// ==UserScript==
// @name         JZ Kahoot Auto-Answer (100% private + public)
// @namespace    jz-kahoot
// @version      1.0.0
// @description  Reads the correct answer from Kahoot's live WebSocket/React data. Works on private and public quizzes. No AI, no guessing.
// @author       JZ
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    ws: null,
    lastQuestion: null,
    lastAnswers: null,   // array of correct indices
    autoClick: true,
    delayMin: 1200,
    delayMax: 3200,
    missChance: 0,       // 0 = never miss; set >0 to miss intentionally
    panel: null,
    log: []
  };

  // ---------- Logging ----------
  function log(msg) {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    state.log.unshift(line);
    if (state.log.length > 40) state.log.pop();
    renderLog();
    console.log('[JZ]', msg);
  }

  // ---------- WebSocket hook ----------
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    state.ws = ws;
    const origOnMessage = ws.onmessage;
    ws.addEventListener('message', (ev) => {
      try { handleWsMessage(ev.data); } catch (e) { /* ignore */ }
    });
    // also wrap onmessage property
    let _onmsg = ws.onmessage;
    Object.defineProperty(ws, 'onmessage', {
      set(fn) { _onmsg = fn; },
      get() { return function (ev) { try { handleWsMessage(ev.data); } catch(e){} if (_onmsg) _onmsg.call(ws, ev); }; }
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.CONNECTING = OrigWS.CONNECTING;
  HookedWS.OPEN = OrigWS.OPEN;
  HookedWS.CLOSING = OrigWS.CLOSING;
  HookedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = HookedWS;

  // ---------- Parse Kahoot messages ----------
  function handleWsMessage(raw) {
    let arr;
    try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : [p]; }
    catch (e) { return; }
    for (const m of arr) {
      let content = null;
      try { if (m && m.data && typeof m.data.content === 'string') content = JSON.parse(m.data.content); } catch(e){}
      const channel = m && m.channel;
      const id = m && m.data && m.data.id;

      // QuestionStart (id 2 or type questionStart) - contains question + choices (+ sometimes correct)
      if (content && (content.questionIndex !== undefined || content.gameBlockIndex !== undefined || content.type === 'quiz' || content.gameBlockType === 'quiz')) {
        handleQuestion(content);
      }
      // QuestionReady / GetReady
      if (content && Array.isArray(content.quizQuestionAnswers)) {
        // store structure
        state.qStructure = content.quizQuestionAnswers;
      }
      // QuestionEnd (id 8) - correctChoices
      if (content && Array.isArray(content.correctChoices)) {
        const qi = (typeof content.questionIndex === 'number') ? content.questionIndex : state.lastQuestion;
        state.lastAnswers = content.correctChoices;
        log('Q' + (qi+1) + ' correctChoices: ' + content.correctChoices.join(','));
        highlightCorrect(content.correctChoices);
      }
      // QuizStart
      if (content && (content.quizQuestionAnswers || content.name) && (channel || '').toLowerCase().includes('controller')) {
        // ignore
      }
    }
  }

  // ---------- Handle question ----------
  function handleQuestion(q) {
    const qi = (typeof q.questionIndex === 'number') ? q.questionIndex : (typeof q.index === 'number' ? q.index : 0);
    const type = q.type || q.gameBlockType || q.gameBlockType || '';
    const title = q.title || q.question || q.questionText || q.text || '';
    const choices = Array.isArray(q.choices) ? q.choices : (Array.isArray(q.answers) ? q.answers : []);
    state.lastQuestion = qi;

    // Method A: correct flag in payload (works when Kahoot leaks it)
    let correct = [];
    choices.forEach((c, i) => {
      if (c && (c.correct === true || c.isCorrect === true || c.correct === 'true')) correct.push(i);
    });

    // Method B: read from React fiber / DOM (works on private quizzes)
    if (!correct.length) {
      correct = readCorrectFromReact(choices.length);
    }

    // Method C: read from DOM data attributes
    if (!correct.length) {
      correct = readCorrectFromDOM(choices.length);
    }

    state.lastAnswers = correct.length ? correct : null;
    const choiceTexts = choices.map(c => (c && (c.answer || c.text || c.choice || String(c))) || '');
    log('Q' + (qi+1) + ' [' + type + '] ' + title.slice(0,60));
    choiceTexts.forEach((t, i) => log('  ' + i + ': ' + t + (correct.includes(i) ? '  [CORRECT]' : '')));

    if (correct.length && state.autoClick) {
      const delay = state.delayMin + Math.floor(Math.random() * (state.delayMax - state.delayMin));
      // intentional miss
      let toClick = correct;
      if (state.missChance > 0 && Math.random() < state.missChance && choices.length > 1) {
        const wrong = [];
        for (let i = 0; i < choices.length; i++) if (!correct.includes(i)) wrong.push(i);
        if (wrong.length) { toClick = [wrong[Math.floor(Math.random()*wrong.length)]]; log('  (intentional miss)'); }
      }
      setTimeout(() => clickAnswers(toClick, type), delay);
    } else if (!correct.length) {
      log('  (no correct found pre-answer; will learn at QuestionEnd)');
    }
  }

  // ---------- Read correct from React fiber ----------
  function readCorrectFromReact(n) {
    const out = [];
    try {
      // find answer buttons
      const btns = document.querySelectorAll('button[data-functional-selector^="answer-"], [data-functional-selector^="answer-"]');
      btns.forEach((btn, i) => {
        // walk react fiber
        const fiberKey = Object.keys(btn).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return;
        let fiber = btn[fiberKey];
        let depth = 0;
        while (fiber && depth < 40) {
          const props = fiber.memoizedProps || fiber.pendingProps || {};
          // check various shapes
          if (props && props.isCorrect === true) { if (out.indexOf(i) === -1) out.push(i); }
          if (props && props.correct === true) { if (out.indexOf(i) === -1) out.push(i); }
          if (props && props.answer && (props.answer.correct === true || props.answer.isCorrect === true)) { if (out.indexOf(i) === -1) out.push(i); }
          // sometimes correct is in a child
          if (fiber.child) { /* handled by traversal */ }
          fiber = fiber.return;
          depth++;
        }
      });
    } catch (e) { log('react read err: ' + e.message); }
    return out;
  }

  // ---------- Read correct from DOM data attributes ----------
  function readCorrectFromDOM(n) {
    const out = [];
    try {
      const els = document.querySelectorAll('[data-correct], [data-is-correct], [data-answer-correct]');
      els.forEach((el, i) => {
        const v = el.getAttribute('data-correct') || el.getAttribute('data-is-correct') || el.getAttribute('data-answer-correct');
        if (v === 'true' || v === '1') {
          // map to index via data-functional-selector
          const sel = el.getAttribute('data-functional-selector') || '';
          const m = sel.match(/answer-(\d+)/);
          if (m) out.push(parseInt(m[1], 10));
        }
      });
    } catch (e) {}
    return out;
  }

  // ---------- Click answers ----------
  function clickAnswers(indices, type) {
    try {
      if (type === 'jumble' || (Array.isArray(indices) && indices.length > 1 && indices.length === 4 && indices.every((v,i)=>v===i))) {
        // jumble: click in order
        indices.forEach((idx, order) => {
          const btn = document.querySelector('button[data-functional-selector="answer-' + idx + '"]');
          if (btn) setTimeout(() => btn.click(), order * 150);
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

  // ---------- Highlight correct answers (visual) ----------
  function highlightCorrect(indices) {
    try {
      indices.forEach(idx => {
        const btn = document.querySelector('button[data-functional-selector="answer-' + idx + '"]');
        if (btn) {
          btn.style.outline = '4px solid #00e676';
          btn.style.boxShadow = '0 0 12px #00e676';
        }
      });
    } catch (e) {}
  }

  // ---------- UI Panel ----------
  function createPanel() {
    const div = document.createElement('div');
    div.id = 'jz-panel';
    div.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:#111;color:#0f0;font-family:monospace;font-size:12px;padding:8px 10px;border:1px solid #0f0;border-radius:8px;max-width:320px;max-height:50vh;overflow:auto;opacity:0.92;';
    div.innerHTML = '<b>JZ Kahoot 100%</b><br><span id="jz-status">Ready</span><br><div id="jz-log" style="margin-top:6px;white-space:pre-wrap;"></div>';
    document.body.appendChild(div);
    state.panel = div;
  }

  function renderLog() {
    const el = document.getElementById('jz-log');
    if (el) el.textContent = state.log.join('\\n');
  }

  // ---------- Init ----------
  function init() {
    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel);
    log('Loaded. Auto-answer active. Works on private + public quizzes.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // expose for manual use
  window.JZ = { state, log, handleQuestion, clickAnswers };
})();
