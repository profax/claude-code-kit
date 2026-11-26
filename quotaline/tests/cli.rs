//! The program's command line: the version, the help, and arguments it does
//! not know.

use std::process::{Command, Output, Stdio};

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
