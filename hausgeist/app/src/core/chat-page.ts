// Schlanke Chat-Oberfläche für die Home-Assistant-Seitenleiste (Ingress).
// Pfade sind relativ, damit sie unter dem Ingress-Präfix funktionieren.
export const CHAT_PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hausgeist</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --me: #e3ecf7; --bot: #ffffff; --line: #dcdcd6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; --me: #24324a; --bot: #1f1f1d; --line: #33332f; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  header b { font-size: 16px; }
  header button { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  main { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 760px; padding: 10px 14px; border-radius: 10px; white-space: pre-wrap; border: 1px solid var(--line); }
  .me { align-self: flex-end; background: var(--me); }
  .bot { align-self: flex-start; background: var(--bot); }
  .wait { color: var(--muted); font-style: italic; }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
  textarea { flex: 1; resize: none; height: 46px; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bot); color: var(--fg); font: inherit; }
  form button { padding: 0 18px; border-radius: 8px; border: 0; background: #2f6fd6; color: #fff; font-weight: 600; cursor: pointer; }
  form button:disabled { opacity: .5; }
</style>
</head>
<body>
<header><b>Hausgeist</b><span id="who"></span><button id="reset" title="Neues Gespräch">Neu</button></header>
<main id="log"></main>
<form id="f"><textarea id="t" placeholder="Was soll ich erledigen?" autofocus></textarea><button id="b">Senden</button></form>
<script>
const log = document.getElementById('log'), t = document.getElementById('t'), b = document.getElementById('b');
function add(text, cls) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
fetch('api/me').then(r => r.json()).then(j => { document.getElementById('who').textContent = j.name ? j.name : (j.error || ''); });
document.getElementById('reset').onclick = async () => { await fetch('api/reset', { method: 'POST' }); log.innerHTML = ''; };
t.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('f').requestSubmit(); } });
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const text = t.value.trim(); if (!text) return;
  t.value = ''; add(text, 'me'); b.disabled = true;
  const w = add('Hausgeist arbeitet …', 'bot wait');
  try {
    const r = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
    const j = await r.json();
    w.className = 'msg bot'; w.textContent = j.reply || j.error || 'Keine Antwort';
  } catch (err) { w.className = 'msg bot'; w.textContent = 'Fehler: ' + err; }
  b.disabled = false; t.focus();
};
</script>
</body>
</html>`;
