# Security policy

## Supported versions

Only the latest release gets fixes.

## What counts as a vulnerability

quotaline reads the Claude Code login token to ask the subscription server
for your limits. The plugins run programs on your machine to read a picture or
to show a file in the file manager, with paths taken from the conversation.
These count as vulnerabilities:

- the token, or anything derived from it, written to a file or a log, or sent
  anywhere other than `api.anthropic.com` and the test server on this machine
  that `QUOTALINE_API` names (`http://127.0.0.1:<port>`, nothing else);
- `quotaline --setup` changing anything in the settings file other than
  `statusLine`, or losing the file's contents;
- text in a prompt, a reply or a file name that makes a plugin run a program
  or open a path other than the one shown.

## Reporting a vulnerability

Please report privately, not in a public issue:
[Report a vulnerability](https://github.com/profax/claude-code-kit/security/advisories/new).

Include the version (`quotaline --version`, or the plugin's version from
`/plugin`), your system and terminal, and the steps that show the problem.
You can expect a first answer within a week.
