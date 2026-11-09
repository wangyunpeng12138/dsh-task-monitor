use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::model::{
    aggregate, now_ms, sort_tasks, DshInfo, Health, MonitorState, TaskSnapshot, PROTOCOL_VERSION,
};
use crate::settings::{AppSettings, SourceKind};
use crate::sources::bridge::BridgeSource;
use crate::sources::file_source;

pub struct Shared {
    pub state: RwLock<MonitorState>,
    pub settings: RwLock<AppSettings>,
    pub refresh: Notify,
    pub config_dir: PathBuf,
    pub bridge_sources: RwLock<HashMap<String, BridgeSource>>,
}

impl Shared {
    pub fn new(settings: AppSettings, config_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            state: RwLock::new(MonitorState::offline()),
            settings: RwLock::new(settings),
            refresh: Notify::new(),
            config_dir,
            bridge_sources: RwLock::new(HashMap::new()),
        })
    }

    pub fn snapshot(&self) -> MonitorState {
        self.state
            .read()
            .map(|state| state.clone())
            .unwrap_or_else(|_| MonitorState::offline())
    }

    pub fn apply_bridge_snapshot(&self, state: MonitorState, url: String, latency_ms: u64) {
        let Some(info) = state.dsh.clone() else {
            return;
        };
        let source_id = info.source_id.clone();
        let source = BridgeSource {
            url,
            tasks: state.tasks,
            info,
            last_ok: now_ms(),
            latency_ms,
            last_error: None,
            seq: state.health.last_seq,
        };
        if let Ok(mut sources) = self.bridge_sources.write() {
            sources.insert(source_id, source);
        }
        self.refresh.notify_one();
    }

    pub fn record_bridge_error(&self, url: &str, message: String) {
        if let Ok(mut sources) = self.bridge_sources.write() {
            for source in sources.values_mut() {
                if source.url == url {
                    source.last_error = Some(message.clone());
                }
            }
        }
    }

    pub fn prune_bridges(&self, seen_urls: &[String]) {
        let now = now_ms();
        if let Ok(mut sources) = self.bridge_sources.write() {
            sources.retain(|_, source| {
                let seen = seen_urls.iter().any(|url| url == &source.url);
                (seen && source.last_error.is_none()) || now.saturating_sub(source.last_ok) < 20_000
            });
        }
    }

    pub fn has_bridges(&self) -> bool {
        self.bridge_sources
            .read()
            .map(|sources| !sources.is_empty())
            .unwrap_or(false)
    }

    pub fn is_busy(&self) -> bool {
        self.state
            .read()
            .map(|state| state.aggregate.running > 0 || state.aggregate.waiting > 0)
            .unwrap_or(false)
    }

    pub fn bridge_tasks(&self) -> Vec<TaskSnapshot> {
        self.bridge_sources
            .read()
            .map(|sources| {
                sources
                    .values()
                    .flat_map(|source| source.tasks.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn bridge_info(&self) -> Option<DshInfo> {
        self.bridge_sources
            .read()
            .ok()
            .and_then(|sources| sources.values().next().map(|source| source.info.clone()))
    }

    pub fn bridge_health(&self) -> Option<(u64, u64, Option<String>)> {
        let sources = self.bridge_sources.read().ok()?;
        if sources.is_empty() {
            return None;
        }
        let seq = sources.values().map(|source| source.seq).max().unwrap_or(0);
        let latency = sources
            .values()
            .map(|source| source.latency_ms)
            .max()
            .unwrap_or(0);
        let error = sources
            .values()
            .find_map(|source| source.last_error.clone());
        Some((seq, latency, error))
    }
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>) {
    tauri::async_runtime::spawn(async move {
        let mut last_signature = String::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(1000));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = shared.refresh.notified() => {}
            }

            let settings = match shared.settings.read() {
                Ok(settings) => settings.clone(),
                Err(_) => continue,
            };

            let mut message: Option<String> = None;
            let mut file_tasks: Vec<TaskSnapshot> = Vec::new();

            if settings.source_enabled(SourceKind::File) {
                let home = settings.resolved_dsh_home();
                match file_source::scan(&home, settings.stale_ms, settings.max_tasks) {
                    Ok(mut found) => {
                        for task in &mut found {
                            task.source_id = "file".into();
                        }
                        file_tasks = found;
                    }
                    Err(error) => {
                        message = Some(format!("读取会话数据失败: {error}"));
                    }
                }
            }

            let plugin_enabled = settings.source_enabled(SourceKind::Plugin);
            let plugin_connected = plugin_enabled && shared.has_bridges();
            let plugin_tasks = if plugin_connected {
                shared.bridge_tasks()
            } else {
                Vec::new()
            };

            let tasks = match settings.source_mode.as_str() {
                "plugin" => plugin_tasks,
                "file" => file_tasks,
                _ => merge_tasks(file_tasks, plugin_tasks),
            };
            let mut tasks = tasks;
            tasks.truncate(settings.max_tasks);

            let source = if plugin_connected {
                "plugin"
            } else if settings.source_enabled(SourceKind::File) {
                "file"
            } else {
                "offline"
            };
            if settings.source_mode == "plugin" && !plugin_connected {
                message = Some("等待 DSH 插件桥连接".into());
            }

            let (last_seq, latency_ms, bridge_error) =
                shared.bridge_health().unwrap_or((0, 0, None));
            if message.is_none() {
                message = bridge_error;
            }

            let signature = format!(
                "{source}|{message:?}|{last_seq}|{}",
                serde_json::to_string(&tasks).unwrap_or_default()
            );
            if signature == last_signature {
                continue;
            }

            let aggregate = aggregate(&tasks);
            let dsh = if plugin_connected {
                shared.bridge_info()
            } else if source == "file" {
                Some(DshInfo {
                    source_id: "file".into(),
                    pid: 0,
                    version: "file".into(),
                    profile: "local".into(),
                    mode: "file".into(),
                })
            } else {
                None
            };
            let state = MonitorState {
                schema: PROTOCOL_VERSION,
                generated_at: now_ms(),
                dsh,
                aggregate,
                tasks,
                health: Health {
                    source: source.into(),
                    last_seq,
                    last_event_at: if plugin_connected {
                        Some(now_ms())
                    } else {
                        None
                    },
                    latency_ms: if plugin_connected {
                        Some(latency_ms)
                    } else {
                        None
                    },
                    message,
                },
            };

            if let Ok(mut guard) = shared.state.write() {
                *guard = state.clone();
            }
            let _ = app.emit("monitor://state", &state);

            if settings.hide_when_idle {
                let panel_visible = app
                    .get_webview_window("panel")
                    .and_then(|panel| panel.is_visible().ok())
                    .unwrap_or(false);
                if let Some(ball) = app.get_webview_window("ball") {
                    let ball_visible = ball.is_visible().unwrap_or(false);
                    let busy = shared.is_busy();
                    if busy && !ball_visible && !panel_visible {
                        let _ = ball.show();
                    } else if !busy && ball_visible && !panel_visible {
                        let _ = ball.hide();
                    }
                }
            }
            last_signature = signature;
        }
    });
}

fn merge_tasks(file: Vec<TaskSnapshot>, plugin: Vec<TaskSnapshot>) -> Vec<TaskSnapshot> {
    let mut merged: HashMap<String, TaskSnapshot> = HashMap::new();
    for task in file {
        merged.insert(task.id.clone(), task);
    }
    for task in plugin {
        merged.insert(task.id.clone(), task);
    }
    let mut tasks: Vec<TaskSnapshot> = merged.into_values().collect();
    sort_tasks(&mut tasks);
    tasks
}
