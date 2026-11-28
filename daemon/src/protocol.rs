//! JSON IPC protocol definitions for communication between
//! `virtualpad-daemon` and the Node.js host application.

use serde::{Deserialize, Serialize};

/// Number of virtual controller slots exposed by the daemon (`0..4`).
pub const VIRTUAL_SLOT_COUNT: usize = 4;

/// Events sent from `virtualpad-daemon` to the Node.js application.
///
/// Serialized as internally tagged JSON objects using `"type"` as the discriminator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonEvent {
    /// Full state snapshot sent upon initial connection and whenever state changes.
    StateUpdate {
        /// Current state of all four virtual controller slots.
        slots: [VirtualSlot; VIRTUAL_SLOT_COUNT],
        /// All currently tracked physical controllers.
        #[serde(rename = "physicalControllers")]
        physical_controllers: Vec<PhysicalController>,
    },
    /// Emitted when a new physical controller is detected.
    ControllerConnected {
        /// Metadata and initial state of the connected physical controller.
        controller: PhysicalController,
    },
    /// Emitted when a physical controller is unplugged or disconnected.
    ControllerDisconnected {
        /// Unique identifier of the disconnected physical controller.
        #[serde(rename = "controllerId")]
        controller_id: String,
    },
    /// Emitted when the Home/Guide button is pressed on a physical controller.
    HomeButtonPressed {
        /// Unique identifier of the physical controller that triggered the press.
        #[serde(rename = "controllerId")]
        controller_id: String,
        /// Virtual slot index (`0..4`) the controller is assigned to, if any.
        #[serde(rename = "slotIndex")]
        slot_index: Option<usize>,
    },
    /// Emitted when a physical controller's reported battery level changes.
    BatteryUpdate {
        /// Unique identifier of the physical controller.
        #[serde(rename = "controllerId")]
        controller_id: String,
        /// Updated battery level.
        level: BatteryLevel,
    },
}

/// Commands sent from the Node.js application to `virtualpad-daemon`.
///
/// Serialized as internally tagged JSON objects using `"type"` as the discriminator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonCommand {
    /// Assign a physical controller to one of the virtual slots (`0..4`).
    AssignController {
        /// Unique identifier of the physical controller to assign.
        #[serde(rename = "controllerId")]
        controller_id: String,
        /// Target virtual slot index (`0..=3`).
        #[serde(rename = "slotIndex")]
        slot_index: usize,
    },
    /// Remove a physical controller from its currently assigned virtual slot.
    UnassignController {
        /// Unique identifier of the physical controller to unassign.
        #[serde(rename = "controllerId")]
        controller_id: String,
    },
    /// Swap the assignments between two virtual slots.
    SwapSlots {
        /// First virtual slot index (`0..=3`).
        #[serde(rename = "slotA")]
        slot_a: usize,
        /// Second virtual slot index (`0..=3`).
        #[serde(rename = "slotB")]
        slot_b: usize,
    },
    /// Change the combined/split operating mode for a Joy-Con controller.
    SetJoyConMode {
        /// Unique identifier of the Joy-Con physical controller.
        #[serde(rename = "controllerId")]
        controller_id: String,
        /// Desired Joy-Con mode (`"combined"`, `"split_left"`, or `"split_right"`).
        mode: JoyConMode,
    },
    /// Automatically assign any unassigned physical controllers to free virtual slots.
    AutoAssign,
    /// Request an immediate [`DaemonEvent::StateUpdate`] snapshot from the daemon.
    QueryState,
}

/// Backwards-compatible alias for [`DaemonCommand`].
pub type NodeCommand = DaemonCommand;

impl DaemonCommand {
    /// Validates command parameters received from the Node.js client.
    ///
    /// Returns `Ok(())` when all slot indices are within `0..VIRTUAL_SLOT_COUNT`
    /// and required controller identifiers are non-empty.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            DaemonCommand::AssignController {
                controller_id,
                slot_index,
            } => {
                if controller_id.trim().is_empty() {
                    return Err("controllerId must not be empty".to_string());
                }
                if *slot_index >= VIRTUAL_SLOT_COUNT {
                    return Err(format!(
                        "slotIndex {slot_index} is out of range (expected 0..{VIRTUAL_SLOT_COUNT})"
                    ));
                }
                Ok(())
            }
            DaemonCommand::UnassignController { controller_id }
            | DaemonCommand::SetJoyConMode { controller_id, .. } => {
                if controller_id.trim().is_empty() {
                    return Err("controllerId must not be empty".to_string());
                }
                Ok(())
            }
            DaemonCommand::SwapSlots { slot_a, slot_b } => {
                if *slot_a >= VIRTUAL_SLOT_COUNT {
                    return Err(format!(
                        "slotA {slot_a} is out of range (expected 0..{VIRTUAL_SLOT_COUNT})"
                    ));
                }
                if *slot_b >= VIRTUAL_SLOT_COUNT {
                    return Err(format!(
                        "slotB {slot_b} is out of range (expected 0..{VIRTUAL_SLOT_COUNT})"
                    ));
                }
                Ok(())
            }
            DaemonCommand::AutoAssign | DaemonCommand::QueryState => Ok(()),
        }
    }
}

/// State of a single virtual gamepad slot managed by the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualSlot {
    /// Zero-based slot index (`0..=3`).
    pub index: usize,
    /// Identifier of the physical controller currently mapped to this slot, if any.
    pub assigned_physical: Option<String>,
    /// Whether the virtual device backing this slot is currently active.
    pub active: bool,
}

impl VirtualSlot {
    /// Creates an empty, inactive virtual slot for the given zero-based index.
    pub fn new(index: usize) -> Self {
        Self {
            index,
            assigned_physical: None,
            active: false,
        }
    }
}

/// Metadata and live status for a physical controller discovered by the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalController {
    /// Stable daemon-assigned identifier for this physical controller.
    pub id: String,
    /// Human-readable device name reported by SDL.
    pub name: String,
    /// Detected controller hardware/layout family.
    pub kind: ControllerKind,
    /// USB/Bluetooth HID vendor ID.
    pub vendor_id: u16,
    /// USB/Bluetooth HID product ID.
    pub product_id: u16,
    /// Whether this controller exposes gyroscope data.
    pub has_gyro: bool,
    /// Whether this controller exposes accelerometer data.
    pub has_accelerometer: bool,
    /// Last known battery or power status.
    pub battery_level: Option<BatteryLevel>,
    /// Physical transport used by the controller.
    pub connection_type: ConnectionType,
    /// Virtual slot index (`0..=3`) currently assigned to this controller, if any.
    pub assigned_slot: Option<usize>,
    /// Current Joy-Con split/combine mode, or `None` for non-Joy-Con controllers.
    pub joycon_mode: Option<JoyConMode>,
    /// Whether the physical device is currently connected (internal router state).
    #[serde(default = "default_connected", skip_serializing_if = "is_true")]
    pub connected: bool,
}

fn default_connected() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

/// Hardware/layout classification of a physical controller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControllerKind {
    /// Xbox / XInput compatible controller.
    Xbox,
    /// Nintendo Switch Pro Controller or standard Switch controller.
    Switch,
    /// Single left Nintendo Switch Joy-Con.
    #[serde(rename = "switch_joycon_left")]
    SwitchJoyConLeft,
    /// Single right Nintendo Switch Joy-Con.
    #[serde(rename = "switch_joycon_right")]
    SwitchJoyConRight,
    /// Sony DualShock / DualSense PlayStation controller.
    #[serde(rename = "playstation")]
    PlayStation,
    /// Nintendo GameCube controller or adapter port.
    #[serde(rename = "gamecube")]
    GameCube,
    /// Any other generic HID/SDL gamepad.
    #[default]
    Generic,
}

/// Battery charge state reported for a physical controller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryLevel {
    /// Battery state is unavailable or unsupported.
    #[default]
    Unknown,
    /// Battery is depleted and requires immediate charging.
    Empty,
    /// Battery charge is critically low.
    Critical,
    /// Battery charge is low.
    Low,
    /// Battery charge is moderate.
    Medium,
    /// Battery charge is high.
    High,
    /// Battery is fully charged.
    Full,
    /// Controller is powered over a wired connection.
    Wired,
}

/// Transport medium over which a physical controller is connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionType {
    /// Transport could not be determined.
    #[default]
    Unknown,
    /// Connected over USB.
    Usb,
    /// Connected wirelessly over Bluetooth.
    Bluetooth,
    /// Connected over a proprietary wireless adapter.
    Wireless,
}

/// Operating mode for Nintendo Switch Joy-Con controllers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoyConMode {
    /// Left and right Joy-Cons combined into a single dual-stick virtual gamepad.
    #[default]
    Combined,
    /// Left Joy-Con operated standalone in horizontal split mode.
    SplitLeft,
    /// Right Joy-Con operated standalone in horizontal split mode.
    SplitRight,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_controller() -> PhysicalController {
        PhysicalController {
            id: "ctrl-1".to_string(),
            name: "Nintendo Switch Joy-Con (L)".to_string(),
            kind: ControllerKind::SwitchJoyConLeft,
            vendor_id: 0x057e,
            product_id: 0x2006,
            has_gyro: true,
            has_accelerometer: true,
            battery_level: Some(BatteryLevel::High),
            connection_type: ConnectionType::Bluetooth,
            assigned_slot: Some(0),
            joycon_mode: Some(JoyConMode::SplitLeft),
            connected: true,
        }
    }

    #[test]
    fn serializes_state_update_with_camel_case_fields() {
        let slots = [
            VirtualSlot {
                index: 0,
                assigned_physical: Some("ctrl-1".to_string()),
                active: true,
            },
            VirtualSlot::new(1),
            VirtualSlot::new(2),
            VirtualSlot::new(3),
        ];
        let event = DaemonEvent::StateUpdate {
            slots,
            physical_controllers: vec![sample_controller()],
        };

        let value = serde_json::to_value(&event).expect("StateUpdate should serialize");
        assert_eq!(value["type"], "StateUpdate");
        assert_eq!(value["slots"].as_array().map(Vec::len), Some(4));
        assert_eq!(value["slots"][0]["assignedPhysical"], "ctrl-1");
        assert_eq!(value["slots"][1]["assignedPhysical"], json!(null));
        assert_eq!(value["physicalControllers"][0]["vendorId"], 0x057e);
        assert_eq!(value["physicalControllers"][0]["productId"], 0x2006);
        assert_eq!(value["physicalControllers"][0]["hasGyro"], true);
        assert_eq!(value["physicalControllers"][0]["hasAccelerometer"], true);
        assert_eq!(value["physicalControllers"][0]["batteryLevel"], "high");
        assert_eq!(
            value["physicalControllers"][0]["connectionType"],
            "bluetooth"
        );
        assert_eq!(value["physicalControllers"][0]["assignedSlot"], 0);
        assert_eq!(value["physicalControllers"][0]["joyconMode"], "split_left");
        assert_eq!(
            value["physicalControllers"][0]["kind"],
            "switch_joycon_left"
        );

        let round_trip: DaemonEvent =
            serde_json::from_value(value).expect("StateUpdate should deserialize");
        assert_eq!(round_trip, event);
    }

    #[test]
    fn round_trips_remaining_daemon_events() {
        let events = vec![
            DaemonEvent::ControllerConnected {
                controller: sample_controller(),
            },
            DaemonEvent::ControllerDisconnected {
                controller_id: "ctrl-1".to_string(),
            },
            DaemonEvent::HomeButtonPressed {
                controller_id: "ctrl-1".to_string(),
                slot_index: Some(2),
            },
            DaemonEvent::BatteryUpdate {
                controller_id: "ctrl-1".to_string(),
                level: BatteryLevel::Critical,
            },
        ];

        for event in events {
            let serialized = serde_json::to_string(&event).expect("event should serialize");
            let deserialized: DaemonEvent =
                serde_json::from_str(&serialized).expect("event should deserialize");
            assert_eq!(deserialized, event);
        }
    }

    #[test]
    fn deserializes_all_daemon_commands() {
        let cases = vec![
            (
                json!({
                    "type": "AssignController",
                    "controllerId": "ctrl-1",
                    "slotIndex": 2
                }),
                DaemonCommand::AssignController {
                    controller_id: "ctrl-1".to_string(),
                    slot_index: 2,
                },
            ),
            (
                json!({
                    "type": "UnassignController",
                    "controllerId": "ctrl-1"
                }),
                DaemonCommand::UnassignController {
                    controller_id: "ctrl-1".to_string(),
                },
            ),
            (
                json!({
                    "type": "SwapSlots",
                    "slotA": 0,
                    "slotB": 3
                }),
                DaemonCommand::SwapSlots {
                    slot_a: 0,
                    slot_b: 3,
                },
            ),
            (
                json!({
                    "type": "SetJoyConMode",
                    "controllerId": "ctrl-1",
                    "mode": "combined"
                }),
                DaemonCommand::SetJoyConMode {
                    controller_id: "ctrl-1".to_string(),
                    mode: JoyConMode::Combined,
                },
            ),
            (json!({ "type": "AutoAssign" }), DaemonCommand::AutoAssign),
            (json!({ "type": "QueryState" }), DaemonCommand::QueryState),
        ];

        for (payload, expected) in cases {
            let parsed: DaemonCommand =
                serde_json::from_value(payload).expect("command should deserialize");
            assert_eq!(parsed, expected);
            assert!(parsed.validate().is_ok());
        }
    }

    #[test]
    fn validates_command_inputs() {
        let invalid_slot = DaemonCommand::AssignController {
            controller_id: "ctrl-1".to_string(),
            slot_index: 4,
        };
        assert!(invalid_slot.validate().is_err());

        let empty_id = DaemonCommand::UnassignController {
            controller_id: "   ".to_string(),
        };
        assert!(empty_id.validate().is_err());

        let invalid_swap = DaemonCommand::SwapSlots {
            slot_a: 1,
            slot_b: 5,
        };
        assert!(invalid_swap.validate().is_err());
    }
}
