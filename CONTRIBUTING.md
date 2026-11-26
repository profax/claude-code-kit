# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue
first so we can agree on the approach before you write it.

## Layout

- `plugins/image-preview`, `plugins/quick-peek`: Claude Code plugins in
  TypeScript. The code is in `hooks/`, the tests are `hooks/*.test.tsx`.
- `plugins/LICENSE`: the notice of the MIT code the plugins started from.
  An installed plugin is a copy of its own folder, so each plugin folder
  carries the same file; `cargo test -p checks` keeps the three copies equal.
- `quotaline/`: the status line, a Rust program.
- `checks/`: tests of the repository itself.

## Checks

Run these before you push. CI runs the same ones.

```
npm ci --ignore-scripts
node node_modules/@anthropic-ai/claude-code/install.cjs
npm run validate
npm test

cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

CI also tests quotaline on the oldest Rust it supports, the `rust-version` in
`quotaline/Cargo.toml`: `cargo +1.89 test --locked -p quotaline`. Every Cargo
command that builds runs with `--locked`, which fails when `Cargo.lock` is out
of date: a change to the dependencies or to a version comes with the
`Cargo.lock` that a plain `cargo build` writes.

`npm ci` installs the oldest Claude Code the plugins support, the version
`engines` names in each `plugin.json`. A plugin that calls something this
version lacks does not load there at all, so the tests must pass on it.

`npm run typecheck` needs the type definitions that Claude Code writes into
a plugin's `.claude-plugin/types/` when it loads the plugin in an interactive
session: start `npx claude --plugin-dir plugins/image-preview --plugin-dir
plugins/quick-peek` once, then run it. `npx` starts the Claude Code that
`npm ci` installed, so the types are those of the version the plugins must
load on. CI can't run this check.

The quotaline tests in `quotaline/tests/line.rs` point the program at a test
server with `QUOTALINE_API`. The request carries the login token, so the
variable takes only `http://127.0.0.1:<port>`; with any other value the
program asks the real server.

`cargo test -p checks` tests the repository itself: it lists the tracked
files with git and reads every commit message, so it needs a git clone. A
shallow clone passes but checks only the commits it has, which is why CI
fetches the full history. In a source archive, run the rest with `cargo test
--workspace --locked --exclude checks`.

## Try a plugin from your working copy

```
claude --plugin-dir plugins/image-preview --plugin-dir plugins/quick-peek
```

Then `/tui fullscreen`: the terminal reports the pointer only there. A
session watches the folder and picks up your edits.

## Conventions

- A bug fix comes as two commits: a test that fails on the old code, then the
  fix.
- One commit per reason, and the message says why the change is needed.
- Comments say why, not what, and describe what a function promises its
  caller. No history of changes in comments: that is what `git log` is for.
- Everything is in English except `README.ru.md`. `cargo test -p checks`
  enforces this.

## Releasing

Raise the version in `quotaline/Cargo.toml`, `Cargo.lock` and both
`plugin.json` files, and add the section to the top of `CHANGELOG.md`;
`cargo test --workspace --locked` fails while any of them disagree. When you
release, remove "(unreleased)" from the section's heading, tag a commit on
`main` with `v<version>`, and push the tag. The release workflow refuses a
tag that disagrees with the versions, a section still marked unreleased, and
a tag off `main`: the marketplace serves the plugins from `main`.
