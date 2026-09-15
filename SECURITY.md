# Security Policy

`prodex` automates a **logged-in ChatGPT Pro browser session** and brokers tasks between
coding agents, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately instead:

- Preferred: GitHub [private vulnerability reporting](https://github.com/youdie006/prodex/security/advisories/new)
- Include: affected version/commit, reproduction steps, and impact.

We aim to acknowledge within 5 business days and to coordinate a fix and disclosure timeline with you.

## Design intent (what we consider in scope)

`prodex` is local-first and is designed never to expose your ChatGPT account, browser
session, or bridge endpoints to other users. Findings of particular interest:

- Credential, cookie, or session-token leakage from the visible-browser adapter
- Token-bearing MCP URLs being logged, printed, or otherwise exposed
- Bypass of the receipt-gated repo-write/apply/stage tools
- Any default that would let a third party reach your logged-in session or `.bridge` ledger
- Path traversal or arbitrary file access through the repo/file tools

Explicitly out of scope (these are intentional non-features, see the README): hidden ChatGPT
endpoints, cookie/token extraction, stealth automation, and public tunnel auto-setup.

## Local storage permissions

On POSIX filesystems ProDex applies owner-only modes to bridge directories and
private files. Native Windows uses the directory's inherited Windows ACLs;
Unix `0700`/`0600` mode bits do not provide owner-only access there. ProDex does
not rewrite Windows ACLs. Keep the repository, `.bridge`, and browser profile
under a private user-owned directory, not a shared drive or a directory writable
by other users. Review the Windows Security permissions before storing private
prompts or credentials. The same caution applies to mounted filesystems that
ignore POSIX modes. Symlink/junction, file identity, and hard-link checks remain
enabled independently of permission modes.

## Supported versions

`prodex` is pre-release (`0.x`). Security fixes target the latest `main`.
