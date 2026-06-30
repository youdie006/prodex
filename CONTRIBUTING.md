# Contributing to prodex

Thanks for your interest! `prodex` is a local CLI + MCP bridge written in TypeScript (Node 20+).

## Development setup

```bash
git clone https://github.com/youdie006/prodex.git
cd prodex
npm install
npm run build
npm test          # full test suite
npm run typecheck
```

## Before opening a pull request

- `npm run release:verify` must pass — it chains tests, typecheck, build, package smoke, and `doctor`.
- Add tests for new behavior; the codebase favors test-first where practical.
- Keep changes focused and small.
- Code comments, commit messages, and docs are written in **English**.
- Never commit `.bridge/` runtime data, secrets, tokens, or personal/local paths.

## Conventions

- Imperative commit subjects (e.g. `Add ...`, `Fix ...`).
- Branch from `main`; open a PR using the checklist in the PR template.
- No emojis in code, comments, docs, or commit messages.

## Reporting

- **Bugs / features**: open an issue using the templates.
- **Security vulnerabilities**: see [SECURITY.md](SECURITY.md) — do **not** file public issues.
