# gptprouse

Personal bridge for using ChatGPT Pro/Projects, Claude, and Codex together.

`gptprouse` is a local receipt bus plus MCP bridge for coordinating Codex execution with ChatGPT Pro/Projects and Claude.

The goal is not to turn ChatGPT Pro into a public API. The goal is to make Codex the main workbench while keeping durable receipts for every outside consult or handoff:

- Ask ChatGPT Pro from Codex when a stronger planning/review pass is useful.
- Let ChatGPT Projects hand structured tasks to Codex/local tools through an optional HTTP MCP bridge.
- Let Claude create/fetch the same tasks through stdio MCP.
- Keep durable records of what was asked, what was returned, and what Codex did with it.

## Core Shape

```text
Codex
  | pro ask preview / tasks / mcp
  v
gptprouse local bridge + .bridge receipts
  |                         ^
  | optional explicit       | optional HTTP/stdin MCP
  | pro browser consult     |
  v                         |
ChatGPT Pro              ChatGPT Projects / Claude
```

## Operating Rules

- Manual-first: each ChatGPT Pro consult should be user-initiated or clearly tied to the current task.
- Browser automation is optional and explicit: use it only through `pro browser ...`, with a real visible logged-in browser session.
- Stop on blockers: login, captcha, rate limit, Cloudflare, permission, and model-limit states stop the workflow.
- No bypass: no hidden API, cookie extraction, stealth automation, proxies, or captcha solving.
- Low volume: no batch prompting or recurring loops that make ChatGPT Pro behave like an API server.
- Local only: do not expose account access, browser sessions, or bridge endpoints to other users.

## Components

- `docs/http-mcp.md`: ChatGPT Project HTTP MCP setup and safety notes.
- `docs/claude.md`: Claude stdio MCP setup and tool notes.
- `.bridge/`: local task/result/session/artifact/receipt storage.

## Package Surface

The npm package is CLI-only for now. The supported public surfaces are the `gptprouse` command, the stdio MCP server, and the optional HTTP MCP server. JavaScript imports from `gptprouse` or `gptprouse/dist/*` are intentionally not exported until a library API is designed and documented.

## v0.2 Status

Implemented:

- Versioned `.bridge` ledger schemas for tasks, results, sessions, and receipts.
- CLI commands for task creation/listing/inspection/claiming/completion/blocking and result display.
- `pro ask` and `pro latest` for Codex-first consult previews and review receipts.
- `sessions list` and `sessions show` for inspecting dry-run, running, done, or blocked consult sessions.
- `receipts list` and `receipts show` for inspecting the local action ledger without exposing legacy inline write payloads.
- Ledger MCP tools for creating, claiming, completing, blocking, and inspecting task/result/session/receipt records from Claude or ChatGPT Projects.
- Read-only result artifact fetch for Pro consult and generic MCP handoff artifacts explicitly listed on result records.
- `pro browser login/check/smoke/ask` for the optional visible browser adapter.
- Claude-compatible stdio MCP server through `gptprouse mcp`.
- ChatGPT Developer Mode-style Streamable HTTP MCP server through `gptprouse setup` and `gptprouse start`.
- Read-only repo tools for bounded file reads and ripgrep search.
- Receipt-gated repo write/stage tools for existing text files: dry-run first, apply only with matching git HEAD and preimage hash, then stage only reviewed applied receipts.
- `doctor` local health check for `.bridge`, redacted config loading, receipt-backed write/apply/stage, and the real HTTP MCP tool catalog.

Not implemented:

- Hidden ChatGPT endpoints.
- Cookie, token, localStorage, or sessionStorage extraction.
- Direct ungated write tools.
- Shell execution tools.
- Automatic public tunnel setup.

## Quick Start

Requires Node.js 20 or newer, `git`, and `ripgrep` (`rg`) on PATH. The optional visible-browser adapter also needs a Chromium-family browser (`google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser`) or `GPTPROUSE_CHROME=/path/to/browser`.

For an installed package:

```bash
gptprouse onboard
gptprouse init
gptprouse doctor
gptprouse pro ask "Review the project positioning"
```

For a source checkout:

```bash
npm install
npm run build
SOURCE_CLI="$(pwd)/dist/cli.js"
node dist/cli.js onboard --source-cli "$SOURCE_CLI"
node dist/cli.js init
node dist/cli.js doctor --source-cli "$SOURCE_CLI"
node dist/cli.js pro ask "Review the project positioning"
```

The examples below use the installed `gptprouse` binary. In a source checkout, replace `gptprouse` with `node dist/cli.js` after building, and pass `--source-cli "$(pwd)/dist/cli.js"` to onboarding, browser, prompt, and local MCP troubleshooting commands so their follow-up guidance stays in source-checkout form.
`onboard` prints the Claude, ChatGPT Project, and optional ChatGPT Pro consult commands without changing local state.

`init` creates the local `.bridge/` ledger directories and ignore rules. On a source checkout it may also add `node_modules/` and `dist/` to the repo root `.gitignore` so local dependencies and build output stay out of git.
Run `init` from the repo root, or use `gptprouse init --cwd /absolute/path/to/your/repo` from elsewhere.

`pro ask` is a dry-run/manual preview. It does not drive a logged-in browser; `pro ask --send` is rejected so accidental sends do not happen through the preview alias. Use `pro browser ask` when you explicitly want the visible browser adapter.
Run `pro ask` and `pro browser ask` from the repo root so `--file` paths and `.bridge` records resolve to the intended project. If you generated commands with `onboard --cwd`, use the `cd ...` line in the optional Pro section first.
Inspection commands such as `pro browser check`, `pro latest`, `pro show`, `tasks list`, `results show`, `results artifact`, `receipts show`, and `sessions show` can also be run from elsewhere with `--cwd /absolute/path/to/your/repo`.
When the file exists and you want it included, add it explicitly, for example `gptprouse pro ask --file README.md "Review the project positioning"`.
If your prompt itself starts with flag-like text, put `--` before the prompt. This applies to both preview and visible-browser sends, for example `gptprouse pro ask -- --strict mode review` or `gptprouse pro browser ask -- --strict mode review`.

## First Pro Login

Use this only when you explicitly want to use your logged-in ChatGPT Pro web session.

```bash
gptprouse pro browser login --dry-run
gptprouse pro browser login
gptprouse pro browser help
gptprouse pro browser check
gptprouse pro browser smoke
```

If you use a non-default debug port or Chrome profile, pass it to `login`; the printed follow-up `check` and `smoke` commands keep the matching `--port`. On slower first launches, add `--launch-timeout-ms 12000`.

For a source checkout, keep the follow-up commands in source-checkout form too:

```bash
SOURCE_CLI="$(pwd)/dist/cli.js"
node dist/cli.js pro browser login --dry-run --source-cli "$SOURCE_CLI"
node dist/cli.js pro browser login --source-cli "$SOURCE_CLI"
node dist/cli.js pro browser help --source-cli "$SOURCE_CLI"
node dist/cli.js pro browser check --source-cli "$SOURCE_CLI"
node dist/cli.js pro browser smoke --source-cli "$SOURCE_CLI"
```

What happens:

- `login --dry-run` prints the dedicated Chrome profile, debug URL, and next commands without opening a browser.
- `login` opens that dedicated Chrome profile at ChatGPT.
- You log in manually in the visible browser.
- If ChatGPT asks for captcha, permission, or account verification, handle it in that browser.
- Open a normal ChatGPT chat or the intended Project/thread so the prompt composer is visible.
- Pick the Pro/Thinking model you want in the ChatGPT UI.
- The login stays in the dedicated profile:

```text
~/.local/share/gptprouse/chrome-chatgpt-pro
```

You can close that Chrome window after check/smoke or when you are done. The next time you need it, run `pro browser login` or `pro browser check` again. `check` will tell you what to do if the browser is closed.

Actual explicit visible-browser consult:

```bash
gptprouse pro browser ask --file README.md "Review the project positioning"
gptprouse pro latest
gptprouse results show latest
gptprouse results artifact latest
gptprouse sessions show latest
```

This uses the currently available ChatGPT web session and model selection. It is not a hidden API client, and it does not read cookies, tokens, localStorage, or sessionStorage.

For a source checkout, keep the explicit send and inspection commands source-aware too:

```bash
SOURCE_CLI="$(pwd)/dist/cli.js"
node dist/cli.js pro browser ask --source-cli "$SOURCE_CLI" --file README.md "Review the project positioning"
node dist/cli.js pro latest --source-cli "$SOURCE_CLI"
```

Pass `--source-cli "$(pwd)/dist/cli.js"` to `pro browser ask`, `pro list`, `pro latest`, or `pro show <task-id|latest>` so blocked consults display source-checkout retry commands instead of installed-binary commands.

Each explicit browser consult creates a `.bridge` task and `.bridge/sessions` record before sending. If the visible browser is blocked by login, captcha, permission, or usage limits, the task is completed as a blocked consult so `gptprouse pro latest` still shows what happened, including the blocker code and next step; the failed command also prints the recorded task id plus `pro show`/`pro latest` inspection commands. Successful answers are normally saved as result artifacts under `.bridge/artifacts/pro-consults/` before the task result is finalized; if artifact or receipt recording fails after an answer is received, the answer is still completed as the result summary with a warning, and fatal finalization failures print the received answer before exiting. If a Pro answer is too large for `bridge_fetch_result_artifact`, it stays in the result summary with `answer_artifact_warning` and no unfetchable artifact is listed. Generic MCP handoff result artifacts can be stored under `.bridge/artifacts/results/`; `bridge_fetch_result_artifact` only reads artifacts explicitly listed on the result record, and newly finalized result artifacts are checked against the sha256 recorded at finalization time.

To send into a specific visible Project or thread, open that ChatGPT URL in the dedicated browser first, confirm it is the right destination, then pass the same URL:

```bash
gptprouse pro browser ask --target-url "https://chatgpt.com/c/..." --confirm-target --file README.md "Review this in this thread"
```

`gptprouse` does not silently switch Projects or threads. If the visible ChatGPT tab is not already on the confirmed URL, the send is refused.
If more than one ChatGPT tab or window is visible or visibility cannot be verified for extra ChatGPT tabs, an untargeted browser send is also refused; close the extra ChatGPT windows or use `--target-url ... --confirm-target`.

For optional ChatGPT Project -> local handoff, start the HTTP MCP bridge:

```bash
gptprouse setup --token-ttl-hours 24
gptprouse start
```

`setup` writes `.bridge/config.local.json` and ensures `.bridge/.gitignore` covers local task/result/session/receipt/artifact/config files. `setup`, `start`, and `status` redact the URL token by default.
The HTTP MCP listener is loopback-only: `setup --host` accepts local loopback hosts such as `127.0.0.1` or `localhost`, not public interfaces like `0.0.0.0`.
`start` reads the saved setup profile when the server process starts. If you rerun `setup` to change the listener or rotate the token, restart `gptprouse start` so the running server uses the new profile. `status --show-token --url-only` prints the saved local MCP URL, while `tunnel url` formats your supplied public tunnel URL with the saved token; it does not create or inspect the tunnel.

Run these commands from the repo root, or add `--cwd /absolute/path/to/your/repo` to `setup`, `start`, `status`, `doctor`, `tunnel url`, and bridge inspection commands. For example:

```bash
gptprouse setup --cwd /absolute/path/to/your/repo --token-ttl-hours 24
gptprouse start --cwd /absolute/path/to/your/repo
```

Token-bearing MCP URLs are secrets. Use the next command only when you are ready to paste the URL into your own trusted private ChatGPT Project/App configuration:

```bash
gptprouse status --show-token --url-only
```

`status --show-token` requires a token with an expiry, so run `setup --token-ttl-hours <hours>` before asking for a paste-ready URL. The URL token is stored only in `.bridge/config.local.json`, which is ignored by git. Rotate it with `setup` when you no longer need that URL. If you intentionally created a non-expiring token for local-only debugging, `status --show-token` refuses to reveal it unless you also pass `--unsafe-show-non-expiring-token`.

After adding the MCP URL to ChatGPT, generate a paste-ready verification prompt:

```bash
gptprouse project prompt
```

For a source checkout, pass the same built CLI path so the prompt's local follow-up commands are also source-checkout commands:

```bash
node dist/cli.js project prompt --source-cli "$(pwd)/dist/cli.js"
```

Paste that prompt into the ChatGPT Project. It asks ChatGPT to call `bridge_create_task`, `bridge_list_tasks`, and `bridge_get_task` only, then you can confirm the created task locally:

```bash
gptprouse tasks list --status new
gptprouse tasks show <task-id>
```

The generated prompt also includes local `status --cwd ...` and `doctor --cwd ...` troubleshooting commands in case the Project cannot see or call the MCP tools. Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.

If ChatGPT cannot reach `127.0.0.1` from its app runtime, keep `gptprouse start` local and put your own tunnel in front of it only after creating a short-lived token. `gptprouse` does not create the tunnel for you, but it can format the public MCP URL safely.

Public tunnel MCP URLs are also secrets. Use the next command only when you are ready to paste the public URL into your own trusted private MCP client configuration:

```bash
gptprouse tunnel url --public-url "https://your-tunnel.example" --show-token --url-only
```

See [docs/http-mcp.md](docs/http-mcp.md) for the full ChatGPT Project HTTP MCP setup flow and safety notes.

The MCP write path is intentionally narrow:

- `repo_write_file_dry_run` previews an existing repo-relative text-file replacement, stores hashes/diff in a receipt, and stores replacement text under `.bridge/artifacts/repo-writes/`.
- `repo_write_file_apply` applies that receipt only when the current git HEAD and file preimage hash still match.
- `repo_stage_reviewed_paths` stages only files whose applied write receipts still match the current git HEAD and file content.
- Sensitive local paths such as `.bridge`, `.git`, `.env*`, `node_modules`, and `dist` are rejected.
- No shell execution or direct ungated staging tool is exposed.

For local task-bus smoke tests:

```bash
gptprouse doctor
gptprouse tasks create --title "Review plan" --prompt "Review this architecture"
gptprouse tasks list
gptprouse tasks show latest
gptprouse tasks block <task-id> --summary "Blocked reason" --code manual_blocker --next-step "What to do next" --retryable
gptprouse pro ask --dry-run --file README.md "Review the project positioning"
gptprouse sessions list
```

`doctor` stays local: it does not open ChatGPT or a browser. It creates isolated temp workspaces for the write/apply/stage smoke and HTTP MCP smoke, then confirms the expected bridge/repo tools are visible and that task create/list/get/claim/complete/block/fetch/list-results works over the MCP protocol.

During local development, you can run the TypeScript source directly:

```bash
npm run dev -- tasks list
```

## Release Checks

GitHub Actions runs `npm ci` and `npm run release:verify` on pushes to `main` and pull requests. The workflow installs `ripgrep` because the repo-search smoke checks require `rg`. It verifies release readiness only; it does not publish anything.

Before sharing a package tarball, run:

```bash
npm run smoke:package
```

This packs the project, installs the tarball into a temporary consumer project, runs the installed `gptprouse` binary, verifies HTTP MCP onboarding through installed token-TTL `setup`/`status`/configured `doctor`/`tunnel url`/`start`, checks `/health`, connects to the installed `/mcp` endpoint, lists tools, calls `bridge_create_task`, verifies explicit `--cwd` task storage, exercises the installed HTTP MCP repo write dry-run/apply/stage flow, exercises the installed HTTP MCP task completion/blocking/result/artifact fetch flow including tampered artifact rejection, verifies installed HTTP MCP receipt/session list/fetch tools, verifies the installed `release-pack` script and `gptprouse release pack` CLI success paths for normalized publish tarballs, runs `npm publish --dry-run` against those normalized tarballs, verifies git-ready release-pack output includes the guarded `release_pack_publish` command, verifies the package is CLI-only by blocking unsupported deep imports, verifies the installed stdio MCP server exposes the expected tool catalog, exercises the installed stdio MCP repo write dry-run/apply/stage flow, verifies installed stdio oversized repo_search failure output, verifies installed stdio non-git write failure output, exercises the installed stdio MCP task completion/blocking/result/artifact fetch flow including tampered artifact rejection, and verifies installed stdio MCP receipt/session list/fetch tools.

To run the full release verification sequence:

```bash
npm run release:verify
```

This runs tests, typecheck, build, package smoke, and `doctor` without weakening the publish guard.

If direct `npm pack` is blocked because a WSL/Windows mount reports normal source files as executable, build the publish tarball from a temporary Linux staging directory:

```bash
gptprouse release pack --pack-destination /tmp/gptprouse-release
```

For a source checkout, use the built CLI with `--source-cli` so follow-up commands stay in source-checkout form:

```bash
node dist/cli.js release pack --source-cli "$(pwd)/dist/cli.js" --pack-destination /tmp/gptprouse-release
node dist/cli.js release status --source-cli "$(pwd)/dist/cli.js"
```

The npm script is equivalent when you only need the tarball:

```bash
npm run release:pack -- --pack-destination /tmp/gptprouse-release
```

`release pack` does not publish anything. It still refuses missing publish metadata, non-regular or hard-linked packed files, and missing package release checks; it only normalizes packed file modes in the staging copy so package `bin` entries remain executable and other packed files become regular `0644` files. Run `npm run release:verify` and `gptprouse release status` before publishing the tarball it creates. When the tarball is ready, `release pack` prints `release_pack_git` and `release_pack_git_next` lines before publish guidance so git remote/upstream blockers stay visible. It always prints `npm publish --dry-run <tarball>` for inspecting the exact tarball, but prints `npm publish <tarball>` only after git readiness is clear; otherwise it prints `release_pack_publish_blocked`.

Add `--keep-workdir` to `gptprouse release pack` or `npm run release:pack -- ...` when you need to inspect the temporary normalized staging directory.

To see the current publish blocker and next step from the CLI:

```bash
gptprouse release status
```

It reports package metadata blockers, pack file-mode, non-regular file, or hard-link blockers when package identity is readable, and local git readiness, including a dirty worktree, detached HEAD, missing git remote, branch without upstream tracking, upstream is gone, branch divergence, unpushed local commits, or a branch behind upstream. For a new public repo, create the remote yourself, then run `git remote add origin <git-url>` and `git push -u origin <branch>`; `release status` prints those handoff commands when the local git state is missing a remote or upstream.

Before publishing to npm, make sure `package.json` has an npm-publishable `name` and valid semver `version`, keep the explicit MIT `license` metadata and matching `LICENSE` regular file, and make sure `package.json` does not have `private: true`. `release:check` treats missing or malformed package identity and `private: true` as publish blockers because npm will refuse to publish those packages. It also rejects a `LICENSE` path that is a directory, symlink, or hard link, rejects non-regular or symlinked packed files, blocks packed files with unexpected executable modes outside package `bin` entries, and rejects hard-linked packed files. If you are on a WSL/Windows mount that reports every file as executable, publish from a Linux filesystem, fix mount metadata/chmod first, or use `gptprouse release pack --pack-destination <dir>` after release verification to create the tarball from normalized staging files. `npm publish` is intentionally guarded by `prepublishOnly`; it runs:

```bash
npm run release:check
```

If package metadata stops being publishable, `release:check` fails with a metadata error instead of letting an accidental public publish proceed. Use `npm run release:verify` when you only want local verification without claiming publish readiness.

## Claude MCP

If `gptprouse` is installed and on your PATH, generate the Claude MCP config JSON:

```bash
gptprouse claude config --cwd /absolute/path/to/your/repo
```

It prints this token-free config:

```json
{
  "mcpServers": {
    "gptprouse": {
      "command": "gptprouse",
      "args": ["mcp", "--cwd", "/absolute/path/to/your/repo"]
    }
  }
}
```

For a source checkout, first run `npm install && npm run build`, then generate a `node dist/cli.js` config:

```bash
gptprouse claude config --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/gptprouse/dist/cli.js
```

See [docs/claude.md](docs/claude.md) for Claude Desktop and Claude Code notes.
Both generated configs point Claude at the same `mcp --cwd /absolute/path/to/your/repo` server args.

After adding the MCP server in Claude, generate a paste-ready verification prompt:

```bash
gptprouse claude prompt --cwd /absolute/path/to/your/repo
```

For a source checkout, include the built CLI path:

```bash
node dist/cli.js claude prompt --cwd /absolute/path/to/your/repo --source-cli /absolute/path/to/gptprouse/dist/cli.js
```

The generated prompt asks Claude to create and read a bridge task only; it does not request write, stage, shell, browser, or tunnel actions. It also includes local `claude config --cwd ...` and `doctor --cwd ...` troubleshooting commands in case Claude cannot see or call the MCP tools. Source-checkout prompts keep `--source-cli` on those troubleshooting commands too.
