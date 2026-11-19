/* 졸아도 노트 — 녹음 + 실시간 받아쓰기 + 기기 저장 (외부 서버 없음) */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mmss = t => { t = Math.max(0, Math.round(t)); const h = Math.floor(t/3600), m = Math.floor(t%3600/60), s = t%60;
  return (h ? h + ':' + String(m).padStart(2,'0') : String(m).padStart(2,'0')) + ':' + String(s).padStart(2,'0'); };
const toast = m => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = m; document.body.appendChild(d); setTimeout(() => d.remove(), 2600); };
const newLec = () => ({ id: 'l' + Date.now().toString(36), sub: '', title: '', created: Date.now(), updated: Date.now(), dur: 0, lines: [], notes: '', segs: [] });

// ---------- 환경
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0);
const isAndroid = /Android/.test(ua);
const isTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer:coarse)').matches;
const isInApp = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|everytimeApp|; wv\)/i.test(ua);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const MIME = !window.MediaRecorder ? '' : ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';

// ---------- IndexedDB
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('jolnote', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('lecs', { keyPath: 'id' }); d.createObjectStore('chunks'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}
const store = {
  list: () => tx('lecs', 'readonly', s => s.getAll()),
  put: l => tx('lecs', 'readwrite', s => s.put(l)),
  del: async id => { await tx('lecs', 'readwrite', s => s.delete(id)); await tx('chunks', 'readwrite', s => s.delete(IDBKeyRange.bound(id + '|', id + '|￿'))); },
  chunk: (id, seg, n, blob) => tx('chunks', 'readwrite', s => s.put(blob, `${id}|${String(seg).padStart(3,'0')}|${String(n).padStart(6,'0')}`)),
  segBlob: async (id, seg, mime) => { const k = `${id}|${String(seg).padStart(3,'0')}|`;
    const parts = await tx('chunks', 'readonly', s => s.getAll(IDBKeyRange.bound(k, k + '￿'))); return parts.length ? new Blob(parts, { type: mime || 'audio/webm' }) : null; }
};
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

// ---------- 상태
let lecs = [], cur = newLec();
let rec = false, startedAt = 0, partial = '', partialT = null, starNext = false, tab = 'log';
let useStt = !!SR, useAudio = canRecord && !SR; // 기본은 받아쓰기만, 녹음은 옵션
let lastResultAt = 0, srRestarts = 0;
// ---------- 진단 줄: 받아쓰기가 어디서 막히는지 화면에 표시
const D = { start: 0, audio: 0, speech: 0, result: 0, end: 0, err: '' };
const diagEl = document.createElement('p'); diagEl.className = 'note'; diagEl.style.fontSize = '12px'; diagEl.style.fontFamily = 'ui-monospace,monospace';
const diag = () => { diagEl.textContent = `[진단 v3] ${SR ? '엔진 있음' : '엔진 없음'} · 녹음기 ${canRecord ? '있음' : '없음'} · 시작 ${D.start} · 마이크 ${D.audio} · 말 감지 ${D.speech} · 결과 ${D.result} · 종료 ${D.end}${D.err ? ' · 오류 ' + D.err : ''} · ${isAndroid ? 'Android' : isIOS ? 'iOS' : 'PC'} ${(ua.match(/(SamsungBrowser|Edg|Chrome|CriOS|Firefox|FxiOS|Version)\/[\d]+/) || [''])[0]}${isInApp ? ' · 앱내브라우저' : ''}`; };
let stream = null, mr = null, segIdx = -1, chunkN = 0;
let sr = null, srWanted = false, srQuick = 0, srLastStart = 0, srGotResult = false;
let wake = null, hiddenAt = 0;

let saving = Promise.resolve(), dirty = false, saveTimer = null;
function touch(soon) { dirty = true; cur.updated = Date.now(); clearTimeout(saveTimer); saveTimer = setTimeout(save, soon ? 500 : 3000); }
function save() { if (!dirty) return saving; dirty = false; const snap = JSON.parse(JSON.stringify(cur));
  const i = lecs.findIndex(x => x.id === snap.id); i < 0 ? lecs.unshift(snap) : lecs[i] = snap;
  saving = saving.then(() => store.put(snap)).catch(() => { dirty = true; toast('저장 공간이 부족하거나 저장에 실패했어요'); }); return saving; }

const elapsed = () => cur.dur + (rec ? (Date.now() - startedAt) / 1000 : 0);
setInterval(() => { $('#time').textContent = mmss(elapsed()); }, 500);

// ---------- 렌더
function renderLog() {
  let h = cur.lines.map((l, i) => l.gap
    ? `<li class="gap"><span class="t">${mmss(l.t)}</span><span>— ${esc(l.x || '받아쓰기 끊김')} —</span></li>`
    : `<li data-i="${i}" class="${l.s ? 'star' : ''}"><span class="t">${mmss(l.t)}</span><span>${esc(l.x)}</span></li>`).join('');
  if (partial) h += `<li class="part"><span class="t">${mmss(partialT ?? elapsed())}</span><span>${esc(partial)}</span></li>`;
  $('#log').innerHTML = h || `<li class="empty">아직 기록이 없어요.<br>빨간 버튼을 누르면 녹음과 함께 교수님 말씀이 시간별로 적혀요.</li>`;
}
function md(s) {
  const out = []; let ul = false;
  for (let ln of esc(s).split('\n')) {
    ln = ln.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="ts">[$1]</span>');
    const m = ln.match(/^\s*[-*•]\s+(.*)/);
    if (m) { if (!ul) { out.push('<ul>'); ul = true; } out.push('<li>' + m[1] + '</li>'); continue; }
    if (ul) { out.push('</ul>'); ul = false; }
    if (/^###\s/.test(ln)) out.push('<h3>' + ln.replace(/^###\s*/, '') + '</h3>');
    else if (/^#{1,2}\s/.test(ln)) out.push('<h2>' + ln.replace(/^#{1,2}\s*/, '') + '</h2>');
    else if (ln.trim()) out.push('<p>' + ln + '</p>');
  }
  if (ul) out.push('</ul>'); return out.join('');
}
function renderSum() { $('#notesIn').value = cur.notes; $('#sum').innerHTML = cur.notes ? md(cur.notes) : ''; }
function renderMeta() { $('#fSub').value = cur.sub; $('#fTitle').value = cur.title; }
function renderRec() {
  $('#recBtn').classList.toggle('on', rec); $('#recBtn').setAttribute('aria-label', rec ? '녹음 멈춤' : '녹음 시작');
  $('#bAudio').classList.toggle('hide', !canRecord); $('#bStt').classList.toggle('hide', !SR);
  $('#bAudio').classList.toggle('on', rec && !!mr && mr.state === 'recording'); $('#bStt').classList.toggle('on', rec && srWanted);
  $('#bAudio').textContent = '녹음 파일 ' + (useAudio ? '켜짐' : '꺼짐'); $('#bStt').textContent = '받아쓰기 ' + (useStt ? '켜짐' : '꺼짐');
  $('#state').textContent = rec ? '기록 중 · 화면을 켜 둔 채로 두세요' : cur.lines.length || cur.segs.length ? '일시정지 · 다시 누르면 이어서 기록' : '대기 중 · 버튼을 눌러 녹음 시작';
  $('#dlAudio').classList.toggle('hide', !cur.segs.length);
}
function setTab(t) { tab = t; document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  $('#tLog').classList.toggle('hide', t !== 'log'); $('#tSum').classList.toggle('hide', t !== 'sum'); }
function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const a = lecs.slice().sort((x, y) => y.updated - x.updated).filter(l => !q || (l.sub + ' ' + l.title + ' ' + l.notes + ' ' + l.lines.map(x => x.x).join(' ')).toLowerCase().includes(q));
  $('#list').innerHTML = a.map(l => { const d = new Date(l.created);
    return `<li><button data-id="${esc(l.id)}"><span class="s">${esc(l.sub || '과목 미정')}${l.notes ? ' · 정리됨' : ''}${l.segs && l.segs.length ? ' · 녹음' : ''}</span><span class="n">${esc(l.title || '제목 없는 수업')}</span><span class="d">${d.getMonth()+1}/${d.getDate()}<br>${mmss(l.dur)}</span></button></li>`; }).join('')
    || `<li class="empty">${q ? '검색 결과가 없어요.' : '저장된 수업이 없어요.'}</li>`;
}
function show(v) { $('#vLec').classList.toggle('hide', v !== 'lec'); $('#vList').classList.toggle('hide', v !== 'list'); $('#bar').classList.toggle('hide', v !== 'lec');
  $('#toList').textContent = v === 'lec' ? '수업 목록' : '돌아가기'; if (v === 'list') renderList(); }
function open(l) { cur = JSON.parse(JSON.stringify(l)); cur.segs = cur.segs || []; partial = ''; stopAudio();
  renderMeta(); renderLog(); renderSum(); setTab('log'); hideAlert(); renderRec(); show('lec'); }
function alertBox(msg, btns) { $('#alertMsg').textContent = msg; $('#alertBtns').innerHTML = '';
  for (const [label, fn, pri] of btns || []) { const b = document.createElement('button'); b.textContent = label; if (pri) b.className = 'pri'; b.onclick = fn; $('#alertBtns').appendChild(b); }
  $('#alert').classList.remove('hide'); try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch (e) {} }
function hideAlert() { $('#alert').classList.add('hide'); }

// ---------- 받아쓰기 (Web Speech API, 끊기면 자동 재시작)
function addLine(x, t) { x = String(x).trim(); if (!x) return;
  cur.lines.push({ t: Math.round(t ?? partialT ?? elapsed()), x, s: starNext ? 1 : 0 }); starNext = false; partialT = null; touch(); }
function srStart() {
  if (!SR || !useStt) return;
  srWanted = true;
  if (!sr) {
    sr = new SR(); sr.lang = 'ko-KR'; sr.interimResults = true; sr.maxAlternatives = 1;
    sr.continuous = !isAndroid; // 안드로이드는 continuous에서 결과가 중복되는 문제가 있어 한 문장씩 받고 다시 시작
    sr.onstart = () => { D.start++; diag(); }; sr.onaudiostart = () => { D.audio++; diag(); }; sr.onspeechstart = () => { D.speech++; diag(); };
    sr.onresult = e => { D.result++; diag(); srGotResult = true; lastResultAt = Date.now(); let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i];
        if (r.isFinal) { if (partialT == null) partialT = elapsed(); addLine(r[0].transcript); } else interim += r[0].transcript; }
      if (interim && partialT == null) partialT = elapsed(); partial = interim.trim(); renderLog(); autoScroll(); };
    sr.onerror = e => { D.err = e.error + (e.message ? '(' + e.message + ')' : ''); diag();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { srWanted = false; useStt = false; renderRec();
        alertBox('받아쓰기 권한이 거부됐어요. 녹음 파일만 저장돼요. 브라우저 설정에서 마이크를 허용하면 받아쓰기도 돼요.', [['확인', hideAlert]]); }
      else if (e.error === 'audio-capture' && useAudio && canRecord) srConflict();
      else if (e.error === 'network') { srWanted = false; renderRec(); alertBox('받아쓰기는 인터넷이 필요해요. 연결을 확인한 뒤 다시 시도해 주세요.', [['다시 시도', () => { hideAlert(); srQuick = 0; srStart(); }, true]]); }
    };
    sr.onend = () => { D.end++; diag();
      if (partial) { addLine(partial); partial = ''; renderLog(); }
      if (!srWanted || !rec || document.hidden) return;
      const quick = Date.now() - srLastStart < 1500 && !srGotResult;
      srQuick = quick ? srQuick + 1 : 0;
      if (srQuick >= 4) { if (mr) return srConflict(); srWanted = false; renderRec(); alertBox('받아쓰기가 계속 끊겨요. 인터넷 연결을 확인해 주세요.', [['다시 시도', () => { hideAlert(); srQuick = 0; srStart(); }, true]]); return; }
      setTimeout(() => { if (srWanted && rec && !document.hidden) srKick(); }, quick ? 600 : 150);
    };
  }
  srKick();
}
function srKick() { srLastStart = Date.now(); srGotResult = false; srRestarts++; try { sr.start(); } catch (e) { if (!/already|InvalidState/i.test(String(e))) { D.err = 'start:' + (e.name || e); diag(); } } }
// 감시: 녹음과 받아쓰기를 같이 켰는데 20초 동안 한 글자도 안 들어오면 마이크 충돌로 보고 물어봄
setInterval(() => { if (rec && srWanted && mr && srRestarts >= 2 && Date.now() - Math.max(lastResultAt, startedAt) > 20000) { lastResultAt = Date.now(); srConflict(); } }, 5000);
function srStop() { srWanted = false; if (sr) { try { sr.stop(); } catch (e) {} } }
function srConflict() {
  srWanted = false; renderRec();
  alertBox('이 기기는 녹음 파일 저장과 받아쓰기를 동시에 못 해요. 하나만 골라 주세요.', [
    ['받아쓰기만', () => { hideAlert(); useAudio = false; audioStop(); srQuick = 0; srStart(); renderRec(); toast('녹음 파일은 끄고 받아쓰기만 해요'); }, true],
    ['녹음 파일만', () => { hideAlert(); useStt = false; renderRec(); toast('받아쓰기는 끄고 녹음 파일만 저장해요'); }]
  ]);
}

// ---------- 녹음 파일 (MediaRecorder, 10초마다 기기에 조각 저장)
async function audioStart() {
  if (!canRecord || !useAudio) return true;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { useAudio = false; renderRec(); toast('마이크를 쓸 수 없어 녹음 파일은 저장하지 않아요'); return false; }
  segIdx = cur.segs.length; chunkN = 0;
  cur.segs.push({ offset: Math.round(cur.dur), dur: 0, mime: MIME || 'audio/webm' });
  const id = cur.id, seg = segIdx;
  mr = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: 32000 } : undefined);
  mr.ondataavailable = e => { if (e.data && e.data.size) store.chunk(id, seg, chunkN++, e.data).catch(() => toast('저장 공간이 부족해요')); };
  mr.onstop = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
  mr.start(10000);
  return true;
}
function audioStop() { if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch (e) {} }
  if (segIdx >= 0 && cur.segs[segIdx]) cur.segs[segIdx].dur = Math.max(1, Math.round(elapsed() - cur.segs[segIdx].offset)); mr = null; segIdx = -1; }

// ---------- 시작 / 멈춤
async function lockScreen() { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { wake = null; } }
async function startRec() {
  if (!canRecord && !SR) { alertBox('이 브라우저는 녹음도 받아쓰기도 지원하지 않아요. Chrome·Edge·삼성 인터넷으로 열어 주세요.', [['확인', hideAlert]]); return; }
  hideAlert(); stopAudio();
  // 받아쓰기는 사용자 터치 직후 바로 시작해야 하는 브라우저가 있어서 먼저 켬
  rec = true; startedAt = Date.now();
  if (useStt) { srQuick = 0; srStart(); }
  renderRec(); lockScreen();
  await audioStart();
  renderRec(); touch(true);
}
function stopRec() {
  const d = elapsed(); rec = false; cur.dur = d; srStop(); audioStop();
  if (partial) { addLine(partial); partial = ''; }
  try { wake && wake.release(); } catch (e) {} wake = null;
  renderLog(); renderRec(); touch(true);
}
const toggleRec = () => rec ? stopRec() : startRec();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); save(); return; }
  if (rec) {
    lockScreen();
    if (hiddenAt && Date.now() - hiddenAt > 4000 && useStt) {
      cur.lines.push({ t: Math.round((hiddenAt - startedAt) / 1000 + cur.dur), gap: 1, x: '화면이 꺼져 받아쓰기 멈춤' + (mr ? ' · 녹음은 계속됨' : '') }); touch(true); renderLog();
    }
    if (srWanted) srKick();
  }
  hiddenAt = 0;
});
window.addEventListener('pagehide', () => { if (rec) { cur.dur = elapsed(); startedAt = Date.now(); } save(); });

// ---------- 재생
let playUrl = null;
function stopAudio() { const a = $('#audio'); a.pause(); if (playUrl) URL.revokeObjectURL(playUrl); playUrl = null; a.removeAttribute('src'); $('#player').classList.add('hide');
  document.querySelectorAll('.log li.playing').forEach(x => x.classList.remove('playing')); }
async function playAt(t, li) {
  if (rec) { toast('녹음 중에는 재생할 수 없어요'); return; }
  const si = cur.segs.findIndex((s, i) => t >= s.offset && (t < s.offset + (s.dur || 1e9) || i === cur.segs.length - 1));
  if (si < 0) { toast('이 부분은 녹음 파일이 없어요'); return; }
  const s = cur.segs[si]; const b = await store.segBlob(cur.id, si, s.mime);
  if (!b) { toast('녹음 파일을 찾지 못했어요'); return; }
  stopAudio(); playUrl = URL.createObjectURL(b); const a = $('#audio'); a.src = playUrl; $('#player').classList.remove('hide');
  li && li.classList.add('playing');
  const seek = Math.max(0, t - s.offset - 2);
  const go = () => { try { a.currentTime = seek; } catch (e) {} a.play().catch(() => {}); };
  // 브라우저 녹음 파일(webm)은 길이 정보가 없어 건너뛰기가 안 됨 → 끝까지 한 번 훑어 길이를 알아낸 뒤 이동
  const ready = () => {
    if (isFinite(a.duration)) return go();
    const fix = () => { if (!isFinite(a.duration)) return; a.removeEventListener('durationchange', fix); a.removeEventListener('timeupdate', fix); a.currentTime = 0; setTimeout(go, 50); };
    a.addEventListener('durationchange', fix); a.addEventListener('timeupdate', fix);
    try { a.currentTime = 1e101; } catch (e) { go(); }
  };
  a.addEventListener('loadedmetadata', ready, { once: true });
  a.load();
}

// ---------- 로그 줄: 누르면 재생, 길게 누르면 ★
let pressT = null, pressed = false;
$('#log').addEventListener('pointerdown', e => { const li = e.target.closest('li[data-i]'); if (!li) return; pressed = false;
  pressT = setTimeout(() => { pressed = true; toggleStar(+li.dataset.i); try { navigator.vibrate && navigator.vibrate(30); } catch (x) {} }, 550); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('#log').addEventListener(ev, () => clearTimeout(pressT)));
$('#log').addEventListener('contextmenu', e => { const li = e.target.closest('li[data-i]'); if (!li) return; e.preventDefault(); if (!pressed) toggleStar(+li.dataset.i); pressed = true; });
$('#log').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (!li) return; if (pressed) { pressed = false; return; }
  const l = cur.lines[+li.dataset.i]; if (cur.segs.length) playAt(l.t, li); else toggleStar(+li.dataset.i); });
function toggleStar(i) { const l = cur.lines[i]; if (!l) return; l.s = l.s ? 0 : 1; touch(); renderLog(); }
function starNow() { if (partial) { starNext = true; toast('지금 말하는 문장에 ★'); return; }
  const l = [...cur.lines].reverse().find(x => !x.gap); if (l && rec) { l.s = 1; touch(); renderLog(); toast('방금 문장에 ★'); }
  else if (l) { toast('줄을 길게 누르면 ★를 붙일 수 있어요'); } else { starNext = true; toast('다음 문장에 ★'); } }
function autoScroll() { if ((tab === 'log' || innerWidth >= 1000) && innerHeight + scrollY > document.body.scrollHeight - 260) scrollTo(0, document.body.scrollHeight); }

// ---------- AI 정리용 복사
function transcript() { return cur.lines.filter(l => !l.gap).map(l => `[${mmss(l.t)}]${l.s ? ' ★' : ''} ${l.x}`).join('\n'); }
function aiPrompt() {
  return `너는 대학 강의 필기 도우미다. 아래는 '${cur.sub || '과목 미상'}' 수업${cur.title ? ` ('${cur.title}')` : ''}의 자동 음성인식 기록이다.
음성인식 오류(동음이의어, 전문용어 오인식)가 많으니 문맥과 해당 분야 지식으로 바로잡아 해석하되, 기록에 없는 내용을 지어내지 마라.
★ 표시는 학생이 직접 중요하다고 표시한 부분이니 반드시 반영하라. 각 항목 끝에 근거 시간을 [mm:ss]로 붙여라.
아래 형식의 한국어 마크다운으로만 답하라:
## 한 줄 요약
## 핵심 내용
(개념별로 ### 소제목과 - 불릿. 정의·공식·예시를 빠짐없이)
## 시험·강조 포인트
## 과제·공지
## 용어 정리
(- **용어**: 쉬운 설명)
## 복습 질문
(3~5개, 답은 괄호로 짧게)
해당 내용이 없으면 "- 해당 없음"이라고 써라.

[기록]
${transcript()}`;
}
async function copy(t, m) {
  try { await navigator.clipboard.writeText(t); toast(m); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(m); } catch (x) { toast('복사하지 못했어요'); } ta.remove(); }
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const baseName = () => (cur.sub ? cur.sub + '_' : '') + (cur.title || new Date(cur.created).toISOString().slice(0, 10)).replace(/[\\/:*?"<>|]/g, '');

// ---------- 불러오기
function parseText(txt) {
  const out = []; let last = cur.lines.length ? cur.lines[cur.lines.length - 1].t : 0;
  for (let ln of txt.replace(/\r/g, '').split('\n')) {
    ln = ln.trim(); if (!ln || /^\d+$/.test(ln) || /^WEBVTT/.test(ln)) continue;
    const srt = ln.match(/^(\d{2}):(\d{2}):(\d{2})[,.]\d+\s*-->/); if (srt) { last = +srt[1]*3600 + +srt[2]*60 + +srt[3]; continue; }
    const m = ln.match(/^(?:[^\d\n]{0,12}?\s)?\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(.*)$/);
    if (m) { last = m[3] != null ? +m[1]*3600 + +m[2]*60 + +m[3] : +m[1]*60 + +m[2]; if (m[4]) out.push({ t: last, x: m[4], s: 0 }); continue; }
    out.push({ t: last, x: ln, s: 0 });
  }
  return out;
}

// ---------- 이벤트
$('#recBtn').onclick = toggleRec;
$('#starBtn').onclick = starNow; $('#starBtn2').onclick = starNow;
$('#barSum').onclick = () => { setTab(tab === 'sum' ? 'log' : 'sum'); $('#barSum').textContent = tab === 'sum' ? '받아쓰기' : '정리 노트'; };
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { setTab(b.dataset.tab); $('#barSum').textContent = tab === 'sum' ? '받아쓰기' : '정리 노트'; });
$('#fSub').oninput = e => { cur.sub = e.target.value; touch(); };
$('#fTitle').oninput = e => { cur.title = e.target.value; touch(); };
$('#cpPrompt').onclick = () => cur.lines.some(l => !l.gap) ? copy(aiPrompt(), '복사했어요. ChatGPT나 Claude에 붙여넣으세요') : toast('정리할 받아쓰기가 없어요');
$('#saveNotes').onclick = () => { cur.notes = $('#notesIn').value.trim(); touch(true); renderSum(); toast(cur.notes ? '노트를 저장했어요' : '노트를 비웠어요'); };
$('#cpNotes').onclick = () => cur.notes ? copy(cur.notes, '노트를 복사했어요') : toast('아직 정리 노트가 없어요');
$('#dlTxt').onclick = () => { const t = (cur.sub ? cur.sub + ' · ' : '') + (cur.title || '') + '\n\n' + transcript() + (cur.notes ? '\n\n=== 정리 노트 ===\n' + cur.notes : '');
  download(new Blob([t], { type: 'text/plain;charset=utf-8' }), baseName() + '.txt'); };
$('#dlAudio').onclick = async () => { if (rec) { toast('녹음을 멈춘 뒤 저장해 주세요'); return; }
  for (let i = 0; i < cur.segs.length; i++) { const s = cur.segs[i]; const b = await store.segBlob(cur.id, i, s.mime); if (!b) continue;
    const ext = /mp4/.test(s.mime) ? 'm4a' : /ogg/.test(s.mime) ? 'ogg' : 'webm'; download(b, baseName() + (cur.segs.length > 1 ? `_${i + 1}` : '') + '.' + ext); } };
$('#file').onchange = async e => { const f = e.target.files[0]; if (f) $('#pasteIn').value = await f.text(); };
$('#imp').onclick = () => { $('#pasteIn').value = ''; $('#file').value = ''; $('#dlg').classList.remove('hide'); $('#pasteIn').focus(); };
$('#dlgX').onclick = () => $('#dlg').classList.add('hide');
$('#dlgOk').onclick = () => { const a = parseText($('#pasteIn').value); if (!a.length) { toast('불러올 내용이 없어요'); return; }
  cur.lines.push(...a); cur.dur = Math.max(cur.dur, a[a.length - 1].t); touch(true); renderLog(); $('#dlg').classList.add('hide'); toast(a.length + '줄을 불러왔어요'); };
let delArm = 0;
$('#del').onclick = async () => { if (Date.now() - delArm > 3000) { delArm = Date.now(); $('#del').textContent = '한 번 더 누르면 삭제'; setTimeout(() => $('#del').textContent = '삭제', 3000); return; }
  if (rec) stopRec(); clearTimeout(saveTimer); dirty = false; await saving; lecs = lecs.filter(x => x.id !== cur.id);
  try { await store.del(cur.id); } catch (e) {} $('#del').textContent = '삭제'; toast('삭제했어요'); open(newLec()); };
$('#toList').onclick = async () => { if ($('#vList').classList.contains('hide')) { if (rec) { toast('녹음 중에는 이동할 수 없어요'); return; }
  if (cur.lines.length || cur.sub || cur.title || cur.segs.length) await save(); stopAudio(); show('list'); } else show('lec'); };
$('#newLec').onclick = () => open(newLec());
$('#list').onclick = e => { const b = e.target.closest('button[data-id]'); if (!b) return; const l = lecs.find(x => x.id === b.dataset.id); if (l) open(l); };
$('#q').oninput = renderList;
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if ($('#vLec').classList.contains('hide') || !$('#dlg').classList.contains('hide')) return;
  const k = e.key.toLowerCase(); if (k === 'r') { e.preventDefault(); toggleRec(); } else if (k === 's') { e.preventDefault(); starNow(); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (!f) return;
  if (!/text|srt|vtt/.test(f.type) && !/\.(txt|srt|vtt)$/i.test(f.name)) { toast('.txt 파일만 불러올 수 있어요'); return; }
  show('lec'); $('#pasteIn').value = await f.text(); $('#dlg').classList.remove('hide'); });

// ---------- 설치(PWA)
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hide'); });
$('#installBtn').onclick = async () => { if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').classList.add('hide'); } };
window.addEventListener('appinstalled', () => { $('#installBtn').classList.add('hide'); toast('설치했어요. 홈 화면에서 열 수 있어요'); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- 녹음 파일 / 받아쓰기 켜고 끄기 (배지를 누르면 전환)
function setModes(stt, audio) {
  if (rec) { toast('녹음을 멈춘 뒤 바꿀 수 있어요'); return; }
  if (isAndroid && stt && audio) { toast('안드로이드에서는 둘 중 하나만 쓸 수 있어요'); return; }
  useStt = stt && !!SR; useAudio = audio && canRecord; renderRec();
}
for (const [id, fn] of [['#bStt', () => isAndroid ? setModes(true, false) : setModes(!useStt, useAudio)], ['#bAudio', () => isAndroid ? setModes(false, true) : setModes(useStt, !useAudio)]]) {
  const b = $(id); b.setAttribute('role', 'button'); b.tabIndex = 0; b.style.cursor = 'pointer'; b.style.border = '1px solid var(--line)'; b.style.padding = '6px 12px';
  b.onclick = fn; b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

// ---------- 카카오톡 등 앱 안 브라우저: 마이크·받아쓰기가 막혀 있어 Chrome으로 열도록 안내
if (isInApp) {
  const url = location.href.split('#')[0];
  const openChrome = () => {
    if (/KAKAOTALK/i.test(ua)) location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url);
    else if (isAndroid) location.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
    else toast('오른쪽 위 메뉴에서 "다른 브라우저로 열기"를 눌러 주세요');
  };
  setTimeout(() => alertBox('카카오톡 같은 앱 안에서 열면 녹음과 받아쓰기가 안 돼요. Chrome(아이폰은 Safari)으로 열어 주세요.', [['Chrome으로 열기', openChrome, true]]), 300);
}

// ---------- 환경 안내
(function envNote() {
  const msgs = [];
  if (!SR && canRecord) msgs.push('이 브라우저는 실시간 받아쓰기를 지원하지 않아 녹음 파일만 저장돼요. 받아쓰기는 Chrome·Edge·삼성 인터넷에서 돼요.');
  if (SR && isIOS) msgs.push('아이폰·아이패드는 받아쓰기가 자주 끊길 수 있어요.');
  if (SR && isAndroid) msgs.push('안드로이드에서는 받아쓰기와 녹음 파일 중 하나만 쓸 수 있어요. 위의 버튼을 눌러 고르세요. 받아쓰기가 다시 시작될 때 효과음이 나면 미디어 볼륨을 줄여 두세요.');
  msgs.push(isTouch ? '화면이 꺼지면 받아쓰기가 멈춰요. 수업 중엔 화면을 켜 두세요.' : '이 창을 최소화하거나 다른 탭으로 옮기면 받아쓰기가 멈출 수 있어요.');
  $('#envNote').textContent = msgs.join(' ');
  if (isIOS && !navigator.standalone) setTimeout(() => toast('Safari 공유 버튼 → 홈 화면에 추가로 설치할 수 있어요'), 1500);
})();

// ---------- 시작
$('#envNote').after(diagEl); diag();
renderMeta(); renderLog(); renderSum(); renderRec();
store.list().then(a => { lecs = a || []; }).catch(() => toast('이 브라우저에서는 저장을 쓸 수 없어요 (사생활 보호 모드인지 확인해 주세요)'));
})();
