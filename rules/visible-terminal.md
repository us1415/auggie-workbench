# Run commands in the visible VS Code terminal

When any of these terminal tools is available, ALWAYS use it to run shell or
terminal commands instead of the internal `launch-process` tool:

- `run_command_in_vscode_terminal`
- `run_terminal_command`
- `run_command`
- `run_in_vscode_terminal`

This applies to every shell command, including commands you decide to run
yourself while diagnosing or fixing an issue (checking status, running tests,
git, builds, linters, port checks, etc.) - not only when the user explicitly
asks you to "run it in the terminal."

Running commands this way executes them in the user's visible VS Code
integrated terminal, so the user can watch what you are doing in real time and
stop a command with Ctrl+C if they need to.

If none of those tools is available in the current session, do NOT fall back to
the internal `launch-process` tool. Instead, STOP and tell the user that you
cannot run the command in the visible VS Code terminal, explain what is needed
to enable it, and wait. Only run the command another way if the user explicitly
tells you to proceed.
