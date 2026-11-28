//! Configuration and core state types for `virtualpad-daemon`.

#![warn(missing_docs)]

use std::time::Duration;

use clap::Parser;
use serde::{Deserialize, Serialize};

pub use crate::protocol::{
    BatteryLevel, ConnectionType, ControllerKind, JoyConMode, PhysicalController, VirtualSlot,
    VIRTUAL_SLOT_COUNT as SLOT_COUNT,
};

/// Default TCP port for the daemon control server.
pub const DEFAULT_WS_PORT: u16 = 26780;

/// Default UDP port for the DSU/Cemuhook motion and pad server.
pub const DEFAULT_DSU_PORT: u16 = 26760;

/// Default bind host address for the daemon control server.
pub const DEFAULT_WS_HOST: &str = "127.0.0.1";

/// Default SDL polling interval in milliseconds.
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 1;

/// Configuration for the daemon, parsed from CLI arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Parser)]
#[command(
    name = "virtualpad-daemon",
    version,
    about = "Virtual controller slot and DSU motion daemon"
)]
pub struct DaemonConfig {
    /// Control server port (default: 26780).
    #[arg(
        long = "port",
        visible_alias = "ws-port",
        default_value_t = DEFAULT_WS_PORT,
        value_parser = clap::value_parser!(u16).range(1..=65535)
    )]
    pub ws_port: u16,

    /// DSU/Cemuhook UDP port (default: 26760).
    #[arg(
        long = "dsu-port",
        default_value_t = DEFAULT_DSU_PORT,
        value_parser = clap::value_parser!(u16).range(1..=65535)
    )]
    pub dsu_port: u16,

    /// Control server bind address (default: "127.0.0.1").
    #[arg(long = "ws-host", default_value_t = DEFAULT_WS_HOST.to_string())]
    pub ws_host: String,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            ws_port: DEFAULT_WS_PORT,
            dsu_port: DEFAULT_DSU_PORT,
            ws_host: DEFAULT_WS_HOST.to_string(),
        }
    }
}

impl DaemonConfig {
    /// Validates the parsed daemon configuration values.
    pub fn validate(&self) -> Result<(), String> {
        if self.ws_port == 0 {
            return Err("ws_port must be greater than 0".to_string());
        }
        if self.dsu_port == 0 {
            return Err("dsu_port must be greater than 0".to_string());
        }
        if self.ws_host.trim().is_empty() {
            return Err("ws_host must not be empty".to_string());
        }
        Ok(())
    }

    /// Returns the formatted `host:port` socket address for the control server.
    pub fn websocket_address(&self) -> String {
        format!("{}:{}", self.ws_host.trim(), self.ws_port)
    }

    /// Returns the SDL polling interval duration.
    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(DEFAULT_POLL_INTERVAL_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_config_default_matches_expected_ports_and_host() {
        let config = DaemonConfig::default();
        assert_eq!(config.ws_port, 26780);
        assert_eq!(config.dsu_port, 26760);
        assert_eq!(config.ws_host, "127.0.0.1");
        assert_eq!(config.websocket_address(), "127.0.0.1:26780");
        assert!(config.validate().is_ok());
    }

    #[test]
    fn daemon_config_parses_cli_arguments() {
        let config = DaemonConfig::try_parse_from([
            "virtualpad-daemon",
            "--port",
            "27000",
            "--dsu-port",
            "27001",
            "--ws-host",
            "127.0.0.1",
        ])
        .expect("CLI arguments should parse");

        assert_eq!(config.ws_port, 27000);
        assert_eq!(config.dsu_port, 27001);
        assert_eq!(config.ws_host, "127.0.0.1");
        assert!(config.validate().is_ok());
    }

    #[test]
    fn daemon_config_rejects_invalid_values() {
        let zero_ws = DaemonConfig {
            ws_port: 0,
            ..DaemonConfig::default()
        };
        assert!(zero_ws.validate().is_err());

        let zero_dsu = DaemonConfig {
            dsu_port: 0,
            ..DaemonConfig::default()
        };
        assert!(zero_dsu.validate().is_err());

        let empty_host = DaemonConfig {
            ws_host: "   ".to_string(),
            ..DaemonConfig::default()
        };
        assert!(empty_host.validate().is_err());
    }

    #[test]
    fn serde_round_trip_for_config_and_controller_types() {
        let controller = PhysicalController {
            id: "42".to_string(),
            name: "Joy-Con (L)".to_string(),
            kind: ControllerKind::SwitchJoyConLeft,
            vendor_id: 0x057e,
            product_id: 0x2006,
            has_gyro: true,
            has_accelerometer: true,
            battery_level: Some(BatteryLevel::Medium),
            connection_type: ConnectionType::Bluetooth,
            assigned_slot: Some(0),
            joycon_mode: Some(JoyConMode::SplitLeft),
            connected: true,
        };

        let json = serde_json::to_string(&controller).expect("serialize PhysicalController");
        let decoded: PhysicalController =
            serde_json::from_str(&json).expect("deserialize PhysicalController");
        assert_eq!(decoded, controller);

        let slot = VirtualSlot {
            index: 0,
            assigned_physical: Some("42".to_string()),
            active: true,
        };
        let slot_json = serde_json::to_string(&slot).expect("serialize VirtualSlot");
        let slot_decoded: VirtualSlot =
            serde_json::from_str(&slot_json).expect("deserialize VirtualSlot");
        assert_eq!(slot_decoded, slot);
    }

    #[test]
    fn slot_count_and_virtual_slot_defaults() {
        assert_eq!(SLOT_COUNT, 4);
        let slot = VirtualSlot::new(2);
        assert_eq!(slot.index, 2);
        assert_eq!(slot.assigned_physical, None);
        assert!(!slot.active);
    }
}
