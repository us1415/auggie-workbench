import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import { marked } from 'marked';
import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { logError } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

const execFileAsync = promisify(execFile);

type TaskSnapshot = {
  id: string;
  title: string;
  status: string;
  rawStatus: string;
};

type ChangedFileSnapshot = {
  file: string;
  added: number;
  removed: number;
  status: string;
  source: string;
  binary?: boolean;
  untracked?: boolean;
};

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;
  private autoRestore?: () => Promise<void> | void;
  private autoRestoreRequested = false;
  private webviewMessageDisposable?: vscode.Disposable;
  private changedFilesRefreshTimer?: NodeJS.Timeout;
  private readonly changedFilesWatchDisposables: vscode.Disposable[] = [];
  private readonly diffBaseContents = new Map<string, string>();
  private readonly diffBaseContentProviderDisposable: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly workspaceState?: vscode.Memento,
  ) {
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);

    this.diffBaseContentProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
      'auggie-diff-base',
      {
        provideTextDocumentContent: (uri) => this.diffBaseContents.get(uri.toString()) ?? '',
      },
    );

    this.changedFilesWatchDisposables.push(
      vscode.workspace.onDidCreateFiles(() => this.scheduleChangedFilesRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleChangedFilesRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleChangedFilesRefresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleChangedFilesRefresh()),
    );
  }

  /**
   * Render markdown text to HTML using marked.
   */
  private renderMarkdown(text: string): string {
    try {
      return marked.parse(text) as string;
    } catch {
      return this.escapeHtml(text);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Handle messages from the webview
    this.webviewMessageDisposable?.dispose();
    this.webviewMessageDisposable = webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'setConfigOption':
          await this.handleSetConfigOption(message.configId, message.value);
          break;
        case 'executeCommand':
          if (message.command) {
            await vscode.commands.executeCommand(message.command, ...(message.args || []));
          }
          break;
        case 'pickContext':
          await this.handlePickContext(message.kind);
          break;
        case 'listContextOptions':
          this.handleListContextOptions(message.kind);
          break;
        case 'persistTasks':
          await this.persistTaskSnapshot(message.tasks);
          break;
        case 'refreshChangedFiles':
          await this.refreshChangedFiles();
          break;
        case 'getFileDiff':
          await this.sendFileDiff(message.file);
          break;
        case 'openChangedFile':
          await this.openChangedFile(message.file);
          break;
        case 'openChangedDiff':
          await this.openChangedDiff(message.file);
          break;
        case 'keepAllChanges':
          await this.refreshChangedFiles();
          break;
        case 'discardChangedFile':
          await this.discardChangedFile(message.file);
          break;
        case 'discardAllChanges':
          await this.discardAllChanges();
          break;
        case 'ready':
          this.sendCurrentState();
          this.scheduleChangedFilesRefresh();
          break;
        case 'renderMarkdown': {
          // Webview requests markdown rendering for history items
          const items: Array<{index: number; text: string}> = message.items || [];
          const rendered = items.map((item: {index: number; text: string}) => ({
            index: item.index,
            html: this.renderMarkdown(item.text),
          }));
          this.postMessage({ type: 'markdownRendered', items: rendered });
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.webviewMessageDisposable?.dispose();
      this.webviewMessageDisposable = undefined;
      this.view = undefined;
      this.autoRestoreRequested = false;
    });

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    this.scheduleAutoRestore();
  }

  setAutoRestore(callback: () => Promise<void> | void): void {
    this.autoRestore = callback;
    this.scheduleAutoRestore();
  }

  private scheduleAutoRestore(): void {
    if (!this.view || !this.autoRestore || this.autoRestoreRequested) { return; }
    if (this.sessionManager.getActiveSessionId()) { return; }

    this.autoRestoreRequested = true;
    setTimeout(() => {
      if (!this.view || this.sessionManager.getActiveSessionId()) { return; }
      void Promise.resolve(this.autoRestore?.()).catch((e) => {
        logError('ChatWebviewProvider auto restore failed', e);
      });
    }, 750);
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    const updateData = update.update as any;

    // Persist session state BEFORE the active-session check. During session
    // creation the agent can dispatch notifications (e.g.
    // `available_commands_update`) before connectToAgent finishes setting
    // `activeSessionId`. Without this, those updates would be dropped and
    // the slash-command popup would never have commands to show.
    if (updateData?.sessionUpdate === 'available_commands_update') {
      this.sessionManager.applyAvailableCommands(
        update.sessionId,
        updateData.availableCommands || [],
      );
    }
    if (updateData?.sessionUpdate === 'config_option_update') {
      this.sessionManager.applyConfigOptions(
        update.sessionId,
        updateData.configOptions || [],
      );
    }
    if (updateData?.sessionUpdate === 'session_info_update') {
      this.sessionManager.applySessionInfoUpdate(update.sessionId, {
        title: updateData.title,
        updatedAt: updateData.updatedAt,
      });
    }
    if (updateData?.sessionUpdate === 'plan') {
      void this.persistTasksFromPlan(update.sessionId, updateData);
    }
    if (
      updateData?.sessionUpdate === 'tool_call' ||
      updateData?.sessionUpdate === 'tool_call_update'
    ) {
      this.scheduleChangedFilesRefresh();
    }

    // Only forward to the webview if this is the active session - the
    // webview only ever shows one session at a time.
    const activeId = this.sessionManager.getActiveSessionId();
    if (update.sessionId !== activeId) {
      return;
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  /**
   * Handle a prompt sent from the webview.
   */
  private async handleSendPrompt(text: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

    sendEvent('chat/messageSent', {
      agentName: this.sessionManager.getActiveAgentName() ?? '',
    }, {
      messageLength: text.length,
    });

    // Record the first prompt for the history store (used as a label
    // fallback when no title is supplied by the agent).
    this.sessionManager.recordFirstPrompt(activeId, text);

    // Tell webview we're processing
    this.postMessage({ type: 'promptStart' });

    try {
      const response = await this.sessionManager.sendPrompt(activeId, text);
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
      });
      this.sessionManager.touchHistory(activeId);
      this.scheduleChangedFilesRefresh();
    } catch (e: any) {
      logError('Prompt failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'Prompt failed',
      });
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) { return; }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  /**
   * Handle generic config-option change from webview picker
   * (ACP "Session Config Options"). The agent returns the full
   * configOptions state which we re-broadcast so any cascading
   * changes are reflected in the UI.
   */
  private async handleSetConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !configId) { return; }
    try {
      const options = await this.sessionManager.setConfigOption(activeId, configId, value);
      this.postMessage({ type: 'configOptionsUpdate', configOptions: options });
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.postMessage({ type: 'error', message: `Failed to set ${configId}: ${e.message}` });
      // Roll back optimistic update on the webview by replaying current state
      const session = this.sessionManager.getSession(activeId);
      this.postMessage({
        type: 'configOptionsUpdate',
        configOptions: session?.configOptions ?? null,
      });
    }
  }

  private taskStateKey(sessionId: string): string {
    return `auggie.tasks.${sessionId}`;
  }

  private normalizeTaskStatus(status: unknown): string {
    if (status === 'completed' || status === 'complete' || status === 'done') {
      return 'completed';
    }
    if (status === 'in_progress' || status === 'in-progress' || status === 'running' || status === 'active') {
      return 'in-progress';
    }
    return 'pending';
  }

  private taskText(entry: any): string {
    return entry?.title || entry?.description || entry?.content || entry?.text || entry?.name || 'Untitled task';
  }

  private async persistTasksFromPlan(sessionId: string, plan: any): Promise<void> {
    if (!this.workspaceState || !sessionId || !Array.isArray(plan?.entries)) { return; }

    const tasks: TaskSnapshot[] = plan.entries.map((entry: any, index: number) => ({
      id: String(entry?.id || entry?.taskId || index),
      title: this.taskText(entry),
      status: this.normalizeTaskStatus(entry?.status),
      rawStatus: String(entry?.status || 'pending'),
    }));

    await this.workspaceState.update(this.taskStateKey(sessionId), tasks);
  }

  private async persistTaskSnapshot(tasks: unknown): Promise<void> {
    const sessionId = this.sessionManager.getActiveSessionId();
    if (!this.workspaceState || !sessionId || !Array.isArray(tasks)) { return; }

    const normalized: TaskSnapshot[] = tasks.map((task: any, index: number) => ({
      id: String(task?.id || index),
      title: this.taskText(task),
      status: this.normalizeTaskStatus(task?.status),
      rawStatus: String(task?.rawStatus || task?.status || 'pending'),
    }));

    await this.workspaceState.update(this.taskStateKey(sessionId), normalized);
  }

  private getPersistedTasks(sessionId: string | undefined | null): TaskSnapshot[] {
    if (!this.workspaceState || !sessionId) { return []; }
    const tasks = this.workspaceState.get<TaskSnapshot[]>(this.taskStateKey(sessionId), []);
    return Array.isArray(tasks) ? tasks : [];
  }

  private parseNumstatNumber(value: string): number {
    if (!value || value === '-') { return 0; }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private parseGitPath(value: string): string {
    const trimmed = value.trim();
    const renameMatch = trimmed.match(/^(.*) => (.*)$/);
    if (!renameMatch) {
      return trimmed;
    }
    const prefix = renameMatch[1].replace(/\{.*$/, '');
    const suffix = renameMatch[2].replace(/^.*\}/, '');
    return `${prefix}${suffix}`;
  }

  private isSafeChangedFile(file: string): boolean {
    if (!file) { return false; }
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/') || file.startsWith('\\')) {
      return false;
    }
    return !file.split(/[\\/]+/).some(part => part === '..' || part === '');
  }

  private changedFileUri(file: string): vscode.Uri | undefined {
    if (!this.isSafeChangedFile(file)) { return undefined; }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) { return undefined; }
    return vscode.Uri.joinPath(workspaceRoot, ...file.split(/[\\/]+/));
  }

  private async getChangedFiles(): Promise<ChangedFileSnapshot[]> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return []; }

    try {
      const { stdout: diffStdout } = await execFileAsync('git', ['diff', '--numstat', 'HEAD', '--'], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });

      const tracked = diffStdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [addedRaw, removedRaw, ...pathParts] = line.split(/\t/);
          const file = this.parseGitPath(pathParts.join('\t'));
          return {
            file,
            added: this.parseNumstatNumber(addedRaw),
            removed: this.parseNumstatNumber(removedRaw),
            status: 'changed',
            source: 'git',
            binary: addedRaw === '-' || removedRaw === '-',
          };
        })
        .filter(change => !!change.file);

      const { stdout: untrackedStdout } = await execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        {
          cwd,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );

      const untracked = await Promise.all(untrackedStdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(file => this.isSafeChangedFile(file))
        .map(async (file) => ({
          file,
          added: 0,
          removed: 0,
          status: 'untracked',
          source: 'git',
          binary: await this.isBinaryWorkspaceFile(file),
          untracked: true,
        })));

      return tracked.concat(untracked);
    } catch (e) {
      logError('Failed to read changed files from git', e);
      return [];
    }
  }

  private async isBinaryWorkspaceFile(file: string): Promise<boolean> {
    const uri = this.changedFileUri(file);
    if (!uri) { return false; }

    try {
      const handle = await fs.open(uri.fsPath, 'r');
      try {
        const buffer = Buffer.alloc(8000);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 0) {
            return true;
          }
        }
        return false;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  private scheduleChangedFilesRefresh(): void {
    if (this.changedFilesRefreshTimer) {
      clearTimeout(this.changedFilesRefreshTimer);
    }
    this.changedFilesRefreshTimer = setTimeout(() => {
      void this.refreshChangedFiles();
    }, 650);
  }

  private async refreshChangedFiles(): Promise<void> {
    const files = await this.getChangedFiles();
    this.postMessage({
      type: 'changedFiles',
      files,
    });
  }

  private async getFileDiff(file: string): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !this.isSafeChangedFile(file)) { return ''; }

    try {
      const { stdout } = await execFileAsync('git', ['diff', '--', file], {
        cwd,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch (e) {
      logError(`Failed to read diff for ${file}`, e);
      return '';
    }
  }

  private async discardChangedFile(file: unknown): Promise<void> {
    if (typeof file !== 'string' || !this.isSafeChangedFile(file)) { return; }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }

    const confirmed = await vscode.window.showWarningMessage(
      `Discard all local changes to ${file}? This cannot be undone by Auggie Workbench.`,
      { modal: true },
      'Discard',
    );
    if (confirmed !== 'Discard') { return; }

    try {
      await execFileAsync('git', ['checkout', 'HEAD', '--', file], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      await execFileAsync('git', ['clean', '-f', '--', file], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    }
    await this.refreshChangedFiles();
  }

  private async discardAllChanges(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }

    const files = await this.getChangedFiles();
    if (files.length === 0) { return; }

    const confirmed = await vscode.window.showWarningMessage(
      `Discard all local changes in ${files.length} file(s)? This cannot be undone by Auggie Workbench.`,
      { modal: true },
      'Discard All',
    );
    if (confirmed !== 'Discard All') { return; }

    const trackedFiles = files.filter(file => !file.untracked).map(file => file.file);
    const untrackedFiles = files.filter(file => file.untracked).map(file => file.file);

    if (trackedFiles.length > 0) {
      await execFileAsync('git', ['checkout', 'HEAD', '--', ...trackedFiles], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    }
    if (untrackedFiles.length > 0) {
      await execFileAsync('git', ['clean', '-f', '--', ...untrackedFiles], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    }
    await this.refreshChangedFiles();
  }

  private async isUntrackedFile(file: string): Promise<boolean> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !this.isSafeChangedFile(file)) { return false; }

    try {
      await execFileAsync('git', ['ls-files', '--error-unmatch', '--', file], {
        cwd,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return false;
    } catch {
      return true;
    }
  }

  private async getUntrackedFilePreview(file: string): Promise<string> {
    const uri = this.changedFileUri(file);
    if (!uri || await this.isBinaryWorkspaceFile(file)) { return ''; }

    try {
      const text = await fs.readFile(uri.fsPath, 'utf8');
      return text
        .split(/\r?\n/)
        .slice(0, 90)
        .map(line => `+${line}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  private async sendFileDiff(file: unknown): Promise<void> {
    if (typeof file !== 'string' || !file) { return; }
    const diff = await this.isUntrackedFile(file)
      ? await this.getUntrackedFilePreview(file)
      : await this.getFileDiff(file);
    this.postMessage({
      type: 'fileDiff',
      file,
      diff,
    });
  }

  private async getHeadFileContent(file: string): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd || !this.isSafeChangedFile(file)) { return ''; }

    try {
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${file}`], {
        cwd,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    } catch (e) {
      logError(`Failed to read HEAD content for ${file}`, e);
      return '';
    }
  }

  private async openChangedFile(file: unknown): Promise<void> {
    if (typeof file !== 'string') { return; }
    const uri = this.changedFileUri(file);
    if (!uri) { return; }

    await vscode.window.showTextDocument(uri, { preview: false });
  }

  private async openChangedDiff(file: unknown): Promise<void> {
    if (typeof file !== 'string') { return; }
    const rightUri = this.changedFileUri(file);
    if (!rightUri) { return; }

    const baseContent = await this.getHeadFileContent(file);
    const leftUri = vscode.Uri.from({
      scheme: 'auggie-diff-base',
      path: `/${file}`,
      query: String(Date.now()),
    });
    this.diffBaseContents.set(leftUri.toString(), baseContent);

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      `${file} (HEAD <-> Working Tree)`,
      { preview: false },
    );
  }

  /**
   * Let the user pick workspace context to attach to the next prompt.
   */
  private async handlePickContext(kind?: string): Promise<void> {
    const items: Array<vscode.QuickPickItem & { uri?: vscode.Uri; action?: 'browse' }> = [];
    const activeEditor = vscode.window.activeTextEditor;

    if (kind === 'selection') {
      if (!activeEditor || activeEditor.selection.isEmpty) {
        this.postMessage({
          type: 'contextNotice',
          message: 'No code selected',
        });
        return;
      }

      const text = activeEditor.document.getText(activeEditor.selection);
      const start = activeEditor.selection.start.line + 1;
      const end = activeEditor.selection.end.line + 1;
      const label = `${vscode.workspace.asRelativePath(activeEditor.document.uri)}:${start}-${end}`;
      this.postMessage({
        type: 'contextPicked',
        path: activeEditor.document.uri.fsPath,
        label,
        content: text,
        kind: 'selection',
      });
      return;
    }

    if (kind === 'file' || kind === 'folder') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: kind === 'file',
        canSelectFolders: kind === 'folder',
        canSelectMany: false,
        openLabel: 'Attach',
      });
      const uri = selected?.[0];
      if (!uri) { return; }
      this.postMessage({
        type: 'contextPicked',
        path: uri.fsPath,
        label: vscode.workspace.asRelativePath(uri),
        kind,
      });
      return;
    }

    if (kind === 'recent') {
      this.handleListContextOptions('recent');
      return;
    }

    if (activeEditor) {
      items.push({
        label: 'Current file',
        description: vscode.workspace.asRelativePath(activeEditor.document.uri),
        uri: activeEditor.document.uri,
      });
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (activeEditor && editor.document.uri.toString() === activeEditor.document.uri.toString()) {
        continue;
      }
      items.push({
        label: vscode.workspace.asRelativePath(editor.document.uri),
        description: 'Open editor',
        uri: editor.document.uri,
      });
    }

    for (const folder of vscode.workspace.workspaceFolders || []) {
      items.push({
        label: folder.name,
        description: 'Workspace folder',
        uri: folder.uri,
      });
    }

    items.push({
      label: 'Browse for file...',
      description: 'Choose a file from disk',
      action: 'browse',
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Add context for Auggie',
      title: 'Add Context',
    });
    if (!picked) { return; }

    let uri = picked.uri;
    if (picked.action === 'browse') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Attach',
      });
      uri = selected?.[0];
    }
    if (!uri) { return; }

    this.postMessage({
      type: 'contextPicked',
      path: uri.fsPath,
      label: vscode.workspace.asRelativePath(uri),
      kind: 'file',
    });
  }

  private handleListContextOptions(kind?: string): void {
    if (kind !== 'recent') { return; }

    const seen = new Set<string>();
    const options: Array<{ label: string; path: string; kind: string }> = [];
    const addUri = (uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || seen.has(uri.fsPath)) { return; }
      seen.add(uri.fsPath);
      options.push({
        label: vscode.workspace.asRelativePath(uri),
        path: uri.fsPath,
        kind: 'file',
      });
    };

    for (const editor of vscode.window.visibleTextEditors) {
      addUri(editor.document.uri);
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isUntitled) {
        addUri(doc.uri);
      }
    }

    this.postMessage({
      type: 'contextOptions',
      kind,
      options,
    });
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      tasks: this.getPersistedTasks(activeId),
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        title: session.title,
        cwd: session.cwd,
        modes: session.modes,
        models: session.models,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      } : null,
    });
  }

  /**
   * Post a message to the webview if it exists.
   */
  private postMessage(message: any): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  /**
   * Notify webview of session config-option state changes.
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
    this.postMessage({ type: 'configOptionsUpdate', configOptions });
  }

  /**
   * Notify webview that a `session/load` replay is starting. The webview
   * wipes any previously-displayed history, disables input, and shows a
   * loading overlay until {@link notifyLoadSessionEnd} fires.
   */
  notifyLoadSessionStart(): void {
    this.postMessage({ type: 'loadSessionStart' });
  }

  /** Notify webview that the active replay finished (success or failure). */
  notifyLoadSessionEnd(ok: boolean): void {
    this.postMessage({ type: 'loadSessionEnd', ok });
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    this.postMessage({ type: 'sessionInfoUpdate', title: title ?? null });
  }

  notifyTerminalCommandRun(details: any): void {
    this.postMessage({ type: 'terminalCommandRun', details });
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chatWebview.js'),
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
  <title>Auggie</title>
  <style>
    :root {
      --container-padding: 12px;
      --message-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .workbench-shell {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1;
    }

    .workbench-header {
      flex-shrink: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    .workbench-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 38px;
      padding: 6px 10px;
    }

    .workbench-title {
      flex: 1;
      min-width: 0;
      font-weight: 600;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .header-icon-btn,
    .header-mode-btn {
      height: 26px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font: inherit;
    }

    .header-icon-btn {
      width: 28px;
      font-size: 18px;
      line-height: 1;
    }

    .header-mode-btn {
      padding: 0 8px;
      color: var(--vscode-descriptionForeground);
    }

    .header-icon-btn:hover,
    .header-mode-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .workbench-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      padding: 0 8px;
    }

    .workbench-tab {
      position: relative;
      min-width: 0;
      height: 32px;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
    }

    .workbench-tab:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .workbench-tab.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }

    .tab-count,
    .delta {
      font-size: 0.88em;
      color: var(--vscode-descriptionForeground);
    }

    .delta.plus {
      color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed));
    }

    .delta.minus {
      color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground));
    }

    .view-stack {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .view-panel {
      display: none;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .view-panel.active {
      display: flex;
    }

    .thread-view {
      flex-direction: column;
    }

    .tasks-view,
    .edits-view {
      flex-direction: column;
      overflow-y: auto;
      padding: 12px;
      gap: 10px;
    }

    .workbench-section-title {
      font-size: 0.86em;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .task-row,
    .edit-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }

    .edit-row {
      flex-direction: column;
      gap: 8px;
    }

    .edit-summary {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: 100%;
      min-width: 0;
      cursor: pointer;
    }

    .edit-chevron {
      width: 12px;
      flex: 0 0 auto;
      color: var(--vscode-descriptionForeground);
      padding-top: 2px;
      font-size: 0.9em;
    }

    .task-check {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 1px solid var(--vscode-descriptionForeground);
      flex-shrink: 0;
      margin-top: 2px;
      opacity: 0.8;
    }

    .task-row.completed .task-check {
      border-color: var(--vscode-testing-iconPassed);
      background: var(--vscode-testing-iconPassed);
      box-shadow: inset 0 0 0 3px var(--vscode-editor-background);
    }

    .task-row.in-progress .task-check {
      border-color: var(--vscode-progressBar-background);
      border-width: 2px;
    }

    .task-row.pending .task-check {
      opacity: 0.55;
    }

    .task-body,
    .edit-body {
      min-width: 0;
      flex: 1;
    }

    .task-title,
    .edit-title {
      font-weight: 600;
      margin-bottom: 3px;
    }

    .task-row.completed .task-title {
      text-decoration: line-through;
      opacity: 0.75;
    }

    .task-meta,
    .edit-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      line-height: 1.35;
    }

    .tasks-header-row,
    .edits-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .edits-header-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }

    .tasks-progress,
    .edits-progress {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      white-space: nowrap;
    }

    .edits-bulk-action {
      height: 24px;
      padding: 0 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      font-size: 0.88em;
      white-space: nowrap;
    }

    .edits-bulk-action:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .edits-bulk-action:disabled {
      cursor: default;
      opacity: 0.45;
    }

    .edits-bulk-action.danger,
    .edit-action.danger {
      color: var(--vscode-errorForeground);
    }

    .tasks-list,
    .edits-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .edit-file-icon {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      margin-top: 1px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 0.78em;
      font-weight: 700;
    }

    .edit-row.running .edit-file-icon,
    .edit-row.pending .edit-file-icon {
      background: var(--vscode-progressBar-background);
      color: var(--vscode-editor-background);
    }

    .edit-row.completed .edit-file-icon {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }

    .edit-row.failed .edit-file-icon {
      background: var(--vscode-testing-iconFailed);
      color: var(--vscode-editor-background);
    }

    .edit-delta {
      flex: 0 0 auto;
      white-space: nowrap;
      font-size: 0.9em;
      padding-top: 1px;
    }

    .edit-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }

    .edit-action {
      height: 22px;
      padding: 0 7px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
      font-size: 0.88em;
    }

    .edit-action:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .edit-action.danger:hover {
      color: var(--vscode-errorForeground);
    }

    .edit-diff {
      width: 100%;
      max-height: 320px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.35;
      padding: 6px 0;
      white-space: pre;
    }

    .edit-diff.loading,
    .diff-truncated {
      padding: 7px 10px;
      color: var(--vscode-descriptionForeground);
      white-space: normal;
    }

    .diff-line {
      padding: 0 10px;
      min-height: 18px;
    }

    .diff-line.file {
      color: var(--vscode-descriptionForeground);
    }

    .diff-line.hunk {
      color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-focusBorder));
      background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent);
    }

    .diff-line.added {
      color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed));
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent);
    }

    .diff-line.removed {
      color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground));
      background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    }

    .empty-workbench-view {
      margin: auto;
      max-width: 360px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

    .empty-workbench-view .title {
      color: var(--vscode-foreground);
      font-weight: 650;
      margin-bottom: 6px;
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }
    .session-banner .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      flex-shrink: 0;
    }
    .session-banner .info { flex: 1; }
    .session-banner .agent { font-weight: 600; }
    .session-banner .cwd {
      font-size: 0.85em;
      opacity: 0.6;
      margin-top: 1px;
    }
    .session-banner .status {
      font-size: 0.85em;
      opacity: 0.7;
      flex-shrink: 0;
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--container-padding);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .message {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      max-width: 95%;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    /* Markdown body inside assistant messages */
    .message.assistant.md-rendered {
      white-space: normal;
    }
    .message.assistant.md-rendered p {
      margin: 0 0 0.5em;
    }
    .message.assistant.md-rendered p:last-child {
      margin-bottom: 0;
    }
    .message.assistant.md-rendered pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0.5em 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.4;
    }
    .message.assistant.md-rendered code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message.assistant.md-rendered pre code {
      background: none;
      padding: 0;
      border-radius: 0;
    }
    .message.assistant.md-rendered ul,
    .message.assistant.md-rendered ol {
      margin: 0.4em 0;
      padding-left: 1.5em;
    }
    .message.assistant.md-rendered li {
      margin: 0.15em 0;
    }
    .message.assistant.md-rendered h1,
    .message.assistant.md-rendered h2,
    .message.assistant.md-rendered h3,
    .message.assistant.md-rendered h4 {
      margin: 0.6em 0 0.3em;
      font-weight: 600;
    }
    .message.assistant.md-rendered h1 { font-size: 1.3em; }
    .message.assistant.md-rendered h2 { font-size: 1.15em; }
    .message.assistant.md-rendered h3 { font-size: 1.05em; }
    .message.assistant.md-rendered blockquote {
      border-left: 3px solid var(--vscode-focusBorder);
      margin: 0.4em 0;
      padding: 0.2em 0 0.2em 0.8em;
      opacity: 0.85;
    }
    .message.assistant.md-rendered a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .message.assistant.md-rendered a:hover {
      text-decoration: underline;
    }
    .message.assistant.md-rendered table {
      border-collapse: collapse;
      margin: 0.4em 0;
      font-size: 0.9em;
    }
    .message.assistant.md-rendered th,
    .message.assistant.md-rendered td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
    }
    .message.assistant.md-rendered th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    .message.assistant.md-rendered hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 0.6em 0;
    }
    /* Thought block - collapsible <details> element */
    .thought-block {
      width: 100%;
      margin-bottom: 4px;
    }
    .thought-block summary {
      font-size: 0.85em;
      opacity: 0.7;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    .thought-block summary::-webkit-details-marker { display: none; }
    .thought-block summary::before {
      content: '>';
      font-size: 0.9em;
      transition: transform 0.15s;
    }
    .thought-block[open] summary::before {
      content: 'v';
    }
    .thought-block summary:hover { opacity: 1; }
    .thought-block.streaming summary .thought-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes thoughtPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .thought-block .thought-content {
      margin-top: 4px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 0.88em;
      opacity: 0.75;
      font-style: italic;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    .message.error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }

    /* Turn container - groups assistant text + tool calls */
    .turn {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-self: flex-start;
      max-width: 95%;
    }

    /* Tool calls group inside a turn */
    .turn-tools {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 4px 0;
    }
    .turn-tools-summary {
      font-size: 0.8em;
      opacity: 0.6;
      cursor: pointer;
      padding: 2px 0;
      user-select: none;
    }
    .turn-tools-summary:hover { opacity: 0.9; }
    .turn-tools-list { }
    .turn-tools-list.collapsed { display: none; }

    /* Reviewable activity card */
    .tool-call-inline {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      font-size: 0.9em;
      border-radius: 6px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .tool-call-inline .tc-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .tool-call-inline .tc-chevron,
    .tool-call-inline .tc-icon {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }

    .tool-call-inline .tc-chevron {
      color: var(--vscode-descriptionForeground);
    }

    .tool-call-inline .tc-icon.pending { color: var(--vscode-badge-foreground); }
    .tool-call-inline .tc-icon.running { color: var(--vscode-progressBar-background); }
    .tool-call-inline .tc-icon.completed { color: var(--vscode-testing-iconPassed); }
    .tool-call-inline .tc-icon.failed { color: var(--vscode-testing-iconFailed); }
    .tool-call-inline .tc-title {
      flex: 1;
      min-width: 0;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-call-inline .tc-status {
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.88em;
    }
    .tool-call-inline .tc-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .tool-call-inline .tc-action {
      min-width: 22px;
      height: 22px;
      padding: 0 5px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font: inherit;
    }
    .tool-call-inline .tc-action:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .tool-call-inline .tc-detail {
      display: none;
      padding-left: 40px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      line-height: 1.35;
    }
    .tool-call-inline.expanded .tc-detail {
      display: block;
    }
    .tc-detail-row {
      display: grid;
      grid-template-columns: minmax(72px, max-content) minmax(0, 1fr);
      gap: 8px;
      margin: 3px 0;
    }
    .tc-detail-label {
      color: var(--vscode-descriptionForeground);
    }
    .tc-detail-value {
      min-width: 0;
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
    }
    .tc-detail-value.mono {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.96em;
    }
    .tc-output-label {
      margin-top: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }
    .tc-output {
      margin: 3px 0 0;
      max-height: 180px;
      overflow: auto;
      padding: 7px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-textCodeBlock-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 0.92em;
      line-height: 1.35;
      white-space: pre-wrap;
    }

    /* Legacy standalone tool-call card (for history restore) */
    .tool-call {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .tool-call .title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .tool-call .status-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      margin-left: 6px;
    }
    .tool-call .status-badge.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tool-call .status-badge.running { background: var(--vscode-progressBar-background); color: white; }
    .tool-call .status-badge.completed { background: var(--vscode-testing-iconPassed); color: white; }
    .tool-call .status-badge.failed { background: var(--vscode-testing-iconFailed); color: white; }

    /* Plan */
    .plan {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .plan .plan-title { font-weight: 600; margin-bottom: 6px; }
    .plan .plan-entry {
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan .plan-entry.completed { text-decoration: line-through; opacity: 0.6; }

    /* Empty / welcome state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px 20px;
      gap: 6px;
      position: relative;
      z-index: 1;
    }
    .empty-state .icon { font-size: 2.4em; margin-bottom: 4px; opacity: 0.85; }
    .empty-state .title {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .empty-state .subtitle {
      font-size: 0.85em;
      opacity: 0.6;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .empty-state .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 220px;
    }
    .empty-state .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      pointer-events: auto;
      position: relative;
      z-index: 2;
    }
    .empty-state .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .empty-state .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty-state .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .empty-state .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty-state .hint {
      font-size: 0.8em;
      opacity: 0.5;
      margin-top: 8px;
    }
    .empty-state .hint kbd {
      padding: 1px 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-editor-background);
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }

    /* Input area states */
    .input-area.disabled .input-toolbar,
    .input-area.disabled .input-editor-wrap,
    .input-area.disabled .input-send-row { opacity: 0.4; pointer-events: none; }

    /* Input area container */
    .input-area {
      position: relative;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
    }

    /* Resize handle */
    .input-resize-handle {
      height: 4px;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .input-resize-handle::after {
      content: '';
      width: 32px;
      height: 2px;
      border-radius: 1px;
      background: var(--vscode-panel-border);
      transition: background 0.15s;
    }
    .input-resize-handle:hover::after {
      background: var(--vscode-focusBorder);
    }

    /* Toolbar row */
    .input-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px var(--container-padding) 0;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    /* Picker wrapper - positioned relatively to anchor the dropdown */
    .picker-wrap {
      position: relative;
      min-width: 0;
      max-width: 100%;
    }
    .picker-wrap.hidden { display: none; }

    /* Picker buttons */
    .picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 1px);
      cursor: pointer;
      white-space: nowrap;
      max-width: 100%;
      min-width: 0;
      opacity: 0.8;
    }
    .picker-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .picker-btn .picker-icon {
      flex-shrink: 0;
      font-size: 14px;
    }
    .picker-btn .picker-label {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .picker-btn .picker-chevron {
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.6;
    }

    /* Picker dropdown - sibling of button, positioned from wrapper */
    .picker-dropdown {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      min-width: 180px;
      max-width: min(420px, calc(100vw - 16px));
      max-height: 240px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
      margin-bottom: 4px;
    }
    .picker-dropdown.open { display: block; }
    .picker-dropdown-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .picker-dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .picker-dropdown-item .check {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
    }
    .picker-dropdown-item .item-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Floating tooltip used by all picker dropdowns to show option
       description on hover (positioned outside the dropdown). */
    .picker-tooltip {
      position: fixed;
      display: none;
      max-width: 280px;
      padding: 6px 10px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.4;
      white-space: normal;
      word-break: break-word;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      z-index: 300;
    }
    .picker-tooltip.visible { display: block; }

    /* Header for grouped picker options */
    .picker-dropdown-group-header {
      padding: 6px 10px 2px;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.6;
      pointer-events: none;
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-group-header:not(:first-child) {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }

    /* Dynamic config-options picker row - sits inline with legacy pickers */
    .picker-row {
      display: contents;
    }

    /* Toolbar spacer */
    .toolbar-spacer { flex: 1; }

    /* Editor wrapper */
    .input-editor-wrap {
      padding: 0 var(--container-padding);
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .input-editor-wrap textarea {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      min-height: 38px;
      outline: none;
    }
    .input-editor-wrap textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* Send row */
    .input-send-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 4px var(--container-padding) 8px;
      gap: 6px;
      flex-shrink: 0;
    }

    /* Send / Stop toggle button - pill-shaped */
    .send-stop-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 4px 14px;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      white-space: nowrap;
      min-width: 60px;
      height: 26px;
      transition: background 0.15s;
    }
    .send-stop-btn.send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .send-stop-btn.send:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .send-stop-btn.send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .send-stop-btn.stop {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .send-stop-btn.stop:hover {
      opacity: 0.9;
    }

    /* Slash command autocomplete popup */
    .slash-popup {
      display: none;
      position: absolute;
      bottom: 100%;
      left: var(--container-padding);
      right: var(--container-padding);
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
      border-radius: 6px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
      z-index: 200;
      margin-bottom: 4px;
    }
    .slash-popup.open { display: block; }
    .slash-popup-header {
      padding: 6px 10px 4px;
      font-size: 0.8em;
      opacity: 0.5;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .slash-popup-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .slash-popup-item:hover,
    .slash-popup-item.active {
      background: var(--vscode-list-hoverBackground);
    }
    .slash-popup-item .cmd-name {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .slash-popup-item .cmd-desc {
      font-size: 0.9em;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .working-indicator {
      align-self: flex-start;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 95%;
      min-width: min(420px, 95%);
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .working-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .working-indicator .spinner {
      flex-shrink: 0;
    }

    .working-text {
      flex: 1;
      min-width: 0;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .working-elapsed {
      flex-shrink: 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }

    .activity-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-left: 22px;
    }

    .activity-row {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }

    .activity-icon {
      width: 12px;
      flex-shrink: 0;
      text-align: center;
    }

    .activity-row.running .activity-icon {
      color: var(--vscode-progressBar-background);
    }

    .activity-row.completed .activity-icon {
      color: var(--vscode-testing-iconPassed);
    }

    .activity-row.failed .activity-icon {
      color: var(--vscode-testing-iconFailed);
    }

    .activity-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Full-area overlay shown while a session is being loaded via session/load */
    .load-overlay {
      display: none;
      position: fixed;
      inset: 0;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
      backdrop-filter: blur(2px);
      z-index: 400;
      font-size: 0.9em;
      color: var(--vscode-foreground);
      pointer-events: all;
    }
    .load-overlay.visible { display: flex; }
    .load-overlay .spinner {
      width: 22px;
      height: 22px;
      border-width: 3px;
      opacity: 0.9;
    }
    .load-overlay .label { opacity: 0.85; }


    /* Auggie Workbench visual pass */
    body {
      background: var(--vscode-editor-background);
    }
    .session-banner {
      padding: 10px var(--container-padding) 9px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    .session-banner.visible { gap: 9px; }
    .session-banner .dot {
      width: 7px;
      height: 7px;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent);
    }
    .session-banner .info { min-width: 0; }
    .session-banner .agent,
    .session-banner .cwd {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .messages {
      padding: 14px var(--container-padding) 12px;
      gap: 10px;
    }
    .message {
      max-width: 100%;
      border-radius: 6px;
    }
    .message.user {
      max-width: 92%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    .message.assistant {
      align-self: stretch;
      background: transparent;
      border: none;
      border-left: 2px solid var(--vscode-focusBorder);
      border-radius: 0;
      padding-left: 12px;
    }
    .turn {
      align-self: stretch;
      max-width: 100%;
    }
    .empty-state {
      align-items: stretch;
      text-align: left;
      max-width: 360px;
      margin: auto;
      height: auto;
      padding: 28px 18px;
      gap: 8px;
    }
    .empty-state .icon { display: none; }
    .empty-state .title {
      font-size: 1.25em;
      font-weight: 650;
      margin-bottom: 2px;
    }
    .empty-state .subtitle {
      font-size: 0.92em;
      opacity: 0.72;
      margin-bottom: 10px;
    }
    .empty-state .actions {
      flex-direction: row;
      max-width: none;
      width: auto;
      flex-wrap: wrap;
    }
    .empty-state .action-btn {
      padding: 5px 10px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
    }
    .input-area {
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      background: var(--vscode-sideBar-background);
      padding-bottom: 2px;
    }
    .input-editor-wrap {
      padding: 6px var(--container-padding) 0;
    }
    .input-editor-wrap textarea {
      min-height: 54px;
      padding: 9px 10px;
      border-radius: 6px;
      border-color: var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
    }
    .input-editor-wrap textarea:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }


    /* Augment-inspired composer and command palette pass */
    .input-area {
      padding: 8px var(--container-padding) 10px;
      gap: 6px;
    }
    .input-toolbar {
      padding: 0;
      gap: 6px;
    }
    .composer-context-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 26px;
      overflow: hidden;
    }
    .composer-icon-btn,
    .composer-send-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
      cursor: pointer;
      opacity: 0.82;
      height: 24px;
      min-width: 24px;
      padding: 0 6px;
    }
    .composer-icon-btn:hover,
    .composer-send-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .picker-icon:empty { display: none; }
    .composer-icon-btn.active {
      opacity: 1;
      background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
    }
    .context-menu {
      display: none;
      position: absolute;
      left: var(--container-padding);
      bottom: calc(100% - 36px);
      width: min(330px, calc(100% - 24px));
      max-height: min(330px, 52vh);
      overflow-y: auto;
      z-index: 240;
      padding: 5px;
      border-radius: 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .context-menu.open { display: block; }
    .context-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      min-height: 30px;
      padding: 5px 8px;
      border: none;
      border-radius: 4px;
      color: inherit;
      background: transparent;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .context-menu-item:hover,
    .context-menu-item.focused {
      background: var(--vscode-list-hoverBackground);
    }
    .context-menu-item.disabled {
      cursor: default;
      opacity: 0.65;
    }
    .context-menu-item.disabled:hover {
      background: transparent;
    }
    .context-menu-item .main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .context-menu-item .icon {
      width: 18px;
      text-align: center;
      opacity: 0.82;
      flex: 0 0 auto;
    }
    .context-menu-item .label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .context-menu-item .chevron {
      opacity: 0.7;
      flex: 0 0 auto;
    }
    .context-menu-separator {
      height: 1px;
      margin: 5px 4px;
      background: var(--vscode-panel-border);
    }
    .context-menu-note {
      padding: 6px 8px 5px;
      color: var(--vscode-descriptionForeground);
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .composer-context-chips {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow-x: auto;
      flex: 1;
    }
    .composer-context-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 52%;
      height: 24px;
      padding: 0 8px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: calc(var(--vscode-font-size) - 1px);
      border: none;
      cursor: pointer;
      flex: 0 1 auto;
    }
    .composer-context-chip .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer-context-chip .remove {
      opacity: 0.75;
      flex: 0 0 auto;
      padding-left: 2px;
    }
    .composer-context-chip:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .input-editor-wrap {
      padding: 0;
    }
    .input-editor-wrap textarea {
      min-height: 82px;
      border-radius: 4px;
      border-color: var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .input-send-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0;
    }
    .composer-controls-left,
    .composer-controls-right {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .composer-auto-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      padding: 0 9px 0 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-size: calc(var(--vscode-font-size) - 1px);
      opacity: 0.9;
    }
    .composer-auto-pill:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .composer-auto-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .send-stop-btn {
      min-width: 32px;
      height: 28px;
      border-radius: 4px;
      padding: 0 10px;
    }
    .slash-popup {
      bottom: calc(100% - 10px);
      left: var(--container-padding);
      right: var(--container-padding);
      max-height: min(430px, 62vh);
      padding: 8px 0;
      border-radius: 6px;
      background: var(--vscode-quickInput-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-quickInputList-focusBackground, var(--vscode-dropdown-border));
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .slash-popup-header {
      padding: 8px 12px 6px;
      font-size: 1.02em;
      font-weight: 650;
      color: var(--vscode-foreground);
      opacity: 0.95;
    }
    .slash-popup-section {
      padding: 10px 12px 5px;
      font-size: 0.88em;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 6px;
    }
    .slash-popup-section.first {
      border-top: none;
      margin-top: 0;
      padding-top: 4px;
    }
    .slash-popup-item {
      display: block;
      padding: 7px 12px 8px;
      border-radius: 0;
    }
    .slash-popup-item .cmd-name {
      display: block;
      font-weight: 650;
      margin-bottom: 2px;
    }
    .slash-popup-item .cmd-desc {
      display: block;
      font-size: 0.92em;
      opacity: 0.82;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  </style>
</head>
<body>
  <div class="workbench-shell">
    <div class="workbench-header">
      <div class="workbench-title-row">
        <button class="header-icon-btn" id="headerMenuBtn" title="Threads">=</button>
        <div class="workbench-title" id="workbenchTitle">Auggie</div>
        <div class="header-actions">
          <button class="header-mode-btn" id="headerAgentModeBtn" title="Current mode">Agent</button>
          <button class="header-icon-btn" id="headerNewThreadBtn" title="New thread">+</button>
        </div>
      </div>
      <div class="workbench-tabs" role="tablist" aria-label="Auggie views">
        <button class="workbench-tab active" data-view="thread" role="tab" aria-selected="true">Thread</button>
        <button class="workbench-tab" data-view="tasks" role="tab" aria-selected="false">Tasks <span class="tab-count" id="tasksTabCount">0/0</span></button>
        <button class="workbench-tab" data-view="edits" role="tab" aria-selected="false">Edits <span class="delta plus" id="editsAddCount">+0</span> <span class="delta minus" id="editsDeleteCount">-0</span></button>
      </div>
    </div>

    <div class="session-banner" id="sessionBanner">
      <span class="dot"></span>
      <div class="info">
        <div class="agent" id="bannerAgent"></div>
        <div class="cwd" id="bannerCwd"></div>
      </div>
      <span class="status" id="status"></span>
    </div>

    <div class="view-stack">
      <div class="view-panel thread-view active" id="threadView" role="tabpanel">
        <div class="messages" id="messages">
          <div class="empty-state" id="emptyState">
            <div class="icon">A</div>
            <div class="title">Auggie</div>
            <div class="subtitle">Ready to work in this codebase. Start Auggie or open an existing thread.</div>
            <div class="actions">
              <button class="action-btn primary" id="welcomeConnectAgent">
                Start Auggie
              </button>
              <button class="action-btn secondary" id="welcomeAddAgent">
                Settings
              </button>
            </div>
            <div class="hint">or press <kbd>Ctrl+Shift+A</kbd> anytime</div>
          </div>
        </div>
      </div>

      <div class="view-panel tasks-view" id="tasksView" role="tabpanel">
        <div class="tasks-header-row">
          <div class="workbench-section-title">Tasks</div>
          <div class="tasks-progress" id="tasksProgress">0 of 0 complete</div>
        </div>
        <div class="tasks-list" id="tasksList"></div>
        <div class="empty-workbench-view" id="tasksEmptyState">
          <div class="title">No active task list yet</div>
          <div>When Auggie sends a plan, its steps will appear here with live status.</div>
        </div>
      </div>

      <div class="view-panel edits-view" id="editsView" role="tabpanel">
        <div class="edits-header-row">
          <div class="workbench-section-title">Edits</div>
          <div class="edits-header-actions">
            <button class="edits-bulk-action" id="editsKeepAllBtn" title="Refresh and keep current changes" disabled>Keep All</button>
            <button class="edits-bulk-action danger" id="editsDiscardAllBtn" title="Discard all listed changes" disabled>Discard All</button>
          </div>
          <div class="edits-progress" id="editsProgress">0 changed files</div>
        </div>
        <div class="edits-list" id="editsList"></div>
        <div class="empty-workbench-view" id="editsEmptyState">
          <div class="title">No changed files yet</div>
          <div>When Auggie edits files, they will appear here for review.</div>
        </div>
      </div>
    </div>
  </div>

  <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-resize-handle" id="resizeHandle"></div>
    <div class="input-toolbar">
      <!-- Dynamic config-options pickers (ACP "Session Config Options"). -->
      <div class="picker-row" id="configOptionsContainer"></div>
      <!-- Legacy pickers - used only when the agent has not migrated to configOptions -->
      <div class="picker-wrap hidden" id="modePickerWrap">
        <button class="picker-btn" id="modePickerBtn" title="Select mode">
          <span class="picker-icon">!</span>
          <span class="picker-label" id="modePickerLabel">Mode</span>
          <span class="picker-chevron">v</span>
        </button>
        <div class="picker-dropdown" id="modeDropdown"></div>
      </div>
      <div class="picker-wrap hidden" id="modelPickerWrap">
        <button class="picker-btn" id="modelPickerBtn" title="Select model">
          <span class="picker-icon"></span>
          <span class="picker-label" id="modelPickerLabel">Model</span>
          <span class="picker-chevron">v</span>
        </button>
        <div class="picker-dropdown" id="modelDropdown"></div>
      </div>
      <span class="toolbar-spacer"></span>
    </div>
    <div class="context-menu" id="contextMenu" role="menu" aria-label="Add context">
      <button class="context-menu-item" data-action="default" role="menuitem">
        <span class="main"><span class="icon">@</span><span class="label">Default Context</span></span>
      </button>
      <button class="context-menu-item" data-action="file" role="menuitem">
        <span class="main"><span class="icon">F</span><span class="label">Files</span></span>
        <span class="chevron">></span>
      </button>
      <button class="context-menu-item" data-action="folder" role="menuitem">
        <span class="main"><span class="icon">D</span><span class="label">Folders</span></span>
        <span class="chevron">></span>
      </button>
      <button class="context-menu-item" data-action="recent" role="menuitem">
        <span class="main"><span class="icon">R</span><span class="label">Recently Opened Files</span></span>
        <span class="chevron">></span>
      </button>
      <button class="context-menu-item" data-action="rules" role="menuitem">
        <span class="main"><span class="icon">G</span><span class="label">Rules</span></span>
        <span class="chevron">></span>
      </button>
      <div class="context-menu-separator"></div>
      <button class="context-menu-item" data-action="clear" role="menuitem">
        <span class="main"><span class="icon">x</span><span class="label">Clear Context</span></span>
      </button>
    </div>
    <div class="composer-context-row" id="composerContextRow">
      <button class="composer-icon-btn" id="contextMentionBtn" title="Add context">@</button>
      <button class="composer-icon-btn" id="composerAttachBtn" title="Add selected code">I</button>
      <button class="composer-icon-btn" id="composerNewThreadBtn" title="New thread">New</button>
      <div class="composer-context-chips" id="composerContextChips"></div>
    </div>
    <div class="input-editor-wrap">
      <textarea
        id="promptInput"
        placeholder="Instruct Auggie, @ for context, / for commands"
        rows="2"
      ></textarea>
    </div>
    <div class="input-send-row">
      <div class="composer-controls-left">
        <span class="composer-auto-pill" title="Toggle agent mode. Auto OFF requires approval for most commands."><span class="composer-auto-dot"></span>Auto</span>
      </div>
      <div class="composer-controls-right">
        <button class="composer-icon-btn" id="bottomAttachBtn" title="Attach file">+</button>
        <button class="composer-icon-btn" id="enhancePromptBtn" title="Prompt Enhancer">*</button>
        <button class="send-stop-btn send" id="sendStopBtn">Send</button>
      </div>
    </div>
  </div>

  <!-- Shared hover tooltip for picker dropdown items -->
  <div class="picker-tooltip" id="pickerTooltip" role="tooltip"></div>

  <!-- Overlay shown during session/load history replay -->
  <div class="load-overlay" id="loadOverlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">Loading conversation history...</div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Attach a file URI - notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
    this.webviewMessageDisposable?.dispose();
    this.diffBaseContentProviderDisposable.dispose();
    for (const disposable of this.changedFilesWatchDisposables) {
      disposable.dispose();
    }
    if (this.changedFilesRefreshTimer) {
      clearTimeout(this.changedFilesRefreshTimer);
    }
  }
}

