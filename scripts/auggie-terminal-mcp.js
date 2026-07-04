#!/usr/bin/env node

const bridgeUrl = process.env.AUGGIE_TERMINAL_BRIDGE_URL;
const bridgeToken = process.env.AUGGIE_TERMINAL_BRIDGE_TOKEN;

let inputBuffer = Buffer.alloc(0);
let outputMode = 'content-length';

const toolDefinitions = [
  {
    name: 'run_command_in_vscode_terminal',
    description: 'Run a shell command in a real user-visible VS Code terminal for this workspace. Use this when the user asks to run a command, terminal command, npm script, git command, test, linter, compiler, or shell command and should be able to see it in VS Code.',
  },
  {
    name: 'run_terminal_command',
    description: 'Run a terminal command in the visible VS Code integrated terminal for this workspace and return the captured output. Prefer this over background process tools when the user asks to run something in the terminal.',
  },
  {
    name: 'run_command',
    description: 'Run a workspace shell command in the visible VS Code terminal and return captured output. Use for commands like npm, node, git, tests, compilers, linters, and other CLI tasks.',
  },
  {
    name: 'run_in_vscode_terminal',
    description: 'Run a command in the user-visible VS Code integrated terminal for this workspace, keeping the terminal output visible while also returning captured output.',
  },
];

function writeMessage(message) {
  const bodyText = JSON.stringify(message);
  if (outputMode === 'ndjson') {
    process.stdout.write(`${bodyText}\n`);
    return;
  }

  const body = Buffer.from(bodyText, 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function readHeaders(buffer) {
  let separator = buffer.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (separator === -1) {
    separator = buffer.indexOf('\n\n');
    separatorLength = 2;
  }
  if (separator === -1) {
    return null;
  }

  const headerText = buffer.subarray(0, separator).toString('utf8');
  const contentLength = headerText
    .split(/\r?\n/)
    .map((line) => line.match(/^Content-Length:\s*(\d+)$/i))
    .find(Boolean)?.[1];

  if (!contentLength) {
    throw new Error('Missing Content-Length header.');
  }

  return {
    contentLength: Number(contentLength),
    bodyStart: separator + separatorLength,
  };
}

function drainContentLengthMessages() {
  const header = readHeaders(inputBuffer);
  if (!header) {
    return false;
  }

  outputMode = 'content-length';

  while (inputBuffer.length > 0) {
    const nextHeader = readHeaders(inputBuffer);
    if (!nextHeader) {
      return true;
    }

    const messageEnd = nextHeader.bodyStart + nextHeader.contentLength;
    if (inputBuffer.length < messageEnd) {
      return true;
    }

    const body = inputBuffer.subarray(nextHeader.bodyStart, messageEnd).toString('utf8');
    inputBuffer = inputBuffer.subarray(messageEnd);
    dispatchMessage(JSON.parse(body));
  }

  return true;
}

function drainNdjsonMessages() {
  const text = inputBuffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return false;
  }

  outputMode = 'ndjson';
  const completeText = text.slice(0, lastNewline);
  inputBuffer = Buffer.from(text.slice(lastNewline + 1), 'utf8');

  for (const line of completeText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    dispatchMessage(JSON.parse(trimmed));
  }
  return true;
}

function drainMessages() {
  if (drainContentLengthMessages()) {
    return;
  }
  drainNdjsonMessages();
}

function dispatchMessage(message) {
  handleMessage(message).catch((error) => {
    writeMessage({
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: {
        code: -32603,
        message: error?.message || String(error),
      },
    });
  });
}

const toolNames = new Set(toolDefinitions.map((tool) => tool.name));

function commandInputSchema() {
  return {
    type: 'object',
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: 'Executable or shell command to run, such as npm, node, git, or a full shell command.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional command arguments.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Defaults to the current workspace.',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional environment variables.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional timeout in milliseconds. Defaults to 120000.',
      },
      outputByteLimit: {
        type: 'number',
        description: 'Optional maximum captured output size in bytes. The VS Code terminal still keeps visible output.',
      },
    },
  };
}

function toolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      ...commandInputSchema(),
    },
  };
}

async function callBridge(argumentsObject) {
  if (!bridgeUrl || !bridgeToken) {
    throw new Error('VS Code terminal bridge is not configured.');
  }

  const response = await fetch(`${bridgeUrl}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridgeToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(argumentsObject || {}),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { output: text };
  }

  if (!response.ok) {
    throw new Error(parsed?.error || `Bridge returned HTTP ${response.status}`);
  }

  return parsed;
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return;
  }

  if (message.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'auggie-vscode-terminal',
          version: '0.1.0',
        },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    return;
  }

  if (message.method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: toolDefinitions.map(toolDefinition),
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    const toolName = message.params?.name;
    if (!toolNames.has(toolName)) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: `Unknown tool: ${toolName}`,
        },
      });
      return;
    }

    const result = await callBridge(message.params?.arguments);
    const summary = [
      `terminalId: ${result.terminalId}`,
      `exitCode: ${result.exitCode}`,
      `signal: ${result.signal}`,
      `timedOut: ${result.timedOut}`,
      `truncated: ${result.truncated}`,
      '',
      result.output || '',
    ].join('\n');

    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text: summary,
          },
        ],
      },
    });
    return;
  }

  if (message.id !== undefined) {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `Method not found: ${message.method}`,
      },
    });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainMessages();
});

process.stdin.on('error', (error) => {
  console.error(error?.stack || String(error));
});
