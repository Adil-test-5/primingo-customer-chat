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

  const showOrderInfo = (data) => {
    messagesArea.innerHTML = `
      <div class="order-info">
        <div class="order-info-row"><span>Product</span><span>${data.product}</span></div>
        <div class="order-info-row"><span>Plan</span><span>${data.plan}</span></div>
        <div class="order-info-row"><span>Status</span><span class="badge">${data.order_status}</span></div>
        <div class="order-info-row"><span>Purchased</span><span>${data.purchase_date}</span></div>
        <div class="order-info-row"><span>Expires</span><span>${data.expiry_date}</span></div>
        <div class="order-info-row"><span>Days left</span><span>${data.days_left}</span></div>
        <div class="system-message" style="margin-top: 16px;">Chat system is being prepared</div>
      </div>`;
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
      setStatus('Chat system is being prepared');
    } else if (data.session_type === 'order') {
      contextInfo.textContent = `${data.customer_name} — Order #${data.order_id}`;
      showOrderInfo(data);
    }
  } catch (err) {
    setStatus('Unable to connect. Please try again later.', true);
  }
});
