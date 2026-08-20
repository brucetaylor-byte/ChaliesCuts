// One-off CLI helper to reset a stylist's password directly in the database.
//
// There's no self-service "forgot password" flow in the app yet (see
// PROJECT-SPEC.md) - if Charlie or Angus forgets their password, run this
// from the project folder (locally, or via your host's shell/console once
// deployed) to set a new one straight away:
//
//   node reset-password.js charlie aNewPassword123
//   node reset-password.js angus aNewPassword123
const bcrypt = require('bcryptjs');
const db = require('./db');

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) {
  console.error('Usage: node reset-password.js <username> <newPassword>');
  console.error('  e.g. node reset-password.js charlie aNewPassword123');
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('New password must be at least 6 characters.');
  process.exit(1);
}

const hd = db.prepare('SELECT id, display_name FROM hairdressers WHERE username = ?').get(username.trim().toLowerCase());
if (!hd) {
  console.error(`No stylist found with username "${username}". Valid usernames: charlie, angus.`);
  process.exit(1);
}

const password_hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE hairdressers SET password_hash = ? WHERE id = ?').run(password_hash, hd.id);
console.log(`Password reset for "${username}" (${hd.display_name}). They can log in with the new password now.`);
