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
command runs with `--locked`, which fails when `Cargo.lock` is out of date: a
change to the dependencies or to a version comes with the `Cargo.lock` that a
plain `cargo build` writes.

`npm ci` installs the oldest Claude Code the plugins support, the version
`engines` names in each `plugin.json`. A plugin that calls something this
version lacks does not load there at all, so the tests must pass on it.

`npm run typecheck` needs the type definitions that Claude Code writes into
a plugin's `.claude-plugin/types/` when it loads the plugin in an interactive
session: start `claude --plugin-dir plugins/image-preview --plugin-dir
plugins/quick-peek` once, then run it. CI can't run this check.

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

Raise the version in `quotaline/Cargo.toml` and in both `plugin.json` files,
add the section to `CHANGELOG.md`, and push the tag `v<version>`. The release
workflow refuses a tag that disagrees with any of them.
