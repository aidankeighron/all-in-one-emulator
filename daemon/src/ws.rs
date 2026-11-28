//! Dual-transport IPC server supporting WebSocket upgrades and newline-delimited
//! JSON (ndjson) over TCP on `127.0.0.1:<port>`.

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{DaemonEvent, NodeCommand};

/// Default TCP port the daemon IPC server listens on.
pub const DEFAULT_PORT: u16 = 26780;

/// Broadcast channel capacity for outgoing serialized events.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// MPSC channel capacity for incoming parsed commands.
const COMMAND_CHANNEL_CAPACITY: usize = 256;

/// Interval between WebSocket keepalive ping frames.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Errors that can occur while broadcasting a [`DaemonEvent`] to connected clients.
#[derive(Debug)]
pub enum BroadcastError {
    /// Failed to serialize the event into JSON.
    Serialization(serde_json::Error),
    /// Failed to deliver the event because no active client receivers are subscribed.
    Send(broadcast::error::SendError<String>),
}

impl BroadcastError {
    /// Returns `true` if the broadcast failed solely because no clients are connected.
    pub fn is_no_receivers(&self) -> bool {
        matches!(self, Self::Send(_))
    }
}

impl fmt::Display for BroadcastError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(error) => {
                write!(formatter, "failed to serialize DaemonEvent: {}", error)
            }
            Self::Send(error) => {
                write!(formatter, "failed to broadcast event to clients: {}", error)
            }
        }
    }
}

impl std::error::Error for BroadcastError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Serialization(error) => Some(error),
            Self::Send(error) => Some(error),
        }
    }
}

impl From<serde_json::Error> for BroadcastError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error)
    }
}

impl From<broadcast::error::SendError<String>> for BroadcastError {
    fn from(error: broadcast::error::SendError<String>) -> Self {
        Self::Send(error)
    }
}

/// IPC server for daemon<->Node.js communication (WebSocket + TCP ndjson).
pub struct WsServer {
    /// Channel for broadcasting events to all connected clients.
    event_sender: broadcast::Sender<String>,
    /// Channel for receiving commands from any connected client.
    command_sender: tokio::sync::mpsc::Sender<NodeCommand>,
    /// Receiver end for the main loop to consume commands.
    command_receiver: tokio::sync::mpsc::Receiver<NodeCommand>,
    /// Latest serialized `StateUpdate` event sent immediately to newly connected clients.
    latest_state: Arc<RwLock<Option<String>>>,
}

impl WsServer {
    /// Create a new IPC server.
    pub fn new() -> Self {
        let (event_sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (command_sender, command_receiver) = tokio::sync::mpsc::channel(COMMAND_CHANNEL_CAPACITY);

        Self {
            event_sender,
            command_sender,
            command_receiver,
            latest_state: Arc::new(RwLock::new(None)),
        }
    }

    /// Start listening for connections on the given address.
    pub async fn listen(&self, addr: &str) -> Result<SocketAddr, Box<dyn std::error::Error>> {
        let trimmed_address = addr.trim();
        if trimmed_address.is_empty() {
            return Err(Box::new(io::Error::new(
                io::ErrorKind::InvalidInput,
                "WebSocket listen address must not be empty",
            )));
        }

        let listener = TcpListener::bind(trimmed_address).await?;
        let bound_address = listener.local_addr()?;
        info!("WebSocket server listening on {}", bound_address);

        let event_sender = self.event_sender.clone();
        let command_sender = self.command_sender.clone();
        let latest_state = Arc::clone(&self.latest_state);

        tokio::spawn(async move {
            accept_connections(listener, event_sender, command_sender, latest_state).await;
        });

        Ok(bound_address)
    }

    /// Broadcast an event to all connected clients.
    pub fn broadcast(&self, event: DaemonEvent) -> Result<(), BroadcastError> {
        let value = serde_json::to_value(&event)?;
        let json = serde_json::to_string(&value)?;

        if is_state_update_value(&value) {
            self.store_latest_state(&json);
        }

        self.event_sender.send(json)?;
        Ok(())
    }

    /// Update the cached `StateUpdate` JSON sent to newly connected clients without requiring active receivers.
    pub fn set_initial_state(&self, event: &DaemonEvent) -> Result<(), BroadcastError> {
        let json = serde_json::to_string(event)?;
        self.store_latest_state(&json);
        Ok(())
    }

    /// Try to receive the next command without blocking.
    pub fn try_recv_command(&mut self) -> Option<NodeCommand> {
        self.command_receiver.try_recv().ok()
    }

    /// Receive the next command from any connected client.
    pub async fn recv_command(&mut self) -> Option<NodeCommand> {
        self.command_receiver.recv().await
    }

    /// Get a clone of the event sender.
    pub fn event_broadcaster(&self) -> broadcast::Sender<String> {
        self.event_sender.clone()
    }

    /// Get a clone of the command sender.
    pub fn command_forwarder(&self) -> tokio::sync::mpsc::Sender<NodeCommand> {
        self.command_sender.clone()
    }

    fn store_latest_state(&self, json: &str) {
        match self.latest_state.write() {
            Ok(mut guard) => {
                *guard = Some(json.to_owned());
            }
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = Some(json.to_owned());
            }
        }
    }
}

impl Default for WsServer {
    fn default() -> Self {
        Self::new()
    }
}

/// Continuously accept incoming TCP connections and spawn a handler task per client.
async fn accept_connections(
    listener: TcpListener,
    event_sender: broadcast::Sender<String>,
    command_sender: tokio::sync::mpsc::Sender<NodeCommand>,
    latest_state: Arc<RwLock<Option<String>>>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, peer_address)) => {
                let connection_event_sender = event_sender.clone();
                let connection_command_sender = command_sender.clone();
                let connection_latest_state = Arc::clone(&latest_state);

                tokio::spawn(async move {
                    handle_connection(
                        stream,
                        peer_address,
                        connection_event_sender,
                        connection_command_sender,
                        connection_latest_state,
                    )
                    .await;
                });
            }
            Err(error) => {
                error!("Failed to accept incoming TCP connection: {}", error);
            }
        }
    }
}

/// Inspect initial bytes on a socket (with a short peek timeout) to decide between
/// WebSocket HTTP upgrade (`GET `) and raw TCP ndjson (`virtualpad.js`).
async fn is_websocket_handshake(stream: &TcpStream) -> bool {
    let mut prefix = [0u8; 4];
    match tokio::time::timeout(Duration::from_millis(50), stream.peek(&mut prefix)).await {
        Ok(Ok(count)) if count >= 4 => &prefix == b"GET ",
        _ => false,
    }
}

/// Dispatch an accepted TCP connection to either WebSocket or raw ndjson framing.
async fn handle_connection(
    stream: TcpStream,
    peer_address: SocketAddr,
    event_sender: broadcast::Sender<String>,
    command_sender: tokio::sync::mpsc::Sender<NodeCommand>,
    latest_state: Arc<RwLock<Option<String>>>,
) {
    if is_websocket_handshake(&stream).await {
        handle_websocket_connection(
            stream,
            peer_address,
            event_sender,
            command_sender,
            latest_state,
        )
        .await;
    }
    else {
        handle_ndjson_connection(
            stream,
            peer_address,
            event_sender,
            command_sender,
            latest_state,
        )
        .await;
    }
}

/// Handle a raw TCP newline-delimited JSON connection (used by `ui/lib/virtualpad.js`).
async fn handle_ndjson_connection(
    stream: TcpStream,
    peer_address: SocketAddr,
    event_sender: broadcast::Sender<String>,
    command_sender: tokio::sync::mpsc::Sender<NodeCommand>,
    latest_state: Arc<RwLock<Option<String>>>,
) {
    info!("IPC ndjson client connected: {}", peer_address);
    let mut event_receiver = event_sender.subscribe();
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    if let Some(state_json) = read_latest_state(&latest_state) {
        let mut line = state_json;
        line.push('\n');
        if let Err(error) = write_half.write_all(line.as_bytes()).await {
            warn!(
                "Failed to send initial StateUpdate to {}: {}",
                peer_address, error
            );
            return;
        }
    }

    loop {
        tokio::select! {
            line_result = lines.next_line() => {
                match line_result {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if !forward_command_json(trimmed.as_bytes(), peer_address, &command_sender).await {
                            break;
                        }
                    }
                    Ok(None) => {
                        break;
                    }
                    Err(error) => {
                        warn!("IPC ndjson read error from {}: {}", peer_address, error);
                        break;
                    }
                }
            }
            broadcast_result = event_receiver.recv() => {
                match broadcast_result {
                    Ok(mut json) => {
                        json.push('\n');
                        if let Err(error) = write_half.write_all(json.as_bytes()).await {
                            warn!("Failed to forward ndjson event to {}: {}", peer_address, error);
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(
                            "IPC client {} lagged behind by {} broadcast events",
                            peer_address, skipped
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }

    info!("IPC ndjson client disconnected: {}", peer_address);
}

/// Handle a WebSocket client connection lifecycle.
async fn handle_websocket_connection(
    stream: TcpStream,
    peer_address: SocketAddr,
    event_sender: broadcast::Sender<String>,
    command_sender: tokio::sync::mpsc::Sender<NodeCommand>,
    latest_state: Arc<RwLock<Option<String>>>,
) {
    let websocket_stream = match accept_async(stream).await {
        Ok(stream) => stream,
        Err(error) => {
            warn!("WebSocket upgrade failed for {}: {}", peer_address, error);
            return;
        }
    };

    info!("WebSocket client connected: {}", peer_address);

    let mut event_receiver = event_sender.subscribe();
    let (mut websocket_sender, mut websocket_receiver) = websocket_stream.split();

    if let Some(state_json) = read_latest_state(&latest_state) {
        if let Err(error) = websocket_sender.send(Message::Text(state_json)).await {
            warn!(
                "Failed to send initial StateUpdate to {}: {}",
                peer_address, error
            );
            info!("WebSocket client disconnected: {}", peer_address);
            return;
        }
    }
    else {
        debug!("No cached StateUpdate available for new client {}", peer_address);
    }

    let mut keepalive_interval = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    keepalive_interval.tick().await;

    let mut awaiting_pong = false;

    loop {
        tokio::select! {
            incoming = websocket_receiver.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        match message {
                            Message::Text(text) => {
                                if !forward_command_json(text.as_bytes(), peer_address, &command_sender).await {
                                    break;
                                }
                            }
                            Message::Binary(bytes) => {
                                if !forward_command_json(&bytes, peer_address, &command_sender).await {
                                    break;
                                }
                            }
                            Message::Ping(_) => {
                                awaiting_pong = false;
                            }
                            Message::Pong(_) => {
                                awaiting_pong = false;
                            }
                            Message::Close(frame) => {
                                debug!("WebSocket close frame received from {}: {:?}", peer_address, frame);
                                break;
                            }
                            Message::Frame(_) => {}
                        }
                    }
                    Some(Err(error)) => {
                        warn!("WebSocket receive error from {}: {}", peer_address, error);
                        break;
                    }
                    None => {
                        break;
                    }
                }
            }
            broadcast_result = event_receiver.recv() => {
                match broadcast_result {
                    Ok(json) => {
                        if let Err(error) = websocket_sender.send(Message::Text(json)).await {
                            warn!("Failed to forward event to {}: {}", peer_address, error);
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(
                            "WebSocket client {} lagged behind by {} broadcast events",
                            peer_address, skipped
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("Event broadcast channel closed for {}", peer_address);
                        break;
                    }
                }
            }
            _ = keepalive_interval.tick() => {
                if awaiting_pong {
                    warn!("WebSocket client {} timed out waiting for pong", peer_address);
                    break;
                }

                if let Err(error) = websocket_sender.send(Message::Ping(Vec::new())).await {
                    warn!("Failed to send keepalive ping to {}: {}", peer_address, error);
                    break;
                }

                awaiting_pong = true;
            }
        }
    }

    let _ = websocket_sender.close().await;
    info!("WebSocket client disconnected: {}", peer_address);
}

/// Parse a JSON payload as [`NodeCommand`], validate it, and forward it to the daemon channel.
async fn forward_command_json(
    payload: &[u8],
    peer_address: SocketAddr,
    command_sender: &tokio::sync::mpsc::Sender<NodeCommand>,
) -> bool {
    let command = match serde_json::from_slice::<NodeCommand>(payload) {
        Ok(command) => command,
        Err(error) => {
            let payload_preview = String::from_utf8_lossy(payload);
            warn!(
                "Failed to parse NodeCommand JSON from {}: {} (payload: {})",
                peer_address, error, payload_preview
            );
            return true;
        }
    };

    if let Err(reason) = command.validate() {
        warn!("Rejected invalid NodeCommand from {}: {}", peer_address, reason);
        return true;
    }

    debug!("Received command from {}: {:?}", peer_address, command);

    if let Err(error) = command_sender.send(command).await {
        error!(
            "Command channel closed while forwarding command from {}: {}",
            peer_address, error
        );
        return false;
    }

    true
}

/// Read the latest cached `StateUpdate` JSON string, recovering gracefully from lock poisoning.
fn read_latest_state(latest_state: &Arc<RwLock<Option<String>>>) -> Option<String> {
    match latest_state.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// Detect whether a serialized [`DaemonEvent`] JSON value represents a `StateUpdate`.
fn is_state_update_value(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };

    if object.contains_key("StateUpdate")
        || object.contains_key("state_update")
        || object.contains_key("stateUpdate")
    {
        return true;
    }

    for tag_key in ["type", "event", "kind"] {
        if let Some(tag) = object.get(tag_key).and_then(|field| field.as_str()) {
            if matches!(tag, "StateUpdate" | "state_update" | "stateUpdate") {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detects_externally_tagged_state_update() {
        assert!(is_state_update_value(&json!({ "StateUpdate": { "slots": [] } })));
        assert!(is_state_update_value(&json!({ "state_update": { "slots": [] } })));
    }

    #[test]
    fn detects_internally_tagged_state_update() {
        assert!(is_state_update_value(&json!({ "type": "StateUpdate", "slots": [] })));
        assert!(is_state_update_value(&json!({ "type": "state_update", "slots": [] })));
        assert!(is_state_update_value(&json!({ "event": "stateUpdate", "slots": [] })));
    }

    #[test]
    fn ignores_non_state_update_events() {
        assert!(!is_state_update_value(&json!({ "type": "SlotAssigned", "slot": 0 })));
        assert!(!is_state_update_value(&json!("plain_string")));
    }

    #[test]
    fn broadcast_error_display_and_predicate() {
        let parse_error = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let serialization_error = BroadcastError::from(parse_error);
        assert!(!serialization_error.is_no_receivers());
        assert!(serialization_error.to_string().contains("serialize"));

        let (sender, _) = broadcast::channel::<String>(1);
        let send_error = sender.send("hello".to_string()).unwrap_err();
        let channel_error = BroadcastError::from(send_error);
        assert!(channel_error.is_no_receivers());
        assert!(channel_error.to_string().contains("broadcast"));
    }
}
