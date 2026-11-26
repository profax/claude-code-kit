//! `--setup`: points Claude Code's `statusLine` at this program. `decide`
//! settles what to do with the settings and the command apart from the disk;
//! `run` finds both, asks, and writes.
//!
//! The file is the user's: a status line that isn't quotaline stays, a file
//! that isn't a JSON object stays, and a write keeps the other keys in their
//! order and leaves a copy of the previous file next to it.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, BufRead as _, IsTerminal as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jiff::Timestamp;
use serde_json::{Value, json};

use crate::login;

/// Seconds between runs while a session is idle: limits reset and other
/// sessions bring fresh numbers whether or not this one gets replies.
const REFRESH: u64 = 60;

/// What `--setup` does with the settings.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// The status line already runs this command.
    Done,
    /// Write `settings` in full. `replaced` is the command of a quotaline in
    /// another place that this one takes over from, `None` for a new status
    /// line.
    Write {
        settings: Value,
        replaced: Option<String>,
    },
    /// Another program's status line, shown and left alone.
    Foreign(Value),
    /// The file holds something other than a JSON object.
    NotObject,
}

/// The status line that runs `command`.
fn status_line(command: &str) -> Value {
    json!({"type": "command", "command": command, "refreshInterval": REFRESH})
}

/// What to do with the settings file's `text` (`None` when there is no file)
/// to make the status line run `command`. Only the command changes in a
/// quotaline status line from another place: the other fields are the
/// user's choice.
pub fn decide(text: Option<&str>, command: &str) -> Plan {
    let mut settings = match text.map(serde_json::from_str::<Value>) {
        None => json!({}),
        Some(Ok(settings)) if settings.is_object() => settings,
        Some(_) => return Plan::NotObject,
    };
    let current = &settings["statusLine"];
    if current.is_null() {
        settings["statusLine"] = status_line(command);
        return Plan::Write {
            settings,
            replaced: None,
        };
    }
    let ran = current["command"]
        .as_str()
        .filter(|_| current["type"] == "command");
    match ran {
        Some(ran) if ran == command => Plan::Done,
        Some(ran) if runs_quotaline(ran) => {
            let replaced = Some(ran.to_owned());
            settings["statusLine"]["command"] = json!(command);
            Plan::Write { settings, replaced }
        }
        _ => Plan::Foreign(current.clone()),
    }
}

/// Whether `command` is just a quotaline program, quoted or not, wherever it
/// lies. A command with anything after the program (arguments, a pipe, a
/// redirect) is the user's own wrapper and counts as another status line.
fn runs_quotaline(command: &str) -> bool {
    let mut word = String::new();
    let mut chars = command.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => word.extend(chars.by_ref().take_while(|&q| q != c)),
            // a backslash escapes only quotes and spaces: elsewhere it is
            // a Windows path separator
            '\\' => match chars.clone().next() {
                Some(next @ ('\'' | '"' | ' ' | '\\')) => {
                    word.push(next);
                    chars.next();
                }
                _ => word.push(c),
            },
            c if c.is_whitespace() => return false,
            c => word.push(c),
        }
    }
    let name = word.rsplit(['/', '\\']).next().unwrap_or("");
    name.eq_ignore_ascii_case("quotaline") || name.eq_ignore_ascii_case("quotaline.exe")
}

/// The command that runs the program at `exe` from Claude Code, or `None`
/// when no command can. On Unix the shell is `sh`, and single quotes take any
/// path. On Windows the shell is Git Bash when it is installed and PowerShell
/// otherwise, and no quoting works in both: a path either needs none, with
/// forward slashes that both read, or the program goes by its bare name,
/// which works only when `on_path` (PATH finds this very program).
fn command(exe: &str, on_path: bool, windows: bool) -> Option<String> {
    if !windows {
        let plain = |c: char| c.is_ascii_alphanumeric() || "/._-+,:@%=".contains(c);
        if exe.chars().all(plain) {
            return Some(exe.to_owned());
        }
        return Some(format!("'{}'", exe.replace('\'', r"'\''")));
    }
    let plain = |text: &str| {
        text.chars()
            .all(|c| c.is_alphanumeric() || "/._-:+~".contains(c))
    };
    let exe = exe.replace('\\', "/");
    if plain(&exe) {
        return Some(exe);
    }
    let name = exe.rsplit('/').next().unwrap_or("");
    let bare = name
        .len()
        .checked_sub(4)
        .filter(|&end| name.is_char_boundary(end) && name[end..].eq_ignore_ascii_case(".exe"))
        .map_or(name, |end| &name[..end]);
    (on_path && !bare.is_empty() && plain(bare)).then(|| bare.to_owned())
}

/// The first file named `name` in a PATH directory, as a shell finds it. On
/// Windows the name is also tried with `.exe`.
fn find_on_path(name: &OsStr) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    std::env::split_paths(&dirs)
        .filter(|dir| dir.is_absolute())
        .find_map(|dir| {
            let path = dir.join(name);
            let mut exe = path.clone().into_os_string();
            exe.push(".exe");
            let exe = PathBuf::from(exe);
            if path.is_file() {
                Some(path)
            } else if cfg!(windows) && exe.is_file() {
                Some(exe)
            } else {
                None
            }
        })
}

fn same_file(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .is_some_and(|(a, b)| a == b)
}

/// The path the program was started by. A link stays a link: package
/// managers point a fixed link at a versioned directory, and a command that
/// names that directory breaks with the next upgrade. `current_exe` follows
/// links on Linux, so the path comes from how the program was started, and
/// `current_exe` only confirms it.
fn program() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let started = std::env::args_os()
        .next()
        .map(PathBuf::from)
        .and_then(|arg| {
            if arg.components().count() > 1 {
                std::path::absolute(&arg).ok()
            } else {
                find_on_path(arg.as_os_str())
            }
        });
    Ok(started.filter(|path| same_file(path, &exe)).unwrap_or(exe))
}

/// The settings snippet as it reads inside the file.
fn snippet(status_line: &Value) -> String {
    let body = serde_json::to_string_pretty(status_line).unwrap_or_default();
    format!("  \"statusLine\": {}", body.replace('\n', "\n  "))
}

/// Asks `question`; `yes` answers it in advance.
fn confirm(question: &str, yes: bool) -> Result<(), String> {
    if yes {
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        return Err("Input isn't a terminal, so quotaline can't ask. \
                    Run 'quotaline --setup --yes' to write without asking."
            .into());
    }
    print!("{question} [y/N] ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    let _ = io::stdin().lock().read_line(&mut answer);
    let answer = answer.trim();
    if answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes") {
        Ok(())
    } else {
        Err("Nothing changed.".into())
    }
}

/// A new file at `path` that no one else can open first, with the
/// permissions of the file it stands in for: settings can hold keys.
fn create(path: &Path, like: Option<&Permissions>) -> io::Result<File> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    #[cfg(unix)]
    if let Some(like) = like {
        file.set_permissions(like.clone())?;
    }
    #[cfg(not(unix))]
    let _ = like;
    Ok(file)
}

/// Saves `text`, the previous settings, next to `path` under a name with
/// the UTC time, which Windows also takes.
fn back_up(path: &Path, text: &str, like: Option<&Permissions>) -> io::Result<PathBuf> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let stamp = Timestamp::now().strftime("%Y%m%dT%H%M%SZ");
    for n in 1..100 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let backup = path.with_file_name(format!("{name}.{stamp}{suffix}.bak"));
        match create(&backup, like) {
            Ok(mut file) => {
                file.write_all(text.as_bytes())?;
                return Ok(backup);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many backups this second",
    ))
}

/// Writes `settings` to `path`, through it when it is a link (dotfile
/// managers keep the real file elsewhere), and returns the copy of
/// `previous`. The file is replaced by a rename, so Claude Code never reads
/// half of it.
fn write(path: &Path, previous: Option<&str>, settings: &Value) -> io::Result<Option<PathBuf>> {
    let target = if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        fs::canonicalize(path)?
    } else {
        path.to_owned()
    };
    let dir = target.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let like = match previous {
        Some(_) => Some(fs::metadata(&target)?.permissions()),
        None => None,
    };
    let backup = previous
        .map(|text| back_up(path, text, like.as_ref()))
        .transpose()?;
    let mut text = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    text.push('\n');
    let tmp = dir.join(format!(".settings.json.{}.tmp", std::process::id()));
    let written = create(&tmp, like.as_ref()).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map(|()| backup)
}

/// Runs `--setup`; `yes` writes without asking. Every refusal and failure
/// ends the same way for the caller: a message and exit code 1.
pub fn run(yes: bool) -> ExitCode {
    match setup(yes) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn setup(yes: bool) -> Result<(), String> {
    let path = login::config_dir()
        .ok_or("Can't find your home directory. Set CLAUDE_CONFIG_DIR to Claude Code's settings directory and run again.")?
        .join("settings.json");
    let shown = path.display();
    let exe = program().map_err(|e| format!("Can't find where quotaline is: {e}"))?;
    let exe_text = exe.to_str().ok_or_else(|| {
        format!(
            "The path to quotaline isn't valid Unicode, so settings.json can't hold it: {}",
            exe.display()
        )
    })?;
    let name = if cfg!(windows) {
        exe.file_stem()
    } else {
        exe.file_name()
    };
    let on_path = name
        .and_then(find_on_path)
        .is_some_and(|found| same_file(&found, &exe));
    let command = command(exe_text, on_path, cfg!(windows)).ok_or_else(|| {
        format!(
            "Neither Git Bash nor PowerShell can run quotaline from its path as written:\n  {}\n\
             Move quotaline to a folder on your PATH, or to a path without spaces or \
             special characters, and run 'quotaline --setup' again.",
            exe_text.replace('\\', "/")
        )
    })?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Can't read {shown}: {e}")),
    };
    let wanted = snippet(&status_line(&command));
    let (settings, replaced) = match decide(text.as_deref(), &command) {
        Plan::Done => {
            println!("Already set up: {shown} runs {command} as the status line.");
            return Ok(());
        }
        Plan::NotObject => {
            return Err(format!(
                "{shown} isn't a JSON object, so quotaline left it alone. \
                 Fix the file, or add this to it by hand:\n\n{wanted}"
            ));
        }
        Plan::Foreign(current) => {
            return Err(format!(
                "{shown} already has a status line that isn't quotaline, so quotaline left it alone. \
                 It's now:\n\n{}\n\nTo use quotaline instead, replace it with:\n\n{wanted}",
                snippet(&current)
            ));
        }
        Plan::Write { settings, replaced } => (settings, replaced),
    };
    let done = match (&replaced, &text) {
        (Some(old), _) => {
            println!(
                "The status line in {shown} runs quotaline from another place.\n  \
                 now:   {old}\n  after: {command}\nThe other statusLine fields stay as they are."
            );
            confirm("Update the command?", yes)?;
            format!("Updated the status line command in {shown}.")
        }
        (None, Some(_)) => {
            println!("quotaline will add this to {shown}:\n\n{wanted}\n");
            confirm("Write it?", yes)?;
            format!("Added the status line to {shown}.")
        }
        (None, None) => {
            println!("quotaline will create {shown} with:\n\n{wanted}\n");
            confirm("Write it?", yes)?;
            format!("Created {shown} with the status line.")
        }
    };
    let backup = write(&path, text.as_deref(), &settings)
        .map_err(|e| format!("Can't write {shown}: {e}"))?;
    println!("{done}");
    if let Some(backup) = backup {
        println!("The previous file is saved as {}", backup.display());
    }
    println!(
        "Claude Code reloads its settings on its own: open sessions show the line without a restart."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "/home/user/.local/bin/quotaline";

    fn written(plan: Plan) -> (Value, Option<String>) {
        match plan {
            Plan::Write { settings, replaced } => (settings, replaced),
            other => panic!("not a write: {other:?}"),
        }
    }

    #[test]
    fn no_file_gets_one_with_the_status_line() {
        let (settings, replaced) = written(decide(None, ME));
        assert_eq!(settings, json!({"statusLine": status_line(ME)}));
        assert_eq!(replaced, None);
    }

    #[test]
    fn status_line_goes_after_the_other_keys() {
        let text = r#"{"model": "opus", "env": {"B": "1", "A": "2"}}"#;
        let (settings, _) = written(decide(Some(text), ME));
        let keys: Vec<&String> = settings.as_object().expect("object").keys().collect();
        assert_eq!(keys, ["model", "env", "statusLine"]);
        let env: Vec<&String> = settings["env"].as_object().expect("env").keys().collect();
        assert_eq!(env, ["B", "A"]);
        let (settings, _) = written(decide(Some("{}"), ME));
        assert_eq!(settings, json!({"statusLine": status_line(ME)}));
    }

    #[test]
    fn own_status_line_is_left_as_it_is() {
        let text = json!({"statusLine": {"type": "command", "command": ME, "padding": 1}});
        assert_eq!(decide(Some(&text.to_string()), ME), Plan::Done);
    }

    #[test]
    fn quotaline_from_another_place_changes_only_its_command() {
        for old in [
            "/opt/old/quotaline",
            "~/.cargo/bin/quotaline",
            "'/Users/John Smith/bin/quotaline'",
            "C:\\Tools\\Quotaline.exe",
            "quotaline",
        ] {
            let text = json!({"statusLine": {"type": "command", "command": old, "padding": 2}});
            let (settings, replaced) = written(decide(Some(&text.to_string()), ME));
            assert_eq!(
                settings,
                json!({"statusLine": {"type": "command", "command": ME, "padding": 2}}),
                "{old}"
            );
            assert_eq!(replaced.as_deref(), Some(old));
        }
    }

    #[test]
    fn other_status_line_is_left_alone() {
        for current in [
            json!({"type": "command", "command": "~/.claude/statusline.sh"}),
            json!({"type": "command", "command": "quotaline | head -1"}),
            json!({"type": "command", "command": "/bin/quotaline-fork"}),
            json!("quotaline"),
        ] {
            let text = json!({"statusLine": current});
            assert_eq!(
                decide(Some(&text.to_string()), ME),
                Plan::Foreign(current.clone())
            );
        }
    }

    #[test]
    fn file_that_is_no_json_object_is_left_alone() {
        for text in ["", "not json", "[1, 2]", "{\"a\": 1,}", "null"] {
            assert_eq!(decide(Some(text), ME), Plan::NotObject, "{text:?}");
        }
    }

    #[test]
    fn unix_path_is_quoted_only_when_the_shell_needs_it() {
        assert_eq!(command(ME, false, false).as_deref(), Some(ME));
        assert_eq!(
            command("/Users/John Smith/bin/quotaline", false, false).as_deref(),
            Some("'/Users/John Smith/bin/quotaline'")
        );
        assert_eq!(
            command("/home/o'brien/$bin/quotaline", false, false).as_deref(),
            Some(r"'/home/o'\''brien/$bin/quotaline'")
        );
    }

    #[test]
    fn windows_path_takes_forward_slashes() {
        assert_eq!(
            command(r"C:\Users\john\.cargo\bin\quotaline.exe", false, true).as_deref(),
            Some("C:/Users/john/.cargo/bin/quotaline.exe")
        );
    }

    #[test]
    fn windows_path_with_a_space_needs_path() {
        let exe = r"C:\Users\John Smith\.cargo\bin\quotaline.exe";
        assert_eq!(command(exe, true, true).as_deref(), Some("quotaline"));
        assert_eq!(command(exe, false, true), None);
        assert_eq!(
            command(r"C:\Program Files (x86)\q\QUOTALINE.EXE", true, true).as_deref(),
            Some("QUOTALINE")
        );
    }

    #[test]
    fn snippet_reads_as_in_the_file() {
        assert_eq!(
            snippet(&status_line(ME)),
            format!(
                "  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": \"{ME}\",\n    \
                 \"refreshInterval\": 60\n  }}"
            )
        );
    }
}
