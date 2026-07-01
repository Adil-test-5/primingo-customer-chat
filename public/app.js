document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const contextInfo = document.getElementById('context-info');

  const orderId = params.get('order_id');
  const itemId = params.get('item_id');
  const type = params.get('type');

  if (orderId && itemId) {
    contextInfo.textContent = `Order #${orderId} — Item #${itemId}`;
  } else if (type === 'general') {
    contextInfo.textContent = 'General Support';
  }
});
