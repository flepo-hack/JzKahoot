// ==UserScript==
// @name         JZ Kahoot Auto-Answer (100% private + public) - Android OK
// @namespace    jz-kahoot
// @version      1.1.0
// @description  Reads the correct answer from Kahoot's live WebSocket/React data. Works on private and public quizzes. No AI, no guessing. Mobile-friendly.
// @author       JZ
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const state = {
    ws: null,
    lastQuestion: null,
    lastAnswers: null,
    autoClick: true,
    delayMin: 1400,
    delayMax: 3400,
    missChance: 0,
    panel: null,
    log: [],
    qStructure: null
  };

  function log(msg) {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    state.log.unshift(line);
    if (state.log.length > 50) state.log.pop();
    renderLog();
    console.log('[JZ]', msg);
  }

  // ---------- WebSocket hook ----------
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    state.ws = ws;
    ws.addEventListener('message', (ev) => {
      try { handleWsMessage(ev.data); } catch (e) { /* ignore */ }
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.CONNECTING = OrigWS.CONNECTING;
  HookedWS.OPEN = OrigWS.OPEN;
  HookedWS.CLOSING = OrigWS.CLOSING;
  HookedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = HookedWS;

  // ---------- Parse messages ----------
  function handleWsMessage(raw) {
    let arr;
    try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : [p]; }
    catch (e) { return; }
    for (const m of arr) {
      let content = null;
      try { if (m && m.data && typeof m.data.content === 'string') content = JSON.parse(m.data.content); } catch(e){}
      if (!content) continue;

      // QuestionStart
      if (content.questionIndex !== undefined || content.gameBlockIndex !== undefined ||
          content.type === 'quiz' || content.gameBlockType === 'quiz' ||
          content.gameBlockType === 'multiple_select_quiz' || content.gameBlockType === 'jumble') {
        handleQuestion(content);
      }
      // Structure
      if (Array.isArray(content.quizQuestionAnswers)) {
        state.qStructure = content.quizQuestionAnswers;
      }
      // QuestionEnd
      if (Array.isArray(content.correctChoices)) {
        const qi = (typeof content.questionIndex === 'number') ? content.questionIndex : state.lastQuestion;
        state.lastAnswers = content.correctChoices;
        log('Q' + (qi + 1) + ' correctChoices: ' + content.correctChoices.join(','));
        highlightCorrect(content.correctChoices);
      }
    }
  }

  // ---------- Handle question ----------
  function handleQuestion(q) {
    const qi = (typeof q.questionIndex === 'number') ? q.questionIndex : (typeof q.index === 'number' ? q.index : 0);
    const type = q.type || q.gameBlockType || '';
    const title = q.title || q.question || q.questionText || q.text || '';
    const choices = Array.isArray(q.choices) ? q.choices : (Array.isArray(q.answers) ? q.answers : []);
    state.lastQuestion = qi;

    // Method A: correct flag in payload
    let correct = [];
    choices.forEach((c, i) => {
      if (c && (c.correct === true || c.isCorrect === true || c.correctAnswer === true)) correct.push(i);
    });

    // Method B: React fiber
    if (!correct.length) correct = readCorrectFromReact(choices.length);

    // Method C: DOM data attributes
    if (!correct.length) correct = readCorrectFromDOM(choices.length);

    state.lastAnswers = correct.length ? correct : null;
    const choiceTexts = choices.map(c => (c && (c.answer || c.text || c.choice || String(c))) || '');
    log('Q' + (qi + 1) + ' [' + type + '] ' + title.slice(0, 50));
    choiceTexts.forEach((t, i) => log('  ' + i + ': ' + t + (correct.includes(i) ? '  [CORRECT]' : '')));

    if (correct.length && state.autoClick) {
      let toClick = correct;
      if (state.missChance > 0 && Math.random() < state.missChance && choices.length > 1) {
        const wrong = [];
        for (let i = 0; i < choices.length; i++) if (!correct.includes(i)) wrong.push(i);
        if (wrong.length) { toClick = [wrong[Math.floor(Math.random() * wrong.length)]]; log('  (intentional miss)'); }
      }
      const delay = state.delayMin + Math.floor(Math.random() * (state.delayMax - state.delayMin));
      setTimeout(() => clickAnswers(toClick, type), delay);
    } else if (!correct.length) {
      log('  (no correct found pre-answer; will learn at QuestionEnd)');
    }
  }

  // ---------- React fiber read ----------
  function readCorrectFromReact(n) {
    const out = [];
    try {
      const btns = document.querySelectorAll('button[data-functional-selector^="answer-"]');
      btns.forEach((btn) => {
        const fiberKey = Object.keys(btn).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return;
        let fiber = btn[fiberKey];
        let depth = 0;
        while (fiber && depth < 50) {
          const props = fiber.memoizedProps || fiber.pendingProps || {};
          if (props) {
            if (props.isCorrect === true || props.correct === true) {
              const sel = btn.getAttribute('data-functional-selector') || '';
              const m = sel.match(/answer-(\d+)/);
              if (m) { const idx = parseInt(m[1], 10); if (out.indexOf(idx) === -1) out.push(idx); }
            }
            if (props.answer && (props.answer.correct === true || props.answer.isCorrect === true)) {
              const sel = btn.getAttribute('data-functional-selector') || '';
              const m = sel.match(/answer-(\d+)/);
              if (m) { const idx = parseInt(m[1], 10); if (out.indexOf(idx) === -1) out.push(idx); }
            }
          }
          fiber = fiber.return;
          depth++;
        }
      });
    } catch (e) { log('react read err: ' + e.message); }
    return out;
  }

  // ---------- DOM data attributes ----------
  function readCorrectFromDOM(n) {
    const out = [];
    try {
      const els = document.querySelectorAll('[data-correct], [data-is-correct]');
      els.forEach((el) => {
        const v = el.getAttribute('data-correct') || el.getAttribute('data-is-correct');
        if (v === 'true' || v === '1') {
          const sel = el.getAttribute('data-functional-selector') || '';
          const m = sel.match(/answer-(\d+)/);
          if (m) { const idx = parseInt(m[1], 10); if (out.indexOf(idx) === -1) out.push(idx); }
        }
      });
    } catch (e) {}
    return out;
  }

  // ---------- Click ----------
  function clickAnswers(indices, type) {
    try {
      if (type === 'jumble' && Array.isArray(indices)) {
        indices.forEach((idx, order) => {
          const btn = document.querySelector('button[data-functional-selector="answer-' + idx + '"]');
          if (btn) setTimeout(() => btn.click(), order * 200);
        });
        return;
      }
      if (Array.isArray(indices)) {
        indices.forEach(idx => {
          const btn = document.querySelector('button[data-functional-selector="answer-' + idx + '"]');
          if (btn) btn.click();
        });
      } else {
        const btn = document.querySelector('button[data-functional-selector="answer-' + indices + '"]');
        if (btn) btn.click();
      }
    } catch (e) { log('click err: ' + e.message); }
  }

  // ---------- Highlight ----------
  function highlightCorrect(indices) {
    try {
      indices.forEach(idx => {
        const btn = document.querySelector('button[data-functional-selector="answer-' + idx + '"]');
        if (btn) {
          btn.style.outline = '4px solid #00e676';
          btn.style.boxShadow = '0 0 16px #00e676';
        }
      });
    } catch (e) {}
  }

  // ---------- UI Panel (mobile-friendly) ----------
  function createPanel() {
    const div = document.createElement('div');
    div.id = 'jz-panel';
    div.style.cssText = 'position:fixed;top:4px;right:4px;z-index:2147483647;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:11px;padding:6px 8px;border:1px solid #0f0;border-radius:8px;max-width:280px;max-height:40vh;overflow:auto;';
    div.innerHTML = '<b style="color:#0ff">JZ Kahoot 100%</b> <span id="jz-status" style="color:#ff0">Ready</span><br><div id="jz-log" style="margin-top:4px;white-space:pre-wrap;font-size:10px;"></div>';
    document.body.appendChild(div);
    state.panel = div;
  }

  function renderLog() {
    const el = document.getElementById('jz-log');
    if (el) el.textContent = state.log.join('\n');
    const st = document.getElementById('jz-status');
    if (st) st.textContent = state.lastAnswers ? 'OK' : 'Waiting';
  }

  function init() {
    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel);
    log('Loaded. Auto-answer active. Private+public.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.JZ = { state, log, handleQuestion, clickAnswers };
})();
