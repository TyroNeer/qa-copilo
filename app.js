'use strict';
/* QA Copilot — 100 % navigateur.
 * Micro -> PCM 16 kHz (live, WAV toutes les 15 s) + MediaRecorder Opus (réunion complète)
 * -> API Gemini directe -> alertes live + synthèse Markdown finale.
 */

// ---- Paramètres figés ----
const CFG = {
  LIVE_INTERVAL_MS: 15000,      // analyse toutes les 15 s
  CONTEXT_ENTRIES: 5,           // ~75 s de transcription précédente + 15 s d'audio = ~90 s
  ALERT_TTL_MS: 20000,          // l'alerte s'estompe après 20 s
  HISTORY_SIZE: 3,
  LIVE_TEMPERATURE: 0.2,
  SYNTH_TEMPERATURE: 0.3,
  AUDIO_BITRATE: 16000,         // Opus 16 kbit/s : ~7 Mo pour 1 h
  MAX_INLINE_AUDIO_BYTES: 14 * 1024 * 1024,
  SILENCE_RMS: 0.002,           // en dessous : extrait ignoré (économie)
  DEFAULT_MODEL: 'gemini-2.5-flash',
  STORE_KEY: 'qacopilot.session',
};

const $ = (id) => document.getElementById(id);
const settings = {
  get key() { return localStorage.getItem('qacopilot.key') || ''; },
  get model() { return (localStorage.getItem('qacopilot.model') || CFG.DEFAULT_MODEL).trim(); },
};

const S = {
  running: false, busy: false, stream: null, ctx: null, proc: null, rate: 16000,
  pcm: [], recorder: null, recChunks: [], audioBlob: null, audioMime: 'audio/webm',
  transcript: [], alerts: [], usContext: '', startedAt: 0, timer: null, clockTimer: null,
  cueTimer: null, wakeLock: null, markdown: '',
};

// ---------- UI ----------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 's-' + screen));
}
function setStatus(msg, isErr = false) {
  const el = $('status'); el.textContent = msg; el.classList.toggle('err', isErr);
}
function tickClock() {
  const s = Math.floor((Date.now() - S.startedAt) / 1000);
  $('clock').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function showCue(a) {
  const cue = $('cue');
  cue.className = a.type;
  cue.querySelector('.type').textContent = a.type;
  cue.querySelector('.text').textContent = a.text;
  clearTimeout(S.cueTimer);
  S.cueTimer = setTimeout(() => cue.classList.add('idle'), CFG.ALERT_TTL_MS);
  renderHistory();
}
function renderHistory() {
  const items = S.alerts.slice(-(CFG.HISTORY_SIZE + 1), -1).reverse();
  $('history').innerHTML = '';
  for (const a of items) {
    const d = document.createElement('div');
    d.className = 'item ' + a.type;
    const b = document.createElement('b'); b.textContent = a.type;
    d.append(b, document.createTextNode(a.text));
    $('history').append(d);
  }
}

// ---------- Persistance (secours si rechargement) ----------
function save() {
  try {
    localStorage.setItem(CFG.STORE_KEY, JSON.stringify({
      date: new Date(S.startedAt || Date.now()).toISOString(), usContext: S.usContext,
      transcript: S.transcript, alerts: S.alerts, markdown: S.markdown,
    }));
  } catch (_) { /* quota : on ignore */ }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(CFG.STORE_KEY) || 'null'); } catch (_) { return null; }
}

// ---------- Audio ----------
function encodeWAV(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej; r.readAsDataURL(blob);
  });
}
function drainPCM() {
  const len = S.pcm.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(len); let o = 0;
  for (const a of S.pcm) { out.set(a, o); o += a.length; }
  S.pcm = []; return out;
}
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length || 1)); }

async function startAudio() {
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
  });
  S.stream.getAudioTracks()[0].onended = () => setStatus('⚠ Micro coupé par le système', true);

  // Flux PCM pour le live
  try { S.ctx = new AudioContext({ sampleRate: 16000 }); } catch (_) { S.ctx = new AudioContext(); }
  await S.ctx.resume();
  S.rate = S.ctx.sampleRate;
  const src = S.ctx.createMediaStreamSource(S.stream);
  S.proc = S.ctx.createScriptProcessor(4096, 1, 1);
  S.proc.onaudioprocess = (e) => { if (S.running) S.pcm.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  const mute = S.ctx.createGain(); mute.gain.value = 0;
  src.connect(S.proc); S.proc.connect(mute); mute.connect(S.ctx.destination);

  // Enregistrement complet pour la synthèse
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime, audioBitsPerSecond: CFG.AUDIO_BITRATE } : {});
  S.audioMime = (S.recorder.mimeType || mime || 'audio/webm').split(';')[0];
  S.recChunks = [];
  S.recorder.ondataavailable = (e) => { if (e.data.size) S.recChunks.push(e.data); };
  S.recorder.start(10000);
}
function stopAudio() {
  return new Promise((resolve) => {
    const finish = () => {
      S.audioBlob = S.recChunks.length ? new Blob(S.recChunks, { type: S.audioMime }) : null;
      S.stream?.getTracks().forEach((t) => t.stop());
      S.ctx?.close().catch(() => {});
      resolve();
    };
    if (S.recorder && S.recorder.state !== 'inactive') { S.recorder.onstop = finish; S.recorder.stop(); } else finish();
  });
}

// ---------- Wake lock ----------
async function keepAwake() {
  try { if ('wakeLock' in navigator && S.running) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
  else if (S.running) setStatus('⚠ Onglet en arrière-plan : gardez-le ouvert', true);
});

// ---------- Gemini ----------
async function gemini({ system, parts, temperature, schema, fast }) {
  const model = settings.model;
  const generationConfig = { temperature };
  if (schema) { generationConfig.responseMimeType = 'application/json'; generationConfig.responseSchema = schema; }
  if (fast && /^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error('Réponse vide (' + (cand?.finishReason || data.promptFeedback?.blockReason || '?') + ')');
  return text;
}

const LIVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    alerts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { type: { type: 'STRING', enum: ['Alerte', 'Question'] }, text: { type: 'STRING' } },
        required: ['type', 'text'],
      },
    },
  },
  required: ['transcript', 'alerts'],
};

async function liveTick() {
  if (!S.running || S.busy) return;           // si un appel est en cours, l'audio s'accumule pour le suivant
  const samples = drainPCM();
  const secs = samples.length / S.rate;
  if (secs < 2) return;
  if (rms(samples) < CFG.SILENCE_RMS) { setStatus('🎙 Silence'); return; }

  S.busy = true;
  setStatus('🎙 Analyse…');
  const ctxText = S.transcript.slice(-CFG.CONTEXT_ENTRIES).map((e) => e.text).join('\n') || '(début de réunion)';
  const prev = S.alerts.slice(-10).map((a) => `- ${a.type} : ${a.text}`).join('\n') || '(aucune)';
  const text =
    (S.usContext ? `USER STORY / CONTEXTE :\n${S.usContext}\n\n` : '') +
    `TRANSCRIPTION PRÉCÉDENTE (contexte, ne pas retranscrire) :\n${ctxText}\n\n` +
    `ALERTES DÉJÀ ÉMISES (ne pas répéter) :\n${prev}\n\n` +
    `L'audio joint contient les ${Math.round(secs)} dernières secondes de la réunion.`;
  try {
    const out = JSON.parse(await gemini({
      system: LIVE_PROMPT,
      parts: [{ inline_data: { mime_type: 'audio/wav', data: bufToB64(encodeWAV(samples, S.rate)) } }, { text }],
      temperature: CFG.LIVE_TEMPERATURE, schema: LIVE_SCHEMA, fast: true,
    }));
    const t = (out.transcript || '').trim();
    if (t) { S.transcript.push({ t: Date.now(), text: t }); $('heard').textContent = t; }
    for (const a of (out.alerts || []).slice(0, 2)) {
      if (!a?.text) continue;
      const alert = { t: Date.now(), type: a.type === 'Question' ? 'Question' : 'Alerte', text: a.text.trim() };
      S.alerts.push(alert); showCue(alert);
    }
    save();
    setStatus(`🎙 En écoute · ${S.alerts.length} remarque(s)`);
  } catch (e) {
    setStatus('⚠ ' + e.message, true);
  } finally {
    S.busy = false;
  }
}

// ---------- Session ----------
async function startSession() {
  if (!settings.key) { show('settings'); return; }
  S.usContext = $('usContext').value.trim();
  localStorage.setItem('qacopilot.us', S.usContext);
  Object.assign(S, { transcript: [], alerts: [], markdown: '', audioBlob: null, pcm: [] });
  try {
    await startAudio();
  } catch (e) {
    setStatus('⚠ Micro refusé : ' + e.message, true); return;
  }
  S.running = true; S.startedAt = Date.now();
  keepAwake();
  $('dot').classList.add('on');
  $('cue').className = 'idle'; $('cue').querySelector('.type').textContent = 'En écoute';
  $('cue').querySelector('.text').textContent = 'RAS'; $('history').innerHTML = ''; $('heard').textContent = '';
  S.timer = setInterval(liveTick, CFG.LIVE_INTERVAL_MS);
  S.clockTimer = setInterval(tickClock, 1000); tickClock();
  setStatus('🎙 En écoute');
  show('live');
}

async function stopSession() {
  if (!S.running) return;
  S.running = false;
  clearInterval(S.timer); clearInterval(S.clockTimer);
  $('dot').classList.remove('on');
  S.wakeLock?.release().catch(() => {});
  await stopAudio();
  show('result');
  await runSynthesis();
}

function stripFences(md) { return md.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim(); }

async function runSynthesis() {
  $('retry').style.display = 'none';
  $('result').textContent = '⏳ Synthèse en cours (30 à 90 s pour 1 h de réunion)…';
  setStatus('Synthèse…');
  const date = new Date(S.startedAt || Date.now()).toLocaleString('fr-FR');
  const transcriptText = S.transcript.map((e) => e.text).join('\n') || '(vide)';
  const alertsText = S.alerts.map((a) => `- ${a.type} : ${a.text}`).join('\n') || '(aucune)';
  const buildText = (withAudio) =>
    `Date de la réunion : ${date}\n\n` +
    (S.usContext ? `USER STORY / CONTEXTE :\n${S.usContext}\n\n` : '') +
    (withAudio ? "L'audio complet de la réunion est joint : il fait foi. La transcription ci-dessous est une aide (peut contenir des erreurs).\n\n" : '') +
    `TRANSCRIPTION AUTOMATIQUE :\n${transcriptText}\n\nALERTES QA ÉMISES EN SÉANCE :\n${alertsText}`;

  const useAudio = S.audioBlob && S.audioBlob.size <= CFG.MAX_INLINE_AUDIO_BYTES;
  try {
    let md;
    try {
      const parts = [{ text: buildText(useAudio) }];
      if (useAudio) parts.unshift({ inline_data: { mime_type: S.audioMime, data: await blobToB64(S.audioBlob) } });
      md = await gemini({ system: SYNTH_PROMPT, parts, temperature: CFG.SYNTH_TEMPERATURE });
    } catch (e) {
      if (!useAudio) throw e;
      $('result').textContent = `⏳ Audio refusé (${e.message}). Synthèse sur la transcription…`;
      md = await gemini({ system: SYNTH_PROMPT, parts: [{ text: buildText(false) }], temperature: CFG.SYNTH_TEMPERATURE });
    }
    S.markdown = stripFences(md);
    $('result').textContent = S.markdown;
    setStatus('Synthèse prête');
    save();
  } catch (e) {
    $('result').textContent = '⚠ Échec de la synthèse : ' + e.message;
    $('retry').style.display = '';
    setStatus('⚠ Synthèse en échec', true);
    save();
  }
}

// ---------- Boutons ----------
$('start').onclick = startSession;
$('stop').onclick = () => { if (confirm('Terminer la réunion et générer la synthèse ?')) stopSession(); };
$('retry').onclick = runSynthesis;
$('newSession').onclick = () => { $('clock').textContent = ''; setStatus('Prêt'); refreshSetup(); show('setup'); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('result').textContent); setStatus('Copié ✔'); } catch (e) { setStatus('⚠ Copie impossible', true); }
};
$('share').onclick = async () => {
  const text = $('result').textContent;
  if (navigator.share) { try { await navigator.share({ title: 'Synthèse de cadrage QA', text }); } catch (_) {} }
  else $('copy').onclick();
};
$('gear').onclick = () => { if (!S.running) { $('apiKey').value = settings.key; $('model').value = settings.model; show('settings'); } };
$('saveSettings').onclick = () => {
  localStorage.setItem('qacopilot.key', $('apiKey').value.trim());
  localStorage.setItem('qacopilot.model', $('model').value.trim() || CFG.DEFAULT_MODEL);
  refreshSetup(); show(settings.key ? 'setup' : 'settings');
};
$('lastSession').onclick = () => {
  const s = loadSaved(); if (!s) return;
  Object.assign(S, { transcript: s.transcript || [], alerts: s.alerts || [], usContext: s.usContext || '', markdown: s.markdown || '', startedAt: Date.parse(s.date) || Date.now(), audioBlob: null });
  show('result');
  if (S.markdown) $('result').textContent = S.markdown; else runSynthesis();
};
window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

function refreshSetup() {
  $('usContext').value = localStorage.getItem('qacopilot.us') || '';
  const s = loadSaved();
  $('lastSession').style.display = s && (s.markdown || (s.transcript || []).length) ? '' : 'none';
}

// ---------- Init ----------
// Lien privé "…/#key=AIza…" : enregistre la clé sur le téléphone puis l'efface de l'URL.
{
  const m = location.hash.match(/key=([\w-]+)/);
  if (m) { localStorage.setItem('qacopilot.key', m[1]); history.replaceState(null, '', location.pathname); }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refreshSetup();
if (!window.isSecureContext) setStatus('⚠ HTTPS requis pour le micro', true);
show(settings.key ? 'setup' : 'settings');
if (!settings.key) { $('model').value = CFG.DEFAULT_MODEL; }
