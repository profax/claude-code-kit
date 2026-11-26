//! What sessions billed by API key have spent: the session's cost and the
//! day's total across this machine's sessions. Both are Claude Code's
//! estimate by list prices, not an invoice. Subscription sessions are left
//! out: Claude Code counts the same cost for them, but nobody pays it.

use serde_json::{Value, json};

use crate::render::dim;

/// The session's cost in dollars; nothing below half a cent.
fn session(event: &Value) -> Option<String> {
    let usd = event["cost"]["total_cost_usd"].as_f64()?;
    (usd >= 0.005).then(|| format!("${usd:.2}"))
}

/// Adds to `day` what the session has spent since its last call. The day is
/// built from these additions, not from session totals: a session outlives a
/// day, and a cost lower than the last one means Claude Code started counting
/// the session from zero.
pub fn tally(kept: &mut Value, event: &Value, day: &str, now: i64) {
    let spend = crate::object(&mut kept["spend"]);
    if spend["day"] != day {
        spend["day"] = json!(day);
        spend["total"] = json!(0.0);
        // a session can be resumed weeks later: its last cost is kept a month
        if let Some(sessions) = spend["sessions"].as_object_mut() {
            sessions.retain(|_, last| last["seen"].as_i64() > Some(now - 30 * 86_400));
        }
    }
    let (Some(id), Some(cost)) = (
        event["session_id"].as_str(),
        event["cost"]["total_cost_usd"].as_f64(),
    ) else {
        return;
    };
    let last = spend["sessions"][id]["cost"].as_f64().unwrap_or(0.0);
    let added = if cost < last { cost } else { cost - last };
    if added > 0.0 {
        spend["total"] = json!(spend["total"].as_f64().unwrap_or(0.0) + added);
        crate::object(&mut spend["sessions"])[id] = json!({"cost": cost, "seen": now});
    }
}

/// The session's cost and the day's total as parts of the line. The day is
/// left out while it only repeats the session.
pub fn shown(kept: &Value, event: &Value) -> Vec<String> {
    let cost = event["cost"]["total_cost_usd"].as_f64().unwrap_or(0.0);
    let day = kept["spend"]["total"].as_f64().unwrap_or(0.0);
    let mut parts: Vec<String> = session(event).into_iter().collect();
    if day >= 0.005 && (day - cost).abs() >= 0.005 {
        parts.push(format!("{} ${day:.2}", dim("today")));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spent_in_dollars() {
        let cost = |usd: f64| session(&json!({"cost": {"total_cost_usd": usd}}));
        assert_eq!(cost(1.238).unwrap(), "$1.24");
        assert_eq!(cost(0.005).unwrap(), "$0.01");
        assert!(cost(0.004).is_none());
        assert!(session(&json!({})).is_none());
    }
}
