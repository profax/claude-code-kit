# claude-code-kit

Two Claude Code plugins (`plugins/`, TypeScript) and a status line
(`quotaline/`, Rust). Read `CONTRIBUTING.md` first: it has the layout, the
checks to run before a commit, and the conventions.

- The plugins must load on the Claude Code version pinned in `package.json`.
  Before you call an engine API, check that this version has it: one unknown
  call keeps the whole module from loading.
- A plugin never blocks the prompt: a hook that gates an event (`prompt.submit`)
  carries a `.catch` that passes the event on.
- quotaline reads the login token and must send it nowhere but
  `api.anthropic.com` and the test server on this machine that `QUOTALINE_API`
  names (`http://127.0.0.1:<port>`, nothing else). The test
  `login_goes_only_to_anthropic_or_this_machine` guards this; do not weaken it.
- `quotaline --setup` changes only `statusLine` in the settings and never
  replaces another program's status line.
- User-facing text is plain American English: short, direct, no exclamation
  marks. `README.ru.md` mirrors `README.md`; change both in the same commit.
- Commits carry no co-author lines and no tool signatures.
