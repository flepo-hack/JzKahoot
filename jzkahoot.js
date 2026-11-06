#!/usr/bin/env node
'use strict';

const readline = require('readline');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- ANSI colors ----------
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', white: '\x1b[97m'
};
function color(t, c) { return (C[c] || '') + t + C.reset; }
function sleep(s) { return new Promise(r => setTimeout(r, Math.round(s * 1000))); }

// ---------- prompt helpers ----------
let inputLines = null;
let inputIndex = 0;
if (!process.stdin.isTTY) {
  try {
    const data = fs.readFileSync(0, 'utf8');
    inputLines = data.split(/\r?\n/);
  } catch (e) { inputLines = []; }
}
let rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
function ask(q) {
  if (inputLines) {
    process.stdout.write(q);
    const ans = inputIndex < inputLines.length ? inputLines[inputIndex++] : '';
    process.stdout.write(ans + '\n');
    if (String(ans).trim().toUpperCase() === 'Q') exitAll();
    return Promise.resolve(ans);
  }
  return new Promise((resolve) => {
    rl.question(q, (ans) => {
      if (String(ans).trim().toUpperCase() === 'Q') exitAll();
      resolve(ans);
    });
  });
}
function closePrompts() {
  if (rl) { try { rl.close(); } catch (e) {} rl = null; }
}
function enableRawExit() {
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  try { process.stdin.setRawMode(true); } catch (e) {}
  process.stdin.on('keypress', (str, key) => {
    if (str === 'Q' || str === 'q') exitAll();
    if (str === '3') { leaveAll('Leaver (3)'); }
    if (key && key.ctrl && key.name === 'c') exitAll();
  });
}

// ---------- exit handling ----------
let exiting = false;
const clients = [];
function registerClient(c) { if (c) clients.push(c); }
function leaveAll(reason) {
  console.log('\n' + color('  [!] ' + (reason || 'Leaver') + ' - poistetaan kaikki botit...', 'yellow'));
  for (const c of clients) { try { c.leave(); } catch (e) {} }
  try { mirrorState.status = 'left'; } catch (e) {}
  console.log(color('  [+] Botit poistettu. Shift+Q = sulje.', 'green'));
}
function exitAll() {
  if (exiting) return;
  exiting = true;
  leaveAll('Iso Q - suljetaan');
  setTimeout(() => process.exit(0), 400);
}

// ---------- helpers ----------
function extractMeta(obj, meta, key) {
  meta = meta || { uuids: [], titles: [], hosts: [], media: [] };
  key = (key || '').toLowerCase();
  if (typeof obj === 'string') {
    const m = obj.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig);
    if (m) for (const u of m) { if (meta.uuids.indexOf(u) === -1) meta.uuids.push(u); }
    if ((key.indexOf('title') !== -1 || key.indexOf('quizname') !== -1 || key.indexOf('name') !== -1) && obj.length > 2 && obj.length < 120 && !/^https?:/.test(obj) && key.indexOf('username') === -1 && key.indexOf('nickname') === -1) {
      if (meta.titles.indexOf(obj) === -1) meta.titles.push(obj);
    }
    if ((key.indexOf('host') !== -1 || key.indexOf('creator') !== -1 || key.indexOf('author') !== -1) && obj.length > 1 && obj.length < 60 && !/^https?:/.test(obj)) {
      if (meta.hosts.indexOf(obj) === -1) meta.hosts.push(obj);
    }
    if (/https?:\/\/.*(images|media|kahoot)/i.test(obj) && meta.media.indexOf(obj) === -1) meta.media.push(obj);
    return meta;
  }
  if (!obj || typeof obj !== 'object') return meta;
  if (Array.isArray(obj)) { obj.forEach(x => extractMeta(x, meta, key)); return meta; }
  for (const k of Object.keys(obj)) extractMeta(obj[k], meta, k);
  return meta;
}

async function fetchAnswers(uuid) {
  if (!uuid) return null;
  const urls = [
    `https://create.kahoot.it/rest/kahoots/${uuid}`,
    `https://kahoot.it/rest/kahoots/${uuid}`,
    `https://play.kahoot.it/rest/kahoots/${uuid}`
  ];
  for (const u of urls) {
    try {
      const data = await httpGetJson(u, 8000);
      if (data && Array.isArray(data.questions)) return data.questions;
    } catch (e) {}
  }
  return null;
}

function httpGetJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Origin': 'https://kahoot.it',
        'Referer': 'https://kahoot.it/'
      },
      timeout: timeout || 8000
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function openAIAnswer(apiKey, model, questionText, choices) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You answer multiple-choice quiz questions. Reply with only the 0-based index of the correct option. For multiple correct, return comma-separated indices.' },
        { role: 'user', content: `Question: ${questionText}\nOptions:\n${choices.map((c, i) => i + ': ' + c).join('\n')}` }
      ],
      temperature: 0,
      max_tokens: 20
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          const nums = txt.match(/\d+/g);
          if (nums && nums.length) {
            const idxs = nums.map(n => parseInt(n, 10)).filter(n => n >= 0 && n < choices.length);
            if (idxs.length === 1) resolve(idxs[0]);
            else if (idxs.length > 1) resolve(idxs);
            else resolve(null);
          } else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function findPublicMatches(questionCount, firstChoiceCount, firstCorrect, firstQuestionText, hints) {
  hints = hints || {};
  // Brain/muisti: tarkista cache (sormenjälki + Q1)
  const mem = loadMemory();
  const key = memKey(questionCount, firstChoiceCount, firstCorrect);
  const structKey = questionCount + ':' + (hints.choiceCounts || []).join(',');
  const brainUuid = (_brain.fingerprints[key] && _brain.fingerprints[key].uuid) || mem[key] || (_brain.fingerprints[structKey] && _brain.fingerprints[structKey].uuid) || mem[structKey];
  if (brainUuid) {
    const cached = (_brain.quizzes[brainUuid] && _brain.quizzes[brainUuid].questions) || await fetchAnswers(brainUuid);
    if (cached && Array.isArray(cached) && cached.length === questionCount) {
      const ok = (firstCorrect == null) ? true : matchQ(cached, 0, firstChoiceCount, firstCorrect);
      if (ok) {
        cached.__uuid = brainUuid;
        console.log(color('  [+] Brain/muisti osui: ' + brainUuid, 'green'));
        return [cached];
      }
    }
  }

  const queries = [];
  const addQ = (q) => { q = String(q || '').trim(); if (q && queries.indexOf(q) === -1) queries.push(q); };
  if (hints.title) addQ(hints.title);
  if (hints.host) addQ(hints.host);
  if (firstQuestionText) {
    const words = String(firstQuestionText).trim().split(/s+/);
    addQ(words.slice(0, 8).join(' '));
    if (words.length > 4) addQ(words.slice(0, 4).join(' '));
  }
  addQ(''); // fallback

  const seen = new Set();
  const candidates = [];
  for (const query of queries) {
    if (candidates.length >= 10) break; // riittavasti
    const url = 'https://create.kahoot.it/rest/kahoots/?query=' + encodeURIComponent(query) + '&limit=50&orderBy=relevance&includeKahoot=false';
    let entities = [];
    try {
      const data = await httpGetJson(url, 10000);
      entities = (data && data.entities) ? data.entities : [];
    } catch (e) { continue; }
    // suodata card-tasolla ensin (nopeampi)
    const uuids = [];
    for (const ent of entities) {
      const card = ent.card || ent;
      const uuid = card.uuid;
      if (!uuid || seen.has(uuid)) continue;
      seen.add(uuid);
      // jos card kertoo kysymysmäärän, käytä sitä
      const noq = card.number_of_questions || card.numberOfQuestions;
      if (noq && Number(noq) !== questionCount) continue;
      uuids.push(uuid);
      if (uuids.length >= 60) break;
    }
    // hae rinnakkain pienissä erissä
    for (let i = 0; i < uuids.length; i += 10) {
      const batch = uuids.slice(i, i + 10);
      const results = await Promise.all(batch.map(u => fetchAnswers(u).then(q => ({ u, q })).catch(() => null)));
      for (const r of results) {
        if (!r || !r.q || !Array.isArray(r.q)) continue;
        const quiz = r.q;
        if (quiz.length !== questionCount) continue;
        // rakennevertailu: vaihtoehtomäärät
        if (hints.choiceCounts && hints.choiceCounts.length === questionCount) {
          let structOk = true;
          for (let qi = 0; qi < hints.choiceCounts.length; qi++) {
            const cc = (quiz[qi] && quiz[qi].choices) ? quiz[qi].choices.length : 0;
            if (hints.choiceCounts[qi] && cc !== hints.choiceCounts[qi]) { structOk = false; break; }
          }
          if (!structOk) continue;
        }
        // Q1 tarkistus jos tiedossa
        if (firstCorrect != null && firstChoiceCount) {
          if (!matchQ(quiz, 0, firstChoiceCount, firstCorrect)) continue;
        }
        quiz.__uuid = r.u;
        candidates.push(quiz);
        if (candidates.length >= 10) break;
      }
      if (candidates.length >= 10) break;
    }
  }

  if (candidates.length > 0) {
    const mem2 = loadMemory();
    if (candidates[0].__uuid) {
      mem2[key] = candidates[0].__uuid;
      if (hints.choiceCounts && hints.choiceCounts.length) mem2[structKey] = candidates[0].__uuid;
      saveMemory(mem2);
      brainLearn({ fingerprintKey: key, uuid: candidates[0].__uuid, qCount: questionCount, quiz: candidates[0], title: hints.title });
      if (hints.choiceCounts && hints.choiceCounts.length) brainLearn({ fingerprintKey: structKey, uuid: candidates[0].__uuid, qCount: questionCount });
      console.log(color('  [+] Opittu brain.jsoniin (' + candidates[0].__uuid + ')', 'green'));
    }
  }
  return candidates;
}

function matchQ(quiz, idx, choiceCount, correct) {
  const q = quiz[idx];
  if (!q || !Array.isArray(q.choices)) return false;
  if (choiceCount && q.choices.length !== choiceCount) return false;
  const idxs = q.choices.map((c, i) => (c && c.correct) ? i : -1).filter(i => i >= 0);
  if (idxs.length === 0) return false;
  const norm = (idxs.length === 1) ? idxs[0] : idxs;
  const want = (Array.isArray(correct) && correct.length === 1) ? correct[0] : correct;
  if (Array.isArray(norm) && Array.isArray(want)) return JSON.stringify(norm) === JSON.stringify(want);
  return norm === want;
}

const MEMORY_FILE = path.join(os.homedir(), '.jzkahoot_memory.json');
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMemory(mem) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem)); } catch (e) {}
}
function memKey(questionCount, firstChoiceCount, firstCorrect) {
  return questionCount + ':' + firstChoiceCount + ':' + JSON.stringify(firstCorrect);
}

// ---------- BRAIN (oppiva muisti / brain.json) ----------
const BRAIN_FILE = path.join(__dirname, 'brain.json');
function loadBrain() {
  try { return JSON.parse(fs.readFileSync(BRAIN_FILE, 'utf8')); } catch (e) {}
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.jzkahoot_brain.json'), 'utf8')); } catch (e) {}
  return { version: 1, fingerprints: {}, quizzes: {}, games: {}, questions: [], stats: { learned: 0 } };
}
function saveBrain(brain) {
  try {
    brain.updated = new Date().toISOString();
    const data = JSON.stringify(brain, null, 2);
    try { fs.writeFileSync(BRAIN_FILE, data); } catch (e) {}
    try { fs.writeFileSync(path.join(os.homedir(), '.jzkahoot_brain.json'), data); } catch (e) {}
  } catch (e) {}
}
const _brain = loadBrain();
function brainLearn(obj) {
  try {
    if (obj.fingerprintKey && obj.uuid) _brain.fingerprints[obj.fingerprintKey] = { uuid: obj.uuid, qCount: obj.qCount, at: Date.now() };
    if (obj.uuid && obj.quiz) _brain.quizzes[obj.uuid] = { questions: obj.quiz, title: obj.title || null, at: Date.now() };
    if (obj.pin && obj.session) {
      _brain.games[obj.pin] = Object.assign(_brain.games[obj.pin] || {}, obj.session, { at: Date.now() });
    }
    if (obj.question) {
      _brain.questions.push(Object.assign({ at: Date.now() }, obj.question));
      if (_brain.questions.length > 500) _brain.questions = _brain.questions.slice(-500);
    }
    _brain.stats.learned = (_brain.stats.learned || 0) + 1;
    saveBrain(_brain);
  } catch (e) {}
}

function computeAnswer(qData, mode, choiceCount) {
  const qType = qData ? (qData.type || '') : '';
  let know = false;
  let correctAnswer = null;
  let wrong = false;
  if (qData) {
    if (qType === 'open_ended' || qType === 'word_cloud') {
      const c = (Array.isArray(qData.choices) ? (qData.choices.find(x => x.correct) || qData.choices[0]) : null);
      if (c) { know = true; correctAnswer = c.answer; }
    } else if (qType === 'jumble') {
      know = true; correctAnswer = [0, 1, 2, 3];
    } else if (Array.isArray(qData.choices)) {
      const idxs = qData.choices.map((c, i) => (c && c.correct) ? i : -1).filter(i => i >= 0);
      if (idxs.length > 0) {
        know = true;
        correctAnswer = (qType === 'multiple_select_quiz') ? idxs : idxs[0];
      }
    }
  }
  let answerToSend;
  if (know) {
    if (mode === '2' && qType === 'quiz' && Math.random() < 0.1) {
      answerToSend = Math.floor(Math.random() * choiceCount);
      if (typeof correctAnswer === 'number' && answerToSend === correctAnswer && choiceCount > 1) {
        answerToSend = (correctAnswer + 1) % choiceCount;
      }
      wrong = true;
    } else {
      answerToSend = correctAnswer;
    }
  } else {
    answerToSend = (qType === 'jumble') ? [0, 1, 2, 3] : Math.floor(Math.random() * choiceCount);
  }
  return { answerToSend, know, wrong };
}

function banner() {
  try { if (process.stdout.isTTY) console.clear(); } catch (e) {}
  console.log(color('   __  _  ______  _  __  ___   ___  __  __  ___  ___ ', 'cyan'));
  console.log(color('  (_  ( \\(  __  )( \\/  )/ __) / __)(  )(  )/ __)/ __)', 'cyan'));
  console.log(color('   /  / \\ ) (  ) )    (\\__ \\( (__  )(__)( \\__ \\\\__ \\', 'cyan'));
  console.log(color('  (__) (__(____/ )_/\\_( (___/ \\___)(______)(___/( (___', 'cyan'));
  console.log(color('        JZ KAHOOT BOT  -  V3.5  -  TERMUX', 'magenta'));
  console.log(color('  Auto+Flooder+Leaver | Shift+Q=sulje | 3=leaver kesken', 'gray'));
  console.log('');
}

// ---------- Mirror UI (pieni ikkuna Chromessa) ----------
const mirrorState = { status: 'idle', mode: '', pin: '', question: '', choices: [], selected: null, correct: null, qi: 0, bots: 0, joined: 0 };
function startMirror(port) {
  port = port || 8080;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JZ Kahoot Peili</title><style>body{font-family:system-ui,Arial;background:#0b0f1a;color:#e6e6e6;margin:0;padding:12px}h1{color:#00e5ff;font-size:18px;margin:0 0 8px}.card{background:#151b2e;border:1px solid #2a3355;border-radius:10px;padding:12px;margin:8px 0}.q{font-size:16px;font-weight:700;margin:6px 0}.choice{padding:8px 10px;margin:4px 0;border-radius:8px;background:#1f2742;border:1px solid #334}.sel{background:#00c853;border-color:#00e676;color:#000;font-weight:700}.correct{background:#2962ff;border-color:#448aff;color:#fff;font-weight:700}.meta{color:#9aa;font-size:12px}.status{color:#ffab00}</style></head><body><h1>JZ Kahoot Peili</h1><div class="meta">Tila: <span id="status" class="status">-</span> | Mode: <span id="mode">-</span> | PIN: <span id="pin">-</span></div><div class="card"><div class="q" id="q">Odotetaan...</div><div id="choices"></div></div><div class="meta" id="sel">Valittu: -</div><div class="meta" id="corr">Oikeat: -</div><script>async function tick(){try{const r=await fetch('/state');const d=await r.json();document.getElementById('status').textContent=d.status;document.getElementById('mode').textContent=d.mode;document.getElementById('pin').textContent=d.pin;document.getElementById('q').textContent=d.question||'Odotetaan...';const c=document.getElementById('choices');c.innerHTML='';(d.choices||[]).forEach((x,i)=>{let cls='choice';if(Array.isArray(d.selected)&&d.selected.includes(i))cls+=' sel';else if(d.selected===i)cls+=' sel';if(Array.isArray(d.correct)&&d.correct.includes(i))cls+=' correct';const div=document.createElement('div');div.className=cls;div.textContent=i+': '+x; c.appendChild(div);});document.getElementById('sel').textContent='Valittu: '+(Array.isArray(d.selected)?d.selected.join(','):(d.selected===null?'-':d.selected));document.getElementById('corr').textContent='Oikeat: '+(Array.isArray(d.correct)?d.correct.join(','):(d.correct===null?'-':d.correct));}catch(e){}}setInterval(tick,500);tick();</script></body></html>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
    else if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(mirrorState)); }
    else { res.writeHead(404); res.end(); }
  });
function startMirror(port) {
  port = port || 8080;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JZ Kahoot Peili</title><style>body{font-family:system-ui,Arial;background:#0b0f1a;color:#e6e6e6;margin:0;padding:12px}h1{color:#00e5ff;font-size:18px;margin:0 0 8px}.card{background:#151b2e;border:1px solid #2a3355;border-radius:10px;padding:12px;margin:8px 0}.q{font-size:16px;font-weight:700;margin:6px 0}.choice{padding:8px 10px;margin:4px 0;border-radius:8px;background:#1f2742;border:1px solid #334}.sel{background:#00c853;border-color:#00e676;color:#000;font-weight:700}.correct{background:#2962ff;border-color:#448aff;color:#fff;font-weight:700}.meta{color:#9aa;font-size:12px}.status{color:#ffab00}</style></head><body><h1>JZ Kahoot Peili</h1><div class="meta">Tila: <span id="status" class="status">-</span> | Mode: <span id="mode">-</span> | PIN: <span id="pin">-</span></div><div class="card"><div class="q" id="q">Odotetaan...</div><div id="choices"></div></div><div class="meta" id="sel">Valittu: -</div><div class="meta" id="corr">Oikeat: -</div><script>async function tick(){try{const r=await fetch('/state');const d=await r.json();document.getElementById('status').textContent=d.status;document.getElementById('mode').textContent=d.mode;document.getElementById('pin').textContent=d.pin;document.getElementById('q').textContent=d.question||'Odotetaan...';const c=document.getElementById('choices');c.innerHTML='';(d.choices||[]).forEach((x,i)=>{let cls='choice';if(Array.isArray(d.selected)&&d.selected.includes(i))cls+=' sel';else if(d.selected===i)cls+=' sel';if(Array.isArray(d.correct)&&d.correct.includes(i))cls+=' correct';const div=document.createElement('div');div.className=cls;div.textContent=i+': '+x; c.appendChild(div);});document.getElementById('sel').textContent='Valittu: '+(Array.isArray(d.selected)?d.selected.join(','):(d.selected===null?'-':d.selected));document.getElementById('corr').textContent='Oikeat: '+(Array.isArray(d.correct)?d.correct.join(','):(d.correct===null?'-':d.correct));}catch(e){}}setInterval(tick,500);tick();</script></body></html>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
    else if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(mirrorState)); }
    else { res.writeHead(404); res.end(); }
  });
  function tryListen(p) {
    srv.listen(p, () => {
      const url = `http://localhost:${p}`;
      console.log(color(`  [UI] Peili (avaa Chromessa): ${url}`, 'cyan'));
      try { require('child_process').exec('termux-open-url ' + url); } catch (e) {}
      try { require('child_process').exec('am start -a android.intent.action.VIEW -d ' + url); } catch (e) {}
    });
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE') tryListen(p + 1);
    });
  }
  tryListen(port);
  return srv;
}
}

// ---------- Auto Answer ----------
async function runAutoAnswer() {
  console.log(color('  [ AUTO ANSWER BOT ]', 'bold'));
  const name = (await ask('  Botin nimi: ') || 'JZBot').trim();
  let mode = (await ask('  Mode (1=RAGE, 2=non-suspicious): ')).trim();
  if (mode !== '1' && mode !== '2') mode = '2';
  const pin = (await ask('  Kahoot PIN: ') || '').trim();

  closePrompts();
  enableRawExit();
  mirrorState.status = 'starting';
  mirrorState.mode = mode;
  mirrorState.pin = pin;
  startMirror(8080);

  const Kahoot = require('kahoot.js-latest');

  let answerKey = null;
  let quizUuid = null;
  let publicCandidates = [];
  let candidatePos = 0;
  let firstQuestionText = null;

  const client = new Kahoot();
  registerClient(client);

  // challenge-tilassa...
  try {
    client.defaults.options.ChallengeWaitForInput = true;
    client.defaults.options.ChallengeAutoContinue = true;
  } catch (e) {}

  let leakedTitle = null;
  let leakedHost = null;
  const origMessage = client._message.bind(client);
  client._message = function (msg) {
    try {
      const parsed = JSON.parse(msg);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of arr) {
        // capture question/title text if present in any content
        try {
          if (m && m.data && m.data.content) {
            const c = JSON.parse(m.data.content);
            if (c && (c.title || c.question) && (c.questionIndex === 0 || !firstQuestionText)) {
              if (!firstQuestionText) firstQuestionText = c.title || c.question;
            }
            if (c && c.quizTitle && !leakedTitle) leakedTitle = c.quizTitle;
            if (c && c.hostId && !leakedHost) leakedHost = c.hostId;
          }
        } catch (e) {}
        const meta = extractMeta(m);
        if (meta.titles.length && !leakedTitle) leakedTitle = meta.titles[0];
        if (meta.hosts.length && !leakedHost) leakedHost = meta.hosts[0];
        for (const u of meta.uuids) {
          if (quizUuid) continue;
          // try fetching; validate against quizQuestionAnswers length when known
          fetchAnswers(u).then(k => {
            if (!k || !Array.isArray(k)) return;
            const expected = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers.length : null;
            if (expected && k.length !== expected) return;
            if (!answerKey) {
              quizUuid = u;
              answerKey = k;
              console.log(color(`  [+] Nuuskittu UUID (${u}) - vastaukset ladattu (${k.length})`, 'green'));
            }
          }).catch(() => {});
        }
      }
    } catch (e) {}
    return origMessage(msg);
  };

  client.on('Joined', (settings) => {
    console.log(color('  [+] Liitytty peliin. Odotetaan aloitusta...', 'green'));
    mirrorState.status = 'joined'; try { brainLearn({ pin: pin, session: { mode: 'auto', name: name, joined: true } }); } catch(e) {}
    // harvest leaked metadata from session/settings
    try {
      const meta = extractMeta(settings);
      if (meta.titles.length && !leakedTitle) leakedTitle = meta.titles[0];
      if (meta.hosts.length && !leakedHost) leakedHost = meta.hosts[0];
      for (const u of meta.uuids) {
        if (quizUuid || answerKey) continue;
        fetchAnswers(u).then(k => {
          if (k && Array.isArray(k) && !answerKey) { quizUuid = u; answerKey = k; console.log(color(`  [+] Metadatasta UUID (${u}) - vastaukset (${k.length})`, 'green')); }
        }).catch(() => {});
      }
    } catch (e) {}
    if (client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Challenge: vastaukset ladattu (${answerKey.length} kysymysta)`, 'green'));
    }
  });

  let structCandidates = null; // rakenne-esisuodatus
  client.on('QuizStart', (quiz) => {
    console.log(color('  [*] Quiz alkoi.', 'cyan'));
    mirrorState.status = 'quiz';
    // vuotanut metadata
    try {
      const meta = extractMeta(quiz);
      if (meta.titles.length && !leakedTitle) leakedTitle = meta.titles[0];
      for (const u of meta.uuids) {
        if (quizUuid || answerKey) continue;
        fetchAnswers(u).then(k => { if (k && !answerKey) { quizUuid = u; answerKey = k; console.log(color(`  [+] QuizStart UUID (${u})`, 'green')); } }).catch(()=>{});
      }
    } catch (e) {}
    if ((!answerKey) && client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Vastaukset ladattu challenge-datasta (${answerKey.length})`, 'green'));
    }
    // rakenne-esihaku taustalla (nopeuttaa Q1 jälkeen)
    if (!answerKey && !structCandidates && Array.isArray(quiz.quizQuestionAnswers)) {
      structCandidates = prefetchByStructure(quiz.quizQuestionAnswers, leakedTitle, leakedHost);
    }
  });

  async function prefetchByStructure(choiceCounts, title, host) {
    const qCount = choiceCounts.length;
    const queries = [];
    if (title) queries.push(title);
    if (host) queries.push(host);
    if (!queries.length) return [];
    const seen = new Set();
    const found = [];
    for (const query of queries) {
      if (found.length >= 30) break;
      try {
        const data = await httpGetJson('https://create.kahoot.it/rest/kahoots/?query=' + encodeURIComponent(query) + '&limit=40&orderBy=relevance', 8000);
        const entities = (data && data.entities) ? data.entities : [];
        const uuids = [];
        for (const ent of entities) {
          const card = ent.card || ent;
          const uuid = card.uuid;
          if (!uuid || seen.has(uuid)) continue;
          const noq = card.number_of_questions || card.numberOfQuestions;
          if (noq && Number(noq) !== qCount) continue;
          seen.add(uuid); uuids.push(uuid);
        }
        for (let i = 0; i < uuids.length; i += 12) {
          const batch = uuids.slice(i, i + 12);
          const res = await Promise.all(batch.map(u => fetchAnswers(u).then(q => ({u,q})).catch(()=>null)));
          for (const r of res) {
            if (!r || !r.q || r.q.length !== qCount) continue;
            let ok = true;
            for (let qi = 0; qi < choiceCounts.length; qi++) {
              const cc = (r.q[qi] && r.q[qi].choices) ? r.q[qi].choices.length : 0;
              if (choiceCounts[qi] && cc !== choiceCounts[qi]) { ok = false; break; }
            }
            if (ok) { r.q.__uuid = r.u; found.push(r.q); }
          }
        }
      } catch (e) {}
    }
    return found;
  }

  let qIndex = 0;
  client.on('QuestionStart', async (question) => {
    const qi = (typeof question.questionIndex === 'number') ? question.questionIndex : qIndex;
    qIndex = qi;
    if (qi === 0) firstQuestionText = question.title || question.question || question.text || firstQuestionText;
    console.log(color(`\\n  [!] Kysymys ${qi + 1} alkoi`, 'yellow'));

    let choiceCount = 4;
    if (Array.isArray(question.choices)) choiceCount = question.choices.length;
    else if (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) choiceCount = client.quiz.quizQuestionAnswers[qi] || choiceCount;
    else if (Array.isArray(question.quizQuestionAnswers)) choiceCount = question.quizQuestionAnswers[qi] || choiceCount;

    const qData = (Array.isArray(answerKey) ? answerKey[qi] : null);
    if (!qData && Array.isArray(question.choices) && question.choices.some(c => c && c.correct)) {
      // Kahoot vuosi oikeat vastaukset kysymyksen mukana
      answerKey = [question];
    }
    const qData2 = (Array.isArray(answerKey) ? answerKey[qi] : null);
    let answerToSend;
    let know = false;
    let wrong = false;
    const r = computeAnswer(qData2, mode, choiceCount);
    answerToSend = r.answerToSend; know = r.know; wrong = r.wrong;
    if (wrong) console.log(color('  [*] Legit: tahallinen virhe', 'gray'));
    else if (know) console.log(color('  [*] Vastataan oikein', 'gray'));
    else console.log(color('  [*] Vastausta ei tiedeta, arvataan', 'gray'));

    let delay = 1000;
    if (mode === '1') delay = 300 + Math.floor(Math.random() * 500);
    else delay = 900 + Math.floor(Math.random() * 300);

    // peili-päivitys
    try {
      mirrorState.status = 'question';
      mirrorState.question = (qData2 && (qData2.question || qData2.title)) || `Kysymys ${qi + 1}`;
      mirrorState.choices = Array.isArray(qData2 && qData2.choices) ? qData2.choices.map(c => c.answer || '') : Array.from({length: choiceCount}, (_,i)=>`Vaihtoehto ${i}`);
      mirrorState.selected = null;
      mirrorState.correct = null;
      mirrorState.questionIndex = qi;
    } catch (e) {}

    setTimeout(() => {
      try {
        console.log(color(`  [+] Lahetetaan vastaus: ${Array.isArray(answerToSend) ? answerToSend.join(',') : answerToSend} (viive ${delay}ms)`, 'green'));
        mirrorState.selected = answerToSend;
        question.answer(answerToSend);
      } catch (e) {
        try { client.answer(answerToSend); } catch (e2) {}
      }
      qIndex++;
    }, delay);
  });

  client.on('QuestionEnd', async (qe) => {
    mirrorState.status = 'questionEnd';
    const idx = Math.max(0, qIndex - 1);
    const correct = Array.isArray(qe.correctChoices) ? qe.correctChoices : null;
    if (correct) {
      mirrorState.correct = correct;
      console.log(color(`  [+] Oikeat vastaukset kysymykseen ${idx + 1}: ${correct.join(',')}`, 'green'));
      if (!Array.isArray(answerKey)) answerKey = [];
      const q = answerKey[idx] || { type: qe.type, choices: [] };
      if (!Array.isArray(q.choices)) q.choices = [];
      const n = Math.max(q.choices.length, (mirrorState.choices && mirrorState.choices.length) || 0, correct.reduce((a,b)=>Math.max(a,b+1),0));
      while (q.choices.length < n) q.choices.push({ answer: '', correct: false });
      correct.forEach(i => { if (q.choices[i]) q.choices[i].correct = true; });
      q.question = mirrorState.question || q.question;
      answerKey[idx] = q;
      // opi brainiin
      try { brainLearn({ question: { pin: mirrorState.pin, qi: idx, correct, choiceCount: n, text: mirrorState.question } }); } catch (e) {}

      // Sormenjälkihaku julkisista pohjista (vain ensimmäisen kysymyksen jälkeen)
      if (idx === 0) {
        const qCount = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers.length : (answerKey.length || 1);
        const firstChoiceCount = (mirrorState.choices && mirrorState.choices.length) || correct.reduce((a,b)=>Math.max(a,b+1),0);
        const firstCorrect = (correct.length === 1) ? correct[0] : correct;
        const hints = {
          title: leakedTitle,
          host: leakedHost,
          choiceCounts: (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers : null
        };
        console.log(color('  [*] Sormenjälkihaku (metadata + rakenne + QuestionEnd)...', 'gray'));
        if (hints.title) console.log(color('  [*] Vuotanut title: ' + hints.title, 'gray'));
        if (hints.host) console.log(color('  [*] Vuotanut host/creator: ' + hints.host, 'gray'));
        let matches = [];
        // 1) rakenne-esiehdokkaat (nopea)
        try {
          const pre = structCandidates ? await Promise.race([structCandidates, sleep(2).then(()=>[])]) : [];
          if (Array.isArray(pre) && pre.length) {
            matches = pre.filter(c => matchQ(c, 0, firstChoiceCount, firstCorrect));
            if (matches.length) console.log(color('  [+] Rakenne-esihaku osui: ' + matches.length + ' ehdokasta', 'green'));
          }
        } catch (e) {}
        // 2) taydennys haulla
        if (matches.length === 0) {
          matches = await findPublicMatches(qCount, firstChoiceCount, firstCorrect, firstQuestionText, hints);
        } else {
          // hae lisaa taustalla mutta ala odota pitkään
          findPublicMatches(qCount, firstChoiceCount, firstCorrect, firstQuestionText, hints).then(extra => {
            if (Array.isArray(extra) && extra.length > publicCandidates.length) {
              publicCandidates = extra;
              console.log(color('  [+] Lisäehdokkaita hausta: ' + extra.length, 'green'));
            }
          }).catch(()=>{});
        }
        publicCandidates = matches;
        candidatePos = 0;
        if (matches.length > 0) {
          answerKey = matches[0];
          console.log(color(`  [+] Julkinen pohja loytyi! ${matches.length} matchia. Ladattu ${answerKey.length} kysymyksen vastaukset.`, 'green'));
        } else {
          console.log(color('  [-] Julkista pohjaa ei loytynyt. Vastaukset kerataan QuestionEndista (private).', 'gray'));
        }
      }

      // Tarkennus: jos toisen kysymyksen vastaus ei täsmää, kokeile seuraavaa matchia
      if (idx === 1 && Array.isArray(publicCandidates) && publicCandidates.length > 1) {
        const predicted = (Array.isArray(answerKey) && answerKey[1] && Array.isArray(answerKey[1].choices)) ? answerKey[1].choices.map((c,i)=>c.correct?i:-1).filter(i=>i>=0) : null;
        const actual = correct;
        let predictedNorm = (predicted && predicted.length === 1) ? predicted[0] : predicted;
        let actualNorm = (actual.length === 1) ? actual[0] : actual;
        if (predictedNorm !== null && JSON.stringify(predictedNorm) !== JSON.stringify(actualNorm)) {
          // etsi seuraava match, joka täsmää myös Q2
          let found = false;
          for (let i = candidatePos + 1; i < publicCandidates.length; i++) {
            const cand = publicCandidates[i];
            if (!cand || !cand[1] || !Array.isArray(cand[1].choices)) continue;
            const cIdxs = cand[1].choices.map((c, j) => (c && c.correct) ? j : -1).filter(j => j >= 0);
            const cNorm = (cIdxs.length === 1) ? cIdxs[0] : cIdxs;
            if (JSON.stringify(cNorm) === JSON.stringify(actualNorm)) {
              candidatePos = i;
              answerKey = cand;
              found = true;
              console.log(color(`  [+] Tarkennus: vaihdettu matchiin #${i + 1}.`, 'green'));
              break;
            }
          }
          if (!found) console.log(color('  [-] Tarkennus epaonnistui, kaytetaan nykyista.', 'gray'));
        }
      }
    }
  });
  client.on('QuizEnd', () => { mirrorState.status = 'ended'; console.log(color('  [+] Peli paattyi.', 'cyan')); try { brainLearn({ pin: pin, session: { ended: true, uuid: quizUuid || null } }); if (quizUuid && Array.isArray(answerKey)) brainLearn({ uuid: quizUuid, quiz: answerKey, title: leakedTitle }); } catch(e) {} });
  client.on('TwoFactorReset', () => { console.log(color('  [!] 2FA vaaditaan (hostin koodi) - botti ei voi vastata automaattisesti', 'yellow')); });
  client.on('Disconnect', (reason) => { console.log(color('  [-] Katkesi: ' + reason, 'red')); process.exit(0); });

  console.log(color(`  [*] Yhdistetaan peliin ${pin} nimella ${name}...`, 'cyan'));
  client.join(pin, name + '\u200B').catch(err => {
    console.log(color('  [-] Liittyminen epaonnistui: ' + (err.description || err), 'red'));
    process.exit(1);
  });
}

// ---------- Flooder ----------
async function runFlooder() {
  console.log(color('  [ FLOODER ]', 'bold'));
  const base = (await ask('  Bottien nimi (prefix): ') || 'JZBot').trim();
  const count = parseInt(await ask('  Kuinka monta bottia: '), 10) || 1;
  const pin = (await ask('  Kahoot PIN: ') || '').trim();

  closePrompts();
  enableRawExit();
  mirrorState.status = 'flooding';
  mirrorState.mode = 'flooder';
  mirrorState.pin = pin;
  mirrorState.bots = count;
  mirrorState.joined = 0;
  startMirror(8081);

  const Kahoot = require('kahoot.js-latest');

  let joined = 0, failed = 0;
  const tasks = [];
  for (let i = 1; i <= count; i++) {
    const name = `${base}${i}\u200B`;
    try {
      const res = Kahoot.join(pin, name);
      const client = res.client;
      const event = res.event;
      registerClient(client);
      const p = event.then(() => {
        joined++;
        mirrorState.joined = joined;
        console.log(color(`  [+] Bot ${i} liittyi (${joined}/${count})`, 'green'));
      }).catch((e) => {
        failed++;
        console.log(color(`  [-] Bot ${i} epaonnistui: ${e && e.description || e}`, 'red'));
        try { client.leave(); } catch (x) {}
      });
      tasks.push(p);
      client.on('Disconnect', (r) => {});
    } catch (e) {
      failed++;
      console.log(color(`  [-] Bot ${i} virhe: ${e && e.description || e}`, 'red'));
    }
    await sleep(0.15);
  }

  await Promise.allSettled(tasks);
  console.log(color(`  [*] Kaikki ${count} lahetetty. Liittyneet: ${joined}, epaonnistuneet: ${failed}`, 'cyan'));
  console.log(color('  [*] Paina Iso Q lopettaaksesi.', 'gray'));
}

// ---------- Leaver (botit poistuvat pelista) ----------
async function runLeaver() {
  console.log(color('  [ LEAVER ]', 'bold'));
  const base = (await ask('  Bottien nimi (prefix): ') || 'JZBot').trim();
  const count = parseInt(await ask('  Kuinka monta bottia: '), 10) || 1;
  const pin = (await ask('  Kahoot PIN: ') || '').trim();
  const delaySec = parseInt(await ask('  Poistumisviive (sek, 0=heti): '), 10) || 0;

  closePrompts();
  enableRawExit();
  mirrorState.status = 'leaving';
  mirrorState.mode = 'leaver';
  mirrorState.pin = pin;
  mirrorState.bots = count;
  mirrorState.joined = 0;
  startMirror(8082);

  const Kahoot = require('kahoot.js-latest');
  console.log(color(`  [*] Liitetaan ${count} bottia ja poistetaan ${delaySec}s kuluttua...`, 'cyan'));

  let joined = 0, failed = 0;
  const clients2 = [];
  for (let i = 1; i <= count; i++) {
    const name = `${base}${i}\u200B`;
    try {
      const res = Kahoot.join(pin, name);
      const client = res.client;
      const event = res.event;
      registerClient(client);
      clients2.push(client);
      event.then(() => {
        joined++;
        mirrorState.joined = joined;
        console.log(color(`  [+] Bot ${i} liittyi (${joined}/${count})`, 'green'));
      }).catch((e) => {
        failed++;
        console.log(color(`  [-] Bot ${i} epaonnistui: ${e && e.description || e}`, 'red'));
      });
    } catch (e) {
      failed++;
      console.log(color(`  [-] Bot ${i} virhe: ${e && e.description || e}`, 'red'));
    }
    await sleep(0.15);
  }

  await sleep(delaySec);
  console.log(color('  [*] Poistetaan botit...', 'yellow'));
  for (const c of clients2) { try { c.leave(); } catch (e) {} }
  mirrorState.status = 'done';
  console.log(color(`  [+] Poistettu. Liittyneet: ${joined}, epaonnistuneet: ${failed}`, 'green'));
  console.log(color('  [*] Paina Iso Q lopettaaksesi.', 'gray'));
}

// ---------- Main ----------
async function runSelfTest() {
  console.log(color('  [ SELF-TEST ]', 'bold'));
  const mockKey = [
    { type: 'quiz', question: 'Paa', choices: [{ answer: 'a', correct: false }, { answer: 'b', correct: true }] },
    { type: 'multiple_select_quiz', question: 'Par', choices: [{ answer: '2', correct: true }, { answer: '3', correct: false }, { answer: '4', correct: true }] },
    { type: 'open_ended', question: '2+2', choices: [{ answer: '4', correct: true }] },
    { type: 'jumble', question: 'Jar', choices: [{ answer: 'A' }, { answer: 'B' }] }
  ];
  for (const mode of ['1', '2']) {
    console.log(color(`  Mode ${mode}`, 'cyan'));
    for (let qi = 0; qi < mockKey.length; qi++) {
      const qData = mockKey[qi];
      const choiceCount = Array.isArray(qData.choices) ? qData.choices.length : 4;
      const { answerToSend, know, wrong } = computeAnswer(qData, mode, choiceCount);
      console.log(`    Q${qi + 1} ${qData.type}: ${Array.isArray(answerToSend) ? answerToSend.join(',') : answerToSend} ${know ? (wrong ? '(tahallinen virhe)' : '(oikein)') : '(arvaus)'}`);
    }
  }
  // simulate QuestionEnd collection
  const answerKey = [];
  const qe = { type: 'quiz', correctChoices: [1] };
  const idx = 0;
  const q = answerKey[idx] || { type: qe.type, choices: [] };
  if (!Array.isArray(q.choices)) q.choices = [];
  const n = Math.max(q.choices.length, 2);
  while (q.choices.length < n) q.choices.push({ answer: '', correct: false });
  qe.correctChoices.forEach(i => { if (q.choices[i]) q.choices[i].correct = true; });
  answerKey[idx] = q;
  const { answerToSend } = computeAnswer(answerKey[0], '1', 2);
  console.log(color(`  Collection test: ${answerToSend} (odotettu 1)`, answerToSend === 1 ? 'green' : 'red'));
  console.log(color('  Self-test valmis.', 'green'));
}

async function main() {
  if (process.argv.includes('--test')) {
    banner();
    await runSelfTest();
    process.exit(0);
  }
  banner();
  console.log(color('  Valitse toiminto:', 'bold'));
  let choice = '';
  while (choice !== '1' && choice !== '2') {
    console.log(color('  1 = Auto Answer Bot', 'green'));
    console.log(color('  2 = Flooder / Crasher', 'red'));
    console.log(color('  3 = Leaver (botit poistuvat)', 'yellow'));
    console.log('');
    choice = (await ask('  Valinta (1/2/3): ')).trim();
    if (choice !== '1' && choice !== '2' && choice !== '3') {
      console.log(color('  Virheellinen valinta, yrita uudelleen.', 'red'));
    }
  }
  if (choice === '1') await runAutoAnswer();
  else if (choice === '2') await runFlooder();
  else if (choice === '3') await runLeaver();

  setInterval(() => {}, 60000);
}

process.on('uncaughtException', (e) => { console.error(color('  [!] Virhe: ' + (e && e.message || e), 'red')); });
process.on('unhandledRejection', (e) => { console.error(color('  [!] Lupausvirhe: ' + (e && e.message || e), 'red')); });

main().catch(e => { console.error(e); process.exit(1); });
