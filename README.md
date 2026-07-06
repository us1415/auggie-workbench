# Auggie Workbench

Auggie Workbench is a personal VS Code sidebar for the Auggie CLI, built on the Agent Client Protocol (ACP). It focuses on the coding-agent workflow: chat, thread history, task progress, visible terminal execution, action cards, and reviewable file changes in one workspace view.

This project is based on the open-source ACP Client for VS Code and has been adapted into a focused Auggie experience.

![Auggie Workbench screenshot](resources/screenshot.png)

## Features

- **Auggie-first workflow**: Starts Auggie through `npx @augmentcode/auggie@latest --acp` by default.
- **Thread history**: Shows recent Auggie conversations in the Threads view and lets you reopen older threads when the agent exposes session support.
- **Workbench tabs**: Thread, Tasks, and Edits views keep chat, plan progress, and workspace changes close together.
- **Visible terminal bridge**: Provides a built-in MCP server with terminal command tools that run commands in the VS Code integrated terminal.
- **Reviewable action cards**: Tool calls expand into cards with command, file, search, URL, output, and preview details when the agent exposes them.
- **Edits review**: Shows changed files, line deltas, untracked files, binary labels, diff previews, Open/Diff actions, and guarded discard controls.
- **Composer context**: Supports file/folder context chips, recently opened files, selected-code context, and prompt controls.
- **ACP traffic and logs**: Keeps protocol and workbench output available for debugging.

## Requirements

- VS Code 1.85+
- Node.js 18+
- `npm` / `npx` available on your PATH
- Access to run `npx @augmentcode/auggie@latest --acp`
- Any Auggie authentication or account setup required by your environment

Work machines with locked-down network/proxy settings may need Node/npm/proxy configuration before Auggie can start through `npx`.

## Install From VSIX

Install the packaged build from this repository:

```powershell
code --install-extension auggie-workbench-0.2.1.vsix
```

Or in VS Code:

1. Open Extensions.
2. Choose `...`.
3. Select `Install from VSIX...`.
4. Pick `auggie-workbench-0.2.1.vsix`.
5. Reload VS Code.

The extension id is `local.auggie-workbench`, so it can be installed beside the original Augment extension without replacing it.

## First Smoke Test

1. Open a workspace in VS Code.
2. Open the Auggie activity view.
3. Wait for Auggie to connect, or run `Auggie: Start` from the Command Palette.
4. Send:

```text
Run node --version in the VS Code terminal.
```

Expected result:

- Auggie chooses the visible-terminal MCP tool.
- A VS Code integrated terminal opens or reuses an Auggie terminal.
- The terminal runs `node --version`.
- The thread shows an expandable completed tool card with command, terminal id, exit code, and output.

## Commands

Common commands are available from the Command Palette:

| Command | Description |
|---------|-------------|
| `Auggie: Start` | Start/connect Auggie |
| `Auggie: New Thread` | Start a new conversation |
| `Auggie: Focus Prompt` | Focus the prompt box |
| `Auggie: Stop` | Cancel the active turn |
| `Auggie: Restart` | Restart the Auggie process |
| `Auggie: Disconnect` | Disconnect the current Auggie process |
| `Auggie: Open Chat` | Focus the Auggie workbench |
| `Auggie: Open Latest Thread` | Open the latest known thread |
| `Auggie: Refresh Threads` | Refresh known threads |
| `Auggie: Show Log` | Open the Auggie Workbench log |
| `Auggie: Show Protocol Traffic` | Open ACP protocol traffic logs |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `auggie.agents` | Auggie CLI | Auggie launch command. Defaults to `npx @augmentcode/auggie@latest --acp`. |
| `auggie.mcpServers` | `{}` | Extra MCP servers to attach to each ACP session. Accepts Auggie-style object config or ACP-style arrays. |
| `auggie.autoApprovePermissions` | `ask` | Permission policy for agent actions. |
| `auggie.defaultWorkingDirectory` | `""` | Default working directory. Empty uses the current workspace. |
| `auggie.logTraffic` | `true` | Log ACP protocol traffic. |
| `auggie.autoConnectAuggie` | `true` | Automatically connect when the Auggie sidebar activates. |

## Built-In Terminal MCP Tools

Auggie Workbench automatically attaches a local MCP server named `auggie-vscode-terminal` to Auggie sessions. It exposes these equivalent tools:

- `run_command_in_vscode_terminal`
- `run_terminal_command`
- `run_command`
- `run_in_vscode_terminal`

All four forward to the same local extension bridge and run commands through the VS Code integrated terminal when possible.

## Development

```powershell
npm install
cmd /c npm run compile
cmd /c npm run lint
```

Press `F5` in VS Code to launch the Extension Development Host.

Package a VSIX:

```powershell
cmd /c npx vsce package --out auggie-workbench-0.2.1.vsix
```

## Current Limitations

- Auggie decides which tools to use; the terminal MCP bridge makes visible terminal execution available but does not force every command through it.
- Tasks depend on ACP plan updates or recovered plan-like assistant text.
- Some action-card details depend on what Auggie exposes in ACP tool payloads.
- Terminal output previews still need additional ANSI/OSC/control-sequence cleanup.
- Checkpoints are planned but not implemented yet.

## License

MIT. See [LICENSE](LICENSE) for details.
