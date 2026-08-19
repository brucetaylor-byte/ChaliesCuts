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
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
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
