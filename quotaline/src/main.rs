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
//! - `asked_at`: when a session last looked for the login to ask the server;
//! - `spend`: the day's total for sessions billed by API key.

mod limits;
mod login;
mod render;
mod setup;
mod spend;

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

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

/// `value`, made an object if it is anything else, ready for writing into.
/// The store is a file anyone can edit, and writing a key into a member of
/// another type panics.
fn object(value: &mut Value) -> &mut Value {
    if !value.is_object() {
        *value = json!({});
    }
    value
}

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Mode {
    /// Print the status line: Claude Code runs the program this way.
    Line,
    Version,
    Help,
    /// Point Claude Code's settings at this program; `yes` writes without
    /// asking.
    Setup {
        yes: bool,
    },
}

const HELP: &str = "\
Shows Claude Code's context fill, subscription limits and the time until they
reset in its status line. Claude Code runs quotaline and passes the session's
data on stdin.

Usage:
  quotaline                 Print the status line (Claude Code runs this)
  quotaline --setup         Add quotaline to Claude Code's settings
  quotaline --setup --yes   The same, without asking first
  quotaline --version, -V   Print the version
  quotaline --help, -h      Print this help

Settings: ~/.claude/settings.json, or settings.json in $CLAUDE_CONFIG_DIR
when that's set.";

/// The mode the arguments ask for, or what is wrong with them.
fn mode(args: &[&str]) -> Result<Mode, String> {
    match args {
        [] => Ok(Mode::Line),
        ["--version" | "-V"] => Ok(Mode::Version),
        ["--help" | "-h"] => Ok(Mode::Help),
        ["--setup"] => Ok(Mode::Setup { yes: false }),
        ["--setup", "--yes"] | ["--yes", "--setup"] => Ok(Mode::Setup { yes: true }),
        ["--yes"] => Err("--yes works only with --setup".into()),
        _ => Err(
            match args
                .iter()
                .find(|arg| !["--version", "-V", "--help", "-h", "--setup", "--yes"].contains(arg))
            {
                Some(arg) => format!("unknown argument: {arg}"),
                None => format!("these arguments don't go together: {}", args.join(" ")),
            },
        ),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match mode(&args) {
        Ok(Mode::Line) => line(),
        Ok(Mode::Version) => println!("quotaline {}", env!("CARGO_PKG_VERSION")),
        Ok(Mode::Help) => println!("quotaline {}\n\n{HELP}", env!("CARGO_PKG_VERSION")),
        Ok(Mode::Setup { yes }) => return setup::run(yes),
        Err(problem) => {
            eprintln!("quotaline: {problem}\nRun 'quotaline --help' to see the options.");
            return ExitCode::from(2);
        }
    }
    ExitCode::SUCCESS
}

/// Reads the session's data from stdin and prints the line.
fn line() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_ask_for_one_mode() {
        assert_eq!(mode(&[]), Ok(Mode::Line));
        assert_eq!(mode(&["-V"]), Ok(Mode::Version));
        assert_eq!(mode(&["--help"]), Ok(Mode::Help));
        assert_eq!(mode(&["--setup"]), Ok(Mode::Setup { yes: false }));
        assert_eq!(mode(&["--yes", "--setup"]), Ok(Mode::Setup { yes: true }));
        assert_eq!(
            mode(&["--yes"]),
            Err("--yes works only with --setup".into())
        );
        assert_eq!(
            mode(&["--verbose"]),
            Err("unknown argument: --verbose".into())
        );
        assert_eq!(
            mode(&["--help", "--version"]),
            Err("these arguments don't go together: --help --version".into())
        );
    }
}
