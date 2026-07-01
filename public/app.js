document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');
  const messagesArea = document.getElementById('messages');

  const orderId = params.get('order_id');
  const itemId = params.get('item_id');
  const type = params.get('type');

  const setStatus = (text, isError) => {
    messagesArea.innerHTML = `<div class="system-message ${isError ? 'error' : ''}">${text}</div>`;
  };

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

    if (data.session_type === 'general') {
      contextInfo.textContent = 'General Support';
    } else if (data.session_type === 'order') {
      contextInfo.textContent = `Order #${data.order_id} — Item #${data.item_id}`;
    }

    setStatus('Chat system is being prepared');
  } catch (err) {
    setStatus('Unable to connect. Please try again later.', true);
  }
});
