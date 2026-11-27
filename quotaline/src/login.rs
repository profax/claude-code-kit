//! The Claude Code subscription login and the server that reports its limits.
//! The token is read where Claude Code keeps it and is sent to that server
//! only.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest as _, Sha256};

/// Address of the subscription server. `replaced` (the `QUOTALINE_API`
/// variable) swaps in a test server, and only one on this machine: the
/// request carries the login token. Nothing may follow the port: a `@`
/// would turn the address before it into user info and name another host.
fn api(replaced: Option<String>) -> String {
    replaced
        .filter(|address| {
            address
                .strip_prefix("http://127.0.0.1:")
                .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        })
        .unwrap_or_else(|| "https://api.anthropic.com".into())
}

/// How long the keychain may take. macOS may first ask the user to let
/// `security` read the entry, and the line can't wait for an answer: every
/// session's line waits on the store's lock meanwhile.
#[cfg(target_os = "macos")]
const KEYCHAIN_WAIT: Duration = Duration::from_millis(1500);

/// The login record in the macOS keychain entry `service`, where Claude Code
/// keeps it; `None` when the keychain has no such entry or takes longer
/// than `KEYCHAIN_WAIT`. The user's keychain lives in their home: a home
/// without one (tests) has no record to ask for.
#[cfg(target_os = "macos")]
fn keychain(service: &str) -> Option<String> {
    use std::io::Read as _;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    if !std::env::home_dir()?.join("Library/Keychains").is_dir() {
        return None;
    }
    let mut child = Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut record = String::new();
                child.stdout.take()?.read_to_string(&mut record).ok()?;
                return Some(record);
            }
            Ok(None) if started.elapsed() < KEYCHAIN_WAIT => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(Some(_)) => return None,
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain(_service: &str) -> Option<String> {
    None
}

/// `-` and the first eight hex digits of the SHA-256 of `dir`: how Claude
/// Code tells a profile's keychain entry from the default one.
fn hashed(dir: &str) -> String {
    let hash = Sha256::digest(dir.as_bytes());
    format!(
        "-{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3]
    )
}

/// The keychain entry of this profile's login, named as Claude Code names
/// it: after `CLAUDE_SECURESTORAGE_CONFIG_DIR` when that is set (an empty
/// one means the default entry), otherwise after `CLAUDE_CONFIG_DIR`.
/// Claude Code hashes the path in Unicode NFC: a path written another way
/// misses the entry, and the profile's login file is read instead.
fn keychain_entry() -> String {
    let named = |var| std::env::var_os(var).map(|v| v.to_string_lossy().into_owned());
    let dir = named("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .or_else(|| named("CLAUDE_CONFIG_DIR"))
        .unwrap_or_default();
    let suffix = if dir.is_empty() {
        String::new()
    } else {
        hashed(&dir)
    };
    format!("Claude Code-credentials{suffix}")
}

/// What sets this profile's files apart from the default profile's: empty
/// for the default one, and for `CLAUDE_CONFIG_DIR` the suffix Claude Code
/// gives its keychain entry. Each profile has a login of its own, and its
/// limits are not another's.
pub fn profile() -> String {
    profile_dir().map_or_else(String::new, |dir| hashed(&dir.to_string_lossy()))
}

/// The directory of a Claude Code profile other than the default one:
/// `CLAUDE_CONFIG_DIR`. An empty variable counts as unset, as it does for
/// Claude Code: it would point at whatever directory the program happens to
/// run in.
fn profile_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

/// Claude Code's directory: `CLAUDE_CONFIG_DIR`, or `.claude` in the home.
pub fn config_dir() -> Option<PathBuf> {
    profile_dir().or_else(|| Some(std::env::home_dir()?.join(".claude")))
}

/// The subscription login token, or `None` without a subscription login. An
/// expired token is neither returned nor refreshed: Claude Code refreshes it,
/// and a second refresher would leave Claude Code signed out. The login is
/// the profile's own: its keychain entry, then its `.credentials.json`.
pub fn token(now: i64) -> Option<String> {
    let text = keychain(&keychain_entry())
        .or_else(|| fs::read_to_string(config_dir()?.join(".credentials.json")).ok())?;
    let login: Value = serde_json::from_str(&text).ok()?;
    let login = &login["claudeAiOauth"];
    if login["expiresAt"]
        .as_i64()
        .is_some_and(|ms| ms / 1000 <= now)
    {
        return None;
    }
    login["accessToken"].as_str().map(str::to_owned)
}

/// The server's answer about the limits, or `None` when it fails or takes
/// over two seconds: Claude Code shows no line while the program runs.
pub fn ask(token: &str) -> Option<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .into();
    agent
        .get(format!(
            "{}/api/oauth/usage",
            api(std::env::var("QUOTALINE_API").ok())
        ))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_goes_only_to_anthropic_or_this_machine() {
        let real = "https://api.anthropic.com";
        assert_eq!(api(None), real);
        assert_eq!(api(Some("https://example.com".into())), real);
        assert_eq!(api(Some("http://127.0.0.1.example.com".into())), real);
        // anything after the port can move the host elsewhere or is no port
        for address in [
            "http://127.0.0.1:1@evil.example/",
            "http://127.0.0.1:8080/",
            "http://127.0.0.1:8080/api",
            "http://127.0.0.1:1#@evil.example",
            "http://127.0.0.1:1?@evil.example",
            "http://127.0.0.1:80\\@evil.example",
            "http://127.0.0.1:",
            "http://127.0.0.1:http",
            "http://127.0.0.1:+80",
        ] {
            assert_eq!(api(Some(address.into())), real, "{address}");
        }
        assert_eq!(
            api(Some("http://127.0.0.1:8080".into())),
            "http://127.0.0.1:8080"
        );
    }
}
