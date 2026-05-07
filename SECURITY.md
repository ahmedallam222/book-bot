# Security Policy

## Supported Versions

The latest release on `main` is the only actively maintained version.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | ✅ Yes             |
| Older   | ❌ No              |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in this project, please report it
privately using one of the following channels:

1. **GitHub Security Advisories** (preferred):
   <https://github.com/ahmedallam222/book-bot/security/advisories/new>
2. **Telegram**: contact the maintainer privately via
   [@kholasaelktob_Bot](https://t.me/kholasaelktob_Bot) with a brief note that
   you have a security report — the maintainer will follow up over a private
   channel.

When reporting, please include:

- A clear description of the issue and its potential impact.
- Steps to reproduce, ideally with a minimal proof-of-concept.
- Any relevant logs, payloads, or affected endpoints.
- Your preferred contact method for follow-up.

## What to Expect

- We aim to **acknowledge** every report within **72 hours**.
- We aim to **triage and assess** within **7 days**.
- For confirmed vulnerabilities, we will work on a fix and coordinate
  disclosure timing with the reporter.
- We are happy to credit reporters in the release notes (if desired).

## Out of Scope

The following are generally **not** considered vulnerabilities:

- Rate-limit or quota issues that do not bypass intended billing.
- Findings on third-party services (Telegram, Mistral, Firecrawl, hosting
  provider) — please report those upstream.
- Issues that require a compromised admin account or root access on the host.
- Spam, phishing, or social-engineering of bot users that does not exploit a
  bug in this codebase.

## Hardening Notes for Operators

If you self-host this bot, please:

- Never commit `.env` or any file containing real credentials.
- Use unique, strong values for `DASHBOARD_SECRET` and database passwords.
- Restrict access to the dashboard (port 5000) behind a firewall, reverse
  proxy with auth, or VPN.
- Keep the host OS, Docker, and dependencies up to date.
- Rotate API keys (Telegram bot token, Mistral, Firecrawl) periodically and
  immediately if any credential is suspected to be exposed.

Thank you for helping keep this project and its users safe.
