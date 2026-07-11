document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const messagesArea = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const chatComposer = document.getElementById('chat-composer');
  const guestForm = document.getElementById('guest-form');
  const guestFormFields = document.getElementById('guest-form-fields');
  const guestFormError = document.getElementById('guest-form-error');

  let sessionData = null;
  let supportKey = null;
  let knownServerIds = new Set();
  let localMessages = [];
  let messageQueue = [];
  let isProcessingQueue = false;
  let pollInterval = null;
  let readStatusInterval = null;
  let agentLastSeen = null;

  // --- WordPress Widget Communication ---
  const isWidget = params.get('widget') === '1';
  const isEmbedded = window.parent !== window;
  const ALLOWED_PARENT_ORIGINS = ['https://primingo.com', 'https://www.primingo.com'];

  function getParentOrigin() {
    try {
      if (document.referrer) {
        const url = new URL(document.referrer);
        return url.origin;
      }
    } catch (e) {}
    return null;
  }

  const parentOrigin = getParentOrigin();
  const widgetEnabled = isWidget && isEmbedded && parentOrigin && ALLOWED_PARENT_ORIGINS.includes(parentOrigin);
  let widgetIsOpen = false;
  let widgetStateKnown = false;

  function postToParent(data) {
    if (!widgetEnabled) return;
    window.parent.postMessage(data, parentOrigin);
  }

  if (widgetEnabled) {
    window.addEventListener('message', (event) => {
      if (!ALLOWED_PARENT_ORIGINS.includes(event.origin)) return;
      if (event.source !== window.parent) return;
      if (!event.data || event.data.source !== 'primingo-support-widget') return;

      if (event.data.type === 'primingo_support_widget_state') {
        widgetStateKnown = true;
        const wasOpen = widgetIsOpen;
        widgetIsOpen = !!event.data.is_open;

        if (widgetIsOpen) {
          // Widget is open — clear unread, mark read
          clearUnreadState();
          markAdminMessagesRead();
          scrollToBottom();
        } else if (!widgetIsOpen) {
          // Widget is closed — send current unread count immediately
          sendUnreadUpdate();
        }
      }
    });

    // Signal to WordPress parent that the iframe is ready
    postToParent({
      source: 'primingo-support-chat',
      type: 'primingo_support_ready'
    });
  }

  // --- Unread Notification State ---

  function getNotificationStorageKey() {
    if (!supportKey) return null;
    return 'primingo_support_notification_state:' + supportKey;
  }

  function loadNotificationState() {
    const key = getNotificationStorageKey();
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function saveNotificationState(state) {
    const key = getNotificationStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {}
  }

  function getLatestAdminMessage() {
    for (let i = localMessages.length - 1; i >= 0; i--) {
      const msg = localMessages[i];
      if (isValidAdminReply(msg)) return msg;
    }
    return null;
  }

  function getLatestAdminMessageId() {
    const msg = getLatestAdminMessage();
    return msg ? msg.serverId : null;
  }

  function isValidAdminReply(msg) {
    if (!msg.serverId) return false;
    if (msg.sender !== 'admin') return false;
    // Must have content or attachments
    const hasContent = msg.content && msg.content.trim().length > 0;
    const hasAttachments = msg.attachments && msg.attachments.length > 0;
    return hasContent || hasAttachments;
  }

  function computeUnreadCount(state) {
    var lastReadId = state.last_read_admin_id;
    var lastReadCreatedAt = state.last_read_admin_created_at;
    var baselineHadNoAdmin = !!state.baseline_had_no_admin;

    // Baseline initialized with no admin messages — count ALL valid admin messages
    if (baselineHadNoAdmin && !lastReadId) {
      var count = 0;
      var latestId = null;
      for (var i = 0; i < localMessages.length; i++) {
        if (isValidAdminReply(localMessages[i])) {
          count++;
          latestId = localMessages[i].serverId;
        }
      }
      return { count: count, latestId: latestId };
    }

    if (!lastReadId) {
      return { count: 0, latestId: null };
    }

    // Try to find the baseline message by ID
    var pastBaseline = false;
    var count = 0;
    var latestId = null;

    for (var i = 0; i < localMessages.length; i++) {
      var msg = localMessages[i];
      if (!msg.serverId) continue;

      if (!pastBaseline) {
        if (msg.serverId === lastReadId) {
          pastBaseline = true;
        }
        continue;
      }

      if (isValidAdminReply(msg)) {
        count++;
        latestId = msg.serverId;
      }
    }

    // Fallback: baseline ID not found in current history — use timestamp
    if (!pastBaseline && lastReadCreatedAt) {
      var baselineMs = toMs(lastReadCreatedAt);
      count = 0;
      latestId = null;
      for (var i = 0; i < localMessages.length; i++) {
        var msg = localMessages[i];
        if (!msg.serverId || !msg.created_at) continue;
        var msgMs = toMs(msg.created_at);
        if (!msgMs || !baselineMs || msgMs <= baselineMs) continue;
        if (isValidAdminReply(msg)) {
          count++;
          latestId = msg.serverId;
        }
      }
    }

    return { count: count, latestId: latestId };
  }

  function sendUnreadUpdate() {
    if (!widgetEnabled) return;
    var state = loadNotificationState();
    if (!state || !state.initialized) return;

    var result = computeUnreadCount(state);

    postToParent({
      source: 'primingo-support-chat',
      type: 'primingo_support_unread',
      unread_count: result.count,
      latest_message_id: result.latestId
    });
  }

  function clearUnreadState() {
    var latestAdmin = getLatestAdminMessage();
    var state = loadNotificationState() || { initialized: true };

    if (latestAdmin) {
      state.last_read_admin_id = latestAdmin.serverId;
      state.last_read_admin_created_at = latestAdmin.created_at || null;
      state.baseline_had_no_admin = false;
    }
    state.initialized = true;
    saveNotificationState(state);

    // Notify parent that unread is 0
    postToParent({
      source: 'primingo-support-chat',
      type: 'primingo_support_unread',
      unread_count: 0,
      latest_message_id: null
    });
  }

  function initializeNotificationBaseline() {
    var state = loadNotificationState();
    if (state && state.initialized) return; // Already initialized

    // First load in this browser — set baseline to latest admin message
    var latestAdmin = getLatestAdminMessage();
    if (latestAdmin) {
      saveNotificationState({
        initialized: true,
        baseline_had_no_admin: false,
        last_read_admin_id: latestAdmin.serverId,
        last_read_admin_created_at: latestAdmin.created_at || null
      });
    } else {
      // No admin messages yet — flag so first future reply triggers unread
      saveNotificationState({
        initialized: true,
        baseline_had_no_admin: true,
        last_read_admin_id: null,
        last_read_admin_created_at: null
      });
    }
  }

  function onHistoryUpdated() {
    // Called after history is loaded/polled
    var state = loadNotificationState();
    if (!state || !state.initialized) {
      initializeNotificationBaseline();
      return;
    }

    if (widgetEnabled) {
      // Wait for parent to confirm widget state before acting
      if (!widgetStateKnown) return;

      if (widgetIsOpen) {
        // Widget is open — mark everything as read
        clearUnreadState();
        markAdminMessagesRead();
      } else {
        // Widget is closed — send unread count
        sendUnreadUpdate();
      }
    }
  }

  const TICK_SENT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>';
  const TICK_DELIVERED = '<svg width="14" height="12" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12l5 5L17 7"/><path d="M8 12l5 5L23 7"/></svg>';
  const TICK_READ = '<svg width="14" height="12" viewBox="0 0 28 24" fill="none" stroke="#53bdeb" stroke-width="2.5"><path d="M2 12l5 5L17 7"/><path d="M8 12l5 5L23 7"/></svg>';
  const TICK_PENDING = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
  const TICK_FAILED = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showNotice(text, isError) {
    messagesArea.innerHTML = `<div class="system-notice ${isError ? 'error' : ''}">${text}</div>`;
  }

  function enableChat() {
    chatComposer.classList.remove('hidden');
    messageInput.disabled = false;
    messageInput.placeholder = 'Type your message...';
    sendBtn.disabled = false;
    document.getElementById('upload-btn').disabled = false;
    document.getElementById('emoji-btn').disabled = false;
    messageInput.focus();
  }

  function isNearBottom() {
    const threshold = 80;
    return messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < threshold;
  }

  function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function getTickHtml(status) {
    switch (status) {
      case 'read': return `<span class="msg-tick read">${TICK_READ}</span>`;
      case 'delivered': return `<span class="msg-tick delivered">${TICK_DELIVERED}</span>`;
      case 'sent': return `<span class="msg-tick sent">${TICK_SENT}</span>`;
      case 'sending': return `<span class="msg-tick sending">${TICK_PENDING}</span>`;
      case 'queued': return `<span class="msg-tick queued">${TICK_PENDING}</span>`;
      case 'failed': return `<span class="msg-tick failed">${TICK_FAILED}</span>`;
      default: return '';
    }
  }

  function toMs(ts) {
    if (!ts) return null;
    if (typeof ts === 'string') return new Date(ts).getTime();
    if (ts > 1e12) return ts;
    return ts * 1000;
  }

  function getSortTs(msg) {
    const serverTs = toMs(msg.created_at);
    if (serverTs) return serverTs;
    if (msg.client_created_at_ms) return msg.client_created_at_ms;
    return Infinity;
  }

  function sortMessages() {
    localMessages.forEach(msg => {
      msg.sort_ts_ms = getSortTs(msg);
    });
    localMessages.sort((a, b) => {
      if (a.sort_ts_ms !== b.sort_ts_ms) return a.sort_ts_ms - b.sort_ts_ms;
      const aId = a.serverId || Infinity;
      const bId = b.serverId || Infinity;
      return aId - bId;
    });
  }

  function renderAllMessages() {
    const wasNearBottom = isNearBottom();
    messagesArea.innerHTML = '';
    localMessages.forEach(msg => {
      messagesArea.appendChild(createBubble(msg));
    });
    if (wasNearBottom) scrollToBottom();
  }

  function createBubble(msg) {
    const el = document.createElement('div');
    el.className = `msg-bubble ${msg.sender}`;

    let contentHtml = '';
    const attachmentMatch = msg.content && msg.content.match(/^Customer uploaded attachment:\s*(https?:\/\/\S+)$/);

    if (attachmentMatch) {
      const url = attachmentMatch[1];
      const isImage = /\.(jpg|jpeg|png|webp)$/i.test(url);
      if (isImage) {
        contentHtml = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="msg-attachment-img" src="${escapeHtml(url)}" alt="Uploaded image"></a>`;
      } else {
        contentHtml = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="msg-attachment-link">📎 ${escapeHtml(msg.uploadName || 'Attached file')}</a>`;
      }
    } else if (msg.attachments && msg.attachments.length > 0) {
      if (msg.content && msg.content.trim()) {
        contentHtml = `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
      }
      msg.attachments.forEach(att => {
        const url = att.url;
        const isImage = att.type === 'image' || /\.(jpg|jpeg|png|webp|gif)$/i.test(url);
        if (isImage) {
          contentHtml += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="msg-attachment-img" src="${escapeHtml(url)}" alt="Attached image"></a>`;
        } else {
          contentHtml += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="msg-attachment-link">📎 Attached file</a>`;
        }
      });
    } else if (msg.uploadStatus === 'uploading') {
      contentHtml = `<div class="msg-upload-progress">⏳ Uploading ${escapeHtml(msg.uploadName || 'file')}...</div>`;
    } else if (msg.uploadStatus === 'error') {
      contentHtml = `<div class="msg-upload-error">❌ ${escapeHtml(msg.content)}</div>`;
    } else {
      contentHtml = `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
    }

    let metaHtml = '';
    if (msg.sender === 'customer' && msg.status) {
      metaHtml = `<div class="msg-meta">${getTickHtml(msg.status)}`;
      if (msg.status === 'failed') {
        metaHtml += `<button class="retry-btn" data-local-id="${msg.localId}">Retry</button>`;
      }
      metaHtml += `</div>`;
    }

    el.innerHTML = `${contentHtml}${metaHtml}`;
    return el;
  }

  function addLocalMessage(text) {
    const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const msg = { localId, content: text, sender: 'customer', status: 'queued', serverId: null, created_at: null, client_created_at_ms: Date.now(), sort_ts_ms: null };
    localMessages.push(msg);
    sortMessages();
    renderAllMessages();
    return msg;
  }

  function updateLocalMessageStatus(localId, status, serverId, createdAt) {
    const msg = localMessages.find(m => m.localId === localId);
    if (msg) {
      msg.status = status;
      if (serverId) {
        msg.serverId = serverId;
        knownServerIds.add(serverId);
      }
      if (createdAt) {
        msg.created_at = createdAt;
        msg.client_created_at_ms = null;
      }
    }
    sortMessages();
    renderAllMessages();
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
      const item = messageQueue[0];
      updateLocalMessageStatus(item.localId, 'sending');

      try {
        const res = await fetch('/api/support/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: item.content,
            support_key: supportKey
          })
        });

        if (res.ok) {
          const data = await res.json();
          updateLocalMessageStatus(item.localId, 'delivered', data.message_id, data.created_at);
        } else {
          updateLocalMessageStatus(item.localId, 'failed');
        }
      } catch (err) {
        updateLocalMessageStatus(item.localId, 'failed');
      }

      messageQueue.shift();
    }

    isProcessingQueue = false;
  }

  function retryMessage(localId) {
    const msg = localMessages.find(m => m.localId === localId);
    if (!msg) return;
    msg.status = 'queued';
    messageQueue.push({ localId: msg.localId, content: msg.content });
    renderAllMessages();
    processQueue();
  }

  messagesArea.addEventListener('click', (e) => {
    const btn = e.target.closest('.retry-btn');
    if (btn) retryMessage(btn.dataset.localId);
  });

  function handleSend() {
    const text = messageInput.value.trim();
    if (!text) return;
    messageInput.value = '';
    closeEmojiPicker();
    const msg = addLocalMessage(text);
    messageQueue.push({ localId: msg.localId, content: msg.content });
    processQueue();
  }

  sendBtn.addEventListener('click', handleSend);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  // --- File Upload ---
  const ALLOWED_UPLOAD_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
  const uploadBtn = document.getElementById('upload-btn');
  const fileInput = document.getElementById('file-input');

  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.value && fileInput.files[0];
    fileInput.value = '';
    if (!file || !supportKey) return;

    const ext = file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
      const errMsg = addLocalMessage('Upload failed: Only images (jpg, png, webp) and PDF files are allowed.');
      errMsg.uploadStatus = 'error';
      sortMessages();
      renderAllMessages();
      return;
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      const errMsg = addLocalMessage('Upload failed: File too large. Maximum size is 10MB.');
      errMsg.uploadStatus = 'error';
      sortMessages();
      renderAllMessages();
      return;
    }

    const localId = 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const uploadMsg = { localId, content: '', sender: 'customer', status: 'sending', serverId: null, created_at: null, client_created_at_ms: Date.now(), sort_ts_ms: null, uploadStatus: 'uploading', uploadName: file.name };
    localMessages.push(uploadMsg);
    sortMessages();
    renderAllMessages();

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('support_key', supportKey);

      const res = await fetch('/api/support/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (res.ok && data.url) {
        uploadMsg.content = `Customer uploaded attachment: ${data.url}`;
        uploadMsg.uploadStatus = null;
        uploadMsg.status = 'delivered';
        uploadMsg.uploadName = data.filename || file.name;
      } else {
        uploadMsg.content = data.message || 'Upload failed. Please try again.';
        uploadMsg.uploadStatus = 'error';
        uploadMsg.status = 'failed';
      }
    } catch (err) {
      uploadMsg.content = 'Upload failed. Please try again.';
      uploadMsg.uploadStatus = 'error';
      uploadMsg.status = 'failed';
    }

    sortMessages();
    renderAllMessages();
  });

  // --- Emoji Picker ---
  const EMOJI_LIST = [
    '😀','😃','😄','😁','😂','😊','🙂','😉','😍','🥰',
    '👍','👎','👌','✌️','🙏','👏','🙌','💪','👋','🤝',
    '❤️','💙','💛','💚','🔥','✨','🎉','✅','❌','⚠️',
    '💯','⭐','🚀','💡','📌','📎','🔒','🔑','📧','📱',
    '💻','🛒','💳','🎁','⏳','📦','🧾','🛠️','🔄',
    'ℹ️','❓','💬'
  ];

  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPicker = document.getElementById('emoji-picker');
  const emojiGrid = document.getElementById('emoji-grid');
  const emojiPickerClose = document.getElementById('emoji-picker-close');

  // Populate emoji grid
  EMOJI_LIST.forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.setAttribute('aria-label', emoji);
    btn.addEventListener('click', () => insertEmoji(emoji));
    emojiGrid.appendChild(btn);
  });

  function insertEmoji(emoji) {
    const start = messageInput.selectionStart || 0;
    const end = messageInput.selectionEnd || 0;
    const before = messageInput.value.substring(0, start);
    const after = messageInput.value.substring(end);
    messageInput.value = before + emoji + after;
    const newPos = start + emoji.length;
    messageInput.setSelectionRange(newPos, newPos);
    messageInput.focus();
    closeEmojiPicker();
  }

  function openEmojiPicker() {
    emojiPicker.classList.remove('hidden');
    emojiBtn.setAttribute('aria-expanded', 'true');
  }

  function closeEmojiPicker() {
    emojiPicker.classList.add('hidden');
    emojiBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleEmojiPicker() {
    if (emojiPicker.classList.contains('hidden')) {
      openEmojiPicker();
    } else {
      closeEmojiPicker();
    }
  }

  emojiBtn.addEventListener('click', toggleEmojiPicker);
  emojiPickerClose.addEventListener('click', () => {
    closeEmojiPicker();
    messageInput.focus();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !emojiPicker.classList.contains('hidden')) {
      closeEmojiPicker();
      messageInput.focus();
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!emojiPicker.classList.contains('hidden') &&
        !emojiPicker.contains(e.target) &&
        e.target !== emojiBtn &&
        !emojiBtn.contains(e.target)) {
      closeEmojiPicker();
    }
  });

  async function loadHistory() {
    if (!supportKey) return;

    try {
      const res = await fetch(`/api/support/history?support_key=${encodeURIComponent(supportKey)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages) return;

      let changed = false;

      data.messages.forEach(serverMsg => {
        if (knownServerIds.has(serverMsg.id)) {
          const existing = localMessages.find(m => m.serverId === serverMsg.id);
          if (existing) {
            if (existing.created_at !== serverMsg.created_at) {
              existing.created_at = serverMsg.created_at;
              changed = true;
            }
            if (serverMsg.attachments && serverMsg.attachments.length > 0 && !existing.attachments) {
              existing.attachments = serverMsg.attachments;
              changed = true;
            }
          }
          return;
        }

        if (serverMsg.sender === 'customer') {
          const match = localMessages.find(m =>
            m.sender === 'customer' &&
            !m.serverId &&
            m.content === serverMsg.content
          );
          if (match) {
            match.serverId = serverMsg.id;
            match.status = 'delivered';
            match.created_at = serverMsg.created_at;
            match.client_created_at_ms = null;
            knownServerIds.add(serverMsg.id);
            changed = true;
            return;
          }
        }

        knownServerIds.add(serverMsg.id);
        localMessages.push({
          localId: 'server_' + serverMsg.id,
          content: serverMsg.content,
          sender: serverMsg.sender,
          status: serverMsg.sender === 'customer' ? 'delivered' : undefined,
          serverId: serverMsg.id,
          created_at: serverMsg.created_at,
          client_created_at_ms: null,
          sort_ts_ms: null,
          attachments: serverMsg.attachments || null
        });
        changed = true;
      });

      if (changed) {
        sortMessages();
        renderAllMessages();
      }

      onHistoryUpdated();
    } catch (err) {}
  }

  async function checkReadStatus() {
    if (!supportKey) return;

    try {
      const res = await fetch(`/api/support/read-status?support_key=${encodeURIComponent(supportKey)}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.agent_last_seen) {
        const newLastSeen = data.agent_last_seen;
        if (newLastSeen !== agentLastSeen) {
          agentLastSeen = newLastSeen;
          const agentLastSeenMs = toMs(agentLastSeen);
          let changed = false;
          localMessages.forEach(msg => {
            if (msg.sender === 'customer' && msg.serverId && msg.created_at && msg.status !== 'read') {
              const msgMs = toMs(msg.created_at);
              if (msgMs && agentLastSeenMs && msgMs <= agentLastSeenMs) {
                msg.status = 'read';
                changed = true;
              }
            }
          });
          if (changed) renderAllMessages();
        }
      }
    } catch (err) {}
  }

  async function markAdminMessagesRead() {
    if (!supportKey) return;
    if (document.hidden) return;
    // In widget mode, only mark read when widget is open
    if (widgetEnabled && !widgetIsOpen) return;

    try {
      await fetch('/api/support/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ support_key: supportKey })
      });
    } catch (err) {}
  }

  function startPolling() {
    pollInterval = setInterval(loadHistory, 5000);
    readStatusInterval = setInterval(checkReadStatus, 10000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && supportKey) {
      markAdminMessagesRead();
    }
  });

  // --- Session Management ---

  function saveSupportSession(key, data) {
    localStorage.setItem('primingo_support_session', JSON.stringify({ support_key: key, ...data }));
  }

  function loadSupportSession() {
    try {
      const raw = localStorage.getItem('primingo_support_session');
      if (raw) return JSON.parse(raw);
    } catch (err) {}
    return null;
  }

  async function startSupportChat(key, name, email) {
    supportKey = key;
    contextInfo.textContent = `${name} — General Support`;
    guestForm.classList.add('hidden');
    messagesArea.innerHTML = '';
    enableChat();
    await loadHistory();
    initializeNotificationBaseline();
    if (widgetEnabled && widgetStateKnown && widgetIsOpen) {
      clearUnreadState();
    }
    markAdminMessagesRead();
    startPolling();
  }

  // --- Token Verification ---

  async function verifyToken(token) {
    try {
      const res = await fetch('/api/support/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      if (!res.ok) return null;
      const data = await res.json();
      if (data.status === 'ok') return data;
      return null;
    } catch (err) {
      return null;
    }
  }

  async function verifyGuest(name, email) {
    const res = await fetch('/api/support/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Verification failed');
    }

    return res.json();
  }

  // --- Guest Form ---

  guestFormFields.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('guest-name').value.trim();
    const email = document.getElementById('guest-email').value.trim();

    if (!name || !email) return;

    guestFormError.classList.add('hidden');

    try {
      const data = await verifyGuest(name, email);
      saveSupportSession(data.support_key, { name: data.name, email: data.email });
      await startSupportChat(data.support_key, data.name, data.email);
    } catch (err) {
      guestFormError.textContent = err.message || 'Failed to start support chat.';
      guestFormError.classList.remove('hidden');
    }
  });

  // --- Init ---

  showNotice('Loading...');

  const token = params.get('token');

  // Try token first
  if (token) {
    const data = await verifyToken(token);
    if (data) {
      saveSupportSession(data.support_key, { name: data.name, email: data.email });
      await startSupportChat(data.support_key, data.name, data.email);
      return;
    }
    // Token invalid — fall through to guest form or saved session
  }

  // Try saved session from localStorage
  const saved = loadSupportSession();
  if (saved && saved.support_key) {
    await startSupportChat(saved.support_key, saved.name || 'Guest', saved.email || '');
    return;
  }

  // Show guest form
  messagesArea.innerHTML = '';
  guestForm.classList.remove('hidden');
});
