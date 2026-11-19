/* 졸아도 노트 보정: 데스크톱 모드 안드로이드 태블릿 인식 + 받아쓰기 안 되는 브라우저에서 Chrome으로 보내기 */
(() => {
const ua = navigator.userAgent;
// 태블릿 Chrome의 '데스크톱 사이트' 모드는 PC(Linux)처럼 보임 → 안드로이드로 알려 줌
if (!/Android/.test(ua) && /Linux/.test(ua) && !/CrOS/.test(ua) && navigator.maxTouchPoints > 0) {
  try { Object.defineProperty(navigator, 'userAgent', { get: () => ua + ' Android', configurable: true }); } catch (e) {}
}
const A = /Android/.test(navigator.userAgent), I = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const inApp = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|everytimeApp|; wv\)/i.test(ua), ff = /Firefox|FxiOS|Focus/i.test(ua);
if (SR && !inApp && !ff) return;
const url = location.href.split('#')[0];
const chrome = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome') + ';end';
const open = A ? chrome : I ? (/KAKAOTALK/i.test(ua) ? 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url) : 'x-safari-' + url) : /Windows/.test(ua) ? 'microsoft-edge:' + url : '';
const label = A ? 'Chrome으로 열기' : I ? 'Safari로 열기' : 'Edge로 열기';
if (A) { let t = false; try { t = sessionStorage.getItem('jn_to_chrome') === '1'; sessionStorage.setItem('jn_to_chrome', '1'); } catch (e) {} if (!t) setTimeout(() => { location.href = chrome; }, 400); }
addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div'); b.id = 'fixBanner';
  b.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;z-index:30;background:var(--bg,#fff);color:var(--ink,#111);border:2px solid #d93a26;border-radius:14px;padding:14px;font-size:15px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;flex-wrap:wrap;gap:10px;align-items:center';
  b.innerHTML = '<span style="flex:1 1 240px">이 브라우저에서는 받아쓰기가 안 돼요. ' + (A ? 'Chrome으로' : I ? 'Safari로' : 'Chrome이나 Edge로') + ' 열어 주세요.</span>';
  const btn = (t, f, p) => { const x = document.createElement('button'); x.textContent = t; x.onclick = f; if (p) x.className = 'pri'; b.appendChild(x); };
  if (open) btn(label, () => { location.href = open; }, true);
  btn('링크 복사', () => { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => { b.firstChild.textContent = '복사했어요. 주소창에 붙여넣으세요.'; }).catch(() => { prompt('이 주소를 복사하세요', url); }); }, !open);
  btn('닫기', () => b.remove());
  document.body.appendChild(b);
});
})();
