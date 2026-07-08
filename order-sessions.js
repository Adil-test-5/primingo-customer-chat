const fs = require('fs');
const path = require('path');

const ORDER_SESSIONS_FILE = path.join(__dirname, 'data', 'order-sessions.json');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function ensureDataDir() {
  const dir = path.dirname(ORDER_SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadOrderSessions() {
  ensureDataDir();
  if (!fs.existsSync(ORDER_SESSIONS_FILE)) {
    return { used_nonces: {}, sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(ORDER_SESSIONS_FILE, 'utf8'));
  } catch (err) {
    return { used_nonces: {}, sessions: {} };
  }
}

function saveOrderSessions(data) {
  ensureDataDir();
  fs.writeFileSync(ORDER_SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function pruneExpired(data) {
  const now = Date.now();
  // Prune nonces older than 24h
  for (const jti of Object.keys(data.used_nonces)) {
    if (now - data.used_nonces[jti] > TWENTY_FOUR_HOURS_MS) {
      delete data.used_nonces[jti];
    }
  }
  // Prune sessions older than 30 days
  for (const sid of Object.keys(data.sessions)) {
    if (now > data.sessions[sid].expires_at) {
      delete data.sessions[sid];
    }
  }
  return data;
}

function isNonceUsed(jti) {
  const data = pruneExpired(loadOrderSessions());
  return !!data.used_nonces[jti];
}

function markNonceUsed(jti) {
  const data = pruneExpired(loadOrderSessions());
  data.used_nonces[jti] = Date.now();
  saveOrderSessions(data);
}

function createOrderSession(sessionId, sessionData) {
  const data = pruneExpired(loadOrderSessions());
  data.sessions[sessionId] = {
    ...sessionData,
    created_at: Date.now(),
    expires_at: Date.now() + THIRTY_DAYS_MS
  };
  saveOrderSessions(data);
}

function getOrderSession(sessionId) {
  if (!sessionId) return null;
  const data = pruneExpired(loadOrderSessions());
  const session = data.sessions[sessionId];
  if (!session) return null;
  if (Date.now() > session.expires_at) {
    delete data.sessions[sessionId];
    saveOrderSessions(data);
    return null;
  }
  return session;
}

function revokeOrderSessions(orderId, itemId) {
  const data = loadOrderSessions();
  let revoked = 0;
  for (const sid of Object.keys(data.sessions)) {
    const s = data.sessions[sid];
    if (String(s.order_id) === String(orderId) && String(s.item_id) === String(itemId)) {
      delete data.sessions[sid];
      revoked++;
    }
  }
  saveOrderSessions(data);
  return revoked;
}

module.exports = {
  isNonceUsed,
  markNonceUsed,
  createOrderSession,
  getOrderSession,
  revokeOrderSessions
};
