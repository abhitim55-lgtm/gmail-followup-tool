// Follow-up Studio for Gmail.
// Adds a "Follow-up Studio" item under Drafts in Gmail's left menu. Clicking
// it opens the Studio web app (the same Apps Script project as the sidebar
// add-on) over Gmail's main area. Any other menu click, Esc, or × closes it.

const DEPLOYMENT_ID = 'AKfycbxqfbAVuFNv968-Zb2eqDl664UlEDnEaWXbdvYicfV44s4jx4ytm0OkkV4v6SmNINduAA';
// Accounts on this Workspace domain open the Studio via /a/macros/<domain>/
// so the right Google account is used when several are signed in.
const OWNER_DOMAIN = 'procmart.com';
const LABEL = 'Follow-up Studio';
const ICON_PATH = 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z'; // Material "send"

let panel = null;

function accountEmail() {
  const m = document.title.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  return m ? m[0].toLowerCase() : '';
}

function studioUrl() {
  const domain = accountEmail().split('@')[1] || '';
  return domain === OWNER_DOMAIN
    ? 'https://script.google.com/a/macros/' + domain + '/s/' + DEPLOYMENT_ID + '/exec'
    : 'https://script.google.com/macros/s/' + DEPLOYMENT_ID + '/exec';
}

// Gmail's main column (message list + reading pane).
function mainArea() {
  return document.querySelector('.nH.bkK');
}

// Tiny DOM builder. Gmail enforces Trusted Types, so no innerHTML anywhere.
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, attrs[k]));
  (children || []).forEach((c) => node.append(c));
  return node;
}

function sendIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATH);
  svg.append(path);
  return svg;
}

// Same structure and classes as Gmail's own menu rows, so it matches the theme.
function buildNavRow() {
  const link = el('a', { class: 'J-Ke n0', href: '#', tabindex: '-1' }, [LABEL]);
  const to = el('div', { class: 'TO', role: 'link', tabindex: '0', title: LABEL }, [
    el('div', { class: 'TN aHS-bnq' }, [
      el('div', { class: 'qj' }, [sendIcon()]),
      el('div', { class: 'aio UKr6le' }, [el('span', { class: 'nU' }, [link])])
    ])
  ]);
  const row = el('div', { id: 'fu-nav-row', class: 'aim' }, [to]);
  const open = (ev) => { ev.preventDefault(); ev.stopPropagation(); openPanel(); };
  row.addEventListener('click', open, true);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') open(ev); });
  return row;
}

// Gmail rebuilds its menu now and then; put the row back whenever it's gone.
function ensureNavRow() {
  if (!document.getElementById('fu-nav-row')) {
    const drafts = document.querySelector('.TK a[href$="#drafts"]');
    const draftsRow = drafts && drafts.closest('.aim');
    if (draftsRow) draftsRow.after(buildNavRow());
  }
  // Gmail colours its icons with sprites, not text colour; follow the label
  // colour instead so the icon is visible in light and dark themes.
  const link = document.querySelector('#fu-nav-row a');
  const svg = document.querySelector('#fu-nav-row svg');
  if (link && svg) svg.style.fill = getComputedStyle(link).color;
}

function buildPanel() {
  const button = (cls, title, text, onClick) => {
    const b = el('button', { class: cls, title: title }, [text]);
    b.addEventListener('click', onClick);
    return b;
  };
  const p = el('div', { id: 'fu-panel' }, [
    el('div', { class: 'fu-bar' }, [
      el('span', { class: 'fu-title' }, [LABEL]),
      button('fu-reload', 'Reload', 'Reload', () => { p.querySelector('iframe').src = studioUrl(); }),
      button('fu-newtab', 'Open in its own tab', 'Open in new tab', () => window.open(studioUrl(), '_blank', 'noopener')),
      button('fu-close', 'Close (Esc)', '×', closePanel)
    ])
  ]);
  document.body.appendChild(p);
  return p;
}

function placePanel() {
  if (!panel || !panel.classList.contains('fu-open')) return;
  const main = mainArea();
  const r = main ? main.getBoundingClientRect()
    : { left: 260, top: 64, width: window.innerWidth - 320, height: window.innerHeight - 80 };
  panel.style.left = r.left + 'px';
  panel.style.top = r.top + 'px';
  panel.style.width = Math.max(320, r.width - 8) + 'px';
  panel.style.height = Math.max(300, Math.min(r.height, window.innerHeight - r.top) - 16) + 'px';
}

function openPanel() {
  if (!panel) panel = buildPanel();
  // Load once and keep it: reopening is instant and keeps a half-written draft.
  if (!panel.querySelector('iframe')) {
    const f = document.createElement('iframe');
    f.src = studioUrl();
    f.allow = 'clipboard-write';
    panel.appendChild(f);
  }
  panel.classList.add('fu-open');
  setActive(true);
  placePanel();
}

function closePanel() {
  if (!panel) return;
  panel.classList.remove('fu-open');
  setActive(false);
}

function setActive(on) {
  const to = document.querySelector('#fu-nav-row .TO');
  if (to) to.classList.toggle('fu-active', on);
}

// Back to Gmail on any click outside the Studio (Inbox, a label, Compose,
// search…) — clicks inside the Studio stay in its iframe and never get here.
// hashchange covers keyboard shortcuts like "g i".
document.addEventListener('click', (ev) => {
  if (!panel || !panel.classList.contains('fu-open')) return;
  if (ev.target.closest('#fu-panel, #fu-nav-row')) return;
  closePanel();
}, true);
window.addEventListener('hashchange', closePanel);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePanel(); });
window.addEventListener('resize', placePanel);

let pending = false;
new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; ensureNavRow(); placePanel(); });
}).observe(document.body, { childList: true, subtree: true });
ensureNavRow();
