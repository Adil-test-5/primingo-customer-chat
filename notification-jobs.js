const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./email-provider');
const { getSession } = require('./sessions');
const { getEmailPreviewMessages } = require('./chatwoot');

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

// --- Message Security ---

const SENSITIVE_PATTERNS = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\bPIN\b/,
  /\botp\b/i,
  /\bverification[_\s-]?code\b/i,
  /\blogin[_\s-]?code\b/i,
  /\brecovery[_\s-]?code\b/i,
  /\bBearer\s+\S/i,
  /\beyJ[A-Za-z0-9_-]{10,}/,                   // JWT
  /\bsk[-_][A-Za-z0-9]{16,}/,                   // sk- style API keys
  /\bapi[_-]?key\s*[:=]/i,
  /\bsecret\s*[:=]/i,
  /\bauthorization\s*[:=]/i,
  /\bcookie\s*[:=]/i,
  /\bsession[_-]?id\s*[:=]/i,
  /\baccess[_-]?token\s*[:=]/i,
  /\btoken\s*[:=]/i,                            // generic token: or token=
  /\brefresh[_-]?token\s*[:=]/i,               // refresh_token:
  /\bauth[_-]?token\s*[:=]/i,                  // auth_token:
  /\b[A-Fa-f0-9]{32,}\b/,                       // Hex tokens (32+ chars)
  /\b[A-Za-z0-9+/=]{40,}\b/,                    // Long base64 tokens
  /\b\d{6}\b/,                                   // 6-digit OTP codes
  /^\s*\d{4,8}\s*$/,                             // Standalone 4-8 digit number
];

function containsSensitiveContent(text) {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function sanitizeMessageContent(content) {
  const text = String(content || '');
  if (!text.trim()) return '';

  // If any sensitive pattern matches, replace the entire message
  if (containsSensitiveContent(text)) {
    return '[Hidden for security]';
  }

  // Strip any URLs that look like attachment links
  let sanitized = text.replace(/https?:\/\/\S+/gi, '[Link removed]');

  // Truncate to 300 characters
  if (sanitized.length > 300) {
    sanitized = sanitized.slice(0, 297) + '...';
  }

  return sanitized;
}

// --- Conversation Preview ---

async function fetchConversationPreview(conversationId) {
  try {
    const messages = await getEmailPreviewMessages(conversationId);
    if (!messages || !messages.length) return [];
    return messages;
  } catch (err) {
    // Fail silently — fallback to email without preview
    console.error(LOG_PREFIX, 'Preview fetch failed for conversation:', conversationId);
    return [];
  }
}

// --- URL Validation ---

const ALLOWED_BUTTON_HOSTS = ['chat.primingo.com', 'primingo.com', 'www.primingo.com'];
const ALLOWED_LOGO_HOSTS = ['primingo.com', 'www.primingo.com', 'chat-files.primingo.com'];
const FALLBACK_BUTTON_URL = 'https://chat.primingo.com/support';

function validateUrl(raw, allowedHosts) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!allowedHosts.includes(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function getSupportButtonUrl() {
  const url = process.env.SUPPORT_EMAIL_BUTTON_URL;
  if (!url) return FALLBACK_BUTTON_URL;
  return validateUrl(url, ALLOWED_BUTTON_HOSTS) || FALLBACK_BUTTON_URL;
}

function getLogoUrl() {
  const url = process.env.EMAIL_LOGO_URL;
  if (!url) return null;
  return validateUrl(url, ALLOWED_LOGO_HOSTS);
}

// --- Email Content ---

function getAttachmentLabel(attachmentTypes) {
  if (!attachmentTypes || !attachmentTypes.length) return '';
  const labels = [];
  if (attachmentTypes.includes('image')) labels.push('Image attached');
  if (attachmentTypes.includes('file')) labels.push('File attached');
  return labels.join(' · ');
}

function buildPreviewHtml(messages, customerName) {
  if (!messages.length) return '';

  let html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0 24px 0;">
    <tr><td style="padding: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #374151;">Recent conversation</td></tr>`;

  const lastAdminIdx = messages.reduce((acc, m, i) => m.sender === 'admin' ? i : acc, -1);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isAdmin = m.sender === 'admin';
    const isLatestAdmin = i === lastAdminIdx;

    let displayContent = sanitizeMessageContent(m.content);
    const attachLabel = getAttachmentLabel(m.attachmentTypes);

    if (!displayContent && attachLabel) {
      displayContent = attachLabel;
    } else if (displayContent && attachLabel) {
      displayContent += ` [${attachLabel}]`;
    }

    if (!displayContent) continue;

    const escapedContent = escapeHtml(displayContent);
    const label = isAdmin ? 'Primingo Support' : escapeHtml(customerName || 'Customer');

    if (isAdmin) {
      const bgColor = isLatestAdmin ? '#dbeafe' : '#eff6ff';
      const borderColor = isLatestAdmin ? '#93c5fd' : '#dbeafe';
      html += `<tr><td align="right" style="padding: 4px 0;">
        <table cellpadding="0" cellspacing="0" border="0" style="margin-left: auto;"><tr><td style="padding: 0 0 2px 0; font-size: 11px; color: #6b7280; text-align: right;">${label}</td></tr>
        <tr><td style="background-color: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 8px; padding: 10px 14px; font-size: 14px; color: #1f2937; max-width: 400px; text-align: left;">${escapedContent}</td></tr></table>
      </td></tr>`;
    } else {
      html += `<tr><td align="left" style="padding: 4px 0;">
        <table cellpadding="0" cellspacing="0" border="0"><tr><td style="padding: 0 0 2px 0; font-size: 11px; color: #6b7280;">${label}</td></tr>
        <tr><td style="background-color: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; color: #1f2937; max-width: 400px;">${escapedContent}</td></tr></table>
      </td></tr>`;
    }
  }

  html += `</table>`;
  return html;
}

function buildLogoHtml() {
  const logoUrl = getLogoUrl();
  if (logoUrl) {
    const escaped = escapeHtml(logoUrl);
    return `<img src="${escaped}" alt="Primingo" style="height: 36px; max-width: 180px; display: block;" />`;
  }
  return `<span style="font-size: 22px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">Primingo</span>`;
}

const PRIVACY_NOTICE = 'For your privacy, sensitive details and attachments may not be shown in this email.';

async function sendNotificationEmail(job) {
  const name = String(job.customerName || 'there');
  const subject = 'You have a new reply from Primingo Support';
  const buttonUrl = getSupportButtonUrl();

  // Fetch conversation preview (fail gracefully)
  let previewHtml = '';
  let previewText = '';
  try {
    const messages = await fetchConversationPreview(job.conversationId);
    if (messages.length) {
      previewHtml = buildPreviewHtml(messages, job.customerName);
      previewText = '\n---\nRecent conversation:\n' + messages.map(m => {
        const label = m.sender === 'admin' ? 'Primingo Support' : (job.customerName || 'Customer');
        let content = sanitizeMessageContent(m.content);
        const attachLabel = getAttachmentLabel(m.attachmentTypes);
        if (!content && attachLabel) {
          content = attachLabel;
        } else if (content && attachLabel) {
          content += ` [${attachLabel}]`;
        }
        return `${label}: ${content || ''}`;
      }).join('\n') + '\n---\n';
    }
  } catch (err) {
    // Send without preview — don't break the notification
  }

  const logoHtml = buildLogoHtml();

  const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f9fafb; padding: 32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid #dbeafe;">
        <!-- Yellow accent line -->
        <tr><td style="height: 4px; background-color: #fbbf24; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <!-- Header -->
        <tr><td style="background-color: #1e3a8a; padding: 24px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align: middle;">${logoHtml}</td>
            <td align="right" style="font-size: 13px; color: #e0e7ff; vertical-align: middle;">Support</td>
          </tr></table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding: 32px;">
          <p style="margin: 0 0 16px 0; font-size: 16px; color: #1f2937;">Hi ${escapeHtml(name)},</p>
          <p style="margin: 0 0 24px 0; font-size: 15px; color: #4b5563; line-height: 1.5;">Our support team has replied to your conversation.</p>
          ${previewHtml}
          <table cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;"><tr><td style="background-color: #2563eb; border-radius: 8px;">
            <a href="${escapeHtml(buttonUrl)}" style="display: inline-block; padding: 14px 28px; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none;">Open Primingo Support</a>
          </td></tr></table>
          <p style="margin: 16px 0 0 0; font-size: 12px; color: #9ca3af; line-height: 1.4;">${escapeHtml(PRIVACY_NOTICE)}</p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding: 24px 32px; border-top: 1px solid #e5e7eb; background-color: #f9fafb;">
          <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280; font-weight: 500;">Primingo Support</p>
          <p style="margin: 0 0 4px 0; font-size: 12px; color: #9ca3af;">Secure digital subscriptions and customer assistance</p>
          <p style="margin: 0; font-size: 12px;"><a href="https://primingo.com" style="color: #2563eb; text-decoration: none;">primingo.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textContent = `Hi ${name},\n\nOur support team has replied to your conversation.\n${previewText}\nOpen Primingo Support to view the reply:\n${buttonUrl}\n\n${PRIVACY_NOTICE}\n\nPrimingo Support\nSecure digital subscriptions and customer assistance\nprimingo.com`;

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
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
