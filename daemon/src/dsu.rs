//! Cemuhook/DSU (Device Status Update) UDP motion server implementation.
//!
//! Streams controller gyroscope and accelerometer data over UDP (default port `26760` on
//! `127.0.0.1`) so emulators such as Dolphin and Ryujinx can consume motion controls.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{debug, trace, warn};
use tokio::net::UdpSocket;

/// Default UDP port for the Cemuhook/DSU server.
pub const DEFAULT_DSU_PORT: u16 = 26760;

/// DSU protocol version implemented by this server (`1001`).
pub const DSU_PROTOCOL_VERSION: u16 = 1001;

/// Maximum number of controller slots supported by the DSU protocol (`0..=3`).
pub const MAX_SLOTS: usize = 4;

/// Magic header bytes for packets sent by the DSU server.
const SERVER_MAGIC: &[u8; 4] = b"DSUS";

/// Magic header bytes for packets sent by a DSU client.
const CLIENT_MAGIC: &[u8; 4] = b"DSUC";

/// Size of the fixed DSU base header before the 4-byte message type.
const BASE_HEADER_LEN: usize = 16;

/// Size of the full DSU header including the 4-byte `message_type` field.
const FULL_HEADER_LEN: usize = 20;

/// Byte offset of the `crc32` field within a DSU packet.
const CRC_OFFSET: usize = 8;

/// Payload size of a `ControllerInfo` (`0x100001`) server response.
const CONTROLLER_INFO_PAYLOAD_LEN: usize = 12;

/// Payload size of a `ControllerData` (`0x100002`) server response.
const CONTROLLER_DATA_PAYLOAD_LEN: usize = 80;

/// Neutral byte value for 8-bit centered analog sticks.
const STICK_CENTER: u8 = 128;

/// Duration after which an inactive registered client is evicted.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// DSU message type for protocol version request and response.
pub const MESSAGE_TYPE_VERSION: u32 = 0x0010_0000;

/// DSU message type for controller slot metadata request and response.
pub const MESSAGE_TYPE_CONTROLLER_INFO: u32 = 0x0010_0001;

/// DSU message type for controller input and motion data request and response.
pub const MESSAGE_TYPE_CONTROLLER_DATA: u32 = 0x0010_0002;

/// Slot state indicating no controller is present in the slot.
pub const SLOT_STATE_NOT_CONNECTED: u8 = 0;

/// Slot state indicating the slot is reserved.
pub const SLOT_STATE_RESERVED: u8 = 1;

/// Slot state indicating a controller is connected in the slot.
pub const SLOT_STATE_CONNECTED: u8 = 2;

/// Device model indicating no motion hardware.
pub const DEVICE_MODEL_NONE: u8 = 0;

/// Device model indicating partial gyroscope support.
pub const DEVICE_MODEL_PARTIAL_GYRO: u8 = 1;

/// Device model indicating full gyroscope and accelerometer support.
pub const DEVICE_MODEL_FULL_GYRO: u8 = 2;

/// Device model indicating a generic controller.
pub const DEVICE_MODEL_GENERIC: u8 = 3;

/// Connection type indicating no active connection.
pub const CONNECTION_TYPE_NONE: u8 = 0;

/// Connection type indicating a wired USB connection.
pub const CONNECTION_TYPE_USB: u8 = 1;

/// Connection type indicating a wireless Bluetooth connection.
pub const CONNECTION_TYPE_BLUETOOTH: u8 = 2;

/// Battery level indicating unknown or not applicable.
pub const BATTERY_NONE: u8 = 0x00;

/// Battery level indicating critical/dying charge.
pub const BATTERY_DYING: u8 = 0x01;

/// Battery level indicating low charge.
pub const BATTERY_LOW: u8 = 0x02;

/// Battery level indicating medium charge.
pub const BATTERY_MEDIUM: u8 = 0x03;

/// Battery level indicating high charge.
pub const BATTERY_HIGH: u8 = 0x04;

/// Battery level indicating full charge.
pub const BATTERY_FULL: u8 = 0x05;

/// Battery level indicating the controller is charging/charged on external power.
pub const BATTERY_CHARGING: u8 = 0xEF;

/// Registration flag bit to subscribe by slot index.
const DATA_FLAG_REGISTER_SLOT: u8 = 0x01;

/// Registration flag bit to subscribe by controller MAC address.
const DATA_FLAG_REGISTER_MAC: u8 = 0x02;

/// Standard IEEE 802.3 CRC-32 reflected polynomial (`0x04C11DB7` bit-reversed).
const CRC32_POLYNOMIAL_REFLECTED: u32 = 0xEDB8_8320;

/// Precomputed CRC-32 lookup table using the standard IEEE 802.3 polynomial.
const CRC32_TABLE: [u32; 256] = build_crc32_table();

/// Builds the 256-entry CRC-32 lookup table at compile time.
const fn build_crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0usize;
    while index < 256 {
        let mut crc = index as u32;
        let mut bit = 0usize;
        while bit < 8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ CRC32_POLYNOMIAL_REFLECTED;
            }
            else {
                crc >>= 1;
            }
            bit += 1;
        }
        table[index] = crc;
        index += 1;
    }
    table
}

/// Computes the standard IEEE 802.3 CRC-32 checksum of `data`.
pub fn calculate_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        let table_index = ((crc ^ u32::from(byte)) & 0xFF) as usize;
        crc = (crc >> 8) ^ CRC32_TABLE[table_index];
    }
    !crc
}

/// Returns the deterministic fake MAC address (`00:00:00:00:00:0N`) for a slot (`0..=3`).
///
/// Uses `slot + 1` as the final octet so that slot `0` has a non-zero MAC address
/// (`00:00:00:00:00:01`), distinguishing connected slots from an unassigned `[0; 6]` MAC.
pub fn fake_mac_for_slot(slot: u8) -> [u8; 6] {
    [0x00, 0x00, 0x00, 0x00, 0x00, slot.saturating_add(1)]
}

/// Controller metadata reported in DSU `ControllerInfo` and `ControllerData` packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotInfo {
    /// Slot connection state (`0` = not connected, `1` = reserved, `2` = connected).
    pub slot_state: u8,
    /// Gyroscope model (`0` = none, `1` = partial gyro, `2` = full gyro, `3` = generic).
    pub device_model: u8,
    /// Transport type (`0` = none, `1` = USB, `2` = Bluetooth).
    pub connection_type: u8,
    /// Controller MAC address (`00:00:00:00:00:0N` for virtual slots).
    pub mac: [u8; 6],
    /// Battery status (`0x00`..=`0x05`, `0xEF` = charging).
    pub battery: u8,
}

impl SlotInfo {
    /// Creates a `SlotInfo` representing a disconnected controller slot.
    pub fn disconnected() -> Self {
        Self {
            slot_state: SLOT_STATE_NOT_CONNECTED,
            device_model: DEVICE_MODEL_NONE,
            connection_type: CONNECTION_TYPE_NONE,
            mac: [0x00; 6],
            battery: BATTERY_NONE,
        }
    }

    /// Creates a `SlotInfo` representing a connected full-gyro controller for `slot`.
    pub fn connected(slot: u8) -> Self {
        Self {
            slot_state: SLOT_STATE_CONNECTED,
            device_model: DEVICE_MODEL_FULL_GYRO,
            connection_type: CONNECTION_TYPE_USB,
            mac: fake_mac_for_slot(slot),
            battery: BATTERY_CHARGING,
        }
    }
}

impl Default for SlotInfo {
    fn default() -> Self {
        Self::disconnected()
    }
}

/// Six-axis controller motion sample streamed over DSU `ControllerData` packets.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MotionData {
    /// Sample timestamp in microseconds.
    pub timestamp_us: u64,
    /// Linear acceleration along the X axis in gravitational units (`g`).
    pub accel_x: f32,
    /// Linear acceleration along the Y axis in gravitational units (`g`).
    pub accel_y: f32,
    /// Linear acceleration along the Z axis in gravitational units (`g`).
    pub accel_z: f32,
    /// Angular velocity around the pitch axis in degrees per second (`deg/s`).
    pub gyro_pitch: f32,
    /// Angular velocity around the yaw axis in degrees per second (`deg/s`).
    pub gyro_yaw: f32,
    /// Angular velocity around the roll axis in degrees per second (`deg/s`).
    pub gyro_roll: f32,
}

/// Subscription state for a connected DSU client.
#[derive(Debug)]
struct RegisteredClient {
    slots: HashSet<u8>,
    last_seen: Instant,
}

/// Async UDP server implementing the Cemuhook/DSU motion streaming protocol.
pub struct DsuServer {
    socket: UdpSocket,
    server_id: u32,
    packet_numbers: [u32; MAX_SLOTS],
    registered_clients: HashMap<SocketAddr, RegisteredClient>,
    slot_infos: [SlotInfo; MAX_SLOTS],
}

impl DsuServer {
    /// Binds a new DSU UDP server on `127.0.0.1:<port>`.
    ///
    /// Pass [`DEFAULT_DSU_PORT`] (`26760`) for standard emulator discovery, or `0` to let
    /// the operating system assign an ephemeral local port.
    pub async fn new(port: u16) -> Result<Self, io::Error> {
        let bind_address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
        let socket = UdpSocket::bind(bind_address).await?;

        Ok(Self {
            socket,
            server_id: generate_server_id(),
            packet_numbers: [0; MAX_SLOTS],
            registered_clients: HashMap::new(),
            slot_infos: [SlotInfo::disconnected(); MAX_SLOTS],
        })
    }

    /// Returns the local socket address the server is bound to.
    pub fn local_addr(&self) -> Result<SocketAddr, io::Error> {
        self.socket.local_addr()
    }

    /// Returns the unique identifier advertised in outgoing `DSUS` packet headers.
    pub fn server_id(&self) -> u32 {
        self.server_id
    }

    /// Returns the number of currently active (non-stale) registered clients.
    pub fn registered_client_count(&self) -> usize {
        self.registered_clients.len()
    }

    /// Updates cached metadata for `slot` (`0..=3`) without sending a packet.
    pub fn set_slot_info(&mut self, slot: u8, info: SlotInfo) -> Result<(), io::Error> {
        let slot_index = validate_slot(slot)?;
        self.slot_infos[slot_index] = info;
        Ok(())
    }

    /// Receives and processes a single incoming DSU UDP datagram from a client.
    ///
    /// Validates the packet header, length, and CRC-32 checksum before dispatching
    /// `VersionRequest`, `ControllerInfoRequest`, or `ControllerDataRequest` messages.
    /// Malformed packets are logged and ignored so a single bad datagram does not fail
    /// the server loop.
    pub async fn handle_incoming(&mut self) -> Result<(), io::Error> {
        let mut buffer = [0u8; 1024];
        let (bytes_received, peer_address) = self.socket.recv_from(&mut buffer).await?;
        self.prune_stale_clients();

        let Some((message_type, payload)) = parse_client_packet(&buffer[..bytes_received]) else {
            debug!("Ignoring invalid DSU packet ({bytes_received} bytes) from {peer_address}");
            return Ok(());
        };

        match message_type {
            MESSAGE_TYPE_VERSION => {
                self.touch_existing_client(peer_address);
                let response = self.build_version_response();
                self.socket.send_to(&response, peer_address).await?;
            }
            MESSAGE_TYPE_CONTROLLER_INFO => {
                self.touch_existing_client(peer_address);
                self.handle_controller_info_request(peer_address, payload)
                    .await?;
            }
            MESSAGE_TYPE_CONTROLLER_DATA => {
                self.handle_controller_data_request(peer_address, payload);
            }
            unknown_type => {
                trace!(
                    "Ignoring unsupported DSU message type 0x{unknown_type:08X} from {peer_address}"
                );
            }
        }

        Ok(())
    }

    /// Broadcasts a motion sample (`ControllerData`, `0x100002`) for `slot` to all
    /// registered clients subscribed to that slot.
    pub async fn send_motion_data(
        &mut self,
        slot: u8,
        motion: &MotionData,
    ) -> Result<(), io::Error> {
        let slot_index = validate_slot(slot)?;
        self.prune_stale_clients();

        let packet_number = self.packet_numbers[slot_index];
        self.packet_numbers[slot_index] = packet_number.wrapping_add(1);

        let info = if self.slot_infos[slot_index].slot_state == SLOT_STATE_NOT_CONNECTED {
            SlotInfo::connected(slot)
        }
        else {
            self.slot_infos[slot_index]
        };

        let packet = self.build_controller_data_packet(slot, &info, packet_number, motion);

        let targets: Vec<SocketAddr> = self
            .registered_clients
            .iter()
            .filter(|(_, client)| client.slots.contains(&slot))
            .map(|(&address, _)| address)
            .collect();

        for target in targets {
            if let Err(error) = self.socket.send_to(&packet, target).await {
                warn!("Failed to send DSU motion packet to {target}: {error}");
            }
        }

        Ok(())
    }

    /// Updates `slot` metadata and sends a `ControllerInfo` (`0x100001`) packet to all
    /// currently registered clients.
    pub async fn send_controller_info(
        &mut self,
        slot: u8,
        info: &SlotInfo,
    ) -> Result<(), io::Error> {
        let slot_index = validate_slot(slot)?;
        self.slot_infos[slot_index] = *info;
        self.prune_stale_clients();

        let packet = self.build_controller_info_packet(slot, info);
        let targets: Vec<SocketAddr> = self.registered_clients.keys().copied().collect();

        for target in targets {
            if let Err(error) = self.socket.send_to(&packet, target).await {
                warn!("Failed to send DSU controller info packet to {target}: {error}");
            }
        }

        Ok(())
    }

    /// Handles a `ControllerInfoRequest` (`0x100001`) by replying with info for each
    /// requested valid slot (`0..=3`).
    async fn handle_controller_info_request(
        &self,
        peer_address: SocketAddr,
        payload: &[u8],
    ) -> Result<(), io::Error> {
        if payload.len() < 4 {
            debug!("Truncated ControllerInfoRequest from {peer_address}");
            return Ok(());
        }

        let port_count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]])
            as usize;

        if port_count > MAX_SLOTS || payload.len() < 4 + port_count {
            debug!("Invalid ControllerInfoRequest port_count ({port_count}) from {peer_address}");
            return Ok(());
        }

        for &slot in &payload[4..4 + port_count] {
            if usize::from(slot) >= MAX_SLOTS {
                continue;
            }
            let info = self.slot_infos[usize::from(slot)];
            let packet = self.build_controller_info_packet(slot, &info);
            self.socket.send_to(&packet, peer_address).await?;
        }

        Ok(())
    }

    /// Handles a `ControllerDataRequest` (`0x100002`) by registering or refreshing the
    /// client's slot subscriptions.
    fn handle_controller_data_request(&mut self, peer_address: SocketAddr, payload: &[u8]) {
        if payload.len() < 8 {
            debug!("Truncated ControllerDataRequest from {peer_address}");
            return;
        }

        let flags = payload[0];
        let requested_slot = payload[1];
        let requested_mac = [
            payload[2], payload[3], payload[4], payload[5], payload[6], payload[7],
        ];

        let entry = self
            .registered_clients
            .entry(peer_address)
            .or_insert_with(|| RegisteredClient {
                slots: HashSet::new(),
                last_seen: Instant::now(),
            });
        entry.last_seen = Instant::now();

        if flags == 0 {
            for slot in 0..MAX_SLOTS as u8 {
                entry.slots.insert(slot);
            }
            return;
        }

        if (flags & DATA_FLAG_REGISTER_SLOT) != 0 && usize::from(requested_slot) < MAX_SLOTS {
            entry.slots.insert(requested_slot);
        }

        if (flags & DATA_FLAG_REGISTER_MAC) != 0 && requested_mac != [0x00; 6] {
            for slot in 0..MAX_SLOTS {
                let slot_mac = self.slot_infos[slot].mac;
                let default_mac = fake_mac_for_slot(slot as u8);
                if slot_mac == requested_mac || default_mac == requested_mac {
                    entry.slots.insert(slot as u8);
                }
            }
        }
    }

    /// Refreshes `last_seen` if `peer_address` is already registered.
    fn touch_existing_client(&mut self, peer_address: SocketAddr) {
        if let Some(client) = self.registered_clients.get_mut(&peer_address) {
            client.last_seen = Instant::now();
        }
    }

    /// Removes registered clients that have not been seen within [`CLIENT_TIMEOUT`].
    fn prune_stale_clients(&mut self) {
        let now = Instant::now();
        self.registered_clients
            .retain(|_, client| now.duration_since(client.last_seen) < CLIENT_TIMEOUT);
    }

    /// Serializes a `VersionResponse` (`0x100000`) packet.
    fn build_version_response(&self) -> Vec<u8> {
        let payload = DSU_PROTOCOL_VERSION.to_le_bytes();
        self.build_server_packet(MESSAGE_TYPE_VERSION, &payload)
    }

    /// Serializes a `ControllerInfo` (`0x100001`) packet for `slot`.
    fn build_controller_info_packet(&self, slot: u8, info: &SlotInfo) -> Vec<u8> {
        let mut payload = [0u8; CONTROLLER_INFO_PAYLOAD_LEN];
        write_shared_slot_header(&mut payload, slot, info);
        // Byte 11 remains 0x00 padding per Cemuhook ControllerInfo layout.
        self.build_server_packet(MESSAGE_TYPE_CONTROLLER_INFO, &payload)
    }

    /// Serializes a `ControllerData` (`0x100002`) packet for `slot`.
    fn build_controller_data_packet(
        &self,
        slot: u8,
        info: &SlotInfo,
        packet_number: u32,
        motion: &MotionData,
    ) -> Vec<u8> {
        let mut payload = [0u8; CONTROLLER_DATA_PAYLOAD_LEN];
        write_shared_slot_header(&mut payload, slot, info);

        let is_connected = if info.slot_state == SLOT_STATE_CONNECTED {
            1u8
        }
        else {
            0u8
        };
        payload[11] = is_connected;
        payload[12..16].copy_from_slice(&packet_number.to_le_bytes());

        // Digital buttons (`buttons1`, `buttons2`, `ps_button`, `touch_button`) stay 0.
        // Analog sticks default to centered (128).
        payload[20] = STICK_CENTER;
        payload[21] = STICK_CENTER;
        payload[22] = STICK_CENTER;
        payload[23] = STICK_CENTER;

        // Analog button values (bytes 24..36) and touch points (bytes 36..48) remain 0.
        payload[48..56].copy_from_slice(&motion.timestamp_us.to_le_bytes());
        payload[56..60].copy_from_slice(&motion.accel_x.to_le_bytes());
        payload[60..64].copy_from_slice(&motion.accel_y.to_le_bytes());
        payload[64..68].copy_from_slice(&motion.accel_z.to_le_bytes());
        payload[68..72].copy_from_slice(&motion.gyro_pitch.to_le_bytes());
        payload[72..76].copy_from_slice(&motion.gyro_yaw.to_le_bytes());
        payload[76..80].copy_from_slice(&motion.gyro_roll.to_le_bytes());

        self.build_server_packet(MESSAGE_TYPE_CONTROLLER_DATA, &payload)
    }

    /// Wraps `message_type` and `payload` in a signed `DSUS` header with CRC-32.
    fn build_server_packet(&self, message_type: u32, payload: &[u8]) -> Vec<u8> {
        let length_after_base_header = (4 + payload.len()) as u16;
        let mut packet = Vec::with_capacity(FULL_HEADER_LEN + payload.len());

        packet.extend_from_slice(SERVER_MAGIC);
        packet.extend_from_slice(&DSU_PROTOCOL_VERSION.to_le_bytes());
        packet.extend_from_slice(&length_after_base_header.to_le_bytes());
        packet.extend_from_slice(&0u32.to_le_bytes());
        packet.extend_from_slice(&self.server_id.to_le_bytes());
        packet.extend_from_slice(&message_type.to_le_bytes());
        packet.extend_from_slice(payload);

        let crc = calculate_crc32(&packet);
        packet[CRC_OFFSET..CRC_OFFSET + 4].copy_from_slice(&crc.to_le_bytes());
        packet
    }
}

/// Validates that `slot` is within `0..MAX_SLOTS` and returns it as `usize`.
fn validate_slot(slot: u8) -> Result<usize, io::Error> {
    let slot_index = usize::from(slot);
    if slot_index >= MAX_SLOTS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Invalid DSU controller slot {slot}: expected 0..{MAX_SLOTS}"),
        ));
    }
    Ok(slot_index)
}

/// Writes the 11-byte shared controller header (`slot` through `battery`) into `buffer`.
fn write_shared_slot_header(buffer: &mut [u8], slot: u8, info: &SlotInfo) {
    buffer[0] = slot;
    buffer[1] = info.slot_state;
    buffer[2] = info.device_model;
    buffer[3] = info.connection_type;
    buffer[4..10].copy_from_slice(&info.mac);
    buffer[10] = info.battery;
}

/// Validates an incoming `DSUC` datagram and returns `(message_type, payload)`.
fn parse_client_packet(datagram: &[u8]) -> Option<(u32, &[u8])> {
    if datagram.len() < FULL_HEADER_LEN {
        return None;
    }

    if &datagram[0..4] != CLIENT_MAGIC {
        return None;
    }

    let version = u16::from_le_bytes([datagram[4], datagram[5]]);
    if version == 0 || version > DSU_PROTOCOL_VERSION {
        return None;
    }

    let length_after_base_header = usize::from(u16::from_le_bytes([datagram[6], datagram[7]]));
    if length_after_base_header < 4 {
        return None;
    }

    let total_length = BASE_HEADER_LEN + length_after_base_header;
    if datagram.len() < total_length {
        return None;
    }

    let packet = &datagram[..total_length];
    let expected_crc = u32::from_le_bytes([
        packet[CRC_OFFSET],
        packet[CRC_OFFSET + 1],
        packet[CRC_OFFSET + 2],
        packet[CRC_OFFSET + 3],
    ]);

    let mut scratch = packet.to_vec();
    scratch[CRC_OFFSET..CRC_OFFSET + 4].fill(0);
    if calculate_crc32(&scratch) != expected_crc {
        return None;
    }

    let message_type = u32::from_le_bytes([packet[16], packet[17], packet[18], packet[19]]);
    Some((message_type, &packet[FULL_HEADER_LEN..]))
}

/// Generates a non-zero server identifier from the system clock and process ID.
fn generate_server_id() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let mixed = nanos ^ pid.rotate_left(13) ^ 0x4453_5553;
    if mixed == 0 {
        1
    }
    else {
        mixed
    }
}

/// Updates pushed from the main SDL loop to the async DSU UDP server.
#[derive(Debug, Clone, Copy)]
pub enum DsuUpdate {
    /// Push a motion sample for a virtual slot (`0..=3`).
    Motion {
        /// Virtual slot index (`0..=3`).
        slot: u8,
        /// Motion sample payload.
        motion: MotionData,
    },
    /// Update metadata for a virtual slot (`0..=3`).
    SlotInfo {
        /// Virtual slot index (`0..=3`).
        slot: u8,
        /// Updated slot metadata.
        info: SlotInfo,
    },
}

/// Thread-safe handle used by the main input loop to stream motion and slot info to [`run_server`].
pub struct DsuState {
    sender: tokio::sync::mpsc::UnboundedSender<DsuUpdate>,
    receiver: tokio::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<DsuUpdate>>>,
}

impl DsuState {
    /// Creates a new [`DsuState`] channel bridge for `slot_count` slots.
    pub fn new(_slot_count: usize) -> Self {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        Self {
            sender,
            receiver: tokio::sync::Mutex::new(Some(receiver)),
        }
    }

    /// Queues a motion sample for `slot` (`0..=3`) to be broadcast to subscribed DSU clients.
    pub fn update_motion(&self, slot: u8, motion: MotionData) {
        let _ = self.sender.send(DsuUpdate::Motion { slot, motion });
    }

    /// Queues a slot metadata update (`SlotInfo`) for `slot` (`0..=3`).
    pub fn update_slot_info(&self, slot: u8, info: SlotInfo) {
        let _ = self.sender.send(DsuUpdate::SlotInfo { slot, info });
    }
}

/// Runs the async DSU/Cemuhook UDP server until `shutdown` is signaled.
pub async fn run_server(
    bind_address: SocketAddr,
    state: std::sync::Arc<DsuState>,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), io::Error> {
    let mut server = DsuServer::new(bind_address.port()).await?;
    let mut receiver = state
        .receiver
        .lock()
        .await
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::AlreadyExists, "DSU server already started"))?;

    let mut shutdown_tick = tokio::time::interval(Duration::from_millis(50));
    while !shutdown.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::select! {
            incoming = server.handle_incoming() => {
                if let Err(error) = incoming {
                    warn!("DSU incoming error: {error}");
                }
            }
            maybe_update = receiver.recv() => {
                match maybe_update {
                    Some(DsuUpdate::Motion { slot, motion }) => {
                        if let Err(error) = server.send_motion_data(slot, &motion).await {
                            warn!("DSU send_motion_data error: {error}");
                        }
                    }
                    Some(DsuUpdate::SlotInfo { slot, info }) => {
                        if let Err(error) = server.send_controller_info(slot, &info).await {
                            warn!("DSU send_controller_info error: {error}");
                        }
                    }
                    None => {
                        break;
                    }
                }
            }
            _ = shutdown_tick.tick() => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper that builds a valid `DSUC` client packet with CRC-32 populated.
    fn build_client_packet(client_id: u32, message_type: u32, payload: &[u8]) -> Vec<u8> {
        let length_after_base_header = (4 + payload.len()) as u16;
        let mut packet = Vec::with_capacity(FULL_HEADER_LEN + payload.len());
        packet.extend_from_slice(CLIENT_MAGIC);
        packet.extend_from_slice(&DSU_PROTOCOL_VERSION.to_le_bytes());
        packet.extend_from_slice(&length_after_base_header.to_le_bytes());
        packet.extend_from_slice(&0u32.to_le_bytes());
        packet.extend_from_slice(&client_id.to_le_bytes());
        packet.extend_from_slice(&message_type.to_le_bytes());
        packet.extend_from_slice(payload);

        let crc = calculate_crc32(&packet);
        packet[CRC_OFFSET..CRC_OFFSET + 4].copy_from_slice(&crc.to_le_bytes());
        packet
    }

    /// Helper that verifies a `DSUS` server packet's header and CRC-32 checksum.
    fn verify_server_packet(packet: &[u8]) -> (u32, &[u8]) {
        assert!(packet.len() >= FULL_HEADER_LEN);
        assert_eq!(&packet[0..4], SERVER_MAGIC);
        assert_eq!(
            u16::from_le_bytes([packet[4], packet[5]]),
            DSU_PROTOCOL_VERSION
        );
        let length_after_base = usize::from(u16::from_le_bytes([packet[6], packet[7]]));
        assert_eq!(packet.len(), BASE_HEADER_LEN + length_after_base);

        let actual_crc = u32::from_le_bytes([packet[8], packet[9], packet[10], packet[11]]);
        let mut copy = packet.to_vec();
        copy[8..12].fill(0);
        assert_eq!(calculate_crc32(&copy), actual_crc);

        let message_type = u32::from_le_bytes([packet[16], packet[17], packet[18], packet[19]]);
        (message_type, &packet[FULL_HEADER_LEN..])
    }

    #[test]
    fn crc32_matches_standard_ieee_vector() {
        assert_eq!(calculate_crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(calculate_crc32(b""), 0x0000_0000);
    }

    #[test]
    fn parse_client_packet_rejects_corrupted_crc_and_bad_magic() {
        let mut valid = build_client_packet(42, MESSAGE_TYPE_VERSION, &[]);
        assert_eq!(
            parse_client_packet(&valid),
            Some((MESSAGE_TYPE_VERSION, &[][..]))
        );

        valid[0] = b'X';
        assert_eq!(parse_client_packet(&valid), None);

        let mut bad_crc = build_client_packet(42, MESSAGE_TYPE_VERSION, &[]);
        bad_crc[8] ^= 0xFF;
        assert_eq!(parse_client_packet(&bad_crc), None);
    }

    #[tokio::test]
    async fn version_and_controller_info_round_trip() {
        let mut server = DsuServer::new(0).await.expect("bind server");
        let server_addr = server.local_addr().expect("server local_addr");
        let client = UdpSocket::bind("127.0.0.1:0").await.expect("bind client");

        server
            .set_slot_info(0, SlotInfo::connected(0))
            .expect("set slot 0");

        let version_request = build_client_packet(0x1122_3344, MESSAGE_TYPE_VERSION, &[]);
        client
            .send_to(&version_request, server_addr)
            .await
            .expect("send version request");
        server.handle_incoming().await.expect("handle version");

        let mut recv_buf = [0u8; 256];
        let (len, _) = client.recv_from(&mut recv_buf).await.expect("recv version");
        let (msg_type, payload) = verify_server_packet(&recv_buf[..len]);
        assert_eq!(msg_type, MESSAGE_TYPE_VERSION);
        assert_eq!(payload, &DSU_PROTOCOL_VERSION.to_le_bytes());

        let info_request =
            build_client_packet(0x1122_3344, MESSAGE_TYPE_CONTROLLER_INFO, &[2, 0, 0, 0, 0, 1]);
        client
            .send_to(&info_request, server_addr)
            .await
            .expect("send info request");
        server.handle_incoming().await.expect("handle info");

        let (len0, _) = client.recv_from(&mut recv_buf).await.expect("recv slot 0");
        let (type0, payload0) = verify_server_packet(&recv_buf[..len0]);
        assert_eq!(type0, MESSAGE_TYPE_CONTROLLER_INFO);
        assert_eq!(payload0.len(), CONTROLLER_INFO_PAYLOAD_LEN);
        assert_eq!(payload0[0], 0);
        assert_eq!(payload0[1], SLOT_STATE_CONNECTED);
        assert_eq!(payload0[2], DEVICE_MODEL_FULL_GYRO);
        assert_eq!(payload0[3], CONNECTION_TYPE_USB);
        assert_eq!(&payload0[4..10], &[0, 0, 0, 0, 0, 1]);
        assert_eq!(payload0[10], BATTERY_CHARGING);

        let (len1, _) = client.recv_from(&mut recv_buf).await.expect("recv slot 1");
        let (type1, payload1) = verify_server_packet(&recv_buf[..len1]);
        assert_eq!(type1, MESSAGE_TYPE_CONTROLLER_INFO);
        assert_eq!(payload1[0], 1);
        assert_eq!(payload1[1], SLOT_STATE_NOT_CONNECTED);
    }

    #[tokio::test]
    async fn motion_data_streams_to_registered_slot_and_mac_clients() {
        let mut server = DsuServer::new(0).await.expect("bind server");
        let server_addr = server.local_addr().expect("server local_addr");
        let client_slot = UdpSocket::bind("127.0.0.1:0").await.expect("bind client 1");
        let client_mac = UdpSocket::bind("127.0.0.1:0").await.expect("bind client 2");

        server
            .set_slot_info(1, SlotInfo::connected(1))
            .expect("set slot 1");

        // Register client 1 by slot index 1 (flags = 0x01).
        let req_slot = build_client_packet(
            1,
            MESSAGE_TYPE_CONTROLLER_DATA,
            &[DATA_FLAG_REGISTER_SLOT, 1, 0, 0, 0, 0, 0, 0],
        );
        client_slot
            .send_to(&req_slot, server_addr)
            .await
            .expect("send slot reg");
        server.handle_incoming().await.expect("handle slot reg");

        // Register client 2 by MAC for slot 1 (00:00:00:00:00:02, flags = 0x02).
        let req_mac = build_client_packet(
            2,
            MESSAGE_TYPE_CONTROLLER_DATA,
            &[DATA_FLAG_REGISTER_MAC, 0, 0, 0, 0, 0, 0, 2],
        );
        client_mac
            .send_to(&req_mac, server_addr)
            .await
            .expect("send mac reg");
        server.handle_incoming().await.expect("handle mac reg");

        assert_eq!(server.registered_client_count(), 2);

        let motion = MotionData {
            timestamp_us: 123_456_789,
            accel_x: 0.1,
            accel_y: -0.98,
            accel_z: 0.25,
            gyro_pitch: 12.5,
            gyro_yaw: -45.0,
            gyro_roll: 3.25,
        };
        server
            .send_motion_data(1, &motion)
            .await
            .expect("send motion");

        for client in [&client_slot, &client_mac] {
            let mut buf = [0u8; 256];
            let (len, _) = client.recv_from(&mut buf).await.expect("recv motion");
            assert_eq!(len, FULL_HEADER_LEN + CONTROLLER_DATA_PAYLOAD_LEN);
            let (msg_type, payload) = verify_server_packet(&buf[..len]);
            assert_eq!(msg_type, MESSAGE_TYPE_CONTROLLER_DATA);
            assert_eq!(payload[0], 1);
            assert_eq!(payload[1], SLOT_STATE_CONNECTED);
            assert_eq!(payload[11], 1);
            assert_eq!(u32::from_le_bytes([payload[12], payload[13], payload[14], payload[15]]), 0);
            assert_eq!(payload[20], STICK_CENTER);
            assert_eq!(payload[23], STICK_CENTER);
            assert_eq!(
                u64::from_le_bytes(payload[48..56].try_into().expect("timestamp bytes")),
                123_456_789
            );
            assert_eq!(
                f32::from_le_bytes(payload[56..60].try_into().expect("accel_x bytes")),
                0.1
            );
            assert_eq!(
                f32::from_le_bytes(payload[76..80].try_into().expect("gyro_roll bytes")),
                3.25
            );
        }
    }

    #[tokio::test]
    async fn stale_clients_are_pruned_after_timeout() {
        let mut server = DsuServer::new(0).await.expect("bind server");
        let stale_addr: SocketAddr = "127.0.0.1:40001".parse().expect("parse addr");
        let fresh_addr: SocketAddr = "127.0.0.1:40002".parse().expect("parse addr");

        let mut slots = HashSet::new();
        slots.insert(0);

        server.registered_clients.insert(
            stale_addr,
            RegisteredClient {
                slots: slots.clone(),
                last_seen: Instant::now() - Duration::from_secs(11),
            },
        );
        server.registered_clients.insert(
            fresh_addr,
            RegisteredClient {
                slots,
                last_seen: Instant::now(),
            },
        );

        server.prune_stale_clients();
        assert_eq!(server.registered_client_count(), 1);
        assert!(!server.registered_clients.contains_key(&stale_addr));
        assert!(server.registered_clients.contains_key(&fresh_addr));
    }

    #[tokio::test]
    async fn invalid_slot_returns_error() {
        let mut server = DsuServer::new(0).await.expect("bind server");
        let err = server
            .send_motion_data(4, &MotionData::default())
            .await
            .expect_err("slot 4 must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let err_info = server
            .send_controller_info(5, &SlotInfo::disconnected())
            .await
            .expect_err("slot 5 must fail");
        assert_eq!(err_info.kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn zero_flags_registers_all_slots_and_receives_controller_info_broadcast() {
        let mut server = DsuServer::new(0).await.expect("bind server");
        let server_addr = server.local_addr().expect("server local_addr");
        let client = UdpSocket::bind("127.0.0.1:0").await.expect("bind client");

        let register_all = build_client_packet(
            99,
            MESSAGE_TYPE_CONTROLLER_DATA,
            &[0, 0, 0, 0, 0, 0, 0, 0],
        );
        client
            .send_to(&register_all, server_addr)
            .await
            .expect("send register all");
        server.handle_incoming().await.expect("handle register all");

        let updated = SlotInfo {
            slot_state: SLOT_STATE_CONNECTED,
            device_model: DEVICE_MODEL_FULL_GYRO,
            connection_type: CONNECTION_TYPE_BLUETOOTH,
            mac: fake_mac_for_slot(3),
            battery: BATTERY_HIGH,
        };
        server
            .send_controller_info(3, &updated)
            .await
            .expect("broadcast controller info");

        let mut buf = [0u8; 256];
        let (len, _) = client.recv_from(&mut buf).await.expect("recv info");
        let (msg_type, payload) = verify_server_packet(&buf[..len]);
        assert_eq!(msg_type, MESSAGE_TYPE_CONTROLLER_INFO);
        assert_eq!(payload[0], 3);
        assert_eq!(payload[1], SLOT_STATE_CONNECTED);
        assert_eq!(payload[3], CONNECTION_TYPE_BLUETOOTH);
        assert_eq!(payload[10], BATTERY_HIGH);

        server
            .send_motion_data(3, &MotionData::default())
            .await
            .expect("send slot 3 motion 1");
        server
            .send_motion_data(3, &MotionData::default())
            .await
            .expect("send slot 3 motion 2");

        let (len_a, _) = client.recv_from(&mut buf).await.expect("recv motion 1");
        let (_, payload_a) = verify_server_packet(&buf[..len_a]);
        assert_eq!(
            u32::from_le_bytes(payload_a[12..16].try_into().expect("packet number")),
            0
        );

        let (len_b, _) = client.recv_from(&mut buf).await.expect("recv motion 2");
        let (_, payload_b) = verify_server_packet(&buf[..len_b]);
        assert_eq!(
            u32::from_le_bytes(payload_b[12..16].try_into().expect("packet number")),
            1
        );
    }
}
