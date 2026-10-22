'use strict';
// All data comes from the API (relative URLs so it works under a sub-path).
// Dataset strings are only ever inserted with textContent — never innerHTML.

const $ = id => document.getElementById(id);
const els = {
  form: $('filter-form'), search: $('search'), domain: $('domain'), mode: $('mode'),
  count: $('result-count'), state: $('state'), list: $('list'), pager: $('pager'),
  prev: $('prev'), next: $('next'), pageInfo: $('page-info'),
  dialog: $('detail'), dTitle: $('detail-title'), dInfo: $('detail-info'), dClose: $('detail-close'),
  apply: $('apply-form'), applyMsg: $('apply-msg'), applySubmit: $('apply-submit')
};
const state = { q: '', domain: '', mode: '', page: 1, limit: 6, totalPages: 1 };
let controller = null;     // cancels stale requests
let lastTrigger = null;    // element to refocus when dialog closes
let currentInternship = null;

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok || !body || body.status !== 'success') {
    const err = new Error((body && body.error && body.error.message) || `Request failed (${res.status})`);
    err.fields = body && body.error && body.error.fields;
    err.code = body && body.error && body.error.code;
    err.notApi = !body; // a response arrived but it was not our JSON API (e.g. static hosting)
    throw err;
  }
  return body;
}


/* ---------- static-hosting fallback (e.g. GitHub Pages) ----------
   If the page is served without the API, read the supplied seed JSON and filter in the browser
   with the same rules as the server. Real network failures still show the error state. */
let staticMode = false;
let staticData = null;
async function getStatic() {
  if (!staticData) {
    const res = await fetch('data/internships.json');
    if (!res.ok) throw new Error('Seed file not found');
    const raw = await res.json();
    const seen = new Set();
    staticData = (Array.isArray(raw.internships) ? raw.internships : [])
      .filter(r => r && typeof r.id === 'string' && typeof r.title === 'string' && !seen.has(r.id) && seen.add(r.id));
  }
  return staticData;
}
async function staticList() {
  const all = await getStatic();
  const q = state.q.trim().toLowerCase();
  const hit = all.filter(r => {
    if (state.domain && r.domain !== state.domain) return false;
    if (state.mode && r.mode !== state.mode) return false;
    if (!q) return true;
    return [r.id, r.title, r.domain, r.mode, r.location, ...(Array.isArray(r.skills) ? r.skills : [])]
      .filter(v => typeof v === 'string').join(' ').toLowerCase().includes(q);
  });
  const total = hit.length, totalPages = Math.max(1, Math.ceil(total / state.limit));
  return { data: hit.slice((state.page - 1) * state.limit, state.page * state.limit), pagination: { page: state.page, limit: state.limit, total, totalPages } };
}

/* ---------- rendering ---------- */
function showState(kind, title, message, retry) {
  els.state.replaceChildren();
  els.state.className = 'state' + (kind === 'error' ? ' error' : '');
  els.state.hidden = false;
  if (kind === 'loading') els.state.append(h('div', { class: 'spinner', 'aria-hidden': 'true' }));
  els.state.append(h('h3', { text: title }));
  if (message) els.state.append(h('p', { text: message }));
  if (retry) {
    const b = h('button', { type: 'button', class: 'btn btn-primary', text: 'Retry' });
    b.addEventListener('click', retry);
    els.state.append(b);
  }
}
const hideState = () => { els.state.hidden = true; els.state.replaceChildren(); };

function renderCard(item) {
  const meta = [item.mode, item.location, Number.isFinite(item.openings) ? `${item.openings} ${item.openings === 1 ? 'opening' : 'openings'}` : null]
    .filter(Boolean).map(t => h('li', { text: t }));
  const skills = (Array.isArray(item.skills) ? item.skills : []).filter(s => typeof s === 'string').map(s => h('li', { text: s }));
  const btn = h('button', { type: 'button', class: 'btn btn-primary' }, ['View details', h('span', { class: 'visually-hidden', text: ` for ${item.title}` })]);
  btn.addEventListener('click', () => openDetail(item, btn));
  const card = h('article', { class: 'card' }, [
    item.domain ? h('p', { class: 'card-domain', text: item.domain }) : '',
    h('h3', { text: item.title }),
    meta.length ? h('ul', { class: 'meta', 'aria-label': 'Details' }, meta) : '',
    skills.length ? h('ul', { class: 'tags', 'aria-label': 'Skills' }, skills) : '',
    btn
  ]);
  return h('li', {}, [card]);
}

function render(data, pagination) {
  els.list.replaceChildren(...data.map(renderCard));
  const { total, page, totalPages } = pagination;
  state.totalPages = totalPages;
  els.count.textContent = total === 0 ? '0 internships found' : `${total} ${total === 1 ? 'internship' : 'internships'} found`;
  if (total === 0) {
    const filtered = state.q || state.domain || state.mode;
    showState('empty', filtered ? 'No internships match your search' : 'No internships are available right now',
      filtered ? 'Try a different keyword or reset the filters.' : 'Please check back later.');
  } else hideState();
  els.pager.hidden = totalPages <= 1;
  els.pageInfo.textContent = `Page ${page} of ${totalPages}`;
  els.prev.disabled = page <= 1;
  els.next.disabled = page >= totalPages;
}

/* ---------- loading ---------- */
async function load() {
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  const params = new URLSearchParams({ page: state.page, limit: state.limit });
  if (state.q) params.set('q', state.q);
  if (state.domain) params.set('domain', state.domain);
  if (state.mode) params.set('mode', state.mode);
  els.list.setAttribute('aria-busy', 'true');
  els.list.replaceChildren();
  els.pager.hidden = true;
  els.count.textContent = 'Loading internships…';
  showState('loading', 'Loading internships…');
  try {
    let body;
    if (staticMode) body = await staticList();
    else {
      try { body = await api('api/internships?' + params, { signal }); }
      catch (err) { if (!err.notApi) throw err; staticMode = true; body = await staticList(); }
    }
    if (signal.aborted) return;
    render(body.data, body.pagination);
  } catch (err) {
    if (err.name === 'AbortError') return;
    els.count.textContent = '';
    showState('error', 'Could not load internships', 'Check your connection and try again.', load);
  } finally {
    if (!signal.aborted) els.list.setAttribute('aria-busy', 'false');
  }
}

async function loadFilters() {
  try {
    let data;
    try { ({ data } = await api('api/filters')); }
    catch (err) {
      if (!err.notApi) throw err;
      staticMode = true;
      const all = await getStatic();
      const uniq = k => [...new Set(all.map(r => r[k]).filter(Boolean))].sort();
      data = { domains: uniq('domain'), modes: uniq('mode') };
    }
    for (const [select, values] of [[els.domain, data.domains], [els.mode, data.modes]])
      for (const v of values) select.append(h('option', { value: v, text: v }));
  } catch { /* filters stay on "All"; list error state covers connectivity issues */ }
}

/* ---------- filters ---------- */
let debounce;
els.search.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { state.q = els.search.value.trim(); state.page = 1; load(); }, 250);
});
els.form.addEventListener('submit', e => { e.preventDefault(); clearTimeout(debounce); state.q = els.search.value.trim(); state.page = 1; load(); });
for (const sel of [els.domain, els.mode]) sel.addEventListener('change', () => { state.domain = els.domain.value; state.mode = els.mode.value; state.page = 1; load(); });
els.form.addEventListener('reset', () => {
  clearTimeout(debounce);
  // reset fires before controls clear, so defer reading values
  setTimeout(() => { state.q = ''; state.domain = ''; state.mode = ''; state.page = 1; load(); els.search.focus(); });
});
els.prev.addEventListener('click', () => { if (state.page > 1) { state.page--; load().then(focusResults); } });
els.next.addEventListener('click', () => { if (state.page < state.totalPages) { state.page++; load().then(focusResults); } });
const focusResults = () => $('results').focus({ preventScroll: false });

/* ---------- detail dialog + application form ---------- */
const fieldIds = { name: ['a-name', 'a-name-err'], email: ['a-email', 'a-email-err'], portfolioUrl: ['a-url', 'a-url-err'] };

function clearErrors() {
  for (const [input, err] of Object.values(fieldIds)) {
    $(input).removeAttribute('aria-invalid');
    $(err).hidden = true; $(err).textContent = '';
  }
  els.applyMsg.hidden = true; els.applyMsg.textContent = '';
}
function setFieldError(key, message) {
  const [input, err] = fieldIds[key];
  $(input).setAttribute('aria-invalid', 'true');
  $(err).textContent = message; $(err).hidden = false;
}
function setMessage(kind, text) {
  els.applyMsg.className = 'form-msg ' + kind;
  els.applyMsg.textContent = text;
  els.applyMsg.hidden = false;
}

function openDetail(item, trigger) {
  currentInternship = item; lastTrigger = trigger;
  els.dTitle.textContent = item.title;
  const rows = [['Domain', item.domain], ['Work mode', item.mode], ['Location', item.location],
    ['Openings', Number.isFinite(item.openings) ? String(item.openings) : null],
    ['Skills', Array.isArray(item.skills) ? item.skills.join(', ') : null], ['Reference ID', item.id]].filter(r => r[1]);
  els.dInfo.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  els.apply.reset(); clearErrors();
  els.applySubmit.disabled = false;
  if (staticMode) {
    els.applySubmit.disabled = true;
    setMessage('err', 'Applications are only accepted by the full server version. This static demo is browse-only.');
  }
  els.dialog.showModal();
}
function closeDetail() { els.dialog.close(); }
els.dClose.addEventListener('click', closeDetail);
els.dialog.addEventListener('click', e => { if (e.target === els.dialog) closeDetail(); }); // backdrop click
els.dialog.addEventListener('close', () => { if (lastTrigger) lastTrigger.focus(); });

els.apply.addEventListener('submit', async e => {
  e.preventDefault();
  clearErrors();
  const data = Object.fromEntries(new FormData(els.apply));
  const errors = {};
  if (data.name.trim().length < 2) errors.name = 'Enter your full name (at least 2 characters).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) errors.email = 'Enter a valid email address.';
  if (data.portfolioUrl.trim()) {
    try { if (!/^https?:$/.test(new URL(data.portfolioUrl.trim()).protocol)) throw 0; } catch { errors.portfolioUrl = 'Enter a valid http(s) link, or leave this blank.'; }
  }
  const keys = Object.keys(errors);
  if (keys.length) {
    keys.forEach(k => setFieldError(k, errors[k]));
    $(fieldIds[keys[0]][0]).focus();
    return;
  }
  els.applySubmit.disabled = true;
  try {
    await api('api/applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ internshipId: currentInternship.id, ...data })
    });
    setMessage('ok', `Application submitted for ${currentInternship.title}. Good luck!`);
    els.apply.reset();
    els.applySubmit.disabled = false;
    els.applyMsg.focus();
  } catch (err) {
    els.applySubmit.disabled = false;
    const keys2 = Object.keys(err.fields || {}).filter(k => fieldIds[k]);
    if (keys2.length) { keys2.forEach(k => setFieldError(k, err.fields[k])); $(fieldIds[keys2[0]][0]).focus(); }
    else { setMessage('err', err.code === 'DUPLICATE_APPLICATION' ? err.message : 'Could not submit your application. ' + err.message); els.applyMsg.focus(); }
  }
});

loadFilters();
load();
