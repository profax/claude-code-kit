//! Parts of the line, with ANSI colors. Yellow and red mark a number close
//! to its limit and are used for nothing else.

use serde_json::{Value, json};

/// "12m", "4h 5m", "2d 23h 5m": the time left, rounded up to a minute.
fn left(seconds: i64) -> String {
    let minutes = (seconds + 59) / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h {}m", minutes % 60);
    }
    format!("{}d {}h {}m", hours / 24, hours % 24, minutes % 60)
}

/// A limit window as a part of the line, or `None` without a percentage.
/// `timed` tells whether to add the time left until the reset.
pub fn window(name: &str, limit: &Value, now: i64, timed: bool) -> Option<String> {
    let used = limit["used_percentage"].as_f64()?;
    let reset = limit["resets_at"].as_i64();
    // the window has reset, and no response has brought the next one yet
    if reset.is_some_and(|r| r <= now) {
        return Some(format!("{} 0%", dim(name)));
    }
    let reset = reset
        .filter(|_| timed)
        .map_or(String::new(), |r| dim(&format!(" ↻ {}", left(r - now))));
    Some(format!("{} {}{reset}", dim(name), painted(used, 75, 90)))
}

/// Weekly limits of single models, each under the model's name. The time is
/// shown only when it is the limit's own: a limit without one resets
/// together with the week. A limit that has reset is left out: only the
/// server reports the next one, and 0% until then would be a guess.
pub fn scoped(kept: &Value, now: i64) -> Vec<String> {
    let week = kept["seven_day"]["resets_at"].as_i64();
    kept["scoped"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|limit| {
            let name = limit["name"].as_str()?.to_lowercase();
            let own = limit["resets_at"].as_i64();
            if own.or(week).is_some_and(|reset| reset <= now) {
                return None;
            }
            let timed = own.zip(week).is_some_and(|(o, w)| o.abs_diff(w) > 60);
            let mut limit = limit.clone();
            limit["resets_at"] = json!(own.or(week));
            window(&name, &limit, now, timed)
        })
        .collect()
}

/// The percentage as a whole number, yellow from `warn`, red from `danger`.
// a percentage is within 0..=100 after round()
#[expect(clippy::cast_possible_truncation)]
fn painted(used: f64, warn: i64, danger: i64) -> String {
    let percent = used.round() as i64;
    let color = if percent >= danger {
        "\x1b[31m"
    } else if percent >= warn {
        "\x1b[33m"
    } else {
        return format!("{percent}%");
    };
    format!("{color}{percent}%\x1b[0m")
}

/// Grey for labels and times, so the eye lands on the numbers. A fixed grey
/// and not the dim attribute (SGR 2), which nearly vanishes on a light theme.
/// 243 is the step of the 256-color ramp that keeps about 4.5:1 contrast on
/// both a white and a black background.
pub fn dim(text: &str) -> String {
    format!("\x1b[38;5;243m{text}\x1b[0m")
}

/// The model in its family's color, with the effort level and the fast mode.
/// Both change in the middle of a session, and the line shows the current
/// ones.
pub fn model(event: &Value) -> Option<String> {
    let name = event["model"]["display_name"].as_str()?;
    let name = name.trim_start_matches("Claude ");
    let color = match name.split(' ').next() {
        Some("Opus") => "\x1b[1;35m",
        Some("Fable") => "\x1b[1;36m",
        Some("Sonnet") => "\x1b[1;34m",
        Some("Haiku") => "\x1b[1;32m",
        _ => "\x1b[1m",
    };
    let mut shown = format!("{color}{name}\x1b[0m");
    if let Some(level) = event["effort"]["level"].as_str() {
        // xhigh and max use up the limits faster: they stand out
        let level = match level {
            "xhigh" | "max" => format!("\x1b[1m{level}\x1b[0m"),
            "high" => level.to_owned(),
            _ => dim(level),
        };
        shown = format!("{shown} {level}");
    }
    if event["fast_mode"] == true {
        shown.push_str(" \x1b[36mfast\x1b[0m");
    }
    Some(shown)
}

/// Context fill: yellow from half (time to compact), red from three quarters
/// (a new session is the better choice).
pub fn context(event: &Value) -> Option<String> {
    let used = event["context_window"]["used_percentage"].as_f64()?;
    Some(format!("{} {}", dim("ctx"), painted(used, 50, 75)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(reset: i64, used: f64) -> Value {
        json!({"resets_at": reset, "used_percentage": used})
    }

    #[test]
    fn time_left_in_words() {
        assert_eq!(left(30), "1m");
        assert_eq!(left(59 * 60), "59m");
        assert_eq!(left(4 * 3600 + 5 * 60), "4h 5m");
        assert_eq!(left(71 * 3600 + 5 * 60), "2d 23h 5m");
    }

    #[test]
    fn line_words() {
        assert_eq!(
            window("5h", &at(1000, 10.4), 1000 - 3600, true).unwrap(),
            "\x1b[38;5;243m5h\x1b[0m 10%\x1b[38;5;243m ↻ 1h 0m\x1b[0m"
        );
        assert_eq!(
            window("week", &at(1000, 75.0), 0, true).unwrap(),
            "\x1b[38;5;243mweek\x1b[0m \x1b[33m75%\x1b[0m\x1b[38;5;243m ↻ 17m\x1b[0m"
        );
        assert_eq!(
            window("5h", &at(1000, 50.0), 1000, true).unwrap(),
            "\x1b[38;5;243m5h\x1b[0m 0%"
        );
        assert!(window("5h", &Value::Null, 0, true).is_none());
        let ctx = |p: f64| context(&json!({"context_window": {"used_percentage": p}}));
        assert_eq!(ctx(34.4).unwrap(), "\x1b[38;5;243mctx\x1b[0m 34%");
        assert_eq!(
            ctx(50.0).unwrap(),
            "\x1b[38;5;243mctx\x1b[0m \x1b[33m50%\x1b[0m"
        );
        assert_eq!(
            ctx(80.0).unwrap(),
            "\x1b[38;5;243mctx\x1b[0m \x1b[31m80%\x1b[0m"
        );
        assert!(context(&json!({})).is_none());
    }

    #[test]
    fn model_limit_names_its_own_time_only() {
        let line = |fable: Value| {
            scoped(
                &json!({"seven_day": at(1000, 26.0), "scoped": [fable]}),
                400,
            )
            .join(" ")
        };
        let grey = |text: &str| format!("\x1b[38;5;243m{text}\x1b[0m");
        // resets together with the week, or names no time of its own
        let with_week = format!("{} 64%", grey("fable"));
        assert_eq!(
            line(json!({"name": "Fable", "used_percentage": 64.0, "resets_at": 1030})),
            with_week
        );
        assert_eq!(
            line(json!({"name": "Fable", "used_percentage": 64.0, "resets_at": null})),
            with_week
        );
        // a time of its own
        assert_eq!(
            line(json!({"name": "Fable", "used_percentage": 95.0, "resets_at": 4000})),
            format!("{} \x1b[31m95%\x1b[0m{}", grey("fable"), grey(" ↻ 1h 0m"))
        );
    }

    #[test]
    fn model_limit_after_its_reset_waits_for_the_server() {
        // only the server knows a model's limit: 0% after the reset would be a guess
        let shown = |fable: Value, now: i64| {
            scoped(
                &json!({"seven_day": at(1000, 26.0), "scoped": [fable]}),
                now,
            )
        };
        // the week has reset
        let with_week = json!({"name": "Fable", "used_percentage": 64.0, "resets_at": null});
        assert_eq!(shown(with_week.clone(), 1000), Vec::<String>::new());
        assert_eq!(shown(with_week, 5000), Vec::<String>::new());
        // its own time has come, the week goes on
        let own = json!({"name": "Fable", "used_percentage": 64.0, "resets_at": 500});
        assert_eq!(shown(own, 600), Vec::<String>::new());
    }

    #[test]
    fn model_with_effort() {
        let event = json!({"model": {"display_name": "Opus 5.5"}, "effort": {"level": "xhigh"}});
        assert_eq!(
            model(&event).unwrap(),
            "\x1b[1;35mOpus 5.5\x1b[0m \x1b[1mxhigh\x1b[0m"
        );
        let fast = json!({"model": {"display_name": "Claude Fable 5.2"}, "fast_mode": true});
        assert_eq!(
            model(&fast).unwrap(),
            "\x1b[1;36mFable 5.2\x1b[0m \x1b[36mfast\x1b[0m"
        );
        assert!(model(&json!({})).is_none());
    }
}
