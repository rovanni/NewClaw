# Security Policy

> **Language / Idioma:**
> 🇺🇸 **English** | 🇧🇷 [Português](SECURITY.pt-br.md) | 🇪🇸 [Español](SECURITY.es.md)

## Reporting a vulnerability

**Please do not open a public issue for security problems.** A public report tells everyone
running NewClaw about the flaw before a fix exists, including people who would exploit it.

Report privately through GitHub Security Advisories:

**https://github.com/rovanni/NewClaw/security/advisories/new**

This creates a private thread visible only to you and the maintainers.

If you cannot use that form, open a regular issue saying only that you have a security report
to send — with no technical detail — and wait for contact.

### What helps

- What an attacker achieves (read files, bypass authentication, run commands…)
- Steps to reproduce, or a minimal proof of concept
- Affected version (`package.json` → `version`) and operating system
- Your configuration, **with secrets removed** — API keys, tokens, passwords and personal paths

### What to expect

This is a project maintained by volunteers, without a paid security team, so there is no
guaranteed response time. What is promised: reports are read, confirmed vulnerabilities are
fixed and published as advisories, and credit is given to whoever reported them — unless you
prefer otherwise.

## Supported versions

Fixes go into the `main` branch. There is no long-term support for older versions: the
recommendation is to run the latest published version.

| Version | Supported |
|---|---|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Where NewClaw handles sensitive data

Useful for anyone auditing the project, and for anyone running it:

- **`.env`** — holds API keys, channel tokens and the dashboard password. Never versioned
  (it is in `.gitignore`); `.env.example` carries only empty placeholders.
- **Web dashboard** — binds to `127.0.0.1` by default. Exposing it on a network
  (`DASHBOARD_HOST=0.0.0.0`) **requires** setting `DASHBOARD_PASSWORD`; without it, `/api/*`
  is open to anyone who can reach the port.
- **Command execution** — the agent runs shell commands through its tools. Destructive patterns
  are blocked outright, and dangerous actions require explicit approval in SAFE mode. Capability
  mode is what governs this: raising it widens what runs without asking.
- **Local model servers** — starting a local model from the dashboard runs an executable found
  in the folder *you* configured. Only the file name travels from the browser, and it is checked
  against the real directory listing; the executable and its arguments are resolved server-side.
- **Conversation memory** — stored in a local SQLite database (`data/`), unencrypted. Anyone with
  filesystem access to the machine can read it.

## Known advisories

Published advisories live at
[github.com/rovanni/NewClaw/security/advisories](https://github.com/rovanni/NewClaw/security/advisories).

Each fixed vulnerability has a regression test that fails if the flaw ever returns — for example
`S129_DashboardAuth_GHSA_jpx8_29mp_v4hw`, covering GHSA-jpx8-29mp-v4hw (auth tokens signed with
an empty HMAC key). Verifying a fix means running the suite:

```bash
npm run test:regression
```
