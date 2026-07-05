# Auggie Workbench TODO

Reference screenshots:
- `Photos-3-001 (1).zip`
- `Photos-3-001 (2).zip`

Public references:
- `https://github.com/augmentcode/auggie`

## 1. Stabilize Current Build

- [x] Remove temporary debug UI text from the webview.
- [x] Reduce temporary Output log spam once restore/message flow is stable.
- [x] Fix duplicate "Opening Auggie..." notifications.
- [ ] Confirm reload/reopen restores the latest conversation without pressing Start.
- [ ] Ensure the loading overlay always clears after replaying conversation history.
- [x] Confirm `media/chatWebview.js` is included when packaging the extension.
- [x] Confirm `scripts/auggie-terminal-mcp.js` is included when packaging the extension.
- [x] Replace upstream ACP Client README with Auggie Workbench install/smoke-test docs.
- [x] Replace upstream ACP Client changelog with Auggie Workbench package/smoke-test changelog.

## 2. Main Shell Layout

- [x] Add Augment-style top header with current thread title.
- [x] Add top tabs: Thread, Tasks, Edits.
- [ ] Add right-side mode selector: Agent / Chat.
- [ ] Add indexing/progress row UI.
- [ ] Improve empty-state card for new thread.
- [ ] Keep top thread tree and lower chat view synchronized.

## 3. Thread And Session Flow

- [x] Show recent conversations in the Threads tree.
- [x] Let user open older conversations from the tree.
- [x] Smoke test Threads tree recent/open-latest/open-older flows in the Extension Development Host.
- [x] Add warning before starting a new conversation.
- [ ] Make restart/open latest behavior reliable after VS Code reload.
- [ ] Decide how to represent missing ACP capabilities, especially resume/list/load differences.

## 4. Composer Controls

- [x] Rework composer to match Augment density and layout.
- [x] Make `@` open context menu:
  - Default Context
  - Files
  - Folders
  - Recently Opened Files
  - Rules
  - Clear Context
- [x] Make attach/context chips show selected folders/files.
- [x] Make selected editor/file chips removable.
- [x] Add code-selection context button state:
  - Show "No code selected" tooltip when no selection exists.
  - Add selected code when an editor selection exists.
- [x] Add Rules & Guidelines button/tooltip.
- [ ] Add Ask/Agent mode toggle or equivalent behavior.
- [x] Improve Auto toggle with tooltip and mode state.
- [x] Improve Prompt Enhancer button/tooltip.
- [x] Clean up model picker label and styling.
- [ ] Verify send/stop behavior during active responses.

## 5. Slash Commands And Menus

- [ ] Expand `/` command menu beyond skills-only.
- [ ] Improve command menu placement and selection styling.
- [ ] Add keyboard navigation for menus.
- [ ] Close menus reliably on Escape, blur, and send.

## 6. Message Rendering

- [ ] Match user message styling closer to Augment.
- [ ] Match assistant message spacing and typography.
- [ ] Improve markdown rendering and code blocks.
- [x] Add verbose inline activity indicator with elapsed time and current tool activity.
- [x] Surface `agent_thought_chunk` events when the agent emits them.
- [ ] Add reaction/action row where useful.
- [ ] Smooth streaming updates.

## 6.5 Reviewable Activity Cards

- [x] Convert compact tool-call rows into expandable action cards.
- [x] Show action-card status states: waiting/running/completed/failed.
- [x] Add action-card header pieces: expand chevron, action icon, title, status, overflow/open placeholders.
- [x] Add compact summary text for command actions when ACP/MCP payloads expose command details.
- [x] Render external integration calls with URL/method/preview rows when ACP/MCP payloads expose them.
- [x] Render terminal command cards with command text, output preview, and completion status.
- [x] Add terminal MCP bridge side-channel for command/output details when Auggie ACP tool payloads only say `other`.
- [ ] Filter ANSI/OSC/shell-control sequences from terminal card output previews.
- [x] Render file read/search cards with file/path/query/result summaries when ACP/MCP payloads expose them.
- [x] Add title fallback parsing for read/search cards when Auggie only exposes path/query text in the card title.
- [x] Treat `Run ...` / `Execute ...` tool titles as command cards when Auggie search work arrives through execute tools.
- [x] Smoke test file/search action-card summaries in the Extension Development Host.
- [ ] Smoke test external/web action-card summaries if Auggie exposes a web-style tool.
- [ ] If ACP exposes approval-needed events, add Approve/Reject controls.
- [ ] Keep Activity panel and action cards consistent so the user can see both live progress and review details.

## 7. Tasks View

- [x] Add Tasks tab view shell.
- [x] Display task count in tab label.
- [ ] Add task filter dropdown.
- [x] Add task list styling with status icons.
- [ ] Add Add Task action.
- [x] Use ACP plan updates as the first real Tasks data source.
- [x] Use placeholder state if ACP does not expose tasks.

## 8. Edits View

- [x] Add Edits tab view shell.
- [x] Display added/removed line counters.
- [x] Show changed file list with file icons.
- [x] Mirror file-edit activity cards into Edits.
- [x] Replace placeholder counters with real Git line deltas for tracked changes.
- [x] Add untracked-file detection and binary-file labeling.
- [x] Add expandable diff preview for edited files.
- [x] Add open-file/open-diff action.
- [ ] Add external/open-in-explorer action if useful.
- [x] Add Keep All / Discard All actions.
- [x] Auto-refresh Edits when workspace files are created, saved, renamed, or deleted.
- [x] Smoke test Edits untracked/binary/discard controls in the Extension Development Host.
- [ ] Track terminal commands, integration calls, and file diffs as reviewable actions.
- [x] Use inferred edit-tool state if ACP does not expose explicit edits.

## 8.5 Checkpoints

- [ ] Decide what counts as a checkpoint, e.g. before task, after edits, before discard.
- [ ] Store checkpoint metadata per conversation/session.
- [ ] Show checkpoint list in or near Edits.
- [ ] Investigate whether safe restore/revert is feasible with available VS Code/git state.

## 8.6 Terminal Integration

- [ ] Use Augment as architecture reference only, not source code.
- [ ] Prefer public Auggie repo/docs/issues/releases for ACP/MCP/terminal behavior clues before inspecting installed extension bundles.
- [x] Record first public Auggie docs pass:
  - ACP mode uses `auggie --acp`.
  - ACP mode does not guarantee every interactive-mode feature.
  - MCP config is first-class in Auggie via `mcpServers`, `auggie mcp ...`, and `--mcp-config`.
  - Internal shell/process tool is referenced as `launch-process`.
- [x] Confirm Augment had a configurable terminal strategy:
  - VS Code built-in terminal events
  - Augment customized terminal support
- [x] Confirm Augment contributed "Add Selection to Augment Chat" for selected terminal text.
- [x] Confirm Augment also had a separate tool-use-state/action-card model with phases like waiting/running/completed/error.
- [x] Capture key architecture lesson: visible terminal execution only happens when the agent's command tool is wired to the terminal strategy; action cards are a separate review layer.
- [x] Confirm this ACP client advertises terminal capability and has terminal/create, output, wait, kill, and release handlers.
- [x] Replace the first-choice terminal backend with VS Code shell integration so ACP terminal requests execute in a visible VS Code terminal.
- [x] Keep the previous spawn/pseudoterminal backend as a fallback when shell integration is unavailable.
- [x] Smoke test whether Auggie actually sends terminal/create requests for command tools.
- [x] Confirm first smoke test did not call terminal/create; Auggie emitted internal `tool_call` / `tool_call_update` events instead.
- [x] Add `acp.mcpServers` plumbing so configured MCP servers are passed into session/new, session/load, and session/resume.
- [x] Normalize `acp.mcpServers` so users can paste Auggie-style object configs or ACP-style arrays.
- [x] Expand `${workspaceFolder}` in MCP command/args/url values before passing servers to ACP sessions.
- [x] Note that MCP plumbing has no visible behavior to test until a server is configured or implemented.
- [x] Investigate whether Auggie will actually use client-provided MCP tools for command execution.
- [x] Add first VS Code-terminal-backed MCP tool path:
  - extension-host localhost bridge
  - stdio MCP helper script
  - `run_command_in_vscode_terminal` tool
  - automatic session attachment as `auggie-vscode-terminal`
- [x] Smoke test whether Auggie chooses `run_command_in_vscode_terminal` when explicitly asked.
- [x] Diagnose first failed MCP smoke test:
  - Bridge/session attach logs appeared.
  - Auggie said the tool was unavailable.
  - Output showed MCP server startup timeout.
  - Root issue was helper startup/framing, not Auggie choosing another tool.
- [x] Make MCP helper tolerate Content-Length CRLF, Content-Length LF, and newline-delimited JSON startup framing.
- [x] Retest MCP helper registration inside Auggie after dev-host restart.
- [x] Improve tool description/schema so Auggie naturally prefers it for terminal requests.
- [x] Consider exposing friendlier alias tools:
  - `run_terminal_command`
  - `run_command`
  - `run_in_vscode_terminal`
- [x] Reverify alias implementation and local checks in `vscode-acp` on 2026-07-04.
- [x] Smoke test whether Auggie naturally chooses the visible-terminal MCP path from prompts like `Run node --version in the VS Code terminal.`
- [x] Confirm Auggie no longer remains internal-only for natural visible-terminal prompts.
- [x] Add richer terminal command cards that parse common ACP/MCP command payload fields and the local visible-terminal MCP summary text.
- [x] Smoke test richer terminal command cards in the Extension Development Host.
- [ ] Low priority: add "Add terminal selection/output to Auggie" command and terminal context menu entry.
- [ ] Low priority: attach selected terminal text to the next prompt as context.

## 9. Visual Polish

- [ ] Tighten spacing around messages and composer.
- [ ] Match menu/dropdown colors to VS Code theme variables.
- [ ] Use consistent icon buttons and hover states.
- [ ] Fix borders/dividers for the sidebar proportions.
- [ ] Check narrow sidebar behavior.

## 10. Final Cleanup

- [ ] Remove temporary diagnostics.
- [x] Run compile and lint.
- [x] Package locally for a clean smoke test.
- [x] Rebuild VSIX after README/package metadata cleanup.
- [ ] Install packaged VSIX on the work machine and confirm it runs beside the original Augment extension.
- [ ] Commit a stable baseline.
