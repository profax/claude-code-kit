# Changelog

Notable changes, newest first. One version covers the whole kit: quotaline
and both plugins.

## Unreleased

- **quotaline**: the weekly percent no longer drops by one when a session
  reports its whole number after the server's finer one (98 after 98.6).

## 0.1.4 (2026-11-27)

- **Both plugins**: while a session runs tools, a card counts each tool
  group once. Claude Code first draws a new group under a stand-in it
  replaces within a second, and the plugins counted that row until the turn
  ended, so a card from a sent prompt could grow past the room it had: over
  its own label, and under the rows drawn after it. A control character in a
  file's lines, a reply or what an image reader said shows as �, where
  before Claude Code dropped the card, the links or the chips that held it.
- CI tests the plugins on the newest Claude Code at each push, as well as on
  the oldest they support.

## 0.1.3 (2026-11-27)

- **Both plugins**: a card no longer lies over Claude Code's logo, which is
  not drawn again: a card that covered it left a cut-off copy at the top of
  the screen. A size just short of a megabyte reads 1.0 MB, not 1024 KB.
- **image-preview**: a card over the prompt counts no rows of the logo, and
  the plugin draws only once Claude Code has said the screen is full, as
  quick-peek does.
- **quick-peek**: a card with no room above its path keeps its title under
  the path.

## 0.1.2 (2026-11-27)

- **image-preview**: on Windows and under WSL, the window draws a picture in
  the screen's own pixels, so on a scaled screen it is no longer soft.
- **quick-peek**: a card has the fill of a prompt, so its lines don't run
  into the transcript under them. A card under its path lies whole over the
  rows drawn after the reply, the next prompt included.
- **quotaline**: a session billed by API key shows its cost without the
  subscription limits of a login on the same machine.
- The plugins' code is split into modules by concern, with direct tests for
  the prompt-token layout, the BMP reader and card placement; what the
  plugins do is unchanged.

## 0.1.1 (2026-11-27)

- **image-preview**: the card of a chip above the prompt always opens above
  the prompt box, where it covers no text, instead of over the transcript.
  ImageMagick reads a pasted picture under limits of memory, disk and time.
  A session keeps the pixels of its last eight pictures and reads an older
  one again when it is hovered. On Windows and under WSL, a window that fails
  is tried again after five minutes instead of never.
- **quick-peek**: a card writes every cell it covers, so the transcript no
  longer shows through beside a file's lines, and its title sits on a grey
  that reads in a light theme as in a dark one. A reply with a long run of
  punctuation no longer holds the screen.
- **quotaline**: a profile set by `CLAUDE_CONFIG_DIR` reads its own keychain
  entry on macOS and keeps its numbers apart from other profiles. A keychain
  that waits for the user no longer holds the line. When the cache folder
  can't be written, the line ends with `can't write cache`. Names are printed
  without control characters, and the store's files are not written through
  links. Moved to jiff 1.0.
- **Releases**: each archive comes with a signed provenance that
  `gh attestation verify` checks.

## 0.1.0 (2026-11-26)

First public release.

- **image-preview**: hover `[Image #N]` above the prompt or on a sent prompt
  to see the picture. Ghostty and kitty draw the picture themselves; other
  terminals show it in colored cells, or, on Windows and under WSL, in a
  window by the pointer.
- **quick-peek**: paths in replies become links with a card (size, age, first
  lines; none for files that hold secrets, such as `.env`); a click shows the
  file in the file manager, an Alt-click opens it, and a program or a script
  is shown in its folder rather than run.
- **quotaline**: a status line with the context fill, the five-hour and weekly
  limits and the time until each resets, a model's weekly limit, and the model
  in use; `quotaline --setup` adds it to the Claude Code settings.
