const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORDER_SESSIONS_FILE = path.join(DATA_DIR, 'order-sessions.json');
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
  const tmpFile = ORDER_SESSIONS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    try { fs.chmodSync(tmpFile, 0o600); } catch (e) { /* unsupported on some platforms */ }
    fs.renameSync(tmpFile, ORDER_SESSIONS_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* cleanup best-effort */ }
    throw err;
  }
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

function updateOrderSession(sessionId, updates) {
  if (!sessionId) return false;
  const data = pruneExpired(loadOrderSessions());
  const session = data.sessions[sessionId];
  if (!session) return false;
  if (Date.now() > session.expires_at) {
    delete data.sessions[sessionId];
    saveOrderSessions(data);
    return false;
  }
  Object.assign(session, updates);
  saveOrderSessions(data);
  return true;
}

module.exports = {
  isNonceUsed,
  markNonceUsed,
  createOrderSession,
  getOrderSession,
  updateOrderSession,
  revokeOrderSessions
};
