const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getOrderSession, updateOrderSession } = require('./order-sessions');
const { findOrCreateContact, findOrCreateConversation, sendMessage } = require('./chatwoot');

const router = express.Router();

// --- Config ---

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf']);
const BLOCKED_EXTENSIONS = new Set(['exe', 'js', 'php', 'html', 'zip', 'rar', 'sh', 'bat']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf'
};

// --- File signature validation ---

const MAGIC_BYTES = {
  jpg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png: [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  webp: null, // checked via RIFF + WEBP
  pdf: [Buffer.from('%PDF')]
};

function validateFileSignature(buffer, ext) {
  if (!buffer || buffer.length < 12) return false;

  // Reject SVG/HTML/JS regardless of extension
  const head = buffer.slice(0, 256).toString('utf8', 0, Math.min(buffer.length, 256)).toLowerCase();
  if (head.includes('<svg') || head.includes('<!doctype') || head.includes('<html') || head.includes('<script')) {
    return false;
  }

  if (ext === 'webp') {
    return buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
           buffer.slice(8, 12).toString('ascii') === 'WEBP';
  }

  const expected = MAGIC_BYTES[ext];
  if (!expected) return false;

  return expected.some(magic => buffer.slice(0, magic.length).equals(magic));
}

// --- S3/R2 Client ---

function getS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

// --- Multer (memory storage) ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// --- Authentication middleware (runs before Multer) ---
// Validates the order_chat_session HttpOnly cookie and attaches
// the trusted server-side session to req.orderSession.
// Rejects with 401 before any file processing if invalid.

function requireOrderUploadSession(req, res, next) {
  const orderSessionId = req.cookies?.order_chat_session;
  if (!orderSessionId) {
    return res.status(401).json({ status: 'error', message: 'Session not verified.' });
  }

  const orderSession = getOrderSession(orderSessionId);
  if (!orderSession || !orderSession.customer_email) {
    return res.status(401).json({ status: 'error', message: 'Session expired or invalid.' });
  }

  // Attach trusted session data — body fields are never used for identity
  req.orderSession = orderSession;
  req.orderSessionId = orderSessionId;
  next();
}

// --- Multer error handler ---
// Catches Multer errors (e.g. file too large) that bypass the route handler's try/catch.

function handleMulterError(err, req, res, next) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ status: 'error', message: 'File too large. Maximum size is 10MB.' });
    }
    if (err.code && err.code.startsWith('LIMIT_')) {
      return res.status(400).json({ status: 'error', message: 'File upload rejected.' });
    }
    // Unexpected multer/upload error — generic response, no stack trace
    console.error('[UPLOAD ERROR]', err.message);
    return res.status(500).json({ status: 'error', message: 'Upload failed. Please try again.' });
  }
  next();
}

// --- Route ---
// Handles order-chat uploads only.
// Support uploads use /api/support/upload in server.js.
// Auth: order_chat_session HttpOnly cookie (set by /api/order-chat/exchange and legacy /api/session/verify).

router.post('/api/upload', requireOrderUploadSession, upload.single('file'), handleMulterError, async (req, res) => {
  try {
    const orderSession = req.orderSession;
    const orderSessionId = req.orderSessionId;

    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file provided.' });
    }

    // Validate extension
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');

    if (BLOCKED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ status: 'error', message: 'File type not allowed.' });
    }

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ status: 'error', message: 'Only images (jpg, png, webp) and PDF files are allowed.' });
    }

    // Validate file signature — reject content/extension mismatches
    if (!validateFileSignature(req.file.buffer, ext)) {
      return res.status(400).json({ status: 'error', message: 'File content does not match the expected type.' });
    }

    // Check R2 config
    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) {
      return res.status(500).json({ status: 'error', message: 'File upload service not configured.' });
    }

    // Resolve conversation bound to this order session
    let conversationId = orderSession.conversation_id;
    let contactId = orderSession.contact_id;

    if (!conversationId) {
      // Use the same resolution path as the order message flow:
      // findOrCreateContact then findOrCreateConversation with order context
      const customerEmail = orderSession.customer_email;
      const customerName = orderSession.customer_name || 'Customer';

      contactId = await findOrCreateContact(customerEmail, customerName);
      const orderContext = {
        order_id: orderSession.order_id,
        item_id: orderSession.item_id,
        product: orderSession.product
      };
      const conv = await findOrCreateConversation(contactId, customerEmail, orderContext);
      conversationId = conv.conversationId;

      if (!conversationId) {
        return res.status(400).json({ status: 'error', message: 'Unable to resolve conversation.' });
      }

      // Persist conversation binding back into the order session atomically
      updateOrderSession(orderSessionId, {
        conversation_id: conversationId,
        contact_id: contactId
      });
    }

    // Build object key
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const customerId = contactId || crypto.createHash('sha256').update(orderSession.customer_email).digest('hex').slice(0, 12);
    const randomName = crypto.randomUUID();
    const objectKey = `chat-uploads/${year}/${month}/customer-${customerId}/${randomName}.${ext}`;

    // Upload to R2
    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: objectKey,
      Body: req.file.buffer,
      ContentType: MIME_MAP[ext] || 'application/octet-stream'
    }));

    // Build public URL
    const baseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
    const fileUrl = `${baseUrl}/${objectKey}`;

    // Send message to the order conversation
    await sendMessage(conversationId, `Customer uploaded attachment: ${fileUrl}`);

    res.json({ status: 'ok', url: fileUrl, filename: req.file.originalname });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(502).json({ status: 'error', message: 'Upload failed. Please try again.' });
  }
});

module.exports = router;
