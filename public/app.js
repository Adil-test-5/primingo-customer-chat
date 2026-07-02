document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const orderBanner = document.getElementById('order-banner');
  const orderPanel = document.getElementById('order-panel');
  const orderCardBody = document.getElementById('order-card-body');
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

  function showOrderBanner(data) {
    orderBanner.textContent = `Selected order: #${data.order_id} — ${data.product}`;
    orderBanner.classList.remove('hidden');
  }

  function showOrderPanel(data) {
    orderPanel.classList.remove('hidden');

    const orderCardSummary = document.getElementById('order-card-summary');
    orderCardSummary.innerHTML = `
      <div class="summary-product">${escapeHtml(data.product)}</div>
      <div class="summary-detail"><span>Plan</span><span>${escapeHtml(data.plan)}</span></div>
      <div class="summary-detail"><span>Status</span><span>${escapeHtml(data.order_status)}</span></div>
      <div class="summary-detail"><span>Days Left</span><span>${data.days_left}</span></div>`;

    orderCardBody.innerHTML = `
      <div class="order-product-name">${escapeHtml(data.product)}</div>
      <div class="order-detail-row"><span class="label">Plan</span><span class="value">${escapeHtml(data.plan)}</span></div>
      <div class="order-detail-row"><span class="label">Order</span><span class="value">#${data.order_id}</span></div>
      <div class="order-detail-row"><span class="label">Item</span><span class="value">#${data.item_id}</span></div>
      <div class="order-detail-row"><span class="label">Status</span><span class="status-pill">${escapeHtml(data.order_status)}</span></div>
      <div class="order-detail-row"><span class="label">Purchased</span><span class="value">${escapeHtml(data.purchase_date)}</span></div>
      <div class="order-detail-row"><span class="label">Expires</span><span class="value">${escapeHtml(data.expiry_date)}</span></div>
      <div class="order-detail-row"><span class="label">Days Left</span><span class="value">${data.days_left}</span></div>`;

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
    console.log('[MSG_ORDER]', localMessages.map(m => ({
      content: m.content?.substring(0, 40),
      sender: m.sender,
      created_at_raw: m.created_at,
      sort_ts_ms: m.sort_ts_ms,
      chatwoot_id: m.serverId
    })));
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

    let metaHtml = '';
    if (msg.sender === 'customer' && msg.status) {
      metaHtml = `<div class="msg-meta">${getTickHtml(msg.status)}`;
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

  async function loadHistory() {
    if (!sessionData?.customer_email) return;

    try {
      const res = await fetch(`/api/messages/history?customer_email=${encodeURIComponent(sessionData.customer_email)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages) return;

      let changed = false;

      data.messages.forEach(serverMsg => {
        if (knownServerIds.has(serverMsg.id)) {
          const existing = localMessages.find(m => m.serverId === serverMsg.id);
          if (existing && existing.created_at !== serverMsg.created_at) {
            existing.created_at = serverMsg.created_at;
            changed = true;
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
          sort_ts_ms: null
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
    if (!sessionData?.customer_email) return;

    try {
      const res = await fetch(`/api/messages/read-status?customer_email=${encodeURIComponent(sessionData.customer_email)}`);
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
    if (!sessionData?.customer_email) return;
    if (document.hidden) return;

    try {
      await fetch('/api/messages/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_email: sessionData.customer_email })
      });
    } catch (err) {}
  }

  function startPolling() {
    pollInterval = setInterval(loadHistory, 5000);
    readStatusInterval = setInterval(checkReadStatus, 10000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sessionData?.customer_email) {
      markAdminMessagesRead();
    }
  });

  // --- Mobile order panel toggle ---
  const orderToggleBtn = document.getElementById('order-toggle-btn');
  if (orderToggleBtn) {
    orderToggleBtn.addEventListener('click', () => {
      const isCollapsed = orderPanel.classList.toggle('collapsed');
      orderToggleBtn.textContent = isCollapsed ? '▶' : '▼';
    });
  }

  function initMobileOrderState() {
    if (window.innerWidth <= 768) {
      orderPanel.classList.add('collapsed');
      if (orderToggleBtn) orderToggleBtn.textContent = '▶';
    } else {
      orderPanel.classList.remove('collapsed');
      if (orderToggleBtn) orderToggleBtn.textContent = '▼';
    }
  }
  initMobileOrderState();

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
      markAdminMessagesRead();
      startPolling();
    } else if (data.session_type === 'order') {
      contextInfo.textContent = `${data.customer_name} — Order #${data.order_id}`;
      showOrderBanner(data);
      showOrderPanel(data);
      messagesArea.innerHTML = '';
      enableChat();
      await loadHistory();
      markAdminMessagesRead();
      startPolling();
    }
  } catch (err) {
    showNotice('Unable to connect. Please try again later.', true);
  }
});
