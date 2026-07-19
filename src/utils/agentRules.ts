import type { AgentConfigEntry } from '../config/AgentConfig';

/**
 * True when the agent is (some form of) the Auggie CLI. Detected loosely from
 * the command + args so it matches `@augmentcode/auggie`, a bare `auggie`
 * binary, or a custom wrapper, without hard-coding one exact invocation.
 */
export function isAuggieAgent(config: AgentConfigEntry): boolean {
  const haystack = [config.command, ...(config.args ?? [])].join(' ').toLowerCase();
  return haystack.includes('auggie');
}

/**
 * Append `--rules <rulesPath>` to an Auggie agent's args so it always loads the
 * bundled rule that steers it to the visible VS Code terminal.
 *
 * No-op when: there is no rules path, the agent is not Auggie (the `--rules`
 * flag is Auggie-specific and would break other ACP agents such as claude-code),
 * or the flag is already present (respect a user-supplied `--rules`).
 */
export function withAuggieRules(
  config: AgentConfigEntry,
  rulesPath: string | undefined,
): AgentConfigEntry {
  if (!rulesPath || !isAuggieAgent(config)) {
    return config;
  }
  const args = config.args ?? [];
  if (args.includes('--rules')) {
    return config;
  }
  return { ...config, args: [...args, '--rules', rulesPath] };
}
