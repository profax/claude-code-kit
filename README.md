**English** | [Русский](README.ru.md)

# claude-code-kit

[![CI](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/profax/claude-code-kit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/profax/claude-code-kit)](https://github.com/profax/claude-code-kit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Three additions to Claude Code in the terminal: look at a pasted image before
you send it, peek into a file a reply names, and keep your limits in the
status line.

| Part | What it does |
|---|---|
| [image-preview](#image-preview) | Hover `[Image #N]` to see the picture |
| [quick-peek](#quick-peek) | Paths in replies become links with a preview card |
| [quotaline](#quotaline) | Status line: context, limits, time until they reset |

All three run on macOS, Linux, Windows and WSL. The plugins work by
hovering, so they need Claude Code's fullscreen interface, which
`/tui fullscreen` turns on, and a terminal that passes mouse movement to
programs. quotaline runs in any terminal.

The parts don't depend on each other. Install the ones you want.

## Install

### Install the plugins

They need Claude Code 2.1.325 or later.

```
/plugin marketplace add profax/claude-code-kit
/plugin install image-preview@claude-code-kit
/plugin install quick-peek@claude-code-kit
```

Then run `/tui fullscreen` once: Claude Code gets the mouse pointer from the
terminal only in its fullscreen interface, and it keeps that setting.

In tmux 3.7b hovering works with tmux's default settings. If it does nothing
in your tmux, try adding `set -g mouse on` to `~/.tmux.conf` and running
`tmux source-file ~/.tmux.conf`.

### Install quotaline

1. Download the archive for your system and processor from
   [Releases](https://github.com/profax/claude-code-kit/releases):

   | System | Processor | Archive |
   |---|---|---|
   | macOS | Apple silicon (M1 and later) | `quotaline-<version>-aarch64-apple-darwin.tar.gz` |
   | macOS | Intel | `quotaline-<version>-x86_64-apple-darwin.tar.gz` |
   | Linux, WSL | x86-64 (Intel or AMD) | `quotaline-<version>-x86_64-unknown-linux-musl.tar.gz` |
   | Linux, WSL | Arm | `quotaline-<version>-aarch64-unknown-linux-musl.tar.gz` |
   | Windows | x86-64 (Intel or AMD) | `quotaline-<version>-x86_64-pc-windows-msvc.zip` |

   On a Mac, the Apple menu > About This Mac names the chip: Apple M1 or later
   is Apple silicon. On Linux and WSL, `uname -m` prints `x86_64` or
   `aarch64`.

2. Unpack it and put the program in a folder for programs.

   On macOS, Linux and WSL, run this in a terminal:

   ```
   cd ~/Downloads
   tar -xzf quotaline-*.tar.gz
   mkdir -p ~/.local/bin
   mv quotaline-*/quotaline ~/.local/bin/
   ```

   If the browser has unpacked the archive already, skip the `tar` line.
   Under WSL, a browser in Windows saves to the Windows Downloads folder, so
   start with `cd /mnt/c/Users/you/Downloads`, with your Windows user name in
   place of `you`.

   On Windows, right-click the archive in File Explorer, choose Extract All,
   and move `quotaline.exe` from the unpacked folder to a folder whose path
   has no spaces, such as `C:\Users\you\bin` (if your user name has a space,
   use `C:\tools`).

3. Run it by its full path with `--setup`:

   ```
   ~/.local/bin/quotaline --setup
   ```

   On Windows, run `C:\Users\you\bin\quotaline.exe --setup` in PowerShell.
   The folder doesn't have to be on your `PATH`: `--setup` writes the full
   path into the settings. On its own, `quotaline` prints its help.

   macOS doesn't start a program downloaded with a browser until Apple has
   checked it, and Apple hasn't checked quotaline. If macOS says it can't
   verify `quotaline` and doesn't start it, remove the mark macOS put on the
   file and run step 3 again:

   ```
   xattr -d com.apple.quarantine ~/.local/bin/quotaline
   ```

`--setup` shows the change it is about to make to the Claude Code settings,
asks, and keeps a copy of the file as it was:

```
$ ~/.local/bin/quotaline --setup
quotaline will add this to /Users/you/.claude/settings.json:

  "statusLine": {
    "type": "command",
    "command": "/Users/you/.local/bin/quotaline",
    "refreshInterval": 60
  }

Write it? [y/N] y
Added the status line to /Users/you/.claude/settings.json.
The previous file is saved as /Users/you/.claude/settings.json.20261201T101500Z.bak
Claude Code reloads its settings on its own: open sessions show the line without a restart.
```

If the settings already name another program as the status line, quotaline
leaves it alone and prints what to change by hand.

Instead of steps 1 and 2, you can build quotaline from source (Rust 1.89 or
later):

```
cargo install --locked --git https://github.com/profax/claude-code-kit quotaline
```

This puts it in `~/.cargo/bin`, so step 3 is `~/.cargo/bin/quotaline --setup`
(`quotaline.exe` on Windows).

<details>
<summary>Set it up by hand</summary>

Add this to `~/.claude/settings.json`, with the full path to the program. On
Windows write the path with forward slashes, such as
`C:/Users/you/bin/quotaline.exe`: both Git Bash and PowerShell run it that way.

```json
"statusLine": {
  "type": "command",
  "command": "/Users/you/.local/bin/quotaline",
  "refreshInterval": 60
}
```

</details>

## image-preview

Paste an image and a `[Image #N]` chip appears above the prompt. Hover it to
see the picture; click to open it in the system viewer. The same works on the
prompts you already sent.

How the picture is drawn depends on the terminal:

- Ghostty and kitty draw the image itself.
- On Windows and under WSL it opens in a small window by the pointer, in tmux
  too. The window takes no focus and closes when the pointer leaves.
- Any other terminal draws it in colored cells, and so do Ghostty and kitty
  inside tmux. If your terminal can show pictures, set
  `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` before you start Claude Code, and the
  card sends it the picture instead.

On Linux it needs ImageMagick (`magick` or `convert`) to read the picture.
macOS and Windows read it with what the system has, and use ImageMagick when
it is installed.

## quick-peek

A path in a reply, such as `src/main.rs` or `docs/plan.md:42`, becomes a link
if the file exists. Hover it for a card with the name, the size and how long
ago it changed. For code and text the card also shows the first lines, or the
lines around the one the path names. Click to show the file in Finder,
Explorer or your Linux file manager. Alt-click opens it.

## quotaline

```
ctx 34% · 5h 21% ↻ 4h 2m · week 62% ↻ 2d 4h 42m · fable 65% · Opus 5.5 medium
```

From left to right: how full the context is, the five-hour and the weekly
limit with the time until each resets, the weekly limit of a single model if
your plan has one, and the model with its effort level. Numbers turn yellow
and then red as a limit runs out.

After a reset, `5h` and `week` show 0% until a session brings the new numbers,
for at most as long as the window lasts (five hours or a week), and then leave
the line. A model's weekly limit leaves the line at its reset, and when
requests to the server have failed for over an hour: only the server reports
it. The line reads `limits: no data` when Claude Code passed nothing to show
and no session has stored any limits yet.

All sessions on a machine share what they learn, so an idle session shows
fresh numbers too, and a new one shows them before its first reply. A session
billed by API key shows its cost and the day's total instead of limits. Both
are Claude Code's estimate at list prices, not an invoice.

## What it reads, writes and sends

- `quotaline` reads the Claude Code login token (the macOS keychain, or
  `.credentials.json` in the Claude Code folder) and sends it to
  `api.anthropic.com` to ask for your limits. The only other place it can go
  is a test server on this machine that the `QUOTALINE_API` variable names. It
  asks at most once in five minutes across all sessions, and not at all when
  it can't write its cache folder, where the sessions note when they last
  asked. It never refreshes or stores the token. It keeps the numbers in
  `quotaline/limits.json`, with a lock file next to it, in your cache folder
  (`$XDG_CACHE_HOME` or `~/.cache`, or `%LOCALAPPDATA%` on Windows). `--setup`
  changes one key, `statusLine`, in the Claude Code settings, and only after
  you agree.
- `image-preview` reads the images Claude Code stored for the session and
  writes resized copies next to them, in the session's temp folder. It runs
  ImageMagick, `sips` or PowerShell to read a picture, and the system viewer
  when you click. On Windows and under WSL it also keeps the window's helper,
  `image-preview-popup-1.dll`, in the Windows temp folder.
- `quick-peek` reads the size, the date and the first lines of the files a
  reply names. It runs the file manager when you click.

The plugins send nothing over the network. When they pass a failure over,
they write its cause to the Claude Code debug log.

## Updates

Claude Code doesn't update plugins from a third-party marketplace on its own.
Turn that on in `/plugin`, under Marketplaces, or run:

```
claude plugin update image-preview@claude-code-kit
claude plugin update quick-peek@claude-code-kit
```

For quotaline, download the new release and replace the file.

## Known limitations

- The fullscreen interface is a research preview in Claude Code. Without it
  the plugins stay out of the way and draw nothing.
- On Windows over SSH, Claude Code turns the fullscreen interface off. Use a
  local terminal there.
- The weekly limit of a single model, and the numbers before a session's
  first reply, come from a server endpoint that Claude Code uses but doesn't
  document. If it changes, the line falls back to what Claude Code reports.
- On macOS, Claude Code keeps the login of a profile set by
  `CLAUDE_CONFIG_DIR` in the keychain under a name quotaline doesn't look for.
  In such a profile quotaline reads only `.credentials.json` in that folder.
  Without that file the line gets no numbers from the server: no weekly limit
  of a single model, and no limits before a session's first reply.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md). Built with Claude Code.

## License

[MIT](LICENSE). The plugins started from `image-preview` and `quick-peek` in
[better-claude](https://github.com/midudev/better-claude) by Miguel Ángel
Durán, also MIT; its notice is in [plugins/LICENSE](plugins/LICENSE).
