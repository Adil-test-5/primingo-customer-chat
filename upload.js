const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSession } = require('./sessions');
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

// --- Route ---

router.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const customerEmail = req.body.customer_email;
    if (!customerEmail) {
      return res.status(400).json({ status: 'error', message: 'Session not verified.' });
    }

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

    // Check R2 config
    if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME) {
      return res.status(500).json({ status: 'error', message: 'File upload service not configured.' });
    }

    // Resolve customer context
    const session = getSession(customerEmail);
    let conversationId = session?.conversation_id;
    let contactId = session?.contact_id;

    if (!conversationId) {
      // Establish conversation like message flow does
      contactId = await findOrCreateContact(customerEmail, 'Customer');
      const conv = await findOrCreateConversation(contactId, customerEmail);
      conversationId = conv.conversationId;
    }

    // Build object key
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const customerId = contactId || crypto.createHash('sha256').update(customerEmail).digest('hex').slice(0, 12);
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

    // Send message to Chatwoot conversation
    await sendMessage(conversationId, `Customer uploaded attachment: ${fileUrl}`);

    res.json({ status: 'ok', url: fileUrl, filename: req.file.originalname });
  } catch (err) {
    // Handle multer file size error
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ status: 'error', message: 'File too large. Maximum size is 10MB.' });
    }
    console.error('[UPLOAD ERROR]', err.message);
    res.status(502).json({ status: 'error', message: 'Upload failed. Please try again.' });
  }
});

module.exports = router;
