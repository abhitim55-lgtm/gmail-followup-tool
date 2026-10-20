// Follow-ups for Gmail.
// Adds a "Follow-ups" item under Drafts in Gmail's left menu. Clicking it
// opens the Follow-up Studio (the same Apps Script project as the sidebar
// add-on) inside Gmail's main pane, the way Mailmeteor's "Campaigns" does:
// Gmail's hash becomes #followups, Gmail's own list is hidden, and the Studio
// takes its place. Inbox, a label, search or Back puts Gmail's view back.

const DEPLOYMENT_ID = 'AKfycbxqfbAVuFNv968-Zb2eqDl664UlEDnEaWXbdvYicfV44s4jx4ytm0OkkV4v6SmNINduAA';
// Accounts on this Workspace domain open the Studio via /a/macros/<domain>/
// so the right Google account is used when several are signed in.
const OWNER_DOMAIN = 'procmart.com';
const LABEL = 'Follow-ups';
const HASH = '#followups';
const ICON_PATH = 'M2.01 21 23 12 2.01 3 2 10l15 2-15 2z'; // Material "send"

let page = null;

function accountEmail() {
  const m = document.title.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  return m ? m[0].toLowerCase() : '';
}

function studioUrl(view) {
  const domain = accountEmail().split('@')[1] || '';
  const base = domain === OWNER_DOMAIN
    ? 'https://script.google.com/a/macros/' + domain + '/s/' + DEPLOYMENT_ID + '/exec'
    : 'https://script.google.com/macros/s/' + DEPLOYMENT_ID + '/exec';
  return view ? base + '?view=' + encodeURIComponent(view) : base;
}

// Gmail's main column (message list + reading pane).
function mainArea() {
  return document.querySelector('.nH.bkK');
}

function isOurs(hash) {
  return hash === HASH || hash.indexOf(HASH + '/') === 0;
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
  const link = el('a', { class: 'J-Ke n0', href: HASH, tabindex: '-1' }, [LABEL]);
  const to = el('div', { class: 'TO', role: 'link', tabindex: '0', title: LABEL }, [
    el('div', { class: 'TN aHS-bnq' }, [
      el('div', { class: 'qj' }, [sendIcon()]),
      el('div', { class: 'aio UKr6le' }, [el('span', { class: 'nU' }, [link])])
    ])
  ]);
  const row = el('div', { id: 'fu-nav-row', class: 'aim' }, [to]);
  const open = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (isOurs(location.hash)) mount(); else location.hash = HASH;
  };
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

function buildPage() {
  const p = el('div', { id: 'fu-page' });
  // Load once and keep it: reopening is instant and keeps a half-written draft.
  const f = document.createElement('iframe');
  const sub = location.hash.slice(HASH.length + 1);
  f.src = studioUrl(sub);
  f.allow = 'clipboard-write';
  f.title = LABEL;
  p.appendChild(f);
  return p;
}

// Inside Gmail's main column, like Mailmeteor: Gmail's own panes are hidden
// by a class on the column, never removed, so leaving restores them as-is.
function mount() {
  const main = mainArea();
  if (!main) return;
  if (!page) page = buildPage();
  if (page.parentNode !== main) main.appendChild(page);
  main.classList.add('fu-host');
  setActive(true);
  fit();
}

function unmount() {
  const main = document.querySelector('.fu-host');
  if (main) main.classList.remove('fu-host');
  setActive(false);
}

// Gmail sizes its panes with inline heights; match the column's height.
function fit() {
  const main = document.querySelector('.fu-host');
  if (!main || !page) return;
  const top = main.getBoundingClientRect().top;
  page.style.height = Math.max(320, window.innerHeight - top - 16) + 'px';
}

function setActive(on) {
  const to = document.querySelector('#fu-nav-row .TO');
  if (to) to.classList.toggle('fu-active', on);
  document.documentElement.classList.toggle('fu-on', on);
}

function sync() {
  if (isOurs(location.hash)) mount(); else unmount();
}

window.addEventListener('hashchange', sync);
window.addEventListener('resize', fit);

let pending = false;
new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    ensureNavRow();
    // Gmail can rebuild its main column; re-attach if we're showing.
    if (isOurs(location.hash) && (!page || !page.isConnected || !document.querySelector('.fu-host'))) mount();
  });
}).observe(document.body, { childList: true, subtree: true });
ensureNavRow();
sync();
