'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PUBLIC_DIR = path.join(__dirname, 'docs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const MAX_BODY = 10 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadInternships(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw.internships) ? raw.internships : [];
  const seen = new Set();
  // Skip malformed records (no id/title or duplicate id); count is logged at startup.
  return list.filter(r => r && typeof r.id === 'string' && typeof r.title === 'string' && !seen.has(r.id) && seen.add(r.id));
}

function createApp({ seedFile, applicationsFile, log = console.log } = {}) {
  seedFile = seedFile || path.join(__dirname, 'docs', 'data', 'internships.json');
  applicationsFile = applicationsFile || process.env.APPLICATIONS_FILE || path.join(__dirname, 'data', 'applications.json');
  const internships = loadInternships(seedFile);
  let applications = [];
  try { applications = JSON.parse(fs.readFileSync(applicationsFile, 'utf8')); } catch { applications = []; }

  const persist = () => {
    fs.mkdirSync(path.dirname(applicationsFile), { recursive: true });
    const tmp = applicationsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(applications, null, 2));
    fs.renameSync(tmp, applicationsFile);
  };

  const send = (res, code, body) => {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store'
    });
    res.end(json);
  };
  const fail = (res, code, errCode, message, fields) =>
    send(res, code, { status: 'error', error: { code: errCode, message, ...(fields ? { fields } : {}) } });

  function listInternships(url, res) {
    const p = url.searchParams;
    const page = p.has('page') ? Number(p.get('page')) : 1;
    const limit = p.has('limit') ? Number(p.get('limit')) : 6;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return fail(res, 400, 'BAD_QUERY', 'page must be an integer >= 1 and limit an integer between 1 and 50.');
    const q = (p.get('q') || '').trim().toLowerCase();
    const domain = p.get('domain') || '';
    const mode = p.get('mode') || '';
    const filtered = internships.filter(r => {
      if (domain && r.domain !== domain) return false;
      if (mode && r.mode !== mode) return false;
      if (!q) return true;
      const hay = [r.id, r.title, r.domain, r.mode, r.location, ...(Array.isArray(r.skills) ? r.skills : [])]
        .filter(v => typeof v === 'string').join(' ').toLowerCase();
      return hay.includes(q);
    });
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    send(res, 200, {
      status: 'success',
      data: filtered.slice((page - 1) * limit, page * limit),
      pagination: { page, limit, total, totalPages }
    });
  }

  function filters(res) {
    const uniq = key => [...new Set(internships.map(r => r[key]).filter(Boolean))].sort();
    send(res, 200, { status: 'success', data: { domains: uniq('domain'), modes: uniq('mode') } });
  }

  function validateApplication(b) {
    const f = {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2 || name.length > 100) f.name = 'Enter your full name (2–100 characters).';
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (!EMAIL_RE.test(email) || email.length > 254) f.email = 'Enter a valid email address.';
    let portfolioUrl = '';
    if (b.portfolioUrl !== undefined && b.portfolioUrl !== null && String(b.portfolioUrl).trim() !== '') {
      try {
        const u = new URL(String(b.portfolioUrl).trim());
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.href.length > 2048) throw new Error();
        portfolioUrl = u.href;
      } catch { f.portfolioUrl = 'Enter a valid http(s) link, or leave this blank.'; }
    }
    return { fields: f, value: { name, email: email.toLowerCase(), portfolioUrl } };
  }

  function createApplication(req, res) {
    if (!/^application\/json/i.test(req.headers['content-type'] || ''))
      return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'INVALID_JSON', 'Request body must be a JSON object.');
      const internship = internships.find(r => r.id === body.internshipId);
      if (!internship) return fail(res, 404, 'NOT_FOUND', 'Internship not found.');
      const { fields, value } = validateApplication(body);
      if (Object.keys(fields).length) return fail(res, 422, 'VALIDATION_FAILED', 'Please fix the highlighted fields.', fields);
      if (applications.some(a => a.internshipId === internship.id && a.email === value.email))
        return fail(res, 409, 'DUPLICATE_APPLICATION', 'You have already applied to this internship with this email.');
      const record = { id: crypto.randomUUID(), internshipId: internship.id, ...value, createdAt: new Date().toISOString() };
      applications.push(record);
      persist();
      send(res, 201, { status: 'success', data: { id: record.id, internshipId: record.internshipId, createdAt: record.createdAt } });
    });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'BAD_PATH', 'Bad path.'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 403, 'FORBIDDEN', 'Forbidden.');
    fs.readFile(file, (err, buf) => {
      if (err) return fail(res, 404, 'NOT_FOUND', 'Not found.');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const server = http.createServer((req, res) => {
    const start = Date.now();
    // Log only method, path (no query string), status and timing. Never bodies or headers.
    res.on('finish', () => log(`${req.method} ${(req.url || '').split('?')[0]} ${res.statusCode} ${Date.now() - start}ms`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'BAD_URL', 'Bad URL.'); }
    const { pathname } = url;
    try {
      if (pathname === '/api/internships' && req.method === 'GET') return listInternships(url, res);
      if (pathname === '/api/filters' && req.method === 'GET') return filters(res);
      if (pathname === '/api/applications' && req.method === 'POST') return createApplication(req, res);
      if (pathname.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', 'Unknown API route.');
      return serveStatic(req, res, pathname);
    } catch {
      return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
    }
  });
  server.internshipCount = internships.length;
  return server;
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, () => console.log(`Internship board running at http://localhost:${port} (${server.internshipCount} internships loaded)`));
}
