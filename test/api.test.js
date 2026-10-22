'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
const logs = [];
const server = createApp({ applicationsFile: path.join(tmp, 'apps.json'), log: l => logs.push(l) });
let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());

const get = async p => { const r = await fetch(base + p); return [r.status, await r.json()]; };
const post = async (body, ct = 'application/json') => {
  const r = await fetch(base + '/api/applications', { method: 'POST', headers: { 'Content-Type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return [r.status, await r.json()];
};
const good = { internshipId: 'INT-101', name: 'Asha Rao', email: 'asha@example.com', portfolioUrl: 'https://example.com' };

test('list returns envelope with all 5 seed records and IDs preserved', async () => {
  const [s, b] = await get('/api/internships?limit=50');
  assert.equal(s, 200); assert.equal(b.status, 'success');
  assert.deepEqual(b.data.map(r => r.id), ['INT-101', 'INT-102', 'INT-103', 'INT-104', 'INT-105']);
  assert.deepEqual(b.pagination, { page: 1, limit: 50, total: 5, totalPages: 1 });
});
test('pagination', async () => {
  const [, b] = await get('/api/internships?limit=2&page=3');
  assert.equal(b.data.length, 1); assert.equal(b.pagination.totalPages, 3);
});
test('search is case-insensitive, partial, trimmed', async () => {
  const [, b] = await get('/api/internships?q=' + encodeURIComponent('  FRONT '));
  assert.deepEqual(b.data.map(r => r.id), ['INT-101']);
});
test('search matches skills and location', async () => {
  assert.equal((await get('/api/internships?q=figma'))[1].data[0].id, 'INT-103');
  assert.equal((await get('/api/internships?q=pune'))[1].data[0].id, 'INT-102');
});
test('domain + mode + search combine', async () => {
  const [, b] = await get('/api/internships?domain=Full%20Stack%20Development&mode=Hybrid');
  assert.deepEqual(b.data.map(r => r.id), ['INT-102']);
  assert.equal((await get('/api/internships?domain=UI/UX&q=sql'))[1].pagination.total, 0);
});
test('every domain and mode from /api/filters returns results', async () => {
  const [, f] = await get('/api/filters');
  assert.equal(f.data.domains.length, 4); assert.equal(f.data.modes.length, 3);
  for (const d of f.data.domains) assert.ok((await get('/api/internships?domain=' + encodeURIComponent(d)))[1].pagination.total > 0);
  for (const m of f.data.modes) assert.ok((await get('/api/internships?mode=' + encodeURIComponent(m)))[1].pagination.total > 0);
});
test('no matches gives empty data, not an error', async () => {
  const [s, b] = await get('/api/internships?q=zzzz');
  assert.equal(s, 200); assert.deepEqual(b.data, []); assert.equal(b.pagination.total, 0);
});
test('bad pagination params rejected', async () => {
  for (const q of ['page=0', 'page=abc', 'limit=0', 'limit=51']) assert.equal((await get('/api/internships?' + q))[0], 400);
});
test('valid application accepted (201) and stored with normalised email', async () => {
  const [s, b] = await post({ ...good, email: ' Asha@Example.com ' });
  assert.equal(s, 201); assert.equal(b.status, 'success');
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, 'apps.json'), 'utf8'));
  assert.equal(stored[0].email, 'asha@example.com');
});
test('duplicate application rejected (409), also with different email case', async () => {
  const [s, b] = await post({ ...good, email: 'ASHA@example.com' });
  assert.equal(s, 409); assert.equal(b.error.code, 'DUPLICATE_APPLICATION');
});
test('same applicant may apply to a different internship', async () => {
  assert.equal((await post({ ...good, internshipId: 'INT-102' }))[0], 201);
});
test('missing / short name rejected', async () => {
  for (const name of [undefined, '', '   ', 'A', 42]) {
    const [s, b] = await post({ ...good, email: 'n@example.com', name });
    assert.equal(s, 422); assert.ok(b.error.fields.name);
  }
});
test('invalid emails rejected', async () => {
  for (const email of [undefined, '', 'plain', 'a@b', 'a b@c.com', '@x.com']) {
    const [s, b] = await post({ ...good, email });
    assert.equal(s, 422); assert.ok(b.error.fields.email);
  }
});
test('unsafe URLs rejected', async () => {
  for (const portfolioUrl of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.com', 'file:///etc/passwd', 'not a url', 'https://user:pw@example.com']) {
    const [s, b] = await post({ ...good, email: 'u@example.com', portfolioUrl });
    assert.equal(s, 422, portfolioUrl); assert.ok(b.error.fields.portfolioUrl);
  }
});
test('empty optional URL accepted', async () => {
  assert.equal((await post({ ...good, email: 'nourl@example.com', portfolioUrl: '' }))[0], 201);
});
test('unknown internship 404, bad JSON 400, wrong content type 415, oversize 413', async () => {
  assert.equal((await post({ ...good, internshipId: 'NOPE' }))[0], 404);
  assert.equal((await post('{bad'))[0], 400);
  assert.equal((await post('[]'))[0], 400);
  assert.equal((await post('x', 'text/plain'))[0], 415);
  assert.equal((await post({ ...good, name: 'x'.repeat(20000) }))[0], 413);
});
test('logs contain no applicant data or query strings', async () => {
  await get('/api/internships?q=secretsearch');
  const all = logs.join('\n');
  assert.ok(logs.length > 5);
  for (const bad of ['asha', 'Asha', 'example.com', 'secretsearch', 'password', 'token']) assert.ok(!all.includes(bad), bad);
});
test('static files served; path traversal blocked; unknown API 404', async () => {
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /<h1/);
  assert.equal((await fetch(base + '/css/styles.css')).status, 200);
  const t = await fetch(base + '/..%2fserver.js'); assert.notEqual(t.status, 200);
  assert.equal((await get('/api/nope'))[0], 404);
});
