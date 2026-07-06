    const vscode = acquireVsCodeApi();
    const queuedExtensionMessages = [];
    let extensionMessageHandlerReady = false;
    window.addEventListener('message', (event) => {
      if (extensionMessageHandlerReady) {
        handleExtensionMessage(event.data);
      } else {
        queuedExtensionMessages.push(event.data);
      }
    });
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const statusEl = document.getElementById('status');
    const sessionBanner = document.getElementById('sessionBanner');
    const bannerAgent = document.getElementById('bannerAgent');
    const bannerCwd = document.getElementById('bannerCwd');
    const inputArea = document.getElementById('inputArea');
    const resizeHandle = document.getElementById('resizeHandle');
    const slashPopup = document.getElementById('slashPopup');
    const contextMentionBtn = document.getElementById('contextMentionBtn');
    const composerAttachBtn = document.getElementById('composerAttachBtn');
    const bottomAttachBtn = document.getElementById('bottomAttachBtn');
    const composerNewThreadBtn = document.getElementById('composerNewThreadBtn');
    const enhancePromptBtn = document.getElementById('enhancePromptBtn');
    const composerContextChips = document.getElementById('composerContextChips');
    const contextMenu = document.getElementById('contextMenu');
    const workbenchTitle = document.getElementById('workbenchTitle');
    const headerNewThreadBtn = document.getElementById('headerNewThreadBtn');
    const workbenchTabs = Array.from(document.querySelectorAll('.workbench-tab'));
    const workbenchPanels = {
      thread: document.getElementById('threadView'),
      tasks: document.getElementById('tasksView'),
      edits: document.getElementById('editsView'),
    };
    const tasksTabCount = document.getElementById('tasksTabCount');
    const tasksProgress = document.getElementById('tasksProgress');
    const tasksList = document.getElementById('tasksList');
    const tasksEmptyState = document.getElementById('tasksEmptyState');
    const editsAddCount = document.getElementById('editsAddCount');
    const editsDeleteCount = document.getElementById('editsDeleteCount');
    const editsProgress = document.getElementById('editsProgress');
    const editsKeepAllBtn = document.getElementById('editsKeepAllBtn');
    const editsDiscardAllBtn = document.getElementById('editsDiscardAllBtn');
    const editsList = document.getElementById('editsList');
    const editsEmptyState = document.getElementById('editsEmptyState');

    // Picker elements
    const modePickerWrap = document.getElementById('modePickerWrap');
    const modePickerBtn = document.getElementById('modePickerBtn');
    const modePickerLabel = document.getElementById('modePickerLabel');
    const modeDropdown = document.getElementById('modeDropdown');
    const modelPickerWrap = document.getElementById('modelPickerWrap');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');
    const configOptionsContainer = document.getElementById('configOptionsContainer');

    let hasActiveSession = false;
    let isProcessing = false;
    let selectedContexts = [];
    let currentTasks = [];
    let currentEdits = [];

    // Modes / models state (legacy fallback path)
    let availableModes = [];
    let currentModeId = null;
    let availableModels = [];
    let currentModelId = null;

    // ACP Session Config Options state (preferred path)
    let configOptions = [];        // SessionConfigOption[]
    let useConfigOptions = false;  // true when the agent provided configOptions

    // Thinking state
    let currentThoughtEl = null;
    let currentThoughtTextEl = null;
    let currentThoughtText = '';
    let thoughtStartTime = null;
    let thoughtEndTime = null;

    // Slash commands state
    let availableCommands = [];
    let slashPopupSelectedIdx = -1;
    let slashFilteredCommands = [];
    let savedPlaceholder = 'Ask Auggie to explain, change, test, or investigate...';

    function updatePlaceholder() {
      savedPlaceholder = availableCommands.length > 0
        ? 'Ask Auggie, or type / for commands...'
        : 'Ask Auggie to explain, change, test, or investigate...';
      if (promptInput && !promptInput.value.startsWith('/')) {
        promptInput.placeholder = savedPlaceholder;
      }
    }

    // --- State persistence ---
    let chatHistory = [];
    let sessionState = null;
    let pendingTaskRestore = null;

    function saveState() {
      vscode.setState({ chatHistory, sessionState, hasActiveSession, currentTasks, currentEdits });
    }

    function restoreState() {
      const saved = vscode.getState();
      if (!saved) {
        return;
      }

      chatHistory = saved.chatHistory || [];
      sessionState = saved.sessionState || null;
      hasActiveSession = saved.hasActiveSession || false;
      currentTasks = Array.isArray(saved.currentTasks) ? saved.currentTasks : [];
      currentEdits = Array.isArray(saved.currentEdits) ? saved.currentEdits : [];

      if (hasActiveSession && sessionState) {
        showSessionConnectedFromState(sessionState);
      }

      const assistantItems = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        switch (item.kind) {
          case 'message':
            addMessageDOM(item.role, item.text);
            if (item.role === 'assistant') {
              assistantItems.push({ index: i, text: item.text });
            }
            break;
          case 'thought':
            addThoughtDOM(item.text, item.durationSec || 0);
            break;
          case 'toolCall':
            addToolCallDOM(item.toolCallId, item.title, item.status, item.details);
            break;
          case 'plan':
            addPlanDOM(item.plan);
            break;
        }
      }

      // Request markdown rendering for all restored assistant messages
      if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      }
      renderTasksView();
      renderEditsView();
    }

    function setWorkbenchTitle(title) {
      if (workbenchTitle) {
        workbenchTitle.textContent = title || 'Auggie';
      }
    }

    function setActiveWorkbenchView(view) {
      const nextView = workbenchPanels[view] ? view : 'thread';
      for (const tab of workbenchTabs) {
        const isActive = tab.dataset.view === nextView;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      for (const [key, panel] of Object.entries(workbenchPanels)) {
        if (panel) {
          panel.classList.toggle('active', key === nextView);
        }
      }
    }

    function normalizeTaskStatus(status) {
      if (status === 'completed' || status === 'complete' || status === 'done') {
        return 'completed';
      }
      if (status === 'in_progress' || status === 'in-progress' || status === 'running' || status === 'active') {
        return 'in-progress';
      }
      return 'pending';
    }

    function taskText(entry) {
      if (!entry) return 'Untitled task';
      return entry.title || entry.description || entry.content || entry.text || entry.name || 'Untitled task';
    }

    function updateTasksFromPlan(plan) {
      const entries = Array.isArray(plan?.entries) ? plan.entries : [];
      currentTasks = entries.map((entry, index) => ({
        id: entry.id || entry.taskId || String(index),
        title: taskText(entry),
        status: normalizeTaskStatus(entry.status),
        rawStatus: entry.status || 'pending',
      }));
      renderTasksView();
      persistCurrentTasks();
    }

    function resetTasksView() {
      currentTasks = [];
      renderTasksView();
    }

    function restoreTasks(tasks) {
      if (!Array.isArray(tasks) || tasks.length === 0) return;
      currentTasks = tasks.map((task, index) => ({
        id: task.id || String(index),
        title: task.title || 'Untitled task',
        status: normalizeTaskStatus(task.status),
        rawStatus: task.rawStatus || task.status || 'pending',
      }));
      renderTasksView();
      saveState();
    }

    function persistCurrentTasks() {
      if (!currentTasks.length) return;
      vscode.postMessage({
        type: 'persistTasks',
        tasks: currentTasks,
      });
      saveState();
    }

    function rebuildTasksFromHistory() {
      if (currentTasks.length > 0) return false;

      const candidateMessages = chatHistory
        .filter(item => item.kind === 'message' && item.role === 'assistant' && typeof item.text === 'string')
        .map(item => item.text)
        .reverse();

      for (const text of candidateMessages) {
        const lines = text.split(/\r?\n/);
        const taskTitles = [];
        for (const line of lines) {
          const match = line.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)(?:\*\*)?(.{4,120}?)(?:\*\*)?(?:\s+-\s+|\s+:\s+|\s+\(|$)/);
          if (!match) continue;
          const title = match[1]
            .replace(/\*\*/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!title || /^the |^and |^or /i.test(title)) continue;
          if (!taskTitles.includes(title)) {
            taskTitles.push(title);
          }
        }
        if (taskTitles.length >= 3) {
          currentTasks = taskTitles.map((title, index) => ({
            id: String(index),
            title,
            status: 'pending',
            rawStatus: 'pending',
          }));
          renderTasksView();
          persistCurrentTasks();
          return true;
        }
      }

      return false;
    }

    function renderTasksView() {
      const total = currentTasks.length;
      const completed = currentTasks.filter(task => task.status === 'completed').length;
      if (tasksTabCount) tasksTabCount.textContent = completed + '/' + total;
      if (tasksProgress) tasksProgress.textContent = completed + ' of ' + total + ' complete';
      if (!tasksList || !tasksEmptyState) return;

      tasksList.innerHTML = '';
      if (total === 0) {
        tasksEmptyState.style.display = '';
        return;
      }

      tasksEmptyState.style.display = 'none';
      for (const task of currentTasks) {
        const row = document.createElement('div');
        row.className = 'task-row ' + task.status;
        row.innerHTML =
          '<span class="task-check"></span>' +
          '<div class="task-body">' +
            '<div class="task-title"></div>' +
            '<div class="task-meta"></div>' +
          '</div>';
        const title = row.querySelector('.task-title');
        const meta = row.querySelector('.task-meta');
        if (title) title.textContent = task.title;
        if (meta) meta.textContent = task.status === 'in-progress' ? 'In progress' : task.status;
        tasksList.appendChild(row);
      }
    }

    function normalizeToolStatus(status) {
      if (status === 'completed' || status === 'complete' || status === 'done' || status === 'success') {
        return 'completed';
      }
      if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
        return 'failed';
      }
      if (status === 'pending' || status === 'queued' || status === 'waiting') {
        return 'pending';
      }
      return 'running';
    }

    function isEditToolTitle(title) {
      const text = String(title || '').trim();
      if (!text) return false;
      if (!/^(edit|edited|update|updated|write|wrote|create|created|modify|modified|replace|patched)\b/i.test(text)) {
        return false;
      }
      return /(?:^|[\s"'`(])[\w.-]+\.(?:md|markdown|ts|tsx|js|jsx|json|css|scss|html|py|txt|yml|yaml|toml|xml|sql|sh|ps1|bat|cjs|mjs|java|cs|go|rs|rb|php|vue|svelte)(?:\b|$)/i.test(text);
    }

    function extractEditFile(title) {
      let text = String(title || '').trim();
      text = text.replace(/^(edit(?:ed)?(?:\s+file)?|update(?:d)?|write|wrote|create(?:d)?|modify|modified|replace|patched)\s+/i, '');
      const match = text.match(/["'`]?([^"'`\s()]+\.(?:md|markdown|ts|tsx|js|jsx|json|css|scss|html|py|txt|yml|yaml|toml|xml|sql|sh|ps1|bat|cjs|mjs|java|cs|go|rs|rb|php|vue|svelte))["'`]?/i);
      return (match ? match[1] : text).replace(/^["'`]+|["'`]+$/g, '').trim();
    }

    function editIconForFile(file) {
      const ext = String(file || '').split('.').pop().toLowerCase();
      if (ext === 'ts' || ext === 'tsx') return 'TS';
      if (ext === 'js' || ext === 'jsx' || ext === 'cjs' || ext === 'mjs') return 'JS';
      if (ext === 'json') return '{}';
      if (ext === 'md' || ext === 'markdown') return 'MD';
      if (ext === 'css' || ext === 'scss') return '#';
      if (ext === 'py') return 'PY';
      return 'E';
    }

    function upsertEditFromTool(toolCallId, title, status) {
      if (!isEditToolTitle(title)) return;
      const file = extractEditFile(title);
      if (!file) return;

      const normalizedStatus = normalizeToolStatus(status);
      const existing = currentEdits.find(edit => edit.file === file || edit.toolCallId === toolCallId);
      if (existing) {
        existing.toolCallId = toolCallId || existing.toolCallId;
        existing.title = title || existing.title;
        existing.status = normalizedStatus;
        existing.updatedAt = Date.now();
      } else {
        currentEdits.push({
          toolCallId,
          title: title || file,
          file,
          status: normalizedStatus,
          added: 0,
          removed: 0,
          source: 'inferred',
          updatedAt: Date.now(),
        });
      }

      renderEditsView();
      saveState();
    }

    function mergeChangedFiles(files) {
      const gitEdits = Array.isArray(files)
        ? files.map((file) => ({
          toolCallId: file.toolCallId || 'git-' + file.file,
          title: file.title || 'Workspace change',
          file: file.file,
          status: file.status || 'changed',
          added: Number.isFinite(file.added) ? file.added : 0,
          removed: Number.isFinite(file.removed) ? file.removed : 0,
          source: file.source || 'git',
          binary: !!file.binary,
          untracked: !!file.untracked,
          expanded: currentEdits.find(edit => edit.file === file.file)?.expanded || false,
          diff: currentEdits.find(edit => edit.file === file.file)?.diff || '',
          diffLoaded: currentEdits.find(edit => edit.file === file.file)?.diffLoaded || false,
          updatedAt: Date.now(),
        })).filter(edit => !!edit.file)
        : [];

      const gitFiles = new Set(gitEdits.map(edit => edit.file));
      const liveInferred = currentEdits.filter(edit =>
        edit.source === 'inferred' &&
        (edit.status === 'running' || edit.status === 'pending') &&
        !gitFiles.has(edit.file)
      );

      currentEdits = gitEdits.concat(liveInferred);
      renderEditsView();
      saveState();
    }

    function updateEditDiff(file, diff) {
      const edit = currentEdits.find(item => item.file === file);
      if (!edit) return;
      edit.diff = diff || '';
      edit.diffLoaded = true;
      renderEditsView();
      saveState();
    }

    function resetEditsView() {
      currentEdits = [];
      renderEditsView();
    }

    function renderEditsView() {
      const total = currentEdits.length;
      const added = currentEdits.reduce((sum, edit) => sum + (Number(edit.added) || 0), 0);
      const removed = currentEdits.reduce((sum, edit) => sum + (Number(edit.removed) || 0), 0);

      if (editsAddCount) editsAddCount.textContent = '+' + added;
      if (editsDeleteCount) editsDeleteCount.textContent = '-' + removed;
      if (editsProgress) {
        editsProgress.textContent = total === 1
          ? '1 changed file'
          : total + ' changed files';
      }
      if (editsKeepAllBtn) editsKeepAllBtn.disabled = total === 0;
      if (editsDiscardAllBtn) editsDiscardAllBtn.disabled = total === 0;
      if (!editsList || !editsEmptyState) return;

      editsList.innerHTML = '';
      if (total === 0) {
        editsEmptyState.style.display = '';
        return;
      }

      editsEmptyState.style.display = 'none';
      const sorted = currentEdits.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const edit of sorted) {
        const row = document.createElement('div');
        row.className = 'edit-row ' + edit.status + (edit.expanded ? ' expanded' : '');
        row.innerHTML =
          '<div class="edit-summary">' +
            '<span class="edit-chevron">' + (edit.expanded ? 'v' : '>') + '</span>' +
            '<span class="edit-file-icon"></span>' +
            '<div class="edit-body">' +
              '<div class="edit-title"></div>' +
              '<div class="edit-meta"></div>' +
            '</div>' +
            '<div class="edit-delta"><span class="delta plus">+' + String(edit.added || 0) + '</span> <span class="delta minus">-' + String(edit.removed || 0) + '</span></div>' +
            '<div class="edit-actions">' +
              '<button class="edit-action" data-action="open-file" title="Open file">Open</button>' +
              '<button class="edit-action" data-action="open-diff" title="Open diff">Diff</button>' +
              '<button class="edit-action danger" data-action="discard-file" title="Discard changes to this file">Discard</button>' +
            '</div>' +
          '</div>' +
          '<div class="edit-diff"></div>';
        const icon = row.querySelector('.edit-file-icon');
        const title = row.querySelector('.edit-title');
        const meta = row.querySelector('.edit-meta');
        const diff = row.querySelector('.edit-diff');
        if (icon) icon.textContent = editIconForFile(edit.file);
        if (title) title.textContent = edit.file;
        if (meta) {
          const parts = [statusLabel(edit.status)];
          if (edit.untracked) parts.push('untracked');
          else parts.push(edit.source === 'git' ? 'workspace diff' : (edit.title || 'edited file'));
          if (edit.binary) parts.push('binary');
          meta.textContent = parts.join(' - ');
        }
        if (diff && edit.expanded) {
          renderEditDiffPreview(diff, edit);
        }
        const summary = row.querySelector('.edit-summary');
        if (summary) {
          summary.addEventListener('click', (event) => {
            if (event.target instanceof Element && event.target.closest('button')) return;
            toggleEditExpanded(edit.file);
          });
        }
        const actions = row.querySelector('.edit-actions');
        if (actions) {
          actions.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            if (!button) return;
            event.stopPropagation();
            if (button.dataset.action === 'open-file') {
              vscode.postMessage({ type: 'openChangedFile', file: edit.file });
            } else if (button.dataset.action === 'open-diff') {
              vscode.postMessage({ type: 'openChangedDiff', file: edit.file });
            } else if (button.dataset.action === 'discard-file') {
              vscode.postMessage({ type: 'discardChangedFile', file: edit.file });
            }
          });
        }
        editsList.appendChild(row);
      }
    }

    function toggleEditExpanded(file) {
      const edit = currentEdits.find(item => item.file === file);
      if (!edit) return;
      edit.expanded = !edit.expanded;
      if (edit.expanded && edit.source === 'git' && !edit.binary && !edit.diffLoaded) {
        edit.diffLoaded = false;
        vscode.postMessage({ type: 'getFileDiff', file });
      } else if (edit.expanded && edit.source !== 'git') {
        edit.diffLoaded = true;
      }
      renderEditsView();
      saveState();
    }

    function renderEditDiffPreview(container, edit) {
      container.innerHTML = '';
      if (!edit.diffLoaded) {
        container.textContent = 'Loading diff...';
        container.classList.add('loading');
        return;
      }
      container.classList.remove('loading');
      if (edit.binary) {
        container.textContent = 'Binary file preview is not available.';
        return;
      }
      if (!edit.diff) {
        container.textContent = 'No text diff available.';
        return;
      }

      const lines = edit.diff.split(/\r?\n/);
      const visibleLines = lines
        .filter(line => !line.startsWith('diff --git') && !line.startsWith('index '))
        .slice(0, 90);

      for (const line of visibleLines) {
        const el = document.createElement('div');
        el.className = 'diff-line';
        if (line.startsWith('@@')) {
          el.classList.add('hunk');
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          el.classList.add('added');
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          el.classList.add('removed');
        } else if (line.startsWith('+++') || line.startsWith('---')) {
          el.classList.add('file');
        }
        el.textContent = line || ' ';
        container.appendChild(el);
      }

      if (lines.length > visibleLines.length) {
        const more = document.createElement('div');
        more.className = 'diff-truncated';
        more.textContent = 'Diff preview truncated.';
        container.appendChild(more);
      }
    }

    // Start with input disabled
    if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let currentTurnEl = null;       // .turn container for current response
    let currentToolsListEl = null;  // .turn-tools-list inside current turn
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    let workingIndicatorEl = null;
    let workingIndicatorTextEl = null;
    let workingElapsedEl = null;
    let activityListEl = null;
    let activityStartedAt = 0;
    let activityTimer = null;
    let activityRowsById = {};
    let toolCalls = {};

    // --- Resize handle ---
    let inputAreaHeight = 140;
    const MIN_INPUT_HEIGHT = 90;
    const MAX_INPUT_HEIGHT = 400;

    function applyInputHeight(h) {
      inputAreaHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, h));
      inputArea.style.height = inputAreaHeight + 'px';
    }

    if (resizeHandle) resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = inputArea.offsetHeight;
      function onMove(ev) {
        const delta = startY - ev.clientY;
        applyInputHeight(startHeight + delta);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // --- Auto-resize textarea (within the input area constraints) ---
    if (promptInput) promptInput.addEventListener('input', () => {
      // Slash command autocomplete
      const text = promptInput.value;
      if (text.startsWith('/') && availableCommands.length > 0) {
        const firstSpace = text.indexOf(' ');
        const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
        if (firstSpace < 0) {
          // Still typing command name - show filtered popup
          slashFilteredCommands = availableCommands.filter(c =>
            c.name.toLowerCase().startsWith(query)
          );
          if (slashFilteredCommands.length > 0) {
            renderSlashPopup(slashFilteredCommands);
            slashPopup.classList.add('open');
            slashPopupSelectedIdx = 0;
            highlightSlashItem(0);
          } else {
            slashPopup.classList.remove('open');
          }
        } else {
          slashPopup.classList.remove('open');
        }
      } else {
        slashPopup.classList.remove('open');
        if (!text.startsWith('/')) {
          promptInput.placeholder = savedPlaceholder;
        }
      }
    });

    // Send on Enter (Shift+Enter for newline)
    if (promptInput) promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && contextMenu && contextMenu.classList.contains('open')) {
        e.preventDefault();
        closeContextMenu();
        return;
      }

      // Slash popup navigation
      if (slashPopup.classList.contains('open')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashPopup.classList.remove('open');
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) {
          handleCancel();
        } else {
          handleSend();
        }
      }
    });

    function handleSend() {
      const text = promptInput.value.trim();
      if (!text || isProcessing) return;

      addMessage('user', text);
      promptInput.value = '';
      vscode.postMessage({ type: 'sendPrompt', text: buildPromptWithContext(text) });
    }

    function handleCancel() {
      vscode.postMessage({ type: 'cancelTurn' });
    }

    function buildPromptWithContext(text) {
      if (selectedContexts.length === 0) return text;
      const contextLines = selectedContexts.map(c => {
        let line = '- ' + c.label;
        if (c.path) line += ' (' + c.path + ')';
        if (c.content) line += '\n```\n' + c.content + '\n```';
        return line;
      }).join('\n');
      return 'Use this context for the request:\n' + contextLines + '\n\nRequest:\n' + text;
    }

    function addContext(ctx) {
      const key = ctx.key || (ctx.kind === 'selection' ? ctx.label : (ctx.path || ctx.label));
      if (!key) return;
      if (selectedContexts.some(c => (c.key || c.path || c.label) === key)) return;
      selectedContexts.push({ ...ctx, key });
      renderContextChips();
    }

    function showComposerNotice(message) {
      if (!statusEl) return;
      const previous = statusEl.innerHTML;
      statusEl.textContent = message;
      window.setTimeout(() => {
        if (statusEl.textContent === message) {
          statusEl.innerHTML = previous;
        }
      }, 1800);
    }

    function renderContextChips() {
      if (!composerContextChips) return;
      composerContextChips.innerHTML = '';
      for (const ctx of selectedContexts) {
        const chip = document.createElement('button');
        chip.className = 'composer-context-chip';
        chip.title = ctx.path || ctx.label;
        chip.type = 'button';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = ctx.label;
        const remove = document.createElement('span');
        remove.className = 'remove';
        remove.textContent = 'x';
        remove.setAttribute('aria-hidden', 'true');
        chip.appendChild(label);
        chip.appendChild(remove);
        chip.addEventListener('click', (event) => {
          if (!(event.target instanceof Element) || !event.target.classList.contains('remove')) {
            return;
          }
          const key = ctx.key || ctx.path || ctx.label;
          selectedContexts = selectedContexts.filter(c => (c.key || c.path || c.label) !== key);
          renderContextChips();
        });
        composerContextChips.appendChild(chip);
      }
    }

    function closeContextMenu() {
      if (contextMenu) contextMenu.classList.remove('open');
      if (contextMentionBtn) contextMentionBtn.classList.remove('active');
    }

    const defaultContextMenuHtml = contextMenu ? contextMenu.innerHTML : '';

    function restoreContextMenuRoot() {
      if (contextMenu) contextMenu.innerHTML = defaultContextMenuHtml;
    }

    function openContextMenu() {
      if (!contextMenu) return;
      closePickers();
      slashPopup.classList.remove('open');
      restoreContextMenuRoot();
      contextMenu.classList.add('open');
      if (contextMentionBtn) contextMentionBtn.classList.add('active');
    }

    function toggleContextMenu() {
      if (!contextMenu) return;
      if (contextMenu.classList.contains('open')) {
        closeContextMenu();
      } else {
        openContextMenu();
      }
    }

    function handleContextMenuAction(action) {
      closeContextMenu();
      if (action === 'default') {
        addContext({ key: 'default', label: 'Default Context', kind: 'default' });
        return;
      }
      if (action === 'rules') {
        addContext({ key: 'rules', label: 'Rules & Guidelines', kind: 'rules' });
        return;
      }
      if (action === 'clear') {
        selectedContexts = [];
        renderContextChips();
        return;
      }
      if (action === 'recent') {
        renderContextMenuLoading('Recently Opened Files');
        vscode.postMessage({ type: 'listContextOptions', kind: 'recent' });
        return;
      }
      if (action === 'file' || action === 'folder') {
        vscode.postMessage({ type: 'pickContext', kind: action });
      }
    }

    function renderContextMenuLoading(title) {
      if (!contextMenu) return;
      contextMenu.innerHTML =
        '<button class="context-menu-item" data-action="back" role="menuitem">' +
          '<span class="main"><span class="icon">&lt;</span><span class="label">' + escapeHtml(title) + '</span></span>' +
        '</button>' +
        '<div class="context-menu-separator"></div>' +
        '<div class="context-menu-note">Loading...</div>';
      contextMenu.classList.add('open');
    }

    function renderRecentFilesMenu(options) {
      if (!contextMenu) return;
      contextMenu.innerHTML =
        '<button class="context-menu-item" data-action="back" role="menuitem">' +
          '<span class="main"><span class="icon">&lt;</span><span class="label">Recently Opened Files</span></span>' +
        '</button>' +
        '<div class="context-menu-separator"></div>';

      if (!Array.isArray(options) || options.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'context-menu-note';
        empty.textContent = 'No recent files available in this window.';
        contextMenu.appendChild(empty);
        return;
      }

      for (const option of options) {
        const item = document.createElement('button');
        item.className = 'context-menu-item';
        item.type = 'button';
        item.dataset.action = 'pickRecent';
        item.dataset.path = option.path || '';
        item.dataset.label = option.label || option.path || '';
        item.innerHTML =
          '<span class="main"><span class="icon">F</span><span class="label"></span></span>';
        item.querySelector('.label').textContent = option.label || option.path || 'File';
        contextMenu.appendChild(item);
      }
      contextMenu.classList.add('open');
    }

    function execCmd(command, args) {
      vscode.postMessage({ type: 'executeCommand', command, args: args || [] });
    }

    // Wire up buttons
    if (sendStopBtn) sendStopBtn.addEventListener('click', () => {
      if (isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
    });

    const welcomeConnectAgent = document.getElementById('welcomeConnectAgent');
    const welcomeAddAgent = document.getElementById('welcomeAddAgent');
    if (welcomeConnectAgent) welcomeConnectAgent.addEventListener('click', () => execCmd('auggie.connectAuggie'));
    if (welcomeAddAgent) welcomeAddAgent.addEventListener('click', () => execCmd('workbench.action.openSettings'));
    if (headerNewThreadBtn) headerNewThreadBtn.addEventListener('click', () => execCmd('auggie.newConversation'));
    for (const tab of workbenchTabs) {
      tab.addEventListener('click', () => setActiveWorkbenchView(tab.dataset.view || 'thread'));
    }
    if (contextMentionBtn) contextMentionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleContextMenu();
    });
    if (contextMenu) contextMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target instanceof Element ? e.target.closest('.context-menu-item') : null;
      if (!item) return;
      if (item.dataset.action === 'back') {
        restoreContextMenuRoot();
        return;
      }
      if (item.dataset.action === 'pickRecent') {
        closeContextMenu();
        addContext({
          path: item.dataset.path,
          label: item.dataset.label || item.dataset.path,
          kind: 'file',
        });
        return;
      }
      handleContextMenuAction(item.dataset.action);
    });
    if (composerAttachBtn) composerAttachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickContext', kind: 'selection' }));
    if (bottomAttachBtn) bottomAttachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickContext', kind: 'file' }));
    if (editsKeepAllBtn) editsKeepAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'keepAllChanges' }));
    if (editsDiscardAllBtn) editsDiscardAllBtn.addEventListener('click', () => vscode.postMessage({ type: 'discardAllChanges' }));
    if (composerNewThreadBtn) composerNewThreadBtn.addEventListener('click', () => execCmd('auggie.newConversation'));
    if (enhancePromptBtn) enhancePromptBtn.addEventListener('click', () => {
      if (!promptInput.value.trim()) {
        promptInput.value = 'Make this request clearer and more actionable: ';
      } else {
        promptInput.value = 'Improve this prompt before answering: ' + promptInput.value;
      }
      promptInput.focus();
      promptInput.dispatchEvent(new Event('input'));
    });

    function insertAtCursor(text) {
      const start = promptInput.selectionStart || 0;
      const end = promptInput.selectionEnd || 0;
      promptInput.value = promptInput.value.slice(0, start) + text + promptInput.value.slice(end);
      promptInput.selectionStart = promptInput.selectionEnd = start + text.length;
      promptInput.focus();
      promptInput.dispatchEvent(new Event('input'));
    }

    // --- Send/Stop toggle ---
    function setProcessing(processing) {
      isProcessing = processing;
      if (processing) {
        sendStopBtn.className = 'send-stop-btn stop';
        sendStopBtn.textContent = 'Stop';
        sendStopBtn.disabled = false;
        promptInput.disabled = true;
        if (statusEl) statusEl.textContent = '';
        showWorkingIndicator('Auggie is working...');
      } else {
        sendStopBtn.className = 'send-stop-btn send';
        sendStopBtn.textContent = 'Send';
        sendStopBtn.disabled = false;
        promptInput.disabled = false;
        if (statusEl) statusEl.textContent = '';
        hideWorkingIndicator();
      }
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      return minutes > 0 ? minutes + ':' + String(rest).padStart(2, '0') : seconds + 's';
    }

    function updateActivityElapsed() {
      if (workingElapsedEl && activityStartedAt) {
        workingElapsedEl.textContent = formatElapsed(Date.now() - activityStartedAt);
      }
    }

    function showWorkingIndicator(message) {
      hideEmpty();
      if (!workingIndicatorEl) {
        activityStartedAt = Date.now();
        workingIndicatorEl = document.createElement('div');
        workingIndicatorEl.className = 'working-indicator';
        workingIndicatorEl.innerHTML =
          '<div class="working-header">' +
            '<span class="spinner"></span>' +
            '<span class="working-text"></span>' +
            '<span class="working-elapsed">0s</span>' +
          '</div>' +
          '<div class="activity-list"></div>';
        workingIndicatorTextEl = workingIndicatorEl.querySelector('.working-text');
        workingElapsedEl = workingIndicatorEl.querySelector('.working-elapsed');
        activityListEl = workingIndicatorEl.querySelector('.activity-list');
        messagesEl.appendChild(workingIndicatorEl);
        updateActivityElapsed();
        activityTimer = window.setInterval(updateActivityElapsed, 1000);
      }
      if (workingIndicatorTextEl) {
        workingIndicatorTextEl.textContent = message || 'Auggie is working...';
      }
      scrollToBottom();
    }

    function updateWorkingIndicator(message) {
      if (!isProcessing) return;
      showWorkingIndicator(message);
    }

    function addActivityRow(id, label, status) {
      if (!isProcessing) return;
      showWorkingIndicator(label || 'Working...');
      if (!activityListEl) return;

      const key = id || 'activity-' + Date.now() + '-' + Math.random();
      let row = activityRowsById[key];
      if (!row) {
        row = document.createElement('div');
        row.className = 'activity-row';
        row.innerHTML = '<span class="activity-icon"></span><span class="activity-label"></span>';
        activityRowsById[key] = row;
        activityListEl.appendChild(row);
      }

      const nextStatus = status || 'running';
      row.className = 'activity-row ' + nextStatus;
      const icon = row.querySelector('.activity-icon');
      const text = row.querySelector('.activity-label');
      if (icon) icon.textContent = getStatusIcon(nextStatus);
      if (text) text.textContent = label || 'Working...';

      while (activityListEl.children.length > 6) {
        const first = activityListEl.firstElementChild;
        if (!first) break;
        first.remove();
      }
      scrollToBottom();
    }

    function hideWorkingIndicator() {
      if (activityTimer) {
        window.clearInterval(activityTimer);
      }
      if (workingIndicatorEl) {
        workingIndicatorEl.remove();
      }
      workingIndicatorEl = null;
      workingIndicatorTextEl = null;
      workingElapsedEl = null;
      activityListEl = null;
      activityStartedAt = 0;
      activityTimer = null;
      activityRowsById = {};
    }

    // --- Session/load overlay ---
    const loadOverlay = document.getElementById('loadOverlay');
    // True while a session/load replay is in progress. Used to suppress
    // per-chunk markdown rendering until the replay finishes.
    let isLoadingSession = false;

    function handleLoadSessionStart() {
      isLoadingSession = true;
      const saved = vscode.getState();
      pendingTaskRestore = saved && Array.isArray(saved.currentTasks) && saved.currentTasks.length > 0
        ? {
          sessionId: saved.sessionState?.sessionId || null,
          tasks: saved.currentTasks,
        }
        : null;
      // Reset all chat state; behaves like clearChat but keeps the session
      // banner / input area structure intact.
      chatHistory = [];
      resetTasksView();
      resetEditsView();
      saveState();
      currentAssistantEl = null;
      currentAssistantText = '';
      toolCalls = {};
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      messagesEl.innerHTML = '';
      if (emptyState) {
        messagesEl.appendChild(emptyState);
        emptyState.style.display = 'none';
      }
      if (loadOverlay) loadOverlay.classList.add('visible');
      if (inputArea) inputArea.classList.add('disabled');
      setProcessing(false);
    }

    function handleLoadSessionEnd(ok) {
      isLoadingSession = false;
      // Commit any trailing assistant turn captured during the replay.
      finalizeCurrentAssistantTurn();
      if (
        currentTasks.length === 0 &&
        pendingTaskRestore?.tasks?.length > 0 &&
        (!pendingTaskRestore.sessionId || pendingTaskRestore.sessionId === sessionState?.sessionId)
      ) {
        currentTasks = pendingTaskRestore.tasks;
        renderTasksView();
        saveState();
      }
      rebuildTasksFromHistory();
      pendingTaskRestore = null;
      if (loadOverlay) loadOverlay.classList.remove('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      // Batch-render markdown for every assistant message captured during
      // the replay (avoids per-chunk render storms).
      const items = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        if (item.kind === 'message' && item.role === 'assistant') {
          items.push({ index: i, text: item.text });
        }
      }
      if (items.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items });
      }
      vscode.postMessage({ type: 'refreshChangedFiles' });
      scrollToBottom();
      if (!ok) {
        addMessage('error', 'Failed to load session history.');
      }
    }

    function handleSessionInfoUpdate(title) {
      if (!sessionState) return;
      if (typeof title === 'string') {
        sessionState.title = title;
      } else if (title === null) {
        delete sessionState.title;
      }
      saveState();
      setWorkbenchTitle(sessionState.title || sessionState.agentName || 'Auggie');
      if (bannerAgent) {
        bannerAgent.textContent = sessionState.title || sessionState.agentName || 'Agent';
      }
    }

    // --- Mode / Model pickers ---

    // --- Slash command helpers ---
    function renderSlashPopup(commands) {
      slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
      const builtInNames = new Set(['ask', 'new', 'fork', 'parent', 'settings']);
      const builtIns = commands.filter(c => builtInNames.has(String(c.name).toLowerCase()));
      const skills = commands.filter(c => !builtInNames.has(String(c.name).toLowerCase()));

      function appendSection(title, items, first) {
        if (items.length === 0) return;
        const header = document.createElement('div');
        header.className = 'slash-popup-section' + (first ? ' first' : '');
        header.textContent = title;
        slashPopup.appendChild(header);
        items.forEach((cmd) => appendCommandItem(cmd));
      }

      let visualIndex = 0;
      function appendCommandItem(cmd) {
        const item = document.createElement('div');
        const active = visualIndex === 0;
        item.className = 'slash-popup-item' + (active ? ' active' : '');
        item.dataset.index = String(visualIndex);
        item.innerHTML =
          '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(cmd.description || '') + '</span>';
        item.addEventListener('click', () => selectSlashCommand(cmd));
        item.addEventListener('mouseenter', () => {
          slashPopupSelectedIdx = Number(item.dataset.index || 0);
          highlightSlashItem(slashPopupSelectedIdx);
        });
        slashPopup.appendChild(item);
        visualIndex++;
      }

      if (builtIns.length > 0) {
        appendSection('Built-in commands', builtIns, true);
        appendSection('Skills', skills, false);
      } else {
        appendSection('Commands', skills, true);
      }
    }

    function highlightSlashItem(idx) {
      const items = slashPopup.querySelectorAll('.slash-popup-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(cmd) {
      slashPopup.classList.remove('open');
      if (!cmd) return;

      if (cmd.input) {
        // Command expects input - insert "/name " and set placeholder to hint
        promptInput.value = '/' + cmd.name + ' ';
        promptInput.placeholder = cmd.input.hint || 'Type input...';
        promptInput.focus();
      } else {
        // No input required - send immediately
        promptInput.value = '/' + cmd.name;
        handleSend();
      }
    }

    // --- Mode / Model pickers (cont.) ---
    function updateModePicker(modes) {
      if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
        modePickerWrap.classList.add('hidden');
        availableModes = [];
        currentModeId = null;
        return;
      }
      availableModes = modes.availableModes;
      currentModeId = modes.currentModeId || null;
      modePickerWrap.classList.remove('hidden');
      const current = availableModes.find(m => m.id === currentModeId);
      modePickerLabel.textContent = current ? current.name : 'Mode';
      modePickerLabel.title = current && current.description ? current.description : '';
      renderModeDropdown();
    }

    function renderModeDropdown() {
      modeDropdown.innerHTML = '';
      for (const mode of availableModes) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (mode.id === currentModeId ? ' selected' : '');
        item.dataset.desc = mode.description || '';
        if (mode.description) item.title = mode.description;
        item.innerHTML =
          '<span class="check">' + (mode.id === currentModeId ? '?' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(mode.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (mode.id !== currentModeId) {
            currentModeId = mode.id;
            const current = availableModes.find(m => m.id === currentModeId);
            modePickerLabel.textContent = current ? current.name : 'Mode';
            renderModeDropdown();
            vscode.postMessage({ type: 'setMode', modeId: mode.id });
          }
        });
        modeDropdown.appendChild(item);
      }
    }

    function updateModelPicker(models) {
      if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      availableModels = models.availableModels;
      currentModelId = models.currentModelId || null;
      modelPickerWrap.classList.remove('hidden');
      const current = availableModels.find(m => m.modelId === currentModelId);
      modelPickerLabel.textContent = current ? current.name : 'Model';
      modelPickerLabel.title = current && current.description ? current.description : '';
      renderModelDropdown();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = '';
      for (const model of availableModels) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (model.modelId === currentModelId ? ' selected' : '');
        item.dataset.desc = model.description || '';
        if (model.description) item.title = model.description;
        item.innerHTML =
          '<span class="check">' + (model.modelId === currentModelId ? '?' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(model.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (model.modelId !== currentModelId) {
            currentModelId = model.modelId;
            const current = availableModels.find(m => m.modelId === currentModelId);
            modelPickerLabel.textContent = current ? current.name : 'Model';
            renderModelDropdown();
            vscode.postMessage({ type: 'setModel', modelId: model.modelId });
          }
        });
        modelDropdown.appendChild(item);
      }
    }

    // --- ACP Session Config Options ---

    function iconForCategory(cat) {
      switch (cat) {
        case 'mode': return '!';
        case 'model': return '';
        case 'thought_level': return '';
        default: return '';
      }
    }

    function isGroupedOptions(opt) {
      const arr = opt && opt.options;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const first = arr[0];
      return !!(first && typeof first.group === 'string' && Array.isArray(first.options));
    }

    function findOptionValue(opt, value) {
      if (!opt || !Array.isArray(opt.options)) return null;
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const hit = group.options.find(v => v && v.value === value);
          if (hit) return hit;
        }
        return null;
      }
      return opt.options.find(v => v && v.value === value) || null;
    }

    function pickerLabelFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return v && v.name ? v.name : (opt.name || 'Option');
    }

    function pickerTooltipFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return (v && v.description) || opt.description || opt.name || '';
    }

    function renderConfigPickers(opts) {
      configOptionsContainer.innerHTML = '';
      if (!Array.isArray(opts)) return;

      for (const opt of opts) {
        // Spec: ignore unknown types and empty option lists
        if (!opt || opt.type !== 'select') continue;
        if (!Array.isArray(opt.options) || opt.options.length === 0) continue;

        const wrap = document.createElement('div');
        wrap.className = 'picker-wrap';
        wrap.dataset.configId = opt.id;

        const btn = document.createElement('button');
        btn.className = 'picker-btn';
        btn.title = pickerTooltipFor(opt);
        btn.innerHTML =
          '<span class="picker-icon">' + iconForCategory(opt.category) + '</span>' +
          '<span class="picker-label"></span>' +
          '<span class="picker-chevron">v</span>';
        btn.querySelector('.picker-label').textContent = pickerLabelFor(opt);
        wrap.appendChild(btn);

        const dropdown = document.createElement('div');
        dropdown.className = 'picker-dropdown';
        renderConfigDropdown(dropdown, opt);
        wrap.appendChild(dropdown);

        configOptionsContainer.appendChild(wrap);
      }
    }

    function renderConfigDropdown(dropdown, opt) {
      dropdown.innerHTML = '';
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const header = document.createElement('div');
          header.className = 'picker-dropdown-group-header';
          header.textContent = group.name || group.group || '';
          dropdown.appendChild(header);
          for (const v of group.options) {
            dropdown.appendChild(buildConfigItem(opt, v));
          }
        }
      } else {
        for (const v of opt.options) {
          dropdown.appendChild(buildConfigItem(opt, v));
        }
      }
    }

    function buildConfigItem(opt, v) {
      const selected = v.value === opt.currentValue;
      const item = document.createElement('div');
      item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
      item.dataset.value = v.value;
      item.dataset.desc = v.description || '';
      if (v.description) item.title = v.description;
      item.innerHTML =
        '<span class="check">' + (selected ? '?' : '') + '</span>' +
        '<span class="item-label"></span>';
      item.querySelector('.item-label').textContent = v.name || v.value;
      return item;
    }

    // Event delegation: handle clicks on dynamically-rendered config pickers
    configOptionsContainer.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const item = target.closest('.picker-dropdown-item');
      if (item) {
        e.stopPropagation();
        const wrap = item.closest('.picker-wrap');
        const dropdown = item.closest('.picker-dropdown');
        if (!wrap || !dropdown) return;
        const configId = wrap.dataset.configId;
        const value = item.dataset.value;
        if (!configId || value == null) return;

        // Find option in current state
        const opt = configOptions.find(o => o && o.id === configId);
        if (!opt || value === opt.currentValue) {
          dropdown.classList.remove('open');
          return;
        }

        // Optimistic update - agent's response will replace with authoritative state
        opt.currentValue = value;
        const labelEl = wrap.querySelector('.picker-btn .picker-label');
        const btn = wrap.querySelector('.picker-btn');
        if (labelEl) labelEl.textContent = pickerLabelFor(opt);
        if (btn) btn.title = pickerTooltipFor(opt);
        renderConfigDropdown(dropdown, opt);

        dropdown.classList.remove('open');
        vscode.postMessage({ type: 'setConfigOption', configId, value });
        return;
      }

      const btn = target.closest('.picker-btn');
      if (btn) {
        e.stopPropagation();
        const wrap = btn.closest('.picker-wrap');
        if (!wrap) return;
        const dropdown = wrap.querySelector('.picker-dropdown');
        if (!dropdown) return;
        const wasOpen = dropdown.classList.contains('open');
        closePickers();
        if (!wasOpen) dropdown.classList.add('open');
      }
    });

    function setConfigOptionsState(opts) {
      configOptions = Array.isArray(opts) ? opts : [];
      useConfigOptions = configOptions.length > 0;

      if (useConfigOptions) {
        // Hide legacy pickers - spec requires configOptions to be used exclusively
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
        renderConfigPickers(configOptions);
      } else {
        configOptionsContainer.innerHTML = '';
      }
    }

    // Toggle picker dropdowns
    modePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modeDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modeDropdown.classList.add('open');
    });

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modelDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modelDropdown.classList.add('open');
    });

    function closePickers() {
      modeDropdown.classList.remove('open');
      modelDropdown.classList.remove('open');
      // Close any dynamic config-option dropdowns
      const open = configOptionsContainer.querySelectorAll('.picker-dropdown.open');
      open.forEach(el => el.classList.remove('open'));
      hidePickerTooltip();
    }

    // --- Picker hover tooltip (shared by all picker dropdowns) ---
    const pickerTooltip = document.getElementById('pickerTooltip');

    function hidePickerTooltip() {
      if (pickerTooltip) pickerTooltip.classList.remove('visible');
    }

    function showPickerTooltip(itemEl) {
      if (!pickerTooltip || !itemEl) return;
      const desc = itemEl.dataset && itemEl.dataset.desc;
      if (!desc) { hidePickerTooltip(); return; }

      pickerTooltip.textContent = desc;
      // Make it measurable while invisible to the user.
      pickerTooltip.style.left = '-9999px';
      pickerTooltip.style.top = '-9999px';
      pickerTooltip.classList.add('visible');

      const dropdown = itemEl.closest('.picker-dropdown');
      if (!dropdown) { hidePickerTooltip(); return; }
      const dropRect = dropdown.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      const tipRect = pickerTooltip.getBoundingClientRect();
      const gap = 6;

      // Prefer left side; flip to right if not enough room.
      let left = dropRect.left - tipRect.width - gap;
      if (left < 4) left = dropRect.right + gap;
      // Clamp horizontally inside the viewport.
      const maxLeft = window.innerWidth - tipRect.width - 4;
      if (left > maxLeft) left = Math.max(4, maxLeft);

      // Vertically align with the hovered item, clamped inside the viewport.
      let top = itemRect.top;
      const maxTop = window.innerHeight - tipRect.height - 4;
      if (top > maxTop) top = Math.max(4, maxTop);

      pickerTooltip.style.left = left + 'px';
      pickerTooltip.style.top = top + 'px';
    }

    // Delegated hover handling - one listener handles every picker dropdown.
    document.addEventListener('mouseover', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Only consider items inside an open dropdown.
      const dropdown = item.closest('.picker-dropdown');
      if (!dropdown || !dropdown.classList.contains('open')) return;
      showPickerTooltip(item);
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target;
      const related = e.relatedTarget;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Stay visible if the mouse moved to another item inside the same dropdown.
      if (related instanceof Element) {
        const nextItem = related.closest('.picker-dropdown-item');
        if (nextItem && nextItem !== item) return;
      }
      hidePickerTooltip();
    });

    // Hide the tooltip when the user scrolls a dropdown so it doesn't drift.
    function attachScrollHide(dropdownEl) {
      if (!dropdownEl || dropdownEl._tooltipScrollAttached) return;
      dropdownEl._tooltipScrollAttached = true;
      dropdownEl.addEventListener('scroll', hidePickerTooltip);
    }
    attachScrollHide(modeDropdown);
    attachScrollHide(modelDropdown);
    // Dynamic configOption dropdowns: rely on the same handler via event-delegation
    // (they exist inside #configOptionsContainer); attach once per dropdown when created.
    if (configOptionsContainer) {
      const mo = new MutationObserver(() => {
        configOptionsContainer.querySelectorAll('.picker-dropdown').forEach(attachScrollHide);
      });
      mo.observe(configOptionsContainer, { childList: true, subtree: true });
    }

    // Close menus when clicking outside
    document.addEventListener('click', () => {
      closePickers();
      closeContextMenu();
    });

    // --- Messages ---
    function addMessage(role, text) {
      chatHistory.push({ kind: 'message', role, text });
      saveState();
      return addMessageDOM(role, text);
    }

    function addMessageDOM(role, text) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function hideEmpty() {
      if (emptyState) emptyState.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function getStatusIcon(status) {
      switch (status) {
        case 'running': return '>';
        case 'completed': return 'v';
        case 'failed': return 'x';
        default: return '.';
      }
    }

    function statusLabel(status) {
      switch (status) {
        case 'running': return 'running';
        case 'completed': return 'completed';
        case 'failed': return 'failed';
        case 'pending': return 'waiting';
        case 'changed': return 'changed';
        default: return status || 'pending';
      }
    }

    // Ensure the current turn has a tools container
    function ensureTurnTools() {
      if (!currentTurnEl) {
        // Create turn container if none (e.g., tool call before first text)
        currentTurnEl = document.createElement('div');
        currentTurnEl.className = 'turn';
        messagesEl.appendChild(currentTurnEl);
      }
      if (!currentToolsListEl) {
        const toolsWrap = document.createElement('div');
        toolsWrap.className = 'turn-tools';

        currentToolCount = 0;
        const summary = document.createElement('div');
        summary.className = 'turn-tools-summary';
        summary.textContent = '> Tool calls';
        currentToolsCountEl = summary;
        summary.addEventListener('click', () => {
          const list = summary.nextElementSibling;
          if (list) {
            const count = parseInt(summary.dataset.count || '0', 10);
            const collapsed = list.classList.toggle('collapsed');
            summary.textContent = (collapsed ? '> ' : 'v ') + count + ' tool call' + (count !== 1 ? 's' : '');
          }
        });
        toolsWrap.appendChild(summary);

        const list = document.createElement('div');
        list.className = 'turn-tools-list';
        toolsWrap.appendChild(list);
        currentToolsListEl = list;

        currentTurnEl.appendChild(toolsWrap);
      }
    }

    function addToolCall(toolCallId, title, status, details) {
      chatHistory.push({ kind: 'toolCall', toolCallId, title, status, details: details || {} });
      saveState();
      updateWorkingIndicator(title || 'Running tool...');
      addActivityRow(toolCallId, title || 'Running tool...', status || 'running');
      addToolCallInline(toolCallId, title, status, details);
      upsertEditFromTool(toolCallId, title, status);
    }

    function addToolCallInline(toolCallId, title, status, details) {
      hideEmpty();
      ensureTurnTools();
      currentToolCount++;
      if (currentToolsCountEl) {
        currentToolsCountEl.dataset.count = String(currentToolCount);
        currentToolsCountEl.textContent = 'v ' + currentToolCount + ' tool call' + (currentToolCount !== 1 ? 's' : '');
      }

      const el = document.createElement('div');
      el.className = 'tool-call-inline';
      el.id = 'tc-' + toolCallId;
      el.innerHTML =
        '<div class="tc-header">' +
          '<span class="tc-chevron">></span>' +
          '<span class="tc-icon ' + status + '">' + getStatusIcon(status) + '</span>' +
          '<span class="tc-title">' + escapeHtml(title || 'Tool Call') + '</span>' +
          '<span class="tc-status">' + escapeHtml(statusLabel(status)) + '</span>' +
          '<span class="tc-actions">' +
            '<button class="tc-action" title="Open details">open</button>' +
            '<button class="tc-action" title="More actions">...</button>' +
          '</span>' +
        '</div>' +
        '<div class="tc-detail"></div>';
      const header = el.querySelector('.tc-header');
      if (header) {
        header.addEventListener('click', (event) => {
          if (event.target instanceof Element && event.target.closest('button')) return;
          const expanded = el.classList.toggle('expanded');
          const chevron = el.querySelector('.tc-chevron');
          if (chevron) chevron.textContent = expanded ? 'v' : '>';
        });
      }
      const openButton = el.querySelector('.tc-action');
      if (openButton) {
        openButton.addEventListener('click', (event) => {
          event.stopPropagation();
          const expanded = el.classList.toggle('expanded');
          const chevron = el.querySelector('.tc-chevron');
          if (chevron) chevron.textContent = expanded ? 'v' : '>';
        });
      }
      renderToolCallDetails(el, title, details);
      currentToolsListEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    // Fallback DOM builder for history restore (standalone card)
    function addToolCallDOM(toolCallId, title, status, details) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = 'tc-' + toolCallId;
      el.innerHTML = '<span class="title">' + escapeHtml(title || 'Tool Call') + '</span>'
        + '<span class="status-badge ' + status + '">' + status + '</span>'
        + '<div class="tc-detail"></div>';
      messagesEl.appendChild(el);
      toolCalls[toolCallId] = el;
      renderToolCallDetails(el, title, details);
      upsertEditFromTool(toolCallId, title, status);
      scrollToBottom();
    }

    function updateToolCall(toolCallId, status, title, details) {
      let activityTitle = title || '';
      let mergedDetails = details || {};
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
          activityTitle = title || chatHistory[i].title || activityTitle;
          chatHistory[i].status = status;
          if (title) chatHistory[i].title = title;
          chatHistory[i].details = mergeToolDetails(chatHistory[i].details, details);
          mergedDetails = chatHistory[i].details;
          break;
        }
      }
      saveState();
      addActivityRow(toolCallId, activityTitle || 'Tool call', status || 'completed');
      upsertEditFromTool(toolCallId, activityTitle || title, status);

      const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
      if (!el) return;

      // Inline style (turn-based)
      const iconEl = el.querySelector('.tc-icon');
      if (iconEl) {
        iconEl.className = 'tc-icon ' + status;
        iconEl.textContent = getStatusIcon(status);
        const statusEl = el.querySelector('.tc-status');
        if (statusEl) statusEl.textContent = statusLabel(status);
        if (title) {
          const titleEl = el.querySelector('.tc-title');
          if (titleEl) titleEl.textContent = title;
        }
        renderToolCallDetails(el, activityTitle || title, mergedDetails);
        return;
      }
      // Legacy card style fallback
      const badge = el.querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status;
      }
      if (title) {
        const titleEl = el.querySelector('.title');
        if (titleEl) titleEl.textContent = title;
      }
      renderToolCallDetails(el, activityTitle || title, mergedDetails);
    }

    function mergeToolDetails(existing, next) {
      if (!existing) return next || {};
      if (!next) return existing;
      return {
        ...existing,
        ...next,
        arguments: { ...(existing.arguments || {}), ...(next.arguments || {}) },
        input: { ...(existing.input || {}), ...(next.input || {}) },
        params: { ...(existing.params || {}), ...(next.params || {}) },
        result: { ...(existing.result || {}), ...(next.result || {}) },
      };
    }

    function toolArguments(details) {
      return details?.arguments ||
        details?.input ||
        details?.params?.arguments ||
        details?.params?.input ||
        details?.toolCall?.arguments ||
        {};
    }

    function textFromToolContent(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return value
          .map(item => item?.type === 'text' ? item.text : '')
          .filter(Boolean)
          .join('\n');
      }
      if (value.type === 'text') return value.text || '';
      if (Array.isArray(value.content)) return textFromToolContent(value.content);
      return '';
    }

    function parseTerminalSummary(text) {
      const summary = {};
      if (!text) return summary;
      const fields = ['terminalId', 'exitCode', 'signal', 'timedOut', 'truncated'];
      for (const field of fields) {
        const match = text.match(new RegExp('^' + field + ':\\s*(.*)$', 'm'));
        if (match) summary[field] = match[1].trim();
      }
      const outputMatch = text.match(/\r?\n\r?\n([\s\S]*)$/);
      if (outputMatch) summary.output = outputMatch[1].trim();
      return summary;
    }

    function valueAtPath(object, path) {
      if (!object || !path) return undefined;
      return path.split('.').reduce((current, part) => {
        if (current === undefined || current === null) return undefined;
        return current[part];
      }, object);
    }

    function firstUsefulValue(object, paths) {
      for (const path of paths) {
        const value = valueAtPath(object, path);
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && value.length === 0) continue;
        return value;
      }
      return undefined;
    }

    function displayList(value) {
      if (!Array.isArray(value)) return value;
      return value
        .map(item => {
          if (typeof item === 'string') return item;
          return item?.path || item?.file || item?.uri || item?.url || item?.name || '';
        })
        .filter(Boolean)
        .join(', ');
    }

    function resultCount(details) {
      const count = firstUsefulValue(details, [
        'result.count',
        'result.total',
        'result.resultCount',
        'count',
        'total',
        'resultCount',
      ]);
      if (count !== undefined) return count;

      const arrays = [
        details?.result?.matches,
        details?.matches,
        details?.result?.results,
        details?.results,
        details?.result?.files,
        details?.files,
      ];
      const found = arrays.find(Array.isArray);
      return found ? found.length : undefined;
    }

    function quotedTitleValue(title) {
      const text = String(title || '');
      const backticked = text.match(/`([^`]+)`/);
      if (backticked) return backticked[1].trim();
      const singleQuoted = text.match(/'([^']+)'/);
      if (singleQuoted) return singleQuoted[1].trim();
      const doubleQuoted = text.match(/"([^"]+)"/);
      if (doubleQuoted) return doubleQuoted[1].trim();
      return '';
    }

    function commandFromTitle(title) {
      const text = String(title || '');
      const quoted = quotedTitleValue(text);
      if (quoted && /\b(run|execute|command|powershell|cmd|shell|terminal)\b/i.test(text)) {
        return quoted;
      }
      const match = text.match(/^\s*(?:run|execute)\s+(.+)$/i);
      return match ? match[1].trim().replace(/^['"`]+|['"`]+$/g, '') : '';
    }

    function filePathFromTitle(title) {
      const quoted = quotedTitleValue(title);
      if (quoted) return quoted;
      const text = String(title || '');
      const match = text.match(/\b[\w./\\-]+\.[\w.-]+\b/);
      return match ? match[0] : '';
    }

    function queryFromTitle(title) {
      const quoted = quotedTitleValue(title);
      if (quoted && /\b(search|grep|find|ripgrep|rg|query)\b/i.test(String(title || ''))) {
        return quoted;
      }
      const match = String(title || '').match(/\b(?:search|grep|find|query)\s+(?:for\s+)?(.+)$/i);
      return match ? match[1].trim().replace(/^['"`]+|['"`]+$/g, '') : '';
    }

    function buildToolDetailModel(title, details) {
      const args = toolArguments(details);
      const contentText = textFromToolContent(details?.content) ||
        textFromToolContent(details?.result?.content) ||
        textFromToolContent(details?.output);
      const terminalSummary = parseTerminalSummary(contentText);
      const titleCommand = commandFromTitle(title);
      const command = args.command || details?.command || titleCommand || details?.name || '';
      const commandArgs = Array.isArray(args.args) ? args.args : (Array.isArray(details?.args) ? details.args : []);
      const toolIdentity = [
        title,
        details?.name,
        details?.kind,
        details?.toolName,
      ].filter(Boolean).join(' ');
      const isTerminalLike = /terminal|run_command|launch-process|shell|command/i.test([
        toolIdentity,
        command,
      ].filter(Boolean).join(' '));
      const isFileLike = /\b(read|open|view|write|edit|file|glob|list|ls)\b/i.test(toolIdentity);
      const isSearchLike = !titleCommand && /\b(search|grep|find|ripgrep|rg|query)\b/i.test(toolIdentity);
      const isExternalLike = /\b(web|http|url|fetch|get|browser|request)\b/i.test(toolIdentity);
      const filePath = firstUsefulValue({ details, args }, [
        'args.path',
        'args.file',
        'args.filePath',
        'args.filename',
        'args.uri',
        'args.paths',
        'args.files',
        'details.path',
        'details.file',
        'details.filePath',
        'details.filename',
        'details.uri',
        'details.location.path',
        'details.result.path',
        'details.result.file',
      ]) || (isFileLike ? filePathFromTitle(title) : '');
      const query = firstUsefulValue({ details, args }, [
        'args.query',
        'args.pattern',
        'args.regex',
        'args.search',
        'args.text',
        'details.query',
        'details.pattern',
        'details.regex',
        'details.search',
        'details.result.query',
      ]) || (isSearchLike ? queryFromTitle(title) : '');
      const url = firstUsefulValue({ details, args }, [
        'args.url',
        'args.uri',
        'args.href',
        'details.url',
        'details.uri',
        'details.href',
        'details.request.url',
        'details.result.url',
        'details.location.url',
      ]);
      const method = firstUsefulValue({ details, args }, [
        'args.method',
        'details.method',
        'details.request.method',
        'details.result.method',
      ]);
      const summary = firstUsefulValue(details, [
        'result.summary',
        'result.description',
        'summary',
        'description',
        'message',
      ]);

      return {
        tool: details?.name || details?.toolName || details?.kind || '',
        command,
        commandArgs,
        cwd: args.cwd || details?.cwd || '',
        filePath: displayList(filePath),
        query,
        url,
        method,
        resultCount: resultCount(details),
        summary,
        terminalId: terminalSummary.terminalId || details?.terminalId || details?.result?.terminalId || '',
        exitCode: terminalSummary.exitCode || (details?.exitCode ?? details?.result?.exitCode),
        signal: terminalSummary.signal || details?.signal || details?.result?.signal || '',
        timedOut: terminalSummary.timedOut || (details?.timedOut ?? details?.result?.timedOut),
        truncated: terminalSummary.truncated || (details?.truncated ?? details?.result?.truncated),
        output: terminalSummary.output || details?.result?.output || details?.output || contentText,
        isTerminalLike,
        isFileLike,
        isSearchLike,
        isExternalLike,
      };
    }

    function appendDetailRow(container, label, value, options) {
      if (value === undefined || value === null || value === '') return false;
      const row = document.createElement('div');
      row.className = 'tc-detail-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'tc-detail-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'tc-detail-value' + (options?.mono ? ' mono' : '');
      valueEl.textContent = String(value);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      container.appendChild(row);
      return true;
    }

    function renderToolCallDetails(el, title, details) {
      const detailEl = el ? el.querySelector('.tc-detail') : null;
      if (!detailEl) return;
      detailEl.innerHTML = '';

      const model = buildToolDetailModel(title, details || {});
      let rendered = false;
      rendered = appendDetailRow(detailEl, 'Tool', model.tool, { mono: true }) || rendered;
      if (model.command) {
        const commandText = [model.command].concat(model.commandArgs || []).join(' ');
        rendered = appendDetailRow(detailEl, 'Command', commandText, { mono: true }) || rendered;
      }
      rendered = appendDetailRow(detailEl, 'Working directory', model.cwd, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'File', model.filePath, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Query', model.query, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'URL', model.url, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Method', model.method, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Results', model.resultCount, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Summary', model.summary) || rendered;
      rendered = appendDetailRow(detailEl, 'Terminal', model.terminalId, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Exit code', model.exitCode, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Signal', model.signal, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Timed out', model.timedOut, { mono: true }) || rendered;
      rendered = appendDetailRow(detailEl, 'Truncated', model.truncated, { mono: true }) || rendered;

      if (model.output) {
        const output = String(model.output);
        const label = document.createElement('div');
        label.className = 'tc-output-label';
        label.textContent = model.isTerminalLike ? 'Output' : 'Preview';
        detailEl.appendChild(label);
        const pre = document.createElement('pre');
        pre.className = 'tc-output';
        pre.textContent = output.length > 1600
          ? output.slice(0, 1600).trimEnd() + '\n... output truncated in card ...'
          : output;
        detailEl.appendChild(pre);
        rendered = true;
      }

      if (!rendered) {
        if (model.isTerminalLike) {
          detailEl.textContent = 'Waiting for command details from Auggie.';
        } else if (model.isFileLike || model.isSearchLike || model.isExternalLike) {
          detailEl.textContent = 'Waiting for tool details from Auggie.';
        } else {
          detailEl.textContent = 'No additional details from Auggie yet.';
        }
      }
    }

    function isTerminalToolTitle(title) {
      return /terminal|run_command|run_terminal|vscode-terminal|launch-process|shell/i.test(String(title || ''));
    }

    function applyTerminalCommandRun(details) {
      if (!details) return;
      const bridgeDetails = {
        name: 'auggie-vscode-terminal',
        arguments: {
          command: details.command,
          args: Array.isArray(details.args) ? details.args : [],
          cwd: details.cwd || '',
        },
        result: {
          terminalId: details.terminalId,
          exitCode: details.exitCode,
          signal: details.signal,
          timedOut: details.timedOut,
          truncated: details.truncated,
          output: details.output || '',
        },
      };

      for (let i = chatHistory.length - 1; i >= 0; i--) {
        const item = chatHistory[i];
        if (item.kind !== 'toolCall') continue;
        if (!isTerminalToolTitle(item.title)) continue;
        item.details = mergeToolDetails(item.details, bridgeDetails);
        const el = toolCalls[item.toolCallId] || document.getElementById('tc-' + item.toolCallId);
        renderToolCallDetails(el, item.title, item.details);
        saveState();
        return;
      }
    }

    function addPlan(plan) {
      chatHistory.push({ kind: 'plan', plan: plan });
      addPlanDOM(plan);
      saveState();
    }

    function addPlanDOM(plan) {
      updateTasksFromPlan(plan);
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function finalizeThought() {
      if (!currentThoughtEl) return;
      if (thoughtEndTime) return; // already finalized
      thoughtEndTime = Date.now();
      currentThoughtEl.classList.remove('streaming');
      const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
      const summary = currentThoughtEl.querySelector('summary');
      if (summary) {
        summary.innerHTML = elapsed > 0
          ? 'Thought for ' + elapsed + 's'
          : 'Thought';
      }
    }

    /**
     * Commit the in-progress assistant turn to chatHistory (without firing
     * the live promptEnd markdown-render request - replay does that
     * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
     * the next turn starts fresh.
     */
    function finalizeCurrentAssistantTurn() {
      if (currentThoughtText) {
        finalizeThought();
        const tEnd = thoughtEndTime || Date.now();
        chatHistory.push({
          kind: 'thought',
          text: currentThoughtText,
          durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
        });
      }
      if (currentAssistantText) {
        chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
        saveState();
      }
      currentAssistantEl = null;
      currentAssistantText = '';
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
    }

    function addThoughtDOM(text, durationSec) {
      hideEmpty();
      const el = document.createElement('details');
      el.className = 'thought-block';
      el.innerHTML =
        '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : 'Thought') + '</summary>' +
        '<div class="thought-content">' + escapeHtml(text) + '</div>';
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showSessionConnected(session) {
      hasActiveSession = true;
      sessionState = {
        sessionId: session.sessionId,
        agentName: session.agentName,
        cwd: session.cwd,
        title: session.title || undefined,
      };
      saveState();
      showSessionConnectedFromState(sessionState);

      // Prefer ACP "Session Config Options" when provided. Spec: clients
      // that support configOptions MUST use them exclusively and ignore
      // the legacy modes field.
      const cfg = session.configOptions;
      if (Array.isArray(cfg) && cfg.length > 0) {
        setConfigOptionsState(cfg);
      } else {
        setConfigOptionsState([]);
        if (session.modes) updateModePicker(session.modes);
        if (session.models) updateModelPicker(session.models);
      }
      // Restore available commands
      if (session.availableCommands) {
        availableCommands = session.availableCommands;
      }
      updatePlaceholder();
    }

    function showSessionConnectedFromState(ss) {
      hasActiveSession = true;
      hideEmpty();
      const title = ss.title || ss.agentName || 'Auggie';
      setWorkbenchTitle(title);
      if (bannerAgent) bannerAgent.textContent = title;
      if (bannerCwd) bannerCwd.textContent = ss.cwd || '';
      if (sessionBanner) sessionBanner.classList.add('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
    }

    function showNoSession() {
      hasActiveSession = false;
      sessionState = null;
      resetTasksView();
      resetEditsView();
      saveState();
      setWorkbenchTitle('Auggie');
      setActiveWorkbenchView('thread');
      if (sessionBanner) sessionBanner.classList.remove('visible');
      if (emptyState) emptyState.style.display = '';
      if (inputArea) inputArea.classList.add('disabled');
      // Hide pickers when disconnected
      modePickerWrap.classList.add('hidden');
      modelPickerWrap.classList.add('hidden');
      setConfigOptionsState([]);
    }

    function handleExtensionMessage(msg) {
      switch (msg.type) {
        case 'state':
          if (msg.session) {
            showSessionConnected(msg.session);
            restoreTasks(msg.tasks || []);
          } else {
            showNoSession();
          }
          break;

        case 'promptStart':
          setProcessing(true);
          currentAssistantEl = null;
          currentAssistantText = '';
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          vscode.postMessage({ type: 'refreshChangedFiles' });
          break;

        case 'promptEnd':
          // Finalize thought block if present
          if (currentThoughtText) {
            finalizeThought();
            const tEnd = thoughtEndTime || Date.now();
            chatHistory.push({
              kind: 'thought',
              text: currentThoughtText,
              durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
            });
          }
          if (currentAssistantText) {
            chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
            saveState();
            // Request markdown rendering from extension host
            if (currentAssistantEl) {
              vscode.postMessage({
                type: 'renderMarkdown',
                items: [{ index: chatHistory.length - 1, text: currentAssistantText }]
              });
            }
          }
          setProcessing(false);
          currentAssistantEl = null;
          currentAssistantText = '';
          // Auto-collapse tool calls in completed turns
          if (currentToolsListEl && currentToolCount > 3) {
            currentToolsListEl.classList.add('collapsed');
            if (currentToolsCountEl) {
              currentToolsCountEl.dataset.count = String(currentToolCount);
              currentToolsCountEl.textContent = '> ' + currentToolCount + ' tool calls';
            }
          }
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;

        case 'clearChat':
          chatHistory = [];
          sessionState = null;
          resetTasksView();
          resetEditsView();
          saveState();
          currentAssistantEl = null;
          currentAssistantText = '';
          toolCalls = {};
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          availableCommands = [];
          slashPopup.classList.remove('open');
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          if (emptyState) emptyState.style.display = '';
          if (sessionBanner) sessionBanner.classList.remove('visible');
          if (inputArea) inputArea.classList.add('disabled');
          modePickerWrap.classList.add('hidden');
          modelPickerWrap.classList.add('hidden');
          setConfigOptionsState([]);
          setProcessing(false);
          break;

        case 'error':
          addMessage('error', msg.message || 'An error occurred');
          break;

        case 'sessionUpdate':
          handleUpdate(msg.update);
          break;

        case 'modesUpdate':
          updateModePicker(msg.modes);
          break;

        case 'modelsUpdate':
          updateModelPicker(msg.models);
          break;

        case 'configOptionsUpdate':
          setConfigOptionsState(msg.configOptions || []);
          break;

        case 'loadSessionStart':
          handleLoadSessionStart();
          break;

        case 'loadSessionEnd':
          handleLoadSessionEnd(!!msg.ok);
          break;

        case 'sessionInfoUpdate':
          handleSessionInfoUpdate(msg.title);
          break;

        case 'changedFiles':
          mergeChangedFiles(msg.files || []);
          break;

        case 'fileDiff':
          updateEditDiff(msg.file, msg.diff || '');
          break;

        case 'terminalCommandRun':
          applyTerminalCommandRun(msg.details);
          break;

        case 'contextPicked':
          addContext({
            path: msg.path,
            label: msg.label || msg.path,
            content: msg.content || '',
            kind: msg.kind || 'file',
          });
          break;

        case 'contextNotice':
          if (msg.message) {
            showComposerNotice(msg.message);
          }
          break;

        case 'contextOptions':
          if (msg.kind === 'recent') {
            renderRecentFilesMenu(msg.options || []);
          }
          break;

        case 'markdownRendered': {
          // Extension sent back rendered HTML for messages
          const rendered = msg.items || [];
          for (const item of rendered) {
            // Find the DOM element for this history item
            // For the just-completed streaming message, update the last assistant el
            const historyItem = chatHistory[item.index];
            if (!historyItem || historyItem.role !== 'assistant') continue;

            // Find the element - walk all .message.assistant elements
            const allAssistant = messagesEl.querySelectorAll('.message.assistant');
            // The item.index tracks position in chatHistory; count only assistant messages up to this index
            let assistantIdx = 0;
            for (let i = 0; i < chatHistory.length; i++) {
              if (i === item.index) break;
              if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') assistantIdx++;
            }
            const el = allAssistant[assistantIdx];
            if (el) {
              el.classList.add('md-rendered');
              el.innerHTML = item.html;
            }
          }
          scrollToBottom();
          break;
        }
      }
    }

    function handleUpdate(update) {
      if (!update) return;
      const type = update.sessionUpdate;

      switch (type) {
        case 'agent_message_chunk': {
          const content = update.content;
          if (content && content.type === 'text' && content.text) {
            currentAssistantText += content.text;
            // Don't create visible element until there's non-whitespace content
            if (!currentAssistantEl && !currentAssistantText.trim()) {
              break;
            }
            hideWorkingIndicator();
            // Auto-collapse thought when assistant text starts
            if (currentThoughtEl && currentThoughtEl.open) {
              finalizeThought();
              currentThoughtEl.open = false;
            }
            if (!currentAssistantEl) {
              // Create a turn container, assistant text goes inside it
              if (!currentTurnEl) {
                currentTurnEl = document.createElement('div');
                currentTurnEl.className = 'turn';
                messagesEl.appendChild(currentTurnEl);
                hideEmpty();
              }
              currentAssistantEl = document.createElement('div');
              currentAssistantEl.className = 'message assistant';
              currentTurnEl.insertBefore(currentAssistantEl, currentTurnEl.querySelector('.turn-tools'));
            }
            currentAssistantEl.textContent = currentAssistantText;
            scrollToBottom();
          }
          break;
        }

        case 'user_message_chunk': {
          // Only the session/load replay path emits this; live prompts
          // never echo the user's message. Use it to break apart historical
          // turns: finalize any pending assistant turn first, then append
          // the historical user message.
          const content = update.content;
          if (content && content.type === 'text' && typeof content.text === 'string') {
            finalizeCurrentAssistantTurn();
            // Coalesce consecutive user chunks into one message.
            const last = chatHistory[chatHistory.length - 1];
            if (last && last.kind === 'message' && last.role === 'user') {
              last.text += content.text;
              const allUser = messagesEl.querySelectorAll('.message.user');
              const el = allUser[allUser.length - 1];
              if (el) el.textContent = last.text;
            } else {
              addMessage('user', content.text);
            }
          }
          break;
        }

        case 'agent_thought_chunk': {
          const content = update.content;
          if (content && content.type === 'text') {
            updateWorkingIndicator('Thinking...');
            addActivityRow('thought', 'Thinking...', 'running');
            if (!currentThoughtEl) {
              // Create thought block inside turn
              if (!currentTurnEl) {
                currentTurnEl = document.createElement('div');
                currentTurnEl.className = 'turn';
                messagesEl.appendChild(currentTurnEl);
                hideEmpty();
              }
              currentThoughtEl = document.createElement('details');
              currentThoughtEl.className = 'thought-block streaming';
              currentThoughtEl.open = true;
              currentThoughtEl.innerHTML =
                '<summary><span class="thought-indicator"></span> Thinking\u2026</summary>' +
                '<div class="thought-content"></div>';
              currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
              currentTurnEl.insertBefore(currentThoughtEl, currentTurnEl.firstChild);
              thoughtStartTime = Date.now();
              currentThoughtText = '';
            }
            currentThoughtText += content.text;
            currentThoughtTextEl.textContent = currentThoughtText;
            scrollToBottom();
          }
          break;
        }

        case 'tool_call': {
          const tc = update;
          addToolCall(
            tc.toolCallId || 'unknown',
            tc.title || 'Tool Call',
            tc.status || 'pending',
            tc,
          );
          break;
        }

        case 'tool_call_update': {
          updateToolCall(
            update.toolCallId || 'unknown',
            update.status || 'completed',
            update.title,
            update,
          );
          break;
        }

        case 'plan': {
          addPlan(update);
          break;
        }

        case 'current_mode_update': {
          // Server pushed a mode change
          currentModeId = update.currentModeId || update.modeId || null;
          const current = availableModes.find(m => m.id === currentModeId);
          if (current) {
            modePickerLabel.textContent = current.name;
            renderModeDropdown();
          }
          break;
        }

        case 'config_option_update': {
          // Server pushed a full configOptions replacement
          setConfigOptionsState(update.configOptions || []);
          break;
        }

        case 'available_commands_update':
          availableCommands = update.availableCommands || [];
          updatePlaceholder();
          break;
      }
    }

    extensionMessageHandlerReady = true;
    while (queuedExtensionMessages.length > 0) {
      handleExtensionMessage(queuedExtensionMessages.shift());
    }

    // Tell extension we're ready. The extension host is the source of truth
    // for restoring sessions, so startup does not render cached webview state
    // and then replay the same conversation a second time.
    vscode.postMessage({ type: 'ready' });
