import { log } from '../utils/Logger';

import type { SessionNotification } from '@agentclientprotocol/sdk';

export type SessionUpdateListener = (update: SessionNotification) => void;

/**
 * Routes session/update notifications to registered listeners.
 * The ChatWebviewProvider registers as a listener to forward updates to the webview.
 */
export class SessionUpdateHandler {
  private listeners: Set<SessionUpdateListener> = new Set();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    const updateType = (update.update as any)?.sessionUpdate || 'unknown';
    log(`sessionUpdate: type=${updateType}, sessionId=${update.sessionId}${this.describeToolUpdate(update.update)}`);

    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        log(`Error in session update listener: ${e}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  private describeToolUpdate(update: unknown): string {
    const data = update as any;
    if (!data || (data.sessionUpdate !== 'tool_call' && data.sessionUpdate !== 'tool_call_update')) {
      return '';
    }

    const fields = Object.keys(data).filter(key => key !== 'sessionUpdate');
    const summary: string[] = [];
    if (data.toolCallId) { summary.push(`id=${data.toolCallId}`); }
    if (data.title) { summary.push(`title=${JSON.stringify(data.title)}`); }
    if (data.status) { summary.push(`status=${data.status}`); }
    if (data.kind) { summary.push(`kind=${data.kind}`); }
    if (data.name) { summary.push(`name=${data.name}`); }
    if (data.command) { summary.push(`command=${JSON.stringify(data.command)}`); }
    if (Array.isArray(data.args)) { summary.push(`args=${JSON.stringify(data.args)}`); }
    if (data.query) { summary.push(`query=${JSON.stringify(data.query)}`); }
    if (data.pattern) { summary.push(`pattern=${JSON.stringify(data.pattern)}`); }
    if (data.url) { summary.push(`url=${JSON.stringify(data.url)}`); }
    if (data.content?.type) { summary.push(`contentType=${data.content.type}`); }
    if (data.location?.path) { summary.push(`path=${data.location.path}`); }
    if (data.location?.url) { summary.push(`url=${data.location.url}`); }
    if (data.path) { summary.push(`path=${data.path}`); }
    if (data.arguments?.path) { summary.push(`argPath=${data.arguments.path}`); }
    if (data.arguments?.query) { summary.push(`argQuery=${JSON.stringify(data.arguments.query)}`); }
    if (data.arguments?.url) { summary.push(`argUrl=${JSON.stringify(data.arguments.url)}`); }

    return ` (${summary.join(', ') || `fields=${fields.join(',')}`})`;
  }
}
