#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod model;
mod settings;
mod sources;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::core::Shared;
use crate::model::MonitorState;
use crate::settings::AppSettings;

fn show_ball(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    if let Some(ball) = app.get_webview_window("ball") {
        let _ = ball.show();
    }
}

fn show_panel(app: &AppHandle) {
    if let Some(ball) = app.get_webview_window("ball") {
        let _ = ball.hide();
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
}

fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    if let Some(ball) = app.get_webview_window("ball") {
        let _ = ball.show();
    }
}

fn hide_to_tray(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    if let Some(ball) = app.get_webview_window("ball") {
        let _ = ball.hide();
    }
}

fn toggle_panel(app: &AppHandle) {
    let visible = app
        .get_webview_window("panel")
        .and_then(|panel| panel.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide_panel(app);
    } else {
        show_panel(app);
    }
}

fn apply_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    let normalized = hotkey.trim().to_ascii_lowercase().replace(' ', "");
    let shortcut: Shortcut = normalized
        .parse()
        .map_err(|error| format!("无效热键: {error}"))?;
    manager
        .register(shortcut)
        .map_err(|error| format!("注册热键失败: {error}"))
}

#[tauri::command]
fn get_state(shared: State<'_, Arc<Shared>>) -> MonitorState {
    shared.snapshot()
}

#[tauri::command]
fn get_settings(shared: State<'_, Arc<Shared>>) -> AppSettings {
    shared
        .settings
        .read()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    mut settings: AppSettings,
) -> Result<AppSettings, String> {
    settings.normalize();
    settings
        .save(&shared.config_dir)
        .map_err(|error| error.to_string())?;
    if let Ok(mut guard) = shared.settings.write() {
        *guard = settings.clone();
    }
    if let Err(error) = apply_hotkey(&app, &settings.hotkey) {
        tracing::warn!(%error, "hotkey registration failed");
    }
    shared.refresh.notify_one();
    Ok(settings)
}

#[tauri::command]
fn refresh_now(shared: State<'_, Arc<Shared>>) {
    shared.refresh.notify_one();
}

#[tauri::command]
fn toggle_panel_command(app: AppHandle) {
    toggle_panel(&app);
}

#[tauri::command]
fn show_panel_command(app: AppHandle) {
    show_panel(&app);
}

#[tauri::command]
fn hide_panel_command(app: AppHandle) {
    hide_panel(&app);
}

#[tauri::command]
fn hide_to_tray_command(app: AppHandle) {
    hide_to_tray(&app);
}

#[tauri::command]
fn show_ball_command(app: AppHandle) {
    show_ball(&app);
}

#[tauri::command]
fn open_dsh(app: AppHandle) -> Result<(), String> {
    let _ = app;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "dsh://open"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("open")
            .arg("dsh://open")
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示面板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到悬浮球", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "刷新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &refresh, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DSH 任务监控")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_panel(app),
            "hide" => hide_panel(app),
            "refresh" => {
                if let Some(shared) = app.try_state::<Arc<Shared>>() {
                    shared.refresh.notify_one();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn position_panel(app: &tauri::App) {
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    let Ok(Some(monitor)) = panel.primary_monitor() else {
        return;
    };
    let Ok(size) = panel.outer_size() else {
        return;
    };
    let position = monitor.position();
    let monitor_size = monitor.size();
    let x = position.x + monitor_size.width as i32 - size.width as i32 - 48;
    let y = position.y + ((monitor_size.height as i32 - size.height as i32) / 2).max(24);
    let _ = panel.set_position(PhysicalPosition::new(x, y));
}

fn main() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_panel(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_panel(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let mut settings = AppSettings::load(&config_dir);
            settings.normalize();
            let shared = Shared::new(settings.clone(), config_dir);
            app.manage(shared.clone());

            core::spawn(app.handle().clone(), shared.clone());
            sources::bridge::spawn_poller(shared.clone());

            setup_tray(app)?;
            position_panel(app);
            if let Some(ball) = app.get_webview_window("ball") {
                let _ = ball.show();
            }
            if let Err(error) = apply_hotkey(app.handle(), &settings.hotkey) {
                tracing::warn!(%error, "hotkey registration failed");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_settings,
            set_settings,
            refresh_now,
            toggle_panel_command,
            show_panel_command,
            hide_panel_command,
            hide_to_tray_command,
            show_ball_command,
            open_dsh,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running DSH Task Monitor");
}
