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
  process.on('SIGINT', () => exitAll());
  if (!process.stdin.isTTY) return;
  try { readline.emitKeypressEvents(process.stdin); } catch(e){}
  try { process.stdin.setRawMode(true); } catch (e) {}
  try { process.stdin.resume(); } catch(e){}
  process.stdin.removeAllListeners('keypress');
  process.stdin.removeAllListeners('data');
  const onKey = (str, key) => {
    const ch = String(str || '');
    const name = key && key.name;
    if (ch === 'Q' || ch === 'q' || name === 'q') { exitAll(); return; }
    if (ch === '3') { leaveAll('Leaver (3)'); return; }
    if (key && key.ctrl && (name === 'c' || name === 'q')) { exitAll(); return; }
  };
  process.stdin.on('keypress', onKey);
  // fallback for terminals where keypress is unreliable
  process.stdin.on('data', (buf) => {
    const b = String(buf || '');
    if (b.indexOf('Q') !== -1 || b.indexOf('q') !== -1) exitAll();
    else if (b.indexOf('3') !== -1) leaveAll('Leaver (3)');
    else if (b === '\u0003') exitAll();
  });
  console.log(color('  [*] Controls: Q = quit, 3 = leave bots' + (JZ_DEBUG?' (debug on)':''), 'gray'));
}

// ---------- exit handling ----------
let exiting = false;
const clients = [];
function registerClient(c) { if (c) clients.push(c); }
function leaveAll(reason) {
  console.log('\n' + color('  [!] ' + (reason || 'Leaver') + ' - removing all bots...', 'yellow'));
  for (const c of clients) { try { c.leave(); } catch (e) {} }
  try { mirrorState.status = 'left'; } catch (e) {}
  console.log(color('  [+] Bots removed. Shift+Q = quit.', 'green'));
}
function exitAll() {
  if (exiting) return;
  exiting = true;
  leaveAll('Shift+Q - quitting');
  setTimeout(() => process.exit(0), 400);
}

// ---------- helpers ----------
const JZ_DEBUG = !!process.env.JZ_DEBUG;
function dbg(...a){ if(JZ_DEBUG) try{ console.log(color('  [dbg] '+a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '),'gray')); }catch(e){} }
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

function normalizeQuizQuestions(data) {
  if (!data) return null;
  if (Array.isArray(data.questions)) return data.questions;
  if (data.kahoot && Array.isArray(data.kahoot.questions)) return data.kahoot.questions;
  if (data.challenge && data.kahoot && Array.isArray(data.kahoot.questions)) return data.kahoot.questions;
  if (Array.isArray(data.answers)) {
    // challenge answers/progress shape -> map to question-like objects with choices
    return data.answers.map((a, i) => {
      const choices = Array.isArray(a.answers) ? a.answers : (Array.isArray(a.choices) ? a.choices : []);
      return { question: a.question || ('Question ' + (i+1)), choices: choices.map(c => typeof c==='string'?{answer:c,correct:false}:{answer:c.answer||c.text||'', correct:!!c.correct, index:c.index}) };
    }).filter(q => q.choices && q.choices.length);
  }
  return null;
}
async function fetchAnswers(uuidOrRef) {
  if (!uuidOrRef) return null;
  const ref = String(uuidOrRef).trim();
  // challenge pin/id reference
  if (/^challenge:/i.test(ref)) {
    const cid = ref.replace(/^challenge:/i, '').trim();
    const urls = [
      `https://kahoot.it/rest/challenges/${encodeURIComponent(cid)}/answers`,
      `https://kahoot.it/rest/challenges/${encodeURIComponent(cid)}`,
      `https://kahoot.it/rest/challenges/pin/${encodeURIComponent(cid)}`,
    ];
    for (const u of urls) {
      try {
        const data = await httpGetJson(u, 9000);
        const q = normalizeQuizQuestions(data);
        if (q && q.length) return q;
        // some challenge payloads nest kahoot
        if (data && data.kahoot && Array.isArray(data.kahoot.questions)) return data.kahoot.questions;
        // if pin lookup returned challenge id info, try answers endpoint
        if (data && (data.challengeId || data.id || data.uuid)) {
          const id = data.challengeId || data.id || data.uuid;
          const q2 = await fetchAnswers('challenge:' + id);
          if (q2) return q2;
        }
      } catch (e) {}
    }
    return null;
  }
  const uuid = ref;
  const urls = [
    `https://create.kahoot.it/rest/kahoots/${uuid}`,
    `https://create.kahoot.it/rest/kahoots/${uuid}/card/?includeKahoot=true`,
    `https://kahoot.it/rest/kahoots/${uuid}`,
    `https://kahoot.it/rest/kahoots/${uuid}/card/?includeKahoot=true`,
    `https://play.kahoot.it/rest/kahoots/${uuid}`,
  ];
  for (const u of urls) {
    try {
      const data = await httpGetJson(u, 8000);
      const q = normalizeQuizQuestions(data);
      if (q && q.length) return q;
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


async function findPublicMatches(questionCount, firstChoiceCount, firstCorrect, firstQuestionText, hints) {
  hints = hints || {};
  // Brain/memory: check cache (fingerprint + Q1)
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
        console.log(color('  [+] Brain/memory hit: ' + brainUuid, 'green'));
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
      console.log(color('  [+] Learned to brain.json (' + candidates[0].__uuid + ')', 'green'));
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

// ---------- BRAIN (persistent learning / brain.json) ----------
const BRAIN_FILE = path.join(__dirname, 'brain.json');
function _readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function loadBrain() {
  const base = { version: 1, fingerprints: {}, quizzes: {}, games: {}, questions: [], stats: { learned: 0 } };
  for (const p of [path.join(__dirname, 'brain.json'), path.join(os.homedir(), '.jzkahoot_brain.json')]) {
    const b = _readJson(p);
    if (!b) continue;
    Object.assign(base.fingerprints, b.fingerprints || {});
    Object.assign(base.quizzes, b.quizzes || {});
    Object.assign(base.games, b.games || {});
    if (Array.isArray(b.questions)) base.questions = base.questions.concat(b.questions).slice(-500);
    base.stats.learned = Math.max(base.stats.learned || 0, (b.stats && b.stats.learned) || 0);
  }
  return base;
}
function saveBrain(brain) {
  try {
    brain.updated = new Date().toISOString();
    const data = JSON.stringify(brain, null, 2);
    for (const p of [path.join(__dirname, 'brain.json'), path.join(os.homedir(), '.jzkahoot_brain.json')]) {
      try { fs.writeFileSync(p, data); } catch (e) {}
    }
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
  console.log(color('  Auto+Flooder+Leaver | Shift+Q=quit | 3=leave bots mid-run', 'gray'));
  console.log('');
}

// ---------- Mirror UI overlay (Chrome/Termux) ----------
const mirrorState = { status: 'idle', mode: '', pin: '', question: '', choices: [], selected: null, correct: null, qi: 0, bots: 0, joined: 0, source: '', quizTitle: '', overlayUrl: '' };
let _mirrorSrv = null;
function startMirror(port) {
  if (_mirrorSrv) return _mirrorSrv; // singleton
  port = Number(port) || 8080;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>JZ Kahoot Overlay</title>
<style>
:root{--bg:#070b14;--card:#121a2b;--bd:#24304f;--tx:#e8eefc;--mut:#8ea0c7;--ok:#00c853;--blue:#448aff;--warn:#ffab00;--cyan:#00e5ff}
*{box-sizing:border-box} body{font-family:system-ui,-apple-system,Arial,sans-serif;background:var(--bg);color:var(--tx);margin:0;padding:8px;font-size:13px;max-width:420px}
h1{color:var(--cyan);font-size:16px;margin:0 0 6px;display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn);display:inline-block}
.meta{color:var(--mut);font-size:12px;margin:2px 0}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px;margin:8px 0}
.q{font-size:15px;font-weight:700;margin:4px 0 8px;line-height:1.25}
.choice{padding:9px 10px;margin:5px 0;border-radius:8px;background:#1a2340;border:1px solid var(--bd);display:flex;gap:8px;align-items:center}
.ci{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;background:#24304f;flex:0 0 22px}
.sel{border-color:var(--ok);box-shadow:0 0 0 1px var(--ok) inset}.sel .ci{background:var(--ok);color:#001a0a}
.correct{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue) inset}.correct .ci{background:var(--blue);color:#001033}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#1a2340;border:1px solid var(--bd)}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#log{max-height:160px;overflow:auto;font-size:12px;color:var(--mut);line-height:1.35;white-space:pre-wrap}
.logi{padding:2px 0;border-bottom:1px solid #162040}
</style></head><body>
<h1><span class="dot" id="dot"></span> JZ Kahoot Overlay</h1>
<div class="row meta"><span class="badge" id="status">idle</span><span>Mode: <b id="mode">-</b></span><span>PIN: <b id="pin">-</b></span><span>Q: <b id="qi">-</b></span></div>
<div class="card"><div class="meta" id="title" style="margin-bottom:2px"></div><div class="q" id="q">Waiting for game...</div><div id="choices"></div></div>
<div class="row meta"><span>Selected: <b id="sel">-</b></span><span>Correct: <b id="corr">-</b></span><span>Source: <b id="src">-</b></span><span>Bots: <b id="bots">-</b></span></div>
<div class="card"><div class="meta" style="margin-bottom:4px">Activity</div><div id="log"></div></div>
<script>
let lastSig='';
async function tick(){try{
 const r=await fetch('/state',{cache:'no-store'});const d=await r.json();
 document.getElementById('status').textContent=d.status||'-';
 document.getElementById('mode').textContent=d.mode||'-';
 document.getElementById('pin').textContent=d.pin||'-';
 document.getElementById('qi').textContent=(d.qi!=null&&d.status==='question')?(d.qi+1):'-';
 document.getElementById('q').textContent=d.question||'Waiting for game...'; document.getElementById('title').textContent=d.quizTitle?('Quiz: '+d.quizTitle):'';
 const dot=document.getElementById('dot'); dot.style.background=(d.status==='question'||d.status==='quiz'||d.status==='joined')?'var(--ok)':(d.status==='ended'||d.status==='left'||d.status==='done')?'#607d8b':'var(--warn)';
 const c=document.getElementById('choices'); c.innerHTML='';
 (d.choices||[]).forEach((x,i)=>{let cls='choice';const isSel=Array.isArray(d.selected)?d.selected.includes(i):(d.selected===i);
  const isCor=Array.isArray(d.correct)?d.correct.includes(i):(d.correct===i);
  if(isSel)cls+=' sel'; if(isCor)cls+=' correct';
  const div=document.createElement('div');div.className=cls;
  div.innerHTML='<span class="ci">'+i+'</span><span>'+String(x||('Option '+i))+'</span>'; c.appendChild(div);
 });
 const fmt=v=>Array.isArray(v)?v.join(','):(v===null||v===undefined?'-':v);
 document.getElementById('sel').textContent=fmt(d.selected);
 document.getElementById('corr').textContent=fmt(d.correct);
 document.getElementById('src').textContent=d.source||'-'; document.getElementById('bots').textContent=(d.bots? (d.joined||0)+'/'+d.bots : '-');
 const sig=(d.status||'')+'|'+(d.qi||'')+'|'+fmt(d.selected)+'|'+fmt(d.correct);
 if(sig!==lastSig&&d.status!=='idle'){lastSig=sig; const l=document.getElementById('log'); const it=document.createElement('div'); it.className='logi'; it.textContent=new Date().toLocaleTimeString()+'  '+(d.status||'')+'  Q'+((d.qi||0)+1)+'  sel:'+fmt(d.selected)+'  ok:'+fmt(d.correct); l.prepend(it); while(l.children.length>40) l.removeChild(l.lastChild);}
}catch(e){}}
setInterval(tick,450);tick();
</script></body></html>`;
  const srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); }
    else if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(mirrorState)); }
    else { res.writeHead(404); res.end('not found'); }
  });
  srv.on('error', () => {}); // handled per attempt
  function tryListen(p, tries) {
    if (tries > 20) { console.log(color('  [UI] Overlay: could not bind a port', 'yellow')); return; }
    srv.removeAllListeners('error');
    srv.once('error', (e) => { if (e && e.code === 'EADDRINUSE') tryListen(p + 1, tries + 1); });
    srv.listen(p, '127.0.0.1', () => {
      _mirrorSrv = srv; mirrorState.overlayUrl = 'http://127.0.0.1:' + p;
      console.log(color('  [UI] Overlay (mini): ' + mirrorState.overlayUrl, 'cyan'));
      console.log(color('  [UI] Tip: open in Chrome, then use split-screen/popup; Termux cannot draw a native floating overlay without extra Android permissions.', 'gray'));
      try { require('child_process').exec('termux-open-url ' + mirrorState.overlayUrl, {timeout:2000}); } catch (e) {}
      try { require('child_process').exec('am start -a android.intent.action.VIEW -d ' + mirrorState.overlayUrl + ' com.android.chrome', {timeout:2000}); } catch (e) {}
      try { require('child_process').exec('am start -a android.intent.action.VIEW -d ' + mirrorState.overlayUrl, {timeout:2000}); } catch (e) {}
    });
  }
  tryListen(port, 0);
  return srv;
}


function parseKahootInput(input) {
  const raw = String(input || '').trim();
  const out = { raw, pin: '', quizUuid: '', challengeId: '' };
  if (!raw) return out;
  // challenge URL/pin
  let m = raw.match(/challenge\/(?:pin\/)?(\d{4,10})/i);
  if (m) out.challengeId = m[1];
  m = raw.match(/[?&](?:challenge-?id|challengeId)=([^&\s]+)/i);
  if (m && !out.challengeId) out.challengeId = decodeURIComponent(m[1]);
  m = raw.match(/challenge[_\-\/]([0-9a-f-]{8,}|[\w-]+_\d+)/i);
  if (m && !out.challengeId && !/^\d+$/.test(m[1])) out.challengeId = m[1];
  // quizId/uuid in URL
  m = raw.match(/[?&]quizId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) out.quizUuid = m[1];
  m = raw.match(/\/details\/[^/\s]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m && !out.quizUuid) out.quizUuid = m[1];
  m = raw.match(/\/kahoot\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m && !out.quizUuid) out.quizUuid = m[1];
  if (!out.quizUuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) out.quizUuid = raw;
  // numeric: live PINs are usually 6-8 digits, challenge PINs can be 7+; treat as both candidates
  if (/^\d{4,10}$/.test(raw)) {
    out.pin = raw;
    if (raw.length >= 7) out.challengeId = out.challengeId || raw;
  }
  return out;
}

// ---------- Auto Answer ----------
async function runAutoAnswer() {
  console.log(color('  [ AUTO ANSWER BOT ]', 'bold'));
  const name = (await ask('  Bot name: ') || 'JZBot').trim();
  let mode = (await ask('  Mode (1=RAGE all correct, 2=non-suspicious): ')).trim();
  if (mode !== '1' && mode !== '2') mode = '2';
  const rawInput = (await ask('  Game PIN / challenge link / quiz URL: ') || '').trim();
  const parsed = parseKahootInput(rawInput);
  let pin = parsed.pin || (/^\d+$/.test(rawInput) ? rawInput : '');
  if (parsed.challengeId) console.log(color('  [*] Detected challenge: ' + parsed.challengeId + ' (trying challenge answers + live PIN paths)', 'cyan'));
  if (parsed.quizUuid) console.log(color('  [*] Detected quiz UUID: ' + parsed.quizUuid, 'cyan'));

  closePrompts();
  enableRawExit();
  mirrorState.status = 'starting'; mirrorState.mode = 'auto/'+mode; mirrorState.pin = pin; mirrorState.question=''; mirrorState.choices=[]; mirrorState.selected=null; mirrorState.correct=null; mirrorState.qi=0; mirrorState.source=''; mirrorState.quizTitle='';
  startMirror(8080);

  const Kahoot = require('kahoot.js-latest');

  let answerKey = null;
  let quizUuid = null;
  let publicCandidates = [];
  let candidatePos = 0;
  let firstQuestionText = null;

  const client = new Kahoot();
  registerClient(client);

  // challenge mode...
  try {
    client.defaults.options.ChallengeWaitForInput = true;
    client.defaults.options.ChallengeAutoContinue = true;
  } catch (e) {}

  let leakedTitle = null;
  let leakedHost = null;
  const origMessage = client._message.bind(client);
  client._message = function (msg) {
    try { if (JZ_DEBUG) { const p=JSON.parse(msg); const arr=Array.isArray(p)?p:[p]; arr.forEach(m=>{ if(m&&m.channel) dbg('ws', m.channel, m.data&&m.data.id, m.data&&m.data.type); }); } } catch(e){}
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
              console.log(color(`  [+] Sniffed UUID (${u}) - answers loaded (${k.length})`, 'green'));
            }
          }).catch(() => {});
        }
      }
    } catch (e) {}
    return origMessage(msg);
  };

  client.on('Joined', (settings) => {
    console.log(color('  [+] Joined game. Waiting for start...', 'green'));
    mirrorState.status = 'joined'; try { brainLearn({ pin: pin, session: { mode: 'auto', name: name, joined: true } }); } catch(e) {}
    // harvest leaked metadata from session/settings
    try {
      const meta = extractMeta(settings);
      if (meta.titles.length && !leakedTitle) leakedTitle = meta.titles[0];
      if (meta.hosts.length && !leakedHost) leakedHost = meta.hosts[0];
      for (const u of meta.uuids) {
        if (quizUuid || answerKey) continue;
        fetchAnswers(u).then(k => {
          if (k && Array.isArray(k) && !answerKey) { quizUuid = u; answerKey = k; console.log(color(`  [+] Metadata UUID (${u}) - answers (${k.length})`, 'green')); }
        }).catch(() => {});
      }
    } catch (e) {}
    if (client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Challenge: answers loaded (${answerKey.length} questions)`, 'green'));
    }
  });

  let structCandidates = null; // rakenne-esisuodatus
  function tryLoadUuid(u, source) {
    if (!u || answerKey) return;
    // check brain/memory for same quiz seen before
    const cached = (_brain.quizzes[u] && _brain.quizzes[u].questions) || mem[u];
    if (Array.isArray(cached) && cached.length) {
      quizUuid = u; answerKey = cached;
      mirrorState.quizTitle = (_brain.quizzes[u] && _brain.quizzes[u].title) || leakedTitle || mirrorState.quizTitle || '';
      console.log(color('  [+] Same quiz seen before in brain/memory (' + source + ', ' + cached.length + 'q): ' + u, 'green'));
      return;
    }
    fetchAnswers(u).then(k => {
      if (k && !answerKey) {
        quizUuid = u; answerKey = k;
        console.log(color('  [+] ' + source + ' UUID (' + u + ') - answers loaded (' + k.length + ')', 'green'));
        try { brainLearn({ uuid: u, quiz: k, title: leakedTitle }); } catch(e){}
      }
    }).catch(()=>{});
  }

  client.on('QuizStart', (quiz) => {
    console.log(color('  [*] Quiz started.', 'cyan'));
    try {
      if (quiz && (quiz.name || quiz.quizName || quiz.title) && !leakedTitle) leakedTitle = quiz.name || quiz.quizName || quiz.title;
      if (quiz && (quiz.uuid || quiz.quizId || quiz.kahootId) && !quizUuid) tryLoadUuid(String(quiz.uuid||quiz.quizId||quiz.kahootId), 'QuizStart-field');
      if (quiz && Array.isArray(quiz.quizQuestionAnswers) && !structCandidates && !answerKey) structCandidates = prefetchByStructure(quiz.quizQuestionAnswers, leakedTitle, leakedHost);
    } catch(e){}
    mirrorState.status = 'quiz'; mirrorState.qi = 0;
    // same game PIN seen before?
    try {
      const prev = _brain.games[pin];
      if (prev && prev.uuid && !answerKey) tryLoadUuid(prev.uuid, 'previous game PIN');
    } catch(e){}
    // leaked metadata
    try {
      const meta = extractMeta(quiz);
      if (meta.titles && meta.titles.length && !leakedTitle) leakedTitle = meta.titles[0];
      if (meta.hosts && meta.hosts.length && !leakedHost) leakedHost = meta.hosts[0];
      for (const u of (meta.uuids||[])) tryLoadUuid(u, 'QuizStart');
    } catch (e) {}
    if ((!answerKey) && client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color('  [+] Answers loaded from challenge data (' + answerKey.length + ')', 'green'));
    }
    // structure prefetch in background (faster after Q1)
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
  async function handleQuestionStart(question) {
    question = question || {};
    const qi = (typeof question.questionIndex === 'number') ? question.questionIndex : (typeof question.index === 'number' ? question.index : qIndex);
    qIndex = qi;
    const liveText = question.title || question.question || question.text || question.questionText || '';
    if (qi === 0 && liveText) firstQuestionText = liveText;
    console.log(color(`\n  [!] Question ${qi + 1} started`, 'yellow'));
    dbg('qstart', qi, question.type, liveText ? String(liveText).slice(0,60) : '');

    let choiceCount = 4;
    if (Array.isArray(question.choices)) choiceCount = question.choices.length;
    else if (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) choiceCount = client.quiz.quizQuestionAnswers[qi] || choiceCount;
    else if (Array.isArray(question.quizQuestionAnswers)) choiceCount = question.quizQuestionAnswers[qi] || choiceCount;

    let qData2 = (Array.isArray(answerKey) ? answerKey[qi] : null);
    if (!qData2 && Array.isArray(answerKey) && liveText) {
      const n = liveText.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      qData2 = answerKey.find(q => q && q.question && similarity(n, String(q.question).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()) > 0.72) || null;
    }
    if (!qData2 && liveText && _brain && Array.isArray(_brain.questions)) {
      const n = liveText.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      const hit = [..._brain.questions].reverse().find(x => x && x.text && similarity(n, String(x.text).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()) > 0.78);
      if (hit && Array.isArray(hit.correct)) { qData2 = { type: question.type||'quiz', choices: Array.from({length:choiceCount},(_,i)=>({correct: hit.correct.includes(i)})), question: hit.text }; }
    }
    if (!qData2 && Array.isArray(question.choices) && question.choices.some(c => c && c.correct)) {
      answerKey = [question]; qData2 = question;
    }
    let r = computeAnswer(qData2, mode, choiceCount);
    let answerToSend = r.answerToSend, know = r.know, wrong = r.wrong;

    // fast narrow-by-text+structure (public catalog). Helps when questions/answers randomized or private copy of public quiz.
    let fastResolve = null;
    if (!know && liveText) {
      const qCount = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers.length : null;
      const cc = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers : null;
      fastResolve = findPublicMatches(qCount || (qi+5), choiceCount, null, liveText, { title: leakedTitle, host: leakedHost, choiceCounts: cc, choiceTexts: Array.isArray(question.choices)?question.choices.map(c=>c&&(c.answer||c.text||c)||''):[] })
        .then(matches => {
          if (!matches || !matches.length) return null;
          // find a question in matches whose text matches and map correct choice text to live choice index
          for (const cand of matches) {
            if (!Array.isArray(cand)) continue;
            for (const cq of cand) {
              if (!cq || !cq.question) continue;
              if (similarity(liveText.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(), String(cq.question).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()) < 0.72) continue;
              const correctTexts = (cq.choices||[]).filter(c=>c&&c.correct).map(c=>String(c.answer||c.text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()).filter(Boolean);
              if (!correctTexts.length || !Array.isArray(question.choices)) continue;
              const idxs = question.choices.map((c,i)=>({i,t:String(c&&(c.answer||c.text||c)||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()})).filter(x=>correctTexts.some(ct=>ct===x.t||similarity(ct,x.t)>0.86)).map(x=>x.i);
              if (idxs.length) return { ans: (idxs.length===1?idxs[0]:idxs), uuid: cand.__uuid, title: null };
            }
          }
          return null;
        }).catch(()=>null);
    }
    if (wrong) console.log(color('  [*] Non-suspicious: intentional miss', 'gray'));
    else if (know) console.log(color('  [*] Answering correctly', 'gray'));
    else console.log(color('  [*] Not known pre-answer (private/randomized/no public match). Guessing now; correct answer will be learned at QuestionEnd.', 'gray'));

    let delay = mode === '1' ? (300 + Math.floor(Math.random() * 500)) : (900 + Math.floor(Math.random() * 300));
    try {
      mirrorState.status = 'question';
      mirrorState.question = liveText || (qData2 && (qData2.question || qData2.title)) || `Question ${qi + 1}`;
      mirrorState.source = know ? (quizUuid ? 'brain/rest/uuid' : 'known') : 'guess->learn@QuestionEnd';
      const liveChoices = Array.isArray(question.choices) ? question.choices.map(c=>c&&(c.answer||c.text||String(c))||'') : null;
      const keyChoices = Array.isArray(qData2 && qData2.choices) ? qData2.choices.map(c => c&&(c.answer||c.text||'')||'') : null;
      mirrorState.choices = liveChoices && liveChoices.length ? liveChoices : (keyChoices && keyChoices.length ? keyChoices : Array.from({length: choiceCount}, (_,i)=>`Option ${i}`));
      mirrorState.selected = null; mirrorState.correct = null; mirrorState.qi = qi; mirrorState.questionIndex = qi;
    } catch (e) {}

    setTimeout(async () => {
      try {
        if (!know && fastResolve) {
          try {
            const fr = await Promise.race([fastResolve, sleep(Math.max(1, Math.min(8, delay/1000))).then(()=>null)]);
            if (fr && fr.ans != null) {
              answerToSend = fr.ans; know = true; mirrorState.source = 'public-text-match';
              if (fr.uuid) quizUuid = quizUuid || fr.uuid;
              console.log(color('  [+] Resolved by public text/structure match: ' + JSON.stringify(answerToSend), 'green'));
            }
          } catch(e){}
        }
        console.log(color(`  [+] Sending: ${Array.isArray(answerToSend)?answerToSend.join(','):answerToSend} (delay ${delay}ms)`, 'green'));
        mirrorState.selected = answerToSend;
        if (question && typeof question.answer === 'function') question.answer(answerToSend);
        else client.answer(answerToSend);
      } catch (e) { try { client.answer(answerToSend); } catch(e2){} }
      qIndex = Math.max(qIndex, qi + 1);
    }, delay);
  }
  client.on('QuestionStart', handleQuestionStart);
  try { client.on('questionStart', handleQuestionStart); } catch(e){}
  try { client.on('QuestionReady', (q)=>dbg('QuestionReady', q&&q.questionIndex)); } catch(e){}

  async function handleQuestionEnd(qe) {
    qe = qe || {};
    mirrorState.status = 'questionEnd';
    const idx = Math.max(0, qIndex - 1);
    const correct = Array.isArray(qe.correctChoices) ? qe.correctChoices : null;
    if (correct) {
      mirrorState.correct = correct; mirrorState.source = 'questionEnd';
      console.log(color(`  [+] Correct answers for Q${idx + 1}: ${correct.join(',')}`, 'green'));
      if (!Array.isArray(answerKey)) answerKey = [];
      const q = answerKey[idx] || { type: qe.type, choices: [] };
      if (!Array.isArray(q.choices)) q.choices = [];
      const n = Math.max(q.choices.length, (mirrorState.choices && mirrorState.choices.length) || 0, correct.reduce((a,b)=>Math.max(a,b+1),0));
      while (q.choices.length < n) q.choices.push({ answer: '', correct: false });
      correct.forEach(i => { if (q.choices[i]) q.choices[i].correct = true; });
      q.question = mirrorState.question || q.question;
      answerKey[idx] = q;
      // learn to brain
      try {
        const choiceTexts = (mirrorState.choices||[]).map((t,i)=>({i,t}));
        const correctTexts = correct.map(i => (mirrorState.choices&&mirrorState.choices[i])||'').filter(Boolean);
        brainLearn({ question: { pin: mirrorState.pin, qi: idx, correct, correctTexts, choiceTexts: mirrorState.choices||[], choiceCount: n, text: mirrorState.question } });
      } catch (e) {}

      // Fingerprint search from public templates (after first question)
      if (idx === 0) {
        const qCount = (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers.length : (answerKey.length || 1);
        const firstChoiceCount = (mirrorState.choices && mirrorState.choices.length) || correct.reduce((a,b)=>Math.max(a,b+1),0);
        const firstCorrect = (correct.length === 1) ? correct[0] : correct;
        const hints = {
          title: leakedTitle,
          host: leakedHost,
          choiceCounts: (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) ? client.quiz.quizQuestionAnswers : null
        };
        console.log(color('  [*] Fingerprint search (metadata + structure + QuestionEnd)...', 'gray'));
        if (hints.title) console.log(color('  [*] Leaked title: ' + hints.title, 'gray'));
        if (hints.host) console.log(color('  [*] Leaked host/creator: ' + hints.host, 'gray'));
        let matches = [];
        // 1) rakenne-esiehdokkaat (nopea)
        try {
          const pre = structCandidates ? await Promise.race([structCandidates, sleep(2).then(()=>[])]) : [];
          if (Array.isArray(pre) && pre.length) {
            matches = pre.filter(c => matchQ(c, 0, firstChoiceCount, firstCorrect, firstQuestionText, mirrorState.choices));
            if (matches.length) console.log(color('  [+] Structure prefetch hit: ' + matches.length + ' ehdokasta', 'green'));
          }
        } catch (e) {}
        // 2) taydennys haulla
        if (matches.length === 0) {
          matches = await findPublicMatches(qCount, firstChoiceCount, firstCorrect, firstQuestionText, {...hints, choiceTexts: mirrorState.choices});
        } else {
          // search more in background but don't wait long
          findPublicMatches(qCount, firstChoiceCount, firstCorrect, firstQuestionText, hints).then(extra => {
            if (Array.isArray(extra) && extra.length > publicCandidates.length) {
              publicCandidates = extra;
              console.log(color('  [+] Extra candidates from search: ' + extra.length, 'green'));
            }
          }).catch(()=>{});
        }
        publicCandidates = matches;
        candidatePos = 0;
        if (matches.length > 0) {
          answerKey = matches[0];
          console.log(color(`  [+] Public quiz match found! ${matches.length} candidates. Loaded ${answerKey.length} answers.`, 'green'));
        } else {
          console.log(color('  [-] No public match. Collecting answers from QuestionEnd (private quiz).', 'gray'));
        }
      }

      // Refinement: if Q2 answer mismatches, try next candidate
      if (idx === 1 && Array.isArray(publicCandidates) && publicCandidates.length > 1) {
        const predicted = (Array.isArray(answerKey) && answerKey[1] && Array.isArray(answerKey[1].choices)) ? answerKey[1].choices.map((c,i)=>c.correct?i:-1).filter(i=>i>=0) : null;
        const actual = correct;
        let predictedNorm = (predicted && predicted.length === 1) ? predicted[0] : predicted;
        let actualNorm = (actual.length === 1) ? actual[0] : actual;
        if (predictedNorm !== null && JSON.stringify(predictedNorm) !== JSON.stringify(actualNorm)) {
          // find next match that also fits Q2
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
              console.log(color(`  [+] Refined: switched to match #${i + 1}.`, 'green'));
              break;
            }
          }
          if (!found) console.log(color('  [-] Refinement failed, keeping current match.', 'gray'));
        }
      }
    }
  }
  client.on('QuestionEnd', handleQuestionEnd);
  try { client.on('questionEnd', handleQuestionEnd); } catch(e){}
  try { client.on('RevealAnswer', handleQuestionEnd); } catch(e){}
  client.on('QuizEnd', () => { mirrorState.status = 'ended'; mirrorState.source='ended'; console.log(color('  [+] Quiz ended. Shift+Q to quit.', 'cyan')); try { brainLearn({ pin: pin, session: { ended: true, uuid: quizUuid || null, title: leakedTitle||null } }); if (quizUuid && Array.isArray(answerKey)) brainLearn({ uuid: quizUuid, quiz: answerKey, title: leakedTitle }); } catch(e) {} });
  client.on('TwoFactorReset', () => { console.log(color('  [!] 2FA required (host code) - bot cannot answer automatically', 'yellow')); });
  client.on('Disconnect', (reason) => { mirrorState.status='disconnected'; console.log(color('  [-] Disconnected: ' + (reason||'unknown'), 'red')); console.log(color('  [*] Shift+Q = quit, or wait/restart from menu if you rerun.', 'gray')); });

  // If we only have a challenge/UUID (no live PIN join useful) but got answers, show them
  const canJoinLive = /^\d{4,10}$/.test(String(pin||''));
  if (!canJoinLive && Array.isArray(answerKey) && answerKey.length) {
    mirrorState.status = 'answers-loaded'; mirrorState.pin = String(challengeId||quizUuid||'');
    console.log(color('\n  [+] Answers loaded: ' + answerKey.length + ' questions (no live join).', 'green'));
    answerKey.forEach((q,i)=>{
      const correct = (q.choices||[]).map((c,idx)=>c&&c.correct?idx:-1).filter(x=>x>=0);
      console.log(color('  Q'+(i+1)+': ' + (q.question||q.title||''), 'cyan'));
      (q.choices||[]).forEach((c,idx)=> console.log('    '+idx+': '+(c&& (c.answer||c.text||c)||'') + (correct.includes(idx)?color('  [CORRECT]','green'):'')));
      if (!correct.length && q.correctChoices) console.log('    correct: ' + JSON.stringify(q.correctChoices));
    });
    try { if (quizUuid) brainLearn({ uuid: quizUuid, quiz: answerKey, title: leakedTitle }); if (challengeId) brainLearn({ pin: challengeId, session: { challenge: true, uuid: quizUuid||null } }); } catch(e){}
    console.log(color('\n  [*] Press Shift+Q to quit.', 'gray'));
    setInterval(()=>{}, 60000); return;
  }
  if (!canJoinLive) {
    console.log(color('  [-] No joinable live PIN. Provide a live game PIN, challenge link/PIN, or public quizId/URL.', 'red'));
    console.log(color('  [*] Private live quizzes without a public copy/challenge: answers are learned per question via QuestionEnd.', 'gray'));
  }
  console.log(color(`  [*] Joining game ${pin} as ${name}...`, 'cyan'));
  client.join(String(pin), name + '\u200B').catch(err => {
    mirrorState.status='join-failed';
    console.log(color('  [-] Join failed: ' + (err && (err.description || err.message || err) || 'unknown'), 'red'));
    console.log(color('  [*] Check PIN (live game must be open). Shift+Q = quit.', 'gray'));
  });
}

// ---------- Flooder ----------
async function runFlooder() {
  console.log(color('  [ FLOODER / CRASHER ]', 'bold'));
  const base = (await ask('  Bot name (prefix): ') || 'JZBot').trim();
  const count = parseInt(await ask('  How many bots: '), 10) || 1;
  const pin = (await ask('  Kahoot PIN: ') || '').trim();

  closePrompts();
  enableRawExit();
  mirrorState.status = 'flooding';
  mirrorState.mode = 'flooder';
  mirrorState.pin = pin;
  mirrorState.bots = count;
  mirrorState.joined = 0;
  startMirror(8080);

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
        console.log(color(`  [+] Bot ${i} joined (${joined}/${count})`, 'green'));
      }).catch((e) => {
        failed++;
        console.log(color(`  [-] Bot ${i} failed: ${e && e.description || e}`, 'red'));
        try { client.leave(); } catch (x) {}
      });
      tasks.push(p);
      client.on('Disconnect', (r) => {});
    } catch (e) {
      failed++;
      console.log(color(`  [-] Bot ${i} error: ${e && e.description || e}`, 'red'));
    }
    await sleep(0.15);
  }

  await Promise.allSettled(tasks);
  console.log(color(`  [*] All ${count} sent. Joined: ${joined}, failed: ${failed}`, 'cyan'));
  console.log(color('  [*] Press Shift+Q to quit, or 3 to leave bots.', 'gray'));
}

// ---------- Leaver (bots leave the game) ----------
async function runLeaver() {
  console.log(color('  [ LEAVER ]', 'bold'));
  const base = (await ask('  Bot name (prefix): ') || 'JZBot').trim();
  const count = parseInt(await ask('  How many bots: '), 10) || 1;
  const pin = (await ask('  Kahoot PIN: ') || '').trim();
  const delaySec = parseInt(await ask('  Leave delay (sec, 0=now): '), 10) || 0;

  closePrompts();
  enableRawExit();
  mirrorState.status = 'leaving';
  mirrorState.mode = 'leaver';
  mirrorState.pin = pin;
  mirrorState.bots = count;
  mirrorState.joined = 0;
  startMirror(8080);

  const Kahoot = require('kahoot.js-latest');
  console.log(color(`  [*] Joining ${count} bots, removing after ${delaySec}s...`, 'cyan'));

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
        console.log(color(`  [+] Bot ${i} joined (${joined}/${count})`, 'green'));
      }).catch((e) => {
        failed++;
        console.log(color(`  [-] Bot ${i} failed: ${e && e.description || e}`, 'red'));
      });
    } catch (e) {
      failed++;
      console.log(color(`  [-] Bot ${i} error: ${e && e.description || e}`, 'red'));
    }
    await sleep(0.15);
  }

  await sleep(delaySec);
  console.log(color('  [*] Removing bots...', 'yellow'));
  for (const c of clients2) { try { c.leave(); } catch (e) {} }
  mirrorState.status = 'done';
  console.log(color(`  [+] Done. Joined: ${joined}, failed: ${failed}`, 'green'));
  console.log(color('  [*] Press Shift+Q to quit, or 3 to leave bots.', 'gray'));
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
      console.log(`    Q${qi + 1} ${qData.type}: ${Array.isArray(answerToSend) ? answerToSend.join(',') : answerToSend} ${know ? (wrong ? '(intentional miss)' : '(correct)') : '(guess)'}`);
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
  console.log(color(`  Collection test: ${answerToSend} (expected 1)`, answerToSend === 1 ? 'green' : 'red'));
  console.log(color('  Self-test done.', 'green'));
}

async function main() {
  if (process.argv.includes('--test')) {
    banner();
    await runSelfTest();
    process.exit(0);
  }
  banner();
  console.log(color('  Select mode:', 'bold'));
  let choice = '';
  while (choice !== '1' && choice !== '2') {
    console.log(color('  1 = Auto Answer Bot', 'green'));
    console.log(color('  2 = Flooder / Crasher', 'red'));
    console.log(color('  3 = Leaver (remove bots)', 'yellow'));
    console.log('');
    choice = (await ask('  Choice (1/2/3): ')).trim();
    if (choice !== '1' && choice !== '2' && choice !== '3') {
      console.log(color('  Invalid choice, try again.', 'red'));
    }
  }
  if (choice === '1') await runAutoAnswer();
  else if (choice === '2') await runFlooder();
  else if (choice === '3') await runLeaver();

  setInterval(() => {}, 60000);
}

process.on('uncaughtException', (e) => { console.error(color('  [!] Error: ' + (e && e.message || e), 'red')); });
process.on('unhandledRejection', (e) => { console.error(color('  [!] Promise error: ' + (e && e.message || e), 'red')); });

main().catch(e => { console.error(e); process.exit(1); });
