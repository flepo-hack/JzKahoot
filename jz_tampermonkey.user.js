// ==UserScript==
// @name         JZ Kahoot AIO v4 (Android/Firefox/Tampermonkey)
// @namespace    jz-kahoot-aio
// @version      4.0.0
// @description  Answer Bot 100% (private+public via isCorrect in WS/React/DOM) + Flooder (fixed challenge solver) + Leaver. Rainbow UI, auto-detect PIN.
// @author       JZ
// @match        https://kahoot.it/*
// @match        https://play.kahoot.it/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const S = {
    view: 'menu',
    inGame: false,
    detectedPin: '',
    answer: { name: 'JZBot', mode: '1', pin: '', running: false, qi: -1, lastCorrect: null },
    flood: { prefix: 'JZBot', count: 43, pin: '', running: false, joined: 0, failed: 0, clients: [] },
    log: [],
    wsHooked: false
  };

  function log(msg) {
    const t = new Date().toLocaleTimeString();
    S.log.unshift(t + ' ' + msg);
    if (S.log.length > 100) S.log.pop();
    render();
    try { console.log('[JZ]', msg); } catch(e){}
  }

  // ==================== CSS ====================
  const CSS = `
  @keyframes jz-rain { 0%{border-color:#ff0040;box-shadow:0 0 14px rgba(255,0,64,.4)} 16%{border-color:#ff8000;box-shadow:0 0 14px rgba(255,128,0,.4)} 33%{border-color:#ffe600;box-shadow:0 0 14px rgba(255,230,0,.4)} 50%{border-color:#00e676;box-shadow:0 0 14px rgba(0,230,118,.4)} 66%{border-color:#00c0ff;box-shadow:0 0 14px rgba(0,192,255,.4)} 83%{border-color:#8000ff;box-shadow:0 0 14px rgba(128,0,255,.4)} 100%{border-color:#ff0040;box-shadow:0 0 14px rgba(255,0,64,.4)} }
  @keyframes jz-glow { 0%,100%{opacity:.92} 50%{opacity:1} }
  #jz-root{position:fixed;top:10px;right:10px;z-index:2147483647;width:330px;max-width:calc(100vw - 20px);background:linear-gradient(180deg,rgba(12,14,28,.98),rgba(8,10,20,.98));color:#eaf2ff;font:13px/1.35 system-ui,-apple-system,Segoe UI,Arial,sans-serif;border:3px solid;border-radius:16px;animation:jz-rain 2.5s linear infinite,jz-glow 2s ease-in-out infinite;padding:12px;box-sizing:border-box;backdrop-filter:blur(6px)}
  #jz-root *{box-sizing:border-box}
  .jz-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .jz-title{font-weight:900;font-size:15px;letter-spacing:.2px;background:linear-gradient(90deg,#ff4d6d,#ffd166,#06d6a0,#4cc9f0,#b388ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .jz-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(76,201,240,.15);color:#7ee7ff}
  .jz-dot{width:8px;height:8px;border-radius:50%;background:#555;display:inline-block;margin-right:6px;flex:0 0 8px}
  .jz-dot.on{background:#00e676;box-shadow:0 0 8px #00e676}
  .jz-sub{font-size:11px;color:#8ea4c7;margin:4px 0 8px}
  .jz-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:8px;margin:6px 0}
  .jz-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px 12px;margin:6px 0;border:0;border-radius:12px;font-weight:800;font-size:13px;cursor:pointer;transition:transform .08s,filter .12s}
  .jz-btn:active{transform:scale(.98)}
  .jz-a{background:linear-gradient(135deg,#00e676,#00bfa5);color:#042016}
  .jz-f{background:linear-gradient(135deg,#ff5252,#ff1744,#ff9100);color:#fff}
  .jz-l{background:linear-gradient(135deg,#ffd166,#ffab00);color:#2a1a00}
  .jz-s{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.08);font-weight:700;padding:9px}
  .jz-row{display:flex;gap:6px}.jz-row>*{flex:1}
  .jz-lbl{font-size:11px;color:#9bb0d3;margin:6px 0 3px;display:block}
  .jz-inp,#jz-root select{width:100%;padding:10px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.25);color:#fff;font-size:13px;outline:none}
  .jz-inp:focus,#jz-root select:focus{border-color:#4cc9f0;box-shadow:0 0 0 2px rgba(76,201,240,.15)}
  .jz-log{font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:7px;max-height:180px;overflow:auto;white-space:pre-wrap;color:#b7ffd0;margin-top:8px}
  .jz-ok{color:#00e676}.jz-warn{color:#ffd166}.jz-err{color:#ff6b8a}
  `;

  function injectCSS() { if(document.getElementById('jz-css'))return; const s=document.createElement('style'); s.id='jz-css'; s.textContent=CSS; (document.head||document.documentElement).appendChild(s); }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function gv(id){ const e=document.getElementById(id); return e?String(e.value||'').trim():''; }

  // ==================== DETECTION ====================
  function detectPin() {
    try {
      const u = new URL(location.href);
      for (const k of ['pin','gameId','gameid','quizId']) { const v=u.searchParams.get(k); if(v && /^\d{4,10}$/.test(v)) return v; }
      const m = location.href.match(/(?:pin|gameId|gameid)[=\/](\d{4,10})/i); if(m) return m[1];
      const inp = document.querySelector('input[name="gameId"],input[data-functional-selector="game-pin-input"],input[placeholder*="PIN" i],input[aria-label*="PIN" i],input[type="tel"],input[type="number"]');
      if (inp && inp.value && /^\d{4,10}$/.test(inp.value.trim())) return inp.value.trim();
      // from any input
      for (const i of document.querySelectorAll('input')) { if (i.value && /^\d{4,10}$/.test(i.value.trim())) return i.value.trim(); }
    } catch(e){}
    return S.detectedPin || '';
  }
  function detectInGame() {
    try {
      if (document.querySelector('button[data-functional-selector^="answer-"]')) return true;
      if (document.querySelector('[data-functional-selector*="question"]')) return true;
      if (/gameblock|answer|getready|start/i.test(location.pathname)) return true;
    } catch(e){}
    return false;
  }
  function updateDet(){ S.detectedPin = detectPin() || S.detectedPin; S.inGame = detectInGame(); }

  // ==================== RENDER ====================
  function render() {
    try {
      injectCSS(); updateDet();
      let root = document.getElementById('jz-root');
      if (!root) { root=document.createElement('div'); root.id='jz-root'; (document.body||document.documentElement).appendChild(root); }
      if (S.view==='menu') root.innerHTML = menuHTML();
      else if (S.view==='answer') root.innerHTML = answerHTML();
      else if (S.view==='flood') root.innerHTML = floodHTML();
      else if (S.view==='leaver') root.innerHTML = leaverHTML();
      bind();
    } catch(e){ try{console.error('[JZ] render',e);}catch(_){} }
  }
  function bind() {
    const root=document.getElementById('jz-root'); if(!root) return;
    root.onclick = (e) => {
      const b=e.target.closest('[data-act]'); if(!b) return;
      const a=b.getAttribute('data-act');
      try {
        if (a==='go') { S.view=b.getAttribute('data-v'); render(); }
        else if (a==='startAnswer') startAnswer();
        else if (a==='stopAnswer') stopAnswer();
        else if (a==='startFlood') startFlood();
        else if (a==='leaveAll') leaveAll();
        else if (a==='toggleAuto') { S.answer.running=!S.answer.running; log(S.answer.running?'Answer bot: ON':'Answer bot: OFF'); render(); }
      } catch(err){ log('UI error: '+(err&&err.message||err)); }
    };
  }

  function menuHTML(){
    const pin = S.detectedPin || detectPin();
    return `
      <div class="jz-h"><div class="jz-title">⚡ JZ Kahoot AIO</div><span class="jz-pill">${S.inGame?'IN GAME':'READY'}</span></div>
      <div class="jz-sub"><span class="jz-dot ${S.inGame?'on':''}"></span>${S.inGame?'Game detected.':'Join a game or start a mode.'}${pin?' PIN: '+esc(pin):''}</div>
      <button class="jz-btn jz-a" data-act="go" data-v="answer">🎯 1. Answer Bot</button>
      <button class="jz-btn jz-f" data-act="go" data-v="flood">💥 2. Flooder</button>
      <button class="jz-btn jz-l" data-act="go" data-v="leaver">🚪 3. Leaver</button>
      <div class="jz-log">${esc(S.log.slice(0,6).join('\n'))||'Ready.'}</div>`;
  }

  function answerHTML(){
    const pin = S.answer.pin || S.detectedPin || detectPin() || '';
    const running = S.answer.running;
    const inGame = S.inGame || detectInGame();
    return `
      <div class="jz-h"><div class="jz-title">🎯 Answer Bot</div><span class="jz-pill">${running?'RUNNING':'SETUP'}</span></div>
      <div class="jz-card">
        <div class="jz-sub">${inGame?'<span class="jz-ok">✓ In game</span> — PIN auto-read. Just start.':'Not in game. Enter PIN+name, I’ll join for you.'}</div>
        <label class="jz-lbl">Name</label>
        <input class="jz-inp" id="a-name" value="${esc(S.answer.name)}" placeholder="Nickname">
        <label class="jz-lbl">Mode</label>
        <select id="a-mode" class="jz-inp">
          <option value="1" ${S.answer.mode==='1'?'selected':''}>1 — RAGE (all correct, 300–800ms)</option>
          <option value="2" ${S.answer.mode==='2'?'selected':''}>2 — Legit (1/10 miss, ~900–1300ms)</option>
        </select>
        <label class="jz-lbl">PIN ${inGame?'<span class="jz-ok">(auto)</span>':''}</label>
        <input class="jz-inp" id="a-pin" value="${esc(pin)}" placeholder="${inGame?'Auto-detected':'e.g. 1234567'}" inputmode="numeric">
      </div>
      <div class="jz-row">
        <button class="jz-btn ${running?'jz-l':'jz-a'}" data-act="${running?'stopAnswer':'startAnswer'}">${running?'⏹ Stop':'▶ Start'}</button>
        <button class="jz-btn jz-s" data-act="go" data-v="menu">← Back</button>
      </div>
      <div class="jz-sub">Reads <b>isCorrect</b> from WebSocket + React fiber. Auto-clicks correct (private+public).</div>
      <div class="jz-log">${esc(S.log.slice(0,14).join('\n'))||'Waiting…'}</div>`;
  }

  function floodHTML(){
    const pin = S.flood.pin || S.detectedPin || detectPin() || '';
    return `
      <div class="jz-h"><div class="jz-title">💥 Flooder</div><span class="jz-pill">${S.flood.joined}/${S.flood.count}</span></div>
      <div class="jz-card">
        <label class="jz-lbl">Bot name prefix</label>
        <input class="jz-inp" id="f-pre" value="${esc(S.flood.prefix)}" placeholder="JZBot">
        <label class="jz-lbl">How many bots (default 43)</label>
        <input class="jz-inp" id="f-cnt" type="number" min="1" max="200" value="${esc(S.flood.count)}">
        <label class="jz-lbl">PIN</label>
        <input class="jz-inp" id="f-pin" value="${esc(pin)}" placeholder="Game PIN" inputmode="numeric">
      </div>
      <div class="jz-row">
        <button class="jz-btn jz-f" data-act="startFlood" ${S.flood.running?'disabled':''}>${S.flood.running?'⏳ Running…':'💥 Flood'}</button>
        <button class="jz-btn jz-s" data-act="go" data-v="menu">← Back</button>
      </div>
      <div class="jz-log">${esc(S.log.slice(0,14).join('\n'))||'Ready.'}</div>`;
  }

  function leaverHTML(){
    return `
      <div class="jz-h"><div class="jz-title">🚪 Leaver</div><span class="jz-pill">${S.flood.clients.length} bots</span></div>
      <div class="jz-card"><div class="jz-sub">Closes all flooder bot connections for this page session.</div></div>
      <button class="jz-btn jz-l" data-act="leaveAll">🚪 Leave all bots</button>
      <button class="jz-btn jz-s" data-act="go" data-v="menu">← Back</button>
      <div class="jz-log">${esc(S.log.slice(0,10).join('\n'))}</div>`;
  }

  function bindUI(){
    const root = document.getElementById('jz-root'); if(!root) return;
    root.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if(!b) return;
      const a = b.getAttribute('data-act');
      try {
        if (a==='go') { S.view=b.getAttribute('data-v'); render(); }
        else if (a==='startAnswer') startAnswer();
        else if (a==='stopAnswer') stopAnswer();
        else if (a==='startFlood') startFlood();
        else if (a==='leaveAll') leaveAll();
      } catch(err){ log('UI error: '+(err&&err.message||err)); }
    };
  }

  function gv(id){ const e=document.getElementById(id); return e?String(e.value||'').trim():''; }

  // ==================== AUTO-JOIN (if not in game) ====================
  function setNativeValue(el, value) {
    try { const last=el.value; el.value=value; const t=el._valueTracker; if(t) t.setValue(last); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    catch(e){ try{el.value=value;}catch(_){} }
  }

  function tryAutoJoin(pin, name) {
    return new Promise((resolve) => {
      try {
        pin=String(pin||'').trim(); name=String(name||'JZBot').trim();
        if (!/^\d{4,10}$/.test(pin)) { resolve(false); return; }
        // find PIN input
        const pinInput = document.querySelector('input[name="gameId"], input[data-functional-selector="game-pin-input"], input[placeholder*="PIN" i], input[aria-label*="PIN" i], input[type="tel"], input[type="number"], input[inputmode="numeric"]');
        if (pinInput) {
          setNativeValue(pinInput, pin);
          setTimeout(() => {
            const btn = document.querySelector('button[type="submit"], button[data-functional-selector="join-game-pin"], button');
            if (btn) btn.click();
            setTimeout(() => fillNickname(name), 900);
            setTimeout(() => fillNickname(name), 2000);
            resolve(true);
          }, 250);
          return;
        }
        // navigate to join page
        try { sessionStorage.setItem('jz_name',name); sessionStorage.setItem('jz_pin',pin); sessionStorage.setItem('jz_autojoin','1'); } catch(e){}
        location.href = 'https://kahoot.it/?pin=' + encodeURIComponent(pin);
        resolve(true);
      } catch(e){ resolve(false); }
    });
  }

  function fillNickname(name) {
    try {
      name = name || sessionStorage.getItem('jz_name') || 'JZBot';
      const nick = document.querySelector('input[name="nickname"], input[data-functional-selector="username-input"], input[placeholder*="nick" i], input[aria-label*="nick" i]');
      if (nick && !nick.__jzFilled) {
        setNativeValue(nick, name);
        nick.__jzFilled = true;
        setTimeout(() => {
          const btn = document.querySelector('button[type="submit"], button[data-functional-selector="join-button-username"]');
          if (btn) btn.click();
        }, 300);
      }
    } catch(e){}
  }

  function resumeAutoJoin() {
    try {
      if (sessionStorage.getItem('jz_autojoin') === '1') {
        const name = sessionStorage.getItem('jz_name') || 'JZBot';
        const pin = sessionStorage.getItem('jz_pin') || '';
        setTimeout(() => { try { sessionStorage.removeItem('jz_autojoin'); } catch(e){} }, 8000);
        [600,1400,2600,4000].forEach(ms => setTimeout(() => fillNickname(name), ms));
        if (pin) setTimeout(() => tryAutoJoin(pin, name), 500);
      }
    } catch(e){}
  }

  // ==================== ANSWER BOT ====================
  function startAnswer() {
    S.answer.name = gv('a-name') || 'JZBot';
    S.answer.mode = gv('a-mode') || '1';
    S.answer.pin = gv('a-pin') || S.detectedPin || detectPin() || '';
    S.answer.running = true; S.answer.qi = -1; S.answer.lastCorrect = null;
    const inGame = S.inGame || detectInGame();
    if (!inGame && /^\d{4,10}$/.test(S.answer.pin)) {
      log('Not in game — auto-joining PIN ' + S.answer.pin + ' as ' + S.answer.name + '…');
      tryAutoJoin(S.answer.pin, S.answer.name);
    } else if (inGame) {
      log('In game — listening (WebSocket/React isCorrect).');
    } else {
      log('Enter a PIN, or join the game first.');
    }
    log('Answer bot: ON.');
    render();
  }
  function stopAnswer(){ S.answer.running=false; log('Answer bot: OFF.'); render(); }

  // WebSocket hook
  function installWsHook() {
    if (S.wsHooked) return;
    S.wsHooked = true;
    const Orig = window.WebSocket;
    function HWS(url, protos) {
      const ws = protos ? new Orig(url, protos) : new Orig(url);
      ws.addEventListener('message', (ev) => { try { onWsMessage(ev.data); } catch(e){} });
      let _om = null;
      try {
        const desc = Object.getOwnPropertyDescriptor(Orig.prototype, 'onmessage');
        if (desc && desc.set) {
          Object.defineProperty(ws, 'onmessage', { configurable:true, get(){ return _om; }, set(fn){ _om = function(ev){ try{onWsMessage(ev.data);}catch(e){} fn.call(ws,ev); }; desc.set.call(ws,_om); } });
        }
      } catch(e){}
      return ws;
    }
    HWS.prototype = Orig.prototype;
    HWS.CONNECTING=Orig.CONNECTING; HWS.OPEN=Orig.OPEN; HWS.CLOSING=Orig.CLOSING; HWS.CLOSED=Orig.CLOSED;
    window.WebSocket = HWS;
  }

  function onWsMessage(raw) {
    // detect PIN from any message
    try {
      const m = String(raw).match(/"gameid"\s*:\s*"?(\d{4,10})"?/i) || String(raw).match(/"pin"\s*:\s*"?(\d{4,10})"?/i);
      if (m) S.detectedPin = m[1];
    } catch(e){}
    if (!S.answer.running) return;
    let arr;
    try { const p=JSON.parse(raw); arr=Array.isArray(p)?p:[p]; } catch(e){ return; }
    for (const m of arr) {
      let c = null;
      try { if (m && m.data && typeof m.data.content === 'string') c = JSON.parse(m.data.content); } catch(e){}
      if (!c) continue;
      // QuestionStart
      if (c.questionIndex !== undefined || c.gameBlockIndex !== undefined || (m.data && (m.data.id===1||m.data.id===2))) {
        if (c.questionIndex !== undefined || c.gameBlockIndex !== undefined || c.type || c.gameBlockType) handleQuestion(c);
      }
      // QuestionEnd
      if (Array.isArray(c.correctChoices)) {
        const qi = typeof c.questionIndex==='number'?c.questionIndex:S.answer.qi;
        log('✓ Q'+(qi+1)+' correct: ['+c.correctChoices.join(',')+'] (QuestionEnd)');
        S.answer.lastCorrect = c.correctChoices;
        highlight(c.correctChoices);
      }
      // isCorrect in any choices
      if (Array.isArray(c.choices)) {
        const corr = [];
        c.choices.forEach((ch,i)=>{ if(ch && (ch.correct===true||ch.isCorrect===true||ch.correctAnswer===true)) corr.push(i); });
        if (corr.length && typeof c.questionIndex==='number') {
          S.answer.lastCorrect = corr;
          log('✓ Q'+(c.questionIndex+1)+' isCorrect in payload: ['+corr.join(',')+']');
        }
      }
    }
  }

  function handleQuestion(q) {
    const qi = typeof q.questionIndex==='number'?q.questionIndex:(typeof q.gameBlockIndex==='number'?q.gameBlockIndex:0);
    const type = q.type || q.gameBlockType || 'quiz';
    const title = q.title || q.question || q.questionText || q.text || '';
    const choices = Array.isArray(q.choices)?q.choices:(Array.isArray(q.answers)?q.answers:[]);
    S.answer.qi = qi;

    let correct = [];
    choices.forEach((c,i)=>{ if(c && (c.correct===true||c.isCorrect===true||c.correctAnswer===true)) correct.push(i); });
    if (!correct.length) correct = readReactCorrect();

    log('Q'+(qi+1)+': '+String(title).slice(0,55));
    choices.forEach((c,i)=> log('  '+i+': '+String((c&&(c.answer||c.text||c))||'').slice(0,40)));

    if (correct.length) {
      S.answer.lastCorrect = correct;
      log('→ ANSWER: ['+correct.join(',')+'] (100%)');
      scheduleClick(correct, type);
    } else {
      log('→ Scanning React/DOM for isCorrect…');
      [300,700,1200,2000,3200].forEach(ms => setTimeout(() => {
        if (!S.answer.running || S.answer.qi!==qi || S.answer.lastCorrect) return;
        const r = readReactCorrect();
        if (r.length) { S.answer.lastCorrect=r; log('→ React correct: ['+r.join(',')+']'); highlight(r); scheduleClick(r,type); }
      }, ms));
    }
    render();
  }

  function readReactCorrect() {
    const out = [];
    try {
      let btns = document.querySelectorAll('button[data-functional-selector^="answer-"]');
      if (!btns.length) btns = document.querySelectorAll('[data-functional-selector^="answer-"]');
      btns.forEach((btn) => {
        const el = btn.closest('[data-functional-selector^="answer-"]') || btn;
        const mSel = (el.getAttribute('data-functional-selector')||'').match(/answer-(\d+)/);
        if (!mSel) return;
        const idx = parseInt(mSel[1],10);
        const fiberKey = Object.keys(el).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$')) || Object.keys(btn).find(k=>k.startsWith('__reactFiber$'));
        if (!fiberKey) return;
        let fiber = (el[fiberKey]||btn[fiberKey]), depth=0;
        while (fiber && depth < 80) {
          const p = fiber.memoizedProps || fiber.pendingProps;
          if (p) {
            if (p.isCorrect===true || p.correct===true) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (p.answer && (p.answer.isCorrect===true || p.answer.correct===true)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (p.choice && (p.choice.isCorrect===true || p.choice.correct===true)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (depth < 3) {
              try {
                const s = JSON.stringify(p, (k,v)=> typeof v==='function'?undefined:v);
                if (/"isCorrect"\s*:\s*true/.test(s) || /"correct"\s*:\s*true/.test(s)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
              } catch(e){}
            }
          }
          fiber = fiber.return; depth++;
        }
      });
    } catch(e){}
    return out;
  }

  function scheduleClick(correct, type) {
    if (!S.answer.running || !correct || !correct.length) return;
    let toClick = correct;
    if (S.answer.mode==='2' && Math.random()<0.1) {
      const wrong = [0,1,2,3].filter(i=>!correct.includes(i));
      if (wrong.length) { toClick=[wrong[Math.floor(Math.random()*wrong.length)]]; log('  (legit miss)'); }
    }
    const delay = S.answer.mode==='1' ? (300+Math.random()*500) : (900+Math.random()*400);
    setTimeout(() => doClick(toClick, type), delay);
  }

  function doClick(indices, type) {
    try {
      if (!S.answer.running) return;
      highlight(indices);
      if (type==='jumble' && Array.isArray(indices)) {
        indices.forEach((idx,ord)=>{ const b=findAnswerBtn(idx); if(b) setTimeout(()=>b.click(), ord*220); });
        log('Clicked jumble.');
        return;
      }
      const arr = Array.isArray(indices)?indices:[indices];
      for (const idx of arr) { const b=findAnswerBtn(idx); if(b) b.click(); }
      log('Clicked: ['+arr.join(',')+']');
    } catch(e){ log('Click error: '+e.message); }
  }

  function findAnswerBtn(idx) {
    return document.querySelector(`button[data-functional-selector="answer-${idx}"]`)
      || document.querySelector(`[data-functional-selector="answer-${idx}"] button`)
      || document.querySelector(`[data-functional-selector="answer-${idx}"]`)
      || document.querySelectorAll('button[data-functional-selector^="answer-"]')[idx]
      || null;
  }

  function highlight(indices) {
    try {
      (Array.isArray(indices)?indices:[indices]).forEach(idx=>{
        const b=findAnswerBtn(idx);
        if(b){ b.style.outline='4px solid #00ff88'; b.style.boxShadow='0 0 18px #00ff88, inset 0 0 8px rgba(0,255,136,.25)'; b.style.transition='all .15s'; }
      });
    } catch(e){}
  }

  // ==================== CHALLENGE SOLVER (browser) ====================
  function solveChallenge(challenge) {
    try {
      let c = challenge;
      c = c.replace(/(\u0009|\u2003)/mg, '');
      c = c.replace(/this /mg, 'this');
      c = c.replace(/ *\./mg, '.');
      c = c.replace(/ *\( */mg, '(');
      c = c.replace(/ *\) */mg, ')');
      c = c.replace('console.', '');
      c = c.replace('this.angular.isObject(offset)', 'true');
      c = c.replace('this.angular.isString(offset)', 'true');
      c = c.replace('this.angular.isDate(offset)', 'true');
      c = c.replace('this.angular.isArray(offset)', 'true');
      const EVAL_ = `var _ = { replace: function(){ var args=arguments; var str=arguments[0]; return str.replace(args[1],args[2]); } }; var log=function(){}; return `;
      const solver = new Function(EVAL_ + c);
      const solved = solver();
      return String(solved);
    } catch(e) { return null; }
  }

  function decodeToken(b64Token, challengeResult) {
    try {
      const raw = atob(b64Token);
      const mask = String(challengeResult);
      let out = '';
      for (let i=0;i<raw.length;i++) out += String.fromCharCode(raw.charCodeAt(i) ^ mask.charCodeAt(i % mask.length));
      return out;
    } catch(e){ return null; }
  }

  // ==================== FLOODER ====================
  async function getSession(pin) {
    const ts = Date.now();
    const res = await fetch('https://kahoot.it/reserve/session/' + encodeURIComponent(pin) + '/?' + ts, { credentials:'omit', mode:'cors' });
    if (!res.ok) throw new Error('reserve ' + res.status + ' (bad/ended PIN?)');
    const token = res.headers.get('x-kahoot-session-token');
    const body = await res.json();
    if (!token) throw new Error('no session token');
    return { token, challenge: body.challenge };
  }

  function floodOne(pin, name) {
    return new Promise(async (resolve, reject) => {
      let ws=null, msgId=1, clientId=null, done=false;
      const finish=(ok,err)=>{ if(done) return; done=true; clearTimeout(timer); if(ok) resolve(ws); else { try{ws&&ws.close();}catch(e){} reject(err||new Error('fail')); } };
      const timer=setTimeout(()=>finish(false,new Error('timeout')),15000);
      try {
        const sess = await getSession(pin);
        const ch = solveChallenge(sess.challenge);
        if (ch==null) throw new Error('challenge solve failed');
        const session = decodeToken(sess.token, ch);
        if (!session) throw new Error('token decode failed');
        ws = new WebSocket(`wss://kahoot.it/cometd/${encodeURIComponent(pin)}/${encodeURIComponent(session)}`);
        function send(obj){ try{ obj.id=String(msgId++); if(clientId) obj.clientId=clientId; ws.send(JSON.stringify([obj])); }catch(e){} }
        ws.onopen = () => {
          send({version:'1.0',minimumVersion:'1.0',channel:'/meta/handshake',supportedConnectionTypes:['websocket','long-polling','callback-polling'],advice:{timeout:60000,interval:0},ext:{ack:true,timesync:{tc:Date.now(),l:0,o:0}}});
        };
        ws.onmessage = (ev) => {
          let arr; try{ arr=JSON.parse(ev.data); }catch(e){return;}
          for (const m of (Array.isArray(arr)?arr:[arr])) {
            if (m.clientId) clientId=m.clientId;
            if (m.channel==='/meta/handshake' && m.successful) {
              send({channel:'/meta/connect',connectionType:'websocket',advice:{timeout:0},ext:{ack:0,timesync:{tc:Date.now(),l:0,o:0}}});
              send({channel:'/meta/connect',connectionType:'websocket',ext:{ack:m.ext&&typeof m.ext.ack==='number'?m.ext.ack+1:undefined,timesync:{tc:Date.now(),l:0,o:0}}});
              send({channel:'/service/controller',data:{type:'login',gameid:String(pin),host:'kahoot.it',name:String(name),content:JSON.stringify({device:{userAgent:navigator.userAgent,screen:{width:screen.width,height:screen.height}}})},ext:{}});
            }
            if (m.channel==='/meta/connect' && m.successful) {
              const ackN = (m.ext && typeof m.ext.ack==='number') ? m.ext.ack+1 : undefined;
              setTimeout(()=>{ try{ send({channel:'/meta/connect',connectionType:'websocket',ext:{ack:ackN,timesync:{tc:Date.now(),l:0,o:0}}}); }catch(e){} }, 20000);
            }
            if (m.channel==='/service/controller' && m.data) {
              let ct=null; try{ ct=typeof m.data.content==='string'?JSON.parse(m.data.content):m.data.content; }catch(e){}
              if (m.data.type==='loginResponse' || (ct && ct.cid!=null)) {
                send({channel:'/service/controller',data:{gameid:String(pin),host:'kahoot.it',type:'message',id:16,content:JSON.stringify({usingNamerator:false})},ext:{}});
                finish(true);
              }
              if (m.data.type==='loginResponse' && m.data.error) finish(false,new Error(m.data.description||m.data.error));
            }
          }
        };
        ws.onerror = () => finish(false,new Error('ws error'));
        ws.onclose = () => { if(!done) finish(false,new Error('closed')); };
      } catch(e){ finish(false,e); }
    });
  }

  async function startFlood() {
    S.flood.prefix = gv('f-pre') || 'JZBot';
    S.flood.count = Math.max(1, Math.min(200, parseInt(gv('f-cnt'),10)||43));
    S.flood.pin = (gv('f-pin') || S.detectedPin || detectPin() || '').replace(/\D/g,'');
    if (!/^\d{4,10}$/.test(S.flood.pin)) { log('Enter a valid PIN.'); render(); return; }
    S.flood.running=true; S.flood.joined=0; S.flood.failed=0; S.flood.clients=[];
    log('Flood: '+S.flood.count+' bots → '+S.flood.pin); render();
    for (let i=1;i<=S.flood.count;i++) {
      if (!S.flood.running) break;
      const name = S.flood.prefix + i;
      floodOne(S.flood.pin, name).then(ws => {
        S.flood.joined++; S.flood.clients.push({ws,name});
        log('✓ '+name+' joined ('+S.flood.joined+'/'+S.flood.count+')'); render();
      }).catch(e => {
        S.flood.failed++; log('✗ '+name+': '+(e&&e.message||e)); render();
      });
      await new Promise(r=>setTimeout(r, 150));
    }
    S.flood.running=false; log('Flood done. Joined: '+S.flood.joined+' Failed: '+S.flood.failed); render();
  }

  function leaveAll() {
    let n=0;
    for (const c of S.flood.clients) { try{ c.ws && c.ws.close(); n++; }catch(e){} }
    S.flood.clients=[]; S.flood.joined=0; log('Left '+n+' bots.'); render();
  }

  // ==================== AUTO-JOIN ====================
  function setNativeValue(el, value) {
    try { const last=el.value; el.value=value; const t=el._valueTracker; if(t) t.setValue(last); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    catch(e){ try{el.value=value;}catch(_){} }
  }
  function tryAutoJoin(pin, name) {
    return new Promise((resolve) => {
      try {
        pin=String(pin||'').trim(); name=String(name||'JZBot').trim();
        if (!/^\d{4,10}$/.test(pin)) { resolve(false); return; }
        const pinInput = document.querySelector('input[name="gameId"], input[data-functional-selector="game-pin-input"], input[placeholder*="PIN" i], input[aria-label*="PIN" i], input[type="tel"], input[type="number"], input[inputmode="numeric"]');
        if (pinInput) {
          setNativeValue(pinInput, pin);
          setTimeout(() => {
            const btn = document.querySelector('button[type="submit"], button[data-functional-selector="join-game-pin"], button');
            if (btn) btn.click();
            setTimeout(() => fillNickname(name), 900);
            setTimeout(() => fillNickname(name), 2000);
            resolve(true);
          }, 250);
          return;
        }
        try { sessionStorage.setItem('jz_name',name); sessionStorage.setItem('jz_pin',pin); sessionStorage.setItem('jz_autojoin','1'); } catch(e){}
        location.href = 'https://kahoot.it/?pin=' + encodeURIComponent(pin);
        resolve(true);
      } catch(e){ resolve(false); }
    });
  }
  function fillNickname(name) {
    try {
      name = name || sessionStorage.getItem('jz_name') || 'JZBot';
      const nick = document.querySelector('input[name="nickname"], input[data-functional-selector="username-input"], input[placeholder*="nick" i], input[aria-label*="nick" i]');
      if (nick && !nick.__jzFilled) {
        setNativeValue(nick, name);
        nick.__jzFilled = true;
        setTimeout(() => {
          const btn = document.querySelector('button[type="submit"], button[data-functional-selector="join-button-username"]');
          if (btn) btn.click();
        }, 300);
      }
    } catch(e){}
  }
  function resumeAutoJoin() {
    try {
      if (sessionStorage.getItem('jz_autojoin') === '1') {
        const name = sessionStorage.getItem('jz_name') || 'JZBot';
        const pin = sessionStorage.getItem('jz_pin') || '';
        setTimeout(() => { try { sessionStorage.removeItem('jz_autojoin'); } catch(e){} }, 8000);
        [600,1400,2600,4000].forEach(ms => setTimeout(() => fillNickname(name), ms));
        if (pin) setTimeout(() => tryAutoJoin(pin, name), 500);
      }
    } catch(e){}
  }

  // ==================== ANSWER BOT ====================
  function startAnswer() {
    S.answer.name = gv('a-name') || 'JZBot';
    S.answer.mode = gv('a-mode') || '1';
    S.answer.pin = gv('a-pin') || S.detectedPin || detectPin() || '';
    S.answer.running = true; S.answer.qi = -1; S.answer.lastCorrect = null;
    const inGame = S.inGame || detectInGame();
    if (!inGame && /^\d{4,10}$/.test(S.answer.pin)) {
      log('Not in game — auto-joining PIN ' + S.answer.pin + ' as ' + S.answer.name + '…');
      tryAutoJoin(S.answer.pin, S.answer.name);
    } else if (inGame) {
      log('In game — listening (WebSocket/React isCorrect).');
    } else {
      log('Enter a PIN, or join the game first.');
    }
    log('Answer bot: ON (100% when isCorrect in payload/React).');
    render();
  }
  function stopAnswer(){ S.answer.running=false; log('Answer bot: OFF.'); render(); }

  // ==================== WS HOOK ====================
  function installWsHook() {
    if (S.wsHooked) return;
    S.wsHooked = true;
    const Orig = window.WebSocket;
    function HWS(url, protos) {
      const ws = protos ? new Orig(url, protos) : new Orig(url);
      ws.addEventListener('message', (ev) => { try { onWsMessage(ev.data); } catch(e){} });
      let _om = null;
      try {
        const desc = Object.getOwnPropertyDescriptor(Orig.prototype, 'onmessage');
        if (desc && desc.set) {
          Object.defineProperty(ws, 'onmessage', { configurable:true, get(){ return _om; }, set(fn){ _om = function(ev){ try{onWsMessage(ev.data);}catch(e){} fn.call(ws,ev); }; desc.set.call(ws,_om); } });
        }
      } catch(e){}
      return ws;
    }
    HWS.prototype = Orig.prototype;
    HWS.CONNECTING=Orig.CONNECTING; HWS.OPEN=Orig.OPEN; HWS.CLOSING=Orig.CLOSING; HWS.CLOSED=Orig.CLOSED;
    window.WebSocket = HWS;
  }

  function onWsMessage(raw) {
    try {
      const m = String(raw).match(/"gameid"\s*:\s*"?(\d{4,10})"?/i) || String(raw).match(/"pin"\s*:\s*"?(\d{4,10})"?/i);
      if (m) S.detectedPin = m[1];
    } catch(e){}
    if (!S.answer.running) return;
    let arr;
    try { const p=JSON.parse(raw); arr=Array.isArray(p)?p:[p]; } catch(e){ return; }
    for (const m of arr) {
      let c = null;
      try { if (m && m.data && typeof m.data.content === 'string') c = JSON.parse(m.data.content); } catch(e){}
      if (!c) continue;
      if (c.questionIndex !== undefined || c.gameBlockIndex !== undefined || (m.data && (m.data.id===1||m.data.id===2))) {
        if (c.questionIndex !== undefined || c.gameBlockIndex !== undefined || c.type || c.gameBlockType) handleQuestion(c);
      }
      if (Array.isArray(c.correctChoices)) {
        const qi = typeof c.questionIndex==='number'?c.questionIndex:S.answer.qi;
        log('✓ Q'+(qi+1)+' correct: ['+c.correctChoices.join(',')+'] (QuestionEnd)');
        S.answer.lastCorrect = c.correctChoices;
        highlight(c.correctChoices);
      }
      if (Array.isArray(c.choices)) {
        const corr = [];
        c.choices.forEach((ch,i)=>{ if(ch && (ch.correct===true||ch.isCorrect===true||ch.correctAnswer===true)) corr.push(i); });
        if (corr.length && typeof c.questionIndex==='number') {
          S.answer.lastCorrect = corr;
          log('✓ Q'+(c.questionIndex+1)+' isCorrect in payload: ['+corr.join(',')+']');
        }
      }
    }
  }

  function handleQuestion(q) {
    const qi = typeof q.questionIndex==='number'?q.questionIndex:(typeof q.gameBlockIndex==='number'?q.gameBlockIndex:0);
    const type = q.type || q.gameBlockType || 'quiz';
    const title = q.title || q.question || q.questionText || q.text || q.stem || '';
    const choices = Array.isArray(q.choices)?q.choices:(Array.isArray(q.answers)?q.answers:[]);
    S.answer.qi = qi;

    let correct = [];
    choices.forEach((c,i)=>{ if(c && (c.correct===true||c.isCorrect===true||c.correctAnswer===true)) correct.push(i); });
    if (!correct.length) correct = readReactCorrect();

    log('Q'+(qi+1)+': '+String(title).slice(0,55));
    choices.forEach((c,i)=> log('  '+i+': '+String((c&&(c.answer||c.text||c))||'').slice(0,40)));

    if (correct.length) {
      S.answer.lastCorrect = correct;
      log('→ ANSWER: ['+correct.join(',')+'] (100%)');
      scheduleClick(correct, type);
    } else {
      log('→ Scanning React/DOM for isCorrect…');
      [300,700,1200,2000,3200].forEach(ms => setTimeout(() => {
        if (!S.answer.running || S.answer.qi!==qi || S.answer.lastCorrect) return;
        const r = readReactCorrect();
        if (r.length) { S.answer.lastCorrect=r; log('→ React correct: ['+r.join(',')+']'); highlight(r); scheduleClick(r,type); }
      }, ms));
    }
    render();
  }

  function readReactCorrect() {
    const out = [];
    try {
      let btns = document.querySelectorAll('button[data-functional-selector^="answer-"]');
      if (!btns.length) btns = document.querySelectorAll('[data-functional-selector^="answer-"]');
      btns.forEach((btn) => {
        const el = btn.closest('[data-functional-selector^="answer-"]') || btn;
        const mSel = (el.getAttribute('data-functional-selector')||'').match(/answer-(\d+)/);
        if (!mSel) return;
        const idx = parseInt(mSel[1],10);
        const fiberKey = Object.keys(el).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$')) || Object.keys(btn).find(k=>k.startsWith('__reactFiber$'));
        if (!fiberKey) return;
        let fiber = (el[fiberKey]||btn[fiberKey]), depth=0;
        while (fiber && depth < 80) {
          const p = fiber.memoizedProps || fiber.pendingProps;
          if (p) {
            if (p.isCorrect===true || p.correct===true) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (p.answer && (p.answer.isCorrect===true || p.answer.correct===true)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (p.choice && (p.choice.isCorrect===true || p.choice.correct===true)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
            if (depth < 3) {
              try {
                const s = JSON.stringify(p, (k,v)=> typeof v==='function'?undefined:v);
                if (/"isCorrect"\s*:\s*true/.test(s) || /"correct"\s*:\s*true/.test(s)) { if(out.indexOf(idx)===-1) out.push(idx); break; }
              } catch(e){}
            }
          }
          fiber = fiber.return; depth++;
        }
      });
    } catch(e){}
    return out;
  }

  function scheduleClick(correct, type) {
    if (!S.answer.running || !correct || !correct.length) return;
    let toClick = correct;
    if (S.answer.mode==='2' && Math.random()<0.1) {
      const wrong = [0,1,2,3].filter(i=>!correct.includes(i));
      if (wrong.length) { toClick=[wrong[Math.floor(Math.random()*wrong.length)]]; log('  (legit miss)'); }
    }
    const delay = S.answer.mode==='1' ? (300+Math.random()*500) : (900+Math.random()*400);
    setTimeout(() => doClick(toClick, type), delay);
  }

  function doClick(indices, type) {
    try {
      if (!S.answer.running) return;
      highlight(indices);
      if (type==='jumble' && Array.isArray(indices)) {
        indices.forEach((idx,ord)=>{ const b=findAnswerBtn(idx); if(b) setTimeout(()=>b.click(), ord*220); });
        log('Clicked jumble.');
        return;
      }
      const arr = Array.isArray(indices)?indices:[indices];
      for (const idx of arr) { const b=findAnswerBtn(idx); if(b) b.click(); }
      log('Clicked: ['+arr.join(',')+']');
    } catch(e){ log('Click error: '+e.message); }
  }

  function findAnswerBtn(idx) {
    return document.querySelector(`button[data-functional-selector="answer-${idx}"]`)
      || document.querySelector(`[data-functional-selector="answer-${idx}"] button`)
      || document.querySelector(`[data-functional-selector="answer-${idx}"]`)
      || document.querySelectorAll('button[data-functional-selector^="answer-"]')[idx]
      || null;
  }

  function highlight(indices) {
    try {
      (Array.isArray(indices)?indices:[indices]).forEach(idx=>{
        const b=findAnswerBtn(idx);
        if(b){ b.style.outline='4px solid #00ff88'; b.style.boxShadow='0 0 18px #00ff88, inset 0 0 8px rgba(0,255,136,.25)'; b.style.transition='all .15s'; }
      });
    } catch(e){}
  }

  // ==================== BOOT ====================
  function boot() {
    installWsHook();
    injectCSS();
    const go = () => { render(); resumeAutoJoin(); };
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go);
    setTimeout(go, 400); setTimeout(go, 1200);
    setInterval(() => { const was=S.inGame; updateDet(); if(was!==S.inGame) render(); }, 1500);
    log('JZ AIO v4 loaded.');
  }
  boot();
  window.JZ_AIO = S;
})();
