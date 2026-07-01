require('dotenv').config();
const express = require('express');
const path = require('path');
const { findOrCreateContact, findOrCreateConversation, sendOrderContext, sendMessage, getMessages, getSession, saveSession, markConversationRead, getConversationMeta } = require('./chatwoot');

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

app.post('/api/messages/send', async (req, res) => {
  const { message, session_type, customer_email, customer_name, order_data } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message cannot be empty.' });
  }

  if (!customer_email) {
    return res.status(400).json({ status: 'error', message: 'Session not verified.' });
  }

  const cwBase = process.env.CHATWOOT_BASE_URL;
  const cwToken = process.env.CHATWOOT_API_TOKEN;
  if (!cwBase || !cwToken) {
    return res.status(500).json({ status: 'error', message: 'Chat service not configured.' });
  }

  try {
    const contactId = await findOrCreateContact(customer_email, customer_name || 'Customer');
    const { conversationId, isNew } = await findOrCreateConversation(contactId, customer_email, order_data);

    if (session_type === 'order' && order_data) {
      const session = getSession(customer_email);
      if (session && !session.order_context_sent) {
        await sendOrderContext(conversationId, order_data);
        saveSession(customer_email, { ...session, order_context_sent: true });
      }
    }

    const result = await sendMessage(conversationId, message.trim());

    res.json({ status: 'ok', message_id: result.id, conversation_id: conversationId });
  } catch (err) {
    res.status(502).json({ status: 'error', message: 'Failed to send message. Please try again.' });
  }
});

app.get('/api/messages/history', async (req, res) => {
  const { customer_email } = req.query;

  if (!customer_email) {
    return res.status(400).json({ status: 'error', message: 'Session not verified.' });
  }

  const cwBase = process.env.CHATWOOT_BASE_URL;
  const cwToken = process.env.CHATWOOT_API_TOKEN;
  if (!cwBase || !cwToken) {
    return res.json({ status: 'ok', messages: [] });
  }

  let session = getSession(customer_email);

  // If no local session, try to find contact and conversation from Chatwoot
  if (!session?.conversation_id) {
    try {
      const contactId = await findOrCreateContact(customer_email, 'Customer');
      const { conversationId } = await findOrCreateConversation(contactId, customer_email);
      session = getSession(customer_email);
    } catch (err) {
      return res.json({ status: 'ok', messages: [] });
    }
  }

  if (!session?.conversation_id) {
    return res.json({ status: 'ok', messages: [] });
  }

  try {
    const messages = await getMessages(session.conversation_id);
    res.json({ status: 'ok', messages });
  } catch (err) {
    res.status(502).json({ status: 'error', message: 'Failed to load messages.' });
  }
});

app.post('/api/messages/mark-read', async (req, res) => {
  const { customer_email } = req.body;

  if (!customer_email) {
    return res.status(400).json({ status: 'error', message: 'Session not verified.' });
  }

  const session = getSession(customer_email);
  if (!session?.conversation_id) {
    return res.json({ status: 'ok' });
  }

  try {
    await markConversationRead(session.conversation_id);
    res.json({ status: 'ok' });
  } catch (err) {
    res.json({ status: 'ok' });
  }
});

app.get('/api/messages/read-status', async (req, res) => {
  const { customer_email } = req.query;

  if (!customer_email) {
    return res.status(400).json({ status: 'error', message: 'Session not verified.' });
  }

  const session = getSession(customer_email);
  if (!session?.conversation_id) {
    return res.json({ status: 'ok', agent_read: false, agent_last_seen: null });
  }

  try {
    const meta = await getConversationMeta(session.conversation_id);
    res.json({ status: 'ok', agent_read: meta.agentRead, agent_last_seen: meta.agentLastSeen });
  } catch (err) {
    res.json({ status: 'ok', agent_read: false, agent_last_seen: null });
  }
});

app.listen(PORT, () => {
  console.log(`Primingo Chat running on port ${PORT}`);
});
