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

## Guided local login

An explicit `prodex login` can connect to an existing local container's
password-protected noVNC viewer. It never reads ChatGPT credentials, cookies or
tokens. It reads only the separate eight-character VNC viewer password, through
a private Docker subprocess pipe, after checking the container identity and the
password file's ownership/type/permissions. Already-ready sessions and `--check`
do not read that password.

The temporary bridge listens on `127.0.0.1` at a random port and accepts only its
exact Host. A random 256-bit, single-use URL fragment establishes an HttpOnly,
SameSite=Strict browser session. The page immediately clears the fragment.
Session bootstrap and WebSocket upgrades require the exact Origin; asset,
credential and status requests require the session cookie and reject cross-origin
requests. No CORS, arbitrary upstream proxying, redirects or directory traversal
are supported. Responses are not cached and the page uses a restrictive CSP.

The VNC password is delivered only to the authenticated noVNC client in memory,
not in URLs, logs, command arguments, clipboard, DOM text or browser storage.
The original VNC password authentication remains enabled. A short-lived bootstrap
capability is necessarily passed to the OS URL opener and may briefly be visible
in local process arguments or to privileged browser extensions. Do not share that
URL or browser debugging output. This protects against unauthenticated web origins,
not a malicious administrator or process with equivalent local-user access.

Timeout, cancellation and readiness close the bridge's owned sockets; they do not
stop the container or erase its saved profile. Docker context, immutable container
ID, image and loopback viewer binding are rechecked before container operations.
Remote contexts are refused. The command does not install services, copy account
profiles, switch browser modes or automate a security challenge.

## Supported versions

`prodex` is pre-release (`0.x`). Security fixes target the latest `main`.
