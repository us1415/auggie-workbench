import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';
import { sanitizeTerminalOutput } from '../utils/terminalOutput';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { spawn, ChildProcess } from 'node:child_process';

interface ManagedTerminal {
  id: string;
  process?: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal?: vscode.Terminal;
  mode: 'shellIntegration' | 'spawn';
}

export interface VisibleCommandRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputByteLimit?: number;
}

export interface VisibleCommandResult {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  terminalId: string;
}

/**
 * Manages terminals that ACP agents request (terminal/create, terminal/output, etc.).
 * Uses real child processes for capturing output, with VS Code terminals for display.
 */
export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1MB default

    log(`createTerminal: ${params.command} ${(params.args || []).join(' ')} (id=${terminalId})`);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const v of params.env) {
        env[v.name] = v.value;
      }
    }

    const realTerminal = await this.tryCreateShellIntegrationTerminal(
      terminalId,
      params,
      env,
      outputByteLimit,
    );
    if (realTerminal) {
      return { terminalId };
    }

    return this.createSpawnTerminal(terminalId, params, env, outputByteLimit);
  }

  async runVisibleCommand(params: VisibleCommandRequest): Promise<VisibleCommandResult> {
    const terminal = await this.createTerminal({
      sessionId: 'auggie-vscode-terminal-mcp',
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      env: Object.entries(params.env ?? {}).map(([name, value]) => ({ name, value })),
      outputByteLimit: params.outputByteLimit ?? 1024 * 1024,
    });

    const timeoutMs = Math.max(1000, params.timeoutMs ?? 120000);
    let timedOut = false;

    const wait = this.waitForTerminalExit({ sessionId: 'auggie-vscode-terminal-mcp', terminalId: terminal.terminalId });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    await Promise.race([wait.then(() => undefined), timeout]);

    if (timedOut) {
      await this.killTerminal({ sessionId: 'auggie-vscode-terminal-mcp', terminalId: terminal.terminalId });
    }

    const output = await this.terminalOutput({ sessionId: 'auggie-vscode-terminal-mcp', terminalId: terminal.terminalId });
    if (output.exitStatus || timedOut) {
      await this.releaseTerminal({ sessionId: 'auggie-vscode-terminal-mcp', terminalId: terminal.terminalId }).catch((e) => {
        logError(`Failed to release visible terminal ${terminal.terminalId}`, e);
      });
    }

    return {
      // Strip terminal control sequences (shell-integration OSC markers, color
      // codes) so command output renders cleanly in the chat action cards.
      output: sanitizeTerminalOutput(output.output),
      truncated: output.truncated,
      exitCode: output.exitStatus?.exitCode ?? null,
      signal: output.exitStatus?.signal ?? null,
      timedOut,
      terminalId: terminal.terminalId,
    };
  }

  private appendManagedOutput(managed: ManagedTerminal, text: string): void {
    managed.output += text;
    const byteLength = Buffer.byteLength(managed.output, 'utf-8');
    if (byteLength <= managed.outputByteLimit) { return; }

    const excess = byteLength - managed.outputByteLimit;
    let cutPoint = 0;
    let bytes = 0;
    for (let i = 0; i < managed.output.length; i++) {
      bytes += Buffer.byteLength(managed.output[i], 'utf-8');
      if (bytes >= excess) {
        cutPoint = i + 1;
        break;
      }
    }
    managed.output = managed.output.substring(cutPoint);
    managed.truncated = true;
  }

  private async waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return terminal.shellIntegration;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        resolve(terminal.shellIntegration);
      }, timeoutMs);

      const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal !== terminal) { return; }
        clearTimeout(timer);
        disposable.dispose();
        resolve(event.shellIntegration);
      });
    });
  }

  private async tryCreateShellIntegrationTerminal(
    terminalId: string,
    params: CreateTerminalRequest,
    env: Record<string, string>,
    outputByteLimit: number,
  ): Promise<boolean> {
    const vsTerminal = vscode.window.createTerminal({
      name: `Auggie: ${params.command}`,
      cwd: params.cwd || undefined,
      env,
    });
    vsTerminal.show(true);

    const shellIntegration = await this.waitForShellIntegration(vsTerminal, 3000);
    if (!shellIntegration) {
      vsTerminal.dispose();
      log(`createTerminal: shell integration unavailable, falling back to spawn terminal (id=${terminalId})`);
      return false;
    }
    log(`createTerminal: using VS Code shell integration terminal (id=${terminalId})`);

    let resolveExit: (() => void) | undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const managed: ManagedTerminal = {
      id: terminalId,
      output: '',
      truncated: false,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise,
      vsTerminal,
      mode: 'shellIntegration',
    };
    this.terminals.set(terminalId, managed);

    let execution: vscode.TerminalShellExecution;
    try {
      execution = shellIntegration.executeCommand(params.command, params.args || []);
    } catch (e) {
      this.terminals.delete(terminalId);
      vsTerminal.dispose();
      logError(`createTerminal: shell integration execution failed, falling back to spawn terminal (id=${terminalId})`, e);
      return false;
    }

    const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution !== execution) { return; }
      managed.exitCode = event.exitCode ?? null;
      managed.exitSignal = null;
      managed.exited = true;
      endDisposable.dispose();
      resolveExit?.();
    });

    void (async () => {
      try {
        for await (const data of execution.read()) {
          this.appendManagedOutput(managed, data);
        }
      } catch (e) {
        logError(`Failed reading terminal output for ${terminalId}`, e);
      }
    })();

    return true;
  }

  private createSpawnTerminal(
    terminalId: string,
    params: CreateTerminalRequest,
    env: Record<string, string>,
    outputByteLimit: number,
  ): CreateTerminalResponse {

    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || undefined,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let truncated = false;

    const appendOutput = (data: Buffer) => {
      const text = data.toString();
      output += text;
      // Truncate from beginning if over limit
      const byteLength = Buffer.byteLength(output, 'utf-8');
      if (byteLength > outputByteLimit) {
        const excess = byteLength - outputByteLimit;
        // Find a safe character boundary to truncate at
        let cutPoint = 0;
        let bytes = 0;
        for (let i = 0; i < output.length; i++) {
          bytes += Buffer.byteLength(output[i], 'utf-8');
          if (bytes >= excess) {
            cutPoint = i + 1;
            break;
          }
        }
        output = output.substring(cutPoint);
        truncated = true;
      }
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        const managed = this.terminals.get(terminalId);
        if (managed) {
          managed.exitCode = code;
          managed.exitSignal = signal;
          managed.exited = true;
        }
        resolve();
      });
      child.on('error', () => {
        resolve();
      });
    });

    // Also create a VS Code terminal for visual output
    const writeEmitter = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open() {
        writeEmitter.fire(`$ ${params.command} ${(params.args || []).join(' ')}\r\n`);
      },
      close() { /* no-op */ },
    };
    const vsTerminal = vscode.window.createTerminal({
      name: `ACP: ${params.command}`,
      pty,
    });

    // Stream output to VS Code terminal
    child.stdout?.on('data', (data: Buffer) => {
      writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
    });
    child.stderr?.on('data', (data: Buffer) => {
      writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
    });

    const managed: ManagedTerminal = {
      id: terminalId,
      process: child,
      output: '',
      truncated: false,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise,
      vsTerminal,
      mode: 'spawn',
    };

    // Keep output reference updated
    const timer = setInterval(() => {
      managed.output = output;
      managed.truncated = truncated;
    }, 100);

    child.on('close', () => {
      managed.output = output;
      managed.truncated = truncated;
      clearInterval(timer);
    });

    this.terminals.set(terminalId, managed);

    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const response: TerminalOutputResponse = {
      output: managed.output,
      truncated: managed.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await managed.exitPromise;

    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    try {
      if (managed.mode === 'shellIntegration') {
        managed.vsTerminal?.sendText('\x03', false);
      } else {
        managed.process?.kill('SIGTERM');
      }
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }

    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    log(`releaseTerminal: ${params.terminalId}`);

    // Kill if still running
    if (!managed.exited) {
      try {
        if (managed.mode === 'shellIntegration') {
          managed.vsTerminal?.sendText('\x03', false);
        } else {
          managed.process?.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    }

    // Don't dispose VS Code terminal — keep output visible per ACP spec
    this.terminals.delete(params.terminalId);

    return {};
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      try {
        if (!managed.exited) {
          if (managed.mode === 'shellIntegration') {
            managed.vsTerminal?.sendText('\x03', false);
          } else {
            managed.process?.kill('SIGKILL');
          }
        }
        managed.vsTerminal?.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
