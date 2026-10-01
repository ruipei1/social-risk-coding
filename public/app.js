import { observationsText } from './memos.js';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const state = { user: null, csrf: '', dimensions: [], prompts: [], codes: [], queue: [], total: 0, offset: 0, detail: null, dirty: false, revision: 0, saving: null, saveTimer: null, blocked: false, view: 'reading' };
const labels = { unread:'Unread', draft:'In progress', complete:'Complete', flagged:'For discussion', explicit:'Explicit', inferred:'Inferred', not_stated:'Not stated', unclear:'Unclear', mixed:'Mixed', unreviewed:'Not reviewed' };
let queueRequest = 0;
let responseRequest = 0;
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type':'application/json', 'X-CSRF-Token':state.csrf } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const e = new Error(data.error || 'Request failed.'); e.status = response.status; throw e; }
  return data;
}
async function attempt(fn) { try { await fn(); } catch (e) { notice(e.message); } }
function prompt(id) { return state.prompts.find(p => p.id === id); }
function setSave(text, error = false) { $('#save-state').textContent = text; $('#save-state').classList.toggle('error', error); }
function statusPill(status) { $('#annotation-status').textContent = labels[status]; $('#annotation-status').className = 'pill ' + status; }
async function bootstrap() {
  const data = await api('/api/session'); Object.assign(state, { user:data.user, csrf:data.csrf, dimensions:data.dimensions, prompts:data.prompts });
  $('#login').hidden = !!data.user; $('#app').hidden = !data.user;
  $('#preview-login').hidden = !data.preview; $('#login-form').hidden = data.preview;
  if (!data.user) return;
  $('#user-name').textContent = data.user.name; $('#team-nav').hidden = data.user.role !== 'admin';
  $('#mode-label').textContent = data.preview ? 'Local preview · saved on this computer' : 'Private research workspace';
  $('#codebook-dimension').innerHTML = '<option value="">Every dimension</option>' + state.dimensions.map(d => `<option value="${d.id}">${esc(d.label)}</option>`).join('');
  await loadCodes(); await loadStats(); await loadQueue();
}
async function loadStats() {
  const stats = await api('/api/stats');
  const complete = stats.mine.find(s => s.status === 'complete')?.n || 0;
  const percentage = stats.total ? Math.round(100 * complete / stats.total) : 0;
  $('#progress-text').textContent = `${complete.toLocaleString()} / ${stats.total.toLocaleString()} reviewed`;
  $('#progress-percent').textContent = percentage + '%'; $('#progress').value = percentage;
  $('#dataset-summary').textContent = `${stats.records.toLocaleString()} survey records · ${stats.nonblank.toLocaleString()} nonblank responses`;
}
function query() {
  const params = new URLSearchParams({ offset:state.offset });
  for (const name of ['domain','perspective','direction','status']) if ($('#filter-' + name).value) params.set(name, $('#filter-' + name).value);
  if ($('#search').value.trim()) params.set('q', $('#search').value.trim());
  if ($('#include-blanks').checked) params.set('blanks', '1');
  return params;
}
async function loadQueue(selectFirst = true) {
  const request = ++queueRequest;
  const data = await api('/api/responses?' + query()); if (request !== queueRequest) return;
  state.queue = data.responses; state.total = data.total;
  if (!data.responses.length && data.total > 0 && state.offset > 0) { state.offset = Math.max(0, state.offset - 40); return loadQueue(selectFirst); }
  renderQueue();
  if (selectFirst && !state.queue.some(r => r.id === state.detail?.response.id)) {
    if (state.queue.length) await openResponse(state.queue[0].id);
    else { state.detail = null; $('#source-panel').innerHTML = '<div class="empty"><h3>No matching responses</h3><p>Try a different search or filter.</p></div>'; $('#coding-fields').innerHTML = ''; setSave('Choose a response to begin'); }
  }
  $$('.save-actions button').forEach(b => b.disabled = !state.detail);
}
function renderQueue() {
  $('#queue-total').textContent = state.total.toLocaleString();
  $('#queue-list').innerHTML = state.queue.length ? state.queue.map(r => `<button class="queue-item ${r.id === state.detail?.response.id ? 'selected' : ''}" data-id="${esc(r.id)}" aria-current="${r.id === state.detail?.response.id ? 'true' : 'false'}"><span class="line"><span class="person">${esc(r.participant_label)} <span class="muted">· ${r.record_number}</span></span><span class="tiny-status ${r.status}">${labels[r.status]}</span></span><div class="prompt">${esc(prompt(r.prompt)?.label)}</div><div class="excerpt">${r.blank ? '<em>No response entered</em>' : esc(r.text)}</div></button>`).join('') : '<div class="empty">No responses match these filters.</div>';
  $('#page-info').textContent = state.total ? `${state.offset + 1}–${Math.min(state.offset + 40, state.total)} of ${state.total.toLocaleString()}` : '0 responses';
  $('#page-prev').disabled = state.offset === 0; $('#page-next').disabled = state.offset + 40 >= state.total;
}
async function openResponse(id) {
  if (state.detail?.response.id === id) return;
  const request = ++responseRequest;
  await flush();
  const data = await api('/api/response/' + encodeURIComponent(id));
  if (request !== responseRequest) return;
  state.detail = data; state.dirty = false; state.blocked = false; state.revision = 0;
  renderResponse(); renderQueue(); notice();
}
function renderResponse() {
  const { response:r, annotation:a, related } = state.detail, p = prompt(r.prompt), memos = a.payload.memos || {};
  $('#source-panel').innerHTML = `<div class="source-top"><h2>${esc(r.participant_label)} <span class="muted small">/ record ${r.record_number}</span></h2><div class="pager"><button class="quiet" id="previous-response" aria-label="Previous response">←</button><button class="quiet" id="next-response" aria-label="Next response">→</button></div></div><article class="response-card"><header><p class="eyebrow">ORIGINAL RESPONSE</p><div class="tags"><span class="tag">${p.domain === 'social' ? 'Social risk' : 'General risk'}</span><span class="tag">${p.perspective === 'self' ? 'Self' : 'Others'}</span><span class="tag direction">${p.direction === 'approach' ? 'Approach' : 'Avoid'}</span></div></header><blockquote id="response-text">${r.blank ? '<span class="muted">No response entered.</span>' : esc(r.text)}</blockquote><footer class="response-foot"><span>${r.text.trim() ? r.text.trim().split(/\s+/).length : 0} words · ${esc(r.pool.toUpperCase())} · ${esc(r.wave)}</span><span>${r.complete ? 'Complete survey' : 'Incomplete survey'}</span></footer></article><details class="prompt-note"><summary>Read the question & source</summary><p>${esc(p.text)}</p><p><em>Question wording summarized for readability.</em></p><p>Source: ${esc(r.source)}</p></details><div class="memo-head"><div><p class="eyebrow">NOTICINGS & QUESTIONS</p><h2>Observations</h2></div><button id="reading-help" class="quiet">Reading guide</button></div><div class="memos">${[
    ['observations','Observations','Words or actions that could mean something different in another setting; unstated details, contradictions, boundary cases, or other observations.']
  ].map(([key,title,hint]) => `<label for="observations">${title}</label><p id="observations-hint" class="memo-hint">${hint}</p><textarea id="observations" data-memo="${key}" rows="5" aria-describedby="observations-hint" placeholder="Optional observations…">${esc(observationsText(memos))}</textarea>`).join('')}</div><details class="context-responses"><summary>This survey record’s other responses (${related.length - 1})</summary>${related.filter(x => x.id !== r.id).map(x => `<div class="related-item"><button class="quiet" data-related="${esc(x.id)}">${esc(prompt(x.prompt)?.label)}</button><p>${x.blank ? '<em>No response entered</em>' : esc(x.text)}</p></div>`).join('')}</details>`;
  const memoGroup = document.createElement('details');
  memoGroup.className = 'memo-group';
  memoGroup.open = window.matchMedia('(min-width: 901px)').matches;
  memoGroup.innerHTML = '<summary class="memo-toggle">Observations <span class="muted">· optional</span></summary>';
  const memoHead = $('.memo-head'), memoFields = $('.memos');
  memoHead.before(memoGroup); memoGroup.append(memoHead, memoFields);
  const jump = document.createElement('button');
  jump.className = 'secondary mobile-code-jump'; jump.textContent = 'Code this response';
  jump.onclick = () => $('.coding-panel').scrollIntoView({ behavior:'smooth', block:'start' });
  $('.response-card').after(jump);
  const quality = a.version === 0 && r.blank ? 'blank' : (a.payload.response_quality || 'substantive');
  $('#coding-fields').innerHTML = `<label class="quality">Response type<select id="response-quality">${[['substantive','Substantive response'],['no_example','No example recalled / not applicable'],['ambiguous','Too ambiguous to interpret'],['off_topic','Off topic'],['blank','Blank response']].map(([v,l]) => `<option value="${v}" ${quality === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` + state.dimensions.map((d,i) => {
    const value = a.payload.dimensions?.[d.id] || {}, codes = value.codes || [];
    return `<details class="dimension" data-dimension="${d.id}" open><summary><span class="dim-number">${String(i+1).padStart(2,'0')}</span><span class="dim-title">${esc(d.label)}</span><span class="dim-indicator">${codes.length ? codes.length + ' selected' : ''}</span><span class="dim-chevron">›</span></summary><div class="dimension-body"><p>${esc(d.help)}</p><div class="chips" data-chips="${d.id}">${renderChips(codes)}</div>${d.id === 'behavior' ? '<label>Broad category<select id="behavior-family" aria-label="Behavior category"><option value="">Choose a category…</option></select></label>' : ''}<div class="code-row"><select data-pick-code="${d.id}" aria-label="Apply a ${esc(d.label.toLowerCase())} code">${codeOptions(d.id, codes)}</select><button class="quiet" data-propose="${d.id}">+ New code</button></div></div></details>`;
  }).join('');
  updateCategoryGuides();
  statusPill(a.status); setSave(a.updated ? 'Saved ' + new Date(a.updated).toLocaleString() : 'Your notes save automatically as you write');
  $('#source-panel').scrollTop = 0; $('#coding-fields').scrollTop = 0;
}
function renderChips(ids) { return ids.map(id => { const code = state.codes.find(c => c.id === id); return `<span class="chip" data-code-id="${id}">${esc(code?.name || 'Code ' + id)}<button data-remove-code="${id}" aria-label="Remove ${esc(code?.name)}">×</button></span>`; }).join(''); }
function codeOptions(dimension, selected = []) {
  const codes = state.codes.filter(c => c.dimension === dimension && c.status !== 'retired' && !selected.includes(c.id));
  const option = c => `<option value="${c.id}">${esc(c.name)}</option>`;
  if (dimension !== 'behavior') return '<option value="">Choose a code…</option>' + codes.map(option).join('');
  const family = $('#behavior-family')?.value;
  if (!family) return '<option value="">Choose a category first…</option>';
  const items = codes.filter(c => (c.family || 'Additional behaviors') === family);
  return `<option value="">${items.length ? 'Choose a specific behavior…' : 'All items in this category selected'}</option>` + items.map(option).join('');
}
function updateBehaviorFamilies() {
  const picker = $('#behavior-family');
  if (!picker) return;
  const selected = picker.value;
  const families = [...new Set(state.codes.filter(c => c.dimension === 'behavior' && c.status !== 'retired').map(c => c.family || 'Additional behaviors'))].sort();
  picker.innerHTML = '<option value="">Choose a category…</option>' + families.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  if (families.includes(selected)) picker.value = selected;
  updateBehaviorPicker();
}
function updateBehaviorPicker() {
  const picker = $('[data-pick-code="behavior"]');
  if (!picker) return;
  picker.disabled = !$('#behavior-family').value;
  picker.innerHTML = codeOptions('behavior', selectedCodes('behavior'));
  $('[data-propose="behavior"]').disabled = false;
}

function updateCategoryGuides() {
  updateBehaviorFamilies();
  for (const d of state.dimensions) {
    const body = $(`[data-dimension="${d.id}"] .dimension-body`);
    if (!body) continue;
    const codes = state.codes.filter(c => c.dimension === d.id && c.status !== 'retired');
    let guide = $('.category-guide', body);
    if (!guide) { guide = document.createElement('details'); guide.className = 'category-guide'; $('p', body).after(guide); }
    const entry = c => `<section><h3>${esc(c.name)}</h3>${c.definition ? `<p>${esc(c.definition)}</p>` : ''}</section>`;
    const families = [...new Set(codes.map(c => c.family || 'Additional behaviors'))].sort();
    const contents = d.id === 'behavior'
      ? families.map(f => `<details class="behavior-guide-group"><summary>${esc(f)}</summary>${codes.filter(c => (c.family || 'Additional behaviors') === f).map(entry).join('')}</details>`).join('')
      : codes.map(entry).join('');
    guide.innerHTML = `<summary>${d.id === 'behavior' ? 'Browse behavior categories' : 'Category guide'}</summary><div class="category-guide-content">${contents || '<p>No categories yet.</p>'}</div>`;
  }
}
function selectedCodes(dimension) { return $$(`[data-chips="${dimension}"] [data-code-id]`).map(el => Number(el.dataset.codeId)); }
function payload() {
  // Preserve legacy descriptions and excerpts when saving the simplified form.
  return { response_quality:$('#response-quality').value, dimensions:{ ...state.detail.annotation.payload.dimensions, ...Object.fromEntries(state.dimensions.map(d => [d.id, { note:state.detail.annotation.payload.dimensions?.[d.id]?.note || '', quote:state.detail.annotation.payload.dimensions?.[d.id]?.quote || '', evidence:state.detail.annotation.payload.dimensions?.[d.id]?.evidence || 'unreviewed', codes:selectedCodes(d.id) }])) }, memos:{ ...state.detail.annotation.payload.memos, observations:$('#observations').value } };
}
function edited() {
  if (!state.detail) return;
  state.dirty = true; state.revision++; if (state.detail.annotation.status !== 'flagged') state.detail.annotation.status = 'draft';
  statusPill(state.detail.annotation.status); setSave('Unsaved changes'); clearTimeout(state.saveTimer);
  if (!state.blocked) state.saveTimer = setTimeout(() => attempt(() => flush()), 900);
}
async function flush(status) {
  clearTimeout(state.saveTimer);
  if (!state.detail) return;
  if (state.blocked) throw new Error('Saving is paused after a conflict. Copy your notes before reloading this page.');
  if (status) { state.detail.annotation.status = status; state.dirty = true; state.revision++; }
  if (state.saving) { await state.saving; if (state.dirty) return flush(); return; }
  if (!state.dirty) return;
  state.saving = (async () => {
    while (state.dirty) {
      const rev = state.revision, current = state.detail, savedPayload = payload(); setSave('Saving…');
      try {
        const result = await api('/api/annotation/' + encodeURIComponent(current.response.id), { method:'PUT', body:JSON.stringify({ version:current.annotation.version, status:current.annotation.status, payload:savedPayload }) });
        current.annotation.version = result.version; current.annotation.updated = result.updated; current.annotation.payload = savedPayload;
        if (state.revision === rev) state.dirty = false;
        const item = state.queue.find(r => r.id === current.response.id); if (item) item.status = current.annotation.status;
        statusPill(current.annotation.status); renderQueue(); setSave('Saved · ' + new Date(result.updated).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }));
      } catch (e) { if (e.status === 409) state.blocked = true; setSave('Not saved · ' + e.message, true); throw e; }
    }
    loadStats().catch(e => notice(e.message));
  })();
  try { await state.saving; } finally { state.saving = null; }
}
async function nextResponse(delta = 1) {
  await flush(); const index = state.queue.findIndex(r => r.id === state.detail?.response.id);
  if (state.queue[index + delta]) return openResponse(state.queue[index + delta].id);
  if (delta > 0 && state.offset + 40 < state.total) { state.offset += 40; await loadQueue(); }
  else if (delta < 0 && state.offset > 0) { state.offset -= 40; await loadQueue(false); await openResponse(state.queue.at(-1).id); }
  else notice(delta > 0 ? 'You’ve reached the end of this reading queue. Change a filter to keep reading.' : 'This is the first response in this queue.');
}
async function loadCodes() {
  state.codes = await api('/api/codes'); $('#code-count').textContent = state.codes.filter(c => state.dimensions.some(d => d.id === c.dimension) && c.status !== 'retired').length;
  renderCodebook();
  updateCategoryGuides();
  for (const d of state.dimensions) { const picker = $(`[data-pick-code="${d.id}"]`); if (picker) { const ids = selectedCodes(d.id); $(`[data-chips="${d.id}"]`).innerHTML = renderChips(ids); picker.innerHTML = codeOptions(d.id, ids); } }
}
function renderCodebook() {
  const dimension = $('#codebook-dimension').value;
  $('#new-code').disabled = !dimension;
  $('#new-code').title = dimension ? 'Add a code to this dimension' : 'Select a dimension first';
  const codes = state.codes.filter(c => state.dimensions.some(d => d.id === c.dimension) && (!dimension || c.dimension === dimension) && c.status !== 'retired');
  $('#codebook-list').innerHTML = codes.length ? codes.map(c => `<article class="code-card"><div class="code-card-top"><p class="eyebrow">${esc(state.dimensions.find(d => d.id === c.dimension)?.label)}</p></div><h2>${esc(c.name)}</h2>${c.family ? `<p class="muted small">${esc(c.family)}</p>` : ''}<p>${esc(c.definition)}</p><dl>${[['include_rule','Include when'],['exclude_rule','Exclude when'],['example','Example / boundary case']].filter(([f]) => c[f]).map(([f,l]) => `<dt>${l}</dt><dd>${esc(c[f])}</dd>`).join('')}</dl><footer><span>${esc(c.author)} · version ${c.version}</span>${state.user.role === 'admin' || (c.author_id === state.user.id && c.status === 'draft') ? `<button class="quiet" data-edit-code="${c.id}">Rename</button>` : '<span>Shared code</span>'}</footer></article>`).join('') : `<div class="empty"><h3>${state.codes.length ? 'No codes match these filters.' : 'Let the responses shape the codebook.'}</h3><p>${state.codes.length ? 'Choose another dimension.' : 'Read a few responses, then add a code when a useful distinction appears.'}</p></div>`;
}
function openCode(dimension, id = null) {
  const form = $('#code-form'), code = state.codes.find(c => c.id === id);
  if (!code && !dimension) return notice('Choose a dimension in the codebook filter first, or use New code inside a reading dimension.');
  form.reset();
  form.elements.dimension.value = code?.dimension || dimension;
  form.elements.family.value = code?.family || (dimension === 'behavior' && state.view === 'reading' ? $('#behavior-family')?.value || '' : '');
  const newBehavior = !code && dimension === 'behavior';
  $('#code-category-fields').hidden = !newBehavior;
  $('#new-code-category').disabled = !newBehavior;
  $('#new-code-category').required = newBehavior;
  $('#new-category-label').hidden = true;
  $('#new-category-name').disabled = true;
  $('#new-category-name').required = false;
  $('#code-name-label').textContent = form.elements.dimension.value === 'behavior' ? 'Behavior name' : 'Code name';
  $('#code-family-label').textContent = code?.family ? 'Category: ' + code.family : '';
  if (newBehavior) {
    const families = [...new Set(state.codes.filter(c => c.dimension === 'behavior' && c.status !== 'retired').map(c => c.family || 'Additional behaviors'))].sort();
    $('#new-code-category').innerHTML = '<option value="">Choose a category…</option>' + families.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('') + '<option value="__new__">+ Add a new category</option>';
    $('#new-code-category').value = form.elements.family.value;
  }
  $('#code-dimension-label').textContent = state.dimensions.find(d => d.id === form.elements.dimension.value)?.label;
  for (const field of ['id','version','name']) form.elements[field].value = code?.[field] ?? '';
  $('.form-error', form).textContent = ''; $('#code-dialog-title').textContent = code ? 'Rename code' : 'New code';
  $('#code-dialog').showModal();
  if (newBehavior && !$('#new-code-category').value) $('#new-code-category').focus(); else form.elements.name.focus();
}
async function changeView(view) {
  await flush(); state.view = view;
  for (const v of ['reading','codebook','team']) $('#' + v + '-view').hidden = v !== view;
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'codebook') await loadCodes(); if (view === 'team') await loadTeam();
}
async function loadTeam() {
  const users = await api('/api/team');
  $('#team-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Researcher</th><th>Role</th><th>Started</th><th>Complete</th><th>For discussion</th></tr></thead><tbody>${users.map(u => `<tr><td><strong>${esc(u.name)}</strong><br><span class="muted">${esc(u.username)}${u.active ? '' : ' · disabled'}</span></td><td>${u.role === 'admin' ? 'Administrator' : 'Research assistant'}</td><td>${u.started}</td><td>${u.complete || 0}</td><td>${u.flagged || 0}</td></tr>`).join('')}</tbody></table></div>`;
}
document.addEventListener('input', e => { if (e.target.matches('[data-memo]')) edited(); });
document.addEventListener('change', e => {
  if (e.target.id === 'new-code-category') {
    const isNew = e.target.value === '__new__';
    $('#new-category-label').hidden = !isNew;
    $('#new-category-name').disabled = !isNew;
    $('#new-category-name').required = isNew;
    if (isNew) $('#new-category-name').focus();
    return;
  }
  if (e.target.id === 'behavior-family') { updateBehaviorPicker(); return; }
  if (e.target.matches('#response-quality')) { edited(); const dim = e.target.closest('.dimension'); if (dim) $('.dim-indicator', dim).textContent = labels[e.target.value]; }
  if (e.target.matches('[data-pick-code]') && e.target.value) {
    const dimension = e.target.dataset.pickCode, ids = [...selectedCodes(dimension), Number(e.target.value)];
    $(`[data-dimension="${dimension}"] .dim-indicator`).textContent = ids.length + ' selected';
    $(`[data-chips="${dimension}"]`).innerHTML = renderChips(ids); e.target.innerHTML = codeOptions(dimension, ids); edited();
  }
});
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.classList.contains('close-dialog')) b.closest('dialog').close();
  else if (b.dataset.id) attempt(() => openResponse(b.dataset.id));
  else if (b.dataset.related) attempt(() => openResponse(b.dataset.related));
  else if (b.dataset.view) attempt(() => changeView(b.dataset.view));
  else if (b.dataset.propose) openCode(b.dataset.propose);
  else if (b.dataset.editCode) openCode(null, Number(b.dataset.editCode));
  else if (b.dataset.removeCode) { const dimension = b.closest('[data-chips]').dataset.chips; b.closest('.chip').remove(); $(`[data-dimension="${dimension}"] .dim-indicator`).textContent = selectedCodes(dimension).length ? selectedCodes(dimension).length + ' selected' : ''; $(`[data-pick-code="${dimension}"]`).innerHTML = codeOptions(dimension, selectedCodes(dimension)); edited(); }
  else if (b.id === 'reading-help') $('#help-dialog').showModal();
  else if (b.id === 'next-response') attempt(() => nextResponse(1));
  else if (b.id === 'previous-response') attempt(() => nextResponse(-1));
});
$('#login-form').addEventListener('submit', async e => { e.preventDefault(); try { const f = new FormData(e.target); await api('/api/login', { method:'POST', body:JSON.stringify(Object.fromEntries(f)) }); e.target.reset(); await bootstrap(); } catch (error) { $('#login-error').textContent = error.message; } });
$('#preview-login').onclick = () => attempt(async () => { await api('/api/preview-login', { method:'POST', body:'{}' }); await bootstrap(); });
$('#logout').onclick = () => attempt(async () => { await flush(); await api('/api/logout', { method:'POST', body:'{}' }); location.reload(); });
$('#save-draft').onclick = () => attempt(() => flush('draft'));
$('#flag-response').onclick = () => attempt(() => flush('flagged'));
$('#complete-next').onclick = () => attempt(async () => { await flush('complete'); await nextResponse(); });
$('#refresh').onclick = () => attempt(async () => { await flush(); await loadCodes(); await loadStats(); await loadQueue(); });
for (const name of ['domain','perspective','direction','status']) $('#filter-' + name).onchange = () => attempt(async () => { await flush(); state.offset = 0; await loadQueue(); });
$('#include-blanks').onchange = () => attempt(async () => { await flush(); state.offset = 0; await loadQueue(); });
let searchTimer;
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => attempt(async () => { await flush(); state.offset = 0; await loadQueue(); }), 350); };
$('#page-prev').onclick = () => attempt(async () => { await flush(); state.offset = Math.max(0, state.offset - 40); await loadQueue(); });
$('#page-next').onclick = () => attempt(async () => { await flush(); state.offset += 40; await loadQueue(); });
$('#new-code').onclick = () => openCode($('#codebook-dimension').value);
$('#codebook-dimension').onchange = renderCodebook;
$('#code-form').onsubmit = async e => {
  e.preventDefault(); const form = e.target, submit = $('button[type=submit]', form); submit.disabled = true;
  try {
    const prior = state.codes.find(c => c.id === Number(form.elements.id.value));
    const values = { ...prior, ...Object.fromEntries(new FormData(form)) }; values.status = prior?.status || 'draft'; values.version = Number(values.version || 0);
    if (!prior && values.dimension === 'behavior') {
      values.family = ($('#new-code-category').value === '__new__' ? $('#new-category-name').value : $('#new-code-category').value).trim();
      if (!values.family) throw new Error('Choose a broad category or enter a new category name.');
      const existing = state.codes.find(c => c.dimension === 'behavior' && c.family?.toLowerCase() === values.family.toLowerCase());
      if (existing) values.family = existing.family;
    }
    const result = await api('/api/codes' + (values.id ? '/' + values.id : ''), { method:values.id ? 'PUT' : 'POST', body:JSON.stringify(values) });
    await loadCodes();
    if (!prior && values.dimension === 'behavior' && $('#behavior-family')) { $('#behavior-family').value = values.family; updateBehaviorPicker(); }
    $('#code-dialog').close();
  } catch (error) { $('.form-error', form).textContent = error.message; } finally { submit.disabled = false; }
};
$('#new-user').onclick = () => { $('#user-form').reset(); $('.form-error', $('#user-form')).textContent = ''; $('#user-dialog').showModal(); };
$('#user-form').onsubmit = async e => { e.preventDefault(); const button = $('button[type=submit]', e.target); button.disabled = true; try { await api('/api/users', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(e.target))) }); e.target.reset(); $('#user-dialog').close(); await loadTeam(); } catch (error) { $('.form-error', e.target).textContent = error.message; } finally { button.disabled = false; } };
window.addEventListener('beforeunload', e => { if (state.dirty || state.saving) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', e => { if (e.altKey && ['ArrowLeft','ArrowRight'].includes(e.key) && state.view === 'reading' && !$$('dialog[open]').length) { e.preventDefault(); attempt(() => nextResponse(e.key === 'ArrowRight' ? 1 : -1)); } });
bootstrap().catch(e => { $('#login').hidden = false; $('#login-error').textContent = e.message; });
