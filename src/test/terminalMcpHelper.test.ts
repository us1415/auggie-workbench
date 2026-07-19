import * as assert from 'assert';
import * as path from 'path';

// The terminal MCP helper is a plain CommonJS script. Requiring it (so
// require.main !== module) exposes its tool table without starting the stdio
// server loop. __dirname at test-run time is <repo>/out/test, so ../../scripts
// resolves back to the source script.
const helperPath = path.resolve(__dirname, '..', '..', 'scripts', 'auggie-terminal-mcp.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const helper = require(helperPath);

// The full set of tool names Auggie should be able to discover for running a
// command in the visible VS Code terminal. If the extension trims or renames
// these, this test is the tripwire.
const EXPECTED_ALIASES = [
  'run_command_in_vscode_terminal',
  'run_terminal_command',
  'run_command',
  'run_in_vscode_terminal',
];

suite('Terminal MCP helper', () => {
  test('advertises every visible-terminal alias', () => {
    const names: string[] = helper.toolDefinitions.map((t: any) => t.name);
    for (const alias of EXPECTED_ALIASES) {
      assert.ok(names.includes(alias), `missing alias tool: ${alias}`);
    }
  });

  test('advertises no unexpected or duplicate tools', () => {
    const names: string[] = helper.toolDefinitions.map((t: any) => t.name);
    assert.deepStrictEqual([...names].sort(), [...EXPECTED_ALIASES].sort());
    assert.strictEqual(names.length, new Set(names).size, 'duplicate tool names');
  });

  test('advertised tools match the callable dispatch set', () => {
    // toolNames gates tools/call; if it drifts from toolDefinitions, a tool can
    // be advertised but rejected on call (or vice versa).
    const advertised = helper.toolDefinitions.map((t: any) => t.name).sort();
    const callable = [...helper.toolNames].sort();
    assert.deepStrictEqual(callable, advertised);
  });

  test('every tool requires a command and is described as a terminal tool', () => {
    for (const tool of helper.toolDefinitions) {
      const def = helper.toolDefinition(tool);
      assert.strictEqual(def.name, tool.name);
      assert.ok(
        def.inputSchema.required.includes('command'),
        `${tool.name} must require a command argument`,
      );
      assert.ok(
        /terminal/i.test(tool.description),
        `${tool.name} description should steer the model to the terminal`,
      );
    }
  });
});
