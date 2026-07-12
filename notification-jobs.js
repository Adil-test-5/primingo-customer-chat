const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./email-provider');
const { getSession } = require('./sessions');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'notification-jobs.json');
const TEMP_FILE = JOBS_FILE + '.tmp';
const LOG_PREFIX = '[NOTIFY]';

const DELAY_SECONDS = parseInt(process.env.EMAIL_NOTIFICATION_DELAY_SECONDS || '180', 10);
const COOLDOWN_SECONDS = parseInt(process.env.EMAIL_NOTIFICATION_COOLDOWN_SECONDS || '900', 10);

// Normalize Chatwoot timestamps to Unix seconds.
// Chatwoot sends created_at as Unix seconds (integer).
// contact_last_seen_at may be an ISO string or Unix seconds.
function normalizeToUnixSeconds(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') {
    // If it looks like milliseconds (> year 2100 in seconds), convert
    return ts > 4102444800 ? Math.floor(ts / 1000) : ts;
  }
  if (typeof ts === 'string') {
    const parsed = new Date(ts).getTime();
    return isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }
  return 0;
}

// --- Persistence (atomic writes) ---

function ensureDataDir() {
  const dir = path.dirname(JOBS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJobs() {
  ensureDataDir();
  if (!fs.existsSync(JOBS_FILE)) return { pending: [], sent: {}, seen_ids: {} };
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to load jobs file:', err.message);
    return { pending: [], sent: {}, seen_ids: {} };
  }
}

function saveJobs(data) {
  ensureDataDir();
  // Atomic write: write to temp file, then rename
  fs.writeFileSync(TEMP_FILE, JSON.stringify(data, null, 2));
  fs.renameSync(TEMP_FILE, JOBS_FILE);
}

// --- Job Scheduling ---

function scheduleNotification({ conversationId, supportKey, messageId, messageCreatedAt, customerName, customerEmail, deliveryId }) {
  const data = loadJobs();

  // Deduplicate by message ID or delivery ID
  const dedupKey = deliveryId || `msg_${messageId}`;
  if (data.seen_ids[dedupKey]) {
    console.log(LOG_PREFIX, 'Duplicate ignored:', dedupKey);
    return false;
  }

  // Cooldown check: one email per conversation per COOLDOWN_SECONDS
  const lastSent = data.sent[conversationId];
  if (lastSent && (Date.now() - lastSent) < COOLDOWN_SECONDS * 1000) {
    console.log(LOG_PREFIX, 'Cooldown active for conversation:', conversationId);
    return false;
  }

  // Remove any existing pending job for this conversation (latest message wins)
  data.pending = data.pending.filter(j => j.conversationId !== conversationId);

  // Normalize Chatwoot created_at to Unix seconds
  const messageCreatedAtSeconds = normalizeToUnixSeconds(messageCreatedAt);

  data.seen_ids[dedupKey] = Date.now();
  data.pending.push({
    conversationId,
    supportKey,
    messageId,
    messageCreatedAt: messageCreatedAtSeconds,
    customerName,
    customerEmail,
    dedupKey,
    scheduledAt: Date.now(),
    sendAfter: Date.now() + DELAY_SECONDS * 1000
  });

  // Prune old seen_ids (older than 24h)
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const key of Object.keys(data.seen_ids)) {
    if (data.seen_ids[key] < dayAgo) delete data.seen_ids[key];
  }

  // Prune old sent timestamps (older than cooldown * 2)
  const cutoff = Date.now() - COOLDOWN_SECONDS * 2 * 1000;
  for (const key of Object.keys(data.sent)) {
    if (data.sent[key] < cutoff) delete data.sent[key];
  }

  saveJobs(data);
  console.log(LOG_PREFIX, 'Job scheduled for conversation:', conversationId, 'sendAfter:', new Date(data.pending[data.pending.length - 1].sendAfter).toISOString());
  return true;
}

// --- Job Processing ---

async function processJobs() {
  const data = loadJobs();
  if (!data.pending.length) return;

  const now = Date.now();
  const ready = data.pending.filter(j => now >= j.sendAfter);
  if (!ready.length) return;

  const remaining = data.pending.filter(j => now < j.sendAfter);

  for (const job of ready) {
    try {
      // Check if customer has already read the conversation
      if (await hasCustomerRead(job)) {
        console.log(LOG_PREFIX, 'Cancelled (already read), conversation:', job.conversationId);
        continue;
      }

      // Re-check cooldown (another email may have been sent while this was pending)
      const lastSent = data.sent[job.conversationId];
      if (lastSent && (now - lastSent) < COOLDOWN_SECONDS * 1000) {
        console.log(LOG_PREFIX, 'Cooldown active at send time, skipping:', job.conversationId);
        continue;
      }

      const result = await sendNotificationEmail(job);
      if (result.success) {
        data.sent[job.conversationId] = now;
        console.log(LOG_PREFIX, 'Email sent for conversation:', job.conversationId);
      } else {
        console.error(LOG_PREFIX, 'Email failed for conversation:', job.conversationId, result.reason);
      }
    } catch (err) {
      console.error(LOG_PREFIX, 'Job processing error:', err.message);
    }
  }

  data.pending = remaining;
  saveJobs(data);
}

// --- Read State Check ---

async function hasCustomerRead(job) {
  // Cancel only when contact_last_seen_at >= message_created_at.
  // A historical contact_last_seen_at must NOT cancel a newer admin reply.
  try {
    const { getConversationMeta } = require('./chatwoot');
    const meta = await getConversationMeta(job.conversationId);

    if (meta.contactLastSeen) {
      const contactSeenSeconds = normalizeToUnixSeconds(meta.contactLastSeen);
      const messageSeconds = job.messageCreatedAt || 0;
      // Customer has read if they viewed the conversation at or after the message was sent
      if (messageSeconds > 0 && contactSeenSeconds >= messageSeconds) {
        return true;
      }
    }

    return false;
  } catch (err) {
    // On error, don't cancel — better to send than to silently drop
    console.error(LOG_PREFIX, 'Read check failed:', err.message);
    return false;
  }
}

// --- Email Content ---

function sendNotificationEmail(job) {
  const name = job.customerName || 'there';
  const subject = 'You have a new reply from Primingo Support';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Our support team has replied to your conversation.</p>
  <p style="margin: 30px 0;">
    <a href="https://primingo.com/" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">Open Primingo Support</a>
  </p>
  <p style="color: #666; font-size: 14px;">If you have any questions, just reply to this email.</p>
  <p style="color: #999; font-size: 12px; margin-top: 40px;">Primingo Support</p>
</body>
</html>`;

  const textContent = `Hi ${name},\n\nOur support team has replied to your conversation.\n\nOpen Primingo Support to view the reply:\nhttps://primingo.com/\n\nPrimingo Support`;

  return sendEmail({
    to: job.customerEmail,
    toName: job.customerName,
    subject,
    htmlContent,
    textContent,
    dedupKey: job.dedupKey || `msg_${job.messageId}`
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Timer ---

let processingInterval = null;

function startProcessing() {
  if (processingInterval) return;
  // Check every 30 seconds for jobs ready to send
  processingInterval = setInterval(() => {
    processJobs().catch(err => {
      console.error(LOG_PREFIX, 'Processing tick error:', err.message);
    });
  }, 30 * 1000);

  // Also run immediately on start to catch jobs that survived a restart
  processJobs().catch(err => {
    console.error(LOG_PREFIX, 'Initial processing error:', err.message);
  });

  console.log(LOG_PREFIX, 'Job processor started');
}

function stopProcessing() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
  }
}

module.exports = { scheduleNotification, processJobs, startProcessing, stopProcessing };
