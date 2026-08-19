// Seeds two hairdresser accounts if they don't already exist.
// Run with: npm run seed
const bcrypt = require('bcryptjs');
const db = require('./db');

const HAIRDRESSERS = [
  { username: 'stylist1', password: 'changeme1', display_name: 'Alex (Stylist 1)' },
  { username: 'stylist2', password: 'changeme2', display_name: 'Sam (Stylist 2)' }
];

const insert = db.prepare(`
  INSERT INTO hairdressers (username, password_hash, display_name, bio)
  VALUES (?, ?, ?, ?)
`);

for (const hd of HAIRDRESSERS) {
  const existing = db.prepare('SELECT id FROM hairdressers WHERE username = ?').get(hd.username);
  if (existing) {
    console.log(`Skipping ${hd.username} - already exists`);
    continue;
  }
  const password_hash = bcrypt.hashSync(hd.password, 10);
  insert.run(hd.username, password_hash, hd.display_name, 'Freelance hairdresser. Bio coming soon!');
  console.log(`Created hairdresser "${hd.username}" (password: ${hd.password}) - please change the password after first login.`);
}

console.log('Done seeding.');
