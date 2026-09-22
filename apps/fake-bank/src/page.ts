/**
 * The hosted payment page -- "a minimal HTML payment page is enough".
 *
 * It is one string on purpose. A build step, a template engine or a framework would all be more
 * machinery than the page is worth, and this is the one surface in the repo a human only ever
 * looks at for four seconds before clicking a button.
 *
 * The tokens below are the `--mc-*` set named in BUILD-PLAN §7.1, inlined rather than imported
 * from @mercatus/ui: that package is still a stub, and fake-bank is a server with no bundler, so
 * it has no way to ship a stylesheet from a workspace package. When `packages/ui/src/tokens.css`
 * exists, this block is the thing to delete -- the names already match.
 *
 * The buttons post JSON with `fetch` rather than submitting a form, because Fastify does not
 * parse `application/x-www-form-urlencoded` without @fastify/formbody, which is not in the
 * catalog. One dependency avoided for four lines of script.
 */
import type { Behaviour } from './contracts.js';
import type { PaymentRecord } from './store.js';

const BEHAVIOURS: readonly { id: Behaviour; label: string; hint: string; tone: string }[] = [
  { id: 'approve', label: 'Pay', hint: 'signed callback, status paid', tone: 'accent' },
  { id: 'decline', label: 'Decline', hint: 'signed callback, status declined', tone: 'danger' },
  { id: 'bad-hash', label: 'Bad signature', hint: 'callback signed with the wrong secret', tone: 'warning' },
  { id: 'no-callback', label: 'No callback', hint: 'money taken, we are never told', tone: 'warning' },
  { id: 'drop', label: 'Drop connection', hint: 'socket destroyed, no reply, no callback', tone: 'danger' },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Minor units and a currency code into something a human reads. Same rule as `Money` in ui. */
function money(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

export function renderPaymentPage(record: PaymentRecord): string {
  const settled = record.status !== 'created';
  const buttons = BEHAVIOURS.map(
    (b) => `      <button class="btn btn-${b.tone}" data-behaviour="${b.id}"${settled ? ' disabled' : ''}>
        <span class="btn-label">${escapeHtml(b.label)}</span>
        <span class="btn-hint">${escapeHtml(b.hint)}</span>
      </button>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fake-bank — ${escapeHtml(record.reference)}</title>
<style>
:root {
  --mc-bg: #f6f7f9;
  --mc-surface: #ffffff;
  --mc-fg: #14181f;
  --mc-fg-muted: #5c6673;
  --mc-border: #d9dee5;
  --mc-accent: #1f5fd0;
  --mc-accent-fg: #ffffff;
  --mc-danger: #b3261e;
  --mc-warning: #8a5a00;
  --mc-success: #1b6b3a;
  --mc-space-1: 4px;
  --mc-space-2: 8px;
  --mc-space-3: 12px;
  --mc-space-4: 16px;
  --mc-space-5: 24px;
  --mc-space-6: 32px;
  --mc-radius: 6px;
  --mc-radius-lg: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: var(--mc-space-6) var(--mc-space-4);
  background: var(--mc-bg); color: var(--mc-fg);
  font: 15px/1.5 system-ui, sans-serif;
}
main { max-width: 34rem; margin: 0 auto; }
.card {
  background: var(--mc-surface); border: 1px solid var(--mc-border);
  border-radius: var(--mc-radius-lg); padding: var(--mc-space-5);
  margin-bottom: var(--mc-space-4);
}
h1 { font-size: 1.1rem; margin: 0 0 var(--mc-space-1); }
.muted { color: var(--mc-fg-muted); font-size: 0.85rem; margin: 0; }
.amount { font-size: 2rem; font-weight: 600; margin: var(--mc-space-4) 0 var(--mc-space-2); }
dl { display: grid; grid-template-columns: auto 1fr; gap: var(--mc-space-1) var(--mc-space-4); margin: 0; }
dt { color: var(--mc-fg-muted); font-size: 0.85rem; }
dd { margin: 0; font-size: 0.85rem; font-family: ui-monospace, monospace; word-break: break-all; }
.btn {
  display: block; width: 100%; text-align: left; cursor: pointer;
  border: 1px solid var(--mc-border); border-radius: var(--mc-radius);
  background: var(--mc-surface); color: var(--mc-fg);
  padding: var(--mc-space-3) var(--mc-space-4); margin-bottom: var(--mc-space-2);
  font: inherit;
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-label { display: block; font-weight: 600; }
.btn-hint { display: block; color: var(--mc-fg-muted); font-size: 0.8rem; }
.btn-accent { border-color: var(--mc-accent); }
.btn-accent .btn-label { color: var(--mc-accent); }
.btn-danger .btn-label { color: var(--mc-danger); }
.btn-warning .btn-label { color: var(--mc-warning); }
#result { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>fake-bank</h1>
    <p class="muted">Run-mode only. No money moves here.</p>
    <p class="amount">${escapeHtml(money(record.amountMinor, record.currency))}</p>
    <dl>
      <dt>reference</dt><dd>${escapeHtml(record.reference)}</dd>
      <dt>provider ref</dt><dd>${escapeHtml(record.providerRef)}</dd>
      <dt>callback</dt><dd>${escapeHtml(record.callbackUrl)}</dd>
      <dt>status</dt><dd>${escapeHtml(record.status)}</dd>
    </dl>
  </div>
  <div class="card">
    <h1>What should the bank answer?</h1>
    <p class="muted">Default is <strong>approve</strong>. Every other answer is a failure you asked for.</p>
${buttons}
  </div>
  <div class="card"><pre id="result" class="muted">${settled ? 'Already settled. Reload GET /payments/' + escapeHtml(record.id) + ' for the record.' : 'No answer sent yet.'}</pre></div>
</main>
<script>
const out = document.getElementById('result');
for (const button of document.querySelectorAll('.btn')) {
  button.addEventListener('click', async () => {
    const behaviour = button.dataset.behaviour;
    for (const b of document.querySelectorAll('.btn')) b.disabled = true;
    out.textContent = 'Answering ' + behaviour + '...';
    try {
      const res = await fetch(location.pathname + '/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ behaviour }),
      });
      out.textContent = res.status + ' ' + JSON.stringify(await res.json(), null, 2);
    } catch (error) {
      // 'drop' lands here, and that is the point: the bank destroyed the socket.
      out.textContent = 'connection dropped by the bank — ' + error;
    }
  });
}
</script>
</body>
</html>
`;
}
