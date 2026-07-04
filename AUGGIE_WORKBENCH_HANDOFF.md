# Auggie Workbench Handoff

Last updated: 2026-07-04

## Repository

Work in:

```text
C:\Users\us141\Documents\codebase\vscode-acp
```

Important: some previous tool sessions had a stale cwd pointing at `AugmentCode-Free`. Always verify the cwd before editing.

## Product Goal

Build a personal Augment-like VS Code sidebar/workbench for Auggie CLI over ACP.

Boundary: reproduce visible workflow and user experience with our own implementation. Do not copy proprietary extension code. Public Auggie docs and the public `augmentcode/auggie` repo are okay as behavior/reference sources.

## User Preferences

- Explain VS Code/dev-host steps very plainly.
- Keep progress in `AUGGIE_SESSION_NOTES.md`.
- Keep the checklist in `AUGGIE_WORKBENCH_TODO.md`.
- Favor bigger functionality over tiny UI nits.
- Visible terminal execution is higher priority than polishing command cards.
- User usually reviews code changes through VS Code Git, so Edits tab is useful but not the core workflow.
- Keep the inferred edit bridge documented; it is intentional fallback behavior.

## Key Files

- `src/ui/ChatWebviewProvider.ts`: webview provider and extension-to-webview state bridge.
- `media/chatWebview.js`: main webview UI script.
- `src/core/SessionManager.ts`: ACP session lifecycle, session load/resume/new, MCP server attachment.
- `src/config/AgentConfig.ts`: agent config plus MCP server normalization.
- `src/handlers/TerminalHandler.ts`: ACP terminal support and visible-command runner.
- `src/core/TerminalMcpBridge.ts`: localhost bridge that lets MCP call the VS Code terminal runner.
- `scripts/auggie-terminal-mcp.js`: stdio MCP helper exposing terminal tools to Auggie.
- `AUGGIE_SESSION_NOTES.md`: running session notes.
- `AUGGIE_WORKBENCH_TODO.md`: project checklist.

## What Is Done

### Core Auggie Workbench

- Extension branded as Auggie Workbench.
- Default agent command is `npx @augmentcode/auggie@latest --acp`.
- Chat webview moved into `media/chatWebview.js`, fixing the old VS Code `document.write` webview parse failure.
- Latest Auggie conversation auto-restores on dev-host startup.
- Main sidebar shell has:
  - Thread / Tasks / Edits tabs
  - connected agent header
  - Augment-like composer controls
  - model/mode-ish lower controls

### Composer / Context

- `@` menu opens an Augment-style context menu.
- Context chips can be added and removed.
- `+` attaches files.
- Selected-code button adds editor selection or shows no-selection state.
- New thread uses a warning flow.

### Tasks

- ACP plan updates populate Tasks tab.
- Tasks persist through extension host reload using webview state and extension workspaceState.
- Fallback parser can recover task titles from assistant text if plan updates are not replayed.
- Fixed hyphenated task title truncation.

### Activity Cards

- Tool calls render as expandable action cards.
- Inline working indicator shows elapsed time and recent tool activity.
- `agent_thought_chunk` is shown only if Auggie actually emits it; no fake hidden reasoning.

### Edits

- Edits tab shows changed files.
- Git-backed file list and line deltas via `git diff --numstat HEAD --`.
- Expandable inline diff previews.
- Open and Diff buttons work.
- Inferred edit rows remain as fallback when tool-call data implies an edit before Git-backed state catches up.

### MCP Config

- `acp.mcpServers` accepts both:
  - ACP-style array
  - Auggie-style object keyed by server name
- Env can be object or `{ name, value }` array.
- `${workspaceFolder}` expands in `command`, `args`, and `url`.

### Visible Terminal MCP Bridge

This is the biggest recent milestone.

Implemented:

- `TerminalMcpBridge` starts a localhost-only HTTP bridge on `127.0.0.1` with a random bearer token.
- `scripts/auggie-terminal-mcp.js` exposes an MCP tool named `run_command_in_vscode_terminal`.
- `SessionManager` appends this built-in MCP server to Auggie sessions.
- `TerminalHandler.runVisibleCommand` executes via VS Code shell integration first, falling back to the existing spawn/pseudoterminal path.

Important fixes:

- First smoke test failed because the MCP helper timed out during startup.
- The helper now accepts:
  - CRLF `Content-Length` framing
  - LF-only `Content-Length` framing
  - newline-delimited JSON framing

Successful user smoke test:

- Prompt:

```text
Use the run_command_in_vscode_terminal MCP tool to run node --version.
```

- Result:
  - Auggie called `run_command_in_vscode_terminal_auggie-vscode-terminal`.
  - VS Code opened a visible terminal named `Auggie: node`.
  - Terminal ran `node --version`.
  - Auggie returned `v22.14.0`.

This confirms the full path works:

```text
Auggie -> MCP helper -> extension localhost bridge -> VS Code terminal -> captured output -> Auggie
```

## Latest Verification

After MCP helper startup-timeout fix:

```text
node --check scripts\auggie-terminal-mcp.js
npm run compile
npm run lint
```

All passed.

After the final user smoke test, no additional code verification was run because no code changed after the smoke test except documentation/checklist notes.

## Known Caveats

- Auggie only used the terminal tool when explicitly asked by exact tool name.
- Next work should improve the tool name/description/schema so Auggie naturally prefers it.
- Consider exposing alias tools:
  - `run_terminal_command`
  - `run_command`
  - `run_in_vscode_terminal`
- The terminal screenshot showed the project venv activating after the command. Only investigate if that extra terminal output becomes noisy.
- MCP bridge availability does not force Auggie away from its internal `launch-process` tool. It only gives Auggie another tool.
- Keep/discard Edits actions are still pending.
- Recent conversation tree is still pending.
- Packaging should be checked before any actual install/distribution; ensure `media/` and `scripts/` are included.

## Best Next Steps

1. Improve terminal MCP tool ergonomics.
   - Add friendlier alias tools in `scripts/auggie-terminal-mcp.js`.
   - Tune descriptions so Auggie understands these are preferred for visible terminal execution.
   - Retest with prompts like:

```text
Run node --version in the VS Code terminal.
```

2. Improve terminal/action cards.
   - Show command text and output preview in action cards.
   - Show whether the command used visible terminal MCP vs internal `launch-process`.

3. Continue Edits polish.
   - Add untracked-file detection.
   - Add binary-file labeling.
   - Add Keep All / Discard All if useful.

4. Continue session/thread work.
   - Show recent conversations in the Threads tree.
   - Let user open older conversations from the tree.

5. Package smoke test.
   - Confirm `media/chatWebview.js` and `scripts/auggie-terminal-mcp.js` are included.

## Instructions For The Next Agent

Tell the next agent:

```text
We are continuing the Auggie Workbench project in C:\Users\us141\Documents\codebase\vscode-acp.

First read:
- AUGGIE_WORKBENCH_HANDOFF.md
- AUGGIE_SESSION_NOTES.md
- AUGGIE_WORKBENCH_TODO.md

Do not work in AugmentCode-Free. Verify cwd is vscode-acp.

The current priority is improving the successful visible-terminal MCP bridge so Auggie naturally chooses it. The bridge already works when explicitly prompted with:
"Use the run_command_in_vscode_terminal MCP tool to run node --version."

Next likely task:
- Add friendlier alias MCP tools such as run_terminal_command / run_command / run_in_vscode_terminal in scripts/auggie-terminal-mcp.js.
- Keep them all forwarding to the same extension bridge.
- Tune tool descriptions for visible VS Code terminal execution.
- Run node --check, npm run compile, npm run lint.
- Then give me clear dev-host test instructions.

Please keep AUGGIE_SESSION_NOTES.md and AUGGIE_WORKBENCH_TODO.md updated.
```

