document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const messagesArea = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  const orderId = params.get('order_id');
  const itemId = params.get('item_id');
  const type = params.get('type');

  let sessionData = null;

  const setStatus = (text, isError) => {
    messagesArea.innerHTML = `<div class="system-message ${isError ? 'error' : ''}">${text}</div>`;
  };

  const showOrderInfo = (data) => {
    messagesArea.innerHTML = `
      <div class="order-info">
        <div class="order-info-row"><span>Product</span><span>${data.product}</span></div>
        <div class="order-info-row"><span>Plan</span><span>${data.plan}</span></div>
        <div class="order-info-row"><span>Status</span><span class="badge">${data.order_status}</span></div>
        <div class="order-info-row"><span>Purchased</span><span>${data.purchase_date}</span></div>
        <div class="order-info-row"><span>Expires</span><span>${data.expiry_date}</span></div>
        <div class="order-info-row"><span>Days left</span><span>${data.days_left}</span></div>
      </div>`;
  };

  const enableChat = () => {
    messageInput.disabled = false;
    messageInput.placeholder = 'Type your message...';
    sendBtn.disabled = false;
  };

  const addMessage = (text, status) => {
    const existing = messagesArea.querySelector('.order-info');
    if (!existing && messagesArea.querySelector('.system-message')) {
      messagesArea.innerHTML = '';
    }

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message';
    msgEl.innerHTML = `
      <div class="msg-text">${text}</div>
      <div class="msg-status ${status}">${status}</div>`;
    messagesArea.appendChild(msgEl);
    messagesArea.style.alignItems = 'flex-start';
    messagesArea.scrollTop = messagesArea.scrollHeight;
    return msgEl;
  };

  const updateMessageStatus = (msgEl, status) => {
    const statusEl = msgEl.querySelector('.msg-status');
    statusEl.className = `msg-status ${status}`;
    statusEl.textContent = status;

    const retryBtn = msgEl.querySelector('.retry-btn');
    if (retryBtn) retryBtn.remove();

    if (status === 'failed') {
      const btn = document.createElement('button');
      btn.className = 'retry-btn';
      btn.textContent = 'Retry';
      btn.onclick = () => retrySend(msgEl);
      statusEl.after(btn);
    }
  };

  const sendMessageToServer = async (msgEl, text) => {
    updateMessageStatus(msgEl, 'sending');
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_type: sessionData.session_type,
          customer_email: sessionData.customer_email,
          customer_name: sessionData.customer_name,
          order_data: sessionData.session_type === 'order' ? sessionData : null
        })
      });

      if (!res.ok) {
        updateMessageStatus(msgEl, 'failed');
        return;
      }

      updateMessageStatus(msgEl, 'sent');
    } catch (err) {
      updateMessageStatus(msgEl, 'failed');
    }
  };

  const retrySend = (msgEl) => {
    const text = msgEl.querySelector('.msg-text').textContent;
    sendMessageToServer(msgEl, text);
  };

  const handleSend = () => {
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = '';
    const msgEl = addMessage(text, 'sending');
    sendMessageToServer(msgEl, text);
  };

  sendBtn.addEventListener('click', handleSend);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  setStatus('Verifying session...');

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
      setStatus(data.message, true);
      return;
    }

    sessionData = data;

    if (data.session_type === 'general') {
      contextInfo.textContent = 'General Support';
      messagesArea.innerHTML = '';
      enableChat();
    } else if (data.session_type === 'order') {
      contextInfo.textContent = `${data.customer_name} — Order #${data.order_id}`;
      showOrderInfo(data);
      enableChat();
    }
  } catch (err) {
    setStatus('Unable to connect. Please try again later.', true);
  }
});
