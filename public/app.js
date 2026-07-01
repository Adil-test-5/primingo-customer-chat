document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const orderCard = document.getElementById('order-card');
  const messagesArea = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  const orderId = params.get('order_id');
  const itemId = params.get('item_id');
  const type = params.get('type');

  let sessionData = null;
  let knownServerIds = new Set();
  let localMessages = [];
  let messageQueue = [];
  let isProcessingQueue = false;
  let pollInterval = null;

  const TICK_SENT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12l5 5L20 5"/><path d="M7 12l5 5L22 7"/></svg>';
  const TICK_PENDING = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 5"/></svg>';
  const TICK_FAILED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';

  function showNotice(text, isError) {
    messagesArea.innerHTML = `<div class="system-notice ${isError ? 'error' : ''}">${text}</div>`;
  }

  function showOrderCard(data) {
    orderCard.classList.remove('hidden');
    orderCard.innerHTML = `
      <span class="order-tag"><strong>${data.product}</strong></span>
      <span class="order-tag">Plan: <strong>${data.plan}</strong></span>
      <span class="order-tag">Status: <strong>${data.order_status}</strong></span>
      <span class="order-tag">Expires: <strong>${data.expiry_date}</strong> (${data.days_left}d)</span>`;
  }

  function enableChat() {
    messageInput.disabled = false;
    messageInput.placeholder = 'Type your message...';
    sendBtn.disabled = false;
    messageInput.focus();
  }

  function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function renderAllMessages() {
    messagesArea.innerHTML = '';
    localMessages.forEach(msg => {
      const el = createBubble(msg);
      messagesArea.appendChild(el);
    });
    scrollToBottom();
  }

  function createBubble(msg) {
    const el = document.createElement('div');
    el.className = `msg-bubble ${msg.sender}`;
    el.dataset.localId = msg.localId || '';

    let metaHtml = '';
    if (msg.sender === 'customer') {
      let tickClass = msg.status || 'sent';
      let tickSvg = tickClass === 'sent' ? TICK_SENT : tickClass === 'failed' ? TICK_FAILED : TICK_PENDING;
      metaHtml = `<div class="msg-meta"><span class="msg-tick ${tickClass}">${tickSvg}</span>`;
      if (msg.status === 'failed') {
        metaHtml += `<button class="retry-btn" data-local-id="${msg.localId}">Retry</button>`;
      }
      metaHtml += `</div>`;
    }

    el.innerHTML = `<div class="msg-text">${escapeHtml(msg.content)}</div>${metaHtml}`;
    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function addLocalMessage(text) {
    const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const msg = { localId, content: text, sender: 'customer', status: 'queued', serverId: null };
    localMessages.push(msg);
    renderAllMessages();
    return msg;
  }

  function updateLocalMessageStatus(localId, status, serverId) {
    const msg = localMessages.find(m => m.localId === localId);
    if (msg) {
      msg.status = status;
      if (serverId) {
        msg.serverId = serverId;
        knownServerIds.add(serverId);
      }
    }
    renderAllMessages();
  }

  async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
      const item = messageQueue[0];
      updateLocalMessageStatus(item.localId, 'sending');

      try {
        const res = await fetch('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: item.content,
            session_type: sessionData.session_type,
            customer_email: sessionData.customer_email,
            customer_name: sessionData.customer_name,
            order_data: sessionData.session_type === 'order' ? sessionData : null
          })
        });

        if (res.ok) {
          const data = await res.json();
          updateLocalMessageStatus(item.localId, 'sent', data.message_id);
          messageQueue.shift();
        } else {
          updateLocalMessageStatus(item.localId, 'failed');
          messageQueue.shift();
        }
      } catch (err) {
        updateLocalMessageStatus(item.localId, 'failed');
        messageQueue.shift();
      }
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

  async function loadHistory() {
    if (!sessionData?.customer_email) return;

    try {
      const res = await fetch(`/api/messages/history?customer_email=${encodeURIComponent(sessionData.customer_email)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages) return;

      let changed = false;

      data.messages.forEach(serverMsg => {
        if (knownServerIds.has(serverMsg.id)) return;

        if (serverMsg.sender === 'customer') {
          const match = localMessages.find(m =>
            m.sender === 'customer' && !m.serverId && m.content === serverMsg.content
          );
          if (match) {
            match.serverId = serverMsg.id;
            match.status = 'sent';
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
          status: 'sent',
          serverId: serverMsg.id,
          created_at: serverMsg.created_at
        });
        changed = true;
      });

      if (changed) {
        localMessages.sort((a, b) => {
          const aTime = a.created_at || 0;
          const bTime = b.created_at || 0;
          if (aTime && bTime) return aTime - bTime;
          if (aTime) return -1;
          if (bTime) return 1;
          return 0;
        });
        renderAllMessages();
      }
    } catch (err) {}
  }

  function startPolling() {
    pollInterval = setInterval(loadHistory, 5000);
  }

  showNotice('Verifying session...');

  const body = {};
  if (type === 'general') {
    body.type = 'general';
  } else {
    body.order_id = orderId;
    body.item_id = itemId;
    body.chat_token = params.get('chat_token');
  }

  try {
    const res = await fetch('/api/session/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      contextInfo.textContent = '';
      showNotice(data.message, true);
      return;
    }

    sessionData = data;

    if (data.session_type === 'general') {
      contextInfo.textContent = 'General Support';
      messagesArea.innerHTML = '';
      enableChat();
      await loadHistory();
      startPolling();
    } else if (data.session_type === 'order') {
      contextInfo.textContent = `${data.customer_name} — Order #${data.order_id}`;
      showOrderCard(data);
      messagesArea.innerHTML = '';
      enableChat();
      await loadHistory();
      startPolling();
    }
  } catch (err) {
    showNotice('Unable to connect. Please try again later.', true);
  }
});
