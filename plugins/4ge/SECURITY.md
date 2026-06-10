# Security Policy

The 4ge plugin runs inside Claude Code and executes hooks, dispatches agents,
and reads/writes files in your project. We take security reports seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

1. **GitHub Security Advisories (preferred).** On the
   [turd-box repository](https://github.com/turdpusher360/turd-box), open the
   **Security** tab and choose **Report a vulnerability** to file a private
   advisory. This keeps the report confidential until a fix is available.
2. **Email.** Send details to **info@3sixtyco.dev** with `SECURITY` in the
   subject line.

Please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce (a minimal repro, affected command/hook/agent, and the
  plugin version from `/4ge:help` or `.claude-plugin/plugin.json`).
- Any relevant logs with secrets redacted — never paste live credentials.

## What to expect

- We aim to acknowledge a report within a few business days.
- We will work with you to confirm the issue, assess severity, and prepare a
  fix. We will let you know when a fix ships.
- Coordinated disclosure is appreciated: please give us a reasonable window to
  release a fix before any public discussion.

## Scope

In scope: the plugin source distributed in this repository — hooks under
`hooks/`, agents under `agents/`, skills under `skills/`, runtime libraries
under `lib/` and `bin/`, and the manifests under `.claude-plugin/`.

Out of scope: vulnerabilities in Claude Code itself (report those to Anthropic),
in third-party tools the plugin merely invokes, or in your own project
configuration.

## Handling secrets

The plugin includes advisory secret-scanning and credential-handling guards.
These are best-effort and **warn-only** — they reduce accidental exposure but
are not a guarantee. Always store secrets in `.env` or a secret store, never in
source or in chat, and rotate any credential you suspect has leaked.
