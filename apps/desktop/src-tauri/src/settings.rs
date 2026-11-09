use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub dsh_home: String,
    pub source_mode: String,
    pub stale_ms: i64,
    pub max_tasks: usize,
    pub hide_when_idle: bool,
    pub notifications: bool,
    pub hotkey: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            dsh_home: String::new(),
            source_mode: "auto".into(),
            stale_ms: 90_000,
            max_tasks: 30,
            hide_when_idle: false,
            notifications: true,
            hotkey: "Ctrl+Alt+Shift+M".into(),
        }
    }
}

impl AppSettings {
    pub fn normalize(&mut self) {
        if !matches!(self.source_mode.as_str(), "auto" | "plugin" | "file") {
            self.source_mode = "auto".into();
        }
        self.stale_ms = self.stale_ms.clamp(10_000, 3_600_000);
        self.max_tasks = self.max_tasks.clamp(5, 100);
        if self.hotkey.trim().is_empty() {
            self.hotkey = "Ctrl+Alt+Shift+M".into();
        }
    }

    pub fn load(dir: &Path) -> Self {
        let path = dir.join("settings.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Self>(&text) {
                Ok(mut settings) => {
                    settings.normalize();
                    settings
                }
                Err(error) => {
                    tracing::warn!(?error, "invalid settings.json, falling back to defaults");
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("settings.json");
        let temporary = dir.join("settings.json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(temporary, path)?;
        Ok(())
    }

    /// Resolve the DSH home in this order: explicit setting, DSH_HOME, `~/.dsh`.
    pub fn resolved_dsh_home(&self) -> PathBuf {
        if !self.dsh_home.trim().is_empty() {
            return PathBuf::from(self.dsh_home.trim());
        }
        if let Ok(home) = std::env::var("DSH_HOME") {
            if !home.trim().is_empty() {
                return PathBuf::from(home);
            }
        }
        let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join(".dsh")
    }

    pub fn source_enabled(&self, kind: SourceKind) -> bool {
        match self.source_mode.as_str() {
            "plugin" => kind == SourceKind::Plugin,
            "file" => kind == SourceKind::File,
            _ => true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Plugin,
    File,
}
