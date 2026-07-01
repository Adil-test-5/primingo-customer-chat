const { getSession, saveSession } = require('./sessions');

const CHATWOOT_BASE_URL = () => process.env.CHATWOOT_BASE_URL;
const CHATWOOT_API_TOKEN = () => process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_ACCOUNT_ID = () => process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = () => process.env.CHATWOOT_INBOX_ID || '2';

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

  return messages
    .filter(m => {
      if (m.private) return false;
      if (m.message_type === 2 || m.message_type === 'activity') return false;
      if (m.content_type && m.content_type !== 'text' && m.content_type !== 'input_text') return false;
      if (!m.content || !m.content.trim()) return false;
      if (m.content.startsWith('--- Order Context ---')) return false;
      const lower = m.content.toLowerCase();
      if (/^conversation was /.test(lower)) return false;
      if (/^(assigned to|status changed|snoozed until|resolved by|reopened by)/.test(lower)) return false;
      if (m.content_attributes?.deleted) return false;
      return true;
    })
    .map(m => {
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
      return {
        id: m.id,
        content: m.content,
        sender,
        created_at: m.created_at
      };
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
