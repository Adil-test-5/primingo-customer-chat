const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function ensureDataDir() {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadSessions() {
  ensureDataDir();
  if (!fs.existsSync(SESSIONS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function saveSessions(data) {
  ensureDataDir();
  const tmpFile = SESSIONS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    try { fs.chmodSync(tmpFile, 0o600); } catch (e) { /* unsupported on some platforms */ }
    fs.renameSync(tmpFile, SESSIONS_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* cleanup best-effort */ }
    throw err;
  }
}

function getSession(email) {
  const sessions = loadSessions();
  return sessions[email] || null;
}

function saveSession(email, sessionData) {
  const sessions = loadSessions();
  sessions[email] = sessionData;
  saveSessions(sessions);
}

module.exports = { getSession, saveSession };
