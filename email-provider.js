const LOG_PREFIX = '[EMAIL]';

async function sendEmail({ to, toName, subject, htmlContent, textContent, dedupKey }) {
  const enabled = process.env.EMAIL_NOTIFICATIONS_ENABLED === 'true';
  if (!enabled) {
    console.log(LOG_PREFIX, 'Notifications disabled, skipping send');
    return { success: false, reason: 'disabled' };
  }

  // Only brevo is supported
  const provider = (process.env.EMAIL_PROVIDER || 'brevo').toLowerCase();
  if (provider !== 'brevo') {
    console.error(LOG_PREFIX, `Unsupported email provider: ${provider}`);
    return { success: false, reason: 'unsupported_provider' };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error(LOG_PREFIX, 'BREVO_API_KEY not configured');
    return { success: false, reason: 'not_configured' };
  }

  const fromName = process.env.EMAIL_FROM_NAME || 'Primingo Support';
  const fromEmail = process.env.EMAIL_FROM_ADDRESS || 'support@notify.primingo.com';
  const replyTo = process.env.EMAIL_REPLY_TO || 'contact@primingo.com';

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to, name: toName || to }],
    replyTo: { email: replyTo },
    subject,
    htmlContent,
    textContent
  };

  // Stable idempotency key — remains identical across retries for the same message
  if (dedupKey) {
    payload.headers = { 'Idempotency-Key': dedupKey };
  }

  try {
    const reqHeaders = {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    };

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(LOG_PREFIX, `Brevo API error: ${res.status}`, errBody);
      return { success: false, reason: 'api_error', status: res.status };
    }

    const data = await res.json();
    console.log(LOG_PREFIX, 'Email sent successfully, messageId:', data.messageId);
    return { success: true, messageId: data.messageId };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.error(LOG_PREFIX, 'Brevo API request timed out');
      return { success: false, reason: 'timeout' };
    }
    console.error(LOG_PREFIX, 'Send failed:', err.message);
    return { success: false, reason: 'network_error' };
  }
}

module.exports = { sendEmail };
