import * as assert from 'assert';
import { isAuggieAgent, withAuggieRules } from '../utils/agentRules';
import type { AgentConfigEntry } from '../config/AgentConfig';

const RULES = '/ext/rules/visible-terminal.md';

const auggie: AgentConfigEntry = {
  command: 'npx',
  args: ['@augmentcode/auggie@latest', '--acp'],
};

const claude: AgentConfigEntry = {
  command: 'npx',
  args: ['@zed-industries/claude-code-acp'],
};

suite('agentRules', () => {
  test('detects Auggie agents from command + args', () => {
    assert.strictEqual(isAuggieAgent(auggie), true);
    assert.strictEqual(isAuggieAgent({ command: 'auggie', args: ['--acp'] }), true);
    assert.strictEqual(isAuggieAgent(claude), false);
  });

  test('appends --rules for an Auggie agent', () => {
    const result = withAuggieRules(auggie, RULES);
    assert.deepStrictEqual(result.args, ['@augmentcode/auggie@latest', '--acp', '--rules', RULES]);
    // original config is not mutated
    assert.deepStrictEqual(auggie.args, ['@augmentcode/auggie@latest', '--acp']);
  });

  test('leaves non-Auggie agents untouched', () => {
    const result = withAuggieRules(claude, RULES);
    assert.strictEqual(result, claude);
  });

  test('is a no-op when no rules path is given', () => {
    const result = withAuggieRules(auggie, undefined);
    assert.strictEqual(result, auggie);
  });

  test('does not override a user-supplied --rules', () => {
    const custom: AgentConfigEntry = {
      command: 'npx',
      args: ['@augmentcode/auggie@latest', '--acp', '--rules', '/my/own.md'],
    };
    const result = withAuggieRules(custom, RULES);
    assert.strictEqual(result, custom);
    assert.strictEqual(result.args?.filter((a) => a === '--rules').length, 1);
  });
});
