import * as vscode from 'vscode';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { TerminalHandler, VisibleCommandRequest } from '../handlers/TerminalHandler';
import { AcpMcpServer } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

export interface TerminalMcpRunEvent {
  command: string;
  args?: string[];
  cwd?: string;
  terminalId: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  output: string;
}

export class TerminalMcpBridge {
  private readonly terminalHandler = new TerminalHandler();
  private readonly token = crypto.randomBytes(24).toString('hex');
  private readonly onDidRunCommandEmitter = new vscode.EventEmitter<TerminalMcpRunEvent>();
  readonly onDidRunCommand = this.onDidRunCommandEmitter.event;
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => {
        this.server?.off('error', reject);
        const address = this.server?.address();
        if (typeof address === 'object' && address?.port) {
          this.port = address.port;
          log(`Terminal MCP bridge listening on 127.0.0.1:${this.port}`);
          resolve();
        } else {
          reject(new Error('Terminal MCP bridge did not receive a TCP port.'));
        }
      });
    });
  }

  getMcpServer(): AcpMcpServer | null {
    if (!this.port) {
      return null;
    }

    const scriptPath = path.join(this.extensionUri.fsPath, 'scripts', 'auggie-terminal-mcp.js');
    return {
      name: 'auggie-vscode-terminal',
      type: 'stdio',
      command: 'node',
      args: [scriptPath],
      env: [
        { name: 'AUGGIE_TERMINAL_BRIDGE_URL', value: `http://127.0.0.1:${this.port}` },
        { name: 'AUGGIE_TERMINAL_BRIDGE_TOKEN', value: this.token },
      ],
    };
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/run') {
      this.sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.headers.authorization !== `Bearer ${this.token}`) {
      this.sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const body = await this.readBody(request);
      const commandRequest = this.parseCommandRequest(body);
      log(`Terminal MCP bridge run: ${commandRequest.command} ${(commandRequest.args ?? []).join(' ')}`);
      const result = await this.terminalHandler.runVisibleCommand(commandRequest);
      this.onDidRunCommandEmitter.fire({
        command: commandRequest.command,
        args: commandRequest.args,
        cwd: commandRequest.cwd,
        terminalId: result.terminalId,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        truncated: result.truncated,
        output: result.output,
      });
      this.sendJson(response, 200, result);
    } catch (e: any) {
      logError('Terminal MCP bridge request failed', e);
      this.sendJson(response, 400, { error: e?.message ?? String(e) });
    }
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error('Request body too large.'));
        }
      });
      request.on('end', () => resolve(body));
      request.on('error', reject);
    });
  }

  private parseCommandRequest(body: string): VisibleCommandRequest {
    const parsed = JSON.parse(body) as VisibleCommandRequest;
    if (!parsed.command || typeof parsed.command !== 'string') {
      throw new Error('Missing command.');
    }
    if (parsed.args && !Array.isArray(parsed.args)) {
      throw new Error('args must be an array.');
    }

    return {
      command: parsed.command,
      args: parsed.args?.map(String),
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      env: parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
        ? Object.fromEntries(Object.entries(parsed.env).map(([key, value]) => [key, String(value)]))
        : undefined,
      timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined,
      outputByteLimit: typeof parsed.outputByteLimit === 'number' ? parsed.outputByteLimit : undefined,
    };
  }

  private sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  dispose(): void {
    this.server?.close();
    this.server = null;
    this.port = null;
    this.terminalHandler.dispose();
    this.onDidRunCommandEmitter.dispose();
  }
}
