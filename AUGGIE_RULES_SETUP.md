# Setting up Augment / Auggie rules (verified)

A practical, docs-verified guide to adding custom rules/guidelines to Augment —
on the Auggie CLI (personal machine) and the Augment VS Code extension (work
machine).

## First: the `AUGMENT.md` answer is WRONG

When asked "how do you load your rules," Auggie will confidently tell you to
create an `AUGMENT.md` file inside a `.augment` directory. **That is a
confabulation** — an LLM guessing about its own configuration. It contradicts
itself if you press it, and the official docs never mention `AUGMENT.md`. Do
not set that up; it will not be loaded. Use the real locations below.

### If you already created `AUGMENT.md` (fix a wrong setup)

If you previously followed Auggie's advice and created an `AUGMENT.md`, it is
NOT being loaded — remove it and set up the correct location instead:

```powershell
# PowerShell (Windows) - check both likely spots and delete if present
Remove-Item -ErrorAction SilentlyContinue "$HOME\.augment\AUGMENT.md"
Remove-Item -ErrorAction SilentlyContinue ".\.augment\AUGMENT.md"
```

```bash
# bash (macOS/Linux)
rm -f ~/.augment/AUGMENT.md ./.augment/AUGMENT.md
```

Then follow "Recommended" below to put the rule where it will actually load.

## Real rule locations

### Augment VS Code extension (work machine)

- **User Guidelines — all projects, always applied:** `~/.augment/user-guidelines.md`
  (also editable via **Settings > Rules and User Guidelines** in the extension).
- **User rules folder — all projects, always applied:** `~/.augment/rules/*.md`
  (name the files whatever you want).
- **Workspace rules — one project:** `<repo>/.augment/rules/*.md`. These support
  three types via frontmatter: `Always` (every prompt), `Manual` (only when you
  `@`-attach it), `Auto` (agent attaches it based on a `description` field).

User-scope rules are always treated as `Always` and included in every prompt.

### Auggie CLI / ACP (personal machine, e.g. Auggie Workbench)

Loaded in this precedence (all layered):

1. `--rules <file>` flag (highest)
2. `CLAUDE.md` at the repo root
3. `AGENTS.md` at the repo root
4. `<repo>/.augment-guidelines`
5. `<repo>/.augment/rules/*.md` (workspace, searched recursively)
6. `~/.augment/rules/*.md` (**user-level, all projects**, searched recursively)

## Recommended: one user-level file for "all my projects"

For a preference you want everywhere, create a single user-level rule. This
works for both the extension and the CLI:

```powershell
# PowerShell (Windows)
New-Item -ItemType Directory -Force "$HOME\.augment\rules" | Out-Null
# then create $HOME\.augment\rules\visible-terminal.md with the content below
```

```bash
# bash/zsh (macOS/Linux) - one paste: creates the folder AND writes the rule
mkdir -p ~/.augment/rules
cat > ~/.augment/rules/visible-terminal.md <<'EOF'
# Run commands in the visible VS Code terminal

When any of these terminal tools is available, ALWAYS use it to run shell or
terminal commands instead of the internal `launch-process` tool:

- run_command_in_vscode_terminal
- run_terminal_command
- run_command
- run_in_vscode_terminal

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
EOF
```

On the extension specifically, `~/.augment/user-guidelines.md` is the dedicated
per-user guidelines file if you prefer a single flat file over a `rules/` folder.

## Example rule content (`visible-terminal.md`)

This is the exact rule Auggie Workbench ships and auto-loads via `--rules`. Most
useful when you drive Auggie over ACP/CLI (its internal tool runs commands
invisibly). Note: the Augment VS Code extension already runs commands in your
real terminal natively, so this specific rule is less relevant there.

```markdown
# Run commands in the visible VS Code terminal

When any of these terminal tools is available, ALWAYS use it to run shell or
terminal commands instead of the internal `launch-process` tool:

- run_command_in_vscode_terminal
- run_terminal_command
- run_command
- run_in_vscode_terminal

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
```

## Verify it actually loaded

Don't just ask the AI "what rules are you following?" — its self-report is
unreliable (see the `AUGMENT.md` fiasco). Instead:

- **Extension:** check **Settings > Rules and User Guidelines** — your rule
  should be listed there.
- **Best test either way:** put a rule with a small, *observable* instruction
  (e.g. "always start your first reply with the word ACK") and confirm the
  behavior actually changes in a new session. If it does, rule loading works.

## Caveat

A rule is a strong nudge, not a hard guarantee — the model can still deviate,
and adherence varies by model. That's why Auggie Workbench also warns loudly if
it ever has to fall back to running a command invisibly.

## Sources

- Augment VS Code extension — Rules & Guidelines: https://docs.augmentcode.com/setup-augment/guidelines
- Auggie CLI — Rules & Guidelines: https://docs.augmentcode.com/cli/rules
