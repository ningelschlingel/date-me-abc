import './style.css';
import { ensureUser } from './firebase.js';
import {
  ALPHABET, MAX_DESC, MAX_LOCATION, MAX_NAME, MIN_OPEN, SPACE_LEN, claimRole, completeLetter, createSeries,
  drawMode, editDescription, fillPredone, formatCode, getKeys, isDone, joinSeries, markNewsSeen, markPlanSeen,
  markRoundSeen, needsPick, otherRole, parseCode, peekSeries, pickLetter, progress, renamePlayer, roleOf,
  roundInCycle, roundLetters, setPlan, startOver, subscribe, totalRounds,
} from './game.js';
import { IDEAS } from './ideas.js';
import { confetti, playReveal, sparkle, toast } from './anim.js';
import { copyText, exportText, renderRecapPNG, saveOrShareImage } from './export.js';
import { downloadICS, googleCalendarUrl } from './calendar.js';
import { datePicker, wireDatePickers } from './datepicker.js';

/** Ask "did it happen?" this long after a planned date starts. */
const HAPPENED_GRACE_MS = 60 * 60 * 1000;

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
  planSeenAt: 0,
  prompted: new Set(), // "did it happen?" prompts already shown this session
  celebrated: false,
};

/* ---------------------------------------------------------------- helpers */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const fmtDateLong = (ms) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const fmtWhen = (ms) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtWhenLong = (ms) =>
  new Date(ms).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function tomorrowEvening() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(19, 0, 0, 0);
  return d.getTime();
}

const spaceUrl = (id) => `${location.origin}/s/${id}`;
const personalUrl = (id, key) => `${location.origin}/s/${id}#k=${key}`;

const me = () => state.data.players[state.role];
const partner = () => state.data.players[otherRole(state.role)];
const dateOf = (x) => x.dateAt ?? x.completedAt;

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
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  calPlus: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  dice: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-2a1.5 1.5 0 0 1 3 0V12M14 10.5a1.5 1.5 0 0 1 3 0V12M17 11a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L4.3 15a1.6 1.6 0 0 1 2.6-1.8L8 14.5"/></svg>',
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

/**
 * Two-or-more option toggle with a sliding, high-contrast thumb.
 * options: [{ value, label, role?, icon? }] — `role` tints the thumb in that player's colour.
 */
function segmented(name, options, checked) {
  return `
    <div class="seg" style="--n:${options.length}">
      <span class="seg-thumb" aria-hidden="true"></span>
      ${options.map((o, i) => `
        <label class="${o.role || ''}" style="--i:${i}">
          <input type="radio" name="${name}" value="${esc(o.value)}" ${o.value === checked ? 'checked' : ''}>
          <span>${o.role ? `<i class="dot ${o.role}"></i>` : o.icon || ''}<span class="seg-text">${o.label}</span></span>
        </label>`).join('')}
    </div>`;
}

function optionsSummary(draw, preCount) {
  const parts = [draw === 'manual' ? 'Pick yourselves' : 'Random draw'];
  if (preCount) parts.push(`${preCount} already done`);
  return parts.join(' · ');
}

/** The quiet "Options" disclosure used when starting a series or a new alphabet. */
function optionsPanel({ draw = 'random' } = {}) {
  return `
    <details class="options">
      <summary>${ICON.sliders}<span>Options</span><span class="options-hint">${optionsSummary(draw, 0)}</span>${ICON.chevron}</summary>
      <div class="options-body">
        <fieldset class="opt">
          <legend class="label">How do you get your letters?</legend>
          ${segmented('draw', [
            { value: 'random', label: 'Random draw', icon: ICON.dice },
            { value: 'manual', label: 'Pick yourselves', icon: ICON.hand },
          ], draw === 'manual' ? 'manual' : 'random')}
        </fieldset>
        <fieldset class="opt">
          <legend class="label">Already done some letters?</legend>
          <p class="fine">Tap the letters you’ve already had a date for. They won’t be drawn, and either of you can fill in the details later.</p>
          <div class="pre-grid">
            ${ALPHABET.map((l) => `<label class="pre"><input type="checkbox" name="pre" value="${l}"><span>${l}</span></label>`).join('')}
          </div>
        </fieldset>
      </div>
    </details>`;
}

function readOptions(form) {
  const fd = new FormData(form);
  return { draw: fd.get('draw') || 'random', premarked: fd.getAll('pre') };
}

function planChip(letter, { action = 'calendar' } = {}) {
  const x = state.data.letters[letter];
  if (!x.plannedAt) return '';
  return `
    <button class="plan-chip" data-action="${action}" data-letter="${letter}">
      ${ICON.calendar}<span>${esc(fmtWhen(x.plannedAt))}${x.location ? ` · ${esc(x.location)}` : ''}</span>
    </button>`;
}

function calBadge(ms, role) {
  const dt = new Date(ms);
  return `
    <div class="cal-badge ${role}" aria-hidden="true">
      <span class="cal-month">${dt.toLocaleDateString(undefined, { month: 'short' })}</span>
      <span class="cal-day">${dt.getDate()}</span>
    </div>`;
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
        <p class="lede">Get a letter each, plan a date that starts with it, log what you did — and work your way from A to Z together.</p>
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
        ${optionsPanel()}
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
        <div class="how-step"><span class="how-num">2</span><h3>Draw</h3><p>You each get a letter — at random, or pick your own. Plan a date around it.</p></div>
        <div class="how-step"><span class="how-num">3</span><h3>Log</h3><p>Write down what you did. When you’re both done, the next round begins.</p></div>
      </section>
      <footer class="foot">Made for two. ♡</footer>
    </main>`);
}

function renderJoin(d) {
  const manual = drawMode(d) === 'manual';
  const pre = progress(d);
  mount('join', `
    <main class="screen narrow">
      ${header({ settings: false })}
      <section class="hero small">
        <div class="hero-tiles sm" aria-hidden="true"><span class="tile-xl p1">${esc(d.players.p1.name[0]?.toUpperCase() || 'A')}</span><span class="tile-xl honey">&amp;</span><span class="tile-xl p2">?</span></div>
        <p class="eyebrow">You’re invited</p>
        <h1><span class="ink-p1">${esc(d.players.p1.name)}</span> wants to go on ${26 - pre} dates with you.</h1>
        <p class="lede">One letter each, one date per letter, all the way from A to Z.${pre ? ` (${pre} ${pre === 1 ? 'letter is' : 'letters are'} already ticked off.)` : ''}</p>
      </section>
      <form class="card" data-form="join">
        <label class="label" for="name">Your name</label>
        <input id="name" name="name" class="input" maxlength="${MAX_NAME}" placeholder="e.g. Sam" autocomplete="given-name" required autofocus>
        <button class="btn primary block">${manual ? 'Join &amp; pick our first letters' : 'Join &amp; draw our first letters'} ${ICON.arrow}</button>
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
        <p class="lede">Send them this link. The moment they join, you’ll each ${drawMode(d) === 'manual' ? 'pick' : 'draw'} your first letter.</p>
      </section>
      <div class="card">
        ${linkBox(spaceUrl(state.id), { label: 'Copy invite', shareTitle: `${d.players.p1.name} invited you to ABC Dates` })}
        <div class="waiting-line"><span class="pulse"></span>Waiting for your partner to join…</div>
      </div>
      <p class="fine center-text">Testing alone? Open the link in a private window.</p>
    </main>`);
}

/* ---- round cards */

function roundCard({ letter, role, pick }) {
  const d = state.data;
  const mine = role === state.role;
  const owner = d.players[role];
  const ownerLabel = mine ? 'Your letter' : `${esc(owner.name)}’s letter`;
  const top = (extra = '') => `<div class="rc-top"><span class="rc-owner"><span class="dot ${role}"></span>${ownerLabel}</span>${extra}</div>`;

  if (pick) {
    return mine
      ? `<button class="round-card ${role} mine pick" data-action="pick">
          ${top()}
          <div class="rc-letter">?</div>
          <p class="rc-ideas">Choose any letter that’s still open.</p>
          <span class="rc-cta"><span class="wide-only">Pick your letter</span><span class="narrow-only">Pick</span>${ICON.arrow}</span>
        </button>`
      : `<div class="round-card ${role} theirs">
          ${top()}
          <div class="rc-letter">?</div>
          <p class="rc-wait">${esc(owner.name)} is choosing a letter<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>
        </div>`;
  }

  const x = d.letters[letter];
  if (x.status === 'DONE') {
    return `
      <div class="round-card ${role} done" data-letter="${letter}">
        ${top(`<span class="rc-badge" aria-label="Done">${ICON.check}<span class="wide-only">Done</span></span>`)}
        <div class="rc-letter">${letter}</div>
        <p class="rc-desc">“${esc(x.description)}”</p>
      </div>`;
  }
  if (mine) {
    return `
      <div class="round-card ${role} mine" data-letter="${letter}">
        ${top()}
        <div class="rc-letter">${letter}</div>
        ${x.plannedAt ? planChip(letter, { action: 'plan' }) : `<p class="rc-ideas">Ideas: ${IDEAS[letter].slice(0, 2).map(esc).join(' · ')}</p>`}
        <div class="rc-actions">
          ${x.plannedAt
            ? `<button class="rc-cta" data-action="log" data-letter="${letter}">${ICON.check}<span class="wide-only">Log our ${letter} date</span><span class="narrow-only">Log it</span></button>
               <button class="rc-icon" data-action="calendar" data-letter="${letter}" aria-label="Add to calendar" title="Add to calendar">${ICON.calPlus}</button>`
            : `<button class="rc-cta" data-action="plan" data-letter="${letter}">${ICON.calPlus}<span class="wide-only">Plan the date</span><span class="narrow-only">Plan it</span></button>
               <button class="rc-icon" data-action="log" data-letter="${letter}" aria-label="Already done? Log it" title="Already done? Log it">${ICON.check}</button>`}
        </div>
      </div>`;
  }
  return `
    <div class="round-card ${role} theirs" data-letter="${letter}">
      ${top()}
      <div class="rc-letter">${letter}</div>
      ${x.plannedAt
        ? `<p class="rc-wait">${esc(owner.name)} has a plan:</p>${planChip(letter)}`
        : `<p class="rc-wait">${esc(owner.name)} is planning something<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>`}
    </div>`;
}

function currentCards(d) {
  const cards = roundLetters(d).map((l) => ({ letter: l, role: d.letters[l].assignedTo }));
  for (const role of ['p1', 'p2']) if (needsPick(d, role)) cards.push({ role, pick: true });
  return cards.sort((a, b) => (b.role === state.role) - (a.role === state.role));
}

function roundHeadline(d, cards) {
  const pName = esc(partner().name);
  const mine = cards.find((c) => c.role === state.role);
  const theirs = cards.find((c) => c.role !== state.role);
  const isDoneCard = (c) => c && !c.pick && d.letters[c.letter].status === 'DONE';
  if (!mine) return isDoneCard(theirs) ? 'That was the last one!' : `Last letter — it’s ${pName}’s.`;
  if (mine.pick) return theirs && !theirs.pick ? `${pName} picked ${theirs.letter}. Your turn to choose.` : 'Pick a letter — any letter.';
  if (!theirs) return isDoneCard(mine) ? 'That was the last one!' : 'Last letter. Make it count.';
  if (isDoneCard(mine) && theirs.pick) return `Nice one. ${pName} still has to pick.`;
  if (isDoneCard(mine) && !isDoneCard(theirs)) return `Nice one. Now it’s ${pName}’s turn.`;
  if (!isDoneCard(mine) && isDoneCard(theirs)) return `${pName} is done — your move.`;
  const mineX = d.letters[mine.letter];
  if (mineX.plannedAt > Date.now()) return `Your ${mine.letter} date is coming up.`;
  if (mineX.plannedAt) return `How was your ${mine.letter} date?`;
  if (!theirs.pick && d.letters[theirs.letter]?.plannedAt) return `${pName} has a plan. Your move.`;
  if (roundInCycle(d) === 1) return `Plan something with ${mine.letter}.`;
  return 'Two letters, two dates.';
}

/* ---- alphabet board */

function tile(letter, prev, pickable) {
  const x = state.data.letters[letter];
  const role = x.assignedTo || '';
  const justDone = prev && !isDone(prev.letters[letter]) && isDone(x);
  const canPick = pickable && x.status === 'UNUSED';
  const cls = ['tile', x.status.toLowerCase(), role, justDone ? 'just' : '', role === state.role ? 'own' : '', canPick ? 'pickable' : ''].join(' ');
  const label = {
    DONE: `${letter}: ${x.description}`,
    PREDONE: `${letter}: done before you started — tap to fill in`,
    ACTIVE: `${letter}: in play`,
    UNUSED: canPick ? `${letter}: pick this letter` : `${letter}: not drawn yet`,
  }[x.status];
  const inert = x.status === 'UNUSED' && !canPick;
  return `<button class="${cls}" data-action="tile" data-letter="${letter}" aria-label="${esc(label)}" ${inert ? 'tabindex="-1"' : ''}><span>${letter}</span></button>`;
}

function board(prev) {
  const d = state.data;
  const done = progress(d);
  const count = (fn) => ALPHABET.filter((l) => fn(d.letters[l])).length;
  const by = (r) => count((x) => x.status === 'DONE' && x.assignedTo === r);
  const pre = count((x) => x.status === 'PREDONE');
  const left = count((x) => x.status === 'UNUSED');
  const pickable = needsPick(d, state.role);
  return `
    <section class="panel board">
      <div class="panel-head">
        <h2 class="h-sm">The alphabet</h2>
        <span class="count"><b>${done}</b>/26</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="26" aria-valuenow="${done}">
        <span class="bar-seg honey" style="width:${(pre / 26) * 100}%"></span><span class="bar-seg p1" style="width:${(by('p1') / 26) * 100}%"></span><span class="bar-seg p2" style="width:${(by('p2') / 26) * 100}%"></span>
      </div>
      ${pickable ? '<p class="board-hint">Tap an open letter to make it yours.</p>' : ''}
      <div class="grid ${pickable ? 'picking' : ''}">${ALPHABET.map((l) => tile(l, prev, pickable)).join('')}</div>
      <p class="fine legend"><span><i class="lg done"></i>done</span><span><i class="lg active"></i>in play</span><span><i class="lg unused"></i>still to come · ${left} left</span></p>
    </section>`;
}

function memoryItem(letter) {
  const d = state.data;
  const x = d.letters[letter];
  if (x.status === 'PREDONE') {
    return `
      <li>
        <button class="memory" data-action="tile" data-letter="${letter}">
          <span class="badge honey">${letter}</span>
          <span class="memory-text">
            <span class="memory-desc muted-desc">Done before you started</span>
            <span class="memory-meta">Tap to add the details</span>
          </span>
        </button>
      </li>`;
  }
  const who = x.assignedTo === state.role ? 'Your' : `${esc(d.players[x.assignedTo]?.name)}’s`;
  return `
    <li>
      <button class="memory" data-action="tile" data-letter="${letter}">
        <span class="badge ${x.assignedTo}">${letter}</span>
        <span class="memory-text">
          <span class="memory-desc">${esc(x.description)}</span>
          <span class="memory-meta">${who} pick · ${fmtDate(dateOf(x))}${x.location ? ` · ${esc(x.location)}` : ''}</span>
        </span>
      </button>
    </li>`;
}

function renderDashboard(prev) {
  const d = state.data;
  const cards = currentCards(d);
  const memories = ALPHABET.filter((l) => d.letters[l].status === 'DONE')
    .sort((a, b) => d.letters[b].completedAt - d.letters[a].completedAt);
  const pre = ALPHABET.filter((l) => d.letters[l].status === 'PREDONE');

  mount('dashboard', `
    <main class="screen dash">
      ${header()}
      <div class="dash-grid">
        <section class="panel round">
          <p class="eyebrow">Round ${roundInCycle(d)} of ${totalRounds(d)}</p>
          <h1 class="h-md">${roundHeadline(d, cards)}</h1>
          <div class="round-cards">${cards.map(roundCard).join('')}</div>
        </section>
        ${board(prev)}
        <section class="panel memories">
          <div class="panel-head"><h2 class="h-sm">Memory book</h2>${memories.length ? `<span class="count">${memories.length} ${memories.length === 1 ? 'date' : 'dates'}</span>` : ''}</div>
          ${memories.length
            ? `<ul class="memory-list">${memories.map(memoryItem).join('')}</ul>`
            : '<p class="empty">Your first date will land here once you log it.</p>'}
          ${pre.length ? `
            <div class="pre-note">
              <p class="fine">Done before you started — tap one to add the details:</p>
              <div class="pre-chips">${pre.map((l) => `<button class="badge honey sm" data-action="tile" data-letter="${l}" aria-label="Fill in ${l}">${l}</button>`).join('')}</div>
            </div>` : ''}
        </section>
      </div>
    </main>`);
}

function renderCompleted(prev) {
  const d = state.data;
  const times = ALPHABET.map((l) => d.letters[l]).filter((x) => x.status === 'DONE').map(dateOf).filter(Boolean);
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
    <div class="sheet-card" tabindex="-1" autofocus>
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
    setTimeout(checkPlans, 400);
  }, 180);
}

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();
});
sheet.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSheet();
});

/** Character counter + single-line behaviour for description textareas. */
function wireTextarea(el, { focus = true } = {}) {
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
  if (focus) setTimeout(() => ta.focus({ preventScroll: true }), 60);
}

const descField = (value = '', placeholder = '') => `
  <div class="field">
    <textarea name="desc" class="input" rows="2" maxlength="${MAX_DESC}" required placeholder="${esc(placeholder)}">${esc(value)}</textarea>
    <span class="counter"><b>${value.length}</b>/${MAX_DESC}</span>
  </div>`;

function openLogSheet(letter, { edit = false } = {}) {
  const x = state.data.letters[letter];
  const value = edit ? x.description : '';
  openSheet(`
    <form class="sheet-body" data-form="log" data-letter="${letter}" data-edit="${edit ? '1' : ''}">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <h2 class="h-md">${edit ? `Edit your ${letter} date` : `What did you do for ${letter}?`}</h2>
      <p class="muted">A few words for the memory book.</p>
      ${descField(value, `e.g. ${IDEAS[letter][0]} & late-night snacks`)}
      ${edit ? '' : `
        <div class="ideas">
          <span class="fine">Quick start:</span>
          ${IDEAS[letter].map((i) => `<button type="button" class="chip" data-action="idea" data-value="${esc(i)}">${esc(i)}</button>`).join('')}
        </div>`}
      <button class="btn primary block">${edit ? 'Save changes' : `Save our ${letter} date`}</button>
    </form>`, { onMount: (el) => wireTextarea(el) });
}

function openDetailSheet(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const canEdit = x.assignedTo === state.role || x.filledBy === state.role;
  openSheet(`
    <div class="sheet-body">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <p class="eyebrow">${x.assignedTo === state.role ? 'Your pick' : `${esc(d.players[x.assignedTo]?.name)}’s pick`} · ${fmtDateLong(dateOf(x))}</p>
      <p class="quote">“${esc(x.description)}”</p>
      ${x.location ? `<p class="muted where">${ICON.pin}<span>${esc(x.location)}</span></p>` : ''}
      ${canEdit ? `<button class="btn soft block" data-action="edit" data-letter="${letter}">${ICON.edit}<span>Edit description</span></button>` : ''}
    </div>`);
}

/** Manual mode: choose your letter for this round. */
function openPickSheet(preselect = null) {
  const d = state.data;
  const open = ALPHABET.filter((l) => d.letters[l].status === 'UNUSED');
  const sel = open.includes(preselect) ? preselect : null;
  openSheet(`
    <form class="sheet-body" data-form="pick">
      <p class="eyebrow">Round ${roundInCycle(d)} of ${totalRounds(d)}</p>
      <h2 class="h-md">Pick your letter</h2>
      <p class="muted">Any letter that’s still open. Once it’s yours, it’s yours.</p>
      <div class="pick-grid ${state.role}">
        ${open.map((l) => `<label class="pick-opt"><input type="radio" name="letter" value="${l}" ${l === sel ? 'checked' : ''} required><span>${l}</span></label>`).join('')}
      </div>
      <p class="fine pick-ideas">${sel ? `Ideas: ${IDEAS[sel].map(esc).join(' · ')}` : '&nbsp;'}</p>
      <button class="btn primary block" ${sel ? '' : 'disabled'}>${sel ? `Take ${sel}` : 'Choose a letter'}</button>
    </form>`, {
    onMount: (el) => {
      const btn = el.querySelector('button.btn.primary');
      const ideas = el.querySelector('.pick-ideas');
      el.querySelector('form').addEventListener('change', (e) => {
        const l = e.target.value;
        btn.disabled = false;
        btn.textContent = `Take ${l}`;
        ideas.textContent = `Ideas: ${IDEAS[l].join(' · ')}`;
      });
    },
  });
}

function openPlanSheet(letter) {
  const x = state.data.letters[letter];
  const pName = partner()?.name;
  openSheet(`
    <form class="sheet-body" data-form="plan" data-letter="${letter}">
      <div class="sheet-head">
        <div class="sheet-letter sm ${x.assignedTo}">${letter}</div>
        <div>
          <h2 class="h-md">${x.plannedAt ? `Move your ${letter} date` : `When’s your ${letter} date?`}</h2>
          <p class="muted">${esc(pName)} gets a heads-up to add it to their calendar.</p>
        </div>
      </div>
      ${datePicker({ name: 'when', value: x.plannedAt || tomorrowEvening(), time: true, min: Date.now(), label: 'Date and time', role: x.assignedTo })}
      <div class="plan-fields">
        <label class="label" for="plan-where">${ICON.pin}Where <span class="opt-tag">optional</span></label>
        <input id="plan-where" name="where" class="input" maxlength="${MAX_LOCATION}" value="${esc(x.location || '')}" placeholder="e.g. The night market on 5th" autocomplete="off">
      </div>
      <div class="sheet-actions">
        ${x.plannedAt ? `<button type="button" class="btn ghost" data-action="clear-plan" data-letter="${letter}">Remove</button>` : ''}
        <button class="btn primary">${ICON.check}<span>Save the date</span></button>
      </div>
    </form>`, { className: 'wide', onMount: wireDatePickers });
}

function calEvent(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const ownerName = d.players[x.assignedTo]?.name;
  return {
    uid: `${state.id}-${d.cycle || 1}-${letter}@abc-dates`,
    title: `${letter} date with ${partner()?.name ?? ''}`.trim(),
    start: x.plannedAt,
    location: x.location || '',
    details: `ABC Dates — the ${letter} date (${ownerName}’s pick).`,
    url: spaceUrl(state.id),
  };
}

function openCalendarSheet(letter, { proactive = false, justSaved = false } = {}) {
  const d = state.data;
  const x = d.letters[letter];
  if (!x.plannedAt) return;
  const mine = x.assignedTo === state.role;
  const eyebrow = proactive
    ? `${esc(d.players[x.plannedBy || x.assignedTo]?.name)} planned the ${letter} date`
    : justSaved ? 'Saved ♡' : `${mine ? 'Your' : `${esc(d.players[x.assignedTo]?.name)}’s`} ${letter} date`;
  openSheet(`
    <div class="sheet-body">
      ${calBadge(x.plannedAt, x.assignedTo)}
      <p class="eyebrow">${eyebrow}</p>
      <h2 class="h-md">${esc(fmtWhenLong(x.plannedAt))}</h2>
      ${x.location ? `<p class="muted where">${ICON.pin}<span>${esc(x.location)}</span></p>` : ''}
      <p class="muted">${proactive ? 'Want to put it in your calendar?' : 'Add it to your calendar so neither of you forgets.'}</p>
      <div class="cal-actions">
        <button class="btn primary block" data-action="ics" data-letter="${letter}">${ICON.calPlus}<span>Add to calendar</span></button>
        <a class="btn soft block" href="${esc(googleCalendarUrl(calEvent(letter)))}" target="_blank" rel="noopener">Google Calendar</a>
      </div>
      <div class="row center">
        ${mine && x.status === 'ACTIVE' ? `<button class="btn ghost sm" data-action="plan" data-letter="${letter}">${ICON.edit}<span>Change</span></button>` : ''}
        <button class="btn ghost sm" data-action="close-sheet">${proactive || justSaved ? 'Not now' : 'Close'}</button>
      </div>
    </div>`);
}

function openHappenedSheet(letter) {
  const x = state.data.letters[letter];
  openSheet(`
    <div class="sheet-body">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <h2 class="h-md">Did your ${letter} date happen?</h2>
      <p class="muted">It was planned for ${esc(fmtWhen(x.plannedAt))}${x.location ? ` at ${esc(x.location)}` : ''}.</p>
      <button class="btn primary block" data-action="log" data-letter="${letter}">${ICON.check}<span>Yes — let’s log it</span></button>
      <button class="btn soft block" data-action="plan" data-letter="${letter}">${ICON.calendar}<span>Not yet — set a new time</span></button>
    </div>`);
}

/** Fill in a letter that was marked "already done" when the series started. */
function openFillSheet(letter) {
  const d = state.data;
  const pRole = otherRole(state.role);
  openSheet(`
    <form class="sheet-body" data-form="fill" data-letter="${letter}">
      <div class="sheet-letter honey">${letter}</div>
      <h2 class="h-md">Your ${letter} date, before it all began</h2>
      <p class="muted">You’d already done this one. Add it to the memory book?</p>
      ${descField('', `e.g. ${IDEAS[letter][0]}`)}
      <fieldset class="opt plan-fields">
        <legend class="label">Who planned it?</legend>
        ${segmented('by', [
          { value: state.role, label: esc(me().name), role: state.role },
          { value: pRole, label: esc(d.players[pRole]?.name), role: pRole },
        ], state.role)}
      </fieldset>
      <fieldset class="opt plan-fields">
        <legend class="label">${ICON.calendar}When was it? <span class="opt-tag">optional</span></legend>
        ${datePicker({ name: 'date', value: null, time: false, max: Date.now(), optional: true, label: 'Date of the date', role: 'honey' })}
      </fieldset>
      <div class="sheet-actions">
        <button class="btn primary block">Add to the memory book</button>
      </div>
    </form>`, { className: 'wide', onMount: (el) => { wireTextarea(el, { focus: false }); wireDatePickers(el); } });
}

function openStartOverSheet() {
  openSheet(`
    <form class="sheet-body" data-form="start-over">
      <h2 class="h-md">Start a new alphabet?</h2>
      <p class="muted">All 26 letters go back in the bag. Your current memory book will be cleared — save the recap image first if you want to keep it.</p>
      ${optionsPanel({ draw: drawMode(state.data) })}
      <div class="row end">
        <button type="button" class="btn ghost" data-action="close-sheet">Cancel</button>
        <button class="btn danger">Start over</button>
      </div>
    </form>`);
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
        <p class="muted">Clears all 26 letters and starts a fresh alphabet for both of you.</p>
        <button class="btn ghost danger" data-action="start-over">Start a new alphabet</button>
      </div>` : ''}

      <p class="fine">Space code <code class="code-pill">${state.id}</code> · Letters: ${drawMode(d) === 'manual' ? 'picked by you' : 'random draw'}</p>
    </div>`, { className: 'wide' });
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
  setTimeout(checkPlans, 700);
}

/** Toasts for what the partner did since this player last looked. */
function showNews(d) {
  const mine = d.players[state.role];
  const pRole = otherRole(state.role);
  const pName = esc(d.players[pRole]?.name);
  const since = Math.max(mine.seenAt || 0, state.newsSeenAt);
  const events = [];
  for (const l of ALPHABET) {
    const x = d.letters[l];
    if (x.status === 'DONE' && x.completedAt > since && (x.filledBy ?? x.assignedTo) === pRole) {
      events.push({
        at: x.completedAt,
        html: x.retro
          ? `<span class="badge sm honey">${l}</span><span><b>${pName}</b> filled in ${l}: “${esc(x.description)}”</span>`
          : `<span class="badge sm ${pRole}">${l}</span><span><b>${pName}</b> logged their ${l} date: “${esc(x.description)}”</span>`,
        letter: l,
      });
    } else if (x.status === 'ACTIVE' && x.assignedTo === pRole && drawMode(d) === 'manual' && x.drawnAt > since) {
      events.push({ at: x.drawnAt, html: `<span class="badge sm ${pRole}">${l}</span><span><b>${pName}</b> picked ${l} for this round.</span>` });
    }
  }
  if (!events.length) return;
  events.sort((a, b) => a.at - b.at);
  const latest = events[events.length - 1].at;
  state.newsSeenAt = latest;
  events.forEach((ev, i) =>
    setTimeout(() => {
      toast(ev.html, { duration: 5200 });
      if (ev.letter) document.querySelector(`.tile[data-letter="${ev.letter}"]`)?.classList.add('just');
    }, 400 + i * 900));
  markNewsSeen(state.id, state.role, latest).catch(() => {});
}

async function maybeReveal(d) {
  const seen = Math.max(d.players[state.role].seenRound || 0, state.revealedRound);
  if (d.status !== 'ACTIVE' || d.round <= seen || state.revealing) return;
  state.revealedRound = d.round;

  // Manual mode has nothing to reveal — just nudge.
  if (drawMode(d) === 'manual') {
    if (needsPick(d, state.role)) toast(roundInCycle(d) === 1 ? 'Time to pick your first letter ♡' : `Round ${roundInCycle(d)} — time to pick your next letter.`);
    markRoundSeen(state.id, state.role, d.round).catch(() => {});
    return;
  }

  state.revealing = true;
  if (sheet.open) closeSheet();
  const letters = roundLetters(d)
    .sort((a, b) => (d.letters[b].assignedTo === state.role) - (d.letters[a].assignedTo === state.role));
  const pool = ALPHABET.filter((l) => !isDone(d.letters[l]));
  const first = roundInCycle(d) === 1;

  await playReveal({
    title: first ? (d.cycle > 1 ? 'A fresh alphabet' : 'Let the games begin') : `Round ${roundInCycle(d)} of ${totalRounds(d)}`,
    subtitle: first ? (letters.length > 1 ? 'Your first letters are…' : 'Your first letter is…') : 'Fresh letters, new plans.',
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
  setTimeout(checkPlans, 500);
}

/**
 * Date/time follow-ups, shown one at a time and never over another sheet or the reveal:
 *  1. my planned date has passed → "Did it happen?"
 *  2. my partner set (or moved) their date → offer to add it to my calendar
 */
function checkPlans() {
  const d = state.data;
  if (!d || d.status !== 'ACTIVE' || state.revealing || sheet.open || document.visibilityState !== 'visible') return;
  const now = Date.now();
  const current = roundLetters(d).filter((l) => d.letters[l].status === 'ACTIVE' && d.letters[l].plannedAt);

  for (const l of current) {
    const x = d.letters[l];
    const key = `${l}:${x.plannedAt}`;
    if (x.assignedTo === state.role && now > x.plannedAt + HAPPENED_GRACE_MS && !state.prompted.has(key)) {
      state.prompted.add(key);
      openHappenedSheet(l);
      return;
    }
  }

  const seen = Math.max(me().seenPlanAt || 0, state.planSeenAt);
  for (const l of current) {
    const x = d.letters[l];
    if (x.plannedBy && x.plannedBy !== state.role && (x.planUpdatedAt || 0) > seen && x.plannedAt > now) {
      state.planSeenAt = x.planUpdatedAt;
      markPlanSeen(state.id, state.role, x.planUpdatedAt).catch(() => {});
      openCalendarSheet(l, { proactive: true });
      return;
    }
  }
}
setInterval(checkPlans, 60 * 1000);

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
  const d = state.data;

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
    case 'pick':
      openPickSheet();
      break;
    case 'plan':
      openPlanSheet(letter);
      break;
    case 'calendar':
      openCalendarSheet(letter);
      break;
    case 'ics': {
      const ev = calEvent(letter);
      downloadICS(ev, `abc-date-${letter}.ics`);
      break;
    }
    case 'clear-plan':
      try {
        await setPlan(state.id, letter, { plannedAt: null }, state.role);
        closeSheet();
        toast('Date removed');
      } catch (err) {
        fail(err);
      }
      break;
    case 'idea': {
      const ta = sheet.querySelector('textarea');
      ta.value = value;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      break;
    }
    case 'tile': {
      const x = d?.letters[letter];
      if (!x) break;
      if (x.status === 'DONE') openDetailSheet(letter);
      else if (x.status === 'PREDONE') openFillSheet(letter);
      else if (x.status === 'UNUSED' && needsPick(d, state.role)) openPickSheet(letter);
      else if (x.status === 'ACTIVE' && x.assignedTo === state.role && d.status === 'ACTIVE') {
        if (x.plannedAt) openLogSheet(letter);
        else openPlanSheet(letter);
      }
      else if (x.status === 'ACTIVE') {
        if (x.plannedAt) openCalendarSheet(letter);
        else toast(`${letter} is ${esc(partner().name)}’s letter this round.`);
      }
      break;
    }
    case 'start-over':
      openStartOverSheet();
      break;
    case 'export-text':
      if (await copyText(exportText(d))) toast('Recap copied to clipboard');
      break;
    case 'export-png':
      await busy(el, async () => {
        const blob = await renderRecapPNG(d);
        const names = `${d.players.p1.name}-${d.players.p2.name}`.replace(/[^\w-]+/g, '');
        await saveOrShareImage(blob, `abc-dates-${names || 'recap'}.png`);
      });
      break;
    default:
  }
});

// Live summary + limits for the "Options" panel.
document.addEventListener('change', (e) => {
  const panel = e.target.closest('details.options');
  if (!panel) return;
  const checked = panel.querySelectorAll('input[name="pre"]:checked');
  if (e.target.name === 'pre' && 26 - checked.length < MIN_OPEN) {
    e.target.checked = false;
    toast('Leave at least one letter to play for ♡');
  }
  const draw = panel.querySelector('input[name="draw"]:checked')?.value;
  panel.querySelector('.options-hint').textContent =
    optionsSummary(draw, panel.querySelectorAll('input[name="pre"]:checked').length);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (!navigator.onLine) {
    toast('You seem to be offline — try again once you’re connected.', { tone: 'error' });
    return;
  }
  const button = e.submitter || form.querySelector('button:not([type="button"])');
  const kind = form.dataset.form;
  const run = (fn) => busy(button, async () => {
    try {
      await fn();
    } catch (err) {
      fail(err);
    }
  });

  if (kind === 'create') {
    const name = form.name.value.trim();
    if (!name) return;
    await run(async () => {
      const id = await createSeries(name, state.uid, readOptions(form));
      navigate(`/s/${id}`);
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
    await run(async () => {
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
    });
  }

  if (kind === 'pick') {
    const letter = new FormData(form).get('letter');
    if (!letter) return;
    await run(async () => {
      await pickLetter(state.id, letter, state.role);
      closeSheet();
      setTimeout(() => {
        const card = document.querySelector(`.round-card[data-letter="${letter}"]`);
        card?.classList.add('arrive');
        sparkle(card, 18);
      }, 250);
      toast(`${letter} is yours. Time to plan something ♡`);
    });
  }

  if (kind === 'plan') {
    const letter = form.dataset.letter;
    const plannedAt = new Date(form.when.value).getTime();
    if (!Number.isFinite(plannedAt)) {
      toast('Pick a date and time first.', { tone: 'error' });
      return;
    }
    const where = form.where.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LOCATION);
    await run(async () => {
      await setPlan(state.id, letter, { plannedAt, location: where }, state.role);
      state.prompted.add(`${letter}:${plannedAt}`); // don't immediately ask "did it happen?" for a past time they just chose
      openCalendarSheet(letter, { justSaved: true });
    });
  }

  if (kind === 'fill') {
    const letter = form.dataset.letter;
    const desc = form.desc.value.replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
    if (!desc) return;
    const dateAt = form.date.value ? new Date(`${form.date.value}T12:00`).getTime() : null;
    const plannedBy = new FormData(form).get('by') || state.role;
    await run(async () => {
      await fillPredone(state.id, letter, { description: desc, dateAt, plannedBy }, state.role);
      closeSheet();
      toast(`${letter} is in the memory book ♡`);
    });
  }

  if (kind === 'start-over') {
    await run(async () => {
      state.celebrated = false;
      await startOver(state.id, readOptions(form));
      closeSheet();
    });
  }

  if (kind === 'rename') {
    const name = form.name.value.trim();
    if (!name) return;
    await run(async () => {
      await renamePlayer(state.id, state.role, name);
      toast('Name updated');
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
