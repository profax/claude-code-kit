//! Merges what sessions report with what the subscription server answers.
//!
//! A session learns its limits only from its own API responses, so an idle
//! one repeats stale numbers on every refresh. The store therefore changes
//! only for a new session and for one that got a response since its last call
//! (its `cost.total_api_duration_ms` grew or its numbers changed). A fresh
//! percentage can be lower than the kept one: resetting the limit in the
//! account settings keeps the week's `resets_at` and lowers the percentage,
//! and it starts a new five-hour window while idle sessions still hold the
//! old one.
//!
//! Claude Code reports no weekly limit of a single model, and nothing at all
//! before a session's first response. The server has both.

use jiff::Timestamp;
use serde_json::{Value, json};

use crate::login;

/// Keys of the windows in Claude Code's `rate_limits`, their labels in the
/// line and their lengths in seconds.
pub const WINDOWS: [(&str, &str, i64); 2] = [
    ("five_hour", "5h", 5 * 3600),
    ("seven_day", "week", 7 * 86_400),
];

/// Seconds between requests to the server, across all sessions. The server
/// counts requests and refuses frequent ones, and a model's weekly limit
/// barely moves in five minutes.
const ASK_EVERY: i64 = 300;

/// Seconds the server's last answer stands while every request after it
/// fails. Model limits come from the server alone: past this they could no
/// longer pass for current.
const ANSWER_LASTS: i64 = 3600;

/// A window from the server's answer in the shape of a Claude Code window: a
/// percentage and epoch seconds.
fn window(used: &Value, reset: &Value) -> Option<Value> {
    let used = used.as_f64()?;
    let reset = reset.as_i64().or_else(|| {
        let at: Timestamp = reset.as_str()?.parse().ok()?;
        Some(at.as_second())
    });
    Some(json!({"used_percentage": used, "resets_at": reset}))
}

/// Puts the server's answer into the store: it is fresher than any session's
/// reading. The list of model limits is replaced as a whole: a limit missing
/// from the answer does not apply to this subscription. Returns whether the
/// answer had that list.
fn absorb(kept: &mut Value, answer: &Value) -> bool {
    for (name, _, _) in WINDOWS {
        if let Some(fresh) = window(&answer[name]["utilization"], &answer[name]["resets_at"]) {
            kept[name] = fresh;
        }
    }
    if let Some(limits) = answer["limits"].as_array() {
        let scoped: Vec<Value> = limits
            .iter()
            .filter(|limit| limit["kind"] == "weekly_scoped")
            .filter_map(|limit| {
                let mut fresh = window(&limit["percent"], &limit["resets_at"])?;
                fresh["name"] = limit["scope"]["model"]["display_name"].clone();
                fresh["name"].is_string().then_some(fresh)
            })
            .collect();
        kept["scoped"] = json!(scoped);
        return true;
    }
    false
}

/// Asks the server with `token` and puts its answer into the store. When it
/// has failed for longer than `ANSWER_LASTS` since its last good answer, the
/// model limits leave the store until it answers again.
fn ask(kept: &mut Value, token: &str, now: i64) {
    if login::ask(token).is_some_and(|answer| absorb(kept, &answer)) {
        kept["answered_at"] = json!(now);
    } else if kept["answered_at"]
        .as_i64()
        .is_none_or(|at| now.saturating_sub(at) > ANSWER_LASTS)
        && let Some(store) = kept.as_object_mut()
    {
        store.remove("scoped");
    }
}

/// What a session has brought since its last call.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Seen {
    /// The session is new: its numbers come from its first API response.
    New,
    /// It got a new API response: the numbers are fresh.
    Renewed,
    /// No response since: the same numbers it has reported before.
    Same,
}

/// Whether reading `a` from a `seen` session is newer than the kept `b`, for
/// one window. Numbers without a new response never replace the kept ones:
/// an idle session would bring back a window that has already been replaced.
/// One subscription has one upcoming reset, so a fresh reading with another
/// future reset means the login changed and the kept reading belongs to the
/// previous one. Within one window a drop of one point is the other
/// source's rounding (the server said 99, a session 98 a moment later) and
/// is left out; a larger drop is a limit reset early and shows at once.
fn newer(a: &Value, b: &Value, seen: Seen, now: i64) -> bool {
    let reset = |v: &Value| v["resets_at"].as_i64().unwrap_or(0);
    if b.is_null() {
        return true;
    }
    if seen == Seen::Same {
        return false;
    }
    if reset(a) == reset(b) {
        let used = |v: &Value| v["used_percentage"].as_f64().unwrap_or(0.0);
        return used(a) > used(b) || used(a) < used(b) - 1.0;
    }
    reset(a) > reset(b) || reset(a) > now
}

/// Records the session's reading and tells whether it is fresh. Sessions
/// whose windows have all reset are forgotten: their numbers are older than
/// any current window.
fn remember(kept: &mut Value, event: &Value, now: i64) -> Seen {
    let id = event["session_id"].as_str().unwrap_or("");
    let mark = json!({
        "api_ms": event["cost"]["total_api_duration_ms"],
        "rate_limits": event["rate_limits"],
    });
    let seen = match kept["sessions"].get(id) {
        None => Seen::New,
        Some(last) if *last != mark => Seen::Renewed,
        Some(_) => Seen::Same,
    };
    if let Some(sessions) = kept["sessions"].as_object_mut() {
        sessions.retain(|other, last| {
            other == id
                || last["rate_limits"]
                    .as_object()
                    .is_some_and(|l| l.values().any(|w| w["resets_at"].as_i64() > Some(now)))
        });
    }
    if seen != Seen::Same {
        crate::object(&mut kept["sessions"])[id] = mark;
    }
    seen
}

/// Merges the session's reading into the store and, when one is due and
/// `may_ask`, the server's answer. Returns whether the session's data has
/// subscription limits.
pub fn update(kept: &mut Value, event: &Value, now: i64, may_ask: bool) -> bool {
    let (has_limits, is_due) = merge(kept, event, now, may_ask);
    if is_due && let Some(token) = login::token(now) {
        ask(kept, &token, now);
    }
    has_limits
}

/// Merges the session's reading into the store. Returns whether the session's
/// data has subscription limits, and whether the server is to be asked now,
/// which counts as asking: the next session waits `ASK_EVERY` from here.
fn merge(kept: &mut Value, event: &Value, now: i64, may_ask: bool) -> (bool, bool) {
    let has_limits = WINDOWS
        .iter()
        .any(|(window, _, _)| event["rate_limits"][window]["used_percentage"].is_number());
    // before the first API response there are no numbers to record
    let seen = if has_limits {
        remember(kept, event, now)
    } else {
        Seen::Same
    };
    for (window, _, _) in WINDOWS {
        let fresh = &event["rate_limits"][window];
        if fresh["used_percentage"].is_number() && newer(fresh, &kept[window], seen, now) {
            kept[window] = fresh.clone();
        }
    }
    // A new session and a working one ask; an idle one makes do with what
    // the others have brought. The attempt counts even without a login:
    // looking for one starts a program on macOS.
    let due = kept["asked_at"]
        .as_i64()
        .is_none_or(|at| now.saturating_sub(at) >= ASK_EVERY);
    let is_due = may_ask && (!has_limits || seen != Seen::Same) && due;
    if is_due {
        kept["asked_at"] = json!(now);
    }
    (has_limits, is_due)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render;

    fn at(reset: i64, used: f64) -> Value {
        json!({"resets_at": reset, "used_percentage": used})
    }

    #[test]
    fn same_window_trusts_only_fresh_numbers() {
        // the same week: an idle session reports old numbers, they are not newer
        assert!(!newer(&at(100, 72.0), &at(100, 75.0), Seen::Same, 50));
        assert!(!newer(&at(100, 99.0), &at(100, 75.0), Seen::Same, 50));
        // a new response: a higher percentage is newer
        assert!(newer(&at(100, 76.0), &at(100, 75.0), Seen::Renewed, 50));
        // the window has reset: the next window is newer at any percentage
        assert!(newer(&at(200, 1.0), &at(100, 75.0), Seen::Renewed, 150));
        // an idle session with its previous window, still running, is not newer
        assert!(!newer(&at(120, 68.0), &at(200, 8.0), Seen::Same, 50));
        assert!(!newer(&at(100, 99.0), &at(200, 1.0), Seen::Renewed, 150));
        // an empty store gives way to any reading
        assert!(newer(&at(100, 0.0), &Value::Null, Seen::Same, 50));
    }

    #[test]
    fn the_server_is_asked_by_a_new_or_working_session_once_in_a_while() {
        let event = |api: u64| {
            json!({"session_id": "a", "cost": {"total_api_duration_ms": api},
                   "rate_limits": {"seven_day": at(10_000, 5.0)}})
        };
        let mut kept = json!({});
        assert_eq!(merge(&mut kept, &event(1), 0, true), (true, true));
        // the same session idle, then working again before ASK_EVERY is up
        assert_eq!(merge(&mut kept, &event(1), ASK_EVERY, true), (true, false));
        assert_eq!(
            merge(&mut kept, &event(2), ASK_EVERY - 1, true),
            (true, false)
        );
        assert_eq!(merge(&mut kept, &event(3), ASK_EVERY, true), (true, true));
        // a session before its first response has no numbers and asks
        assert_eq!(
            merge(&mut kept, &json!({}), 2 * ASK_EVERY, true),
            (false, true)
        );
        // without the store's lock no session asks
        assert_eq!(
            merge(&mut kept, &event(4), 3 * ASK_EVERY, false),
            (true, false)
        );
    }

    #[test]
    fn sessions_are_remembered_until_their_windows_end() {
        let event = |id: &str, api: u64, reset: i64| {
            json!({"session_id": id, "cost": {"total_api_duration_ms": api},
                   "rate_limits": {"seven_day": at(reset, 5.0)}})
        };
        let mut kept = json!({});
        assert_eq!(remember(&mut kept, &event("a", 10, 100), 50), Seen::New);
        assert_eq!(remember(&mut kept, &event("a", 10, 100), 50), Seen::Same);
        assert_eq!(remember(&mut kept, &event("a", 20, 100), 50), Seen::Renewed);
        assert_eq!(remember(&mut kept, &event("b", 10, 300), 50), Seen::New);
        // the week of `a` has ended: `a` is forgotten, `b` stays
        assert_eq!(remember(&mut kept, &event("b", 10, 300), 150), Seen::Same);
        assert!(kept["sessions"].get("a").is_none());
        assert!(kept["sessions"].get("b").is_some());
    }

    #[test]
    fn a_window_drops_only_by_a_reset() {
        // the server said 99, then a session rounds the same week to 98:
        // the shown number must not drop to 98
        assert!(!newer(&at(100, 98.0), &at(100, 99.0), Seen::Renewed, 50));
        assert!(newer(&at(100, 99.0), &at(100, 98.0), Seen::Renewed, 50));
        // a limit reset early, with the same reset time or a new one,
        // shows from a session and from the server alike
        assert!(newer(&at(100, 1.0), &at(100, 100.0), Seen::New, 50));
        assert!(newer(&at(300, 0.0), &at(100, 99.0), Seen::Renewed, 50));
        let mut kept = json!({"seven_day": at(100, 99.0)});
        absorb(
            &mut kept,
            &json!({"seven_day": {"utilization": 0.0, "resets_at": 100}}),
        );
        assert_eq!(kept["seven_day"], at(100, 0.0));
    }

    #[test]
    fn other_subscription_replaces_kept_week() {
        // the login changed to a subscription whose week resets earlier
        let before = at(1_793_570_400, 94.0);
        let after = at(1_793_448_000, 84.0);
        assert!(newer(&after, &before, Seen::Renewed, 1_793_282_823));
    }

    #[test]
    fn server_answer_as_it_came() {
        // a real answer of the server, extra fields removed
        let answer = json!({
            "five_hour": {"utilization": 63.0, "resets_at": "2026-11-26T05:49:59.834360+00:00"},
            "seven_day": {"utilization": 56.0, "resets_at": "2026-11-28T11:59:59.834380+00:00"},
            "seven_day_opus": null,
            "limits": [
                {"kind": "session", "group": "session", "percent": 63,
                 "resets_at": "2026-11-26T05:49:59.834360+00:00", "scope": null},
                {"kind": "weekly_all", "group": "weekly", "percent": 56,
                 "resets_at": "2026-11-28T11:59:59.834380+00:00", "scope": null},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 56,
                 "resets_at": "2026-11-28T11:59:59.834516+00:00",
                 "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}},
            ],
        });
        let mut kept = json!({"scoped": [{"name": "Opus", "used_percentage": 1.0}]});
        absorb(&mut kept, &answer);
        assert_eq!(kept["five_hour"], at(1_795_672_199, 63.0));
        assert_eq!(kept["seven_day"], at(1_795_867_199, 56.0));
        assert_eq!(
            kept["scoped"],
            json!([{"used_percentage": 56.0, "resets_at": 1_795_867_199, "name": "Fable"}])
        );
        // the model's limit resets together with the week: one time for both
        let now = 1_795_867_199 - 3600;
        assert_eq!(
            render::scoped(&kept, now),
            ["\x1b[38;5;243mfable\x1b[0m 56%"]
        );
        // an answer without the list of limits keeps the previous list
        absorb(&mut kept, &json!({"error": "rate_limited"}));
        assert_eq!(kept["scoped"][0]["name"], "Fable");
    }
}
