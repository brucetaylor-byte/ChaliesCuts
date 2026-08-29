// Sends booking emails via Resend (https://resend.com) - a transactional
// email API reached over plain HTTPS, rather than raw SMTP.
//
// We moved off Gmail SMTP after three separate rounds of fixes (port 465
// timing out, then an IPv6 routing dead-end, then port 587 timing out again)
// never got delivery reliable on Railway. That pattern - a different failure
// mode each time rather than clean success - is a known characteristic of
// raw outbound SMTP from cloud hosts: many providers throttle or route it
// unpredictably to fight spam abuse, in a way a plain HTTPS API call isn't
// subject to. If RESEND_API_KEY isn't set, sending is silently disabled
// (booking flows still work exactly as before; emails are just skipped) so
// this never blocks the app.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Charlie's Cuts <onboarding@resend.dev>";

if (!RESEND_API_KEY) {
  console.warn(
    'Email sending is disabled: set RESEND_API_KEY (see .env.example) ' +
    'to have the app email booking confirmations.'
  );
}

// Never throws - a failed or disabled send is logged and swallowed so it
// can never break a booking/approve/decline/cancel request.
async function sendMail({ to, subject, text }) {
  if (!RESEND_API_KEY || !to) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend API responded ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    console.log(`Email accepted by Resend for ${to} (id: ${data.id})`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err.message);
  }
}

module.exports = { sendMail, isEnabled: () => !!RESEND_API_KEY };
