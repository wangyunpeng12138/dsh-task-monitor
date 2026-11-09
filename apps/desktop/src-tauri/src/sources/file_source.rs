use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use serde_json::Value;

use crate::model::{
    now_ms, sort_tasks, Goal, ModelInfo, Phase, Progress, TaskSnapshot, TodoItem, TodoProgress,
    Tokens, TurnInfo, Waiting,
};

const RECENT_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;

/// Read the projection cache DSH writes for every session and turn it into
/// task cards. This path is read-only and works without any plugin installed.
pub fn scan(home: &Path, stale_ms: i64, max_tasks: usize) -> Result<Vec<TaskSnapshot>> {
    let dir = home
        .join("storages")
        .join("session_projcache")
        .join("sessions");
    let mut tasks = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(tasks);
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        match parse_record(id, &path, stale_ms) {
            Ok(Some(task)) => tasks.push(task),
            Ok(None) => {}
            Err(error) => {
                tracing::debug!(?error, path = %path.display(), "skip unreadable session projection");
            }
        }
    }

    sort_tasks(&mut tasks);
    tasks.truncate(max_tasks);
    Ok(tasks)
}

fn parse_record(id: &str, path: &Path, stale_ms: i64) -> Result<Option<TaskSnapshot>> {
    let text = std::fs::read_to_string(path)?;
    let root: Value = serde_json::from_str(&text)?;
    let record = root.get("record").unwrap_or(&root);
    let rows = record.get("rows").unwrap_or(&Value::Null);
    let identity = record.get("identity").unwrap_or(&Value::Null);

    let updated_at = modified_ms(path).unwrap_or_else(now_ms);
    let metadata = row(rows, "sessionListMetadata");
    if flag(metadata, "blank").unwrap_or(false) {
        return Ok(None);
    }

    let cwd = identity
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| string(row(rows, "workingDirectory")));

    let title = string(row(rows, "title"))
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            cwd.as_deref()
                .and_then(basename)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| format!("会话 {}", &id[..id.len().min(12)]));

    let last_prompt_at = metadata
        .and_then(|value| value.get("lastPromptAt"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let updated_at = updated_at.max(last_prompt_at);

    let stats = row(rows, "sessionStats");
    let turn = row(rows, "turnBoundary");
    let open_turn = turn
        .and_then(|value| value.get("openTurnStartSeq"))
        .map(|value| !value.is_null())
        .unwrap_or(false);
    let last_turn = turn
        .and_then(|value| value.get("lastTurn"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let open_step = stats.and_then(|value| value.get("openStep"));
    let turn_index = open_step
        .and_then(|value| value.get("turn"))
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(last_turn);
    let step_index = open_step
        .and_then(|value| value.get("step"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);

    let questions = row(rows, "userQuestions")
        .and_then(|value| value.get("questions"))
        .and_then(|value| value.get("active"))
        .and_then(Value::as_array);
    let question_count = questions.map(Vec::len).unwrap_or(0);
    let stale = now_ms().saturating_sub(updated_at) > stale_ms;

    let phase = if question_count > 0 {
        Phase::Waiting
    } else if open_turn && stale {
        Phase::Stale
    } else if open_turn {
        Phase::Running
    } else if last_turn > 0 || turn_index > 0 {
        Phase::Completed
    } else {
        Phase::Unknown
    };

    if phase == Phase::Unknown && tooltip_empty(&title) {
        return Ok(None);
    }
    let recency = if matches!(phase, Phase::Running | Phase::Waiting | Phase::Stale) {
        updated_at
    } else if last_prompt_at > 0 {
        last_prompt_at
    } else {
        updated_at
    };
    if !matches!(phase, Phase::Running | Phase::Waiting | Phase::Stale)
        && now_ms().saturating_sub(recency) > RECENT_WINDOW_MS
    {
        return Ok(None);
    }
    if last_prompt_at == 0 && step_index.is_none() && question_count == 0 && last_turn == 0 {
        return Ok(None);
    }

    let todos = row(rows, "todos").and_then(parse_todos);
    let todo_progress = todos.as_ref().map(|items| {
        let done = items
            .iter()
            .filter(|item| item.status == "completed")
            .count();
        let doing = items
            .iter()
            .filter(|item| item.status == "in_progress")
            .count();
        let total = items.len();
        let percent = if total == 0 {
            0.0
        } else {
            ((done as f64 + doing as f64 * 0.5) / total as f64) * 100.0
        };
        let current = items
            .iter()
            .find(|item| item.status == "in_progress")
            .map(|item| item.content.clone());
        let progress = Progress {
            kind: "todos".into(),
            percent: Some(percent.round().clamp(0.0, 100.0) as u32),
            label: build_todo_label(done, total, current.as_deref()),
        };
        (
            TodoProgress {
                items: items
                    .iter()
                    .map(|item| TodoItem {
                        content: item.content.clone(),
                        status: item.status.clone(),
                    })
                    .collect(),
                done,
                total,
                current,
            },
            progress,
        )
    });
    let todo = todo_progress.as_ref().map(|(value, _)| value.clone());
    let progress = todo_progress
        .map(|(_, progress)| progress)
        .unwrap_or_else(|| fallback_progress(phase, step_index, turn_index, stats));

    let waiting = if question_count > 0 {
        Some(Waiting {
            kind: "question".into(),
            since: last_prompt_at.max(updated_at),
            summary: question_summary(questions),
        })
    } else {
        None
    };

    let model = row(rows, "modelSelection")
        .and_then(|value| value.get("lastUsed"))
        .and_then(|value| {
            Some(ModelInfo {
                provider: value.get("provider")?.as_str()?.to_owned(),
                model: value.get("model")?.as_str()?.to_owned(),
            })
        });

    let tokens = parse_tokens(rows);
    let goal = parse_goal(rows.get("goal").and_then(|entry| entry.get("val")));
    let started_at = if last_prompt_at > 0 {
        Some(last_prompt_at)
    } else {
        open_step
            .and_then(|value| value.get("startTime"))
            .and_then(Value::as_i64)
    };

    Ok(Some(TaskSnapshot {
        id: id.to_owned(),
        source_id: String::new(),
        title,
        cwd,
        workspace: None,
        origin: "user".into(),
        parent_id: None,
        phase_reason: Some(match phase {
            Phase::Running => "open turn".into(),
            Phase::Waiting => "user question".into(),
            Phase::Stale => "no update".into(),
            Phase::Completed => "turn closed".into(),
            _ => "file snapshot".into(),
        }),
        phase,
        started_at,
        updated_at,
        turn: if turn_index > 0 {
            Some(TurnInfo {
                index: turn_index,
                step: step_index,
            })
        } else {
            None
        },
        todos: todo,
        progress,
        jobs: None,
        waiting,
        goal,
        model,
        tokens,
        error: None,
        last_event: None,
    }))
}

fn fallback_progress(
    phase: Phase,
    step_index: Option<u32>,
    turn_index: u32,
    stats: Option<&Value>,
) -> Progress {
    if phase == Phase::Completed {
        return Progress {
            kind: "turn".into(),
            percent: Some(100),
            label: "已完成".into(),
        };
    }
    let pending = stats
        .and_then(|value| value.get("pendingCalls"))
        .and_then(Value::as_object)
        .map(|value| value.len())
        .unwrap_or(0);
    if let Some(step) = step_index {
        let label = if pending > 0 {
            format!("第 {step} 步 · {pending} 个工具执行中")
        } else {
            format!("第 {step} 步")
        };
        return Progress {
            kind: "steps".into(),
            percent: None,
            label,
        };
    }
    if turn_index > 0 {
        return Progress {
            kind: "turn".into(),
            percent: None,
            label: format!("第 {turn_index} 回合"),
        };
    }
    Progress {
        kind: "turn".into(),
        percent: None,
        label: if phase == Phase::Stale {
            "无更新".into()
        } else {
            "等待开始".into()
        },
    }
}

fn build_todo_label(done: usize, total: usize, current: Option<&str>) -> String {
    let mut label = format!("{done}/{total}");
    if let Some(current) = current {
        label.push_str(" · ");
        label.push_str(current);
    }
    label
}

fn parse_todos(value: &Value) -> Option<Vec<TodoItem>> {
    let array = value.as_array()?;
    if array.is_empty() {
        return None;
    }
    let items = array
        .iter()
        .filter_map(|item| {
            let content = item.get("content")?.as_str()?.to_owned();
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            let status = match status {
                "completed" | "in_progress" => status,
                _ => "pending",
            };
            Some(TodoItem {
                content,
                status: status.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn question_summary(questions: Option<&Vec<Value>>) -> String {
    let Some(questions) = questions else {
        return "等待回答".into();
    };
    let count = questions.len();
    let text = questions
        .iter()
        .find_map(|item| {
            item.get("questions")
                .and_then(Value::as_array)
                .and_then(|list| list.first())
        })
        .and_then(|question| {
            question
                .get("question")
                .or_else(|| question.get("prompt"))
                .or_else(|| question.get("text"))
                .and_then(Value::as_str)
        });
    match text {
        Some(text) if !text.is_empty() => format!("{count} 个问题 · {text}"),
        _ => format!("{count} 个问题待回答"),
    }
}

fn parse_tokens(rows: &Value) -> Option<Tokens> {
    let pressure = row(rows, "contextPressure").and_then(|value| {
        let pressure = value.get("pressureTokens")?.as_f64()?;
        let window = value.get("contextWindow")?.as_f64()?;
        if window <= 0.0 {
            None
        } else {
            Some((pressure / window).clamp(0.0, 1.0))
        }
    });
    let output_tokens = row(rows, "tokenUsage")
        .and_then(|value| value.get("totals"))
        .and_then(|value| value.get("outputTokens"))
        .and_then(Value::as_i64);
    if pressure.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(Tokens {
        context_pressure: pressure,
        output_tokens,
    })
}

fn parse_goal(value: Option<&Value>) -> Option<Goal> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let objective = value
        .get("objective")
        .or_else(|| value.get("title"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let phase = value
        .get("phase")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let round = value
        .get("round")
        .or_else(|| value.get("roundNumber"))
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .or_else(|| {
            value
                .get("rounds")
                .and_then(Value::as_array)
                .map(|items| items.len() as u32)
        });
    let max_rounds = value
        .get("maxRounds")
        .or_else(|| value.get("max"))
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    if objective.is_none() && phase.is_none() && round.is_none() {
        return None;
    }
    Some(Goal {
        objective,
        phase,
        round,
        max_rounds,
    })
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis() as i64)
}

fn row<'a>(rows: &'a Value, key: &str) -> Option<&'a Value> {
    rows.get(key).and_then(|entry| entry.get("val"))
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: Option<&Value>, key: &str) -> Option<bool> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
}

fn basename(path: &str) -> Option<String> {
    PathBuf::from(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
}

fn tooltip_empty(title: &str) -> bool {
    title.trim().is_empty() || title.starts_with("会话 ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_projection_cache_into_a_running_task() {
        let home = std::env::temp_dir().join(format!("dsh-monitor-test-{}", std::process::id()));
        let dir = home
            .join("storages")
            .join("session_projcache")
            .join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let record = serde_json::json!({
            "record": {
                "identity": { "cwd": "E:\\work\\demo", "createdAt": 1000 },
                "rows": {
                    "title": { "val": "Demo task" },
                    "todos": { "val": [
                        { "content": "scaffold", "status": "completed" },
                        { "content": "wire bridge", "status": "in_progress" }
                    ] },
                    "sessionStats": { "val": {
                        "steps": 3,
                        "lastTurn": 1,
                        "openStep": { "turn": 1, "step": 2, "startTime": now_ms() - 1000 },
                        "pendingCalls": { "call-1": { "name": "pwsh" } }
                    } },
                    "turnBoundary": { "val": { "openTurnStartSeq": 5, "lastTurn": 1 } },
                    "sessionListMetadata": { "val": { "blank": false, "lastPromptAt": now_ms() - 2000 } }
                }
            }
        });
        std::fs::write(
            dir.join("session-demo.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();

        let tasks = scan(&home, 90_000, 30).unwrap();
        assert_eq!(tasks.len(), 1);
        let task = &tasks[0];
        assert_eq!(task.title, "Demo task");
        assert_eq!(task.phase, Phase::Running);
        assert_eq!(task.todos.as_ref().unwrap().done, 1);
        assert_eq!(task.progress.percent, Some(75));
        assert_eq!(task.turn.as_ref().unwrap().step, Some(2));
        assert!(task.progress.label.contains("1/2"));

        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn skips_blank_and_old_sessions() {
        let home =
            std::env::temp_dir().join(format!("dsh-monitor-test-blank-{}", std::process::id()));
        let dir = home
            .join("storages")
            .join("session_projcache")
            .join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let blank = serde_json::json!({
            "record": {
                "identity": { "cwd": "E:\\work\\demo" },
                "rows": { "sessionListMetadata": { "val": { "blank": true } } }
            }
        });
        std::fs::write(
            dir.join("session-blank.json"),
            serde_json::to_vec(&blank).unwrap(),
        )
        .unwrap();
        let tasks = scan(&home, 90_000, 30).unwrap();
        assert!(tasks.is_empty());
        std::fs::remove_dir_all(&home).unwrap();
    }
}
