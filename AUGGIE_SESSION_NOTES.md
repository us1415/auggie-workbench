# Auggie Workbench Session Notes

Use this as the running handoff for long sessions so context compaction does not lose decisions, bugs, or workflow details.

## Current Goal

Build a personal Augment-like VS Code workbench UI for Auggie CLI over ACP.

Important boundary: reproduce the visible workflow/look through our own implementation. Do not copy proprietary extension code.

Public reference note:

- Augment has public repositories, including `https://github.com/augmentcode/auggie`.
- Prefer public Auggie docs/issues/release notes for behavior, flags, ACP/MCP clues, and workflow reference before guessing from the installed VS Code extension bundle.
- Still treat license/source boundaries carefully: use public material for interoperability and behavior reference, not copy/paste implementation.

## Current State

- Repo: `C:\Users\us141\Documents\codebase\vscode-acp`
- Extension branding: Auggie Workbench / Auggie.
- Agent command: `npx @augmentcode/auggie@latest --acp`
- Chat webview is loaded from `media/chatWebview.js`.
- The external webview script fixed the previous VS Code `document.write` parse failure.
- Latest Auggie conversation restores successfully on dev-host startup.
- Auto-restore is silent and avoids the old double-load/cached-conversation flash.
- Temporary debug text/log spam was removed.
- `AUGGIE_WORKBENCH_TODO.md` tracks the feature checklist.

## Implemented So Far

- Webview script externalized to `media/chatWebview.js`.
- Startup restore loads latest Auggie session using ACP list/load when available.
- Single-flight guard prevents duplicate restore/open flows.
- Composer/context pass:
  - `@` opens an Augment-style context menu.
  - Context menu includes Default Context, Files, Folders, Recently Opened Files, Rules, Clear Context.
  - Bottom `+` attaches a file.
  - `I` adds selected code or shows "No code selected".
  - Context chips are removable.
  - Selected context is included in the prompt sent to Auggie.
  - New thread uses warning flow.
  - Model picker label cleanup.
  - Auto and Prompt Enhancer tooltips improved.
- Follow-up composer fixes:
  - Context chips now remove only when clicking the small `x`, not the whole pill.
  - "Recently Opened Files" now renders inside the composer context menu instead of opening VS Code QuickPick at the top.
  - Recent files are sourced from visible editors and workspace text documents.
  - If no recent files are available, the in-menu recent-files view shows an empty message.
- Main workbench shell pass:
  - Added top header with current session/thread title.
  - Added Thread / Tasks / Edits tabs.
  - Header `+` uses the same new-conversation warning flow.
  - Added Tasks placeholder view and Edits placeholder view as real tab panels.
  - Session title updates now drive both the connected banner and the header title.
- Tasks wiring pass:
  - ACP `plan` updates now populate the Tasks tab.
  - The Tasks tab count shows completed/total plan entries.
  - Session replay can restore Tasks from historical plan updates.
  - New/load session flows reset task state before replaying updates.
- Plan/working indicator cleanup:
  - ACP plan updates no longer render a raw Plan card in the Thread view.
  - Plans now feed the Tasks tab only.
  - Removed the detached right-side banner spinner during prompts.
  - Added an inline conversation working indicator that updates from tool-call titles.
- Verbose activity mode:
  - The inline working indicator now shows a header, elapsed timer, and recent activity rows.
  - Tool calls and tool-call updates feed the activity list.
  - `agent_thought_chunk` events, when emitted by Auggie, update the visible activity as "Thinking..." and still render in the collapsible thought block.
  - No hidden/private reasoning is fabricated; the UI only shows ACP events we receive.
- Tasks reload persistence:
  - Observed that after restarting the Extension Development Host, chat history could replay without the original ACP `plan` update, leaving the Tasks tab empty.
  - Persisted the derived task model separately in webview state.
  - During session reload, keep a pending task snapshot and restore it after replay if no fresh plan arrives for the same session.
- Extension-host Tasks persistence:
  - Webview state did not survive the full dev-host restart reliably enough.
  - `ChatWebviewProvider` now derives tasks from live ACP `plan` updates and stores them in `context.workspaceState`, keyed by session id.
  - `state` messages now include persisted tasks for the active session.
  - The webview restores provider-sent tasks even when session replay does not resend the plan update.
- Explicit Tasks snapshot persistence:
  - Provider-side plan detection still did not cover the observed replay case.
  - The webview now posts `persistTasks` to the extension host whenever it successfully renders non-empty Tasks from a plan.
  - Existing sessions can also rebuild a pending task list from replayed assistant numbered/bulleted task text, then persist that snapshot.
- Task fallback parser cleanup:
  - The recovered-title parser no longer treats hyphenated words as delimiters.
  - This should recover titles like "Cross-platform compatibility audit" instead of truncating to "Cross".
- Reviewable activity card first pass:
  - Live tool-call rows are now expandable action-card style blocks.
  - Cards include a chevron, status icon, title, status label, and open/more placeholders.
  - Detail content is still placeholder until we map ACP tool payloads into per-tool summaries.
- Edits bridge first pass:
  - The Edits tab now mirrors edit-looking tool calls such as `Edit README.md`.
  - It renders a changed-file list with file badges and status.
  - The Edits tab now requests Git-backed changed-file snapshots from the extension host.
  - For tracked changes, counters use `git diff --numstat HEAD --` and show real added/removed line totals.
  - Inferred edit-tool rows remain as a live fallback until Git-backed data arrives.
  - Untracked files and binary-file labels are still pending.
  - Expandable diff previews now request `git diff -- <file>` from the extension host.
  - Diff previews render hunk/add/remove/context lines inline and truncate long diffs.
  - Edit rows now include Open and Diff actions.
  - Open shows the changed file in VS Code.
  - Diff opens a VS Code diff using a virtual `HEAD` document on the left and the working-tree file on the right.
  - The inferred edit bridge is intentionally still present as a fallback when ACP/tool-call data implies an edit before Git-backed detection catches up.
  - Keep/discard controls are still pending.
- Product direction from additional Augment screenshots:
  - The old Augment UI emphasized reviewable action cards, not raw hidden thinking.
  - Tool/integration actions should become expandable cards with status, summary, and optional approval controls.
  - File edits should be mirrored into the Edits tab with line deltas and diff preview.
  - Terminal commands, external calls, and file changes should all be reviewable by expanding the action.
  - Checkpoints are a later feature after the review/action model is stable.
- Terminal integration reference:
  - Inspected Augment package metadata and bundled names only for architecture signals; do not copy proprietary source.
  - Augment exposed `augment.experimental.terminal.vscodeTerminalStrategy` with `VSCode` and `Augment` options.
  - The descriptions indicate one path used VS Code built-in terminal events and another used Augment's customized terminal support.
  - Augment also contributed `vscode-augment.addTerminalOutputToChat` as "Add Selection to Augment Chat" in the terminal context menu when terminal text is selected.
  - Augment also appeared to keep a separate persisted tool-use-state model for action cards, with phases such as new/checking/runnable/running/completed/error/cancelled/awaiting-user-input.
  - Architecture lesson: Augment's terminal strategy does not imply arbitrary internal agent tools can be forced into a terminal. Visible terminal execution works when the agent/tool runner chooses a terminal-backed command tool. Tool cards are the separate review/status layer.
  - User clarified visible terminal execution is higher priority than polishing command cards.
  - This ACP client already advertises `terminal: true` and implements terminal/create, output, wait, kill, and release handlers.
  - Previous terminal handler executed commands with `child_process.spawn` and mirrored output into a VS Code pseudoterminal.
  - New first-choice terminal path uses VS Code shell integration so ACP terminal/create requests execute in a real visible VS Code terminal while still capturing output for ACP.
  - The old spawn/pseudoterminal path remains as a fallback if VS Code shell integration is unavailable.
  - Smoke-test signal:
    - If Output > Auggie Workbench shows `createTerminal: using VS Code shell integration terminal`, Auggie is using ACP terminal/create and visible execution should happen.
    - If there are no `createTerminal:` logs while Auggie runs a command, Auggie is using an internal command tool that this client cannot redirect through the terminal handler.
  - First user smoke test on 2026-07-04 showed only `tool_call` and `tool_call_update` events for a node version command, with no `createTerminal:` log. This means Auggie did not use ACP terminal/create for that command.
  - Added targeted tool-call diagnostics in `SessionUpdateHandler` so future logs include tool id/title/status and any command/path fields Auggie exposes.
  - Added `acp.mcpServers` plumbing so configured MCP servers are passed into ACP `session/new`, `session/load`, and `session/resume` instead of always passing `[]`.
  - Current testing status: there is nothing visible for the user to test from this plumbing alone. UI behavior should remain unchanged until an MCP server is configured or a local terminal-runner MCP server is added.
  - Public Auggie reference pass on 2026-07-04:
    - Public repo: `https://github.com/augmentcode/auggie`
    - ACP docs: `https://docs.augmentcode.com/cli/acp/agent`
    - MCP docs: `https://docs.augmentcode.com/cli/integrations`
    - CLI reference: `https://docs.augmentcode.com/cli/reference`
    - The public repo is useful for docs/examples/release references, but it is not a full product implementation source. Continue using it as public behavior/reference material, not as code to copy.
    - Auggie ACP mode is started with `auggie --acp`; docs explicitly warn that not every interactive-mode feature is supported in ACP mode.
    - Auggie's own MCP config is an object keyed by server name under `mcpServers`, usually in `~/.augment/settings.json`.
    - Auggie supports stdio/http/sse MCP transports, env objects, headers, `auggie mcp add/list/remove`, `--mcp-config`, and `${workspaceFolder}` expansion.
    - CLI reference exposes the internal process tool name as `launch-process`, with flags like `--permission launch-process:allow`, `--shell`, and `--startup-script`.
    - This supports the MCP route for future tools, but it also explains the terminal smoke test: Auggie may choose its own internal `launch-process` tool in ACP mode instead of ACP `terminal/create`.
  - MCP normalization pass:
    - `acp.mcpServers` now accepts both ACP-style arrays and Auggie-style objects keyed by server name.
    - Env values can be Auggie-style objects or ACP-style `{ name, value }` arrays.
    - `${workspaceFolder}` is expanded in `command`, `args`, and `url` before the config is passed into ACP sessions.
    - This keeps the door open for a local VS Code-terminal-backed MCP tool without making the user translate Auggie docs by hand.
  - Local terminal-runner MCP bridge pass:
    - Added `TerminalMcpBridge` in the extension host.
    - The bridge starts a localhost-only HTTP server on `127.0.0.1` with a random bearer token.
    - Added `scripts/auggie-terminal-mcp.js`, a small stdio MCP server that exposes one tool: `run_command_in_vscode_terminal`.
    - The MCP tool forwards command requests to the extension-host bridge.
    - The bridge runs commands through `TerminalHandler.runVisibleCommand`, which uses the existing VS Code shell-integration terminal path first and the spawn/pseudoterminal fallback second.
    - `SessionManager` now has a client MCP server provider. User-configured MCP servers are still read from settings, and the built-in terminal MCP server is appended afterward.
    - Every new/load/resume Auggie session should now include the built-in MCP server named `auggie-vscode-terminal`.
    - Important caveat: this does not force Auggie to use the tool. It makes the tool available. The next smoke test is whether Auggie chooses `run_command_in_vscode_terminal` when explicitly asked.
    - Expected logs on dev-host startup/session open:
      - `Terminal MCP bridge listening on 127.0.0.1:<port>`
      - `SessionManager: attaching N MCP server(s) to ... session`
    - Expected logs if Auggie uses the MCP tool:
      - `Terminal MCP bridge run: <command> ...`
      - `createTerminal: using VS Code shell integration terminal`
  - First MCP bridge smoke test result:
    - User saw the bridge/session attach logs, but Auggie responded that `run_command_in_vscode_terminal` was not available.
    - Output log showed `MCP server startup error: MCP error -32001: Request timed out`.
    - Command in log: `node c:\Users\us141\Documents\codebase\vscode-acp\scripts\auggie-terminal-mcp.js`.
    - Interpretation: Auggie did not ignore a registered tool; the MCP helper failed startup before registration.
  - MCP helper startup-timeout fix:
    - `scripts/auggie-terminal-mcp.js` now accepts CRLF `Content-Length`, LF-only `Content-Length`, and newline-delimited JSON framing.
    - Replies use the framing mode detected from the request.
    - Local smoke tests confirmed both Content-Length and NDJSON initialize requests receive a response.
  - Successful terminal MCP smoke test:
    - User restarted the dev host and asked Auggie to use `run_command_in_vscode_terminal` for `node --version`.
    - Auggie successfully called the MCP tool.
    - A real visible VS Code terminal named `Auggie: node` ran `node --version`.
    - Auggie returned result `v22.14.0`.
    - The Thread view showed a completed tool card named `run_command_in_vscode_terminal_auggie-vscode-terminal`.
    - This confirms the full chain works: Auggie -> MCP helper -> extension localhost bridge -> VS Code terminal -> captured output -> Auggie.
    - Follow-up improvement: make Auggie prefer this tool more naturally without needing such exact prompting. Likely improve tool name/description and possibly expose additional alias tools such as `run_terminal_command`.
    - Note: terminal also activated the project venv after the command in the screenshot. Track this only if extra startup output becomes noisy.
  - Terminal MCP alias ergonomics pass:
    - `scripts/auggie-terminal-mcp.js` now advertises four visible-terminal command tools:
      - `run_command_in_vscode_terminal`
      - `run_terminal_command`
      - `run_command`
      - `run_in_vscode_terminal`
    - All aliases forward to the same extension-host localhost bridge and use the same command schema.
    - Descriptions now explicitly say to use the tools for visible VS Code integrated terminal execution, including npm, node, git, tests, compilers, linters, and other CLI tasks.
    - The advertised schema now includes `outputByteLimit`, matching the bridge parser.
    - Local MCP `tools/list` sanity check confirmed all four tool names are reported.
    - Next user smoke test should check whether Auggie chooses a visible-terminal alias from natural prompts like `Run node --version in the VS Code terminal.` without naming the exact original tool.
  - Natural-prompt terminal MCP smoke test:
    - User tested `Run node --version in the VS Code terminal.` in the Extension Development Host.
    - Auggie chose the visible-terminal MCP path without being given the exact tool name.
    - The completed tool card still used the original tool name: `run_command_in_vscode_terminal_auggie-vscode-terminal`.
    - A visible VS Code terminal ran `node --version` in the workspace and returned `v22.14.0` with exit code 0.
    - This confirms the ergonomic improvement worked for the important behavior: natural terminal requests route to the MCP bridge and visible VS Code terminal.
  - Next execution-first path is richer terminal/action card summaries now that visible terminal command execution is working from natural prompts.
  - Keep terminal selection/output as low priority because copy/paste is good enough for now.

## Recent Verification

After the composer/context pass and follow-up fixes:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After the main shell pass:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After the Tasks wiring pass:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After the plan/working indicator cleanup:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After verbose activity mode:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After Tasks reload persistence:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After extension-host Tasks persistence:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After explicit Tasks snapshot persistence:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After task parser cleanup and activity-card first pass:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After Edits bridge first pass:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After Git-backed Edits line deltas:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After expandable Edits diff previews:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After VS Code shell-integration terminal bridge:

- `node --check media/chatWebview.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After tool-call diagnostics:

- `npm run compile` passed.
- `npm run lint` passed.

After public Auggie docs reference + MCP config normalization:

- `npm run compile` passed.
- `npm run lint` passed.

After local terminal-runner MCP bridge:

- `node --check scripts\auggie-terminal-mcp.js` passed.
- `npm run compile` passed.
- `npm run lint` passed.

After MCP helper startup-timeout fix:

- `node --check scripts\auggie-terminal-mcp.js` passed.
- Local Content-Length initialize smoke test passed.
- Local newline-delimited JSON initialize smoke test passed.
- `npm run compile` passed.
- `npm run lint` passed.

After successful user terminal MCP smoke test:

- User confirmed visible VS Code terminal execution worked for `node --version`.
- No additional code verification run after the user smoke test.

After terminal MCP alias ergonomics pass:

- `node --check scripts\auggie-terminal-mcp.js` passed.
- Local MCP `tools/list` sanity check returned `run_command_in_vscode_terminal`, `run_terminal_command`, `run_command`, and `run_in_vscode_terminal`.
- `npm.cmd run compile` passed.
- `npm.cmd run lint` passed.
- Plain `npm run compile` and `npm run lint` were blocked by PowerShell execution policy for `npm.ps1`; rerunning through `npm.cmd` worked.

After natural-prompt terminal MCP smoke test:

- User confirmed `Run node --version in the VS Code terminal.` opened a visible VS Code terminal through the MCP tool.
- The terminal returned `v22.14.0` with exit code 0.
- No code changes were made after this smoke test, only notes/checklist updates.

Current continuation verification on 2026-07-04:

- Confirmed cwd was `C:\Users\us141\Documents\codebase\vscode-acp`, not `AugmentCode-Free`.
- Rechecked `scripts/auggie-terminal-mcp.js`; it already advertises `run_command_in_vscode_terminal`, `run_terminal_command`, `run_command`, and `run_in_vscode_terminal`, all forwarding to the same extension bridge.
- `node --check scripts\auggie-terminal-mcp.js` passed.
- `cmd /c npm run compile` passed.
- `cmd /c npm run lint` passed.
- Used `cmd /c npm run ...` because direct PowerShell `npm run ...` can be blocked by the local `npm.ps1` execution policy.

Terminal/action card summary pass on 2026-07-04:

- `media/chatWebview.js` now preserves the full `tool_call` and `tool_call_update` payloads in chat history instead of storing only id/title/status.
- Expandable tool cards now derive and render useful details when Auggie exposes them:
  - command and args
  - working directory
  - terminal id
  - exit code / signal
  - timed-out and truncated flags
  - bounded output preview
- The renderer handles the visible-terminal MCP summary text format returned by `scripts/auggie-terminal-mcp.js`, while also tolerating generic ACP fields like `arguments`, `input`, `result`, `content`, `command`, and `args`.
- The card `open` button now toggles expanded details instead of being a placeholder-only button.
- `src/ui/ChatWebviewProvider.ts` includes CSS for the detail rows and output preview block.
- Verification after this pass:
  - `node --check media\chatWebview.js` passed.
  - `cmd /c npm run compile` passed.
  - `cmd /c npm run lint` passed.
- Needs dev-host smoke test: run a visible terminal command and expand the resulting tool card to confirm the command/output details appear from Auggie's actual payload shape.

## Known Issues / Watch Items

- Need user smoke test after each F5 dev-host restart.
- Confirm reload/reopen restores latest conversation without pressing Start.
- Confirm loading overlay always clears after history replay.
- Confirm `media/chatWebview.js` is included in packaged extension.
- `@` menu is UI-local; Files/Folders still use VS Code dialogs rather than nested in-webview submenus.
- Files/Folders still use VS Code dialogs; Recently Opened Files is now in-webview.
- Rules/Default Context are prompt-context chips, not full Augment index/rules integrations yet.
- Need to ensure context injection is acceptable to Auggie and not too noisy.
- Tasks tab uses ACP plan updates, so it only has content when Auggie emits a plan.
- Edits now shows real Git line deltas for tracked files, keeps inferred rows as a fallback, has read-only expandable diff previews, and can open files/diffs. It does not yet show untracked files, binary labels, external open actions, or keep/discard controls.

## Next Best Work

0. Public Auggie repo/reference pass:
   - Done for initial ACP/MCP/terminal architecture pass.
   - Continue using public docs/repo first when new Auggie behavior questions come up.
1. No current user smoke test for MCP plumbing:
   - The latest `acp.mcpServers` change is infrastructure only.
   - Do not ask the user to test it until a real MCP server is configured or a local terminal-runner server is added.
2. Smoke test composer controls in Extension Development Host:
   - `@`
   - bottom `+`
   - selected-code `I`
   - `New`
   - send prompt with chips attached
3. Continue bigger functionality:
   - convert tool-call rows into expandable reviewable action cards
   - wire Edits to real file change detection, diff previews, and keep/discard actions
   - wire Tasks to plan/task/tool progress if ACP exposes enough data
   - make top header mode selector functional
4. Terminal execution smoke test:
   - Completed successfully for explicit prompt: `Use the run_command_in_vscode_terminal MCP tool to run node --version.`
   - Alias/description ergonomics are implemented.
   - Natural-prompt smoke test also completed: `Run node --version in the VS Code terminal.`
   - Next terminal work is richer command/action cards, not basic connectivity.
5. Activity cards:
   - smoke test command activity details in the Extension Development Host
   - render file read/search cards with file/path/result summaries
   - keep terminal selection/output as a later low-priority convenience
6. Continue context-menu parity:
   - make Files/Folders nested in-webview lists if feasible
   - decide what Default Context and Rules should really include
7. Improve message rendering and action-card polish.
8. Package smoke test and confirm `media/chatWebview.js` is included.

## User Workflow Notes

The user is not deep into VS Code extension workflow, so explain dev-host steps clearly:

1. Use the source VS Code window for coding/debugging.
2. Stop debugging there.
3. Press `F5` to launch the Extension Development Host.
4. Test Auggie inside the Extension Development Host.

## Screenshot References

- `Photos-3-001 (1).zip`
- `Photos-3-001 (2).zip`

The second zip showed:

- Top header with Thread / Tasks / Edits tabs.
- Indexing progress row.
- `@` context menu.
- Auto toggle tooltip.
- Prompt Enhancer tooltip.
- Ask/Agent style controls.
- Tasks list view.
- Edits changed-file view.
