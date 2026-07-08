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
