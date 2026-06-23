# Research Notes

Date: 2026-06-23

## Target

Build a personal bidirectional bridge:

- Codex -> ChatGPT Pro/Projects for on-demand consults.
- ChatGPT Pro/Projects -> Codex/local tools through MCP/task receipts.

## Findings

### Best Fit for Codex -> ChatGPT Pro

`steipete/oracle`

- Strong consult workflow.
- Supports dry-run previews, bundled files, sessions, follow-ups, and MCP-style usage.
- Best first base for a `ask-pro` style Codex skill.
- Browser mode is useful but should stay explicit/experimental.

`adamallcock/codex-chatgpt-control`

- Closest match for controlling real ChatGPT Project/thread UI.
- Handles visible tab control, messages, files, artifacts, mode/tool selection, thread operations, and Project Sources.
- More brittle because it depends on web UI selectors and browser state.
- Best used as a backend for explicit Project/thread operations, not as a general API replacement.

### Best Fit for ChatGPT -> Codex/Local

`CAHN91/gpt-repo-mcp`

- Strongest safety model among local repo MCP candidates.
- Repo IDs, path sandbox, no arbitrary shell, write policies, git review receipts.
- Good base for exposing local repo/context to ChatGPT.

`rebel0789/codexpro`

- Good ChatGPT-facing bridge ergonomics.
- Useful `.ai-bridge` handoff pattern and safe bash ideas.
- Smaller and safer default posture than broad workspace servers.

`Waishnav/devspace`

- Useful OAuth, allowed-host, worktree, and session ideas.
- Avoid copying broad shell permissions and vulnerable transitive dependency surface.

### Other References

`oraios/serena`

- Excellent symbolic code navigation/editing.
- Use as an optional external tool rather than merging into this bridge.

`github/github-mcp-server`

- Well-maintained MCP transport/auth reference.
- Useful for boundaries and toolset partitioning, not directly for ChatGPT Pro consult.

`cyanheads/git-mcp-server`

- Good git safety patterns in places, but too broad/destructive as a dependency.

`ruvnet/chatgpt-dev-mode`

- Mostly tutorial/reference material, not a reusable implementation.

## Policy/Risk Summary

Lower-risk pattern:

- Personal account.
- Local machine.
- Visible browser.
- User-triggered consults.
- Low volume.
- Stop on captcha/rate-limit/login/permission blockers.
- No hidden endpoint or cookie/token extraction.

Higher-risk pattern:

- Using ChatGPT Pro web as an API server.
- Programmatic bulk extraction of outputs.
- Scheduled/infinite loops.
- Captcha, Cloudflare, rate-limit, or model-limit bypass.
- Public service or shared account access.

Current product stance:

- Main engine should follow the `codexpro`-style ChatGPT -> local MCP bridge.
- Codex -> ChatGPT Pro consult should stay as a visible-browser adapter, not the core engine.
- The `.bridge` ledger is the differentiator: every handoff, consult, result, and blocker gets durable local receipts.
- Publishable posture depends on keeping the bridge personal, manual, low-volume, and non-bypass oriented.
