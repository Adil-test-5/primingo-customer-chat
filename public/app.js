document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const orderPanel = document.getElementById('order-panel');
  const orderPanelBody = document.getElementById('order-panel-body');
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

  const TICK_SENT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M2 12l5 5L12 12"/><path d="M8 12l5 5L22 7"/></svg>';
  const TICK_PENDING = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 5"/></svg>';
  const TICK_FAILED = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showNotice(text, isError) {
    messagesArea.innerHTML = `<div class="system-notice ${isError ? 'error' : ''}">${text}</div>`;
  }

  function showOrderPanel(data) {
    orderPanel.classList.remove('hidden');
    orderPanelBody.innerHTML = `
      <div class="order-product-name">${escapeHtml(data.product)}</div>
      <div class="order-row"><span class="label">Plan</span><span class="value">${escapeHtml(data.plan)}</span></div>
      <div class="order-row"><span class="label">Status</span><span class="status-pill">${escapeHtml(data.order_status)}</span></div>
      <div class="order-row"><span class="label">Purchased</span><span class="value">${escapeHtml(data.purchase_date)}</span></div>
      <div class="order-row"><span class="label">Expires</span><span class="value">${escapeHtml(data.expiry_date)}</span></div>
      <div class="order-row"><span class="label">Days Left</span><span class="value">${data.days_left}</span></div>`;

    document.getElementById('btn-send-order').addEventListener('click', () => {
      const contextText = [
        `Order #${data.order_id} — Item #${data.item_id}`,
        `Product: ${data.product}`,
        `Plan: ${data.plan}`,
        `Status: ${data.order_status}`,
        `Purchased: ${data.purchase_date}`,
        `Expires: ${data.expiry_date}`,
        `Days left: ${data.days_left}`
      ].join('\n');
      const msg = addLocalMessage(contextText);
      messageQueue.push({ localId: msg.localId, content: msg.content });
      processQueue();
    });

    document.getElementById('btn-aftersale').addEventListener('click', () => {
      const msg = addLocalMessage('I need after-sale support for this order.');
      messageQueue.push({ localId: msg.localId, content: msg.content });
      processQueue();
    });
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
      messagesArea.appendChild(createBubble(msg));
    });
    scrollToBottom();
  }

  function createBubble(msg) {
    const el = document.createElement('div');
    el.className = `msg-bubble ${msg.sender}`;

    let metaHtml = '';
    if (msg.sender === 'customer' && msg.status) {
      const tickClass = msg.status;
      const tickSvg = msg.status === 'sent' ? TICK_SENT : msg.status === 'failed' ? TICK_FAILED : TICK_PENDING;
      metaHtml = `<div class="msg-meta"><span class="msg-tick ${tickClass}">${tickSvg}</span>`;
      if (msg.status === 'failed') {
        metaHtml += `<button class="retry-btn" data-local-id="${msg.localId}">Retry</button>`;
      }
      metaHtml += `</div>`;
    }

    el.innerHTML = `<div class="msg-text">${escapeHtml(msg.content)}</div>${metaHtml}`;
    return el;
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

        // Check if this is a customer message that matches an optimistic local message
        if (serverMsg.sender === 'customer') {
          const match = localMessages.find(m =>
            m.sender === 'customer' &&
            !m.serverId &&
            m.content === serverMsg.content
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
          status: serverMsg.sender === 'customer' ? 'sent' : undefined,
          serverId: serverMsg.id,
          created_at: serverMsg.created_at
        });
        changed = true;
      });

      if (changed) {
        // Sort: server messages by created_at, local pending messages stay at end
        localMessages.sort((a, b) => {
          const aTime = a.created_at || Infinity;
          const bTime = b.created_at || Infinity;
          return aTime - bTime;
        });
        renderAllMessages();
      }
    } catch (err) {}
  }

  function startPolling() {
    pollInterval = setInterval(loadHistory, 5000);
  }

  // --- Init ---
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
      showOrderPanel(data);
      messagesArea.innerHTML = '';
      enableChat();
      await loadHistory();
      startPolling();
    }
  } catch (err) {
    showNotice('Unable to connect. Please try again later.', true);
  }
});
