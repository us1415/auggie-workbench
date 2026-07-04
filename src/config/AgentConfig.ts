import * as vscode from 'vscode';

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpMcpServer {
  type?: 'stdio' | 'http' | 'sse';
  name: string;
  command?: string;
  args?: string[];
  env?: AcpEnvVariable[];
  url?: string;
  headers?: Record<string, string>;
}

export type AuggieMcpServerConfig = Omit<AcpMcpServer, 'name' | 'env'> & {
  name?: string;
  env?: Record<string, string> | AcpEnvVariable[];
};

export type McpServerConfig = AcpMcpServer[] | Record<string, AuggieMcpServerConfig>;

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
  /** MCP servers to attach to sessions for this agent. */
  mcpServers?: McpServerConfig;
}

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acp');
  const agents = config.get<Record<string, AgentConfigEntry>>('agents', {});
  return agents;
}

/**
 * Get the list of agent names available.
 */
export function getAgentNames(): string[] {
  return Object.keys(getAgentConfigs());
}

/**
 * Get a specific agent config by name.
 */
export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}

function getWorkspaceFolderToken(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function expandWorkspaceFolder(value: string | undefined, workspaceFolder: string | undefined): string | undefined {
  if (!value || !workspaceFolder) {
    return value;
  }
  return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
}

function normalizeEnv(env: Record<string, string> | AcpEnvVariable[] | undefined): AcpEnvVariable[] | undefined {
  if (!env) {
    return undefined;
  }

  if (Array.isArray(env)) {
    return env
      .filter((entry) => typeof entry?.name === 'string' && typeof entry?.value === 'string')
      .map((entry) => ({ name: entry.name, value: entry.value }));
  }

  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
}

function normalizeMcpServers(configValue: McpServerConfig | undefined): AcpMcpServer[] {
  if (!configValue) {
    return [];
  }

  const workspaceFolder = getWorkspaceFolderToken();
  const entries: Array<[string | undefined, AuggieMcpServerConfig]> = Array.isArray(configValue)
    ? configValue.map((server) => [server.name, server])
    : Object.entries(configValue);

  return entries
    .map(([key, server]) => {
      const name = server.name ?? key;
      if (!name) {
        return undefined;
      }

      const normalized: AcpMcpServer = {
        name,
        type: server.type,
        command: expandWorkspaceFolder(server.command, workspaceFolder),
        args: server.args?.map((arg) => expandWorkspaceFolder(arg, workspaceFolder) ?? arg),
        env: normalizeEnv(server.env),
        url: expandWorkspaceFolder(server.url, workspaceFolder),
        headers: server.headers,
      };

      return normalized;
    })
    .filter((server): server is AcpMcpServer => Boolean(server));
}

/**
 * MCP servers passed to ACP session/new, session/load, and session/resume.
 *
 * Global `acp.mcpServers` applies to every agent. Per-agent `mcpServers`
 * are appended afterward so a specific agent can add its own tools.
 *
 * Accept both the ACP-client list shape and Auggie's documented
 * `mcpServers: { name: { ... } }` settings shape.
 */
export function getMcpServers(agentName: string): AcpMcpServer[] {
  const config = vscode.workspace.getConfiguration('acp');
  const globalServers = config.get<McpServerConfig>('mcpServers', []);
  const agentServers = getAgentConfig(agentName)?.mcpServers;
  return [...normalizeMcpServers(globalServers), ...normalizeMcpServers(agentServers)];
}
