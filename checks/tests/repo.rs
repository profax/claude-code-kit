//! What must not get into the repository, in any tracked file or commit
//! message: text in Russian outside the Russian README, a path into
//! somebody's home folder, and tool signatures in commits. Review misses
//! these; a test does not.

use std::path::Path;
use std::process::Command;

/// The only files written in Russian.
const RUSSIAN: &[&str] = &["README.ru.md"];

/// Cyrillic that belongs where it is: `(file, text)`. Test data for prompts
/// typed in Russian, where a letter's width decides the column of a chip.
const CYRILLIC_DATA: &[(&str, &str)] = &[(
    "plugins/image-preview/hooks/register.test.tsx",
    "что за цвета тут",
)];

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

/// Tracked files with their text; binary files are skipped. This file is
/// left out: it has to spell what it looks for.
fn tracked() -> Vec<(String, String)> {
    let files: Vec<(String, String)> = git(&["ls-files", "-z"])
        .split('\0')
        .filter(|name| !name.is_empty() && *name != "checks/tests/repo.rs")
        .filter_map(|name| {
            let text = std::fs::read_to_string(root().join(name)).ok()?;
            Some((name.to_owned(), text))
        })
        .collect();
    assert!(files.len() > 10, "the check found next to nothing to read");
    files
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
