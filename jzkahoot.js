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
    if (str === 'Q') exitAll();
    if (key && key.ctrl && key.name === 'c') exitAll();
  });
}

// ---------- exit handling ----------
let exiting = false;
const clients = [];
function registerClient(c) { if (c) clients.push(c); }
function exitAll() {
  if (exiting) return;
  exiting = true;
  console.log('\n' + color('  [!] Iso Q - suljetaan JZ Kahoot...', 'yellow'));
  for (const c of clients) { try { c.leave(); } catch (e) {} }
  setTimeout(() => process.exit(0), 300);
}

// ---------- helpers ----------
function findUuids(obj, out, key) {
  out = out || [];
  if (typeof obj === 'string') {
    const m = obj.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (m && out.indexOf(m[0]) === -1) out.push(m[0]);
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((x) => findUuids(x, out));
    return out;
  }
  for (const k of Object.keys(obj)) findUuids(obj[k], out);
  return out;
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

async function findPublicMatches(questionCount, firstChoiceCount, firstCorrect, firstQuestionText) {
  // Muisti: tarkista cache
  const mem = loadMemory();
  const key = memKey(questionCount, firstChoiceCount, firstCorrect);
  if (mem[key]) {
    const cached = await fetchAnswers(mem[key]);
    if (cached && Array.isArray(cached) && cached.length === questionCount) {
      console.log(color('  [+] Muistista: julkinen pohja loytyi cache:sta.', 'green'));
      return [cached];
    }
  }

  // Sormenjälkihaku: etsi julkiset quizit, jolla sama kysymysmäärä ja ensimmäinen kysymys
  const matches = [];
  const queries = [];
  if (firstQuestionText) {
    const words = String(firstQuestionText).trim().split(/\s+/);
    queries.push(words.slice(0, 6).join(' '));
    if (words.length > 3) queries.push(words.slice(0, 3).join(' '));
  }
  queries.push(''); // fallback: kaikki
  const seen = new Set();
  for (const query of queries) {
    const url = 'https://create.kahoot.it/rest/kahoots/?query=' + encodeURIComponent(query) + '&limit=50&orderBy=relevance';
    try {
      const data = await httpGetJson(url, 10000);
      const entities = (data && data.entities) ? data.entities : [];
      for (const ent of entities) {
        const uuid = ent.card && ent.card.uuid;
        if (!uuid || seen.has(uuid)) continue;
        seen.add(uuid);
        const quiz = await fetchAnswers(uuid);
        if (!quiz || !Array.isArray(quiz) || quiz.length !== questionCount) continue;
        const q0 = quiz[0];
        if (!q0 || !Array.isArray(q0.choices)) continue;
        if (q0.choices.length !== firstChoiceCount) continue;
        const idxs = q0.choices.map((c, i) => (c && c.correct) ? i : -1).filter(i => i >= 0);
        if (idxs.length === 0) continue;
        const correct = (idxs.length === 1) ? idxs[0] : idxs;
        let match = false;
        if (Array.isArray(correct) && Array.isArray(firstCorrect)) {
          match = JSON.stringify(correct) === JSON.stringify(firstCorrect);
        } else {
          match = correct === firstCorrect;
        }
        if (match) {
          quiz.__uuid = uuid;
          matches.push(quiz);
        }
      }
    } catch (e) {}
  }

  // Tallenna muistiin
  if (matches.length > 0 && matches[0].__uuid) {
    const mem2 = loadMemory();
    mem2[key] = matches[0].__uuid;
    saveMemory(mem2);
  }
  return matches;
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
  console.log(color('  Auto Answer + Flooder + Leaver  |  Shift+Q = stop', 'gray'));
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
  let mode = (await ask('  Mode (1=RAGE, 2=non-suspicious, 3=GHOST 100% private): ')).trim();
  if (mode !== '1' && mode !== '2' && mode !== '3') mode = '2';
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

  // GHOST-tila: 4 apubottia painavat eri vastauksia -> 100% oikein private-peleissa
  const ghosts = [];
  const ghostResults = {}; // qi -> [bool|null,...]
  let ghostQIndex = 0;
  if (mode === '3') {
    const Kahoot = require('kahoot.js-latest');
    for (let g = 0; g < 4; g++) {
      const gname = 'G' + (g + 1) + Math.floor(Math.random() * 1000) + '\u200B';
      const gc = new Kahoot();
      registerClient(gc);
      const gIndex = g;
      gc.on('QuestionStart', (question) => {
        const qi = (typeof question.questionIndex === 'number') ? question.questionIndex : 0;
        ghostQIndex = qi;
        if (!ghostResults[qi]) ghostResults[qi] = [null, null, null, null];
        setTimeout(() => {
          try { question.answer(gIndex); } catch (e) { try { gc.answer(gIndex); } catch (e2) {} }
        }, 50 + Math.floor(Math.random() * 100));
      });
      gc.on('QuestionEnd', (qe) => {
        const key = ghostQIndex;
        if (!ghostResults[key]) ghostResults[key] = [null, null, null, null];
        ghostResults[key][gIndex] = !!qe.isCorrect;
      });
      ghosts.push(gc);
      gc.join(pin, gname).catch(() => {});
    }
  }

  // challenge-tilassa...
  try {
    client.defaults.options.ChallengeWaitForInput = true;
    client.defaults.options.ChallengeAutoContinue = true;
  } catch (e) {}

  const origMessage = client._message.bind(client);
  client._message = function (msg) {
    try {
      const parsed = JSON.parse(msg);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const m of arr) {
        const found = findUuids(m);
        for (const u of found) {
          if (!quizUuid) {
            quizUuid = u;
            fetchAnswers(u).then(k => {
              const ok = k && (!client.quiz || !Array.isArray(client.quiz.quizQuestionAnswers) || k.length === client.quiz.quizQuestionAnswers.length);
              if (ok) { answerKey = k; console.log(color(`  [+] Nuuskittiin UUID (${u}) - vastaukset ladattu (${k.length})`, 'green')); }
            }).catch(() => {});
          }
        }
      }
    } catch (e) {}
    return origMessage(msg);
  };

  client.on('Joined', (settings) => {
    console.log(color('  [+] Liitytty peliin. Odotetaan aloitusta...', 'green'));
    mirrorState.status = 'joined';
    if (client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Challenge: vastaukset ladattu (${answerKey.length} kysymysta)`, 'green'));
    }
  });

  client.on('QuizStart', (quiz) => {
    console.log(color('  [*] Quiz alkoi.', 'cyan'));
    mirrorState.status = 'quiz';
    if ((!answerKey) && client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Vastaukset ladattu challenge-datasta (${answerKey.length})`, 'green'));
    }
  });

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
    if (mode === '3' && !qData2) {
      // GHOST: odotetaan apubottien tuloksia -> 100% oikea indeksi
      console.log(color('  [*] Ghost: odotetaan apubottien tuloksia...', 'gray'));
      const start = Date.now();
      while (Date.now() - start < 1500) {
        const res = ghostResults[qi];
        if (res && res.some(r => r === true)) {
          answerToSend = res.findIndex(r => r === true);
          know = true;
          break;
        }
        await sleep(0.05);
      }
      if (answerToSend === undefined) {
        const r = computeAnswer(qData2, mode, choiceCount);
        answerToSend = r.answerToSend; know = r.know; wrong = r.wrong;
      } else {
        console.log(color('  [*] Ghost: oikea vastaus loytyi (' + answerToSend + ')', 'green'));
      }
    } else {
      const r = computeAnswer(qData2, mode, choiceCount);
      answerToSend = r.answerToSend; know = r.know; wrong = r.wrong;
    }
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
      answerKey[idx] = q;

      // Sormenjälkihaku julkisista pohjista (vain ensimmäisen kysymyksen jälkeen)
      if (idx === 0) {
        const qCount = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers.length : (answerKey.length || 1);
        const firstChoiceCount = (mirrorState.choices && mirrorState.choices.length) || correct.reduce((a,b)=>Math.max(a,b+1),0);
        const firstCorrect = (correct.length === 1) ? correct[0] : correct;
        console.log(color('  [*] Sormenjälkihaku julkisista pohjista (1000+ vertailu)...', 'gray'));
        const matches = await findPublicMatches(qCount, firstChoiceCount, firstCorrect, firstQuestionText);
        publicCandidates = matches;
        candidatePos = 0;
        if (matches.length > 0) {
          answerKey = matches[0];
          console.log(color(`  [+] Julkinen pohja loytyi! ${matches.length} matchia. Ladattu ${answerKey.length} kysymyksen vastaukset.`, 'green'));
        } else {
          console.log(color('  [-] Julkista pohjaa ei loytynyt (private quiz).', 'gray'));
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
  client.on('QuizEnd', () => { mirrorState.status = 'ended'; console.log(color('  [+] Peli paattyi.', 'cyan')); });
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
  while (choice !== '1' && choice !== '2' && choice !== '3') {
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
