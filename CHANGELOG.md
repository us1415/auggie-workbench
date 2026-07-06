# Changelog

All notable changes to Auggie Workbench are documented here.

This project started from the open-source ACP Client for VS Code and is now being shaped into a focused Auggie CLI workbench. Older ACP Client release history is intentionally not repeated here because this branch is tracking the Auggie Workbench fork/package path.

## [0.2.2] - 2026-07-06

### Fixed

- Added startup failure classification for Auggie/npm stderr so Node engine failures report a useful message instead of only `ACP connection closed`.
- Captured recent agent stderr lines in the extension host for better connection-failure diagnostics.
- Guarded older-thread loading so clicking multiple past sessions while one replay is still loading does not start overlapping loads or stack duplicate `Loading session...` notifications.

### Verified

- Work-machine install runs beside the original extension after namespacing.
- Work-machine Auggie launch succeeds with supported Node/runtime configuration.
- Natural terminal requests route through the visible-terminal MCP bridge:
  - `Run node --version in the VS Code terminal.`
  - `run git status`
- Large older-thread replay works but can take a noticeable time; progress feedback remains a follow-up.

### Documentation

- Documented correct custom Auggie binary configuration:
  - direct binary path goes in `command`
  - `--acp` stays in `args`
  - `npx` should only be used with the package form `@augmentcode/auggie@latest`
- Expanded custom command documentation for work machines with custom Node installs:
  - how to find `node`, `npx`, and `auggie` paths on Windows
  - how to find `node`, `npx`, and `auggie` paths on macOS
  - direct `auggie.cmd` example
  - direct Homebrew `/opt/homebrew/bin/auggie` and `/usr/local/bin/auggie` examples
  - explicit Node 22/23 `npx.cmd` examples
  - explicit Homebrew, nvm, and asdf `npx` examples
  - guidance for Node managers and locked-down work environments
- Added configuration examples for:
  - global and per-agent `auggie.mcpServers`
  - Auggie-style object MCP config and ACP-style array MCP config
  - HTTP MCP servers with headers
  - `auggie.defaultWorkingDirectory`
  - `auggie.autoApprovePermissions`
  - `auggie.logTraffic`
  - `auggie.autoConnectAuggie`
- Documented the work-machine failure where Auggie rejects Node `v24.4.0`; Auggie currently requires Node `>=22.14.0 <24`.

## [0.2.1] - 2026-07-06

### Fixed

- Fixed side-by-side installation with the original ACP Client / Augment-related extensions by namespacing Auggie Workbench contribution IDs:
  - view container id: `auggie-workbench`
  - thread tree view id: `auggie-sessions`
  - chat view id: `auggie-chat`
  - commands: `auggie.*`
  - turn-in-progress context key: `auggie.turnInProgress`
- Moved this fork's contributed settings from `acp.*` to `auggie.*` so Auggie Workbench no longer shares configuration keys with the original ACP Client extension.
- Updated the VS Code extension test baseline to assert the `auggie.*` command namespace.

## [0.2.0] - 2026-07-05

### Added

- Auggie-focused extension identity:
  - display name: `Auggie Workbench`
  - extension id: `local.auggie-workbench`
  - activity bar title: `Auggie`
- Default Auggie launch configuration using `npx @augmentcode/auggie@latest --acp`.
- Auggie workbench shell with Thread, Tasks, and Edits tabs.
- Recent thread tree with active-thread marker, refresh support, open latest, and open older thread flow.
- Composer context controls for files, folders, recently opened files, selected code, rules/context chips, and prompt controls.
- Task view backed by ACP plan updates, persisted task snapshots, and fallback plan-like text recovery.
- Reviewable action cards for tool activity with expandable details.
- File/read/search/execute card fallbacks when Auggie exposes useful details only in card titles.
- Git-backed Edits view with:
  - tracked changed-file list
  - added/removed line totals
  - untracked-file detection
  - binary-file labels
  - expandable diff or added-line previews
  - Open and Diff actions
  - guarded row-level discard and Discard All controls
  - live refresh on workspace file create, save, rename, and delete events
- Visible terminal command path:
  - VS Code shell-integration terminal backend
  - fallback pseudoterminal backend
  - extension-host localhost bridge
  - built-in stdio MCP helper at `scripts/auggie-terminal-mcp.js`
  - automatic MCP session attachment as `auggie-vscode-terminal`
- Built-in terminal MCP aliases:
  - `run_command_in_vscode_terminal`
  - `run_terminal_command`
  - `run_command`
  - `run_in_vscode_terminal`
- Terminal card side-channel so visible-terminal MCP runs can show command, terminal id, exit status, timeout/truncation flags, and output even when Auggie ACP payloads are sparse.
- Packaging guardrails in `.vscodeignore` so the VSIX includes runtime assets and excludes repo/dev artifacts.
- Local packaged artifact: `auggie-workbench-0.2.0.vsix`.
- Auggie Workbench README with install, smoke-test, command, settings, terminal MCP, development, and limitation notes.

### Changed

- Reworked the original multi-agent ACP Client framing into an Auggie-first sidebar experience.
- Updated package metadata links to `https://github.com/us1415/vscode-acp`.
- Renamed user-facing commands and views from ACP Client language to Auggie language where practical.
- Improved MCP server config handling:
  - accepts ACP-style arrays and Auggie-style objects keyed by server name
  - supports env object or `{ name, value }` array shapes
  - expands `${workspaceFolder}` in command, args, and URL fields
- Improved action-card parsing for command, args, cwd, file path, search query, URL, HTTP method, result count, summary/message, output, and preview content.
- Replaced the upstream README in the packaged VSIX with Auggie Workbench documentation.

### Fixed

- Fixed webview loading by externalizing the chat script to `media/chatWebview.js`.
- Fixed startup restore flows to reduce duplicate open/restore behavior and old conversation flashes.
- Fixed task persistence across dev-host reloads by persisting rendered task snapshots in extension workspace state.
- Fixed task-title recovery for hyphenated titles.
- Fixed MCP helper startup timeout by supporting Content-Length CRLF, Content-Length LF, and newline-delimited JSON framing.
- Fixed visible-terminal card details when Auggie reports only generic `other` tool payloads.
- Fixed read/search/execute action-card summaries when the useful file/query/command data appears only in the tool title.
- Fixed Edits tab freshness for ordinary workspace file changes.

### Verified

- User smoke-tested natural prompt terminal execution:
  - `Run node --version in the VS Code terminal.`
  - Auggie selected the visible-terminal MCP path.
  - VS Code terminal ran the command and returned `v22.14.0`.
- User smoke-tested expanded terminal card details.
- User smoke-tested file read and command/search action-card summaries.
- User smoke-tested Edits tab untracked-file display, untracked text preview, binary labels, and row-level discard on a disposable file.
- User smoke-tested recent/open older thread behavior.
- Packaging smoke verified the VSIX includes:
  - `extension/dist/extension.js`
  - `extension/media/chatWebview.js`
  - `extension/scripts/auggie-terminal-mcp.js`
  - package metadata, README, license, and resources
- Packaging smoke verified the VSIX excludes:
  - `.agents`
  - `.github`
  - `AUGGIE_*.md`
  - `Photos-*.zip`
  - generated `.vsix`
  - source maps
  - declaration files
  - dist test output
- Latest local checks passed:
  - `cmd /c npm run compile`
  - `cmd /c npm run lint`
  - `cmd /c npx vsce package --out auggie-workbench-0.2.0.vsix`

### Known Limitations

- Auggie chooses which tools to call; the visible-terminal MCP bridge makes terminal execution available but does not force every command through it.
- Terminal card output previews still need ANSI/OSC/control-sequence cleanup.
- External/web action-card summaries need a real Auggie web-style tool payload to validate.
- `Discard All` has not been smoke-tested against only disposable changes.
- Checkpoints are planned but not implemented.
- Some reload/open-latest and loading-overlay polish remains on the TODO list.

## Attribution

Auggie Workbench is built from the open-source ACP Client for VS Code foundation. The current changelog tracks the Auggie Workbench fork/package work rather than the upstream ACP Client release history.
