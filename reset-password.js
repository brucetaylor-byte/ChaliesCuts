// One-off CLI helper to reset a stylist's password directly in the database.
//
// There's no self-service "forgot password" flow in the app yet (see
// PROJECT-SPEC.md) - if Charlie or Angus forgets their password, run this
// from the project folder (locally, or via your host's shell/console once
// deployed) to set a new one straight away:
//
//   node reset-password.js stylist1 aNewPassword123
//   node reset-password.js stylist2 aNewPassword123
//
// Remember "stylist1" = Charlie's login and "stylist2" = Angus's login -
// those internal usernames never change even though their display names do.
const bcrypt = require('bcryptjs');
const db = require('./db');

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) {
  console.error('Usage: node reset-password.js <username> <newPassword>');
  console.error('  e.g. node reset-password.js stylist1 aNewPassword123');
  process.exit(1);
}
if (newPassword.length < 6) {
  console.error('New password must be at least 6 characters.');
  process.exit(1);
}

const hd = db.prepare('SELECT id, display_name FROM hairdressers WHERE username = ?').get(username.trim().toLowerCase());
if (!hd) {
  console.error(`No stylist found with username "${username}". Valid usernames: stylist1, stylist2.`);
  process.exit(1);
}

const password_hash = bcrypt.hashSync(newPassword, 10);
db.prepare('UPDATE hairdressers SET password_hash = ? WHERE id = ?').run(password_hash, hd.id);
console.log(`Password reset for "${username}" (${hd.display_name}). They can log in with the new password now.`);
