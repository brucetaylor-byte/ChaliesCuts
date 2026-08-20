// Seeds two hairdresser accounts if they don't already exist.
// Run with: npm run seed
const bcrypt = require('bcryptjs');
const db = require('./db');

// Charlie is the admin - the only one who can add further stylist logins
// from the dashboard (see routes/hairdressers.js). Angus, and anyone Charlie
// adds later, are regular (non-admin) stylist accounts.
const HAIRDRESSERS = [
  { username: 'charlie', password: 'changeme1', display_name: 'Charlie', is_admin: 1 },
  { username: 'angus', password: 'changeme2', display_name: 'Angus', is_admin: 0 }
];

const insert = db.prepare(`
  INSERT INTO hairdressers (username, password_hash, display_name, bio, is_admin)
  VALUES (?, ?, ?, ?, ?)
`);

for (const hd of HAIRDRESSERS) {
  const existing = db.prepare('SELECT id FROM hairdressers WHERE username = ?').get(hd.username);
  if (existing) {
    console.log(`Skipping ${hd.username} - already exists`);
    continue;
  }
  const password_hash = bcrypt.hashSync(hd.password, 10);
  insert.run(hd.username, password_hash, hd.display_name, 'Freelance hairdresser. Bio coming soon!', hd.is_admin);
  console.log(`Created hairdresser "${hd.username}" (password: ${hd.password}) - please change the password after first login.`);
}

console.log('Done seeding.');
