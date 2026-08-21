// Sends booking emails using the stylist's own Gmail account (via an "app
// password", not the normal login password) - no domain purchase or
// third-party email service account required. If the two env vars below
// aren't set, sending is silently disabled (booking flows still work
// exactly as before; emails are just skipped) so this never blocks the app.
const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_NAME = process.env.EMAIL_FROM_NAME || "Charlie's Cuts";

let transporter = null;

if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  // Explicit host/port (STARTTLS on 587) rather than the `service: 'gmail'`
  // shortcut, which connects on port 465 - some hosts (Railway included)
  // have outbound network paths that time out on 465 but work fine on 587.
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    connectionTimeout: 15000,
    // Railway's containers can't route outbound IPv6, and smtp.gmail.com
    // resolves to both an IPv4 and IPv6 address - without this, Node can
    // pick the IPv6 one and fail with ENETUNREACH. Forcing IPv4 avoids that.
    family: 4
  });
} else {
  console.warn(
    'Email sending is disabled: set GMAIL_USER and GMAIL_APP_PASSWORD ' +
    '(see .env.example) to have the app email booking confirmations.'
  );
}

// Never throws - a failed or disabled send is logged and swallowed so it
// can never break a booking/approve/decline/cancel request.
async function sendMail({ to, subject, text }) {
  if (!transporter || !to) return;
  try {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${GMAIL_USER}>`,
      to,
      subject,
      text
    });
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
  }
}

module.exports = { sendMail, isEnabled: () => !!transporter };
