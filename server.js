require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { findOrCreateContact, findOrCreateConversation, findOrCreateSupportConversation, sendOrderContext, sendSupportContext, sendMessage, getMessages, getSession, saveSession, markConversationRead, getConversationMeta } = require('./chatwoot');
const { isNonceUsed, markNonceUsed, createOrderSession, getOrderSession, revokeOrderSessions } = require('./order-sessions');
const { scheduleNotification, startProcessing } = require('./notification-jobs');
const uploadRouter = require('./upload');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy (Railway)
app.set('trust proxy', 1);

// CORS — env-driven with hardcoded fallback
const DEFAULT_ORIGINS = [
  'https://primingo.com',
  'https://www.primingo.com',
  'https://chat.primingo.com'
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : DEFAULT_ORIGINS;

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Support-Key'],
  credentials: true
}));

app.use(cookieParser());

// --- Origin protection middleware ---
// Rejects browser requests with unexpected Origin header.
// Does not apply to: webhook, server-to-server (no Origin), or GET requests.
function checkOrigin(req, res, next) {
  const origin = req.headers.origin;
  // No Origin header = server-to-server or same-origin navigation — allow
  if (!origin) return next();
  if (allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ status: 'error', message: 'Forbidden.' });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Rate limiters ---

// Helper: hash a session key for safe use in limiter keys
function hashKey(key) {
  if (!key) return 'none';
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const guestVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip,
  message: { status: 'error', message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const supportMessageLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `${req.ip}_${hashKey(req.body?.support_key)}`,
  message: { status: 'error', message: 'Too many messages. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

const orderMessageLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => `${req.ip}_${hashKey(req.cookies?.order_chat_session)}`,
  message: { status: 'error', message: 'Too many messages. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

const supportUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.ip}_${hashKey(req.headers['x-support-key'])}`,
  message: { status: 'error', message: 'Too many uploads. Please wait before uploading again.' },
  standardHeaders: true,
  legacyHeaders: false
});

const exchangeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  message: { status: 'error', message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// --- Chatwoot Webhook (raw body needed for HMAC verification) ---

app.post('/api/webhooks/chatwoot', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const LOG = '[WEBHOOK]';

  // Signature verification
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (!secret) {
    console.error(LOG, 'CHATWOOT_WEBHOOK_SECRET not configured');
    return res.status(500).json({ status: 'error', message: 'Webhook not configured' });
  }

  const signature = req.headers['x-chatwoot-signature'];
  const timestamp = req.headers['x-chatwoot-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).json({ status: 'error', message: 'Missing signature headers' });
  }

  // Reject timestamps older than 5 minutes
  const tsAge = Math.abs(Date.now() - parseInt(timestamp, 10) * 1000);
  if (isNaN(tsAge) || tsAge > 5 * 60 * 1000) {
    return res.status(401).json({ status: 'error', message: 'Timestamp too old' });
  }

  // HMAC verification: sha256=HMAC-SHA256(secret, timestamp + "." + rawBody)
  const rawBody = req.body;
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody.toString())
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return res.status(401).json({ status: 'error', message: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Invalid signature' });
  }

  // Parse the verified body
  let payload;
  try {
    payload = JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'Invalid JSON' });
  }

  console.log(LOG, 'Received event:', payload.event);

  // Only process: message_created + outgoing + public + general-support
  if (payload.event !== 'message_created') {
    return res.json({ status: 'ok', action: 'ignored' });
  }

  const message = payload;
  const messageType = message.message_type;

  // message_type: 0 = incoming, 1 = outgoing, 2 = activity, 3 = template
  if (messageType !== 'outgoing' && messageType !== 1) {
    return res.json({ status: 'ok', action: 'ignored', reason: 'not_outgoing' });
  }

  // Only public messages (private = internal notes)
  if (message.private === true) {
    return res.json({ status: 'ok', action: 'ignored', reason: 'private_note' });
  }

  // Must be a general-support conversation — never process order-chat
  const conversation = message.conversation || {};
  const conversationId = conversation.id;
  let labels = conversation.labels || [];

  // If labels are missing/empty in the payload, fetch from Chatwoot API
  if (!labels.length && conversationId) {
    try {
      const { getConversationContact } = require('./chatwoot');
      const cwBaseUrl = process.env.CHATWOOT_BASE_URL;
      const cwAccountId = process.env.CHATWOOT_ACCOUNT_ID || '1';
      const cwToken = process.env.CHATWOOT_API_TOKEN;
      if (cwBaseUrl && cwToken) {
        const convRes = await fetch(
          `${cwBaseUrl}/api/v1/accounts/${cwAccountId}/conversations/${conversationId}`,
          { headers: { 'Content-Type': 'application/json', 'api_access_token': cwToken } }
        );
        if (convRes.ok) {
          const convData = await convRes.json();
          labels = convData.labels || [];
          console.log(LOG, 'Fetched labels from API:', labels);
        }
      }
    } catch (err) {
      console.error(LOG, 'Failed to fetch conversation labels:', err.message);
    }
  }

  // Also look up the support key for this conversation
  const supportKey = findSupportKeyByConversation(conversationId);

  // Determine if this is a valid general-support conversation:
  // 1. Has the "general-support" label, OR
  // 2. Has a session key starting with support_customer_ or support_guest_
  const hasGeneralSupportLabel = labels.includes('general-support');
  const hasValidSupportKey = supportKey && (
    supportKey.startsWith('support_customer_') || supportKey.startsWith('support_guest_')
  );

  // Explicitly reject order-chat conversations
  if (labels.includes('order-chat') || (supportKey && !supportKey.startsWith('support_'))) {
    return res.json({ status: 'ok', action: 'ignored', reason: 'order_chat_conversation' });
  }

  if (!hasGeneralSupportLabel && !hasValidSupportKey) {
    return res.json({ status: 'ok', action: 'ignored', reason: 'not_general_support' });
  }

  // For outgoing messages, payload.sender is the AGENT — never use it as customer.
  // Use conversation.meta.sender (the contact), then fall back to payload.contact.
  const conversationMeta = conversation.meta || {};
  const contactFromMeta = conversationMeta.sender || {};
  const contactFromPayload = message.contact || {};
  let customerEmail = contactFromMeta.email || contactFromPayload.email || null;
  let customerName = contactFromMeta.name || contactFromPayload.name || 'Customer';

  // If still no email, try fetching conversation details from Chatwoot
  if (!customerEmail || !customerEmail.includes('@')) {
    try {
      const { getConversationContact } = require('./chatwoot');
      const contactInfo = await getConversationContact(conversationId);
      if (contactInfo && contactInfo.email) {
        customerEmail = contactInfo.email;
        customerName = contactInfo.name || customerName;
      }
    } catch (err) {
      console.error(LOG, 'Failed to fetch contact details:', err.message);
    }
  }

  if (!customerEmail || !customerEmail.includes('@')) {
    return res.json({ status: 'ok', action: 'ignored', reason: 'no_customer_email' });
  }

  const messageId = message.id;
  const messageCreatedAt = message.created_at; // Unix timestamp from Chatwoot
  const deliveryId = req.headers['x-chatwoot-delivery'];

  const scheduled = scheduleNotification({
    conversationId,
    supportKey,
    messageId,
    messageCreatedAt,
    customerName,
    customerEmail,
    deliveryId
  });

  console.log(LOG, scheduled ? 'Job scheduled' : 'Job skipped (duplicate/cooldown)', 'conversation:', conversationId);
  res.json({ status: 'ok', action: scheduled ? 'scheduled' : 'skipped' });
});

function findSupportKeyByConversation(conversationId) {
  // Search sessions for one matching this conversation_id
  try {
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
    const sessionsFile = path.join(DATA_DIR, 'sessions.json');
    const fs = require('fs');
    if (!fs.existsSync(sessionsFile)) return null;
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    for (const key of Object.keys(data)) {
      if (data[key].conversation_id === conversationId) return key;
    }
  } catch (err) {
    // Non-critical — supportKey is optional for notification scheduling
  }
  return null;
}

app.use(express.json());
app.use(uploadRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/order-chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/order-chat/start', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Order Chat Token Helpers ---

const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;

function maskToken(t) {
  if (!t || t.length < 12) return '***';
  return t.slice(0, 6) + '...' + t.slice(-4);
}

function verifyOrderChatToken(token) {
  const secret = process.env.PRIMINGO_ORDER_CHAT_TOKEN_SECRET;
  if (!secret) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadB64, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

    // 24h expiry
    if (payload.timestamp) {
      const age = Date.now() - payload.timestamp;
      if (age > 24 * 60 * 60 * 1000 || age < -60000) return null;
    } else {
      return null;
    }

    if (!payload.order_id || !payload.item_id || !payload.jti) return null;
    if (!payload.customer_email && !payload.customer_id) return null;

    return payload;
  } catch (err) {
    return null;
  }
}

function setOrderSessionCookie(res, sessionId) {
  res.cookie('order_chat_session', sessionId, {
    httpOnly: true,
    secure: process.env.ORDER_CHAT_COOKIE_SECURE !== 'false',
    sameSite: 'lax',
    maxAge: THIRTY_DAYS_SEC * 1000,
    path: '/'
  });
}

// --- Order Chat Token Exchange ---

app.post('/api/order-chat/exchange', checkOrigin, exchangeLimiter, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Missing token.' });
  }

  console.log('[ORDER-CHAT] Exchange attempt:', maskToken(token));

  const payload = verifyOrderChatToken(token);
  if (!payload) {
    console.warn('[ORDER-CHAT] Invalid/expired token:', maskToken(token));
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token. Please open chat from Primingo My Products.' });
  }

  // One-time use check
  if (isNonceUsed(payload.jti)) {
    console.warn('[ORDER-CHAT] Nonce already used:', payload.jti);
    return res.status(401).json({ status: 'error', message: 'This link has already been used. Please open a new chat from Primingo My Products.' });
  }

  // Verify with WordPress
  const wpBaseUrl = process.env.WORDPRESS_BASE_URL;
  if (!wpBaseUrl) {
    return res.status(500).json({ status: 'error', message: 'Service configuration error.' });
  }

  try {
    // NOTE: This calls WordPress verify-session with customer_email instead of chat_token.
    // The WordPress endpoint must be updated to accept this format for the new secure flow.
    // Until then, this exchange endpoint requires the upcoming WordPress token button update.
    const wpRes = await fetch(`${wpBaseUrl}/wp-json/primingo-chat/v1/verify-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: payload.order_id,
        item_id: payload.item_id,
        customer_email: payload.customer_email
      })
    });

    if (!wpRes.ok) {
      const wpError = await wpRes.json().catch(() => null);
      const message = wpError?.message || 'Session verification failed.';
      return res.status(wpRes.status).json({ status: 'error', message });
    }

    const wpData = await wpRes.json();

    // Mark nonce as used
    markNonceUsed(payload.jti);

    // Create server-side session
    const sessionId = crypto.randomUUID();
    const sessionData = {
      order_id: wpData.order_id || payload.order_id,
      item_id: wpData.item_id || payload.item_id,
      customer_name: wpData.customer_name,
      customer_email: wpData.customer_email || payload.customer_email,
      product: wpData.product,
      plan: wpData.plan,
      order_status: wpData.status,
      purchase_date: wpData.purchase_date,
      expiry_date: wpData.expiry_date,
      days_left: wpData.days_left
    };

    createOrderSession(sessionId, sessionData);

    // Set HttpOnly cookie
    setOrderSessionCookie(res, sessionId);

    console.log('[ORDER-CHAT] Session created for order:', payload.order_id);

    res.json({
      status: 'ok',
      session_type: 'order',
      ...sessionData
    });
  } catch (err) {
    console.error('[ORDER-CHAT] Exchange error:', err.message);
    res.status(502).json({ status: 'error', message: 'Unable to verify session.' });
  }
});

// --- Order Chat Cookie Session Check ---

app.post('/api/order-chat/session', (req, res) => {
  const sessionId = req.cookies?.order_chat_session;
  if (!sessionId) {
    return res.status(401).json({ status: 'error', message: 'Please open this chat from your Primingo account.' });
  }

  const session = getOrderSession(sessionId);
  if (!session) {
    // Clear stale cookie
    res.clearCookie('order_chat_session', { path: '/' });
    return res.status(401).json({ status: 'error', message: 'Session expired. Please open this chat from your Primingo account.' });
  }

  res.json({
    status: 'ok',
    session_type: 'order',
    customer_name: session.customer_name,
    customer_email: session.customer_email,
    order_id: session.order_id,
    item_id: session.item_id,
    product: session.product,
    plan: session.plan,
    order_status: session.order_status,
    purchase_date: session.purchase_date,
    expiry_date: session.expiry_date,
    days_left: session.days_left
  });
});

// --- Order Chat Revocation ---

app.post('/api/order-chat/revoke', (req, res) => {
  const { order_id, item_id, admin_secret } = req.body;

  // Simple shared-secret auth for admin revocation
  const expectedSecret = process.env.PRIMINGO_ORDER_CHAT_TOKEN_SECRET;
  if (!expectedSecret || admin_secret !== expectedSecret) {
    return res.status(403).json({ status: 'error', message: 'Forbidden.' });
  }

  if (!order_id || !item_id) {
    return res.status(400).json({ status: 'error', message: 'Missing order_id or item_id.' });
  }

  const revoked = revokeOrderSessions(order_id, item_id);
  console.log('[ORDER-CHAT] Revoked', revoked, 'sessions for order:', order_id, 'item:', item_id);
  res.json({ status: 'ok', revoked });
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.post('/api/session/verify', checkOrigin, exchangeLimiter, async (req, res) => {
  const { type, order_id, item_id, chat_token } = req.body;

  if (type === 'general') {
    return res.json({ status: 'ok', session_type: 'general', message: 'General Support' });
  }

  // Legacy flow — can be disabled via env
  const legacyEnabled = process.env.ORDER_CHAT_LEGACY_ENABLED !== 'false';
  if (!legacyEnabled) {
    return res.status(401).json({
      status: 'error',
      message: 'Please open this chat from your Primingo account.'
    });
  }

  console.warn('[ORDER-CHAT] Legacy token flow used for order:', order_id);

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

    // Create secure session for legacy flow too
    const sessionId = crypto.randomUUID();
    const sessionData = {
      order_id: wpData.order_id,
      item_id: wpData.item_id,
      customer_name: wpData.customer_name,
      customer_email: wpData.customer_email,
      product: wpData.product,
      plan: wpData.plan,
      order_status: wpData.status,
      purchase_date: wpData.purchase_date,
      expiry_date: wpData.expiry_date,
      days_left: wpData.days_left
    };

    createOrderSession(sessionId, sessionData);
    setOrderSessionCookie(res, sessionId);

    const safeData = {
      status: 'ok',
      session_type: 'order',
      ...sessionData
    };

    res.json(safeData);
  } catch (err) {
    res.status(502).json({ status: 'error', message: 'Unable to verify session. Please try again later.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/messages/send', checkOrigin, orderMessageLimiter, async (req, res) => {
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

    res.json({ status: 'ok', message_id: result.id, created_at: result.created_at, conversation_id: conversationId });
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

// --- Support API ---

function generateSupportKey(type, identifier) {
  if (type === 'customer') {
    return `support_customer_${identifier}`;
  }
  // Guest: hash email
  const normalized = identifier.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `support_guest_${hash}`;
}

function verifySignedToken(token) {
  const secret = process.env.PRIMINGO_SUPPORT_TOKEN_SECRET;
  if (!secret) return null;

  try {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadB64, signature] = parts;

    // Validate signature is valid SHA-256 hex (64 chars)
    if (!signature || signature.length !== 64 || !/^[0-9a-f]{64}$/.test(signature)) return null;

    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');

    // Timing-safe comparison
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

    // Reject expired tokens (15 min window)
    if (payload.timestamp) {
      const age = Date.now() - payload.timestamp;
      if (age > 15 * 60 * 1000 || age < -60000) return null;
    }

    if (!payload.customer_id || !payload.email) return null;

    return payload;
  } catch (err) {
    return null;
  }
}

// Conditional limiter: token uses exchange, guest uses stricter limit
function supportVerifyLimiter(req, res, next) {
  if (req.body?.token) {
    return exchangeLimiter(req, res, next);
  }
  return guestVerifyLimiter(req, res, next);
}

app.post('/api/support/verify', checkOrigin, supportVerifyLimiter, async (req, res) => {
  const { token, name, email, website } = req.body;

  // Honeypot: hidden field filled = reject silently
  if (website) {
    return res.status(400).json({ status: 'error', message: 'Verification failed.' });
  }

  let supportKey, customerName, customerEmail, customerId;

  if (token) {
    // Logged-in customer via signed token
    const payload = verifySignedToken(token);
    if (!payload) {
      return res.status(401).json({ status: 'error', message: 'Invalid or expired token.' });
    }
    customerId = payload.customer_id;
    customerEmail = payload.email;
    customerName = payload.name || 'Customer';
    supportKey = generateSupportKey('customer', customerId);
  } else if (email) {
    // Guest flow
    customerEmail = email.trim().toLowerCase();
    customerName = (name || 'Guest').trim();
    customerId = null;
    supportKey = generateSupportKey('guest', customerEmail);
  } else {
    return res.status(400).json({ status: 'error', message: 'Provide a token or name/email.' });
  }

  const cwBase = process.env.CHATWOOT_BASE_URL;
  const cwToken = process.env.CHATWOOT_API_TOKEN;
  if (!cwBase || !cwToken) {
    return res.status(500).json({ status: 'error', message: 'Chat service not configured.' });
  }

  try {
    const contactId = await findOrCreateContact(customerEmail, customerName);
    const { conversationId, isNew } = await findOrCreateSupportConversation(contactId, supportKey, {
      customer_id: customerId,
      name: customerName,
      email: customerEmail
    });

    // Send context message only on first creation
    const session = getSession(supportKey);
    if (session && !session.support_context_sent) {
      await sendSupportContext(conversationId, {
        customer_id: customerId,
        name: customerName,
        email: customerEmail
      });
      saveSession(supportKey, { ...session, support_context_sent: true });
    }

    res.json({
      status: 'ok',
      support_key: supportKey,
      name: customerName,
      email: customerEmail
    });
  } catch (err) {
    console.error('[SUPPORT] Verify error:', err.message);
    res.status(502).json({ status: 'error', message: 'Failed to start support chat.' });
  }
});

app.post('/api/support/send', checkOrigin, supportMessageLimiter, async (req, res) => {
  const { message, support_key } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message cannot be empty.' });
  }

  if (!support_key) {
    return res.status(400).json({ status: 'error', message: 'Support session not verified.' });
  }

  const session = getSession(support_key);
  if (!session?.conversation_id) {
    return res.status(400).json({ status: 'error', message: 'Support session not found.' });
  }

  try {
    const result = await sendMessage(session.conversation_id, message.trim());
    res.json({ status: 'ok', message_id: result.id, created_at: result.created_at, conversation_id: session.conversation_id });
  } catch (err) {
    res.status(502).json({ status: 'error', message: 'Failed to send message.' });
  }
});

app.get('/api/support/history', async (req, res) => {
  const { support_key } = req.query;

  if (!support_key) {
    return res.status(400).json({ status: 'error', message: 'Support session not verified.' });
  }

  const session = getSession(support_key);
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

app.post('/api/support/mark-read', async (req, res) => {
  const { support_key } = req.body;

  if (!support_key) {
    return res.status(400).json({ status: 'error', message: 'Support session not verified.' });
  }

  const session = getSession(support_key);
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

app.get('/api/support/read-status', async (req, res) => {
  const { support_key } = req.query;

  if (!support_key) {
    return res.status(400).json({ status: 'error', message: 'Support session not verified.' });
  }

  const session = getSession(support_key);
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

// --- Support File Upload ---

const supportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const SUPPORT_ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf']);
const SUPPORT_MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', pdf: 'application/pdf'
};

// File signature validation for content-type verification
const SUPPORT_MAGIC_BYTES = {
  jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png: [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  webp: null,
  pdf: [Buffer.from('%PDF')]
};

function validateSupportFileSignature(buffer, ext) {
  if (!buffer || buffer.length < 12) return false;
  const head = buffer.slice(0, 256).toString('utf8', 0, Math.min(buffer.length, 256)).toLowerCase();
  if (head.includes('<svg') || head.includes('<!doctype') || head.includes('<html') || head.includes('<script')) {
    return false;
  }
  if (ext === 'webp') {
    return buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
           buffer.slice(8, 12).toString('ascii') === 'WEBP';
  }
  const expected = SUPPORT_MAGIC_BYTES[ext];
  if (!expected) return false;
  return expected.some(magic => buffer.slice(0, magic.length).equals(magic));
}

// Multer error handler for support uploads
function handleSupportUploadError(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ status: 'error', message: 'File too large. Maximum size is 10MB.' });
    }
    if (err.code && err.code.startsWith('LIMIT_')) {
      return res.status(400).json({ status: 'error', message: 'File upload rejected.' });
    }
    console.error('[SUPPORT UPLOAD ERROR]', err.message);
    return res.status(500).json({ status: 'error', message: 'Upload failed. Please try again.' });
  }
  next();
}

// Authentication middleware for support uploads (runs before Multer)
function requireSupportUploadSession(req, res, next) {
  const supportKey = req.headers['x-support-key'];
  if (!supportKey) {
    return res.status(401).json({ status: 'error', message: 'Support session not verified.' });
  }

  const session = getSession(supportKey);
  if (!session || !session.conversation_id) {
    return res.status(401).json({ status: 'error', message: 'Support session expired or invalid.' });
  }

  req.supportSession = session;
  req.supportKey = supportKey;
  next();
}

app.post('/api/support/upload', checkOrigin, requireSupportUploadSession, supportUploadLimiter, supportUpload.single('file'), handleSupportUploadError, async (req, res) => {
  try {
    const session = req.supportSession;

    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file provided.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    if (!SUPPORT_ALLOWED_EXTS.has(ext)) {
      return res.status(400).json({ status: 'error', message: 'Only images (jpg, png, webp) and PDF files are allowed.' });
    }

    // Validate file signature — reject content/extension mismatches
    if (!validateSupportFileSignature(req.file.buffer, ext)) {
      return res.status(400).json({ status: 'error', message: 'File content does not match the expected type.' });
    }

    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) {
      return res.status(500).json({ status: 'error', message: 'File upload service not configured.' });
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const randomName = crypto.randomUUID();
    const objectKey = `chat-uploads/${year}/${month}/support/${randomName}.${ext}`;

    const s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    });

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: req.file.buffer,
      ContentType: SUPPORT_MIME_MAP[ext] || 'application/octet-stream'
    }));

    const baseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
    const fileUrl = `${baseUrl}/${objectKey}`;

    await sendMessage(session.conversation_id, `Customer uploaded attachment: ${fileUrl}`);

    res.json({ status: 'ok', url: fileUrl, filename: req.file.originalname });
  } catch (err) {
    console.error('[SUPPORT UPLOAD ERROR]', err.message);
    res.status(502).json({ status: 'error', message: 'Upload failed. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Primingo Chat running on port ${PORT}`);
  startProcessing();
});
