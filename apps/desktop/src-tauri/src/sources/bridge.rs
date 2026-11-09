use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::time::interval;

use crate::core::Shared;
use crate::model::MonitorState;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeDiscovery {
    pub protocol: u32,
    pub url: String,
    pub token: String,
}

#[derive(Clone, Debug)]
pub struct BridgeSource {
    pub url: String,
    pub tasks: Vec<crate::model::TaskSnapshot>,
    pub info: crate::model::DshInfo,
    pub last_ok: i64,
    pub latency_ms: u64,
    pub last_error: Option<String>,
    pub seq: u64,
}

/// Poll every bridge discovery file once per second. The bridge exposes the
/// same snapshot the app would receive over SSE; polling keeps the MVP simple
/// and costs one loopback request per second per DSH instance.
pub fn spawn_poller(shared: Arc<Shared>) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(2500))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(?error, "cannot build bridge HTTP client");
                return;
            }
        };
        let mut ticker = interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            let home = match shared.settings.read() {
                Ok(settings) => settings.resolved_dsh_home(),
                Err(_) => continue,
            };
            let dir = home.join("storages").join("task-monitor").join("bridges");
            let discoveries = read_discoveries(&dir);
            let mut seen = Vec::new();

            for discovery in discoveries {
                if discovery.protocol != 1 {
                    continue;
                }
                seen.push(discovery.url.clone());
                let started = Instant::now();
                match fetch_snapshot(&client, &discovery).await {
                    Ok(state) => {
                        let latency = started.elapsed().as_millis() as u64;
                        shared.apply_bridge_snapshot(state, discovery.url.clone(), latency);
                    }
                    Err(error) => {
                        shared.record_bridge_error(&discovery.url, error.to_string());
                    }
                }
            }

            shared.prune_bridges(&seen);
            if shared.has_bridges() {
                shared.refresh.notify_one();
            }
        }
    });
}

fn read_discoveries(dir: &PathBuf) -> Vec<BridgeDiscovery> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<BridgeDiscovery>(&text) {
            Ok(discovery) => result.push(discovery),
            Err(error) => {
                tracing::debug!(?error, path = %path.display(), "invalid bridge discovery")
            }
        }
    }
    result
}

async fn fetch_snapshot(
    client: &reqwest::Client,
    discovery: &BridgeDiscovery,
) -> anyhow::Result<MonitorState> {
    let response = client
        .get(format!(
            "{}/v1/snapshot",
            discovery.url.trim_end_matches('/')
        ))
        .bearer_auth(&discovery.token)
        .header("accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("bridge responded {}", response.status());
    }
    let state: MonitorState = response.json().await?;
    if state.schema != 1 {
        anyhow::bail!("unsupported bridge schema {}", state.schema);
    }
    Ok(state)
}
