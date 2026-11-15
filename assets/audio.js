// Audio Converter (/audio). Everything runs in the visitor's browser:
//   decode (Web Audio, 44.1 kHz) -> speed / pitch (SoundTouch) -> amplify + limiter -> MP3 (LAME)
// Roblox calls go through the Worker (/api/roblox/*) because Roblox doesn't allow them from browsers.
// The visitor's API key stays in this browser and is sent only with those calls; the Worker doesn't store it.
import { SoundTouch, SimpleFilter } from 'https://cdn.jsdelivr.net/npm/soundtouchjs@0.3.0/dist/soundtouch.js';
import { startI18n, setLang } from './audio-i18n.js';

const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const RATE = 44100;
const MAX_SECONDS = 400;             // longest converted audio (6:40), under Roblox's 7:00 limit
const MAX_BYTES = 20 * 1024 * 1024;  // Roblox audio file size limit
const KBPS = 192;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pause = () => new Promise((r) => setTimeout(r, 0));

// ---------- storage (every access can throw in private mode) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let sessionKey = store.get('ac.key', '');
let cfg = store.get('ac.cfg', { creatorType: 'user', creatorId: '' });
let jobs = store.get('ac.jobs', []);
const outputs = new Map(); // job id -> { blob, url } (memory only)
// a conversion can't survive a reload, since the file was only in memory
jobs.forEach((j) => { if (['convert', 'upload'].includes(j.stage)) Object.assign(j, { stage: 'error', failedStage: j.stage, error: 'Interrupted by a page reload.' }); });
const saveJobs = () => store.set('ac.jobs', jobs.slice(0, 100));
const connected = () => Boolean(sessionKey && cfg.creatorId);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- Roblox through the Worker ----------
async function roblox(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.key !== false) {
    if (!sessionKey) throw new Error('Connect your Roblox account first.');
    headers['X-Roblox-Key'] = sessionKey;
  }
  let r;
  try { r = await fetch('/api/roblox/' + path, { method: opts.method || 'GET', body: opts.body, headers }); }
  catch { throw new Error("Couldn't reach 3iaw.com. Check your internet and try again."); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    // needLogin / needPlan: the upload limit (Discord login, 2 free uploads, then a plan)
    const e = new Error(body.error || ('Roblox error ' + r.status));
    e.needLogin = Boolean(body.needLogin); e.needPlan = Boolean(body.needPlan);
    throw e;
  }
  return body;
}

async function resolveCreator(text, type) {
  const kind = type === 'group' ? 'group' : 'user';
  text = text.trim();
  if (!text) throw new Error(kind === 'group' ? 'Enter the group ID.' : 'Enter your username or user ID.');
  if (/^\d+$/.test(text)) return text;
  const m = text.match(/\/(?:users|groups|communities)\/(\d+)/);
  if (m) return m[1];
  if (kind === 'user' && /^@?\w{3,20}$/.test(text)) {
    const r = await roblox('user', { key: false, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: text.replace(/^@/, '') }) });
    return String(r.id);
  }
  throw new Error(kind === 'group' ? 'Use the number from the group page link.' : "That doesn't look like a username or user ID.");
}

// ---------- audio processing ----------
let lamePromise;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  lamePromise = lamePromise || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LAME_URL; s.async = true;
    s.onload = () => resolve(window.lamejs);
    s.onerror = () => { lamePromise = null; reject(new Error("Couldn't load the MP3 encoder. Check your internet and try again.")); };
    document.head.appendChild(s);
  });
  return lamePromise;
}

async function decode(file) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, RATE); // decodeAudioData resamples to the context's rate
  try { return await ctx.decodeAudioData(data); }
  catch { throw new Error("This file couldn't be read as audio. Try an MP3, WAV or OGG file."); }
}

// speed, mode ('tempo' keeps pitch, 'pitch' lets pitch follow speed), semitones on top
async function stretch(L, R, s, onProgress) {
  const st = new SoundTouch();
  st.rate = s.mode === 'pitch' ? s.speed : 1;
  st.tempo = s.mode === 'pitch' ? 1 : s.speed;
  st.pitchSemitones = s.pitch;
  const len = L.length;
  const pad = RATE; // a second of silence pushes the last samples out of SoundTouch's buffers
  const source = {
    extract(target, numFrames, position) {
      const n = Math.min(numFrames, len + pad - position);
      for (let i = 0; i < n; i++) {
        const p = position + i;
        target[i * 2] = p < len ? L[p] : 0;
        target[i * 2 + 1] = p < len ? R[p] : 0;
      }
      return Math.max(0, n);
    },
  };
  const filter = new SimpleFilter(source, st);
  const want = Math.round(len / s.speed);
  const outL = new Float32Array(want), outR = new Float32Array(want);
  const CHUNK = 8192, tmp = new Float32Array(CHUNK * 2);
  let n = 0, loops = 0;
  while (n < want) {
    const got = filter.extract(tmp, CHUNK);
    if (!got) break;
    const take = Math.min(got, want - n);
    for (let i = 0; i < take; i++) { outL[n + i] = tmp[i * 2]; outR[n + i] = tmp[i * 2 + 1]; }
    n += take;
    if (++loops % 16 === 0) { onProgress(n / want); await pause(); }
  }
  return [outL.subarray(0, n), outR.subarray(0, n)];
}

// gain, then a limiter (instant attack, ~80 ms release) so loud settings don't clip
function amplify(L, R, gainDb) {
  const g = Math.pow(10, gainDb / 20), limit = 0.97, release = Math.exp(-1 / (0.08 * RATE));
  let env = 0;
  for (let i = 0; i < L.length; i++) {
    const a = L[i] * g, b = R[i] * g;
    const peak = Math.max(Math.abs(a), Math.abs(b));
    env = peak > env ? peak : env * release + peak * (1 - release);
    const k = env > limit ? limit / env : 1;
    L[i] = a * k; R[i] = b * k;
  }
}

// smooth edges, so a cut never ends (or starts) with a click: a tiny fade-in, and a cosine fade-out
// (longer when the audio was cut short, e.g. at the 400 s maximum)
function fadeEdges(L, R, fadeOutSeconds) {
  const len = L.length;
  const inN = Math.min(Math.round(0.012 * RATE), len >> 3);
  for (let i = 0; i < inN; i++) {
    const g = Math.sin((i / inN) * Math.PI / 2);
    L[i] *= g; R[i] *= g;
  }
  const outN = Math.min(Math.round(fadeOutSeconds * RATE), Math.floor(len * 0.15));
  for (let i = 0; i < outN; i++) {
    // goes from 1 to 0 along half a cosine, so it eases in and lands softly on silence
    const g = 0.5 + 0.5 * Math.cos((i / (outN - 1 || 1)) * Math.PI);
    const p = len - outN + i;
    L[p] *= g; R[p] *= g;
  }
  // the very last samples are exactly zero, so the MP3 ends on silence
  for (let i = Math.max(0, len - 32); i < len; i++) { L[i] = 0; R[i] = 0; }
}

async function encodeMp3(L, R, onProgress) {
  const lame = await loadLame();
  const enc = new lame.Mp3Encoder(2, RATE, KBPS);
  const parts = [], BLOCK = 1152;
  const l16 = new Int16Array(BLOCK), r16 = new Int16Array(BLOCK);
  const toInt = (v) => (v < -1 ? -32768 : v > 1 ? 32767 : Math.round(v * (v < 0 ? 32768 : 32767)));
  for (let i = 0; i < L.length; i += BLOCK) {
    const n = Math.min(BLOCK, L.length - i);
    for (let k = 0; k < n; k++) { l16[k] = toInt(L[i + k]); r16[k] = toInt(R[i + k]); }
    const out = enc.encodeBuffer(n === BLOCK ? l16 : l16.subarray(0, n), n === BLOCK ? r16 : r16.subarray(0, n));
    if (out.length) parts.push(new Uint8Array(out));
    if ((i / BLOCK) % 300 === 0) { onProgress(i / L.length); await pause(); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

async function convert(job, file) {
  const prog = (from, span) => (f) => { job.progress = Math.round((from + f * span) * 100); render(); };
  const buf = await decode(file);
  prog(0, 0.1)(1);
  const start = Math.min(Math.floor((job.trimStart || 0) * RATE), buf.length);
  const maxSec = Math.min(MAX_SECONDS, job.maxSeconds || MAX_SECONDS);
  const maxIn = Math.floor(maxSec * job.speed * RATE);
  const inLen = Math.min(buf.length - start, maxIn);
  if (inLen < RATE * 0.2) throw new Error('Nothing left to convert after the start time.');
  job.notes = buf.length - start > maxIn ? [`Cut to ${maxSec} seconds (Max Duration).`] : [];
  // copies, so the effects never change the decoded original
  let L = buf.getChannelData(0).slice(start, start + inLen);
  let R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(start, start + inLen);
  if (Math.abs(job.speed - 1) > 1e-3 || Math.abs(job.pitch) > 1e-3) [L, R] = await stretch(L, R, job, prog(0.1, 0.5));
  amplify(L, R, job.gain);
  // cut before the song's own end (Max Duration, up to 400 s): a 3 s fade; otherwise a short 1.2 s one just to clean the tail
  const cutShort = buf.length - start > maxIn;
  fadeEdges(L, R, cutShort ? 3 : 1.2);
  const blob = await encodeMp3(L, R, prog(0.6, 0.4));
  if (blob.size > MAX_BYTES) throw new Error(`The MP3 is ${(blob.size / 1e6).toFixed(1)} MB; Roblox allows 20 MB.`);
  outputs.set(job.id, { blob, url: URL.createObjectURL(blob) });
  Object.assign(job, { outputSeconds: Math.round((L.length / RATE) * 10) / 10, outputBytes: blob.size, progress: 100 });
}

// ---------- upload + moderation ----------
async function upload(job) {
  const out = outputs.get(job.id);
  if (!out) throw new Error('The converted file is gone (the page was reloaded). Convert it again.');
  Object.assign(job, { stage: 'upload', progress: 20, error: null }); render();
  const creator = cfg.creatorType === 'group' ? { groupId: cfg.creatorId } : { userId: cfg.creatorId };
  const fd = new FormData();
  fd.append('request', JSON.stringify({
    assetType: 'Audio', displayName: (job.name || 'Audio').slice(0, 50),
    description: 'Uploaded with 3iaw.com Audio Converter', creationContext: { creator },
  }));
  fd.append('fileContent', out.blob, 'audio.mp3');
  let op = await roblox('upload', { method: 'POST', body: fd });
  job.progress = 60; render();
  // Roblox processes uploads in the background; ask until it has an asset ID (up to 2 minutes)
  for (let i = 0; i < 60 && !op.done; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const id = op.operationId || String(op.path || '').split('/').pop();
    op = await roblox('operation?id=' + encodeURIComponent(id));
  }
  if (!op.done) throw new Error("Roblox didn't finish processing the upload in 2 minutes. Check your Creator Dashboard.");
  if (op.error) throw new Error('Roblox rejected the upload: ' + (op.error.message || JSON.stringify(op.error)));
  Object.assign(job, { assetId: String(op.response.assetId), stage: 'moderation', moderation: 'Reviewing', progress: 100 });
  saveJobs(); render();
  await checkModeration(job);
}

async function checkModeration(job) {
  if (!job.assetId || !sessionKey) return;
  try {
    const r = await roblox('asset?id=' + encodeURIComponent(job.assetId));
    job.moderation = r.moderationState || 'Reviewing';
    job.moderationError = null;
    if (['Approved', 'Rejected'].includes(job.moderation)) job.stage = 'done';
  } catch (e) { job.moderationError = e.message; }
  saveJobs(); render();
}

setInterval(() => {
  jobs.filter((j) => j.assetId && j.moderation === 'Reviewing').forEach(checkModeration);
}, 30000);

async function run(job, file) {
  try {
    job.stage = 'convert'; render();
    await convert(job, file);
    if (job.autoUpload) await upload(job);
    else job.stage = 'ready';
  } catch (e) {
    Object.assign(job, { failedStage: job.stage, stage: 'error', error: e.message || String(e) });
    if (e.needLogin || e.needPlan) limitHit(e);
  }
  saveJobs(); render();
  if (job.autoUpload) refreshMe();
}

// ---------- form ----------
let file = null, mode = 'tempo', filter = 'all';
// pitch has no control on the page: a hidden field the presets set; mode comes from the preset too
const speed = $('#speed'), pitch = $('#pitch'), gain = $('#gain'), maxDur = $('#maxDur');
const showSpeed = () => { $('#speedVal').textContent = (+speed.value).toFixed(2) + 'x'; };
const showPitch = () => {};
const showGain = () => { $('#gainVal').textContent = (gain.value > 0 ? '+' : '') + gain.value + ' dB'; };
const showMax = () => { $('#maxVal').textContent = maxDur.value + 's'; };
function setMode(v) { mode = v; }
function markPreset() {
  document.querySelectorAll('.ac-fx button').forEach((b) => b.classList.toggle('on',
    +b.dataset.s === +speed.value && +b.dataset.p === +pitch.value && b.dataset.m === mode));
  summarize();
}
// one-line summary next to "02 Sound", so the settings can be folded away
function summarize() {
  const fx = document.querySelector('.ac-fx button.on');
  const g = +gain.value;
  $('#soundSummary').textContent = [fx ? fx.dataset.name : 'Custom', (+speed.value).toFixed(2) + 'x',
    (g > 0 ? '+' : '') + g + ' dB', maxDur.value + 's'].join(' · ');
}
speed.oninput = () => { showSpeed(); markPreset(); };
gain.oninput = () => { showGain(); summarize(); };
maxDur.oninput = () => { showMax(); summarize(); };
const soundToggle = $('#soundToggle'), soundBox = $('#soundBox');
soundToggle.onclick = () => {
  const open = soundBox.hidden;
  soundBox.hidden = !open;
  soundToggle.textContent = open ? 'Hide' : 'Edit';
  soundToggle.setAttribute('aria-expanded', String(open));
};
document.querySelectorAll('[data-speed]').forEach((b) => { b.onclick = () => { speed.value = b.dataset.speed; showSpeed(); markPreset(); }; });
document.querySelectorAll('.ac-fx button').forEach((b) => {
  b.onclick = () => {
    speed.value = b.dataset.s; pitch.value = b.dataset.p; setMode(b.dataset.m);
    if (b.dataset.gain !== undefined) { gain.value = b.dataset.gain; showGain(); }
    showSpeed(); showPitch(); markPreset();
  };
});
// every visit starts on Default (1x, -8 dB), even after a refresh or coming back with the Back button
const pickDefault = () => document.querySelector('.ac-presets [data-name="Default"]').click();
pickDefault();
window.addEventListener('pageshow', (e) => { if (e.persisted) pickDefault(); });

const drop = $('#drop'), fileIn = $('#fileIn');
function setFile(f) {
  file = f || null;
  $('#dropName').textContent = f ? f.name : 'Drop an audio file here';
  drop.classList.toggle('has', Boolean(f));
}
drop.onclick = () => fileIn.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } };
fileIn.onchange = () => setFile(fileIn.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); };

const autoUpload = $('#autoUpload');
const syncGo = () => {
  $('#goBtn').textContent = autoUpload.checked ? 'Convert & upload' : 'Convert only';
  $('#flowUpload').classList.toggle('off', !autoUpload.checked);
  $('#flowCheck').classList.toggle('off', !autoUpload.checked);
};
autoUpload.onchange = syncGo; syncGo();

$('#acForm').onsubmit = (e) => {
  e.preventDefault();
  const err = $('#formErr'); err.textContent = '';
  if (!file) { err.textContent = 'Choose an audio file first.'; return; }
  if (autoUpload.checked && !connected()) { err.textContent = 'Connect your Roblox account first, or untick upload.'; openSettings(); return; }
  // uploading needs a Discord login, and a plan after the free uploads; converting alone is always free
  if (autoUpload.checked && me.ready && !me.user) { err.textContent = 'Log in with Discord to upload, or untick upload.'; showPlans(); return; }
  if (autoUpload.checked && me.plan && !me.plan.active && me.plan.left <= 0) { err.textContent = "You've used your 2 free uploads. Get a plan, or untick upload."; showPlans(); return; }
  if (file.size > 300 * 1024 * 1024) { err.textContent = 'That file is too big (over 300 MB).'; return; }
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: ($('#assetName').value.trim() || file.name.replace(/\.[^.]+$/, '')).slice(0, 50),
    source: file.name, speed: +speed.value, mode, pitch: +pitch.value, gain: +gain.value, maxSeconds: +maxDur.value,
    trimStart: Math.max(0, +$('#trimStart').value || 0), autoUpload: autoUpload.checked,
    stage: 'queued', progress: 0, createdAt: Date.now(),
  };
  jobs.unshift(job); saveJobs();
  const f = file;
  setFile(null); fileIn.value = ''; $('#assetName').value = '';
  run(job, f);
  showPanel('library');
};

// ---------- console panels (sidebar) ----------
const navTabs = [...document.querySelectorAll('.ac-nav [role="tab"]')];
let current = 'convert';
function showPanel(name, focus) {
  current = name;
  navTabs.forEach((t) => {
    const on = t.dataset.panel === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#panel-' + t.dataset.panel).hidden = !on;
    if (on && focus) t.focus();
  });
  // on a phone the panel is below the menu, so bring its top into view
  if (window.matchMedia('(max-width: 900px)').matches) $('.ac-main').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
navTabs.forEach((t, i) => {
  t.onclick = () => { if (t.dataset.panel === 'account') openSettings(); else showPanel(t.dataset.panel); };
  t.onkeydown = (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = navTabs[(i + step + navTabs.length) % navTabs.length];
    if (next.dataset.panel === 'account') openSettings(); else showPanel(next.dataset.panel, true);
    next.focus();
  };
});

// ---------- settings ----------
// the Roblox account panel replaces the old pop-up; "closing" it goes back to Convert
const dlg = { close: () => showPanel('convert') };
function renderConn() {
  const on = connected();
  const who = on ? (cfg.creatorType === 'group' ? 'Group ' : 'User ') + cfg.creatorId : '';
  ['#connDot', '#navDot', '#acctDot'].forEach((s) => $(s).classList.toggle('on', on));
  $('#connText').textContent = on ? who : 'Connect Roblox';
  $('#acctText').textContent = on ? 'Connected: ' + who : 'Not connected';
  renderDash();
}
const syncCreatorLbl = () => {
  const g = $('#creatorType').value === 'group';
  $('#creatorLbl').textContent = g ? 'Group ID' : 'Username or user ID';
  $('#creatorId').placeholder = g ? 'group ID or group link' : 'username, ID or profile link';
  document.querySelectorAll('#typePick button').forEach((b) => { const on = b.dataset.v === $('#creatorType').value; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
};
document.querySelectorAll('#typePick button').forEach((b) => { b.onclick = () => { $('#creatorType').value = b.dataset.v; syncCreatorLbl(); }; });
function openSettings() {
  $('#settingsErr').textContent = '';
  $('#apiKey').value = '';
  $('#keyHint').textContent = sessionKey ? '(saved, ends in ' + sessionKey.slice(-4) + ')' : '';
  $('#creatorType').value = cfg.creatorType || 'user';
  $('#creatorId').value = cfg.creatorId || '';
  $('#remember').checked = store.get('ac.key', '') !== '' || !sessionKey;
  syncCreatorLbl();
  showPanel('account');
  if (!sessionKey) $('#apiKey').focus({ preventScroll: true });
}
$('#creatorType').onchange = syncCreatorLbl;
$('#openSettings').onclick = openSettings;
$('#cancelSettings').onclick = () => dlg.close();
$('#forgetKey').onclick = () => {
  sessionKey = ''; store.del('ac.key'); renderConn();
  $('#keyHint').textContent = ''; toast('Key removed from this browser');
};
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#settingsErr'); err.textContent = '';
  const key = $('#apiKey').value.trim();
  if (!key && !sessionKey) { err.textContent = 'Paste your API key.'; return; }
  const btn = $('#saveSettings'); btn.disabled = true;
  try {
    const type = $('#creatorType').value === 'group' ? 'group' : 'user';
    const id = await resolveCreator($('#creatorId').value, type);
    if (key) sessionKey = key;
    cfg = { creatorType: type, creatorId: id };
    store.set('ac.cfg', cfg);
    if ($('#remember').checked) store.set('ac.key', sessionKey); else store.del('ac.key');
    $('#formErr').textContent = '';
    renderConn(); dlg.close(); toast('Connected as ' + type + ' ' + id);
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; }
};

// ---------- job list ----------
const fmtTime = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '');
// the pipeline on each history row: Convert — Upload — Review — In game
function steps(j) {
  const failAt = j.stage === 'error' ? (j.failedStage === 'upload' ? 'upload' : 'convert') : null;
  const st = {
    convert: failAt === 'convert' ? 'fail' : j.stage === 'convert' ? 'active' : j.stage === 'queued' ? '' : 'done',
    upload: failAt === 'upload' ? 'fail' : j.assetId ? 'done' : j.stage === 'upload' ? 'active' : '',
    review: j.moderation === 'Approved' ? 'done' : j.moderation === 'Rejected' ? 'fail' : j.moderation === 'Reviewing' ? 'active' : '',
    game: j.moderation === 'Approved' ? 'done' : '',
  };
  const names = { convert: 'Convert', upload: 'Upload', review: 'Review', game: 'In game' };
  const icon = (c) => c === 'done' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.3l2.6 2.6L12 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : c === 'fail' ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' : '<i></i>';
  return Object.keys(names).map((k) => `<span class="ac-pipe-step ${st[k]}">${icon(st[k])}${names[k]}</span>`).join('<span class="ac-pipe-line"></span>');
}
function badge(j) {
  if (j.stage === 'error') return '<span class="ac-badge error">Failed</span>';
  if (j.moderation === 'Rejected') return '<span class="ac-badge Rejected">Rejected</span>';
  if (j.moderation === 'Reviewing') return '<span class="ac-badge Reviewing">In review</span>';
  if (j.stage === 'ready') return '<span class="ac-badge ready">Not uploaded</span>';
  if (j.stage === 'queued') return '<span class="ac-badge">Waiting</span>';
  return '';
}
function timeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const [n, u] = s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day'];
  const v = Math.floor(n);
  return v + ' ' + u + (v === 1 ? '' : 's') + ' ago';
}
// which rows are unfolded survives re-rendering
const openJobs = new Map();
$('#jobs').addEventListener('toggle', (e) => {
  const d = e.target.closest('.ac-job'); if (!d) return;
  openJobs.set(d.dataset.id, d.open);
}, true);
function jobHTML(j) {
  const busy = ['queued', 'convert', 'upload'].includes(j.stage);
  const out = outputs.get(j.id);
  const fileName = (j.name || 'audio').replace(/[\/:*?"<>|]/g, '') + '.mp3';
  const open = openJobs.has(j.id) ? openJobs.get(j.id) : (busy || j.stage === 'error');
  const canUpload = j.stage === 'ready' || (j.stage === 'error' && j.failedStage === 'upload' && out);
  const icoCopy = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="2"/></svg>';
  const icoOpen = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const icoDown = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const icoUp = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const assetState = j.moderation === 'Approved' ? 'approved' : j.moderation === 'Rejected' ? 'rejected' : 'in review';
  const rows = [
    ['Source', `<span class="ac-dim">File</span> ${esc(j.source)}`],
    ['Speed', `<b>${esc((+j.speed).toFixed(2))}x</b> <span class="ac-dim">Max Duration: ${esc(j.maxSeconds || 400)}s</span>`],
    ['Amplify', `${esc((j.gain > 0 ? '+' : '') + (j.gain || 0))} dB`],
  ];
  if (j.outputSeconds || j.outputBytes) rows.push(['Output', [j.outputSeconds ? fmtTime(j.outputSeconds) : '', j.outputBytes ? (j.outputBytes / 1e6).toFixed(1) + ' MB' : ''].filter(Boolean).map(esc).join(' <span class="ac-dim">·</span> ')]);
  rows.push(['Date', esc(new Date(j.createdAt || Date.now()).toLocaleString())]);
  return `<details class="ac-job" data-id="${esc(j.id)}"${open ? ' open' : ''}>
    <summary class="ac-job-row">
      <div class="ac-job-main">
        <div class="ac-job-title">${esc(j.name)} ${badge(j)}</div>
        <div class="ac-pipe">${steps(j)}</div>
      </div>
      <span class="ac-job-time">${esc(timeAgo(j.createdAt || Date.now()))}</span>
      <span class="ac-chev" aria-hidden="true"></span>
    </summary>
    <div class="ac-job-body">
    ${busy ? `<div class="ac-bar"><i style="width:${j.progress || 0}%"></i></div>` : ''}
    <div class="ac-actions">
      ${j.assetId ? `<button type="button" class="ac-btn solid" data-act="copy">${icoCopy}Copy link</button>` : ''}
      ${canUpload ? `<button type="button" class="ac-btn solid" data-act="upload">${icoUp}Upload to Roblox</button>` : ''}
      ${out ? `<a class="ac-btn" href="${out.url}" download="${esc(fileName)}">${icoDown}Download MP3</a>` : ''}
      ${j.assetId ? '<button type="button" class="ac-btn" data-act="check">Check status</button>' : ''}
      ${!busy ? '<button type="button" class="ac-btn ghost" data-act="remove">Remove</button>' : ''}
    </div>
    ${j.assetId ? `<div class="ac-kv-head">Asset <span class="${j.moderation === 'Approved' ? 'ok' : j.moderation === 'Rejected' ? 'bad' : 'rev'}">· ${esc(assetState)}</span></div>
    <div class="ac-asset"><b>${esc(j.assetId)}</b>
      <button type="button" class="ac-icon" data-act="copyid" title="Copy ID" aria-label="Copy ID">${icoCopy}</button>
      <a class="ac-icon" href="https://create.roblox.com/store/asset/${esc(j.assetId)}" target="_blank" rel="noopener" title="Open on Roblox" aria-label="Open on Roblox">${icoOpen}</a></div>` : ''}
    ${out ? `<audio class="ac-player" controls preload="metadata" src="${out.url}"></audio>` : ''}
    ${(j.notes || []).map((n) => `<div class="ac-warn">${esc(n)}</div>`).join('')}
    ${j.error ? `<div class="ac-err">${esc(j.error)}</div>` : ''}
    ${j.moderationError ? `<div class="ac-err">${esc(j.moderationError)}</div>` : ''}
    <div class="ac-kv-head">Details</div>
    <div class="ac-kv">${rows.map(([k, v]) => `<div><span>${k}</span><p>${v}</p></div>`).join('')}</div>
    </div></details>`;
}
function matches(j) {
  if (filter === 'all') return true;
  if (filter === 'failed') return j.stage === 'error' || j.moderation === 'Rejected';
  return j.moderation === filter;
}
let lastHTML = '';
function render() {
  $('#navCount').textContent = jobs.length;
  renderDash();
  const shown = jobs.filter(matches);
  const html = shown.length ? shown.map(jobHTML).join('')
    : `<div class="ac-empty">${jobs.length ? 'Nothing here with this filter.' : 'No audio yet. Choose a file in Convert to start.'}</div>`;
  if (html === lastHTML) return;
  // rebuilding would stop a preview that's playing; it re-renders on the next change instead
  if ([...document.querySelectorAll('#jobs audio')].some((a) => !a.paused) && !shown.some((j) => ['convert', 'upload'].includes(j.stage))) return;
  lastHTML = html;
  $('#jobs').innerHTML = html;
}
$('#jobs').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const j = jobs.find((x) => x.id === b.closest('.ac-job').dataset.id); if (!j) return;
  const act = b.dataset.act;
  if (act === 'copy') {
    const link = 'https://create.roblox.com/store/asset/' + j.assetId;
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Copy failed: ' + link); }
    return;
  }
  if (act === 'copyid') {
    try { await navigator.clipboard.writeText(j.assetId); toast('Asset ID copied'); } catch { toast('Copy failed: ' + j.assetId); }
  } else if (act === 'upload') {
    if (!connected()) { openSettings(); return; }
    try { await upload(j); } catch (ex) { Object.assign(j, { failedStage: 'upload', stage: 'error', error: ex.message }); if (ex.needLogin || ex.needPlan) limitHit(ex); }
    saveJobs(); render(); refreshMe();
  } else if (act === 'check') {
    if (!sessionKey) { openSettings(); return; }
    await checkModeration(j); toast('Status: ' + (j.moderation || 'unknown'));
  } else if (act === 'remove') {
    if (!confirm('Remove this from the list? Audio already on Roblox stays there.')) return;
    const out = outputs.get(j.id); if (out) URL.revokeObjectURL(out.url);
    outputs.delete(j.id); jobs = jobs.filter((x) => x !== j); saveJobs(); render();
  }
});
document.querySelectorAll('#filter button').forEach((b) => {
  b.onclick = () => { filter = b.dataset.f; document.querySelectorAll('#filter button').forEach((x) => x.classList.toggle('on', x === b)); render(); };
});
window.addEventListener('beforeunload', (e) => { if (jobs.some((j) => ['convert', 'upload'].includes(j.stage))) e.preventDefault(); });

// ---------- Discord login + plans ----------
let me = { user: null, plan: null, ready: true };
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
function planWords(p) {
  if (!p) return '';
  if (p.active) return 'Unlimited until ' + fmtDate(p.until);
  return p.left + ' of ' + p.free + ' free uploads left';
}
function renderMe() {
  const u = me.user;
  $('#loginBtn').hidden = Boolean(u);
  $('#loginBtn').disabled = !me.ready;
  if (!me.ready) $('#loginBtn').lastChild.nodeValue = 'Discord login coming soon';
  $('#planLogin').hidden = Boolean(u) || !me.ready;
  $('#buyBtn').textContent = u ? 'Place order' : 'Log in with Discord to buy';
  renderDash();
  if ($('#hdrUser')) renderHdr();
}

// ---------- dashboard: welcome line, four account cards, uploads-left banner ----------
// the connected Roblox account's name and headshot, fetched once per account and kept for a day
const profiles = store.get('ac.profiles', {});
const profileLoading = new Set();
function robloxProfile() {
  const k = cfg.creatorType + ':' + cfg.creatorId, p = profiles[k];
  if (p && Date.now() - p.at < 86400000) return p;
  if (!profileLoading.has(k)) {
    profileLoading.add(k);
    roblox(`profile?type=${encodeURIComponent(cfg.creatorType)}&id=${encodeURIComponent(cfg.creatorId)}`, { key: false })
      .then((d) => { if (d.name) { profiles[k] = { ...d, at: Date.now() }; store.set('ac.profiles', profiles); renderDash(); } })
      .catch(() => {})
      .finally(() => profileLoading.delete(k));
  }
  return p || null;
}
// numbers count up to their new value instead of jumping
function countTo(el, to) {
  const from = +el.dataset.n || 0;
  el.dataset.n = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderDash() {
  const u = me.user, p = me.plan, active = Boolean(p && p.active);
  $('#helloName').textContent = u ? ', ' + u.name : '';
  // Discord
  $('#tDiscord').textContent = u ? u.name : (me.ready ? 'Not linked' : 'Coming soon');
  $('#tDiscordPill').textContent = u ? 'Linked' : 'Log in';
  $('#tDiscordPill').classList.toggle('on', Boolean(u));
  const av = $('#tDiscordAv');
  av.hidden = !u;
  if (u) av.src = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  // Roblox
  const on = connected();
  const prof = on ? robloxProfile() : null;
  $('#tRoblox').textContent = on ? (prof && prof.name) || (cfg.creatorType === 'group' ? 'Group ' : '') + cfg.creatorId : 'Not connected';
  $('#tRoblox').title = prof && prof.username ? '@' + prof.username + ' · ID ' + cfg.creatorId : (on ? 'ID ' + cfg.creatorId : '');
  const rav = $('#tRobloxAv');
  rav.hidden = !(prof && prof.avatar);
  if (prof && prof.avatar && rav.src !== prof.avatar) rav.src = prof.avatar;
  $('#tRobloxPill').textContent = on ? 'Linked' : 'Connect';
  $('#tRobloxPill').classList.toggle('on', on);
  // conversions (this browser)
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  countTo($('#tTotal'), jobs.length);
  $('#tMonth').textContent = jobs.filter((j) => j.createdAt >= monthStart.getTime()).length + ' this month';
  // plan
  $('#tPlan').textContent = active ? 'Unlimited' : 'Free';
  $('#tPlanSub').textContent = active ? 'Until ' + fmtDate(p.until) : (p ? p.left + ' of ' + p.free + ' free uploads left' : '2 free uploads');
  $('#tUpgrade').hidden = active;
  document.querySelector('.ac-tile.plan').classList.toggle('active', active);
  // banner above the convert form
  const q = $('#quota');
  q.hidden = !u || !p;
  if (u && p) {
    q.classList.toggle('active', active);
    q.classList.toggle('empty', !active && p.left <= 0);
    $('#quotaNum').textContent = active ? '∞' : p.left;
    $('#quotaMain').textContent = active ? 'Unlimited uploads' : '/' + p.free + ' free uploads left';
    $('#quotaSub').textContent = active ? 'Until ' + fmtDate(p.until) : 'Free plan';
    $('#quotaBtn').hidden = active;
  }
  $('#cPlan').textContent = active ? 'Unlimited' : 'Free';
  $('#cPlan').classList.toggle('on', active);
  // while a plan runs, show it instead of the buy form
  $('#planActive').hidden = !active;
  $('#buyForm').hidden = active;
  if (active) $('#planActiveLine').textContent = 'Unlimited uploads until ' + fmtDate(p.until) + '.';
  // Accounts & Plan: profile card
  $('#pName').textContent = u ? u.name : (me.ready ? 'Not logged in' : 'Discord login coming soon');
  const pav = $('#pAvatar');
  pav.hidden = !u;
  if (u) pav.src = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  $('#pInitial').textContent = u ? (u.name || '?').trim().charAt(0).toUpperCase() : '?';
  const chip = (el, label, value) => {
    el.classList.toggle('on', Boolean(value));
    el.innerHTML = (value ? '<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '')
      + esc(label) + ' <em>' + esc(value || 'not linked') + '</em>';
  };
  chip($('#pDiscord'), 'Discord Account', u && u.name);
  chip($('#pRoblox'), 'Roblox Account', on ? (prof && (prof.username || prof.name)) || cfg.creatorId : '');
  $('#profileCard').classList.toggle('active', active);
  countTo($('#pTotal'), jobs.length);
  countTo($('#pMonth'), jobs.filter((j) => j.createdAt >= monthStart.getTime()).length);
  countTo($('#pUploaded'), jobs.filter((j) => j.assetId).length);
}
$('#tUpgrade').onclick = () => showPlans();
$('#quotaBtn').onclick = () => showPlans();
$('#tDiscordPill').onclick = () => { if (!me.user && me.ready) login(); };
$('#tRobloxPill').onclick = () => openSettings();

// cards light up where the pointer is
document.querySelectorAll('.ac-tile, .ac-card').forEach((el) => {
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
});

// tutorial video: data-video holds a YouTube ID or link
(() => {
  const box = $('#tutorialVideo'), v = (box.dataset.video || '').trim();
  const id = (v.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/) || [])[1] || (/^[\w-]{11}$/.test(v) ? v : '');
  if (!id) return;
  box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}" title="Audio Converter tutorial" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
})();
async function refreshMe() {
  try { me = await (await fetch('/api/auth/me', { cache: 'no-store' })).json(); } catch { /* keep what we had */ }
  renderMe();
}
// the plan lives in the Roblox Account tab: open it and bring the plan into view
function showPlans() {
  showPanel('account');
  setTimeout(() => $('#plans').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
// after the free uploads: say why, and open the Plans section
function limitHit(e) { toast(e.message); showPlans(); refreshMe(); }
const login = () => { location.href = '/api/auth/discord'; };
$('#loginBtn').onclick = login;
$('#planLogin').onclick = login;
async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  me = { user: null, plan: null, ready: me.ready }; renderMe(); toast('Logged out');
};
// back from Discord: say how it went and tidy the address bar
(() => {
  const q = new URLSearchParams(location.search).get('login');
  if (!q) return;
  toast(q === 'ok' ? 'Logged in with Discord' : "Discord login didn't work. Try again.");
  history.replaceState(null, '', location.pathname);
})();

// buy a plan: bKash / Nagad, like the order form, tied to the logged-in Discord account
let payWith = 'bKash';
function showPay() {
  const picked = document.querySelector('#planPick input:checked');
  $('#payAmount').textContent = '৳' + Number(picked.dataset.bdt).toLocaleString('en-US');
  $('#payMethod').textContent = payWith;
  document.querySelectorAll('#payPick button').forEach((b) => b.classList.toggle('on', b.dataset.v === payWith));
}
document.querySelectorAll('#payPick button').forEach((b) => { b.onclick = () => { payWith = b.dataset.v; showPay(); }; });
$('#planPick').onchange = showPay;
showPay();
$('#copyNumber').onclick = async () => {
  const n = $('#payBox').dataset.number;
  try { await navigator.clipboard.writeText(n); toast(payWith + ' number copied'); } catch { toast(n); }
};
$('#buyForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#buyErr'); err.textContent = ''; err.className = 'form-status err';
  if (!me.user) { if (me.ready) login(); else err.textContent = 'Discord login is being set up. Try again soon.'; return; }
  const txn = $('#buyTxn').value.trim(), email = $('#buyEmail').value.trim();
  if (!txn) { err.textContent = 'Enter the transaction ID from your receipt.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { err.textContent = 'Enter a correct email address.'; return; }
  const btn = $('#buyBtn'); btn.disabled = true;
  try {
    const r = await fetch('/api/plan-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: document.querySelector('#planPick input:checked').value, payment: payWith, transactionId: txn, email }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { if (d.needLogin) { me.user = null; renderMe(); } throw new Error(d.error || 'Could not place the order. Try again.'); }
    $('#buyTxn').value = '';
    err.className = 'form-status ok';
    err.textContent = 'Order ' + d.orderId + ' placed. Your plan starts as soon as the payment is confirmed.';
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.disabled = false; }
};

// ---------- header: EN / Bangla switch and the Discord account menu (next to the Audio Converter tab) ----------
(() => {
  const wrap = document.querySelector('#siteHeader .brand-wrap');
  if (!wrap) return;
  const box = document.createElement('div');
  box.className = 'ac-hdr';
  box.id = 'acHdr';
  box.innerHTML = `
    <div class="ac-lang" role="group" aria-label="Language">
      <button type="button" data-lang="en">EN</button><button type="button" data-lang="bn">বাং</button>
    </div>
    <button type="button" class="ac-hdr-login" id="hdrLogin" hidden><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.3 5.3A17 17 0 0 0 15 4l-.5 1.1a15.6 15.6 0 0 0-5 0L9 4a17 17 0 0 0-4.3 1.3C2 9.4 1.3 13.4 1.6 17.3a17.2 17.2 0 0 0 5.3 2.7l1.1-1.8a11 11 0 0 1-1.8-.9l.4-.3a12.2 12.2 0 0 0 10.6 0l.4.3c-.6.4-1.2.7-1.8.9l1.1 1.8a17.1 17.1 0 0 0 5.3-2.7c.4-4.5-.7-8.5-2.9-12z"/></svg>Log in</button>
    <div class="ac-user" id="hdrUser" hidden>
      <button type="button" class="ac-av-btn" id="hdrAvBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="hdrMenu" aria-label="Account menu"><img id="hdrAv" alt=""></button>
      <div class="ac-menu" id="hdrMenu" role="menu" hidden>
        <div class="ac-menu-who"><b id="hdrName" data-no-i18n></b><span id="hdrSub" data-no-i18n></span></div>
        <button type="button" role="menuitem" id="hdrLogout"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Logout</button>
      </div>
    </div>`;
  wrap.appendChild(box);
  box.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => setLang(b.dataset.lang); });
  const btn = $('#hdrAvBtn'), menu = $('#hdrMenu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) $('#hdrLogout').focus(); };
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
  $('#hdrLogout').onclick = () => { close(); logout(); };
  $('#hdrLogin').onclick = () => { if (me.ready) login(); };
})();
function renderHdr() {
  const u = me.user;
  $('#hdrUser').hidden = !u;
  $('#hdrLogin').hidden = Boolean(u) || !me.ready;
  if (!u) return;
  $('#hdrAv').src = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  $('#hdrName').textContent = u.name;
  $('#hdrSub').textContent = '@' + u.username;
}
renderConn();
renderMe();
startI18n();
refreshMe();
render();
jobs.filter((j) => j.assetId && j.moderation === 'Reviewing').forEach(checkModeration);
