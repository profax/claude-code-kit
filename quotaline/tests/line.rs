//! The program on a temporary home: a limit reset in the account settings
//! shows at once, and an idle session does not bring its old numbers back;
//! limits before a session's first response and a model's weekly limit come
//! from the subscription server. The server here is a stub on 127.0.0.1 and
//! the login is fake: no network is needed.

use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use jiff::{Timestamp, Zoned};
use serde_json::{Value, json};

/// A home and the address of the subscription server; without a stub the
/// address is dead.
struct Home(PathBuf, String);

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Home {
    fn new() -> Self {
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let n = COUNT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("statusline-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("home");
        Self(path, "http://127.0.0.1:9".into())
    }

    /// A home with a subscription login that expires in `expires` seconds
    /// and a stub server at `api`.
    fn signed_in(api: &str, expires: i64) -> Self {
        let mut home = Self::new();
        home.sign_in(expires);
        api.clone_into(&mut home.1);
        home
    }

    /// Puts a subscription login that expires in `expires` seconds where
    /// Claude Code keeps it.
    fn sign_in(&self, expires: i64) {
        fs::create_dir_all(self.path().join(".claude")).expect("login directory");
        fs::write(
            self.path().join(".claude/.credentials.json"),
            login("test-token", expires).to_string(),
        )
        .expect("login");
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// Where the program keeps its store in this home.
    fn store(&self) -> PathBuf {
        let cache = if cfg!(windows) {
            "AppData/Local"
        } else {
            ".cache"
        };
        self.path().join(cache).join("quotaline/limits.json")
    }

    /// Puts `kept` into the store before the program runs.
    fn keep(&self, kept: &Value) {
        let store = self.store();
        fs::create_dir_all(store.parent().expect("store directory")).expect("store directory");
        fs::write(store, kept.to_string()).expect("store");
    }

    /// The line without colors after a call with `event`.
    fn line(&self, event: &Value) -> String {
        self.line_with(event, &[])
    }

    /// The line without colors after a call with `event`, with `vars` set
    /// on top of this home's variables.
    fn line_with(&self, event: &Value, vars: &[(&str, &OsStr)]) -> String {
        let mut child = Command::new(env!("CARGO_BIN_EXE_quotaline"))
            .env("HOME", self.path())
            .env("USERPROFILE", self.path())
            .env("LOCALAPPDATA", self.path().join("AppData/Local"))
            .env("QUOTALINE_API", &self.1)
            .env_remove("XDG_CACHE_HOME")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env("no_proxy", "*")
            .env("NO_PROXY", "*")
            .envs(vars.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the program starts");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(event.to_string().as_bytes())
            .expect("stdin");
        let out = child.wait_with_output().expect("the program ends");
        assert!(out.status.success(), "{out:?}");
        plain(&String::from_utf8_lossy(&out.stdout))
    }
}

/// A subscription login with `token` that expires in `expires` seconds, as
/// Claude Code keeps it.
fn login(token: &str, expires: i64) -> Value {
    json!({"claudeAiOauth": {
        "accessToken": token,
        "expiresAt": (Timestamp::now().as_second() + expires) * 1000,
    }})
}

/// The text without color escape sequences.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c in chars.by_ref() {
                if c == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_owned()
}

/// A status line event: the session, how long it has waited for API
/// responses, and the percentage and reset of the five hours and the week.
fn limits(session: &str, api_ms: u64, five: (f64, i64), week: (f64, i64)) -> Value {
    json!({
        "session_id": session,
        "cost": {"total_api_duration_ms": api_ms},
        "rate_limits": {
            "five_hour": {"used_percentage": five.0, "resets_at": five.1},
            "seven_day": {"used_percentage": week.0, "resets_at": week.1},
        },
    })
}

fn event(session: &str, api_ms: u64, week: f64, week_reset: i64) -> Value {
    limits(
        session,
        api_ms,
        (1.0, week_reset - 86_400),
        (week, week_reset),
    )
}

/// The percentage of the window `name` in the line.
fn percent<'a>(line: &'a str, name: &str) -> &'a str {
    let label = format!("{name} ");
    let start = line.find(&label).expect("the line has the window") + label.len();
    line[start..].split(' ').next().unwrap_or("")
}

fn week(line: &str) -> &str {
    percent(line, "week")
}

#[test]
fn limit_reset_shows_at_once() {
    let home = Home::new();
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    // two sessions saw the week used up
    assert_eq!(week(&home.line(&event("a", 1000, 100.0, reset))), "100%");
    assert_eq!(week(&home.line(&event("b", 500, 100.0, reset))), "100%");
    // the limit was reset: session `a` got a new response, the window is the same
    assert_eq!(week(&home.line(&event("a", 2000, 1.0, reset))), "1%");
    // idle `b` keeps reporting its 100%: these are old numbers
    assert_eq!(week(&home.line(&event("b", 500, 100.0, reset))), "1%");
    // a new session after the reset: its first reading comes from an API response
    assert_eq!(week(&home.line(&event("c", 300, 3.0, reset))), "3%");
    assert_eq!(week(&home.line(&event("b", 500, 100.0, reset))), "3%");
}

#[test]
fn idle_session_does_not_bring_back_old_numbers() {
    let home = Home::new();
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    assert_eq!(week(&home.line(&event("b", 500, 72.0, reset))), "72%");
    // `a` works, the usage grows
    assert_eq!(week(&home.line(&event("a", 1000, 75.0, reset))), "75%");
    // `b` idles with its old 72%
    assert_eq!(week(&home.line(&event("b", 500, 72.0, reset))), "75%");
    // `a` has gone quiet too: its 75% stay
    assert_eq!(week(&home.line(&event("a", 1000, 75.0, reset))), "75%");
}

#[test]
fn idle_session_keeps_its_old_five_hours_to_itself() {
    // a reset started a new five-hour window while idle sessions still held
    // the previous one, which had not ended
    let home = Home::new();
    let now = Timestamp::now().as_second();
    let (old_five, new_five, week_reset) = (now + 1800, now + 5 * 3600, now + 3 * 86_400);
    home.line(&limits("a", 1000, (68.0, old_five), (99.0, week_reset)));
    home.line(&limits("b", 500, (70.0, old_five), (99.0, week_reset)));
    let line = home.line(&limits("b", 900, (8.0, new_five), (1.0, week_reset)));
    assert_eq!((percent(&line, "5h"), week(&line)), ("8%", "1%"));
    let line = home.line(&limits("a", 1000, (68.0, old_five), (99.0, week_reset)));
    assert_eq!((percent(&line, "5h"), week(&line)), ("8%", "1%"));
}

type Asked = Arc<Mutex<Vec<String>>>;

/// The subscription server: answers every request with `answer` and records
/// the request line with the login header.
fn usage_server(answer: &Value) -> (String, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port for the stub");
    let address = format!("http://{}", listener.local_addr().expect("address"));
    let asked = Asked::default();
    let seen = Arc::clone(&asked);
    let answer = answer.to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming().map_while(Result::ok) {
            let mut reader = BufReader::new(stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                let name = line.to_ascii_lowercase();
                if request.is_empty() || name.starts_with("authorization:") {
                    request.push_str(line.trim());
                    request.push(' ');
                }
            }
            seen.lock().expect("request log").push(request);
            let _ = write!(
                reader.get_mut(),
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{answer}",
                answer.len()
            );
        }
    });
    (address, asked)
}

/// The server's answer: the five hours, the week, and the weekly limits of
/// `models`.
fn usage(five: f64, week: f64, models: &[(&str, f64)]) -> Value {
    let at = |seconds: i64| {
        Timestamp::from_second(Timestamp::now().as_second() + seconds)
            .expect("time")
            .to_string()
    };
    let mut limits = vec![
        json!({"kind": "session", "group": "session", "percent": five}),
        json!({"kind": "weekly_all", "group": "weekly", "percent": week}),
    ];
    for (model, percent) in models {
        limits.push(
            json!({"kind": "weekly_scoped", "group": "weekly", "percent": percent,
            "scope": {"model": {"display_name": model}}}),
        );
    }
    json!({
        "five_hour": {"utilization": five, "resets_at": at(3 * 3600)},
        "seven_day": {"utilization": week, "resets_at": at(3 * 86_400)},
        "seven_day_opus": null,
        "limits": limits,
    })
}

/// A session before its first API response: its data has no limits yet.
fn fresh_session(session: &str) -> Value {
    json!({"session_id": session, "cost": {"total_api_duration_ms": 0}})
}

#[test]
fn new_session_shows_limits_before_its_first_answer() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[("Fable", 64.0)]));
    let home = Home::signed_in(&api, 3600);
    let line = home.line(&fresh_session("a"));
    assert_eq!(
        (percent(&line, "5h"), week(&line), percent(&line, "fable")),
        ("37%", "26%", "64%"),
        "{line}"
    );
    let asked = asked.lock().expect("request log");
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert!(asked[0].starts_with("GET /api/oauth/usage "), "{asked:?}");
    assert!(
        asked[0]
            .to_lowercase()
            .contains("authorization: bearer test-token")
    );
}

#[test]
fn subscription_without_model_limit_shows_none() {
    let (api, _) = usage_server(&usage(37.0, 26.0, &[]));
    let home = Home::signed_in(&api, 3600);
    let line = home.line(&fresh_session("a"));
    assert_eq!(
        (percent(&line, "5h"), week(&line)),
        ("37%", "26%"),
        "{line}"
    );
    assert!(!line.contains("fable"), "{line}");
}

#[test]
fn model_limit_gone_from_the_answer_leaves_the_line() {
    let (api, _) = usage_server(&usage(37.0, 26.0, &[]));
    let home = Home::signed_in(&api, 3600);
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    let kept = json!({"scoped": [{"name": "Fable", "used_percentage": 64.0, "resets_at": reset}]});
    home.keep(&kept);
    assert!(!home.line(&fresh_session("a")).contains("fable"));
}

#[test]
fn server_is_asked_once_in_five_minutes() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[("Fable", 64.0)]));
    let home = Home::signed_in(&api, 3600);
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    home.line(&fresh_session("a"));
    // a second new session and a working one: the numbers are already fresh
    let line = home.line(&fresh_session("b"));
    assert_eq!(percent(&line, "fable"), "64%", "{line}");
    let line = home.line(&event("a", 1000, 27.0, reset));
    assert_eq!(
        (week(&line), percent(&line, "fable")),
        ("27%", "64%"),
        "{line}"
    );
    assert_eq!(asked.lock().expect("request log").len(), 1);
}

#[test]
fn idle_session_does_not_ask_the_server() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[]));
    let home = Home::signed_in(&api, 3600);
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    let kept = json!({"sessions": {"a": {"api_ms": 1000, "rate_limits": event("a", 1000, 5.0, reset)["rate_limits"]}}});
    home.keep(&kept);
    home.line(&event("a", 1000, 5.0, reset));
    assert!(asked.lock().expect("request log").is_empty());
}

#[test]
fn expired_login_is_not_sent() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[]));
    let home = Home::signed_in(&api, -60);
    assert_eq!(home.line(&fresh_session("a")), "limits: no data");
    assert!(asked.lock().expect("request log").is_empty());
}

/// A home with a stub server at `api` whose only login is the default
/// profile's, `default-token`, in a stand-in for the macOS keychain: a
/// `security` program that knows only the default entry, first on the
/// returned PATH. The real keychain is never asked.
#[cfg(target_os = "macos")]
fn keychain_home(api: &str) -> (Home, std::ffi::OsString) {
    use std::os::unix::fs::PermissionsExt as _;
    let mut home = Home::new();
    api.clone_into(&mut home.1);
    fs::create_dir_all(home.path().join("Library/Keychains")).expect("keychain folder");
    let bin = home.path().join("bin");
    fs::create_dir_all(&bin).expect("bin folder");
    let security = bin.join("security");
    fs::write(
        &security,
        format!(
            "#!/bin/sh\n\
             [ \"$*\" = 'find-generic-password -s Claude Code-credentials -w' ] || exit 44\n\
             echo '{}'\n",
            login("default-token", 3600)
        ),
    )
    .expect("security");
    fs::set_permissions(&security, fs::Permissions::from_mode(0o755)).expect("security");
    let mut path = bin.into_os_string();
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap_or_default());
    (home, path)
}

#[cfg(target_os = "macos")]
#[test]
fn another_profile_never_takes_the_default_keychain_login() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[]));
    // the default profile: its login is in the keychain
    let (home, path) = keychain_home(&api);
    let line = home.line_with(&fresh_session("a"), &[("PATH", &path)]);
    assert_eq!(percent(&line, "5h"), "37%", "{line}");
    // a profile of its own: Claude Code keeps its login under another
    // keychain entry, and the default one belongs to another login
    let (home, path) = keychain_home(&api);
    let profile = home.path().join("profile");
    fs::create_dir_all(&profile).expect("profile folder");
    let vars = [
        ("PATH", path.as_os_str()),
        ("CLAUDE_CONFIG_DIR", profile.as_os_str()),
    ];
    assert_eq!(
        home.line_with(&fresh_session("a"), &vars),
        "limits: no data"
    );
    // the profile's own login file is the one that counts
    let (home, path) = keychain_home(&api);
    let profile = home.path().join("profile");
    fs::create_dir_all(&profile).expect("profile folder");
    let file = login("profile-token", 3600).to_string();
    fs::write(profile.join(".credentials.json"), file).expect("login");
    let vars = [
        ("PATH", path.as_os_str()),
        ("CLAUDE_CONFIG_DIR", profile.as_os_str()),
    ];
    let line = home.line_with(&fresh_session("a"), &vars);
    assert_eq!(percent(&line, "5h"), "37%", "{line}");
    let asked = asked.lock().expect("request log");
    let sent: Vec<bool> = asked
        .iter()
        .map(|request| request.to_lowercase().contains("bearer profile-token"))
        .collect();
    assert_eq!(sent, [false, true], "{asked:?}");
}

#[test]
fn login_is_looked_for_once_in_five_minutes() {
    // looking for the login starts a program on macOS: a session without
    // one must not do it on every refresh
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[]));
    let home = Home::signed_in(&api, -60);
    home.line(&fresh_session("a"));
    home.sign_in(3600);
    home.line(&fresh_session("b"));
    assert!(asked.lock().expect("request log").is_empty());
}

#[test]
fn server_is_not_asked_when_the_store_cannot_remember_it() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[]));
    // no store directory: a file stands where it would go
    let home = Home::signed_in(&api, 3600);
    let dir = home.store().parent().expect("store directory").to_owned();
    fs::create_dir_all(dir.parent().expect("cache")).expect("cache");
    fs::write(&dir, "").expect("a file in the way");
    home.line(&fresh_session("a"));
    home.line(&fresh_session("b"));
    // no lock: a directory stands where it would go
    let home = Home::signed_in(&api, 3600);
    let dir = home.store().parent().expect("store directory").to_owned();
    fs::create_dir_all(dir.join("limits.lock")).expect("a directory in the way");
    home.line(&fresh_session("a"));
    home.line(&fresh_session("b"));
    let asked = asked.lock().expect("request log");
    assert!(asked.is_empty(), "{asked:?}");
}

#[test]
fn model_limit_leaves_the_line_when_the_server_fails_for_an_hour() {
    let now = Timestamp::now().as_second();
    let reset = now + 3 * 86_400;
    // the store as a good answer left it `answered` seconds ago; the last
    // attempt to ask was five minutes ago
    let kept = |answered: i64| {
        json!({
            "seven_day": {"used_percentage": 26.0, "resets_at": reset},
            "scoped": [{"name": "Fable", "used_percentage": 64.0, "resets_at": reset}],
            "asked_at": now - 301,
            "answered_at": now - answered,
            "sessions": {"idle": {"api_ms": 1000,
                "rate_limits": event("idle", 1000, 26.0, reset)["rate_limits"]}},
        })
    };
    let dead = "http://127.0.0.1:9";
    // the server fails over an hour after its last good answer
    let home = Home::signed_in(dead, 3600);
    home.keep(&kept(3700));
    let line = home.line(&fresh_session("a"));
    assert!(!line.contains("fable"), "{line}");
    // within the hour the last answer still stands
    let home = Home::signed_in(dead, 3600);
    home.keep(&kept(1000));
    assert_eq!(percent(&home.line(&fresh_session("a")), "fable"), "64%");
    // an idle session asks nobody: nothing has failed
    let home = Home::signed_in(dead, 3600);
    home.keep(&kept(8000));
    let line = home.line(&event("idle", 1000, 26.0, reset));
    assert_eq!(percent(&line, "fable"), "64%", "{line}");
    // without a login nothing is asked either
    let home = Home::new();
    home.keep(&kept(8000));
    assert_eq!(percent(&home.line(&fresh_session("a")), "fable"), "64%");
    // a good answer is remembered
    let (api, _) = usage_server(&usage(37.0, 26.0, &[("Fable", 64.0)]));
    let home = Home::signed_in(&api, 3600);
    home.keep(&kept(8000));
    home.line(&fresh_session("a"));
    let stored: Value =
        serde_json::from_str(&fs::read_to_string(home.store()).expect("store")).expect("JSON");
    assert_eq!(stored["answered_at"], stored["asked_at"], "{stored}");
    assert!(stored["asked_at"].as_i64() >= Some(now), "{stored}");
}

#[test]
fn without_login_the_line_shows_what_the_session_gave() {
    let (api, asked) = usage_server(&usage(37.0, 26.0, &[("Fable", 64.0)]));
    let mut home = Home::new();
    home.1 = api;
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    let line = home.line(&event("a", 1000, 5.0, reset));
    assert_eq!(week(&line), "5%", "{line}");
    assert!(!line.contains("fable"), "{line}");
    assert!(asked.lock().expect("request log").is_empty());
}

/// A session billed by API key: it got a response that cost `usd`, and its
/// data has no subscription limits.
fn paid_session(session: &str, usd: f64) -> Value {
    json!({
        "session_id": session,
        "cost": {"total_api_duration_ms": 1000, "total_cost_usd": usd},
        "model": {"display_name": "Opus 5.5"},
    })
}

#[test]
fn api_key_session_shows_what_it_spent() {
    let home = Home::new();
    assert_eq!(home.line(&paid_session("a", 1.238)), "$1.24 · Opus 5.5");
    assert_eq!(home.line(&paid_session("a", 12.4)), "$12.40 · Opus 5.5");
    // a new session has spent nothing before its first response: only the day shows
    assert_eq!(
        home.line(&paid_session("b", 0.0)),
        "today $12.40 · Opus 5.5"
    );
}

#[test]
fn day_total_adds_up_sessions() {
    let home = Home::new();
    // one session in the day: the day's total would repeat its cost
    assert_eq!(home.line(&paid_session("a", 1.238)), "$1.24 · Opus 5.5");
    assert_eq!(
        home.line(&paid_session("b", 2.0)),
        "$2.00 · today $3.24 · Opus 5.5"
    );
    assert_eq!(
        home.line(&paid_session("a", 1.5)),
        "$1.50 · today $3.50 · Opus 5.5"
    );
    // the program is also called with no new responses: nothing counts twice
    assert_eq!(
        home.line(&paid_session("a", 1.5)),
        "$1.50 · today $3.50 · Opus 5.5"
    );
    assert_eq!(
        home.line(&paid_session("b", 2.0)),
        "$2.00 · today $3.50 · Opus 5.5"
    );
}

#[test]
fn session_over_midnight_counts_only_what_it_added_today() {
    let home = Home::new();
    // the day is the machine's local one
    let today = Zoned::now().date();
    let yesterday = today.yesterday().expect("date").to_string();
    let seen = Timestamp::now().as_second() - 86_400;
    let kept = json!({"spend": {"day": yesterday, "total": 5.0,
        "sessions": {"a": {"cost": 5.0, "seen": seen}}}});
    home.keep(&kept);
    // no responses since midnight
    assert_eq!(home.line(&paid_session("a", 5.0)), "$5.00 · Opus 5.5");
    assert_eq!(
        home.line(&paid_session("a", 6.0)),
        "$6.00 · today $1.00 · Opus 5.5"
    );
}

#[test]
fn session_counted_from_zero_again_adds_all_of_it() {
    // Claude Code started counting the session from zero: the earlier 5 dollars stay in the day
    let home = Home::new();
    home.line(&paid_session("a", 5.0));
    assert_eq!(
        home.line(&paid_session("a", 0.5)),
        "$0.50 · today $5.50 · Opus 5.5"
    );
}

#[test]
fn subscription_session_adds_nothing_to_the_day() {
    let home = Home::new();
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    let mut session = event("a", 1000, 5.0, reset);
    session["cost"]["total_cost_usd"] = json!(7.5);
    home.line(&session);
    // the same session without limits in its data: the day leaves out the cost nobody pays
    session
        .as_object_mut()
        .expect("event")
        .remove("rate_limits");
    assert!(!home.line(&session).contains("today"));
    let line = home.line(&paid_session("b", 1.0));
    assert!(line.starts_with("$1.00 · 5h"), "{line}");
    assert!(!line.contains("today"), "{line}");
}

#[test]
fn subscription_session_shows_no_money() {
    // Claude Code counts a cost for subscription sessions too: nobody pays it
    let home = Home::new();
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    let mut session = event("a", 1000, 5.0, reset);
    session["cost"]["total_cost_usd"] = json!(7.5);
    let line = home.line(&session);
    assert_eq!(week(&line), "5%", "{line}");
    assert!(!line.contains('$'), "{line}");
}

#[test]
fn store_of_any_shape_still_gives_a_line() {
    // the store is a file anyone can edit: its members can be of any type
    let stores = [
        json!({"sessions": 5, "spend": "x", "five_hour": [], "seven_day": 7,
               "scoped": {"a": 1}, "asked_at": "x"}),
        json!({"sessions": [1], "spend": {"sessions": "x", "total": "x", "day": 3},
               "scoped": [1, "x", {"name": 5}], "five_hour": {"used_percentage": "x"},
               "asked_at": 1.5}),
        json!({"sessions": {"a": 5, "b": [1]}, "spend": {"sessions": [], "day": []},
               "seven_day": {"used_percentage": 50, "resets_at": "x"}}),
        json!({"sessions": "x", "spend": 5}),
        json!({"sessions": null, "spend": [1]}),
    ];
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    for kept in stores {
        let home = Home::new();
        home.keep(&kept);
        let line = home.line(&event("a", 1000, 5.0, reset));
        assert_eq!(week(&line), "5%", "{kept} {line}");
        let home = Home::new();
        home.keep(&kept);
        let line = home.line(&paid_session("new", 1.238));
        assert!(line.starts_with("$1.24 · "), "{kept} {line}");
        assert!(line.ends_with("Opus 5.5"), "{kept} {line}");
    }
}

#[test]
fn extreme_times_still_give_a_line() {
    let reset = Timestamp::now().as_second() + 3 * 86_400;
    for (asked, own, week_reset) in [
        (i64::MIN, i64::MIN, i64::MAX),
        (i64::MAX, i64::MAX, i64::MIN),
        (i64::MIN, i64::MIN, 0),
        (-1, i64::MAX, -1),
    ] {
        let home = Home::new();
        home.keep(&json!({
            "asked_at": asked,
            "seven_day": {"used_percentage": 5.0, "resets_at": week_reset},
            "scoped": [{"name": "Fable", "used_percentage": 64.0, "resets_at": own}],
        }));
        let line = home.line(&fresh_session("a"));
        assert!(!line.contains('-'), "{line}");
        let line = home.line(&event("b", 1000, 5.0, reset));
        assert_eq!(week(&line), "5%", "{line}");
        for at in [i64::MAX, i64::MIN] {
            let line = home.line(&limits("c", 1000, (1.0, at), (5.0, at)));
            assert!(!line.contains('-'), "{line}");
        }
    }
}

#[test]
fn window_that_has_reset_shows_zero_for_one_length_of_it() {
    // nobody has used the subscription since: a user who has left it would
    // see 0% in every session for as long as the store lives
    let now = Timestamp::now().as_second();
    let kept = |ago: i64| {
        json!({
            "five_hour": {"used_percentage": 40.0, "resets_at": now - 5 * 3600 - ago},
            "seven_day": {"used_percentage": 50.0, "resets_at": now - 7 * 86_400 - ago},
        })
    };
    let home = Home::new();
    home.keep(&kept(-60));
    assert_eq!(
        home.line(&paid_session("a", 1.238)),
        "$1.24 · 5h 0% · week 0% · Opus 5.5"
    );
    let home = Home::new();
    home.keep(&kept(60));
    assert_eq!(home.line(&paid_session("a", 1.238)), "$1.24 · Opus 5.5");
}

#[test]
fn failed_store_write_leaves_no_file_behind() {
    // a directory where the store goes: the new store is written, but
    // can't take its place
    let home = Home::new();
    fs::create_dir_all(home.store().join("in the way")).expect("a directory in the way");
    assert_eq!(home.line(&paid_session("a", 1.238)), "$1.24 · Opus 5.5");
    let left: Vec<String> = fs::read_dir(home.store().parent().expect("store directory"))
        .expect("store directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.starts_with("limits.json."))
        .collect();
    assert_eq!(left, Vec::<String>::new());
}

#[test]
fn sessions_calling_at_once_lose_nothing() {
    let home = Home::new();
    std::thread::scope(|scope| {
        for n in 0..12 {
            let home = &home;
            scope.spawn(move || home.line(&paid_session(&format!("s{n}"), 1.0)));
        }
    });
    assert_eq!(
        home.line(&paid_session("new", 0.0)),
        "today $12.00 · Opus 5.5"
    );
}
