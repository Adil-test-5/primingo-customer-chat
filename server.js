require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/order-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/session/verify', async (req, res) => {
  const { type, order_id, item_id, chat_token } = req.body;

  if (type === 'general') {
    return res.json({ status: 'ok', session_type: 'general', message: 'General Support' });
  }

  if (!order_id || !item_id) {
    return res.status(400).json({ status: 'error', message: 'Missing order_id or item_id.' });
  }

  if (!chat_token) {
    return res.status(401).json({
      status: 'error',
      message: 'Missing secure chat token. Please open chat from Primingo My Products.'
    });
  }

  const wpBaseUrl = process.env.WORDPRESS_BASE_URL;
  if (!wpBaseUrl) {
    return res.status(500).json({ status: 'error', message: 'Service configuration error. Please try again later.' });
  }

  try {
    const wpRes = await fetch(`${wpBaseUrl}/wp-json/primingo-chat/v1/verify-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id, item_id, chat_token })
    });

    if (!wpRes.ok) {
      const wpError = await wpRes.json().catch(() => null);
      const message = wpError?.message || 'Session verification failed. Please try again from Primingo My Products.';
      return res.status(wpRes.status).json({ status: 'error', message });
    }

    const wpData = await wpRes.json();

    const safeData = {
      status: 'ok',
      session_type: 'order',
      customer_name: wpData.customer_name,
      customer_email: wpData.customer_email,
      order_id: wpData.order_id,
      item_id: wpData.item_id,
      product: wpData.product,
      plan: wpData.plan,
      order_status: wpData.status,
      purchase_date: wpData.purchase_date,
      expiry_date: wpData.expiry_date,
      days_left: wpData.days_left
    };

    res.json(safeData);
  } catch (err) {
    res.status(502).json({ status: 'error', message: 'Unable to verify session. Please try again later.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Primingo Chat running on port ${PORT}`);
});
