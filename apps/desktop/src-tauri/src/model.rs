use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Running,
    Waiting,
    Completed,
    Failed,
    Aborted,
    Interrupted,
    Blocked,
    Stale,
    Unknown,
}

impl Phase {
    fn rank(&self) -> u8 {
        match self {
            Phase::Waiting => 0,
            Phase::Failed => 1,
            Phase::Running => 2,
            Phase::Blocked => 3,
            Phase::Interrupted => 4,
            Phase::Stale => 5,
            Phase::Completed => 6,
            Phase::Aborted => 7,
            Phase::Unknown => 8,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoProgress {
    pub items: Vec<TodoItem>,
    pub done: usize,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobBrief {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Jobs {
    pub running: usize,
    pub total: usize,
    pub recent: Vec<JobBrief>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub kind: String,
    pub since: i64,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_pressure: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastEvent {
    pub r#type: String,
    pub seq: i64,
    pub time: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub id: String,
    pub source_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos: Option<TodoProgress>,
    pub progress: Progress,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jobs: Option<Jobs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<Waiting>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event: Option<LastEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub total: usize,
    pub running: usize,
    pub waiting: usize,
    pub failed: usize,
    pub attention: usize,
    pub worst: Option<Phase>,
}

pub fn aggregate(tasks: &[TaskSnapshot]) -> Aggregate {
    let mut result = Aggregate {
        total: tasks.len(),
        ..Default::default()
    };
    let mut worst: Option<&Phase> = None;
    for task in tasks {
        match task.phase {
            Phase::Running => result.running += 1,
            Phase::Waiting => result.waiting += 1,
            Phase::Failed | Phase::Interrupted => result.failed += 1,
            _ => {}
        }
        if worst.map(|w| task.phase.rank() < w.rank()).unwrap_or(true) {
            worst = Some(&task.phase);
        }
    }
    result.attention = result.waiting;
    result.worst = Some(worst.cloned().unwrap_or(Phase::Unknown));
    result
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshInfo {
    pub source_id: String,
    pub pid: u32,
    pub version: String,
    pub profile: String,
    pub mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub source: String,
    pub last_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorState {
    pub schema: u32,
    pub generated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dsh: Option<DshInfo>,
    pub aggregate: Aggregate,
    pub tasks: Vec<TaskSnapshot>,
    pub health: Health,
}

impl MonitorState {
    pub fn offline() -> Self {
        Self {
            schema: 1,
            generated_at: now_ms(),
            dsh: None,
            aggregate: Aggregate {
                worst: Some(Phase::Unknown),
                ..Default::default()
            },
            tasks: Vec::new(),
            health: Health {
                source: "offline".into(),
                last_seq: 0,
                last_event_at: None,
                latency_ms: None,
                message: None,
            },
        }
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn sort_tasks(tasks: &mut [TaskSnapshot]) {
    tasks.sort_by(|a, b| {
        let rank = a.phase.rank().cmp(&b.phase.rank());
        if rank.is_ne() {
            return rank;
        }
        b.updated_at.cmp(&a.updated_at)
    })
}
