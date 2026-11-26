# Changelog

Notable changes, newest first. One version covers the whole kit: quotaline
and both plugins.

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
