//! Entry point for `virtualpad-daemon`.
//!
//! Initializes SDL2 game controller and sensor subsystems, creates four persistent
//! virtual gamepad slots, launches the dual WebSocket/TCP-ndjson control server and
//! DSU/Cemuhook UDP motion server on a Tokio runtime, and runs the main ~1ms input loop.

mod config;
mod dsu;
mod protocol;
mod router;
mod virtual_device;
mod ws;

use std::collections::HashMap;
use std::error::Error;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::Parser;
use log::{debug, error, info, warn};
use sdl2::controller::GameController;
use sdl2::event::Event;
use sdl2::joystick::PowerLevel;
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};

use crate::config::{BatteryLevel, ConnectionType, DaemonConfig, SLOT_COUNT};
use crate::dsu::DsuState;
use crate::protocol::DaemonEvent;
use crate::router::{ControllerDescriptor, InputRouter, SensorType};
use crate::ws::WsServer;

/// Queued rumble command forwarded from a virtual slot back to a physical controller.
#[derive(Debug, Clone, Copy)]
struct PendingRumble {
    slot_index: usize,
    low_freq: u16,
    high_freq: u16,
    duration_ms: u32,
}

/// Owns the SDL2 context, game controller and sensor subsystems, event pump, and open handles.
///
/// SDL2 types are `!Send` and must remain on the main thread for the lifetime of the daemon.
struct SdlControllerHost {
    _sdl_context: sdl2::Sdl,
    game_controller_subsystem: sdl2::GameControllerSubsystem,
    event_pump: sdl2::EventPump,
    open_controllers: HashMap<u32, GameController>,
    instance_to_id: HashMap<u32, String>,
    id_to_instance: HashMap<String, u32>,
}

impl SdlControllerHost {
    /// Configures SDL2 hints and initializes the GameController and Sensor subsystems.
    fn new() -> Result<Self, String> {
        configure_sdl_hints();

        let sdl_context = sdl2::init()?;
        let game_controller_subsystem = sdl_context.game_controller()?;
        game_controller_subsystem.set_event_state(true);

        unsafe {
            sdl2::sys::SDL_InitSubSystem(sdl2::sys::SDL_INIT_SENSOR);
        }
        let event_pump = sdl_context.event_pump()?;

        info!("Initialized SDL2 GameController and Sensor subsystems");

        Ok(Self {
            _sdl_context: sdl_context,
            game_controller_subsystem,
            event_pump,
            open_controllers: HashMap::new(),
            instance_to_id: HashMap::new(),
            id_to_instance: HashMap::new(),
        })
    }

    /// Enumerates and opens all game controllers already attached when the daemon starts.
    fn open_existing_controllers(
        &mut self,
        router: &mut InputRouter,
        ws_server: &WsServer,
        dsu_state: &DsuState,
    ) -> Result<(), String> {
        let joystick_count = self.game_controller_subsystem.num_joysticks()?;

        for device_index in 0..joystick_count {
            if self.game_controller_subsystem.is_game_controller(device_index) {
                self.handle_device_added(device_index, router, ws_server, dsu_state);
            }
        }

        Ok(())
    }

    /// Opens a newly connected SDL2 game controller (excluding real Wii Remotes) and registers it.
    fn handle_device_added(
        &mut self,
        device_index: u32,
        router: &mut InputRouter,
        ws_server: &WsServer,
        dsu_state: &DsuState,
    ) {
        if !self.game_controller_subsystem.is_game_controller(device_index) {
            debug!("Ignoring non-game-controller joystick at index {}", device_index);
            return;
        }

        let controller = match self.game_controller_subsystem.open(device_index) {
            Ok(controller) => controller,
            Err(error_value) => {
                error!(
                    "Failed to open game controller at device index {}: {}",
                    device_index, error_value
                );
                return;
            }
        };

        let instance_id = controller.instance_id();
        let controller_name = controller.name();
        let (vendor_id, product_id) = Self::controller_ids(instance_id);

        if InputRouter::is_excluded_wiimote(vendor_id, product_id, &controller_name) {
            info!(
                "Leaving real Wii Remote '{}' untouched for Dolphin passthrough",
                controller_name
            );
            return;
        }

        if self.open_controllers.contains_key(&instance_id) {
            debug!(
                "Controller '{}' (instance {}) is already open",
                controller_name, instance_id
            );
            return;
        }

        let (has_accelerometer, has_gyro) =
            Self::enable_controller_sensors(instance_id, &controller_name);
        let battery_level = Self::read_battery_level(instance_id);
        let connection_type = Self::read_connection_type(instance_id);
        let stable_id = Self::build_stable_id(instance_id, vendor_id, product_id, &controller_name);

        let descriptor = ControllerDescriptor {
            id: stable_id.clone(),
            name: controller_name.clone(),
            vendor_id,
            product_id,
            kind: None,
            has_gyro,
            has_accelerometer,
            battery_level,
            connection_type,
        };

        let events = router.handle_controller_added(descriptor);
        self.open_controllers.insert(instance_id, controller);
        self.instance_to_id.insert(instance_id, stable_id.clone());
        self.id_to_instance.insert(stable_id.clone(), instance_id);

        Self::sync_player_indices(router, &self.id_to_instance);
        Self::broadcast_events(ws_server, events);
        Self::sync_dsu_slots(router, dsu_state);

        info!(
            "Connected controller '{}' (id={}, vid={:04x}, pid={:04x}, slot={:?})",
            controller_name,
            stable_id,
            vendor_id,
            product_id,
            router.slot_for_controller(&stable_id)
        );
    }

    /// Removes a disconnected SDL2 game controller while keeping its virtual slot alive.
    fn handle_device_removed(
        &mut self,
        instance_id: u32,
        router: &mut InputRouter,
        ws_server: &WsServer,
        dsu_state: &DsuState,
    ) {
        if let Some(controller) = self.open_controllers.remove(&instance_id) {
            let controller_name = controller.name();
            if let Some(stable_id) = self.instance_to_id.remove(&instance_id) {
                self.id_to_instance.remove(&stable_id);
                let events = router.handle_controller_removed(&stable_id);
                Self::broadcast_events(ws_server, events);
                Self::sync_dsu_slots(router, dsu_state);
                info!(
                    "Disconnected controller '{}' (id={})",
                    controller_name, stable_id
                );
            }
        }
    }

    /// Reads sensor data (accelerometer and gyroscope) for every open sensor-capable controller.
    fn poll_sensors(&self, router: &mut InputRouter, dsu_state: &DsuState) {
        let timestamp_us = current_timestamp_us();

        for (&instance_id, _) in &self.open_controllers {
            let Some(stable_id) = self.instance_to_id.get(&instance_id) else {
                continue;
            };

            unsafe {
                let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                    instance_id as sdl2::sys::SDL_JoystickID,
                );
                if raw_controller.is_null() {
                    continue;
                }

                let mut accel = [0.0f32; 3];
                if sdl2::sys::SDL_GameControllerIsSensorEnabled(
                    raw_controller,
                    sdl2::sys::SDL_SensorType::SDL_SENSOR_ACCEL,
                ) == sdl2::sys::SDL_bool::SDL_TRUE
                    && sdl2::sys::SDL_GameControllerGetSensorData(
                        raw_controller,
                        sdl2::sys::SDL_SensorType::SDL_SENSOR_ACCEL,
                        accel.as_mut_ptr(),
                        3,
                    ) == 0
                {
                    if let Some((slot, motion)) = router.handle_sensor(
                        stable_id,
                        SensorType::Accelerometer,
                        accel,
                        timestamp_us,
                    ) {
                        dsu_state.update_motion(slot, motion);
                    }
                }

                let mut gyro = [0.0f32; 3];
                if sdl2::sys::SDL_GameControllerIsSensorEnabled(
                    raw_controller,
                    sdl2::sys::SDL_SensorType::SDL_SENSOR_GYRO,
                ) == sdl2::sys::SDL_bool::SDL_TRUE
                    && sdl2::sys::SDL_GameControllerGetSensorData(
                        raw_controller,
                        sdl2::sys::SDL_SensorType::SDL_SENSOR_GYRO,
                        gyro.as_mut_ptr(),
                        3,
                    ) == 0
                {
                    if let Some((slot, motion)) =
                        router.handle_sensor(stable_id, SensorType::Gyroscope, gyro, timestamp_us)
                    {
                        dsu_state.update_motion(slot, motion);
                    }
                }
            }
        }
    }

    /// Polls SDL battery status for all open controllers and emits updates on change.
    fn poll_batteries(&self, router: &mut InputRouter, ws_server: &WsServer) {
        for (&instance_id, _) in &self.open_controllers {
            let Some(stable_id) = self.instance_to_id.get(&instance_id) else {
                continue;
            };
            if let Some(level) = Self::read_battery_level(instance_id) {
                if let Some(event) = router.update_battery(stable_id, level) {
                    Self::broadcast_events(ws_server, vec![event]);
                }
            }
        }
    }

    /// Applies queued rumble requests from virtual slots to the assigned physical controllers.
    fn flush_rumble(&mut self, router: &InputRouter, pending_rumbles: &[PendingRumble]) {
        for rumble in pending_rumbles {
            for controller_id in router.ids_in_slot(rumble.slot_index) {
                if let Some(&instance_id) = self.id_to_instance.get(&controller_id) {
                    if let Some(controller) = self.open_controllers.get_mut(&instance_id) {
                        let _ = controller.set_rumble(
                            rumble.low_freq,
                            rumble.high_freq,
                            rumble.duration_ms,
                        );
                    }
                }
            }
        }
    }

    /// Updates SDL player LEDs on every open physical controller to match its virtual slot.
    fn sync_player_indices(router: &InputRouter, id_to_instance: &HashMap<String, u32>) {
        for (stable_id, &instance_id) in id_to_instance {
            let player_index = router
                .slot_for_controller(stable_id)
                .map(|slot| slot as i32)
                .unwrap_or(-1);
            unsafe {
                let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                    instance_id as sdl2::sys::SDL_JoystickID,
                );
                if !raw_controller.is_null() {
                    sdl2::sys::SDL_GameControllerSetPlayerIndex(raw_controller, player_index);
                }
            }
        }
    }

    /// Syncs DSU slot metadata for all 4 virtual slots.
    fn sync_dsu_slots(router: &InputRouter, dsu_state: &DsuState) {
        for slot_index in 0..SLOT_COUNT {
            dsu_state.update_slot_info(slot_index as u8, router.dsu_slot_info(slot_index));
        }
    }

    /// Broadcasts a batch of daemon events over IPC (ignoring no-receiver conditions).
    fn broadcast_events(ws_server: &WsServer, events: Vec<DaemonEvent>) {
        for event in events {
            if let Err(error) = ws_server.broadcast(event) {
                if !error.is_no_receivers() {
                    warn!("IPC broadcast error: {}", error);
                }
            }
        }
    }

    /// Builds a controller ID that remains stable across reconnects when SDL serial/GUID is available.
    fn build_stable_id(instance_id: u32, vendor_id: u16, product_id: u16, name: &str) -> String {
        unsafe {
            let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                instance_id as sdl2::sys::SDL_JoystickID,
            );
            if !raw_controller.is_null() {
                let serial_ptr = sdl2::sys::SDL_GameControllerGetSerial(raw_controller);
                if !serial_ptr.is_null() {
                    if let Ok(serial) = std::ffi::CStr::from_ptr(serial_ptr).to_str() {
                        let trimmed = serial.trim();
                        if !trimmed.is_empty() {
                            return format!("{vendor_id:04x}:{product_id:04x}:{trimmed}");
                        }
                    }
                }
            }
        }
        format!("sdl:{vendor_id:04x}:{product_id:04x}:{name}:{instance_id}")
    }

    /// Queries USB/Bluetooth vendor and product IDs for an SDL controller instance.
    fn controller_ids(instance_id: u32) -> (u16, u16) {
        unsafe {
            let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                instance_id as sdl2::sys::SDL_JoystickID,
            );
            if raw_controller.is_null() {
                return (0, 0);
            }
            let vendor = sdl2::sys::SDL_GameControllerGetVendor(raw_controller);
            let product = sdl2::sys::SDL_GameControllerGetProduct(raw_controller);
            (vendor, product)
        }
    }

    /// Enables accelerometer and gyroscope sensors when present and returns `(has_accel, has_gyro)`.
    fn enable_controller_sensors(instance_id: u32, controller_name: &str) -> (bool, bool) {
        unsafe {
            let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                instance_id as sdl2::sys::SDL_JoystickID,
            );
            if raw_controller.is_null() {
                return (false, false);
            }

            let accel = Self::try_enable_sensor(
                raw_controller,
                sdl2::sys::SDL_SensorType::SDL_SENSOR_ACCEL,
                "accelerometer",
                controller_name,
            );
            let gyro = Self::try_enable_sensor(
                raw_controller,
                sdl2::sys::SDL_SensorType::SDL_SENSOR_GYRO,
                "gyroscope",
                controller_name,
            );
            (accel, gyro)
        }
    }

    unsafe fn try_enable_sensor(
        raw_controller: *mut sdl2::sys::SDL_GameController,
        sensor_type: sdl2::sys::SDL_SensorType,
        sensor_label: &str,
        controller_name: &str,
    ) -> bool {
        if sdl2::sys::SDL_GameControllerHasSensor(raw_controller, sensor_type)
            != sdl2::sys::SDL_bool::SDL_TRUE
        {
            return false;
        }
        let result = sdl2::sys::SDL_GameControllerSetSensorEnabled(
            raw_controller,
            sensor_type,
            sdl2::sys::SDL_bool::SDL_TRUE,
        );
        if result == 0 {
            debug!("Enabled {} on '{}'", sensor_label, controller_name);
            true
        }
        else {
            warn!("Failed to enable {} on '{}'", sensor_label, controller_name);
            false
        }
    }

    /// Reads current battery level from the underlying SDL joystick.
    fn read_battery_level(instance_id: u32) -> Option<BatteryLevel> {
        unsafe {
            let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                instance_id as sdl2::sys::SDL_JoystickID,
            );
            if raw_controller.is_null() {
                return None;
            }
            let raw_joystick = sdl2::sys::SDL_GameControllerGetJoystick(raw_controller);
            if raw_joystick.is_null() {
                return None;
            }
            let power = sdl2::sys::SDL_JoystickCurrentPowerLevel(raw_joystick);
            let level = match power {
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_EMPTY => BatteryLevel::Empty,
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_LOW => BatteryLevel::Low,
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_MEDIUM => {
                    BatteryLevel::Medium
                }
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_FULL => BatteryLevel::Full,
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_WIRED => BatteryLevel::Wired,
                _ => return None,
            };
            let _ = PowerLevel::Unknown;
            Some(level)
        }
    }

    /// Reads transport connection type from SDL controller metadata.
    fn read_connection_type(instance_id: u32) -> ConnectionType {
        unsafe {
            let raw_controller = sdl2::sys::SDL_GameControllerFromInstanceID(
                instance_id as sdl2::sys::SDL_JoystickID,
            );
            if raw_controller.is_null() {
                return ConnectionType::Unknown;
            }
            let raw_joystick = sdl2::sys::SDL_GameControllerGetJoystick(raw_controller);
            if raw_joystick.is_null() {
                return ConnectionType::Unknown;
            }
            let power = sdl2::sys::SDL_JoystickCurrentPowerLevel(raw_joystick);
            if power == sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_WIRED {
                ConnectionType::Usb
            }
            else if matches!(
                power,
                sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_EMPTY
                    | sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_LOW
                    | sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_MEDIUM
                    | sdl2::sys::SDL_JoystickPowerLevel::SDL_JOYSTICK_POWER_FULL
            ) {
                ConnectionType::Bluetooth
            }
            else {
                ConnectionType::Unknown
            }
        }
    }
}

/// Returns current UNIX epoch timestamp in microseconds for DSU motion packets.
fn current_timestamp_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros() as u64)
        .unwrap_or(0)
}

/// Configures SDL2 hints required for background polling and HIDAPI controller/sensor support.
fn configure_sdl_hints() {
    let hints = [
        ("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", "1"),
        ("SDL_JOYSTICK_HIDAPI_SWITCH", "1"),
        ("SDL_JOYSTICK_HIDAPI_JOY_CONS", "1"),
        ("SDL_JOYSTICK_HIDAPI_PS4_RUMBLE", "1"),
        ("SDL_JOYSTICK_HIDAPI_PS5_RUMBLE", "1"),
    ];

    for (hint_name, hint_value) in hints {
        if !sdl2::hint::set(hint_name, hint_value) {
            warn!("Failed to apply SDL2 hint {}={}", hint_name, hint_value);
        }
    }
}

/// Initializes logging with `env_logger`, defaulting to `info` when `RUST_LOG` is unset.
fn initialize_logging() {
    let environment = env_logger::Env::default().default_filter_or("info");
    env_logger::Builder::from_env(environment).init();
}

/// Builds the multi-threaded Tokio runtime used by the IPC, DSU, and signal tasks.
fn build_tokio_runtime() -> Result<Runtime, Box<dyn Error>> {
    let runtime = RuntimeBuilder::new_multi_thread()
        .thread_name("virtualpad-tokio")
        .enable_all()
        .build()?;
    Ok(runtime)
}

/// Spawns a Ctrl+C handler on the Tokio runtime to signal graceful loop termination.
fn spawn_shutdown_listener(runtime: &Runtime, shutdown_requested: Arc<AtomicBool>) {
    runtime.spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                info!("Shutdown signal received; stopping virtualpad-daemon");
                shutdown_requested.store(true, Ordering::SeqCst);
            }
            Err(error_value) => {
                error!("Failed to listen for Ctrl+C shutdown signal: {}", error_value);
            }
        }
    });
}

/// Polls all pending SDL2 events for the current tick and routes them through `InputRouter`.
fn poll_sdl_events(
    sdl_host: &mut SdlControllerHost,
    input_router: &mut InputRouter,
    ws_server: &WsServer,
    dsu_state: &DsuState,
) -> bool {
    let pending_events: Vec<Event> = sdl_host.event_pump.poll_iter().collect();

    for event in pending_events {
        match event {
            Event::Quit { .. } => {
                info!("SDL2 quit event received");
                return true;
            }
            Event::ControllerDeviceAdded { which, .. } => {
                sdl_host.handle_device_added(which, input_router, ws_server, dsu_state);
            }
            Event::ControllerDeviceRemoved { which, .. } => {
                sdl_host.handle_device_removed(which, input_router, ws_server, dsu_state);
            }
            Event::ControllerButtonDown { which, button, .. } => {
                if let Some(stable_id) = sdl_host.instance_to_id.get(&which).cloned() {
                    input_router.handle_button(&stable_id, button, true);
                }
            }
            Event::ControllerButtonUp { which, button, .. } => {
                if let Some(stable_id) = sdl_host.instance_to_id.get(&which).cloned() {
                    input_router.handle_button(&stable_id, button, false);
                }
            }
            Event::ControllerAxisMotion {
                which,
                axis,
                value,
                ..
            } => {
                if let Some(stable_id) = sdl_host.instance_to_id.get(&which).cloned() {
                    input_router.handle_axis(&stable_id, axis, value);
                }
            }
            _ => {}
        }
    }

    false
}

/// Drains pending IPC commands without blocking the SDL2 loop and applies them.
fn process_ipc_commands(
    ws_server: &mut WsServer,
    input_router: &mut InputRouter,
    sdl_host: &SdlControllerHost,
    dsu_state: &DsuState,
) {
    while let Some(command) = ws_server.try_recv_command() {
        match input_router.handle_command(command) {
            Ok(events) => {
                SdlControllerHost::sync_player_indices(input_router, &sdl_host.id_to_instance);
                SdlControllerHost::broadcast_events(ws_server, events);
                SdlControllerHost::sync_dsu_slots(input_router, dsu_state);
            }
            Err(error_value) => {
                warn!("Rejected IPC command: {}", error_value);
            }
        }
    }
}

/// Runs the ~1ms SDL2 polling, input routing, IPC command, and state broadcast loop.
fn run_event_loop(
    sdl_host: &mut SdlControllerHost,
    input_router: &mut InputRouter,
    ws_server: &mut WsServer,
    dsu_state: &Arc<DsuState>,
    rumble_queue: &Arc<Mutex<Vec<PendingRumble>>>,
    shutdown_requested: &Arc<AtomicBool>,
    poll_interval: Duration,
) {
    info!(
        "Starting main event loop ({}ms SDL poll interval)",
        poll_interval.as_millis()
    );

    let mut last_battery_check = Instant::now();

    while !shutdown_requested.load(Ordering::SeqCst) {
        let tick_start = Instant::now();

        if poll_sdl_events(sdl_host, input_router, ws_server, dsu_state) {
            shutdown_requested.store(true, Ordering::SeqCst);
            break;
        }

        sdl_host.poll_sensors(input_router, dsu_state);
        process_ipc_commands(ws_server, input_router, sdl_host, dsu_state);

        if let Ok(mut queue) = rumble_queue.lock() {
            if !queue.is_empty() {
                let drained: Vec<PendingRumble> = queue.drain(..).collect();
                drop(queue);
                sdl_host.flush_rumble(input_router, &drained);
            }
        }

        if last_battery_check.elapsed() >= Duration::from_secs(5) {
            sdl_host.poll_batteries(input_router, ws_server);
            last_battery_check = Instant::now();
        }

        if input_router.take_dirty_flag() {
            let snapshot = input_router.build_state_update();
            SdlControllerHost::broadcast_events(ws_server, vec![snapshot]);
        }

        let elapsed = tick_start.elapsed();
        if elapsed < poll_interval {
            std::thread::sleep(poll_interval - elapsed);
        }
    }
}

/// Starts `virtualpad-daemon`, initializes subsystems and servers, and runs until shutdown.
fn run() -> Result<(), Box<dyn Error>> {
    let daemon_config = DaemonConfig::parse();
    daemon_config.validate()?;

    let tokio_runtime = build_tokio_runtime()?;
    let shutdown_requested = Arc::new(AtomicBool::new(false));
    spawn_shutdown_listener(&tokio_runtime, Arc::clone(&shutdown_requested));

    let mut sdl_host = SdlControllerHost::new()?;
    let virtual_slots = virtual_device::create_virtual_slots()?;
    info!("Created {} persistent virtual gamepad slots", SLOT_COUNT);

    let mut input_router = InputRouter::new(virtual_slots);
    let mut ws_server = WsServer::new();
    let dsu_state = Arc::new(DsuState::new(SLOT_COUNT));

    // Forward intercepted Home/Guide presses to Node.js via IPC.
    let home_broadcaster = ws_server.event_broadcaster();
    input_router.on_home_button(move |controller_id, slot_index| {
        let event = DaemonEvent::HomeButtonPressed {
            controller_id,
            slot_index,
        };
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = home_broadcaster.send(json);
        }
    });

    // Forward virtual device force-feedback rumble back to assigned physical controllers.
    let rumble_queue: Arc<Mutex<Vec<PendingRumble>>> = Arc::new(Mutex::new(Vec::new()));
    for slot_index in 0..SLOT_COUNT {
        let queue_ref = Arc::clone(&rumble_queue);
        input_router.register_rumble_callback(slot_index, move |low_freq, high_freq, duration_ms| {
            if let Ok(mut queue) = queue_ref.lock() {
                queue.push(PendingRumble {
                    slot_index,
                    low_freq,
                    high_freq,
                    duration_ms,
                });
            }
        });
    }

    sdl_host.open_existing_controllers(&mut input_router, &ws_server, &dsu_state)?;
    let initial_state = input_router.build_state_update();
    ws_server.set_initial_state(&initial_state)?;

    let listen_addr = daemon_config.websocket_address();
    let bound_addr = tokio_runtime.block_on(ws_server.listen(&listen_addr))?;
    info!("WebSocket server listening on {}", bound_addr);

    let dsu_address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), daemon_config.dsu_port);
    let dsu_state_for_server = Arc::clone(&dsu_state);
    let dsu_shutdown = Arc::clone(&shutdown_requested);
    tokio_runtime.spawn(async move {
        if let Err(error_value) =
            dsu::run_server(dsu_address, dsu_state_for_server, dsu_shutdown).await
        {
            error!("DSU UDP server exited with error: {}", error_value);
        }
    });
    info!("DSU/Cemuhook UDP server listening on {}", dsu_address);

    run_event_loop(
        &mut sdl_host,
        &mut input_router,
        &mut ws_server,
        &dsu_state,
        &rumble_queue,
        &shutdown_requested,
        daemon_config.poll_interval(),
    );

    info!("virtualpad-daemon shut down cleanly");
    Ok(())
}

/// Program entry point; initializes logging and exits with a non-zero status on fatal error.
fn main() {
    initialize_logging();

    if let Err(error_value) = run() {
        error!("Fatal virtualpad-daemon error: {}", error_value);
        std::process::exit(1);
    }
}
