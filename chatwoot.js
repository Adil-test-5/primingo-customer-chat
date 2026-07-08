const { getSession, saveSession } = require('./sessions');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CHATWOOT_BASE_URL = () => process.env.CHATWOOT_BASE_URL;
const CHATWOOT_API_TOKEN = () => process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_ACCOUNT_ID = () => process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = () => process.env.CHATWOOT_INBOX_ID || '2';

// --- Attachment cache (Chatwoot URL → R2 URL) ---
const CACHE_FILE = path.join(__dirname, 'data', 'attachment-cache.json');

function loadAttachmentCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) { /* ignore corrupt cache */ }
  return {};
}

function saveAttachmentCache(cache) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function processAttachments(attachments) {
  if (!attachments || attachments.length === 0) return [];

  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) {
    console.warn('[ATTACH] R2 env vars missing — cannot process admin attachments');
    return [];
  }

  const cache = loadAttachmentCache();
  const results = [];

  for (const att of attachments) {
    // Chatwoot uses data_url (full URL) or file_url (relative path)
    let sourceUrl = att.data_url;
    if (!sourceUrl && att.file_url) {
      // file_url may be relative — prepend Chatwoot base if needed
      sourceUrl = att.file_url.startsWith('http')
        ? att.file_url
        : `${CHATWOOT_BASE_URL()}${att.file_url}`;
    }

    if (!sourceUrl) {
      console.warn('[ATTACH] No source URL found in attachment:', JSON.stringify(att));
      continue;
    }

    console.log('[ATTACH] Processing:', { sourceUrl, file_type: att.file_type, file_name: att.file_name });

    // Return cached R2 URL if already processed
    if (cache[sourceUrl]) {
      console.log('[ATTACH] Cache hit:', cache[sourceUrl]);
      results.push({ url: cache[sourceUrl], type: att.file_type || 'file' });
      continue;
    }

    try {
      // Download from Chatwoot (authenticated)
      const dlRes = await fetch(sourceUrl, {
        headers: { 'api_access_token': CHATWOOT_API_TOKEN() }
      });

      if (!dlRes.ok) {
        console.error('[ATTACH] Download failed:', dlRes.status, dlRes.statusText, sourceUrl);
        continue;
      }

      const buffer = Buffer.from(await dlRes.arrayBuffer());
      console.log('[ATTACH] Downloaded:', buffer.length, 'bytes');

      // Determine extension from original filename or content type
      const ext = getExtFromAttachment(att, dlRes.headers.get('content-type'));
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const objectKey = `chat-uploads/${year}/${month}/admin/${crypto.randomUUID()}.${ext}`;

      // Upload to R2
      const s3 = getR2Client();
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: buffer,
        ContentType: dlRes.headers.get('content-type') || 'application/octet-stream'
      }));

      const baseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
      const r2Url = `${baseUrl}/${objectKey}`;

      console.log('[ATTACH] Uploaded to R2:', r2Url);

      // Cache and return
      cache[sourceUrl] = r2Url;
      results.push({ url: r2Url, type: att.file_type || 'file' });
    } catch (err) {
      console.error('[ATTACH] Error processing attachment:', err.message, sourceUrl);
    }
  }

  // Persist cache
  if (Object.keys(cache).length > 0) {
    saveAttachmentCache(cache);
  }

  return results;
}

function getExtFromAttachment(att, contentType) {
  // Try from filename
  if (att.file_name) {
    const ext = path.extname(att.file_name).toLowerCase().replace('.', '');
    if (ext) return ext;
  }
  // Fallback from content-type
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'image/gif': 'gif'
  };
  return mimeToExt[contentType] || 'bin';
}

function apiUrl(path) {
  return `${CHATWOOT_BASE_URL()}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID()}${path}`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'api_access_token': CHATWOOT_API_TOKEN()
  };
}

async function findOrCreateContact(email, name) {
  const searchRes = await fetch(apiUrl(`/contacts/search?q=${encodeURIComponent(email)}`), {
    headers: headers()
  });

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    const existing = searchData.payload?.find(c => c.email === email);
    if (existing) return existing.id;
  }

  const createRes = await fetch(apiUrl('/contacts'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      inbox_id: parseInt(CHATWOOT_INBOX_ID()),
      name,
      email
    })
  });

  if (!createRes.ok) {
    throw new Error('Failed to create Chatwoot contact');
  }

  const created = await createRes.json();
  return created.payload?.contact?.id || created.id;
}

async function findOrCreateConversation(contactId, email, orderContext) {
  const session = getSession(email);

  if (session?.conversation_id) {
    return { conversationId: session.conversation_id, isNew: false };
  }

  // Search for existing open conversations for this contact
  const searchRes = await fetch(apiUrl(`/contacts/${contactId}/conversations`), {
    headers: headers()
  });

  if (searchRes.ok) {
    const searchData = await searchRes.json();
    const conversations = searchData.payload || [];
    const open = conversations.find(c => c.status === 'open' || c.status === 'pending');
    if (open) {
      saveSession(email, {
        contact_id: contactId,
        conversation_id: open.id,
        order_context_sent: true
      });
      return { conversationId: open.id, isNew: false };
    }
  }

  const createRes = await fetch(apiUrl('/conversations'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      inbox_id: parseInt(CHATWOOT_INBOX_ID()),
      contact_id: contactId,
      status: 'open'
    })
  });

  if (!createRes.ok) {
    throw new Error('Failed to create Chatwoot conversation');
  }

  const conv = await createRes.json();
  const conversationId = conv.id;

  saveSession(email, {
    contact_id: contactId,
    conversation_id: conversationId,
    order_context_sent: false
  });

  return { conversationId, isNew: true };
}

async function sendOrderContext(conversationId, orderData) {
  const contextMessage = [
    `--- Order Context ---`,
    `Product: ${orderData.product}`,
    `Plan: ${orderData.plan}`,
    `Order #${orderData.order_id} — Item #${orderData.item_id}`,
    `Status: ${orderData.order_status}`,
    `Purchased: ${orderData.purchase_date}`,
    `Expires: ${orderData.expiry_date}`,
    `Days left: ${orderData.days_left}`,
    `---`
  ].join('\n');

  await fetch(apiUrl(`/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      content: contextMessage,
      message_type: 'incoming',
      private: false
    })
  });
}

async function sendMessage(conversationId, content) {
  const res = await fetch(apiUrl(`/conversations/${conversationId}/messages`), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      content,
      message_type: 'incoming'
    })
  });

  if (!res.ok) {
    throw new Error('Failed to send message to Chatwoot');
  }

  return res.json();
}

async function getMessages(conversationId) {
  const res = await fetch(apiUrl(`/conversations/${conversationId}/messages`), {
    headers: headers()
  });

  if (!res.ok) {
    throw new Error('Failed to fetch messages from Chatwoot');
  }

  const data = await res.json();
  const messages = data.payload || [];

  const filtered = messages.filter(m => {
    if (m.private) return false;
    if (m.message_type === 2 || m.message_type === 'activity') return false;
    if (m.content_attributes?.deleted) return false;

    const hasAttachments = m.attachments && m.attachments.length > 0;

    if (m.content_type && m.content_type !== 'text' && m.content_type !== 'input_text') {
      if (!hasAttachments) return false;
    }

    const hasContent = m.content && m.content.trim();
    if (!hasContent && !hasAttachments) return false;

    if (hasContent) {
      if (m.content.startsWith('--- Order Context ---')) return false;
      const lower = m.content.toLowerCase();
      if (/^conversation was /.test(lower)) return false;
      if (/^(assigned to|status changed|snoozed until|resolved by|reopened by)/.test(lower)) return false;
    }

    return true;
  });

  const mapped = await Promise.all(filtered.map(async m => {
    let sender;
    if (m.message_type === 0 || m.message_type === 'incoming') {
      sender = 'customer';
    } else if (m.message_type === 1 || m.message_type === 'outgoing') {
      sender = 'admin';
    } else if (m.sender_type === 'Contact' || m.sender?.type === 'contact') {
      sender = 'customer';
    } else {
      sender = 'admin';
    }

    const result = {
      id: m.id,
      content: m.content || '',
      sender,
      created_at: m.created_at
    };

    // Process attachments — download from Chatwoot, upload to R2
    if (m.attachments && m.attachments.length > 0) {
      console.log('[MSG]', { id: m.id, sender, content_type: m.content_type, attachments_count: m.attachments.length });
      const processed = await processAttachments(m.attachments);
      if (processed.length > 0) {
        result.attachments = processed;
      }
      console.log('[MSG] Final message object:', JSON.stringify(result));
    }

    return result;
  }));

  return mapped.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id - b.id;
  });
}

async function markConversationRead(conversationId) {
  await fetch(apiUrl(`/conversations/${conversationId}/update_last_seen`), {
    method: 'POST',
    headers: headers()
  });
}

async function getConversationMeta(conversationId) {
  const res = await fetch(apiUrl(`/conversations/${conversationId}`), {
    headers: headers()
  });

  if (!res.ok) {
    return { agentRead: false, agentLastSeen: null };
  }

  const data = await res.json();
  const agentLastSeen = data.agent_last_seen_at || null;
  const agentRead = !!agentLastSeen;
  return { agentRead, agentLastSeen };
}

module.exports = { findOrCreateContact, findOrCreateConversation, sendOrderContext, sendMessage, getMessages, getSession, saveSession, markConversationRead, getConversationMeta };
