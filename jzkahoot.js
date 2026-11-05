#!/usr/bin/env node
'use strict';

const readline = require('readline');
const axios = require('axios');

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
const fs = require('fs');
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
  key = key || '';
  if (typeof obj === 'string') {
    if (/quiz|uuid|kahoot|game/i.test(key)) {
      const m = obj.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
      if (m && out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((x, i) => findUuids(x, out, String(i)));
    return out;
  }
  for (const k of Object.keys(obj)) findUuids(obj[k], out, k);
  return out;
}

async function fetchAnswers(uuid) {
  if (!uuid) return null;
  const urls = [
    `https://create.kahoot.it/rest/kahoots/${uuid}`,
    `https://kahoot.it/rest/kahoots/${uuid}`
  ];
  for (const u of urls) {
    try {
      const res = await axios.get(u, { timeout: 8000 });
      if (res.data && Array.isArray(res.data.questions)) return res.data.questions;
    } catch (e) {}
  }
  return null;
}

function banner() {
  console.log(color('  ╔══════════════════════════════════════════════════════╗', 'cyan'));
  console.log(color('  ║                                                      ║', 'cyan'));
  console.log(color('  ║   ██╗ ███████╗   ██╗  ██╗ █████╗ ██╗  ██╗  ██████╗   ║', 'cyan'));
  console.log(color('  ║   ██║ ╚══███╔╝   ██║  ██║██╔══██╗██║  ██║ ██╔═══██╗  ║', 'cyan'));
  console.log(color('  ║   ██║   ███╔╝    ███████║███████║███████║ ██║   ██║  ║', 'cyan'));
  console.log(color('  ║   ██║  ███╔╝     ██╔══██║██╔══██║██╔══██║ ██║   ██║  ║', 'cyan'));
  console.log(color('  ║   ██║ ███████╗   ██║  ██║██║  ██║██║  ██║ ╚██████╔╝  ║', 'cyan'));
  console.log(color('  ║   ╚═╝ ╚══════╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═════╝   ║', 'cyan'));
  console.log(color('  ║                                                      ║', 'cyan'));
  console.log(color('  ║        JZ KAHOOT BOT  -  V3.0  -  TERMUX             ║', 'magenta'));
  console.log(color('  ║   Auto Answer + Flooder  |  Shift+Q = stop           ║', 'gray'));
  console.log(color('  ╚══════════════════════════════════════════════════════╝', 'cyan'));
  console.log('');
}

// ---------- Auto Answer ----------
async function runAutoAnswer() {
  console.log(color('  [ AUTO ANSWER BOT ]', 'bold'));
  const name = (await ask('  Botin nimi: ') || 'JZBot').trim();
  let mode = (await ask('  Mode (1 = RAGE all correct, 2 = non-suspicious): ')).trim();
  if (mode !== '1') mode = '2';
  const link = (await ask('  Quiz link/UUID (valinnainen, Enter ohittaa): ') || '').trim();
  const pin = (await ask('  Kahoot PIN: ') || '').trim();

  closePrompts();
  enableRawExit();

  const Kahoot = require('kahoot.js-latest');

  let answerKey = null;
  let quizUuid = null;

  if (link) {
    const m = link.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (m) {
      quizUuid = m[0];
      fetchAnswers(quizUuid).then(k => {
        if (k) { answerKey = k; console.log(color(`  [+] Vastaukset ladattu linkista (${k.length} kysymysta)`, 'green')); }
      }).catch(() => {});
    }
  }

  const client = new Kahoot();
  registerClient(client);

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
              if (k) { answerKey = k; console.log(color(`  [+] Nuuskittiin UUID (${u}) - vastaukset ladattu (${k.length})`, 'green')); }
            }).catch(() => {});
          }
        }
      }
    } catch (e) {}
    return origMessage(msg);
  };

  client.on('Joined', (settings) => {
    console.log(color('  [+] Liitytty peliin. Odotetaan aloitusta...', 'green'));
    if (client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Challenge: vastaukset ladattu (${answerKey.length} kysymysta)`, 'green'));
    }
  });

  client.on('QuizStart', (quiz) => {
    console.log(color('  [*] Quiz alkoi.', 'cyan'));
    if ((!answerKey) && client.challengeData && client.challengeData.kahoot && client.challengeData.kahoot.questions) {
      answerKey = client.challengeData.kahoot.questions;
      console.log(color(`  [+] Vastaukset ladattu challenge-datasta (${answerKey.length})`, 'green'));
    }
  });

  let qIndex = 0;
  client.on('QuestionStart', (question) => {
    const qi = (typeof question.questionIndex === 'number') ? question.questionIndex : qIndex;
    qIndex = qi;
    console.log(color(`\n  [!] Kysymys ${qi + 1} alkoi`, 'yellow'));

    let choiceCount = 4;
    if (Array.isArray(question.choices)) choiceCount = question.choices.length;
    else if (client.quiz && Array.isArray(client.quiz.quizQuestionAnswers)) choiceCount = client.quiz.quizQuestionAnswers[qi] || choiceCount;
    else if (Array.isArray(question.quizQuestionAnswers)) choiceCount = question.quizQuestionAnswers[qi] || choiceCount;

    let know = false;
    let correctIndex = null;
    let correctIndices = null;
    const qData = (Array.isArray(answerKey) ? answerKey[qi] : null);
    if (qData && Array.isArray(qData.choices)) {
      const idxs = [];
      qData.choices.forEach((c, i) => { if (c.correct) idxs.push(i); });
      if (idxs.length > 0) {
        know = true;
        if (idxs.length === 1) correctIndex = idxs[0];
        else correctIndices = idxs;
      }
    }

    let delay = 1000;
    if (mode === '1') delay = 300 + Math.floor(Math.random() * 500);
    else delay = 900 + Math.floor(Math.random() * 300);

    let answerToSend;
    if (know) {
      if (mode === '2' && Math.random() < 0.1) {
        const wrong = [];
        for (let i = 0; i < choiceCount; i++) {
          if (correctIndex !== null && i !== correctIndex) wrong.push(i);
          if (correctIndices && !correctIndices.includes(i)) wrong.push(i);
        }
        const uniq = [...new Set(wrong)];
        answerToSend = uniq.length ? uniq[Math.floor(Math.random() * uniq.length)] : Math.floor(Math.random() * choiceCount);
        console.log(color('  [*] Legit: tahallinen virhe', 'gray'));
      } else {
        answerToSend = (correctIndices && correctIndices.length > 1) ? correctIndices : correctIndex;
        console.log(color('  [*] Vastataan oikein', 'gray'));
      }
    } else {
      answerToSend = Math.floor(Math.random() * choiceCount);
      console.log(color('  [*] Vastausta ei tiedeta, arvataan', 'gray'));
    }

    setTimeout(() => {
      try {
        console.log(color(`  [+] Lahetetaan vastaus: ${Array.isArray(answerToSend) ? answerToSend.join(',') : answerToSend} (viive ${delay}ms)`, 'green'));
        question.answer(answerToSend);
      } catch (e) {
        try { client.answer(answerToSend); } catch (e2) {}
      }
      qIndex++;
    }, delay);
  });

  client.on('QuizEnd', () => { console.log(color('  [+] Peli paattyi.', 'cyan')); });
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

  const Kahoot = require('kahoot.js-latest');
  console.log(color(`  [*] Lahetetaan ${count} bottia peliin ${pin}...`, 'cyan'));

  let joined = 0, failed = 0;
  for (let i = 1; i <= count; i++) {
    const name = `${base}${i}\u200B`;
    try {
      const res = Kahoot.join(pin, name);
      const client = res.client;
      const event = res.event;
      registerClient(client);
      event.then(() => {
        joined++;
        console.log(color(`  [+] Bot ${i} liittyi (${joined}/${count})`, 'green'));
      }).catch((e) => {
        failed++;
        console.log(color(`  [-] Bot ${i} epaonnistui: ${e && e.description || e}`, 'red'));
        try { client.leave(); } catch (x) {}
      });
      client.on('Disconnect', (r) => {});
    } catch (e) {
      failed++;
      console.log(color(`  [-] Bot ${i} virhe: ${e && e.description || e}`, 'red'));
    }
    await sleep(0.15);
  }

  console.log(color(`  [*] Kaikki ${count} lahetetty. Liittyneet: ${joined}, epaonnistuneet: ${failed}`, 'cyan'));
  console.log(color('  [*] Paina Iso Q lopettaaksesi.', 'gray'));
}

// ---------- Main ----------
async function main() {
  banner();
  console.log(color('  Valitse toiminto:', 'bold'));
  console.log(color('  1 = Auto Answer Bot', 'green'));
  console.log(color('  2 = Flooder', 'red'));
  console.log('');
  const c = (await ask('  Valinta (1/2): ')).trim();
  if (c === '1') await runAutoAnswer();
  else if (c === '2') await runFlooder();
  else { console.log(color('  Virheellinen valinta.', 'red')); process.exit(0); }

  setInterval(() => {}, 60000);
}

main().catch(e => { console.error(e); process.exit(1); });
