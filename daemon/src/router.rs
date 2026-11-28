//! Core input routing module for `virtualpad-daemon`.
//!
//! Maps physical controllers (identified by persistent IDs) to the 4 persistent
//! virtual controller slots (`0..SLOT_COUNT`), handles disconnect/reconnect resilience,
//! Joy-Con split/combine pairing, Home/Guide button interception, player LED updates,
//! and slot management commands.

use std::collections::HashMap;
use std::fmt;

use sdl2::controller::{Axis, Button};

/// Sensor channels read from physical controllers for DSU streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SensorType {
    /// 3-axis accelerometer (`m/s^2`).
    Accelerometer,
    /// 3-axis gyroscope (`rad/s`).
    Gyroscope,
}

use crate::config::{
    BatteryLevel, ConnectionType, ControllerKind, JoyConMode, PhysicalController, VirtualSlot,
    SLOT_COUNT,
};
use crate::dsu::{
    MotionData, SlotInfo, BATTERY_DYING, BATTERY_FULL, BATTERY_HIGH, BATTERY_LOW, BATTERY_MEDIUM,
    BATTERY_NONE, CONNECTION_TYPE_BLUETOOTH, CONNECTION_TYPE_NONE, CONNECTION_TYPE_USB,
    DEVICE_MODEL_FULL_GYRO, DEVICE_MODEL_NONE, SLOT_STATE_CONNECTED, fake_mac_for_slot,
};
use crate::protocol::{DaemonCommand, DaemonEvent};
use crate::virtual_device::{VirtualAxis, VirtualButton, VirtualDeviceError, VirtualGamepad};

/// Nintendo USB vendor ID used for Joy-Con, Switch Pro, and Wii Remote detection.
const NINTENDO_VENDOR_ID: u16 = 0x057E;
/// Nintendo Switch Left Joy-Con USB/Bluetooth product ID.
const JOYCON_LEFT_PRODUCT_ID: u16 = 0x2006;
/// Nintendo Switch Right Joy-Con USB/Bluetooth product ID.
const JOYCON_RIGHT_PRODUCT_ID: u16 = 0x2007;
/// Nintendo Switch Pro Controller USB/Bluetooth product ID.
const SWITCH_PRO_PRODUCT_ID: u16 = 0x2009;
/// Nintendo Wii Remote product ID (`RVL-CNT-01`).
const WIIMOTE_PRODUCT_ID: u16 = 0x0306;
/// Nintendo Wii Remote Plus product ID (`RVL-CNT-01-TR`).
const WIIMOTE_PLUS_PRODUCT_ID: u16 = 0x0330;
/// Nintendo GameCube adapter USB product ID.
const GAMECUBE_ADAPTER_PRODUCT_ID: u16 = 0x0337;
/// Sony USB vendor ID.
const SONY_VENDOR_ID: u16 = 0x054C;
/// Microsoft Xbox USB vendor ID.
const MICROSOFT_VENDOR_ID: u16 = 0x045E;

/// Conversion factor from SDL2 radians/sec to DSU degrees/sec.
const RAD_TO_DEG: f32 = 180.0 / std::f32::consts::PI;

/// Conversion factor from SDL2 m/s^2 to DSU gravitational units (`g`).
const METERS_PER_SEC2_TO_G: f32 = 1.0 / 9.80665;

/// Callback invoked when the Home/Guide/PS button is pressed on a controller.
pub type HomeButtonCallback = Box<dyn Fn(String, Option<usize>) + Send>;

/// Mapped sensor payload forwarded to a DSU slot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SensorData {
    /// SDL2 sensor type (accelerometer or gyroscope).
    pub sensor_type: SensorType,
    /// Three-axis sensor sample values (m/s^2 for accel, rad/s for gyro).
    pub values: [f32; 3],
}

/// Metadata supplied when a physical SDL controller is opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControllerDescriptor {
    /// Unique controller identifier (persistent ID or SDL instance ID string).
    pub id: String,
    /// Human-readable controller name.
    pub name: String,
    /// USB/Bluetooth vendor ID.
    pub vendor_id: u16,
    /// USB/Bluetooth product ID.
    pub product_id: u16,
    /// Optional explicit controller kind override.
    pub kind: Option<ControllerKind>,
    /// Whether the controller exposes a gyroscope sensor.
    pub has_gyro: bool,
    /// Whether the controller exposes an accelerometer sensor.
    pub has_accelerometer: bool,
    /// Initial battery level if known.
    pub battery_level: Option<BatteryLevel>,
    /// Physical transport connection type.
    pub connection_type: ConnectionType,
}

impl ControllerDescriptor {
    /// Creates a minimal descriptor for testing or manual controller registration.
    pub fn basic(id: impl Into<String>, name: impl Into<String>, vendor_id: u16, product_id: u16) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            vendor_id,
            product_id,
            kind: None,
            has_gyro: false,
            has_accelerometer: false,
            battery_level: None,
            connection_type: ConnectionType::Unknown,
        }
    }
}

/// Errors returned by [`InputRouter`] slot and Joy-Con management operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouterError {
    /// Target slot index is outside `0..SLOT_COUNT`.
    InvalidSlot {
        /// Out-of-bounds slot index.
        slot_index: usize,
    },
    /// Referenced physical controller ID is not known to the router.
    ControllerNotFound {
        /// Controller ID that could not be located.
        controller_id: String,
    },
    /// Physical controller has no currently assigned virtual slot.
    ControllerNotAssigned {
        /// Controller ID that is currently unassigned.
        controller_id: String,
    },
    /// Operation requires a Joy-Con controller, but another kind was supplied.
    NotAJoyCon {
        /// Controller ID that is not a Joy-Con.
        controller_id: String,
    },
    /// Combined mode was requested without a free, connected opposite-side Joy-Con.
    NoPartnerJoyCon {
        /// Controller ID missing a partner Joy-Con.
        controller_id: String,
    },
    /// All virtual slots are currently occupied or reserved.
    NoFreeSlot,
    /// Joy-Con is already in the requested mode.
    AlreadyInMode {
        /// Joy-Con controller ID.
        controller_id: String,
        /// Mode the Joy-Con is already using.
        mode: JoyConMode,
    },
}

impl fmt::Display for RouterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RouterError::InvalidSlot { slot_index } => {
                write!(
                    formatter,
                    "invalid virtual slot index {slot_index}; expected 0..{SLOT_COUNT}"
                )
            }
            RouterError::ControllerNotFound { controller_id } => {
                write!(formatter, "physical controller '{controller_id}' not found")
            }
            RouterError::ControllerNotAssigned { controller_id } => {
                write!(
                    formatter,
                    "physical controller '{controller_id}' is not assigned to any slot"
                )
            }
            RouterError::NotAJoyCon { controller_id } => {
                write!(
                    formatter,
                    "physical controller '{controller_id}' is not a Joy-Con"
                )
            }
            RouterError::NoPartnerJoyCon { controller_id } => {
                write!(
                    formatter,
                    "no available opposite-side Joy-Con to combine with '{controller_id}'"
                )
            }
            RouterError::NoFreeSlot => {
                write!(formatter, "no free virtual slot available")
            }
            RouterError::AlreadyInMode {
                controller_id,
                mode,
            } => {
                write!(
                    formatter,
                    "Joy-Con '{controller_id}' is already in {mode:?} mode"
                )
            }
        }
    }
}

impl std::error::Error for RouterError {}

/// Represents a pair of Left and Right Joy-Cons merged onto one virtual slot.
#[derive(Debug, Clone, PartialEq, Eq)]
struct JoyConPair {
    left_id: String,
    right_id: String,
    slot_index: usize,
}

impl JoyConPair {
    /// Returns `true` if `controller_id` is either half of this pair.
    fn contains(&self, controller_id: &str) -> bool {
        self.left_id == controller_id || self.right_id == controller_id
    }
}

/// No-op virtual gamepad used in unit tests when OS virtual devices are unavailable.
struct NullVirtualGamepad {
    identifier: String,
}

impl NullVirtualGamepad {
    fn new(slot_index: usize) -> Self {
        Self {
            identifier: format!("null://slot-{}", slot_index + 1),
        }
    }
}

impl VirtualGamepad for NullVirtualGamepad {
    fn create(slot_index: usize) -> Result<Self, VirtualDeviceError> {
        Ok(Self::new(slot_index))
    }

    fn set_button(&mut self, _button: VirtualButton, _pressed: bool) -> Result<(), VirtualDeviceError> {
        Ok(())
    }

    fn set_axis(&mut self, _axis: VirtualAxis, _value: i32) -> Result<(), VirtualDeviceError> {
        Ok(())
    }

    fn reset(&mut self) -> Result<(), VirtualDeviceError> {
        Ok(())
    }

    fn set_player_led(&mut self, _player: u8) -> Result<(), VirtualDeviceError> {
        Ok(())
    }

    fn set_rumble_callback(&mut self, _callback: Box<dyn Fn(u16, u16, u32) + Send>) {}

    fn device_identifier(&self) -> &str {
        &self.identifier
    }

    fn destroy(&mut self) -> Result<(), VirtualDeviceError> {
        Ok(())
    }
}

/// Per-slot motion accumulator combining recent accelerometer and gyroscope samples.
#[derive(Debug, Clone, Copy, Default)]
struct SlotMotionAccumulator {
    accel: [f32; 3],
    gyro: [f32; 3],
}

/// Routes physical controller input and connection lifecycle events to the 4 virtual slots.
pub struct InputRouter {
    slots: [VirtualSlot; SLOT_COUNT],
    virtual_devices: Vec<Box<dyn VirtualGamepad>>,
    physical_controllers: HashMap<String, PhysicalController>,
    assignments: HashMap<String, usize>,
    joycon_pairs: Vec<JoyConPair>,
    home_button_callbacks: Vec<HomeButtonCallback>,
    motion_buffers: [SlotMotionAccumulator; SLOT_COUNT],
    dirty: bool,
}

impl Default for InputRouter {
    fn default() -> Self {
        Self::new_headless()
    }
}

impl InputRouter {
    /// Creates a new [`InputRouter`] backed by the provided [`VirtualGamepad`] slots.
    pub fn new(virtual_devices: Vec<Box<dyn VirtualGamepad>>) -> Self {
        Self {
            slots: std::array::from_fn(VirtualSlot::new),
            virtual_devices,
            physical_controllers: HashMap::new(),
            assignments: HashMap::new(),
            joycon_pairs: Vec::new(),
            home_button_callbacks: Vec::new(),
            motion_buffers: [SlotMotionAccumulator::default(); SLOT_COUNT],
            dirty: false,
        }
    }

    /// Creates a headless [`InputRouter`] backed by no-op virtual gamepads for testing.
    pub fn new_headless() -> Self {
        let virtual_devices: Vec<Box<dyn VirtualGamepad>> = (0..SLOT_COUNT)
            .map(|slot_index| Box::new(NullVirtualGamepad::new(slot_index)) as Box<dyn VirtualGamepad>)
            .collect();
        Self::new(virtual_devices)
    }

    /// Registers a callback invoked when a Home/Guide/PS button press is intercepted.
    pub fn on_home_button<F>(&mut self, callback: F)
    where
        F: Fn(String, Option<usize>) + Send + 'static,
    {
        self.home_button_callbacks.push(Box::new(callback));
    }

    /// Returns `true` if `button` corresponds to the Home / Guide / PS button.
    pub fn is_home_button(button: Button) -> bool {
        matches!(button, Button::Guide)
    }

    /// Returns `true` if a controller is a real Wii Remote that must stay excluded
    /// so Dolphin passthrough continues working untouched.
    pub fn is_excluded_wiimote(vendor_id: u16, product_id: u16, name: &str) -> bool {
        if vendor_id == NINTENDO_VENDOR_ID
            && (product_id == WIIMOTE_PRODUCT_ID || product_id == WIIMOTE_PLUS_PRODUCT_ID)
        {
            return true;
        }
        let lower = name.to_ascii_lowercase();
        lower.contains("wii remote") || lower.contains("rvl-cnt")
    }

    /// Infers the [`ControllerKind`] from USB/Bluetooth vendor ID, product ID, and name.
    pub fn detect_controller_kind(vendor: u16, product: u16, name: &str) -> ControllerKind {
        if vendor == NINTENDO_VENDOR_ID {
            match product {
                JOYCON_LEFT_PRODUCT_ID => return ControllerKind::SwitchJoyConLeft,
                JOYCON_RIGHT_PRODUCT_ID => return ControllerKind::SwitchJoyConRight,
                SWITCH_PRO_PRODUCT_ID => return ControllerKind::Switch,
                GAMECUBE_ADAPTER_PRODUCT_ID => return ControllerKind::GameCube,
                _ => {}
            }
        }

        let lower = name.to_ascii_lowercase();
        if lower.contains("joy-con (l)") || lower.contains("joycon (l)") || lower.contains("joy-con left") {
            return ControllerKind::SwitchJoyConLeft;
        }
        if lower.contains("joy-con (r)") || lower.contains("joycon (r)") || lower.contains("joy-con right") {
            return ControllerKind::SwitchJoyConRight;
        }
        if lower.contains("gamecube") {
            return ControllerKind::GameCube;
        }
        if lower.contains("switch") || lower.contains("nintendo") || vendor == NINTENDO_VENDOR_ID {
            return ControllerKind::Switch;
        }
        if vendor == SONY_VENDOR_ID
            || lower.contains("playstation")
            || lower.contains("dualshock")
            || lower.contains("dualsense")
            || lower.contains("ps4")
            || lower.contains("ps5")
            || lower.contains("ps3")
        {
            return ControllerKind::PlayStation;
        }
        if vendor == MICROSOFT_VENDOR_ID || lower.contains("xbox") || lower.contains("xinput") {
            return ControllerKind::Xbox;
        }

        ControllerKind::Generic
    }

    /// Handles a physical controller connection event.
    ///
    /// If the controller ID was previously assigned to a slot, routing resumes
    /// to that slot. Otherwise, the controller is automatically assigned to the
    /// first free virtual slot if one is available.
    pub fn handle_controller_added(&mut self, descriptor: ControllerDescriptor) -> Vec<DaemonEvent> {
        let mut events = Vec::new();
        let resolved_kind = descriptor.kind.unwrap_or_else(|| {
            Self::detect_controller_kind(
                descriptor.vendor_id,
                descriptor.product_id,
                &descriptor.name,
            )
        });
        let existing_slot = self.assignments.get(&descriptor.id).copied();

        let joycon_mode = match resolved_kind {
            ControllerKind::SwitchJoyConLeft => {
                if self.find_pair_for(&descriptor.id).is_some() {
                    Some(JoyConMode::Combined)
                }
                else {
                    Some(JoyConMode::SplitLeft)
                }
            }
            ControllerKind::SwitchJoyConRight => {
                if self.find_pair_for(&descriptor.id).is_some() {
                    Some(JoyConMode::Combined)
                }
                else {
                    Some(JoyConMode::SplitRight)
                }
            }
            _ => None,
        };

        let controller = PhysicalController {
            id: descriptor.id.clone(),
            name: descriptor.name,
            kind: resolved_kind,
            vendor_id: descriptor.vendor_id,
            product_id: descriptor.product_id,
            has_gyro: descriptor.has_gyro,
            has_accelerometer: descriptor.has_accelerometer,
            battery_level: descriptor.battery_level,
            connection_type: descriptor.connection_type,
            assigned_slot: existing_slot,
            joycon_mode,
            connected: true,
        };

        self.physical_controllers
            .insert(descriptor.id.clone(), controller.clone());
        events.push(DaemonEvent::ControllerConnected { controller });

        if let Some(slot_index) = existing_slot {
            self.slots[slot_index].assigned_physical = Some(descriptor.id.clone());
            self.slots[slot_index].active = true;
            let _ = self.set_slot_led(slot_index);
            self.dirty = true;
            events.push(self.build_state_update());
            return events;
        }

        if let Some(free_slot) = self.first_free_slot() {
            if let Ok(mut assign_events) = self.assign(&descriptor.id, free_slot) {
                events.append(&mut assign_events);
            }
        }
        else {
            self.dirty = true;
            events.push(self.build_state_update());
        }

        events
    }

    /// Handles a physical controller disconnection event.
    ///
    /// Keeps the assigned virtual slot alive and retains the controller-to-slot
    /// mapping for reconnection while resetting the virtual device to neutral.
    pub fn handle_controller_removed(&mut self, id: &str) -> Vec<DaemonEvent> {
        let mut events = Vec::new();

        if let Some(controller) = self.physical_controllers.get_mut(id) {
            controller.connected = false;
        }
        else {
            return events;
        }

        let slot_index = self.assignments.get(id).copied();
        events.push(DaemonEvent::ControllerDisconnected {
            controller_id: id.to_string(),
        });

        if let Some(slot_idx) = slot_index {
            self.neutralize_virtual_device(slot_idx);
            let any_connected = if let Some(pair) = self.find_pair_for(id) {
                self.is_connected(&pair.left_id) || self.is_connected(&pair.right_id)
            }
            else {
                false
            };
            self.slots[slot_idx].active = any_connected;
        }

        self.dirty = true;
        events.push(self.build_state_update());
        events
    }

    /// Updates a physical controller's battery level and emits a [`DaemonEvent::BatteryUpdate`]
    /// if the level changed.
    pub fn update_battery(&mut self, id: &str, level: BatteryLevel) -> Option<DaemonEvent> {
        let controller = self.physical_controllers.get_mut(id)?;
        if controller.battery_level == Some(level) {
            return None;
        }
        controller.battery_level = Some(level);
        self.dirty = true;
        Some(DaemonEvent::BatteryUpdate {
            controller_id: id.to_string(),
            level,
        })
    }

    /// Routes a button input from a physical controller to its assigned virtual slot.
    ///
    /// Returns `None` if the button is the Home/Guide/PS button (emitting a
    /// [`DaemonEvent::HomeButtonPressed`] event via callbacks instead), if the controller
    /// is unknown/disconnected/unassigned, or if filtered out in Combined Joy-Con mode.
    pub fn handle_button(
        &mut self,
        id: &str,
        button: Button,
        pressed: bool,
    ) -> Option<(usize, Button, bool)> {
        let (connected, joycon_mode) = {
            let controller = self.physical_controllers.get(id)?;
            (controller.connected, controller.joycon_mode)
        };
        if !connected {
            return None;
        }

        let slot_index = self.assignments.get(id).copied();

        if Self::is_home_button(button) {
            if pressed {
                for callback in &self.home_button_callbacks {
                    callback(id.to_string(), slot_index);
                }
            }
            return None;
        }

        let slot = slot_index?;

        let (target_slot, mapped_button) = if let Some(pair) = self.find_pair_for(id) {
            let mapped = Self::map_combined_joycon_button(pair, id, button)?;
            (pair.slot_index, mapped)
        }
        else if let Some(mode) = joycon_mode {
            (slot, Self::map_split_joycon_button(mode, button))
        }
        else {
            (slot, button)
        };

        if let Some(virtual_button) = sdl_button_to_virtual(mapped_button) {
            if let Some(device) = self.virtual_devices.get_mut(target_slot) {
                let _ = device.set_button(virtual_button, pressed);
            }
        }

        Some((target_slot, mapped_button, pressed))
    }

    /// Routes an axis input from a physical controller to its assigned virtual slot.
    pub fn handle_axis(&mut self, id: &str, axis: Axis, value: i16) -> Option<(usize, Axis, i16)> {
        let (connected, joycon_mode) = {
            let controller = self.physical_controllers.get(id)?;
            (controller.connected, controller.joycon_mode)
        };
        if !connected {
            return None;
        }

        let slot = self.assignments.get(id).copied()?;

        let (target_slot, mapped_axis, mapped_value) = if let Some(pair) = self.find_pair_for(id) {
            let mapped = Self::map_combined_joycon_axis(pair, id, axis)?;
            (pair.slot_index, mapped, value)
        }
        else if let Some(mode) = joycon_mode {
            let (rotated_axis, rotated_value) = Self::map_split_joycon_axis(mode, axis, value);
            (slot, rotated_axis, rotated_value)
        }
        else {
            (slot, axis, value)
        };

        if let Some((virtual_axis, scaled_value)) = sdl_axis_to_virtual(mapped_axis, mapped_value) {
            if let Some(device) = self.virtual_devices.get_mut(target_slot) {
                let _ = device.set_axis(virtual_axis, scaled_value);
            }
        }

        Some((target_slot, mapped_axis, mapped_value))
    }

    /// Routes a motion sensor reading from a physical controller to its assigned DSU slot.
    pub fn handle_sensor(
        &mut self,
        id: &str,
        sensor_type: SensorType,
        data: [f32; 3],
        timestamp_us: u64,
    ) -> Option<(u8, MotionData)> {
        let controller = self.physical_controllers.get(id)?;
        if !controller.connected {
            return None;
        }

        let slot = self.assignments.get(id).copied()?;
        let target_slot = if let Some(pair) = self.find_pair_for(id) {
            let right_connected = self
                .physical_controllers
                .get(&pair.right_id)
                .map(|right| right.connected)
                .unwrap_or(false);

            // Prefer Right Joy-Con IMU when both halves are connected.
            if id == pair.left_id && right_connected {
                return None;
            }
            pair.slot_index
        }
        else {
            slot
        };

        if target_slot >= SLOT_COUNT {
            return None;
        }

        let acc = &mut self.motion_buffers[target_slot];
        match sensor_type {
            SensorType::Accelerometer => {
                acc.accel = [
                    data[0] * METERS_PER_SEC2_TO_G,
                    data[1] * METERS_PER_SEC2_TO_G,
                    data[2] * METERS_PER_SEC2_TO_G,
                ];
            }
            SensorType::Gyroscope => {
                acc.gyro = [
                    data[0] * RAD_TO_DEG,
                    data[1] * RAD_TO_DEG,
                    data[2] * RAD_TO_DEG,
                ];
            }
        }

        let motion = MotionData {
            timestamp_us,
            accel_x: acc.accel[0],
            accel_y: acc.accel[1],
            accel_z: acc.accel[2],
            gyro_pitch: acc.gyro[0],
            gyro_yaw: acc.gyro[1],
            gyro_roll: acc.gyro[2],
        };

        Some((target_slot as u8, motion))
    }

    /// Assigns `controller_id` (or its combined Joy-Con pair) to `slot_index`.
    pub fn assign(
        &mut self,
        controller_id: &str,
        slot_index: usize,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        self.validate_slot(slot_index)?;
        self.ensure_known_controller(controller_id)?;

        if self.assignments.get(controller_id).copied() == Some(slot_index) {
            return Ok(Vec::new());
        }

        if self.is_slot_occupied(slot_index) {
            self.vacate_slot(slot_index);
        }

        let moving_ids = self.paired_or_single_ids(controller_id);
        let old_slot = self.assignments.get(controller_id).copied();

        if let Some(previous_slot) = old_slot {
            self.clear_slot(previous_slot);
            self.neutralize_virtual_device(previous_slot);
        }

        for moving_id in &moving_ids {
            self.assignments.insert(moving_id.clone(), slot_index);
            if let Some(physical) = self.physical_controllers.get_mut(moving_id) {
                physical.assigned_slot = Some(slot_index);
            }
        }

        let any_connected = moving_ids.iter().any(|id| self.is_connected(id));
        let primary_id = self
            .find_pair_for(controller_id)
            .map(|pair| pair.left_id.clone())
            .unwrap_or_else(|| controller_id.to_string());

        if let Some(pair) = self
            .joycon_pairs
            .iter_mut()
            .find(|pair| pair.contains(controller_id))
        {
            pair.slot_index = slot_index;
        }

        self.slots[slot_index].assigned_physical = Some(primary_id);
        self.slots[slot_index].active = any_connected;
        let _ = self.set_slot_led(slot_index);

        self.dirty = true;
        Ok(vec![self.build_state_update()])
    }

    /// Unassigns `controller_id` from its virtual slot and resets that virtual device.
    pub fn unassign(&mut self, controller_id: &str) -> Result<Vec<DaemonEvent>, RouterError> {
        self.ensure_known_controller(controller_id)?;

        let slot_index = self
            .assignments
            .get(controller_id)
            .copied()
            .ok_or_else(|| RouterError::ControllerNotAssigned {
                controller_id: controller_id.to_string(),
            })?;

        self.vacate_slot(slot_index);
        self.dirty = true;
        Ok(vec![self.build_state_update()])
    }

    /// Swaps the assignments of virtual slots `slot_a` and `slot_b`.
    pub fn swap_slots(
        &mut self,
        slot_a: usize,
        slot_b: usize,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        self.validate_slot(slot_a)?;
        self.validate_slot(slot_b)?;

        if slot_a == slot_b {
            return Ok(Vec::new());
        }

        let ids_in_a = self.ids_in_slot(slot_a);
        let ids_in_b = self.ids_in_slot(slot_b);

        for id in ids_in_a {
            self.assignments.insert(id.clone(), slot_b);
            if let Some(controller) = self.physical_controllers.get_mut(&id) {
                controller.assigned_slot = Some(slot_b);
            }
        }

        for id in ids_in_b {
            self.assignments.insert(id.clone(), slot_a);
            if let Some(controller) = self.physical_controllers.get_mut(&id) {
                controller.assigned_slot = Some(slot_a);
            }
        }

        for pair in &mut self.joycon_pairs {
            if pair.slot_index == slot_a {
                pair.slot_index = slot_b;
            }
            else if pair.slot_index == slot_b {
                pair.slot_index = slot_a;
            }
        }

        self.slots.swap(slot_a, slot_b);
        self.slots[slot_a].index = slot_a;
        self.slots[slot_b].index = slot_b;

        self.neutralize_virtual_device(slot_a);
        self.neutralize_virtual_device(slot_b);
        let _ = self.set_slot_led(slot_a);
        let _ = self.set_slot_led(slot_b);

        self.dirty = true;
        Ok(vec![self.build_state_update()])
    }

    /// Automatically assigns all connected, unassigned physical controllers
    /// to the first available free slots in deterministic ID order.
    pub fn auto_assign(&mut self) -> Vec<DaemonEvent> {
        let mut unassigned_ids: Vec<String> = self
            .physical_controllers
            .values()
            .filter(|controller| {
                controller.connected && !self.assignments.contains_key(&controller.id)
            })
            .map(|controller| controller.id.clone())
            .collect();

        unassigned_ids.sort();

        for controller_id in unassigned_ids {
            let Some(free_slot) = self.first_free_slot() else {
                break;
            };
            let _ = self.assign(&controller_id, free_slot);
        }

        if self.dirty {
            vec![self.build_state_update()]
        }
        else {
            Vec::new()
        }
    }

    /// Switches a Joy-Con between `Combined`, `SplitLeft`, and `SplitRight` modes.
    pub fn set_joycon_mode(
        &mut self,
        controller_id: &str,
        mode: JoyConMode,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        let kind = self
            .physical_controllers
            .get(controller_id)
            .map(|controller| controller.kind)
            .ok_or_else(|| RouterError::ControllerNotFound {
                controller_id: controller_id.to_string(),
            })?;

        if !Self::is_joycon_kind(kind) {
            return Err(RouterError::NotAJoyCon {
                controller_id: controller_id.to_string(),
            });
        }

        match mode {
            JoyConMode::Combined => self.combine_joycon(controller_id, kind),
            JoyConMode::SplitLeft | JoyConMode::SplitRight => {
                self.split_joycon(controller_id, mode)
            }
        }
    }

    /// Returns a snapshot of all virtual slots and known physical controllers.
    pub fn get_state(&self) -> (Vec<VirtualSlot>, Vec<PhysicalController>) {
        let slots = self.slots.to_vec();
        let mut controllers: Vec<PhysicalController> =
            self.physical_controllers.values().cloned().collect();
        controllers.sort_by(|left, right| left.id.cmp(&right.id));
        (slots, controllers)
    }

    /// Builds a [`DaemonEvent::StateUpdate`] reflecting current router state.
    pub fn build_state_update(&self) -> DaemonEvent {
        let mut controllers: Vec<PhysicalController> =
            self.physical_controllers.values().cloned().collect();
        controllers.sort_by(|left, right| left.id.cmp(&right.id));
        DaemonEvent::StateUpdate {
            slots: self.slots.clone(),
            physical_controllers: controllers,
        }
    }

    /// Builds [`SlotInfo`] for DSU `ControllerInfo` / `ControllerData` packets for `slot_index`.
    pub fn dsu_slot_info(&self, slot_index: usize) -> SlotInfo {
        let Some(slot) = self.slots.get(slot_index) else {
            return SlotInfo::disconnected();
        };
        let Some(ref primary_id) = slot.assigned_physical else {
            return SlotInfo::disconnected();
        };
        let Some(controller) = self.physical_controllers.get(primary_id) else {
            return SlotInfo::disconnected();
        };
        if !slot.active || !controller.connected {
            return SlotInfo::disconnected();
        }

        let device_model = if controller.has_gyro || controller.has_accelerometer {
            DEVICE_MODEL_FULL_GYRO
        }
        else {
            DEVICE_MODEL_NONE
        };

        let connection_type = match controller.connection_type {
            ConnectionType::Usb => CONNECTION_TYPE_USB,
            ConnectionType::Bluetooth | ConnectionType::Wireless => CONNECTION_TYPE_BLUETOOTH,
            ConnectionType::Unknown => CONNECTION_TYPE_NONE,
        };

        let battery = match controller.battery_level {
            Some(BatteryLevel::Empty) | Some(BatteryLevel::Critical) => BATTERY_DYING,
            Some(BatteryLevel::Low) => BATTERY_LOW,
            Some(BatteryLevel::Medium) => BATTERY_MEDIUM,
            Some(BatteryLevel::High) => BATTERY_HIGH,
            Some(BatteryLevel::Full) | Some(BatteryLevel::Wired) => BATTERY_FULL,
            _ => BATTERY_NONE,
        };

        SlotInfo {
            slot_state: SLOT_STATE_CONNECTED,
            device_model,
            connection_type,
            mac: fake_mac_for_slot(slot_index as u8),
            battery,
        }
    }

    /// Dispatches a [`DaemonCommand`] against the router.
    pub fn handle_command(
        &mut self,
        command: DaemonCommand,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        match command {
            DaemonCommand::AssignController {
                controller_id,
                slot_index,
            } => self.assign(&controller_id, slot_index),
            DaemonCommand::UnassignController { controller_id } => self.unassign(&controller_id),
            DaemonCommand::SwapSlots { slot_a, slot_b } => self.swap_slots(slot_a, slot_b),
            DaemonCommand::AutoAssign => Ok(self.auto_assign()),
            DaemonCommand::SetJoyConMode {
                controller_id,
                mode,
            } => self.set_joycon_mode(&controller_id, mode),
            DaemonCommand::QueryState => Ok(vec![self.build_state_update()]),
        }
    }

    /// Returns the assigned virtual slot index for `controller_id`, if any.
    pub fn slot_for_controller(&self, controller_id: &str) -> Option<usize> {
        self.assignments.get(controller_id).copied()
    }

    /// Returns all physical controller IDs currently assigned to `slot_index`.
    pub fn ids_in_slot(&self, slot_index: usize) -> Vec<String> {
        self.assignments
            .iter()
            .filter_map(|(id, &slot)| {
                if slot == slot_index {
                    Some(id.clone())
                }
                else {
                    None
                }
            })
            .collect()
    }

    /// Returns and clears the pending state-broadcast dirty flag.
    pub fn take_dirty_flag(&mut self) -> bool {
        let was_dirty = self.dirty;
        self.dirty = false;
        was_dirty
    }

    /// Registers a rumble forwarding callback on virtual device `slot_index`.
    pub fn register_rumble_callback<F>(&mut self, slot_index: usize, callback: F)
    where
        F: Fn(u16, u16, u32) + Send + 'static,
    {
        if let Some(device) = self.virtual_devices.get_mut(slot_index) {
            device.set_rumble_callback(Box::new(callback));
        }
    }

    fn validate_slot(&self, slot_index: usize) -> Result<(), RouterError> {
        if slot_index >= SLOT_COUNT {
            return Err(RouterError::InvalidSlot { slot_index });
        }
        Ok(())
    }

    fn ensure_known_controller(&self, controller_id: &str) -> Result<(), RouterError> {
        if self.physical_controllers.contains_key(controller_id)
            || self.assignments.contains_key(controller_id)
        {
            return Ok(());
        }
        Err(RouterError::ControllerNotFound {
            controller_id: controller_id.to_string(),
        })
    }

    fn is_joycon_kind(kind: ControllerKind) -> bool {
        matches!(
            kind,
            ControllerKind::SwitchJoyConLeft | ControllerKind::SwitchJoyConRight
        )
    }

    fn default_split_mode(kind: ControllerKind) -> JoyConMode {
        match kind {
            ControllerKind::SwitchJoyConRight => JoyConMode::SplitRight,
            _ => JoyConMode::SplitLeft,
        }
    }

    fn is_connected(&self, controller_id: &str) -> bool {
        self.physical_controllers
            .get(controller_id)
            .map(|controller| controller.connected)
            .unwrap_or(false)
    }

    fn first_free_slot(&self) -> Option<usize> {
        (0..SLOT_COUNT).find(|slot_index| !self.is_slot_occupied(*slot_index))
    }

    fn is_slot_occupied(&self, slot_index: usize) -> bool {
        self.assignments
            .values()
            .any(|assigned_slot| *assigned_slot == slot_index)
    }

    fn find_pair_for(&self, controller_id: &str) -> Option<&JoyConPair> {
        self.joycon_pairs
            .iter()
            .find(|pair| pair.contains(controller_id))
    }

    fn paired_or_single_ids(&self, controller_id: &str) -> Vec<String> {
        if let Some(pair) = self.find_pair_for(controller_id) {
            return vec![pair.left_id.clone(), pair.right_id.clone()];
        }
        vec![controller_id.to_string()]
    }

    fn set_slot_led(&mut self, slot_index: usize) -> Result<(), VirtualDeviceError> {
        if let Some(device) = self.virtual_devices.get_mut(slot_index) {
            device.set_player_led((slot_index + 1) as u8)?;
        }
        Ok(())
    }

    fn neutralize_virtual_device(&mut self, slot_index: usize) {
        if let Some(device) = self.virtual_devices.get_mut(slot_index) {
            let _ = device.reset();
        }
    }

    fn clear_slot(&mut self, slot_index: usize) {
        if slot_index >= SLOT_COUNT {
            return;
        }
        self.slots[slot_index].assigned_physical = None;
        self.slots[slot_index].active = false;
    }

    fn vacate_slot(&mut self, slot_index: usize) {
        if let Some(pair_pos) = self
            .joycon_pairs
            .iter()
            .position(|pair| pair.slot_index == slot_index)
        {
            let pair = self.joycon_pairs.remove(pair_pos);
            for half_id in [&pair.left_id, &pair.right_id] {
                self.assignments.remove(half_id);
                if let Some(controller) = self.physical_controllers.get_mut(half_id) {
                    controller.assigned_slot = None;
                    controller.joycon_mode = Some(Self::default_split_mode(controller.kind));
                }
            }
            self.clear_slot(slot_index);
            self.neutralize_virtual_device(slot_index);
            return;
        }

        let occupant_ids = self.ids_in_slot(slot_index);
        for occupant_id in &occupant_ids {
            self.assignments.remove(occupant_id);
            if let Some(controller) = self.physical_controllers.get_mut(occupant_id) {
                controller.assigned_slot = None;
            }
        }

        self.clear_slot(slot_index);
        self.neutralize_virtual_device(slot_index);
    }

    fn combine_joycon(
        &mut self,
        controller_id: &str,
        kind: ControllerKind,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        if self.find_pair_for(controller_id).is_some() {
            return Err(RouterError::AlreadyInMode {
                controller_id: controller_id.to_string(),
                mode: JoyConMode::Combined,
            });
        }

        let partner_kind = match kind {
            ControllerKind::SwitchJoyConLeft => ControllerKind::SwitchJoyConRight,
            ControllerKind::SwitchJoyConRight => ControllerKind::SwitchJoyConLeft,
            _ => {
                return Err(RouterError::NotAJoyCon {
                    controller_id: controller_id.to_string(),
                });
            }
        };

        let mut candidate_partners: Vec<String> = self
            .physical_controllers
            .values()
            .filter(|candidate| {
                candidate.connected
                    && candidate.kind == partner_kind
                    && candidate.id != controller_id
                    && self.find_pair_for(&candidate.id).is_none()
            })
            .map(|candidate| candidate.id.clone())
            .collect();

        candidate_partners.sort();

        let partner_id = candidate_partners
            .into_iter()
            .next()
            .ok_or_else(|| RouterError::NoPartnerJoyCon {
                controller_id: controller_id.to_string(),
            })?;

        let (left_id, right_id) = match kind {
            ControllerKind::SwitchJoyConLeft => (controller_id.to_string(), partner_id),
            ControllerKind::SwitchJoyConRight => (partner_id, controller_id.to_string()),
            _ => unreachable!(),
        };

        let left_slot = self.assignments.get(&left_id).copied();
        let right_slot = self.assignments.get(&right_id).copied();

        let target_slot = left_slot
            .or(right_slot)
            .or_else(|| self.first_free_slot())
            .ok_or(RouterError::NoFreeSlot)?;

        if let Some(previous_right_slot) = right_slot {
            if previous_right_slot != target_slot {
                self.assignments.remove(&right_id);
                self.clear_slot(previous_right_slot);
                self.neutralize_virtual_device(previous_right_slot);
            }
        }

        if let Some(previous_left_slot) = left_slot {
            if previous_left_slot != target_slot {
                self.assignments.remove(&left_id);
                self.clear_slot(previous_left_slot);
                self.neutralize_virtual_device(previous_left_slot);
            }
        }

        self.assignments.insert(left_id.clone(), target_slot);
        self.assignments.insert(right_id.clone(), target_slot);

        if let Some(left_ctrl) = self.physical_controllers.get_mut(&left_id) {
            left_ctrl.joycon_mode = Some(JoyConMode::Combined);
            left_ctrl.assigned_slot = Some(target_slot);
        }
        if let Some(right_ctrl) = self.physical_controllers.get_mut(&right_id) {
            right_ctrl.joycon_mode = Some(JoyConMode::Combined);
            right_ctrl.assigned_slot = Some(target_slot);
        }

        self.joycon_pairs.push(JoyConPair {
            left_id: left_id.clone(),
            right_id: right_id.clone(),
            slot_index: target_slot,
        });

        self.slots[target_slot].assigned_physical = Some(left_id);
        self.slots[target_slot].active = true;
        self.neutralize_virtual_device(target_slot);
        let _ = self.set_slot_led(target_slot);

        self.dirty = true;
        Ok(vec![self.build_state_update()])
    }

    fn split_joycon(
        &mut self,
        controller_id: &str,
        requested_mode: JoyConMode,
    ) -> Result<Vec<DaemonEvent>, RouterError> {
        let Some(pair_index) = self
            .joycon_pairs
            .iter()
            .position(|pair| pair.contains(controller_id))
        else {
            if let Some(controller) = self.physical_controllers.get_mut(controller_id) {
                if controller.joycon_mode == Some(requested_mode) {
                    return Err(RouterError::AlreadyInMode {
                        controller_id: controller_id.to_string(),
                        mode: requested_mode,
                    });
                }
                controller.joycon_mode = Some(requested_mode);
                self.dirty = true;
                return Ok(vec![self.build_state_update()]);
            }
            return Err(RouterError::ControllerNotFound {
                controller_id: controller_id.to_string(),
            });
        };

        let pair = self.joycon_pairs.remove(pair_index);
        let shared_slot = pair.slot_index;

        self.assignments.insert(pair.left_id.clone(), shared_slot);
        if let Some(left_ctrl) = self.physical_controllers.get_mut(&pair.left_id) {
            left_ctrl.joycon_mode = Some(JoyConMode::SplitLeft);
            left_ctrl.assigned_slot = Some(shared_slot);
        }

        self.slots[shared_slot].assigned_physical = Some(pair.left_id.clone());
        self.slots[shared_slot].active = self.is_connected(&pair.left_id);
        self.neutralize_virtual_device(shared_slot);
        let _ = self.set_slot_led(shared_slot);

        self.assignments.remove(&pair.right_id);
        if let Some(new_slot) = self.first_free_slot() {
            self.assignments.insert(pair.right_id.clone(), new_slot);
            if let Some(right_ctrl) = self.physical_controllers.get_mut(&pair.right_id) {
                right_ctrl.joycon_mode = Some(JoyConMode::SplitRight);
                right_ctrl.assigned_slot = Some(new_slot);
            }
            self.slots[new_slot].assigned_physical = Some(pair.right_id.clone());
            self.slots[new_slot].active = self.is_connected(&pair.right_id);
            let _ = self.set_slot_led(new_slot);
        }
        else if let Some(right_ctrl) = self.physical_controllers.get_mut(&pair.right_id) {
            right_ctrl.joycon_mode = Some(JoyConMode::SplitRight);
            right_ctrl.assigned_slot = None;
        }

        self.dirty = true;
        Ok(vec![self.build_state_update()])
    }

    /// Maps buttons from a paired Joy-Con into the merged virtual gamepad layout.
    fn map_combined_joycon_button(
        pair: &JoyConPair,
        controller_id: &str,
        button: Button,
    ) -> Option<Button> {
        if controller_id == pair.left_id {
            match button {
                Button::DPadUp
                | Button::DPadDown
                | Button::DPadLeft
                | Button::DPadRight
                | Button::LeftShoulder
                | Button::LeftStick
                | Button::Back
                | Button::Misc1
                | Button::Paddle1
                | Button::Paddle2 => Some(button),
                _ => None,
            }
        }
        else if controller_id == pair.right_id {
            match button {
                Button::A
                | Button::B
                | Button::X
                | Button::Y
                | Button::RightShoulder
                | Button::RightStick
                | Button::Start
                | Button::Paddle3
                | Button::Paddle4 => Some(button),
                Button::Paddle1 => Some(Button::Paddle3),
                Button::Paddle2 => Some(Button::Paddle4),
                _ => None,
            }
        }
        else {
            None
        }
    }

    /// Maps axes from a paired Joy-Con into the merged virtual gamepad layout.
    fn map_combined_joycon_axis(
        pair: &JoyConPair,
        controller_id: &str,
        axis: Axis,
    ) -> Option<Axis> {
        if controller_id == pair.left_id {
            match axis {
                Axis::LeftX | Axis::LeftY | Axis::TriggerLeft => Some(axis),
                _ => None,
            }
        }
        else if controller_id == pair.right_id {
            match axis {
                Axis::RightX | Axis::RightY | Axis::TriggerRight => Some(axis),
                Axis::LeftX => Some(Axis::RightX),
                Axis::LeftY => Some(Axis::RightY),
                Axis::TriggerLeft => Some(Axis::TriggerRight),
            }
        }
        else {
            None
        }
    }

    /// Maps a standalone horizontal Joy-Con's buttons into standard virtual pad layout.
    fn map_split_joycon_button(mode: JoyConMode, button: Button) -> Button {
        match mode {
            JoyConMode::Combined => button,
            JoyConMode::SplitLeft => match button {
                Button::DPadLeft => Button::A,
                Button::DPadDown => Button::B,
                Button::DPadUp => Button::X,
                Button::DPadRight => Button::Y,
                Button::Paddle1 => Button::LeftShoulder,
                Button::Paddle2 => Button::RightShoulder,
                Button::Back => Button::Start,
                other => other,
            },
            JoyConMode::SplitRight => match button {
                Button::A => Button::Y,
                Button::B => Button::X,
                Button::X => Button::A,
                Button::Y => Button::B,
                Button::Paddle1 | Button::Paddle3 => Button::LeftShoulder,
                Button::Paddle2 | Button::Paddle4 => Button::RightShoulder,
                other => other,
            },
        }
    }

    /// Maps a standalone horizontal Joy-Con's stick axes (rotated 90 degrees).
    fn map_split_joycon_axis(mode: JoyConMode, axis: Axis, value: i16) -> (Axis, i16) {
        let negated = value.saturating_neg();
        match mode {
            JoyConMode::Combined => (axis, value),
            JoyConMode::SplitLeft => match axis {
                Axis::LeftX => (Axis::LeftY, negated),
                Axis::LeftY => (Axis::LeftX, value),
                other => (other, value),
            },
            JoyConMode::SplitRight => match axis {
                Axis::LeftX | Axis::RightX => (Axis::LeftY, value),
                Axis::LeftY | Axis::RightY => (Axis::LeftX, negated),
                other => (other, value),
            },
        }
    }
}

/// Converts an SDL2 `Button` into our virtual gamepad button enum.
fn sdl_button_to_virtual(button: Button) -> Option<VirtualButton> {
    match button {
        Button::A => Some(VirtualButton::A),
        Button::B => Some(VirtualButton::B),
        Button::X => Some(VirtualButton::X),
        Button::Y => Some(VirtualButton::Y),
        Button::DPadUp => Some(VirtualButton::DPadUp),
        Button::DPadDown => Some(VirtualButton::DPadDown),
        Button::DPadLeft => Some(VirtualButton::DPadLeft),
        Button::DPadRight => Some(VirtualButton::DPadRight),
        Button::LeftShoulder => Some(VirtualButton::LeftShoulder),
        Button::RightShoulder => Some(VirtualButton::RightShoulder),
        Button::LeftStick => Some(VirtualButton::LeftStick),
        Button::RightStick => Some(VirtualButton::RightStick),
        Button::Start => Some(VirtualButton::Start),
        Button::Back => Some(VirtualButton::Back),
        Button::Guide => Some(VirtualButton::Guide),
        _ => None,
    }
}

/// Converts an SDL2 `Axis` and `i16` value into a [`VirtualAxis`] and scaled value.
fn sdl_axis_to_virtual(axis: Axis, value: i16) -> Option<(VirtualAxis, i32)> {
    match axis {
        Axis::LeftX => Some((VirtualAxis::LeftStickX, value as i32)),
        Axis::LeftY => Some((VirtualAxis::LeftStickY, value as i32)),
        Axis::RightX => Some((VirtualAxis::RightStickX, value as i32)),
        Axis::RightY => Some((VirtualAxis::RightStickY, value as i32)),
        Axis::TriggerLeft => {
            let scaled = ((value.max(0) as i32) * 255) / 32767;
            Some((VirtualAxis::LeftTrigger, scaled))
        }
        Axis::TriggerRight => {
            let scaled = ((value.max(0) as i32) * 255) / 32767;
            Some((VirtualAxis::RightTrigger, scaled))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn auto_assigns_new_controllers_to_first_free_slot() {
        let mut router = InputRouter::new_headless();

        let events_one = router.handle_controller_added(ControllerDescriptor::basic(
            "pad-1",
            "Xbox Series X Controller",
            MICROSOFT_VENDOR_ID,
            0x0B12,
        ));
        assert_eq!(router.slot_for_controller("pad-1"), Some(0));
        assert!(events_one
            .iter()
            .any(|event| matches!(event, DaemonEvent::StateUpdate { .. })));

        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-2",
            "DualSense Wireless Controller",
            SONY_VENDOR_ID,
            0x0CE6,
        ));
        assert_eq!(router.slot_for_controller("pad-2"), Some(1));
    }

    #[test]
    fn disconnect_keeps_slot_alive_neutral_and_reconnect_resumes() {
        let mut router = InputRouter::new_headless();
        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-1",
            "Xbox Controller",
            MICROSOFT_VENDOR_ID,
            0x02EA,
        ));
        assert_eq!(
            router.handle_button("pad-1", Button::A, true),
            Some((0, Button::A, true))
        );

        let removed_events = router.handle_controller_removed("pad-1");
        assert!(removed_events
            .iter()
            .any(|event| matches!(event, DaemonEvent::ControllerDisconnected { controller_id } if controller_id == "pad-1")));
        assert_eq!(router.slot_for_controller("pad-1"), Some(0));
        assert_eq!(router.handle_button("pad-1", Button::A, true), None);

        // A second controller must not steal the preserved slot 0.
        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-2",
            "Xbox Controller 2",
            MICROSOFT_VENDOR_ID,
            0x02EA,
        ));
        assert_eq!(router.slot_for_controller("pad-2"), Some(1));

        // Reconnecting pad-1 resumes routing on slot 0.
        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-1",
            "Xbox Controller",
            MICROSOFT_VENDOR_ID,
            0x02EA,
        ));
        assert_eq!(
            router.handle_button("pad-1", Button::A, true),
            Some((0, Button::A, true))
        );
    }

    #[test]
    fn intercepts_home_button_and_invokes_callbacks() {
        let mut router = InputRouter::new_headless();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        router.on_home_button(move |id, slot| {
            captured_clone.lock().unwrap().push((id, slot));
        });

        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-1",
            "Pro Controller",
            NINTENDO_VENDOR_ID,
            SWITCH_PRO_PRODUCT_ID,
        ));

        assert!(InputRouter::is_home_button(Button::Guide));
        assert!(!InputRouter::is_home_button(Button::Start));

        assert_eq!(router.handle_button("pad-1", Button::Guide, true), None);
        assert_eq!(router.handle_button("pad-1", Button::Guide, false), None);

        let calls = captured.lock().unwrap();
        assert_eq!(calls.as_slice(), &[("pad-1".to_string(), Some(0))]);
    }

    #[test]
    fn combines_and_splits_joycons() {
        let mut router = InputRouter::new_headless();
        router.handle_controller_added(ControllerDescriptor::basic(
            "jc-left",
            "Nintendo Switch Joy-Con (L)",
            NINTENDO_VENDOR_ID,
            JOYCON_LEFT_PRODUCT_ID,
        ));
        router.handle_controller_added(ControllerDescriptor::basic(
            "jc-right",
            "Nintendo Switch Joy-Con (R)",
            NINTENDO_VENDOR_ID,
            JOYCON_RIGHT_PRODUCT_ID,
        ));

        assert_eq!(router.slot_for_controller("jc-left"), Some(0));
        assert_eq!(router.slot_for_controller("jc-right"), Some(1));

        router
            .set_joycon_mode("jc-left", JoyConMode::Combined)
            .expect("combine should succeed");

        assert_eq!(router.slot_for_controller("jc-left"), Some(0));
        assert_eq!(router.slot_for_controller("jc-right"), Some(0));

        assert_eq!(
            router.handle_button("jc-left", Button::DPadUp, true),
            Some((0, Button::DPadUp, true))
        );
        assert_eq!(router.handle_button("jc-left", Button::A, true), None);
        assert_eq!(
            router.handle_axis("jc-left", Axis::LeftX, 12000),
            Some((0, Axis::LeftX, 12000))
        );

        assert_eq!(
            router.handle_button("jc-right", Button::A, true),
            Some((0, Button::A, true))
        );
        assert_eq!(router.handle_button("jc-right", Button::DPadUp, true), None);
        assert_eq!(
            router.handle_axis("jc-right", Axis::LeftX, -8000),
            Some((0, Axis::RightX, -8000))
        );

        router
            .set_joycon_mode("jc-right", JoyConMode::SplitRight)
            .expect("split should succeed");
        assert_eq!(router.slot_for_controller("jc-left"), Some(0));
        assert_eq!(router.slot_for_controller("jc-right"), Some(1));
    }

    #[test]
    fn swaps_and_validates_slots() {
        let mut router = InputRouter::new_headless();
        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-a",
            "Pad A",
            MICROSOFT_VENDOR_ID,
            0x02EA,
        ));
        router.handle_controller_added(ControllerDescriptor::basic(
            "pad-b",
            "Pad B",
            MICROSOFT_VENDOR_ID,
            0x02EA,
        ));

        router.swap_slots(0, 1).expect("swap should succeed");
        assert_eq!(router.slot_for_controller("pad-a"), Some(1));
        assert_eq!(router.slot_for_controller("pad-b"), Some(0));

        assert_eq!(
            router.swap_slots(0, SLOT_COUNT),
            Err(RouterError::InvalidSlot {
                slot_index: SLOT_COUNT
            })
        );
    }

    #[test]
    fn excludes_real_wiimotes_from_virtual_routing() {
        assert!(InputRouter::is_excluded_wiimote(
            NINTENDO_VENDOR_ID,
            WIIMOTE_PRODUCT_ID,
            "Nintendo Wii Remote"
        ));
        assert!(InputRouter::is_excluded_wiimote(
            NINTENDO_VENDOR_ID,
            WIIMOTE_PLUS_PRODUCT_ID,
            "Nintendo RVL-CNT-01-TR"
        ));
        assert!(!InputRouter::is_excluded_wiimote(
            NINTENDO_VENDOR_ID,
            SWITCH_PRO_PRODUCT_ID,
            "Pro Controller"
        ));
    }
}
