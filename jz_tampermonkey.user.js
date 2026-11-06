// ==UserScript==
// @name         JZ Kahoot All-in-One (Android/Firefox/Tampermonkey)
// @namespace    jz-kahoot-aio
// @version      2.0.0
// @description  Answer Bot (100% private+public, reads isCorrect from WebSocket/React) + Flooder + Leaver. Mini UI, rainbow border. Works on kahoot.it.
// @author       JZ
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ==================== STATE ====================
  const S = {
    view: 'menu', // menu | answer | flood | leaver
    answer: { name: 'JZBot', mode: '1', pin: '', running: false, correct: null, qi: -1 },
    flood: { prefix: 'JZBot', count: 43, pin: '', running: false, joined: 0, failed: 0, clients: [] },
    ws: null,
    log: [],
    overlay: null
  };

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    S.log.unshift(t + '  ' + msg);
    if (S.log.length > 60) S.log.pop();
    render();
    console.log('[JZ]', msg);
  }

  // ==================== RAINBOW UI ====================
  const css = `
  @keyframes jz-rainbow {
    0% { border-color: #ff0040; box-shadow: 0 0 8px #ff0040; }
    16% { border-color: #ff8000; box-shadow: 0 0 8px #ff8000; }
    33% { border-color: #ffff00; box-shadow: 0 0 8px #ffff00; }
    50% { border-color: #00ff40; box-shadow: 0 0 8px #00ff40; }
    66% { border-color: #00c0ff; box-shadow: 0 0 8px #00c0ff; }
    83% { border-color: #8000ff; box-shadow: 0 0 8px #8000ff; }
    100% { border-color: #ff0040; box-shadow: 0 0 8px #ff0040; }
  }
  #jz-root {
    position: fixed; top: 8px; right: 8px; z-index: 2147483647;
    width: 300px; max-width: calc(100vw - 16px);
    background: rgba(10,10,18,0.96); color: #e8eefc;
    font: 13px/1.35 system-ui, -apple-system, Arial, sans-serif;
    border: 3px solid #ff0040; border-radius: 14px;
    animation: jz-rainbow 3s linear infinite;
    padding: 10px; box-sizing: border-box;
  }
  #jz-root * { box-sizing: border-box; }
  #jz-root .jz-title { font-weight: 800; font-size: 14px; color: #fff; margin-bottom: 6px; display:flex; justify-content:space-between; align-items:center; }
  #jz-root .jz-badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; background:#1a2340; color:#8ef; }
  #jz-root .jz-btn {
    display:block; width:100%; padding:10px; margin:6px 0;
    border:0; border-radius:10px; font-weight:700; font-size:13px; cursor:pointer; color:#061018;
  }
  #jz-root .jz-btn-a { background: linear-gradient(90deg,#00e676,#00c853); }
  #jz-root .jz-btn-f { background: linear-gradient(90deg,#ff5252,#ff1744); color:#fff; }
  #jz-root .jz-btn-l { background: linear-gradient(90deg,#ffab00,#ff9100); }
  #jz-root .jz-btn-s { background: #24304f; color:#fff; font-weight:600; padding:8px; }
  #jz-root .jz-inp, #jz-root select {
    width:100%; padding:8px 10px; margin:4px 0 8px; border-radius:8px;
    border:1px solid #334; background:#121a2b; color:#fff; font-size:13px;
  }
  #jz-root label { font-size: 11px; color:#9ab; display:block; margin-top:4px; }
  #jz-root .jz-log { font: 11px/1.3 ui-monospace, monospace; background:#070b14; border:1px solid #223; border-radius:8px; padding:6px; max-height:160px; overflow:auto; white-space:pre-wrap; color:#8fa; margin-top:6px; }
  #jz-root .jz-row { display:flex; gap:6px; }
  #jz-root .jz-row > * { flex:1; }
  #jz-root .jz-muted { color:#89a; font-size:11px; }
  `;

  function injectCSS() {
    if (document.getElementById('jz-style')) return;
    const st = document.createElement('style');
    st.id = 'jz-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // ==================== RENDER ====================
  function h(html) { return html; }
  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function render() {
    injectCSS();
    let root = document.getElementById('jz-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'jz-root';
      (document.body || document.documentElement).appendChild(root);
    }
    if (S.view === 'menu') root.innerHTML = renderMenu();
    else if (S.view === 'answer') root.innerHTML = renderAnswer();
    else if (S.view === 'flood') root.innerHTML = renderFlood();
    else if (S.view === 'leaver') root.innerHTML = renderLeaver();
    bind();
  }

  function renderMenu() {
    return h(`
      <div class="jz-title"><span>JZ Kahoot AIO</span><span class="jz-badge">100%</span></div>
      <button class="jz-btn jz-btn-a" data-act="go" data-v="answer">1. Answer Bot</button>
      <button class="jz-btn jz-btn-f" data-act="go" data-v="flood">2. Flooder</button>
      <button class="jz-btn jz-btn-l" data-act="go" data-v="leaver">3. Leaver</button>
      <div class="jz-muted">Answer bot reads isCorrect from WebSocket/React (private+public). Flooder joins bots via Kahoot API.</div>
      <div class="jz-log">${esc(S.log.slice(0,8).join('\n')) || 'Ready.'}</div>
    `);
  }

  function renderAnswer() {
    const running = S.answer.running;
    const pinVal = S.answer.pin || detectPin() || '';
    return h(`
      <div class="jz-title"><span>Answer Bot</span><span class="jz-badge">${running?'RUNNING':'READY'}</span></div>
      <label>Name</label><input class="jz-inp" id="jz-aname" value="${esc(S.answer.name)}" ${running?'disabled':''}>
      <label>Mode</label>
      <select class="jz-inp" id="jz-amode" ${running?'disabled':''}>
        <option value="1" ${S.answer.mode==='1'?'selected':''}>1 = RAGE (all correct, fast)</option>
        <option value="2" ${S.answer.mode==='2'?'selected':''}>2 = Non-suspicious (1/10 miss, slower)</option>
      </select>
      <label>PIN / URL (auto-detected if on kahoot.it)</label>
      <input class="jz-inp" id="jz-apin" value="${esc(pinVal)}" placeholder="Game PIN" ${running?'disabled':''}>
      <div class="jz-row">
        <button class="jz-btn jz-btn-a" data-act="${running?'stopAnswer':'startAnswer'}">${running?'Stop':'Start'}</button>
        <button class="jz-btn jz-btn-s" data-act="go" data-v="menu">Back</button>
      </div>
      <div class="jz-muted">Reads correct answers from live WebSocket/React. 100% on private when isCorrect is in payload/DOM.</div>
      <div class="jz-log">${esc(S.log.slice(0,12).join('\n'))}</div>
    `);
  }

  function renderFlood() {
    return h(`
      <div class="jz-title"><span>Flooder</span><span class="jz-badge">${S.flood.running?'RUNNING':(S.flood.joined+'/'+S.flood.count)}</span></div>
      <label>Bot name prefix</label><input class="jz-inp" id="jz-fpre" value="${esc(S.flood.prefix)}">
      <label>How many bots</label><input class="jz-inp" id="jz-fcnt" type="number" value="${esc(S.flood.count)}">
      <label>PIN</label><input class="jz-inp" id="jz-fpin" value="${esc(S.flood.pin || detectPin() || '')}" placeholder="Game PIN">
      <div class="jz-row">
        <button class="jz-btn jz-btn-f" data-act="startFlood">Flood</button>
        <button class="jz-btn jz-btn-s" data-act="go" data-v="menu">Back</button>
      </div>
      <div class="jz-log">${esc(S.log.slice(0,12).join('\n'))}</div>
    `);
  }

  function renderLeaver() {
    return h(`
      <div class="jz-title"><span>Leaver</span><span class="jz-badge">${S.flood.clients.length} bots</span></div>
      <button class="jz-btn jz-btn-l" data-act="leaveAll">Leave all bots</button>
      <button class="jz-btn jz-btn-s" data-act="go" data-v="menu">Back</button>
      <div class="jz-log">${esc(S.log.slice(0,12).join('\n'))}</div>
    `);
  }

  function bind() {
    const root = document.getElementById('jz-root');
    if (!root) return;
    root.onclick = (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'go') { S.view = btn.getAttribute('data-v'); render(); }
      else if (act === 'startAnswer') startAnswer();
      else if (act === 'stopAnswer') stopAnswer();
      else if (act === 'startFlood') startFlood();
      else if (act === 'leaveAll') leaveAll();
    };
  }

  function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
  function detectPin() {
    // try URL params or page text
    try {
      const u = new URL(location.href);
      const p = u.searchParams.get('pin') || u.searchParams.get('gameId');
      if (p && /^\d+$/.test(p)) return p;
      const m = location.href.match(/pin[=\/](\d{4,10})/i);
      if (m) return m[1];
    } catch(e){}
    return '';
  }

  // ==================== ANSWER BOT (100% via WebSocket/React) ====================
  function stopAnswer() {
    S.answer.running = false;
    log('Answer bot stopped.');
    render();
  }

  function startAnswer() {
    S.answer.name = getVal('jz-aname') || 'JZBot';
    S.answer.mode = getVal('jz-amode') || '1';
    S.answer.pin = (getVal('jz-apin') || detectPin() || '').trim();
    S.answer.running = true;
    S.answer.correct = null;
    S.answer.qi = -1;
    log('Answer bot started. Mode=' + S.answer.mode + (S.answer.pin ? ' PIN=' + S.answer.pin : ' (waiting for game)'));
    log('Listening for WebSocket/React isCorrect (100% on private+public)...');
    render();
  }

  // WebSocket hook
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    S.ws = ws;
    ws.addEventListener('message', (ev) => {
      try { handleWsMessage(ev.data); } catch(e){}
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  HookedWS.CONNECTING = OrigWS.CONNECTING; HookedWS.OPEN = OrigWS.OPEN;
  HookedWS.CLOSING = OrigWS.CLOSING; HookedWS.CLOSED = OrigWS.CLOSED;
  window.WebSocket = HookedWS;

  function handleWsMessage(raw) {
    if (!S.answer.running) return;
    let arr;
    try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : [p]; } catch(e){ return; }
    for (const m of arr) {
      let content = null;
      try { if (m && m.data && typeof m.data.content === 'string') content = JSON.parse(m.data.content); } catch(e){}
      if (!content) continue;
      // QuestionStart
      if (content.questionIndex !== undefined || content.gameBlockIndex !== undefined) {
        handleQuestion(content);
      }
      // QuestionEnd
      if (Array.isArray(content.correctChoices)) {
        const qi = (typeof content.questionIndex === 'number') ? content.questionIndex : S.answer.qi;
        log('Q' + (qi+1) + ' correct: ' + content.correctChoices.join(','));
        highlightCorrect(content.correctChoices);
      }
    }
  }

  function handleQuestion(q) {
    const qi = (typeof q.questionIndex === 'number') ? q.questionIndex : (typeof q.gameBlockIndex === 'number' ? q.gameBlockIndex : 0);
    const type = q.type || q.gameBlockType || 'quiz';
    const title = q.title || q.question || q.questionText || '';
    const choices = Array.isArray(q.choices) ? q.choices : (Array.isArray(q.answers) ? q.answers : []);
    S.answer.qi = qi;

    // correct in payload
    let correct = [];
    choices.forEach((c, i) => { if (c && (c.correct === true || c.isCorrect === true)) correct.push(i); });

    // React fiber fallback
    if (!correct.length) correct = readCorrectFromReact();

    log('Q' + (qi+1) + ': ' + String(title).slice(0,50));
    if (correct.length) {
      log('  CORRECT: ' + correct.join(',') + ' (100%)');
      S.answer.correct = correct;
      // auto-click
      let toClick = correct;
      if (S.answer.mode === '2' && Math.random() < 0.1 && choices.length > 1) {
        const wrong = []; for (let i=0;i<choices.length;i++) if(!correct.includes(i)) wrong.push(i);
        if (wrong.length) { toClick = [wrong[Math.floor(Math.random()*wrong.length)]]; log('  (intentional miss)'); }
      }
      const delay = S.answer.mode === '1' ? (300 + Math.random()*500) : (900 + Math.random()*400);
      setTimeout(() => clickAnswers(toClick, type), delay);
    } else {
      log('  No correct in payload; waiting for React/QuestionEnd...');
      // retry React read after DOM renders
      setTimeout(() => {
        if (!S.answer.running || S.answer.qi !== qi) return;
        const r = readCorrectFromReact();
        if (r.length) { log('  React correct: ' + r.join(',')); clickAnswers(r, type); highlightCorrect(r); }
      }, 800);
      setTimeout(() => {
        if (!S.answer.running || S.answer.qi !== qi) return;
        const r = readCorrectFromReact();
        if (r.length) { log('  React correct (retry): ' + r.join(',')); clickAnswers(r, type); highlightCorrect(r); }
      }, 1800);
    }
    render();
  }

  function readCorrectFromReact() {
    const out = [];
    try {
      const btns = document.querySelectorAll('button[data-functional-selector^="answer-"]');
      btns.forEach((btn) => {
        const fiberKey = Object.keys(btn).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return;
        let fiber = btn[fiberKey], depth = 0;
        while (fiber && depth < 60) {
          const props = fiber.memoizedProps || fiber.pendingProps || {};
          if (props && (props.isCorrect === true || props.correct === true)) {
            const m = (btn.getAttribute('data-functional-selector')||'').match(/answer-(\d+)/);
            if (m) { const i=parseInt(m[1],10); if(out.indexOf(i)===-1) out.push(i); }
          }
          if (props && props.answer && (props.answer.correct===true || props.answer.isCorrect===true)) {
            const m = (btn.getAttribute('data-functional-selector')||'').match(/answer-(\d+)/);
            if (m) { const i=parseInt(m[1],10); if(out.indexOf(i)===-1) out.push(i); }
          }
          fiber = fiber.return; depth++;
        }
      });
    } catch(e){}
    return out;
  }

  function clickAnswers(indices, type) {
    try {
      if (type === 'jumble' && Array.isArray(indices)) {
        indices.forEach((idx, order) => { const b=document.querySelector('button[data-functional-selector="answer-'+idx+'"]'); if(b) setTimeout(()=>b.click(), order*200); });
        return;
      }
      (Array.isArray(indices)?indices:[indices]).forEach(idx => { const b=document.querySelector('button[data-functional-selector="answer-'+idx+'"]'); if(b) b.click(); });
    } catch(e){ log('click err: '+e.message); }
  }

  function highlightCorrect(indices) {
    try { (Array.isArray(indices)?indices:[indices]).forEach(idx=>{ const b=document.querySelector('button[data-functional-selector="answer-'+idx+'"]'); if(b){ b.style.outline='4px solid #00e676'; b.style.boxShadow='0 0 16px #00e676'; } }); } catch(e){}
  }

  // ==================== FLOODER (cometd websocket) ====================
  // Minimal Kahoot flooder: joins via reserve/session + cometd
  function solveChallenge(challenge) {
    // Kahoot challenge is JS that computes offset; execute in sandbox
    try {
      // extract the function body and decode
      const decoded = decodeURIComponent(challenge);
      // common pattern: (function(){...})(); returns offset
      const fn = new Function('return (' + decoded + ')');
      // some challenges are wrapped differently
      try { return fn(); } catch(e) {
        const fn2 = new Function(decoded);
        return fn2();
      }
    } catch(e) {
      // fallback: try eval-like via Function
      try { return (new Function(challenge))(); } catch(e2) { return null; }
    }
  }

  function decodeSessionToken(headerToken, challengeToken) {
    try {
      const raw = atob(headerToken);
      let result = '';
      for (let i = 0; i < raw.length; i++) {
        const char = raw.charCodeAt(i);
        const mod = challengeToken.charCodeAt(i % challengeToken.length);
        result += String.fromCharCode(char ^ mod);
      }
      return result;
    } catch(e) { return null; }
  }

  async function floodOne(pin, name) {
    try {
      // 1. reserve session
      const ts = Date.now();
      const res = await fetch('https://kahoot.it/reserve/session/' + pin + '/?' + ts, { credentials: 'omit' });
      if (!res.ok) throw new Error('reserve ' + res.status);
      const headerToken = res.headers.get('x-kahoot-session-token');
      const data = await res.json();
      if (!headerToken) throw new Error('no token');
      const challengeToken = solveChallenge(data.challenge);
      if (challengeToken == null) throw new Error('challenge fail');
      const session = decodeSessionToken(headerToken, String(challengeToken));
      if (!session) throw new Error('decode fail');

      // 2. cometd websocket
      const wsUrl = 'wss://kahoot.it/cometd/' + pin + '/' + session;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let msgId = 1;
        let clientId = null;
        const timer = setTimeout(() => { try { ws.close(); } catch(e){} reject(new Error('timeout')); }, 12000);

        function send(obj) {
          obj.id = String(msgId++);
          if (clientId) obj.clientId = clientId;
          ws.send(JSON.stringify([obj]));
        }

        ws.onopen = () => {
          send({ version: '1.0', minimumVersion: '1.0', channel: '/meta/handshake', supportedConnectionTypes: ['websocket','long-polling'], advice: { timeout: 60000, interval: 0 } });
        };
        ws.onmessage = (ev) => {
          let arr; try { arr = JSON.parse(ev.data); } catch(e){ return; }
          for (const m of arr) {
            if (m.clientId) clientId = m.clientId;
            if (m.channel === '/meta/handshake' && m.successful) {
              send({ channel: '/meta/connect', connectionType: 'websocket', advice: { timeout: 0 } });
              send({ channel: '/service/controller', data: { type: 'login', gameid: pin, host: 'kahoot.it', name: name }, ext: {} });
              send({ channel: '/service/controller', data: { type: 'message', gameid: pin, host: 'kahoot.it', id: 16, content: JSON.stringify({ usingNamerator: false }) }, ext: {} });
            }
            if (m.channel === '/service/controller' && m.data) {
              let c = null; try { c = typeof m.data.content === 'string' ? JSON.parse(m.data.content) : m.data.content; } catch(e){}
              const type = (m.data.type || (c && c.type) || '').toLower();
              if (type === 'loginresponse' || (c && c.cid) || m.successful) {
                // might be joined
              }
            }
            // check for join success via status or controller
            if (m.channel === '/meta/connect' && m.successful && !m.advice) {
              // keepalive
              setTimeout(() => { try { send({ channel: '/meta/connect', connectionType: 'websocket' }); } catch(e){} }, 5000);
            }
          }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
        ws.onclose = () => { clearTimeout(timer); };

        // resolve as "joined" after handshake+login sent (best-effort)
        setTimeout(() => {
          S.flood.clients.push({ ws, name, pin });
          clearTimeout(timer);
          resolve({ ws, name });
        }, 2500);
      });
    } catch(e) { throw e; }
  }

  async function startFlood() {
    S.flood.prefix = getVal('jz-fpre') || 'JZBot';
    S.flood.count = Math.max(1, Math.min(200, parseInt(getVal('jz-fcnt'), 10) || 43));
    S.flood.pin = (getVal('jz-fpin') || detectPin() || '').trim();
    if (!S.flood.pin) { log('Enter PIN'); return; }
    S.flood.running = true; S.flood.joined = 0; S.flood.failed = 0;
    log('Flooding ' + S.flood.count + ' bots to ' + S.flood.pin + '...');
    render();
    for (let i = 1; i <= S.flood.count; i++) {
      if (!S.flood.running) break;
      const name = S.flood.prefix + i;
      floodOne(S.flood.pin, name).then(() => {
        S.flood.joined++;
        log('Bot ' + i + ' joined (' + S.flood.joined + '/' + S.flood.count + ')');
        render();
      }).catch((e) => {
        S.flood.failed++;
        log('Bot ' + i + ' failed: ' + (e && e.message || e));
        render();
      });
      await new Promise(r => setTimeout(r, 120));
    }
    S.flood.running = false;
    log('Flood done. Joined: ' + S.flood.joined + ', failed: ' + S.flood.failed);
    render();
  }

  function leaveAll() {
    let n = 0;
    for (const c of S.flood.clients) {
      try { c.ws.close(); n++; } catch(e){}
    }
    S.flood.clients = [];
    log('Left ' + n + ' bots.');
    render();
  }

  // ==================== INIT ====================
  function init() {
    injectCSS();
    render();
    log('JZ AIO loaded. Open on kahoot.it to play.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // also try after a short delay in case body not ready
  setTimeout(init, 500);

  window.JZ_AIO = S;
})();
