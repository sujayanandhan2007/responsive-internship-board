'use strict';
// Validates the seed file and (re)creates an empty applications store.
const fs = require('node:fs');
const path = require('node:path');
const seedPath = path.join(__dirname, '..', 'docs', 'data', 'internships.json');
const appsPath = process.env.APPLICATIONS_FILE || path.join(__dirname, '..', 'data', 'applications.json');

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
if (!Array.isArray(seed.internships)) throw new Error('Seed must contain an "internships" array');
const ids = new Set();
for (const r of seed.internships) {
  if (!r.id || !r.title) throw new Error('Record missing id/title: ' + JSON.stringify(r));
  if (ids.has(r.id)) throw new Error('Duplicate id ' + r.id);
  ids.add(r.id);
}
fs.writeFileSync(appsPath, '[]\n');
console.log(`Seed OK: ${ids.size} internships. Applications store reset at ${appsPath}`);
