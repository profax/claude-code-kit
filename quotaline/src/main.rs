//! Status line for Claude Code: context fill, subscription limits with the
//! time left until each resets, weekly limits of single models, and the model
//! with its effort level. Claude Code runs the program on a timer and after
//! every reply (`statusLine` in its settings), passes the session's data as
//! JSON on stdin, and shows what the program prints.
//!
//! All sessions on the machine share one store, `limits.json`, so an idle
//! session shows the numbers a busy one has just received:
//! - `five_hour`, `seven_day`: the freshest windows, in the shape Claude Code
//!   reports them (`used_percentage`, `resets_at` in epoch seconds);
//! - `scoped`: weekly limits of single models, from the subscription server;
//! - `sessions`: the last reading of each session, to tell fresh from stale;
//! - `asked_at`: when the server was last asked;
//! - `spend`: the day's total for sessions billed by API key.

mod limits;
mod login;
mod render;
mod spend;

use std::fs;
use std::path::PathBuf;

use jiff::{Timestamp, Zoned};
use serde_json::{Value, json};

/// Directory of the store: the user's cache directory, or `None` when the
/// system names neither it nor a home. The line then shows only what the
/// session itself reports.
fn store_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| Some(std::env::home_dir()?.join("AppData").join("Local")));
    // a relative XDG path is invalid and ignored, as the XDG spec asks
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| Some(std::env::home_dir()?.join(".cache")));
    Some(base?.join("quotaline"))
}

fn main() {
    let event: Value = serde_json::from_reader(std::io::stdin().lock()).unwrap_or_default();
    let dir = store_dir().filter(|dir| fs::create_dir_all(dir).is_ok());
    // Sessions call the program at the same moment: without the lock one
    // would overwrite what another has just added. The lock lasts until the
    // process exits.
    let lock = dir
        .as_ref()
        .and_then(|dir| fs::File::create(dir.join("limits.lock")).ok());
    if let Some(lock) = &lock {
        let _ = lock.lock();
    }
    let path = dir.as_ref().map(|dir| dir.join("limits.json"));
    let mut kept: Value = path
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let now = Timestamp::now().as_second();
    let before = kept.clone();
    let has_limits = limits::update(&mut kept, &event, now);
    // No subscription limits in the data of a session the store has never
    // seen with them: the session is billed by API key
    let paid = !has_limits
        && kept["sessions"]
            .get(event["session_id"].as_str().unwrap_or(""))
            .is_none();
    if paid {
        let day = Zoned::now().date().to_string();
        spend::tally(&mut kept, &event, &day, now);
    }
    if kept != before
        && let (Some(dir), Some(path)) = (&dir, &path)
    {
        // through a rename: another session never reads half a file
        let tmp = dir.join(format!("limits.json.{}", std::process::id()));
        let _ = fs::write(&tmp, kept.to_string()).and_then(|()| fs::rename(&tmp, path));
    }
    let money = if paid {
        spend::shown(&kept, &event)
    } else {
        vec![]
    };
    let parts: Vec<String> = render::context(&event)
        .into_iter()
        .chain(money)
        .chain(
            limits::WINDOWS
                .iter()
                .filter_map(|(window, name)| render::window(name, &kept[*window], now, true)),
        )
        .chain(render::scoped(&kept, now))
        .chain(render::model(&event))
        .collect();
    if parts.is_empty() {
        println!("limits: no data");
    } else {
        println!("{}", parts.join(&render::dim(" · ")));
    }
}
