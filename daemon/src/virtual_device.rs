//! Virtual gamepad device abstraction and platform-specific backends.
//!
//! Provides a unified [`VirtualGamepad`] trait backed by `uinput` on Linux and
//! `ViGEmBus` (via `vigem-client`) on Windows, supporting up to 4 virtual
//! controller slots that emulators see as physical gamepads.

use std::fmt;

/// Maximum number of virtual gamepad slots supported by the daemon.
pub const MAX_VIRTUAL_SLOTS: usize = 4;

/// Type alias for the rumble callback invoked when an emulator sends force-feedback.
///
/// Parameters are `(low_frequency_rumble, high_frequency_rumble, duration_ms)`.
pub type RumbleCallback = Box<dyn Fn(u16, u16, u32) + Send>;

/// A virtual gamepad device that emulators see as a real controller.
/// On Linux, this is backed by uinput. On Windows, by ViGEmBus.
pub trait VirtualGamepad: Send {
    /// Create and register the virtual device with the OS
    fn create(slot_index: usize) -> Result<Self, VirtualDeviceError>
    where
        Self: Sized;

    /// Set a button state (pressed or released)
    fn set_button(&mut self, button: VirtualButton, pressed: bool) -> Result<(), VirtualDeviceError>;

    /// Set an axis value (normalized to -32768..32767 for sticks, 0..255 for triggers)
    fn set_axis(&mut self, axis: VirtualAxis, value: i32) -> Result<(), VirtualDeviceError>;

    /// Reset all inputs to neutral (all buttons up, axes centered)
    fn reset(&mut self) -> Result<(), VirtualDeviceError>;

    /// Set the player LED indicator (1-4)
    fn set_player_led(&mut self, player: u8) -> Result<(), VirtualDeviceError>;

    /// Forward rumble to the physical controller (via callback)
    fn set_rumble_callback(&mut self, callback: Box<dyn Fn(u16, u16, u32) + Send>);

    /// Get the device path/identifier that emulators can bind to
    fn device_identifier(&self) -> &str;

    /// Destroy the virtual device
    fn destroy(&mut self) -> Result<(), VirtualDeviceError>;
}

/// Digital buttons exposed by a virtual gamepad.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VirtualButton {
    /// South face button (Xbox A / Nintendo B).
    A,
    /// East face button (Xbox B / Nintendo A).
    B,
    /// West face button (Xbox X / Nintendo Y).
    X,
    /// North face button (Xbox Y / Nintendo X).
    Y,
    /// Directional pad up.
    DPadUp,
    /// Directional pad down.
    DPadDown,
    /// Directional pad left.
    DPadLeft,
    /// Directional pad right.
    DPadRight,
    /// Left shoulder bumper (LB / L).
    LeftShoulder,
    /// Right shoulder bumper (RB / R).
    RightShoulder,
    /// Left trigger digital press (LT / ZL).
    LeftTrigger,
    /// Right trigger digital press (RT / ZR).
    RightTrigger,
    /// Left analog stick click (L3).
    LeftStick,
    /// Right analog stick click (R3).
    RightStick,
    /// Start / Plus / Menu button.
    Start,
    /// Back / Select / Minus / View button.
    Back,
    /// Guide / Home button (only forwarded explicitly, normally intercepted).
    Guide,
}

/// Analog axes exposed by a virtual gamepad.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VirtualAxis {
    /// Left analog stick horizontal axis (`-32768..=32767`).
    LeftStickX,
    /// Left analog stick vertical axis (`-32768..=32767`).
    LeftStickY,
    /// Right analog stick horizontal axis (`-32768..=32767`).
    RightStickX,
    /// Right analog stick vertical axis (`-32768..=32767`).
    RightStickY,
    /// Left analog trigger axis (`0..=255`).
    LeftTrigger,
    /// Right analog trigger axis (`0..=255`).
    RightTrigger,
}

/// Errors produced when creating, updating, or destroying virtual gamepads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VirtualDeviceError {
    /// Creating or registering the virtual device with the OS failed.
    CreationFailed(String),
    /// An I/O or driver communication error occurred while updating or reading the device.
    IoError(String),
    /// Virtual gamepads or a requested operation are not supported on this platform.
    NotSupported(String),
}

impl fmt::Display for VirtualDeviceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VirtualDeviceError::CreationFailed(message) => {
                write!(formatter, "virtual device creation failed: {message}")
            }
            VirtualDeviceError::IoError(message) => {
                write!(formatter, "virtual device I/O error: {message}")
            }
            VirtualDeviceError::NotSupported(message) => {
                write!(formatter, "virtual device operation not supported: {message}")
            }
        }
    }
}

impl std::error::Error for VirtualDeviceError {}

/// Create all 4 virtual gamepad slots (`0..4`) for the current platform.
pub fn create_virtual_slots() -> Result<Vec<Box<dyn VirtualGamepad>>, VirtualDeviceError> {
    (0..MAX_VIRTUAL_SLOTS)
        .map(create_platform_gamepad)
        .collect()
}

/// Create a boxed platform-specific virtual gamepad for the given `slot_index` (`0..4`).
fn create_platform_gamepad(slot_index: usize) -> Result<Box<dyn VirtualGamepad>, VirtualDeviceError> {
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(LinuxVirtualGamepad::create(slot_index)?))
    }

    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(WindowsVirtualGamepad::create(slot_index)?))
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = slot_index;
        Err(VirtualDeviceError::NotSupported(
            "Virtual gamepads are only supported on Linux and Windows".to_string(),
        ))
    }
}

/// Validate that `slot_index` is within `0..MAX_VIRTUAL_SLOTS`.
fn validate_slot_index(slot_index: usize) -> Result<(), VirtualDeviceError> {
    if slot_index >= MAX_VIRTUAL_SLOTS {
        return Err(VirtualDeviceError::CreationFailed(format!(
            "Invalid virtual slot index {slot_index}: expected 0..{MAX_VIRTUAL_SLOTS}"
        )));
    }
    Ok(())
}

/// Validate that `player` is within `1..=4`.
fn validate_player_number(player: u8) -> Result<(), VirtualDeviceError> {
    if !(1..=MAX_VIRTUAL_SLOTS as u8).contains(&player) {
        return Err(VirtualDeviceError::IoError(format!(
            "Invalid player LED number {player}: expected 1..={MAX_VIRTUAL_SLOTS}"
        )));
    }
    Ok(())
}

/// Clamp a stick axis input into the signed 16-bit range `-32768..=32767`.
fn clamp_stick_axis(value: i32) -> i16 {
    value.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// Clamp a trigger axis input into the unsigned 8-bit range `0..=255`.
fn clamp_trigger_axis(value: i32) -> u8 {
    value.clamp(0, u8::MAX as i32) as u8
}

/// Compute the effective trigger value combining analog position and digital press.
fn effective_trigger_value(analog_value: u8, digital_pressed: bool) -> u8 {
    if digital_pressed {
        u8::MAX
    } else {
        analog_value
    }
}

#[cfg(target_os = "linux")]
mod linux_impl {
    use super::{
        clamp_stick_axis, clamp_trigger_axis, effective_trigger_value, validate_player_number,
        validate_slot_index, RumbleCallback, VirtualAxis, VirtualButton, VirtualDeviceError,
        VirtualGamepad,
    };
    use nix::fcntl::OFlag;
    use nix::sys::ioctl::ioctl_param_type;
    use std::collections::HashMap;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::mem;
    use std::os::raw::{c_int, c_long};
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::slice;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use uinput::event::absolute::{Hat, Position};
    use uinput::event::controller::{DPad, GamePad};
    use uinput::event::Code;

    const UINPUT_MAX_NAME_SIZE: usize = 80;
    const ABS_CNT: usize = 64;
    const BUS_USB: u16 = 0x03;
    const VIRTUAL_VENDOR_ID: u16 = 0x045E;
    const VIRTUAL_PRODUCT_ID: u16 = 0x028E;
    const VIRTUAL_VERSION: u16 = 0x0110;
    const MAX_FF_EFFECTS: u32 = 16;

    const EV_KEY: ioctl_param_type = 0x01;
    const EV_ABS: ioctl_param_type = 0x03;
    const EV_FF_BIT: ioctl_param_type = 0x15;
    const EV_FF: u16 = 0x15;
    const EV_UINPUT: u16 = 0x0101;
    const UI_FF_UPLOAD: u16 = 1;
    const UI_FF_ERASE: u16 = 2;
    const FF_RUMBLE_CODE: u16 = 0x50;
    const FF_RUMBLE_BIT: ioctl_param_type = 0x50;

    /// Kernel `struct input_id`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputId {
        bustype: u16,
        vendor: u16,
        product: u16,
        version: u16,
    }

    /// Kernel `struct uinput_user_dev`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UinputUserDev {
        name: [u8; UINPUT_MAX_NAME_SIZE],
        id: InputId,
        ff_effects_max: u32,
        absmax: [i32; ABS_CNT],
        absmin: [i32; ABS_CNT],
        absfuzz: [i32; ABS_CNT],
        absflat: [i32; ABS_CNT],
    }

    /// Kernel `struct timeval` used inside `struct input_event`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct TimeVal {
        tv_sec: c_long,
        tv_usec: c_long,
    }

    /// Kernel `struct input_event`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InputEvent {
        time: TimeVal,
        kind: u16,
        code: u16,
        value: i32,
    }

    /// Kernel `struct ff_trigger`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfTrigger {
        button: u16,
        interval: u16,
    }

    /// Kernel `struct ff_replay`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfReplay {
        length: u16,
        delay: u16,
    }

    /// Kernel `struct ff_envelope`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfEnvelope {
        attack_length: u16,
        attack_level: u16,
        fade_length: u16,
        fade_level: u16,
    }

    /// Kernel `struct ff_rumble_effect`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfRumbleEffect {
        strong_magnitude: u16,
        weak_magnitude: u16,
    }

    /// Kernel `struct ff_condition_effect`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfConditionEffect {
        right_saturation: u16,
        left_saturation: u16,
        right_coeff: i16,
        left_coeff: i16,
        deadband: u16,
        center: i16,
    }

    /// Kernel `struct ff_periodic_effect` (ensures exact C ABI union size and alignment).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfPeriodicEffect {
        waveform: u16,
        period: u16,
        magnitude: i16,
        offset: i16,
        phase: u16,
        envelope: FfEnvelope,
        custom_len: u32,
        custom_data: *mut i16,
    }

    /// Kernel union inside `struct ff_effect`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    union FfEffectUnion {
        rumble: FfRumbleEffect,
        periodic: FfPeriodicEffect,
        condition: [FfConditionEffect; 2],
    }

    /// Kernel `struct ff_effect`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FfEffect {
        kind: u16,
        id: i16,
        direction: u16,
        trigger: FfTrigger,
        replay: FfReplay,
        u: FfEffectUnion,
    }

    /// Kernel `struct uinput_ff_upload`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UinputFfUpload {
        request_id: u32,
        retval: i32,
        effect: FfEffect,
        old: FfEffect,
    }

    /// Kernel `struct uinput_ff_erase`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UinputFfErase {
        request_id: u32,
        retval: i32,
        effect_id: u32,
    }

    /// Stored rumble parameters for an uploaded force-feedback effect ID.
    #[derive(Clone, Copy)]
    struct StoredRumble {
        strong_magnitude: u16,
        weak_magnitude: u16,
        duration_ms: u32,
    }

    nix::ioctl_write_int!(ui_set_evbit, b'U', 100);
    nix::ioctl_write_int!(ui_set_keybit, b'U', 101);
    nix::ioctl_write_int!(ui_set_absbit, b'U', 103);
    nix::ioctl_write_int!(ui_set_ffbit, b'U', 107);
    nix::ioctl_none!(ui_dev_create, b'U', 1);
    nix::ioctl_read_buf!(ui_get_sysname, b'U', 44, u8);
    nix::ioctl_readwrite!(ui_begin_ff_upload, b'U', 200, UinputFfUpload);
    nix::ioctl_write_ptr!(ui_end_ff_upload, b'U', 201, UinputFfUpload);
    nix::ioctl_readwrite!(ui_begin_ff_erase, b'U', 202, UinputFfErase);
    nix::ioctl_write_ptr!(ui_end_ff_erase, b'U', 203, UinputFfErase);

    /// Linux `uinput`-backed virtual gamepad with force-feedback (`FF_RUMBLE`) support.
    pub struct LinuxVirtualGamepad {
        stop_flag: Arc<AtomicBool>,
        ff_thread: Option<JoinHandle<()>>,
        device: Option<uinput::Device>,
        _uinput_file: Option<File>,
        identifier: String,
        rumble_callback: Arc<Mutex<Option<RumbleCallback>>>,
        player_led: u8,
        dpad_up: bool,
        dpad_down: bool,
        dpad_left: bool,
        dpad_right: bool,
        analog_left_trigger: u8,
        analog_right_trigger: u8,
        digital_left_trigger: bool,
        digital_right_trigger: bool,
    }

    impl LinuxVirtualGamepad {
        /// Map a standard [`VirtualButton`] to a `uinput` [`GamePad`] button.
        fn map_gamepad_button(button: VirtualButton) -> Option<GamePad> {
            match button {
                VirtualButton::A => Some(GamePad::A),
                VirtualButton::B => Some(GamePad::B),
                VirtualButton::X => Some(GamePad::X),
                VirtualButton::Y => Some(GamePad::Y),
                VirtualButton::LeftShoulder => Some(GamePad::TL),
                VirtualButton::RightShoulder => Some(GamePad::TR),
                VirtualButton::LeftStick => Some(GamePad::ThumbL),
                VirtualButton::RightStick => Some(GamePad::ThumbR),
                VirtualButton::Start => Some(GamePad::Start),
                VirtualButton::Back => Some(GamePad::Select),
                VirtualButton::Guide => Some(GamePad::Mode),
                VirtualButton::DPadUp
                | VirtualButton::DPadDown
                | VirtualButton::DPadLeft
                | VirtualButton::DPadRight
                | VirtualButton::LeftTrigger
                | VirtualButton::RightTrigger => None,
            }
        }

        /// Map a D-pad [`VirtualButton`] to a `uinput` [`DPad`] button.
        fn map_dpad_button(button: VirtualButton) -> Option<DPad> {
            match button {
                VirtualButton::DPadUp => Some(DPad::Up),
                VirtualButton::DPadDown => Some(DPad::Down),
                VirtualButton::DPadLeft => Some(DPad::Left),
                VirtualButton::DPadRight => Some(DPad::Right),
                _ => None,
            }
        }

        /// Obtain a mutable reference to the underlying `uinput::Device` or return an error.
        fn active_device(&mut self) -> Result<&mut uinput::Device, VirtualDeviceError> {
            self.device.as_mut().ok_or_else(|| {
                VirtualDeviceError::IoError("Virtual uinput device has been destroyed".to_string())
            })
        }

        /// Synchronize D-pad hat axes (`ABS_HAT0X`, `ABS_HAT0Y`) from current D-pad state.
        fn sync_dpad_hat(&mut self) -> Result<(), VirtualDeviceError> {
            let hat_x = match (self.dpad_left, self.dpad_right) {
                (true, false) => -1,
                (false, true) => 1,
                _ => 0,
            };
            let hat_y = match (self.dpad_up, self.dpad_down) {
                (true, false) => -1,
                (false, true) => 1,
                _ => 0,
            };

            let device = self.active_device()?;
            device
                .position(&Hat::X0, hat_x)
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            device
                .position(&Hat::Y0, hat_y)
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            Ok(())
        }

        /// Configure axis bounds on `UinputUserDev` and register the `ABS_*` bit.
        fn configure_axis(
            fd: c_int,
            dev: &mut UinputUserDev,
            axis_code: c_int,
            min: i32,
            max: i32,
            fuzz: i32,
            flat: i32,
        ) -> Result<(), VirtualDeviceError> {
            unsafe {
                ui_set_absbit(fd, axis_code as ioctl_param_type).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!("UI_SET_ABSBIT failed: {err}"))
                })?;
            }
            let index = axis_code as usize;
            if index < ABS_CNT {
                dev.absmin[index] = min;
                dev.absmax[index] = max;
                dev.absfuzz[index] = fuzz;
                dev.absflat[index] = flat;
            }
            Ok(())
        }

        /// Resolve the `/dev/input/event*` path for a created `uinput` device via `UI_GET_SYSNAME`.
        fn resolve_device_path(fd: c_int) -> String {
            let mut buffer = [0u8; 64];
            let sysname_result = unsafe { ui_get_sysname(fd, &mut buffer) };
            let Ok(_) = sysname_result else {
                return "/dev/uinput".to_string();
            };

            let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
            let sysname = String::from_utf8_lossy(&buffer[..end]).trim().to_string();
            if sysname.is_empty() {
                return "/dev/uinput".to_string();
            }

            let sys_dir = format!("/sys/devices/virtual/input/{sysname}");
            if let Ok(entries) = fs::read_dir(&sys_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("event") {
                        return format!("/dev/input/{name_str}");
                    }
                }
            }

            sys_dir
        }

        /// Spawn the background thread that processes `EV_UINPUT` FF upload/erase and `EV_FF` playback.
        fn spawn_ff_thread(
            mut reader_file: File,
            stop_flag: Arc<AtomicBool>,
            rumble_callback: Arc<Mutex<Option<RumbleCallback>>>,
        ) -> JoinHandle<()> {
            thread::spawn(move || {
                let mut effects: HashMap<i16, StoredRumble> = HashMap::new();
                let event_size = mem::size_of::<InputEvent>();
                let mut buffer = vec![0u8; event_size];

                while !stop_flag.load(Ordering::Relaxed) {
                    match reader_file.read_exact(&mut buffer) {
                        Ok(()) => {
                            let event: InputEvent = unsafe {
                                ptr_read_unaligned(buffer.as_ptr() as *const InputEvent)
                            };
                            Self::handle_kernel_event(
                                reader_file.as_raw_fd(),
                                &event,
                                &mut effects,
                                &rumble_callback,
                            );
                        }
                        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            })
        }

        /// Handle a single kernel `InputEvent` read from `/dev/uinput`.
        fn handle_kernel_event(
            fd: c_int,
            event: &InputEvent,
            effects: &mut HashMap<i16, StoredRumble>,
            rumble_callback: &Arc<Mutex<Option<RumbleCallback>>>,
        ) {
            match (event.kind, event.code) {
                (EV_UINPUT, UI_FF_UPLOAD) => {
                    let mut upload: UinputFfUpload = unsafe { mem::zeroed() };
                    upload.request_id = event.value as u32;
                    unsafe {
                        if ui_begin_ff_upload(fd, &mut upload).is_ok() {
                            if upload.effect.kind == FF_RUMBLE_CODE {
                                let rumble = unsafe { upload.effect.u.rumble };
                                effects.insert(
                                    upload.effect.id,
                                    StoredRumble {
                                        strong_magnitude: rumble.strong_magnitude,
                                        weak_magnitude: rumble.weak_magnitude,
                                        duration_ms: upload.effect.replay.length as u32,
                                    },
                                );
                            }
                            upload.retval = 0;
                            let _ = ui_end_ff_upload(fd, &upload);
                        }
                    }
                }
                (EV_UINPUT, UI_FF_ERASE) => {
                    let mut erase: UinputFfErase = unsafe { mem::zeroed() };
                    erase.request_id = event.value as u32;
                    unsafe {
                        if ui_begin_ff_erase(fd, &mut erase).is_ok() {
                            effects.remove(&(erase.effect_id as i16));
                            erase.retval = 0;
                            let _ = ui_end_ff_erase(fd, &erase);
                        }
                    }
                }
                (EV_FF, effect_id) => {
                    let id = effect_id as i16;
                    if event.value > 0 {
                        if let Some(rumble) = effects.get(&id) {
                            Self::invoke_rumble_callback(
                                rumble_callback,
                                rumble.strong_magnitude,
                                rumble.weak_magnitude,
                                rumble.duration_ms,
                            );
                        }
                    } else {
                        Self::invoke_rumble_callback(rumble_callback, 0, 0, 0);
                    }
                }
                _ => {}
            }
        }

        /// Invoke the registered rumble callback if present.
        fn invoke_rumble_callback(
            rumble_callback: &Arc<Mutex<Option<RumbleCallback>>>,
            low: u16,
            high: u16,
            duration_ms: u32,
        ) {
            if let Ok(guard) = rumble_callback.lock() {
                if let Some(ref callback) = *guard {
                    callback(low, high, duration_ms);
                }
            }
        }
    }

    /// Read a `Copy` struct from an aligned or unaligned raw pointer.
    unsafe fn ptr_read_unaligned<T: Copy>(ptr: *const T) -> T {
        std::ptr::read_unaligned(ptr)
    }

    impl VirtualGamepad for LinuxVirtualGamepad {
        fn create(slot_index: usize) -> Result<Self, VirtualDeviceError> {
            validate_slot_index(slot_index)?;

            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(OFlag::O_NONBLOCK.bits())
                .open("/dev/uinput")
                .map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!(
                        "Failed to open /dev/uinput: {err}"
                    ))
                })?;

            let fd = file.as_raw_fd();

            unsafe {
                ui_set_evbit(fd, EV_KEY).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!("UI_SET_EVBIT(EV_KEY) failed: {err}"))
                })?;
                ui_set_evbit(fd, EV_ABS).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!("UI_SET_EVBIT(EV_ABS) failed: {err}"))
                })?;
                ui_set_evbit(fd, EV_FF_BIT).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!("UI_SET_EVBIT(EV_FF) failed: {err}"))
                })?;
                ui_set_ffbit(fd, FF_RUMBLE_BIT).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!(
                        "UI_SET_FFBIT(FF_RUMBLE) failed: {err}"
                    ))
                })?;
            }

            let gamepad_buttons = [
                GamePad::A,
                GamePad::B,
                GamePad::X,
                GamePad::Y,
                GamePad::TL,
                GamePad::TR,
                GamePad::Select,
                GamePad::Start,
                GamePad::Mode,
                GamePad::ThumbL,
                GamePad::ThumbR,
            ];
            for button in gamepad_buttons {
                unsafe {
                    ui_set_keybit(fd, button.code() as ioctl_param_type).map_err(|err| {
                        VirtualDeviceError::CreationFailed(format!("UI_SET_KEYBIT failed: {err}"))
                    })?;
                }
            }

            let dpad_buttons = [DPad::Up, DPad::Down, DPad::Left, DPad::Right];
            for button in dpad_buttons {
                unsafe {
                    ui_set_keybit(fd, button.code() as ioctl_param_type).map_err(|err| {
                        VirtualDeviceError::CreationFailed(format!("UI_SET_KEYBIT failed: {err}"))
                    })?;
                }
            }

            let mut dev: UinputUserDev = unsafe { mem::zeroed() };
            let device_name = format!("Virtual Pad {}", slot_index + 1);
            let name_bytes = device_name.as_bytes();
            let copy_len = name_bytes.len().min(UINPUT_MAX_NAME_SIZE - 1);
            dev.name[..copy_len].copy_from_slice(&name_bytes[..copy_len]);
            dev.id = InputId {
                bustype: BUS_USB,
                vendor: VIRTUAL_VENDOR_ID,
                product: VIRTUAL_PRODUCT_ID,
                version: VIRTUAL_VERSION,
            };
            dev.ff_effects_max = MAX_FF_EFFECTS;

            Self::configure_axis(fd, &mut dev, Position::X.code(), -32768, 32767, 16, 128)?;
            Self::configure_axis(fd, &mut dev, Position::Y.code(), -32768, 32767, 16, 128)?;
            Self::configure_axis(fd, &mut dev, Position::RX.code(), -32768, 32767, 16, 128)?;
            Self::configure_axis(fd, &mut dev, Position::RY.code(), -32768, 32767, 16, 128)?;
            Self::configure_axis(fd, &mut dev, Position::Z.code(), 0, 255, 0, 0)?;
            Self::configure_axis(fd, &mut dev, Position::RZ.code(), 0, 255, 0, 0)?;
            Self::configure_axis(fd, &mut dev, Hat::X0.code(), -1, 1, 0, 0)?;
            Self::configure_axis(fd, &mut dev, Hat::Y0.code(), -1, 1, 0, 0)?;

            let dev_bytes = unsafe {
                slice::from_raw_parts(&dev as *const _ as *const u8, mem::size_of::<UinputUserDev>())
            };
            file.write_all(dev_bytes).map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Failed to write uinput_user_dev: {err}"
                ))
            })?;

            unsafe {
                ui_dev_create(fd).map_err(|err| {
                    VirtualDeviceError::CreationFailed(format!("UI_DEV_CREATE failed: {err}"))
                })?;
            }

            let identifier = Self::resolve_device_path(fd);
            let reader_file = file.try_clone().map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Failed to clone uinput file handle for FF thread: {err}"
                ))
            })?;

            let stop_flag = Arc::new(AtomicBool::new(false));
            let rumble_callback: Arc<Mutex<Option<RumbleCallback>>> = Arc::new(Mutex::new(None));
            let ff_thread = Self::spawn_ff_thread(
                reader_file,
                Arc::clone(&stop_flag),
                Arc::clone(&rumble_callback),
            );

            Ok(Self {
                stop_flag,
                ff_thread: Some(ff_thread),
                device: Some(uinput::Device::new(fd)),
                _uinput_file: Some(file),
                identifier,
                rumble_callback,
                player_led: (slot_index + 1) as u8,
                dpad_up: false,
                dpad_down: false,
                dpad_left: false,
                dpad_right: false,
                analog_left_trigger: 0,
                analog_right_trigger: 0,
                digital_left_trigger: false,
                digital_right_trigger: false,
            })
        }

        fn set_button(
            &mut self,
            button: VirtualButton,
            pressed: bool,
        ) -> Result<(), VirtualDeviceError> {
            match button {
                VirtualButton::LeftTrigger => {
                    self.digital_left_trigger = pressed;
                    let value = effective_trigger_value(
                        self.analog_left_trigger,
                        self.digital_left_trigger,
                    );
                    let device = self.active_device()?;
                    device
                        .position(&Position::Z, value as i32)
                        .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                    device
                        .synchronize()
                        .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                    return Ok(());
                }
                VirtualButton::RightTrigger => {
                    self.digital_right_trigger = pressed;
                    let value = effective_trigger_value(
                        self.analog_right_trigger,
                        self.digital_right_trigger,
                    );
                    let device = self.active_device()?;
                    device
                        .position(&Position::RZ, value as i32)
                        .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                    device
                        .synchronize()
                        .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                    return Ok(());
                }
                VirtualButton::DPadUp => self.dpad_up = pressed,
                VirtualButton::DPadDown => self.dpad_down = pressed,
                VirtualButton::DPadLeft => self.dpad_left = pressed,
                VirtualButton::DPadRight => self.dpad_right = pressed,
                _ => {}
            }

            if let Some(dpad_button) = Self::map_dpad_button(button) {
                {
                    let device = self.active_device()?;
                    if pressed {
                        device.press(&dpad_button)
                    } else {
                        device.release(&dpad_button)
                    }
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                }
                self.sync_dpad_hat()?;
                self.active_device()?
                    .synchronize()
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                return Ok(());
            }

            if let Some(gamepad_button) = Self::map_gamepad_button(button) {
                let device = self.active_device()?;
                if pressed {
                    device.press(&gamepad_button)
                } else {
                    device.release(&gamepad_button)
                }
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
                device
                    .synchronize()
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            }

            Ok(())
        }

        fn set_axis(&mut self, axis: VirtualAxis, value: i32) -> Result<(), VirtualDeviceError> {
            let (position, clamped) = match axis {
                VirtualAxis::LeftStickX => (Position::X, clamp_stick_axis(value) as i32),
                VirtualAxis::LeftStickY => (Position::Y, clamp_stick_axis(value) as i32),
                VirtualAxis::RightStickX => (Position::RX, clamp_stick_axis(value) as i32),
                VirtualAxis::RightStickY => (Position::RY, clamp_stick_axis(value) as i32),
                VirtualAxis::LeftTrigger => {
                    self.analog_left_trigger = clamp_trigger_axis(value);
                    let effective = effective_trigger_value(
                        self.analog_left_trigger,
                        self.digital_left_trigger,
                    );
                    (Position::Z, effective as i32)
                }
                VirtualAxis::RightTrigger => {
                    self.analog_right_trigger = clamp_trigger_axis(value);
                    let effective = effective_trigger_value(
                        self.analog_right_trigger,
                        self.digital_right_trigger,
                    );
                    (Position::RZ, effective as i32)
                }
            };

            let device = self.active_device()?;
            device
                .position(&position, clamped)
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            device
                .synchronize()
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            Ok(())
        }

        fn reset(&mut self) -> Result<(), VirtualDeviceError> {
            self.dpad_up = false;
            self.dpad_down = false;
            self.dpad_left = false;
            self.dpad_right = false;
            self.analog_left_trigger = 0;
            self.analog_right_trigger = 0;
            self.digital_left_trigger = false;
            self.digital_right_trigger = false;

            let gamepad_buttons = [
                GamePad::A,
                GamePad::B,
                GamePad::X,
                GamePad::Y,
                GamePad::TL,
                GamePad::TR,
                GamePad::Select,
                GamePad::Start,
                GamePad::Mode,
                GamePad::ThumbL,
                GamePad::ThumbR,
            ];
            let dpad_buttons = [DPad::Up, DPad::Down, DPad::Left, DPad::Right];
            let axes = [
                Position::X,
                Position::Y,
                Position::RX,
                Position::RY,
                Position::Z,
                Position::RZ,
            ];

            let device = self.active_device()?;
            for button in gamepad_buttons {
                device
                    .release(&button)
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            }
            for button in dpad_buttons {
                device
                    .release(&button)
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            }
            for axis in axes {
                device
                    .position(&axis, 0)
                    .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            }
            device
                .position(&Hat::X0, 0)
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            device
                .position(&Hat::Y0, 0)
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;
            device
                .synchronize()
                .map_err(|err| VirtualDeviceError::IoError(err.to_string()))?;

            Ok(())
        }

        fn set_player_led(&mut self, player: u8) -> Result<(), VirtualDeviceError> {
            validate_player_number(player)?;
            self.player_led = player;
            Ok(())
        }

        fn set_rumble_callback(&mut self, callback: Box<dyn Fn(u16, u16, u32) + Send>) {
            if let Ok(mut guard) = self.rumble_callback.lock() {
                *guard = Some(callback);
            }
        }

        fn device_identifier(&self) -> &str {
            &self.identifier
        }

        fn destroy(&mut self) -> Result<(), VirtualDeviceError> {
            self.stop_flag.store(true, Ordering::SeqCst);
            if let Some(handle) = self.ff_thread.take() {
                let _ = handle.join();
            }
            if let Ok(mut guard) = self.rumble_callback.lock() {
                *guard = None;
            }
            // Drop `uinput::Device` before `_uinput_file` so `UI_DEV_DESTROY` runs while fd is open.
            drop(self.device.take());
            drop(self._uinput_file.take());
            Ok(())
        }
    }

    impl Drop for LinuxVirtualGamepad {
        fn drop(&mut self) {
            let _ = self.destroy();
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux_impl::LinuxVirtualGamepad;

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        clamp_stick_axis, clamp_trigger_axis, effective_trigger_value, validate_player_number,
        validate_slot_index, RumbleCallback, VirtualAxis, VirtualButton, VirtualDeviceError,
        VirtualGamepad,
    };
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    /// Default duration in milliseconds passed to rumble callbacks for non-zero XInput rumble.
    const XINPUT_RUMBLE_DURATION_MS: u32 = 5000;

    /// Windows ViGEmBus-backed virtual Xbox 360 gamepad.
    pub struct WindowsVirtualGamepad {
        target: Option<Xbox360Wired<Client>>,
        report: XGamepad,
        analog_left_trigger: u8,
        analog_right_trigger: u8,
        digital_left_trigger: bool,
        digital_right_trigger: bool,
        player_led: u8,
        identifier: String,
        rumble_callback: Arc<Mutex<Option<RumbleCallback>>>,
        notification_thread: Option<JoinHandle<()>>,
    }

    impl WindowsVirtualGamepad {
        /// Map a [`VirtualButton`] to its `XButtons` bitmask flag, if it is a digital button.
        pub(crate) fn button_flag(button: VirtualButton) -> Option<u16> {
            match button {
                VirtualButton::A => Some(XButtons::A),
                VirtualButton::B => Some(XButtons::B),
                VirtualButton::X => Some(XButtons::X),
                VirtualButton::Y => Some(XButtons::Y),
                VirtualButton::DPadUp => Some(XButtons::UP),
                VirtualButton::DPadDown => Some(XButtons::DOWN),
                VirtualButton::DPadLeft => Some(XButtons::LEFT),
                VirtualButton::DPadRight => Some(XButtons::RIGHT),
                VirtualButton::LeftShoulder => Some(XButtons::LB),
                VirtualButton::RightShoulder => Some(XButtons::RB),
                VirtualButton::LeftStick => Some(XButtons::LTHUMB),
                VirtualButton::RightStick => Some(XButtons::RTHUMB),
                VirtualButton::Start => Some(XButtons::START),
                VirtualButton::Back => Some(XButtons::BACK),
                VirtualButton::Guide => Some(XButtons::GUIDE),
                VirtualButton::LeftTrigger | VirtualButton::RightTrigger => None,
            }
        }

        /// Update internal report state for a button change without submitting to the driver.
        pub(crate) fn apply_button_state(&mut self, button: VirtualButton, pressed: bool) {
            match button {
                VirtualButton::LeftTrigger => {
                    self.digital_left_trigger = pressed;
                    self.report.left_trigger = effective_trigger_value(
                        self.analog_left_trigger,
                        self.digital_left_trigger,
                    );
                }
                VirtualButton::RightTrigger => {
                    self.digital_right_trigger = pressed;
                    self.report.right_trigger = effective_trigger_value(
                        self.analog_right_trigger,
                        self.digital_right_trigger,
                    );
                }
                _ => {
                    if let Some(flag) = Self::button_flag(button) {
                        if pressed {
                            self.report.buttons.raw |= flag;
                        } else {
                            self.report.buttons.raw &= !flag;
                        }
                    }
                }
            }
        }

        /// Update internal report state for an axis change without submitting to the driver.
        pub(crate) fn apply_axis_state(&mut self, axis: VirtualAxis, value: i32) {
            match axis {
                VirtualAxis::LeftStickX => {
                    self.report.thumb_lx = clamp_stick_axis(value);
                }
                VirtualAxis::LeftStickY => {
                    self.report.thumb_ly = clamp_stick_axis(value);
                }
                VirtualAxis::RightStickX => {
                    self.report.thumb_rx = clamp_stick_axis(value);
                }
                VirtualAxis::RightStickY => {
                    self.report.thumb_ry = clamp_stick_axis(value);
                }
                VirtualAxis::LeftTrigger => {
                    self.analog_left_trigger = clamp_trigger_axis(value);
                    self.report.left_trigger = effective_trigger_value(
                        self.analog_left_trigger,
                        self.digital_left_trigger,
                    );
                }
                VirtualAxis::RightTrigger => {
                    self.analog_right_trigger = clamp_trigger_axis(value);
                    self.report.right_trigger = effective_trigger_value(
                        self.analog_right_trigger,
                        self.digital_right_trigger,
                    );
                }
            }
        }

        /// Submit the current `XGamepad` report to the ViGEmBus target.
        fn submit_report(&mut self) -> Result<(), VirtualDeviceError> {
            let target = self.target.as_mut().ok_or_else(|| {
                VirtualDeviceError::IoError("Virtual ViGEm target has been destroyed".to_string())
            })?;
            target
                .update(&self.report)
                .map_err(|err| VirtualDeviceError::IoError(format!("ViGEm update failed: {err}")))
        }
    }

    impl VirtualGamepad for WindowsVirtualGamepad {
        fn create(slot_index: usize) -> Result<Self, VirtualDeviceError> {
            validate_slot_index(slot_index)?;

            let client = Client::connect().map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Failed to connect to ViGEmBus driver: {err}"
                ))
            })?;

            let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
            target.plugin().map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Failed to plug in virtual Xbox 360 slot {}: {err}",
                    slot_index + 1
                ))
            })?;
            target.wait_ready().map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Virtual Xbox 360 slot {} did not become ready: {err}",
                    slot_index + 1
                ))
            })?;

            let identifier = match target.get_user_index() {
                Ok(user_index) => {
                    format!("vigem://x360/slot-{}/xinput-{}", slot_index + 1, user_index)
                }
                Err(_) => format!("vigem://x360/slot-{}", slot_index + 1),
            };

            let rumble_callback: Arc<Mutex<Option<RumbleCallback>>> = Arc::new(Mutex::new(None));
            let request = target.request_notification().map_err(|err| {
                VirtualDeviceError::CreationFailed(format!(
                    "Failed to register ViGEm rumble notification for slot {}: {err}",
                    slot_index + 1
                ))
            })?;

            let callback_ref = Arc::clone(&rumble_callback);
            let notification_thread = request.spawn_thread(move |_req, notification| {
                // Scale 0..255 XInput motor bytes up to 0..65535 (`val * 257`).
                let low = (notification.large_motor as u16) * 257;
                let high = (notification.small_motor as u16) * 257;
                let duration_ms = if low == 0 && high == 0 {
                    0
                } else {
                    XINPUT_RUMBLE_DURATION_MS
                };

                if let Ok(guard) = callback_ref.lock() {
                    if let Some(ref callback) = *guard {
                        callback(low, high, duration_ms);
                    }
                }
            });

            Ok(Self {
                target: Some(target),
                report: XGamepad::default(),
                analog_left_trigger: 0,
                analog_right_trigger: 0,
                digital_left_trigger: false,
                digital_right_trigger: false,
                player_led: (slot_index + 1) as u8,
                identifier,
                rumble_callback,
                notification_thread: Some(notification_thread),
            })
        }

        fn set_button(
            &mut self,
            button: VirtualButton,
            pressed: bool,
        ) -> Result<(), VirtualDeviceError> {
            self.apply_button_state(button, pressed);
            self.submit_report()
        }

        fn set_axis(&mut self, axis: VirtualAxis, value: i32) -> Result<(), VirtualDeviceError> {
            self.apply_axis_state(axis, value);
            self.submit_report()
        }

        fn reset(&mut self) -> Result<(), VirtualDeviceError> {
            self.analog_left_trigger = 0;
            self.analog_right_trigger = 0;
            self.digital_left_trigger = false;
            self.digital_right_trigger = false;
            self.report = XGamepad::default();
            self.submit_report()
        }

        fn set_player_led(&mut self, player: u8) -> Result<(), VirtualDeviceError> {
            validate_player_number(player)?;
            self.player_led = player;
            Ok(())
        }

        fn set_rumble_callback(&mut self, callback: Box<dyn Fn(u16, u16, u32) + Send>) {
            if let Ok(mut guard) = self.rumble_callback.lock() {
                *guard = Some(callback);
            }
        }

        fn device_identifier(&self) -> &str {
            &self.identifier
        }

        fn destroy(&mut self) -> Result<(), VirtualDeviceError> {
            if let Ok(mut guard) = self.rumble_callback.lock() {
                *guard = None;
            }
            if let Some(mut target) = self.target.take() {
                if target.is_attached() {
                    target.unplug().map_err(|err| {
                        VirtualDeviceError::IoError(format!("ViGEm unplug failed: {err}"))
                    })?;
                }
            }
            if let Some(handle) = self.notification_thread.take() {
                let _ = handle.join();
            }
            Ok(())
        }
    }

    impl Drop for WindowsVirtualGamepad {
        fn drop(&mut self) {
            let _ = self.destroy();
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::WindowsVirtualGamepad;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamp_stick_axis() {
        assert_eq!(clamp_stick_axis(0), 0);
        assert_eq!(clamp_stick_axis(32767), 32767);
        assert_eq!(clamp_stick_axis(-32768), -32768);
        assert_eq!(clamp_stick_axis(100_000), 32767);
        assert_eq!(clamp_stick_axis(-100_000), -32768);
    }

    #[test]
    fn test_clamp_trigger_axis() {
        assert_eq!(clamp_trigger_axis(-50), 0);
        assert_eq!(clamp_trigger_axis(0), 0);
        assert_eq!(clamp_trigger_axis(128), 128);
        assert_eq!(clamp_trigger_axis(255), 255);
        assert_eq!(clamp_trigger_axis(500), 255);
    }

    #[test]
    fn test_effective_trigger_value() {
        assert_eq!(effective_trigger_value(0, false), 0);
        assert_eq!(effective_trigger_value(120, false), 120);
        assert_eq!(effective_trigger_value(0, true), 255);
        assert_eq!(effective_trigger_value(120, true), 255);
    }

    #[test]
    fn test_slot_and_player_validation() {
        assert!(validate_slot_index(0).is_ok());
        assert!(validate_slot_index(3).is_ok());
        assert!(matches!(
            validate_slot_index(4),
            Err(VirtualDeviceError::CreationFailed(_))
        ));

        assert!(validate_player_number(1).is_ok());
        assert!(validate_player_number(4).is_ok());
        assert!(matches!(
            validate_player_number(0),
            Err(VirtualDeviceError::IoError(_))
        ));
        assert!(matches!(
            validate_player_number(5),
            Err(VirtualDeviceError::IoError(_))
        ));
    }

    #[test]
    fn test_error_display() {
        let creation = VirtualDeviceError::CreationFailed("no bus".to_string());
        assert!(creation.to_string().contains("no bus"));

        let io = VirtualDeviceError::IoError("disconnected".to_string());
        assert!(io.to_string().contains("disconnected"));

        let unsupported = VirtualDeviceError::NotSupported("macOS".to_string());
        assert!(unsupported.to_string().contains("macOS"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_button_mapping_covers_all_digital_buttons() {
        use vigem_client::XButtons;

        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::A),
            Some(XButtons::A)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::B),
            Some(XButtons::B)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::X),
            Some(XButtons::X)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::Y),
            Some(XButtons::Y)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::DPadUp),
            Some(XButtons::UP)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::DPadDown),
            Some(XButtons::DOWN)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::DPadLeft),
            Some(XButtons::LEFT)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::DPadRight),
            Some(XButtons::RIGHT)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::LeftShoulder),
            Some(XButtons::LB)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::RightShoulder),
            Some(XButtons::RB)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::LeftStick),
            Some(XButtons::LTHUMB)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::RightStick),
            Some(XButtons::RTHUMB)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::Start),
            Some(XButtons::START)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::Back),
            Some(XButtons::BACK)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::Guide),
            Some(XButtons::GUIDE)
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::LeftTrigger),
            None
        );
        assert_eq!(
            WindowsVirtualGamepad::button_flag(VirtualButton::RightTrigger),
            None
        );
    }
}
