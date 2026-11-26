//! The program's command line: the version, the help, arguments it does not
//! know, and `--setup` on a temporary home. The settings file in the real
//! home is never touched: every run gets `HOME`, `USERPROFILE` and
//! `CLAUDE_CONFIG_DIR` of its own.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_quotaline"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("the program runs")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn version_names_the_package_version() {
    for flag in ["--version", "-V"] {
        let out = run(&[flag]);
        assert!(out.status.success(), "{out:?}");
        assert_eq!(
            text(&out.stdout),
            format!("quotaline {}\n", env!("CARGO_PKG_VERSION"))
        );
    }
}

#[test]
fn help_lists_the_options() {
    for flag in ["--help", "-h"] {
        let out = run(&[flag]);
        assert!(out.status.success(), "{out:?}");
        let help = text(&out.stdout);
        for word in ["--version", "--help", "settings.json"] {
            assert!(help.contains(word), "{help}");
        }
    }
}

#[test]
fn unknown_argument_fails_with_code_2() {
    for args in [&["--verbose"][..], &["status"], &["--help", "--version"]] {
        let out = run(args);
        assert_eq!(out.status.code(), Some(2), "{out:?}");
        assert!(out.stdout.is_empty(), "{out:?}");
        assert!(text(&out.stderr).contains("quotaline --help"), "{out:?}");
    }
}

/// A home with Claude Code's directory in it, removed after the test.
struct Home(PathBuf);

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Home {
    fn new() -> Self {
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let n = COUNT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("quotaline-setup-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("home");
        Self(path)
    }

    fn claude(&self) -> PathBuf {
        self.0.join(".claude")
    }

    fn settings(&self) -> PathBuf {
        self.claude().join("settings.json")
    }

    /// Puts `text` into the settings file.
    fn write(&self, text: &str) {
        fs::create_dir_all(self.claude()).expect("settings directory");
        fs::write(self.settings(), text).expect("settings");
    }

    fn read(&self) -> String {
        fs::read_to_string(self.settings()).expect("settings")
    }

    /// Files in Claude Code's directory whose names end in `.bak`.
    fn backups(&self) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = fs::read_dir(self.claude())
            .into_iter()
            .flatten()
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "bak"))
            .collect();
        found.sort();
        found
    }

    /// `quotaline` with `args`; stdin is not a terminal.
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_quotaline"))
            .args(args)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("CLAUDE_CONFIG_DIR", self.claude())
            .stdin(Stdio::null())
            .output()
            .expect("the program runs")
    }

    fn setup(&self) -> Output {
        self.run(&["--setup", "--yes"])
    }
}

/// The command `--setup` writes for the program under test, which lies in a
/// path without spaces.
fn me() -> String {
    env!("CARGO_BIN_EXE_quotaline").replace('\\', "/")
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).expect("settings are JSON")
}

#[test]
fn setup_creates_the_settings() {
    let home = Home::new();
    let out = home.setup();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        parsed(&home.read()),
        json!({"statusLine": {"type": "command", "command": me(), "refreshInterval": 60}})
    );
    assert!(home.read().ends_with("}\n"));
    assert_eq!(home.backups(), Vec::<PathBuf>::new());
    assert!(text(&out.stdout).contains("Created"), "{out:?}");
}

#[test]
fn setup_keeps_the_other_settings_in_their_order() {
    let home = Home::new();
    let before = "{\"model\": \"opus\", \"env\": {\"Z\": \"1\", \"A\": \"2\"}, \"hooks\": {}}";
    home.write(before);
    let out = home.setup();
    assert!(out.status.success(), "{out:?}");
    let after = home.read();
    let order = [
        "\"model\"",
        "\"env\"",
        "\"Z\"",
        "\"A\"",
        "\"hooks\"",
        "\"statusLine\"",
    ]
    .map(|key| after.find(key).expect("the key stays"));
    assert!(order.is_sorted(), "{after}");
    assert!(after.starts_with("{\n  \"model\": \"opus\",\n"), "{after}");
    assert_eq!(parsed(&after)["env"], json!({"Z": "1", "A": "2"}));
    // the previous file is kept as it was
    let backups = home.backups();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(fs::read_to_string(&backups[0]).expect("backup"), before);
    assert!(text(&out.stdout).contains(&backups[0].display().to_string()));
}

#[test]
fn setup_twice_changes_nothing_the_second_time() {
    let home = Home::new();
    home.write("{}");
    assert!(home.setup().status.success());
    let first = home.read();
    let out = home.setup();
    assert!(out.status.success(), "{out:?}");
    assert!(text(&out.stdout).starts_with("Already set up"), "{out:?}");
    assert_eq!(home.read(), first);
    assert_eq!(home.backups().len(), 1);
}

#[test]
fn setup_moves_quotaline_from_another_place() {
    let home = Home::new();
    home.write(
        r#"{"statusLine": {"type": "command", "command": "/opt/old/quotaline", "padding": 2}}"#,
    );
    let out = home.setup();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        parsed(&home.read()),
        json!({"statusLine": {"type": "command", "command": me(), "padding": 2}})
    );
    assert!(text(&out.stdout).contains("/opt/old/quotaline"), "{out:?}");
}

#[test]
fn setup_leaves_another_status_line_alone() {
    let home = Home::new();
    let before = r#"{"statusLine": {"type": "command", "command": "~/.claude/statusline.sh"}}"#;
    home.write(before);
    let out = home.setup();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(home.read(), before);
    assert_eq!(home.backups(), Vec::<PathBuf>::new());
    let said = text(&out.stderr);
    assert!(said.contains("~/.claude/statusline.sh"), "{said}");
    assert!(said.contains(&me()), "{said}");
}

#[test]
fn setup_leaves_a_file_that_is_no_json_object_alone() {
    let home = Home::new();
    home.write("{\"model\": \"opus\",}");
    let out = home.setup();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(home.read(), "{\"model\": \"opus\",}");
    assert_eq!(home.backups(), Vec::<PathBuf>::new());
}

#[test]
fn setup_without_a_terminal_asks_for_yes() {
    let home = Home::new();
    home.write("{}");
    let out = home.run(&["--setup"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(text(&out.stderr).contains("--yes"), "{out:?}");
    assert_eq!(home.read(), "{}");
    assert_eq!(home.backups(), Vec::<PathBuf>::new());
}

#[cfg(unix)]
#[test]
fn setup_writes_through_a_link_and_keeps_permissions() {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::Path;
    let home = Home::new();
    let real = home.0.join("dotfiles/claude/settings.json");
    fs::create_dir_all(real.parent().expect("dotfiles")).expect("dotfiles");
    fs::write(&real, r#"{"model": "opus"}"#).expect("settings");
    fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).expect("permissions");
    fs::create_dir_all(home.claude()).expect("settings directory");
    std::os::unix::fs::symlink(&real, home.settings()).expect("link");
    let out = home.setup();
    assert!(out.status.success(), "{out:?}");
    let link = fs::symlink_metadata(home.settings()).expect("link");
    assert!(link.file_type().is_symlink());
    assert_eq!(
        parsed(&fs::read_to_string(&real).expect("settings"))["model"],
        "opus"
    );
    assert_eq!(parsed(&home.read())["statusLine"]["command"], me());
    let mode = |path: &Path| fs::metadata(path).expect("file").permissions().mode() & 0o777;
    assert_eq!(mode(&real), 0o600);
    let backups = home.backups();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(mode(&backups[0]), 0o600);
    // nothing was left next to the real file
    let beside = fs::read_dir(real.parent().expect("dotfiles"))
        .expect("dotfiles")
        .count();
    assert_eq!(beside, 1);
}
