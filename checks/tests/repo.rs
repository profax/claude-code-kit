//! What must not get into the repository, in any tracked file or commit
//! message: text in Russian outside the Russian README, a path into
//! somebody's home folder, and tool signatures in commits. And the facts
//! written down in several files, which must agree. Review misses these; a
//! test does not.

use std::path::Path;
use std::process::Command;

use serde_json::Value;

/// The only files written in Russian.
const RUSSIAN: &[&str] = &["README.ru.md"];

/// Cyrillic that belongs where it is: `(file, text)`. The link to the Russian
/// README, and test data for prompts typed in Russian, where a letter's width
/// decides the column of a chip.
const CYRILLIC_DATA: &[(&str, &str)] = &[
    ("README.md", "Русский"),
    (
        "plugins/image-preview/hooks/register.test.tsx",
        "что за цвета тут",
    ),
];

/// Home folders the examples and the test data are allowed to name.
const SAMPLE_USERS: &[&str] = &["ana", "you", "user", "john", "John", "runner", "Shared"];

/// Signatures that tools add to commits and files.
const SIGNATURES: &[&str] = &["Co-Authored-By", "Generated with", "\u{1f916}"];

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the crate sits in the repository root")
}

fn git(args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(root())
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Tracked files that are not UTF-8 text, and so are not searched. Text in
/// another encoding would pass every check unread: a file that fails to
/// decode is an error unless it is here.
const BINARY: &[&str] = &[];

/// Tracked files with their text. This file is left out: it has to spell
/// what it looks for. A file deleted from the working tree has no text to
/// get into a commit.
fn tracked() -> Vec<(String, String)> {
    let mut files = vec![];
    let mut unread = vec![];
    for name in git(&["ls-files", "-z"]).split('\0') {
        if name.is_empty() || name == "checks/tests/repo.rs" {
            continue;
        }
        match std::fs::read(root().join(name)) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => files.push((name.to_owned(), text)),
                Err(_) if BINARY.contains(&name) => {}
                Err(error) => unread.push(format!("{name}: {error}")),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => unread.push(format!("{name}: {error}")),
        }
    }
    assert!(
        unread.is_empty(),
        "files the checks can't read: {unread:#?}"
    );
    assert!(files.len() > 10, "the check found next to nothing to read");
    files
}

fn read(name: &str) -> String {
    std::fs::read_to_string(root().join(name)).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn json(name: &str) -> Value {
    serde_json::from_str(&read(name)).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// The folders of the plugins, such as `plugins/quick-peek`: those with a
/// tracked `.claude-plugin/plugin.json`.
fn plugins() -> Vec<String> {
    let found: Vec<String> = git(&["ls-files", "-z", "plugins"])
        .split('\0')
        .filter_map(|name| name.strip_suffix("/.claude-plugin/plugin.json"))
        .map(str::to_owned)
        .collect();
    assert!(!found.is_empty(), "no plugin.json under plugins/");
    found
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// The versions `text` names right after `prefix`, as in "Claude Code
/// 2.1.325 or later".
fn versions_after(text: &str, prefix: &str) -> Vec<String> {
    text.match_indices(prefix)
        .filter_map(|(at, _)| {
            let rest = &text[at + prefix.len()..];
            let end = rest
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(rest.len());
            let version = rest[..end].trim_end_matches('.');
            is_version(version).then(|| version.to_owned())
        })
        .collect()
}

fn has_cyrillic(text: &str) -> bool {
    text.chars().any(|c| ('\u{400}'..='\u{52f}').contains(&c))
}

/// The user a path names after `marker` (`/Users/`, `/home/`, `\Users\`), if
/// the line has such a path and the user is not a sample one.
fn real_home<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.match_indices(marker).find_map(|(at, _)| {
        let rest = &line[at + marker.len()..];
        let end = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '.'))
            .unwrap_or(rest.len());
        let user = &rest[..end];
        (!user.is_empty() && !SAMPLE_USERS.contains(&user)).then_some(user)
    })
}

#[test]
fn russian_stays_in_the_russian_readme() {
    let mut found = vec![];
    for (name, text) in tracked() {
        if RUSSIAN.contains(&name.as_str()) {
            continue;
        }
        for (n, line) in text.lines().enumerate() {
            let mut line = line.to_owned();
            for (file, data) in CYRILLIC_DATA {
                if *file == name {
                    line = line.replace(data, "");
                }
            }
            if has_cyrillic(&line) {
                found.push(format!("{name}:{}", n + 1));
            }
        }
    }
    assert!(found.is_empty(), "Cyrillic text: {found:#?}");
}

#[test]
fn no_path_leads_into_a_real_home() {
    let mut found = vec![];
    for (name, text) in tracked() {
        for (n, line) in text.lines().enumerate() {
            for marker in ["/Users/", "/home/", "\\Users\\", "\\\\Users\\\\"] {
                if let Some(user) = real_home(line, marker) {
                    found.push(format!("{name}:{}: {marker}{user}", n + 1));
                }
            }
        }
    }
    assert!(found.is_empty(), "home paths: {found:#?}");
}

#[test]
fn files_carry_no_tool_signature() {
    let found: Vec<String> = tracked()
        .into_iter()
        .filter(|(_, text)| SIGNATURES.iter().any(|mark| text.contains(mark)))
        .map(|(name, _)| name)
        .collect();
    assert!(found.is_empty(), "tool signatures in: {found:#?}");
}

#[test]
fn commit_messages_are_plain_english() {
    let log = git(&["log", "--format=%H%n%B%x00"]);
    let commits: Vec<&str> = log
        .split('\0')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .collect();
    assert!(!commits.is_empty(), "no commit to read");
    let found: Vec<&str> = commits
        .into_iter()
        .filter(|message| {
            has_cyrillic(message) || SIGNATURES.iter().any(|mark| message.contains(mark))
        })
        .map(|message| message.lines().next().unwrap_or_default())
        .collect();
    assert!(found.is_empty(), "commits to reword: {found:#?}");
}

/// CI runs the plugins on the Claude Code that `package.json` pins, so that
/// is the oldest version they are known to load on. A promise of an older
/// one is never tested, and a module that calls something this version lacks
/// does not load at all.
#[test]
fn one_lowest_claude_code_version_everywhere() {
    let pinned = json("package.json")["devDependencies"]["@anthropic-ai/claude-code"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(
        is_version(&pinned),
        "package.json must pin an exact @anthropic-ai/claude-code, not {pinned:?}"
    );
    let mut named = vec![];
    for plugin in plugins() {
        let file = format!("{plugin}/.claude-plugin/plugin.json");
        let engine = json(&file)["engines"]["claude-code"]
            .as_str()
            .unwrap_or("none")
            .to_owned();
        named.push((file, engine));
    }
    for readme in ["README.md", "README.ru.md"] {
        let versions = versions_after(&read(readme), "Claude Code ");
        assert!(
            !versions.is_empty(),
            "{readme} names no Claude Code version"
        );
        named.extend(versions.into_iter().map(|v| (readme.to_owned(), v)));
    }
    let wrong: Vec<&(String, String)> = named
        .iter()
        .filter(|(file, version)| {
            let want = if file.ends_with("plugin.json") {
                format!(">={pinned}")
            } else {
                pinned.clone()
            };
            *version != want
        })
        .collect();
    assert!(
        wrong.is_empty(),
        "package.json pins Claude Code {pinned}, these say otherwise: {wrong:#?}"
    );
}

/// The `version` of the `[package]` table in a Cargo.toml.
fn package_version(manifest: &str) -> Option<String> {
    let mut table = "";
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            table = line;
        } else if table == "[package]"
            && let Some(value) = line.strip_prefix("version")
            && let Some(value) = value.trim_start().strip_prefix('=')
        {
            return Some(value.trim().trim_matches('"').to_owned());
        }
    }
    None
}

/// One version covers the kit. A plugin's version decides what `/plugin
/// update` offers, so a release that raised only the program's would reach
/// no plugin user. The release workflow checks the same against the tag;
/// this finds the mismatch on the push that makes it.
#[test]
fn one_version_for_the_kit() {
    let want = package_version(&read("quotaline/Cargo.toml"))
        .expect("quotaline/Cargo.toml has a [package] version");
    let mut named = vec![];
    for plugin in plugins() {
        let file = format!("{plugin}/.claude-plugin/plugin.json");
        named.push((file.clone(), json(&file)["version"].clone()));
    }
    // The marketplace may carry versions too; where it does, they must agree
    let file = ".claude-plugin/marketplace.json";
    let marketplace = json(file);
    let listed = marketplace["plugins"].as_array().into_iter().flatten();
    for version in std::iter::once(&marketplace["metadata"]).chain(listed) {
        if let Some(version) = version.get("version") {
            named.push((file.to_owned(), version.clone()));
        }
    }
    let newest = read("CHANGELOG.md")
        .lines()
        .find_map(|line| line.strip_prefix("## "))
        .and_then(|heading| heading.split_whitespace().next())
        .map(Value::from);
    named.push(("CHANGELOG.md".to_owned(), newest.unwrap_or_default()));
    let wrong: Vec<&(String, Value)> = named
        .iter()
        .filter(|(_, version)| version.as_str() != Some(&want))
        .collect();
    assert!(
        wrong.is_empty(),
        "quotaline is {want}, these say otherwise: {wrong:#?}"
    );
}

/// The plugins started from MIT code whose notice must go with every copy.
/// An installed plugin is a copy of its own folder, so each folder carries
/// the notice, the same as `plugins/LICENSE`.
#[test]
fn each_plugin_carries_the_license_notice() {
    let notice = read("plugins/LICENSE");
    let listed = git(&["ls-files", "-z", "plugins"]);
    let wrong: Vec<String> = plugins()
        .into_iter()
        .map(|plugin| format!("{plugin}/LICENSE"))
        .filter(|file| {
            !listed.split('\0').any(|name| name == file)
                || std::fs::read_to_string(root().join(file)).ok() != Some(notice.clone())
        })
        .collect();
    assert!(
        wrong.is_empty(),
        "not tracked, or not the same as plugins/LICENSE: {wrong:#?}"
    );
}

#[test]
fn the_home_check_tells_a_real_user_from_a_sample_one() {
    assert_eq!(real_home("at /Users/jane/project", "/Users/"), Some("jane"));
    assert_eq!(real_home(r"C:\Users\ana\AppData", "\\Users\\"), None);
    assert_eq!(
        real_home("see /home/you/.claude and /home/bob", "/home/"),
        Some("bob")
    );
    assert_eq!(real_home("the /Users/ folder", "/Users/"), None);
}
