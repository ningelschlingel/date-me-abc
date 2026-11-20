import './style.css';
import { ensureUser } from './firebase.js';
import {
  ALPHABET, MAX_DESC, MAX_NAME, SPACE_LEN, claimRole, completeLetter, createSeries, editDescription,
  formatCode, getKeys, joinSeries, markNewsSeen, markRoundSeen, otherRole, parseCode, peekSeries,
  progress, renamePlayer, roleOf, startOver, subscribe,
} from './game.js';
import { IDEAS } from './ideas.js';
import { confetti, playReveal, sparkle, toast } from './anim.js';
import { copyText, exportText, renderRecapPNG, saveOrShareImage } from './export.js';

/* ------------------------------------------------------------------ state */

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');

const state = {
  uid: null,
  id: null,
  role: null,
  data: null,
  unsub: null,
  screen: null,
  revealing: false,
  revealedRound: 0,
  newsSeenAt: 0,
  celebrated: false,
};

/* ---------------------------------------------------------------- helpers */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const fmtDateLong = (ms) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

const spaceUrl = (id) => `${location.origin}/s/${id}`;
const personalUrl = (id, key) => `${location.origin}/s/${id}#k=${key}`;

const me = () => state.data.players[state.role];
const partner = () => state.data.players[otherRole(state.role)];
const nameOf = (role) => (role === state.role ? 'You' : state.data.players[role]?.name ?? '');

function roundInCycle(d) {
  const drawn = ALPHABET.filter((l) => d.letters[l].status !== 'UNUSED').length;
  return Math.max(1, Math.ceil(drawn / 2));
}

const STORE_KEY = 'abc-dates:spaces';
function rememberSpace(id, d, role) {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]').filter((s) => s.id !== id);
    list.unshift({ id, me: d.players[role]?.name, partner: d.players[otherRole(role)]?.name ?? null, at: Date.now() });
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 5)));
  } catch { /* storage unavailable — fine */ }
}
function recallSpaces() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  } catch {
    return [];
  }
}

function mount(screen, html) {
  const fresh = state.screen !== screen;
  state.screen = screen;
  app.innerHTML = html;
  if (fresh) {
    app.firstElementChild?.classList.add('enter');
    window.scrollTo(0, 0);
  }
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

async function busy(button, fn) {
  if (button) {
    button.disabled = true;
    button.classList.add('loading');
  }
  try {
    return await fn();
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.classList.remove('loading');
    }
  }
}

function fail(err) {
  console.error(err);
  const offline = !navigator.onLine || ['unavailable', 'deadline-exceeded'].includes(err?.code)
    || /connection failed|offline/i.test(err?.message || '');
  const msg = offline
    ? 'You seem to be offline — try again once you’re connected.'
    : err?.code === 'permission-denied'
      ? 'That didn’t go through — you may not have access to this space.'
      : err?.message || 'Something went wrong. Try again?';
  toast(esc(msg), { tone: 'error' });
}

async function share(url, title) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ url, title });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  if (await copyText(url)) toast('Link copied');
}

/* ---------------------------------------------------------------- pieces */

const ICON = {
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
};

const mark = () => '<span class="mark" aria-hidden="true"><i>a</i><i>b</i><i>c</i></span>';

function header({ settings = true } = {}) {
  const d = state.data;
  const couple = d
    ? `<div class="couple">
        <span class="who"><span class="dot ${state.role}"></span>${esc(me().name)}</span>
        ${partner() ? `<span class="amp">&amp;</span><span class="who"><span class="dot ${otherRole(state.role)}"></span>${esc(partner().name)}</span>` : ''}
      </div>`
    : '';
  return `
    <header class="topbar">
      <a href="/" class="brand" data-link>${mark()}<span>ABC Dates</span></a>
      ${couple}
      ${settings && d ? `<button class="icon-btn" data-action="settings" aria-label="Settings">${ICON.gear}</button>` : ''}
    </header>`;
}

function linkBox(url, { label = 'Copy link', shareTitle = 'ABC Dates' } = {}) {
  return `
    <div class="linkbox">
      <span class="linkbox-url">${esc(url.replace(/^https?:\/\//, ''))}</span>
      <div class="linkbox-actions">
        <button class="btn soft sm" data-action="copy" data-value="${esc(url)}">${ICON.copy}<span>${label}</span></button>
        <button class="btn soft sm icon-only" data-action="share" data-value="${esc(url)}" data-title="${esc(shareTitle)}" aria-label="Share">${ICON.share}</button>
      </div>
    </div>`;
}

function codeForm({ id = '', autofocus = false } = {}) {
  return `
    <form class="code-form" data-form="code">
      <label class="label" for="code-input">Personal code</label>
      <div class="row">
        <input id="code-input" name="code" class="input code" autocomplete="off" autocapitalize="characters"
          spellcheck="false" placeholder="${id ? `${esc(id)}-XXXXX` : 'XXXXXX-XXXXX'}" maxlength="13" required ${autofocus ? 'autofocus' : ''}>
        <button class="btn primary">Open</button>
      </div>
    </form>`;
}

/* ---------------------------------------------------------------- screens */

function renderLoading(text = 'Loading…') {
  mount('loading', `<main class="screen center"><div class="loader"><i></i><i></i><i></i></div><p class="muted">${text}</p></main>`);
}

function renderLanding() {
  const spaces = recallSpaces();
  mount('landing', `
    <main class="screen landing">
      <header class="topbar"><span class="brand">${mark()}<span>ABC Dates</span></span></header>
      <section class="hero">
        <div class="hero-tiles" aria-hidden="true">
          <span class="tile-xl p1">A</span><span class="tile-xl honey">B</span><span class="tile-xl p2">C</span>
        </div>
        <h1>Twenty-six letters.<br><em>Twenty-six dates.</em></h1>
        <p class="lede">Draw a letter each, plan a date that starts with it, log what you did — and work your way from A to Z together.</p>
      </section>

      ${spaces.length ? `
        <section class="resume">
          ${spaces.map((s) => `
            <a class="resume-card" href="/s/${esc(s.id)}" data-link>
              <span class="mark sm" aria-hidden="true"><i>a</i><i>b</i><i>c</i></span>
              <span class="resume-text"><b>${esc(s.me)}${s.partner ? ` &amp; ${esc(s.partner)}` : ''}</b><small>Continue your series</small></span>
              ${ICON.arrow}
            </a>`).join('')}
        </section>` : ''}

      <form class="card create" data-form="create">
        <label class="label" for="name">Your name</label>
        <input id="name" name="name" class="input" maxlength="${MAX_NAME}" placeholder="e.g. Alex" autocomplete="given-name" required>
        <button class="btn primary block">Start a series ${ICON.arrow}</button>
        <p class="fine">You’ll get a link to send to your partner.</p>
      </form>

      <details class="have-code">
        <summary>Already playing on another device?</summary>
        <p class="muted">Enter the personal code from <b>Settings → Your other devices</b> on your first device.</p>
        ${codeForm()}
      </details>

      <section class="how">
        <div class="how-step"><span class="how-num">1</span><h3>Invite</h3><p>Start a series and send the link to your person.</p></div>
        <div class="how-step"><span class="how-num">2</span><h3>Draw</h3><p>You each get a random letter. Plan a date around it.</p></div>
        <div class="how-step"><span class="how-num">3</span><h3>Log</h3><p>Write down what you did. When you’re both done, two new letters drop.</p></div>
      </section>
      <footer class="foot">Made for two. ♡</footer>
    </main>`);
}

function renderJoin(d) {
  mount('join', `
    <main class="screen narrow">
      ${header({ settings: false })}
      <section class="hero small">
        <div class="hero-tiles sm" aria-hidden="true"><span class="tile-xl p1">${esc(d.players.p1.name[0]?.toUpperCase() || 'A')}</span><span class="tile-xl honey">&amp;</span><span class="tile-xl p2">?</span></div>
        <p class="eyebrow">You’re invited</p>
        <h1><span class="ink-p1">${esc(d.players.p1.name)}</span> wants to go on 26 dates with you.</h1>
        <p class="lede">One letter each, one date per letter, all the way from A to Z.</p>
      </section>
      <form class="card" data-form="join">
        <label class="label" for="name">Your name</label>
        <input id="name" name="name" class="input" maxlength="${MAX_NAME}" placeholder="e.g. Sam" autocomplete="given-name" required autofocus>
        <button class="btn primary block">Join &amp; draw our first letters ${ICON.arrow}</button>
      </form>
    </main>`);
}

function renderLocked(id, message = '') {
  mount('locked', `
    <main class="screen narrow">
      ${header({ settings: false })}
      <section class="hero small">
        <div class="hero-tiles sm" aria-hidden="true"><span class="tile-xl p1">?</span><span class="tile-xl honey">?</span></div>
        <p class="eyebrow">Private space</p>
        <h1>This series is already full.</h1>
        <p class="lede">${message ? esc(message) + ' ' : ''}If you’re one of the two players, enter your personal code — or ask your partner to send you your link from <b>Settings</b>.</p>
      </section>
      <div class="card">${codeForm({ id, autofocus: true })}</div>
      <p class="center-text"><a href="/" data-link class="text-link">Start your own series instead</a></p>
    </main>`);
}

function renderWaiting() {
  const d = state.data;
  mount('waiting', `
    <main class="screen narrow">
      ${header()}
      <section class="hero small">
        <div class="shuffle" aria-hidden="true"><span class="tile-xl p1 s1">A</span><span class="tile-xl honey s2">B</span><span class="tile-xl p2 s3">C</span></div>
        <p class="eyebrow">Almost there</p>
        <h1>Invite your person.</h1>
        <p class="lede">Send them this link. The moment they join, you’ll each draw your first letter.</p>
      </section>
      <div class="card">
        ${linkBox(spaceUrl(state.id), { label: 'Copy invite', shareTitle: `${d.players.p1.name} invited you to ABC Dates` })}
        <div class="waiting-line"><span class="pulse"></span>Waiting for your partner to join…</div>
      </div>
      <p class="fine center-text">Testing alone? Open the link in a private window.</p>
    </main>`);
}

function roundCard(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const mine = x.assignedTo === state.role;
  const owner = d.players[x.assignedTo];
  const role = x.assignedTo;
  if (x.status === 'DONE') {
    return `
      <div class="round-card ${role} done" data-letter="${letter}">
        <div class="rc-top"><span class="rc-owner"><span class="dot ${role}"></span>${mine ? 'Your letter' : `${esc(owner.name)}’s letter`}</span><span class="rc-badge" aria-label="Done">${ICON.check}<span class="wide-only">Done</span></span></div>
        <div class="rc-letter">${letter}</div>
        <p class="rc-desc">“${esc(x.description)}”</p>
      </div>`;
  }
  if (mine) {
    return `
      <button class="round-card ${role} mine" data-action="log" data-letter="${letter}">
        <div class="rc-top"><span class="rc-owner"><span class="dot ${role}"></span>Your letter</span></div>
        <div class="rc-letter">${letter}</div>
        <p class="rc-ideas">Ideas: ${IDEAS[letter].slice(0, 2).map(esc).join(' · ')}</p>
        <span class="rc-cta"><span class="wide-only">Log our ${letter} date</span><span class="narrow-only">Log it</span>${ICON.arrow}</span>
      </button>`;
  }
  return `
    <div class="round-card ${role} theirs" data-letter="${letter}">
      <div class="rc-top"><span class="rc-owner"><span class="dot ${role}"></span>${esc(owner.name)}’s letter</span></div>
      <div class="rc-letter">${letter}</div>
      <p class="rc-wait">${esc(owner.name)} is planning something<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>
    </div>`;
}

function roundHeadline(d, letters) {
  const mine = letters.find((l) => d.letters[l].assignedTo === state.role);
  const theirs = letters.find((l) => d.letters[l].assignedTo !== state.role);
  const myDone = mine && d.letters[mine].status === 'DONE';
  const theirDone = theirs && d.letters[theirs].status === 'DONE';
  if (myDone && !theirDone) return `Nice one. Now it’s ${esc(partner().name)}’s turn.`;
  if (!myDone && theirDone) return `${esc(partner().name)} is done — your move.`;
  return 'Two letters, two dates.';
}

function tile(letter, prev) {
  const x = state.data.letters[letter];
  const role = x.assignedTo || '';
  const justDone = prev && prev.letters[letter].status !== 'DONE' && x.status === 'DONE';
  const cls = ['tile', x.status.toLowerCase(), role, justDone ? 'just' : '', role === state.role ? 'own' : ''].join(' ');
  const label = x.status === 'DONE'
    ? `${letter}: ${x.description}`
    : x.status === 'ACTIVE' ? `${letter}: in play` : `${letter}: not drawn yet`;
  return `<button class="${cls}" data-action="tile" data-letter="${letter}" aria-label="${esc(label)}" ${x.status === 'UNUSED' ? 'tabindex="-1"' : ''}><span>${letter}</span></button>`;
}

function memoryItem(letter) {
  const x = state.data.letters[letter];
  return `
    <li>
      <button class="memory" data-action="tile" data-letter="${letter}">
        <span class="badge ${x.assignedTo}">${letter}</span>
        <span class="memory-text">
          <span class="memory-desc">${esc(x.description)}</span>
          <span class="memory-meta">${x.assignedTo === state.role ? 'Your' : `${esc(state.data.players[x.assignedTo].name)}’s`} pick · ${fmtDate(x.completedAt)}</span>
        </span>
      </button>
    </li>`;
}

function board(prev) {
  const d = state.data;
  const done = progress(d);
  const by = (r) => ALPHABET.filter((l) => d.letters[l].status === 'DONE' && d.letters[l].assignedTo === r).length;
  return `
    <section class="panel board">
      <div class="panel-head">
        <h2 class="h-sm">The alphabet</h2>
        <span class="count"><b>${done}</b>/26</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="26" aria-valuenow="${done}">
        <span class="bar-seg p1" style="width:${(by('p1') / 26) * 100}%"></span><span class="bar-seg p2" style="width:${(by('p2') / 26) * 100}%"></span>
      </div>
      <div class="grid">${ALPHABET.map((l) => tile(l, prev)).join('')}</div>
      <p class="fine legend"><span><i class="lg done"></i>done</span><span><i class="lg active"></i>in play</span><span><i class="lg unused"></i>still to come · ${26 - done - ALPHABET.filter((l) => d.letters[l].status === 'ACTIVE').length} left</span></p>
    </section>`;
}

function renderDashboard(prev) {
  const d = state.data;
  const current = ALPHABET
    .filter((l) => d.letters[l].round === d.round && d.letters[l].status !== 'UNUSED')
    .sort((a, b) => (d.letters[a].assignedTo === state.role ? -1 : d.letters[b].assignedTo === state.role ? 1 : 0));
  const memories = ALPHABET.filter((l) => d.letters[l].status === 'DONE')
    .sort((a, b) => d.letters[b].completedAt - d.letters[a].completedAt);

  mount('dashboard', `
    <main class="screen dash">
      ${header()}
      <div class="dash-grid">
        <section class="panel round">
          <p class="eyebrow">Round ${roundInCycle(d)} of 13</p>
          <h1 class="h-md">${roundHeadline(d, current)}</h1>
          <div class="round-cards">${current.map(roundCard).join('')}</div>
        </section>
        ${board(prev)}
        <section class="panel memories">
          <div class="panel-head"><h2 class="h-sm">Memory book</h2>${memories.length ? `<span class="count">${memories.length} ${memories.length === 1 ? 'date' : 'dates'}</span>` : ''}</div>
          ${memories.length
            ? `<ul class="memory-list">${memories.map(memoryItem).join('')}</ul>`
            : '<p class="empty">Your first date will land here once you log it.</p>'}
        </section>
      </div>
    </main>`);
}

function renderCompleted(prev) {
  const d = state.data;
  const done = ALPHABET.filter((l) => d.letters[l].status === 'DONE');
  const times = done.map((l) => d.letters[l].completedAt).filter(Boolean);
  const days = times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 864e5)) : 0;
  mount('completed', `
    <main class="screen dash">
      ${header()}
      <section class="celebrate">
        <div class="hero-tiles" aria-hidden="true"><span class="tile-xl p1">A</span><span class="tile-xl honey">♡</span><span class="tile-xl p2">Z</span></div>
        <p class="eyebrow">Series complete</p>
        <h1>You’re all done!<br><em>A to Z, together.</em></h1>
        <div class="stats">
          <div><b>26</b><span>dates</span></div>
          <div><b>${days}</b><span>${days === 1 ? 'day' : 'days'}</span></div>
          <div><b>${d.cycle || 1}</b><span>${(d.cycle || 1) === 1 ? 'alphabet' : 'alphabets'}</span></div>
        </div>
        <div class="export-row">
          <button class="btn primary" data-action="export-png">${ICON.image}<span>Save recap image</span></button>
          <button class="btn soft" data-action="export-text">${ICON.text}<span>Copy as text</span></button>
        </div>
      </section>
      <section class="panel memories">
        <div class="panel-head"><h2 class="h-sm">Your alphabet</h2></div>
        <ul class="memory-list">${ALPHABET.map(memoryItem).join('')}</ul>
      </section>
      <div class="center-text again">
        <button class="btn ghost" data-action="start-over">Start a new alphabet</button>
      </div>
    </main>`);

  const justFinished = prev && prev.status !== 'COMPLETED';
  if (justFinished || !state.celebrated) {
    state.celebrated = true;
    setTimeout(() => confetti(), 250);
  }
}

/* ------------------------------------------------------------------ sheets */

function openSheet(html, { onMount, className = '' } = {}) {
  sheet.className = `sheet ${className}`;
  sheet.innerHTML = `
    <div class="sheet-card">
      <button class="icon-btn sheet-close" data-action="close-sheet" aria-label="Close">${ICON.close}</button>
      ${html}
    </div>`;
  if (!sheet.open) sheet.showModal();
  onMount?.(sheet);
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.classList.add('closing');
  setTimeout(() => {
    sheet.close();
    sheet.classList.remove('closing');
    sheet.innerHTML = '';
  }, 180);
}

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();
});
sheet.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSheet();
});

function openLogSheet(letter, { edit = false } = {}) {
  const x = state.data.letters[letter];
  const value = edit ? x.description : '';
  openSheet(`
    <form class="sheet-body" data-form="log" data-letter="${letter}" data-edit="${edit ? '1' : ''}">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <h2 class="h-md">${edit ? `Edit your ${letter} date` : `What did you do for ${letter}?`}</h2>
      <p class="muted">A few words for the memory book.</p>
      <div class="field">
        <textarea name="desc" class="input" rows="2" maxlength="${MAX_DESC}" required
          placeholder="e.g. ${esc(IDEAS[letter][0])} & late-night snacks">${esc(value)}</textarea>
        <span class="counter"><b>${value.length}</b>/${MAX_DESC}</span>
      </div>
      ${edit ? '' : `
        <div class="ideas">
          <span class="fine">Quick start:</span>
          ${IDEAS[letter].map((i) => `<button type="button" class="chip" data-action="idea" data-value="${esc(i)}">${esc(i)}</button>`).join('')}
        </div>`}
      <button class="btn primary block">${edit ? 'Save changes' : `Save our ${letter} date`}</button>
    </form>`, {
    onMount: (el) => {
      const ta = el.querySelector('textarea');
      const counter = el.querySelector('.counter b');
      const sync = () => {
        ta.value = ta.value.replace(/\s*\n\s*/g, ' ');
        counter.textContent = ta.value.length;
        counter.parentElement.classList.toggle('near', ta.value.length >= MAX_DESC - 10);
      };
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          ta.form.requestSubmit();
        }
      });
      setTimeout(() => ta.focus({ preventScroll: true }), 60);
    },
  });
}

function openDetailSheet(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const mine = x.assignedTo === state.role;
  openSheet(`
    <div class="sheet-body">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <p class="eyebrow">${mine ? 'Your pick' : `${esc(d.players[x.assignedTo].name)}’s pick`} · ${fmtDateLong(x.completedAt)}</p>
      <p class="quote">“${esc(x.description)}”</p>
      ${mine ? `<button class="btn soft block" data-action="edit" data-letter="${letter}">${ICON.edit}<span>Edit description</span></button>` : ''}
    </div>`);
}

async function openSettings() {
  const d = state.data;
  const myRole = state.role;
  const pRole = otherRole(myRole);
  openSheet(`<div class="sheet-body"><h2 class="h-md">Settings</h2><div class="loader sm"><i></i><i></i><i></i></div></div>`, { className: 'wide' });
  const keys = await getKeys(state.id);
  if (!sheet.open) return;
  const myKey = keys[myRole];
  const pKey = keys[pRole];
  openSheet(`
    <div class="sheet-body left">
      <h2 class="h-md">Settings</h2>

      <form class="set-block" data-form="rename">
        <label class="label" for="rename"><span class="dot ${myRole}"></span>Your name</label>
        <div class="row">
          <input id="rename" name="name" class="input" maxlength="${MAX_NAME}" value="${esc(me().name)}" required>
          <button class="btn soft">Save</button>
        </div>
      </form>

      ${myKey ? `
      <div class="set-block">
        <h3 class="h-xs">Your other devices</h3>
        <p class="muted">Open this on your phone, laptop or tablet to play as <b>${esc(me().name)}</b> there too. It signs in as you — keep it to yourself.</p>
        ${linkBox(personalUrl(state.id, myKey), { shareTitle: 'My ABC Dates link' })}
        <p class="fine">Or type this code on the start page: <code class="code-pill">${formatCode(state.id, myKey)}</code></p>
      </div>` : ''}

      ${partner() && pKey ? `
      <div class="set-block">
        <h3 class="h-xs">${esc(partner().name)} lost access?</h3>
        <p class="muted">New phone or cleared browser? Send ${esc(partner().name)} their personal link to get back in.</p>
        ${linkBox(personalUrl(state.id, pKey), { label: `Copy ${partner().name}’s link`, shareTitle: 'Your ABC Dates link' })}
      </div>` : ''}

      ${partner() ? `
      <div class="set-block">
        <h3 class="h-xs">Not ${esc(me().name)}?</h3>
        <p class="muted">Switch this device to the other player with their personal code.</p>
        ${codeForm({ id: state.id })}
      </div>` : ''}

      ${d.status !== 'WAITING' ? `
      <div class="set-block danger">
        <h3 class="h-xs">Start over</h3>
        <p class="muted">Clears all 26 letters and draws fresh ones for both of you.</p>
        <button class="btn ghost danger" data-action="start-over">Start a new alphabet</button>
      </div>` : ''}

      <p class="fine">Space code <code class="code-pill">${state.id}</code></p>
    </div>`, { className: 'wide' });
}

function confirmSheet({ title, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <div class="sheet-body">
        <h2 class="h-md">${title}</h2>
        <p class="muted">${body}</p>
        <div class="row end">
          <button class="btn ghost" data-confirm="no">Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm="yes">${confirm}</button>
        </div>
      </div>`, {
      onMount: (el) => {
        el.querySelectorAll('[data-confirm]').forEach((b) =>
          b.addEventListener('click', () => {
            closeSheet();
            resolve(b.dataset.confirm === 'yes');
          }));
      },
    });
  });
}

/* ---------------------------------------------------- realtime + reveals */

function onSeries(d) {
  if (!d) {
    renderLocked(state.id, 'This series doesn’t exist anymore.');
    return;
  }
  const role = roleOf(d, state.uid);
  if (!role) {
    // This device was moved off the series (e.g. switched player elsewhere).
    cleanup();
    renderLocked(state.id);
    return;
  }
  const prev = state.data;
  state.role = role;
  state.data = d;
  rememberSpace(state.id, d, role);

  if (d.status === 'WAITING') renderWaiting();
  else if (d.status === 'COMPLETED') renderCompleted(prev);
  else renderDashboard(prev);

  showNews(d);
  maybeReveal(d);
}

function showNews(d) {
  const mine = d.players[state.role];
  const pRole = otherRole(state.role);
  const since = Math.max(mine.seenAt || 0, state.newsSeenAt);
  const fresh = ALPHABET
    .filter((l) => {
      const x = d.letters[l];
      return x.status === 'DONE' && x.assignedTo === pRole && x.completedAt > since;
    })
    .sort((a, b) => d.letters[a].completedAt - d.letters[b].completedAt);
  if (!fresh.length) return;
  const latest = Math.max(...fresh.map((l) => d.letters[l].completedAt));
  state.newsSeenAt = latest;
  fresh.forEach((l, i) =>
    setTimeout(() => {
      toast(`<span class="badge sm ${pRole}">${l}</span><span><b>${esc(d.players[pRole].name)}</b> logged their ${l} date: “${esc(d.letters[l].description)}”</span>`, { duration: 5200 });
      document.querySelector(`.tile[data-letter="${l}"]`)?.classList.add('just');
    }, 400 + i * 900));
  markNewsSeen(state.id, state.role, latest).catch(() => {});
}

async function maybeReveal(d) {
  const seen = Math.max(d.players[state.role].seenRound || 0, state.revealedRound);
  if (d.status !== 'ACTIVE' || d.round <= seen || state.revealing) return;
  state.revealing = true;
  state.revealedRound = d.round;
  if (sheet.open) closeSheet();

  const letters = ALPHABET
    .filter((l) => d.letters[l].round === d.round && d.letters[l].status !== 'UNUSED')
    .sort((a, b) => (d.letters[b].assignedTo === state.role) - (d.letters[a].assignedTo === state.role));
  const pool = ALPHABET.filter((l) => d.letters[l].status !== 'DONE');
  const first = roundInCycle(d) === 1;

  await playReveal({
    title: first ? (d.cycle > 1 ? 'A fresh alphabet' : 'Let the games begin') : `Round ${roundInCycle(d)} of 13`,
    subtitle: first ? 'Your first letters are…' : 'Fresh letters, new plans.',
    pool,
    cards: letters.map((l) => ({
      letter: l,
      role: d.letters[l].assignedTo,
      name: d.players[d.letters[l].assignedTo].name,
      mine: d.letters[l].assignedTo === state.role,
      done: d.letters[l].status === 'DONE',
    })),
  });
  state.revealing = false;
  markRoundSeen(state.id, state.role, d.round).catch(() => {});
  document.querySelector('.round-card.mine')?.classList.add('arrive');
}

function cleanup() {
  state.unsub?.();
  state.unsub = null;
  state.data = null;
  state.role = null;
}

/* ------------------------------------------------------------------ routing */

async function openSeries(id, key) {
  cleanup();
  state.id = id;
  state.celebrated = false;
  renderLoading();

  const data = await peekSeries(id);
  let role = roleOf(data, state.uid);
  if (!role && key) {
    role = await claimRole(id, key, state.uid);
    toast(role ? 'This device is connected ♡' : 'That code didn’t match this series.', { tone: role ? '' : 'error' });
  }
  if (location.hash) history.replaceState(null, '', `/s/${id}`); // don't leave the key lying around

  if (role) {
    listen(id);
  } else if (data && data.status === 'WAITING' && !data.players.p2) {
    renderJoin(data);
  } else {
    renderLocked(id);
  }
}

function route() {
  if (sheet.open) closeSheet();
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)\/?$/);
  if (m) {
    const id = m[1].toUpperCase();
    const key = new URLSearchParams(location.hash.slice(1)).get('k')?.toUpperCase() || null;
    openSeries(id, key);
  } else {
    cleanup();
    state.id = null;
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    renderLanding();
  }
}

/* ------------------------------------------------------------------ events */

document.addEventListener('click', async (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(link.getAttribute('href'));
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, letter, value } = el.dataset;

  switch (action) {
    case 'copy':
      if (await copyText(value)) {
        const span = el.querySelector('span');
        const before = span?.textContent;
        el.classList.add('ok');
        if (span) span.textContent = 'Copied!';
        setTimeout(() => {
          el.classList.remove('ok');
          if (span && before) span.textContent = before;
        }, 1600);
      }
      break;
    case 'share':
      share(value, el.dataset.title);
      break;
    case 'settings':
      openSettings();
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'log':
      openLogSheet(letter);
      break;
    case 'edit':
      openLogSheet(letter, { edit: true });
      break;
    case 'idea': {
      const ta = sheet.querySelector('textarea');
      ta.value = value;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      break;
    }
    case 'tile': {
      const x = state.data?.letters[letter];
      if (!x) break;
      if (x.status === 'DONE') openDetailSheet(letter);
      else if (x.status === 'ACTIVE' && x.assignedTo === state.role && state.data.status === 'ACTIVE') openLogSheet(letter);
      else if (x.status === 'ACTIVE') toast(`${letter} is ${esc(partner().name)}’s letter this round.`);
      break;
    }
    case 'start-over': {
      const ok = await confirmSheet({
        title: 'Start a new alphabet?',
        body: 'All 26 letters go back in the bag and you’ll both draw fresh ones. Your current memory book will be cleared — save the recap image first if you want to keep it.',
        confirm: 'Start over',
        danger: true,
      });
      if (ok) {
        try {
          state.celebrated = false;
          await startOver(state.id);
        } catch (err) {
          fail(err);
        }
      }
      break;
    }
    case 'export-text':
      if (await copyText(exportText(state.data))) toast('Recap copied to clipboard');
      break;
    case 'export-png':
      await busy(el, async () => {
        const blob = await renderRecapPNG(state.data);
        const names = `${state.data.players.p1.name}-${state.data.players.p2.name}`.replace(/[^\w-]+/g, '');
        await saveOrShareImage(blob, `abc-dates-${names || 'recap'}.png`);
      });
      break;
    default:
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (!navigator.onLine) {
    toast('You seem to be offline — try again once you’re connected.', { tone: 'error' });
    return;
  }
  const button = form.querySelector('button:not([type="button"])');
  const kind = form.dataset.form;

  if (kind === 'create') {
    const name = form.name.value.trim();
    if (!name) return;
    await busy(button, async () => {
      try {
        const id = await createSeries(name, state.uid);
        navigate(`/s/${id}`);
      } catch (err) {
        fail(err);
      }
    });
  }

  if (kind === 'join') {
    const name = form.name.value.trim();
    if (!name) return;
    await busy(button, async () => {
      try {
        await joinSeries(state.id, name, state.uid);
        await openSeries(state.id, null);
      } catch (err) {
        fail(err);
        if (err?.message?.includes('already joined')) renderLocked(state.id);
      }
    });
  }

  if (kind === 'code') {
    const parsed = parseCode(form.code.value);
    if (!parsed) {
      toast(`Codes look like ${'X'.repeat(SPACE_LEN)}-XXXXX.`, { tone: 'error' });
      return;
    }
    const switching = state.data && state.id === parsed.id && state.role;
    if (switching) {
      await busy(button, async () => {
        const role = await claimRole(parsed.id, parsed.key, state.uid, state.role);
        if (role) {
          closeSheet();
          toast(`This device now plays as ${esc(state.data.players[role].name)}.`);
        } else toast('That code didn’t work.', { tone: 'error' });
      });
    } else {
      navigate(`/s/${parsed.id}#k=${parsed.key}`);
    }
  }

  if (kind === 'log') {
    const letter = form.dataset.letter;
    const desc = form.desc.value.replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
    if (!desc) return;
    await busy(button, async () => {
      try {
        if (form.dataset.edit) {
          await editDescription(state.id, letter, desc);
          closeSheet();
          toast('Saved');
        } else {
          const res = await completeLetter(state.id, letter, desc, state.role);
          closeSheet();
          const card = document.querySelector(`.round-card[data-letter="${letter}"], .tile[data-letter="${letter}"]`);
          sparkle(card, 18);
          if (!res.drew.length && !res.completed) toast(`${letter} is in the book ♡`);
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  if (kind === 'rename') {
    const name = form.name.value.trim();
    if (!name) return;
    await busy(button, async () => {
      try {
        await renamePlayer(state.id, state.role, name);
        toast('Name updated');
      } catch (err) {
        fail(err);
      }
    });
  }
});

// Auto-format personal codes as XXXXXX-XXXXX while typing.
document.addEventListener('input', (e) => {
  if (!e.target.matches('input.code')) return;
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11);
  e.target.value = raw.length > SPACE_LEN ? `${raw.slice(0, SPACE_LEN)}-${raw.slice(SPACE_LEN)}` : raw;
});

window.addEventListener('popstate', route);

/* ------------------------------------------------------ live connection */

function listen(id) {
  state.unsub?.();
  state.unsub = subscribe(id, onSeries, (err) => {
    state.unsub = null;
    if (err?.code === 'permission-denied') {
      cleanup();
      renderLocked(id);
    } else fail(err);
  });
}

// Phones suspend network connections when the screen locks or the browser is
// backgrounded, and Firestore's stream doesn't always recover by itself (iOS
// Safari especially) — the page then silently stops updating. Re-attach the
// listener whenever the page comes back; it costs one document read.
function reconnect() {
  if (state.unsub && state.id && document.visibilityState === 'visible') listen(state.id);
}
document.addEventListener('visibilitychange', reconnect);
window.addEventListener('online', reconnect);
window.addEventListener('pageshow', (e) => e.persisted && reconnect());

/* -------------------------------------------------------------------- boot */

(async () => {
  renderLoading('Warming up…');
  try {
    const user = await ensureUser();
    state.uid = user.uid;
    route();
  } catch (err) {
    console.error(err);
    mount('error', `
      <main class="screen center narrow">
        <h1 class="h-md">Couldn’t connect.</h1>
        <p class="muted">Check your connection and reload. (If you’re the developer: make sure Anonymous sign-in is enabled in Firebase Auth.)</p>
        <button class="btn primary" onclick="location.reload()">Reload</button>
      </main>`);
  }
})();
