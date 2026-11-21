import './style.css';
import { LANGS, getLang, locale, setLang, t } from './i18n.js';
import { getTheme, setTheme } from './theme.js';
import { ensureUser } from './firebase.js';
import {
  ALPHABET, MAX_DESC, MAX_LOCATION, MAX_NAME, MIN_OPEN, SPACE_LEN, claimRole, completeLetter, createSeries,
  drawMode, editDescription, fillPredone, formatCode, getKeys, isDone, joinSeries, markNewsSeen, markPlanSeen,
  markRoundSeen, needsPick, otherRole, parseCode, peekSeries, pickLetter, progress, renamePlayer, roleOf,
  roundInCycle, roundLetters, setPlan, startOver, subscribe, totalRounds,
} from './game.js';
import { ideasFor } from './ideas.js';
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
  redraw: null, // re-renders the current screen in place (e.g. after a language switch)
  keys: null, // { id, keys } — personal codes, cached for the settings sheet
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

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : '');
const fmtDateLong = (ms) =>
  ms ? new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const fmtWhen = (ms) =>
  new Date(ms).toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtWhenLong = (ms) =>
  new Date(ms).toLocaleString(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

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
    ? t('offline')
    : err?.code === 'permission-denied'
      ? t('denied')
      : err?.message || t('genericError');
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
  if (await copyText(url)) toast(t('linkCopied'));
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
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none"/></svg>',
};

const mark = (sm = false) => `<span class="mark${sm ? ' sm' : ''}" aria-hidden="true"><i>a</i><i>b</i><i>c</i></span>`;

function header() {
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
      <button class="icon-btn" data-action="settings" aria-label="${t('settings')}">${ICON.gear}</button>
    </header>`;
}

function linkBox(url, { label = t('copyLink'), shareTitle = 'ABC Dates' } = {}) {
  return `
    <div class="linkbox">
      <span class="linkbox-url">${esc(url.replace(/^https?:\/\//, ''))}</span>
      <div class="linkbox-actions">
        <button class="btn soft sm" data-action="copy" data-value="${esc(url)}">${ICON.copy}<span>${label}</span></button>
        <button class="btn soft sm icon-only" data-action="share" data-value="${esc(url)}" data-title="${esc(shareTitle)}" aria-label="${t('share')}">${ICON.share}</button>
      </div>
    </div>`;
}

function codeForm({ id = '', autofocus = false } = {}) {
  return `
    <form class="code-form" data-form="code">
      <label class="label" for="code-input">${t('personalCode')}</label>
      <div class="row">
        <input id="code-input" name="code" class="input code" autocomplete="off" autocapitalize="characters"
          spellcheck="false" placeholder="${id ? `${esc(id)}-XXXXX` : 'XXXXXX-XXXXX'}" maxlength="13" required ${autofocus ? 'autofocus' : ''}>
        <button class="btn primary">${t('open')}</button>
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
  const parts = [draw === 'manual' ? t('pickYourselves') : t('randomDraw')];
  if (preCount) parts.push(t('nAlreadyDone', preCount));
  return parts.join(' · ');
}

/** The quiet "Options" disclosure used when starting a new alphabet. */
function optionsPanel({ draw = 'random' } = {}) {
  return `
    <details class="options">
      <summary>${ICON.sliders}<span>${t('options')}</span><span class="options-hint">${optionsSummary(draw, 0)}</span>${ICON.chevron}</summary>
      ${optionsBody(draw)}
    </details>`;
}

function optionsBody(draw = 'random') {
  return `
      <div class="options-body">
        <fieldset class="opt">
          <legend class="label">${t('howGetLetters')}</legend>
          ${segmented('draw', [
            { value: 'random', label: t('randomDraw'), icon: ICON.dice },
            { value: 'manual', label: t('pickYourselves'), icon: ICON.hand },
          ], draw === 'manual' ? 'manual' : 'random')}
        </fieldset>
        <fieldset class="opt">
          <legend class="label">${t('alreadyDoneQ')}</legend>
          <p class="fine">${t('alreadyDoneHelp')}</p>
          <div class="pre-grid">
            ${ALPHABET.map((l) => `<label class="pre"><input type="checkbox" name="pre" value="${l}"><span>${l}</span></label>`).join('')}
          </div>
        </fieldset>
      </div>`;
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
      <span class="cal-month">${dt.toLocaleDateString(locale(), { month: 'short' })}</span>
      <span class="cal-day">${dt.getDate()}</span>
    </div>`;
}

/* ---------------------------------------------------------------- screens */

function renderLoading(text = t('loading')) {
  mount('loading', `<main class="screen center"><div class="loader"><i></i><i></i><i></i></div><p class="muted">${text}</p></main>`);
}

function renderLanding() {
  state.redraw = renderLanding;
  const spaces = recallSpaces();
  mount('landing', `
    <main class="screen landing">
      ${header()}
      <section class="hero">
        <div class="hero-tiles" aria-hidden="true">
          <span class="tile-xl p1">A</span><span class="tile-xl honey">B</span><span class="tile-xl p2">C</span>
        </div>
        <h1>${t('heroTitle')}</h1>
        <p class="lede">${t('heroLede')}</p>
      </section>

      ${spaces.length ? `
        <section class="resume">
          ${spaces.map((s) => `
            <a class="resume-card" href="/s/${esc(s.id)}" data-link>
              ${mark(true)}
              <span class="resume-text"><b>${esc(s.me)}${s.partner ? ` &amp; ${esc(s.partner)}` : ''}</b><small>${t('continueSeries')}</small></span>
              ${ICON.arrow}
            </a>`).join('')}
        </section>` : ''}

      <form class="create" data-form="create">
        <div class="create-row">
          <input id="name" name="name" class="input" maxlength="${MAX_NAME}" placeholder="${t('namePrompt')}" aria-label="${t('namePrompt')}" autocomplete="given-name" required>
          <button type="button" class="btn opt-toggle" data-action="toggle" aria-controls="create-options" aria-expanded="false" aria-label="${t('options')}" title="${t('options')}">${ICON.sliders}<i class="opt-badge" hidden></i></button>
          <button class="btn primary">${t('start')} ${ICON.arrow}</button>
        </div>
        <div class="options create-options" id="create-options" hidden>${optionsBody()}</div>
      </form>

      <p class="create-foot">
        <span>${t('willGetLink')}</span>
        <span class="sep" aria-hidden="true"></span>
        <button type="button" class="link-btn" data-action="toggle" aria-controls="have-code" aria-expanded="false" data-focus="#code-input">${t('otherDevice')}</button>
      </p>
      <div class="have-code" id="have-code" hidden>
        <p class="muted">${t('enterCode')}</p>
        ${codeForm()}
      </div>

      <section class="how">
        <h2 class="eyebrow how-title">${t('howTitle')}</h2>
        <ol class="how-steps">
          <li class="how-step"><span class="how-num">1</span><div><h3>${t('step1Title')}</h3><p>${t('step1')}</p></div></li>
          <li class="how-step"><span class="how-num">2</span><div><h3>${t('step2Title')}</h3><p>${t('step2')}</p></div></li>
          <li class="how-step"><span class="how-num">3</span><div><h3>${t('step3Title')}</h3><p>${t('step3')}</p></div></li>
        </ol>
      </section>
      <footer class="foot">${t('foot')}</footer>
    </main>`);
}

function renderJoin(d) {
  state.redraw = () => renderJoin(d);
  const manual = drawMode(d) === 'manual';
  const pre = progress(d);
  mount('join', `
    <main class="screen narrow">
      ${header()}
      <section class="hero small">
        <div class="hero-tiles sm" aria-hidden="true"><span class="tile-xl p1">${esc(d.players.p1.name[0]?.toUpperCase() || 'A')}</span><span class="tile-xl honey">&amp;</span><span class="tile-xl p2">?</span></div>
        <p class="eyebrow">${t('invited')}</p>
        <h1>${t('joinTitle', esc(d.players.p1.name), 26 - pre)}</h1>
        <p class="lede">${t('joinLede')}${pre ? t('joinPre', pre) : ''}</p>
      </section>
      <form class="card" data-form="join">
        <label class="label" for="name">${t('yourName')}</label>
        <input id="name" name="name" class="input" maxlength="${MAX_NAME}" placeholder="${t('joinPlaceholder')}" autocomplete="given-name" required autofocus>
        <button class="btn primary block">${manual ? t('joinPick') : t('joinDraw')} ${ICON.arrow}</button>
      </form>
    </main>`);
}

function renderLocked(id, message = '') {
  state.redraw = () => renderLocked(id, message);
  mount('locked', `
    <main class="screen narrow">
      ${header()}
      <section class="hero small">
        <div class="hero-tiles sm" aria-hidden="true"><span class="tile-xl p1">?</span><span class="tile-xl honey">?</span></div>
        <p class="eyebrow">${t('privateSpace')}</p>
        <h1>${t('seriesFull')}</h1>
        <p class="lede">${message ? esc(message) + ' ' : ''}${t('lockedLede')}</p>
      </section>
      <div class="card">${codeForm({ id, autofocus: true })}</div>
      <p class="center-text"><a href="/" data-link class="text-link">${t('startOwn')}</a></p>
    </main>`);
}

function renderWaiting() {
  state.redraw = renderWaiting;
  const d = state.data;
  mount('waiting', `
    <main class="screen narrow">
      ${header()}
      <section class="hero small">
        <div class="shuffle" aria-hidden="true"><span class="tile-xl p1 s1">A</span><span class="tile-xl honey s2">B</span><span class="tile-xl p2 s3">C</span></div>
        <p class="eyebrow">${t('almostThere')}</p>
        <h1>${t('inviteTitle')}</h1>
        <p class="lede">${t('waitLede', drawMode(d) === 'manual')}</p>
      </section>
      <div class="card">
        ${linkBox(spaceUrl(state.id), { label: t('copyInvite'), shareTitle: t('invitedYou', d.players.p1.name) })}
        <div class="waiting-line"><span class="pulse"></span>${t('waitingPartner')}</div>
      </div>
      <p class="fine center-text">${t('testingAlone')}</p>
    </main>`);
}

/* ---- round cards */

function roundCard({ letter, role, pick }) {
  const d = state.data;
  const mine = role === state.role;
  const owner = d.players[role];
  const ownerLabel = mine ? t('yourLetter') : t('theirLetter', esc(owner.name));
  const top = (extra = '') => `<div class="rc-top"><span class="rc-owner"><span class="dot ${role}"></span>${ownerLabel}</span>${extra}</div>`;
  const ideas = (l) => `${t('ideas')} ${ideasFor(l).slice(0, 2).map(esc).join(' · ')}`;

  if (pick) {
    return mine
      ? `<button class="round-card ${role} mine pick" data-action="pick">
          ${top()}
          <div class="rc-letter">?</div>
          <p class="rc-ideas">${t('chooseAnyOpen')}</p>
          <span class="rc-cta"><span class="wide-only">${t('pickYourLetter')}</span><span class="narrow-only">${t('pickShort')}</span>${ICON.arrow}</span>
        </button>`
      : `<div class="round-card ${role} theirs">
          ${top()}
          <div class="rc-letter">?</div>
          <p class="rc-wait">${t('isChoosing', esc(owner.name))}<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>
        </div>`;
  }

  const x = d.letters[letter];
  if (x.status === 'DONE') {
    return `
      <div class="round-card ${role} done" data-letter="${letter}">
        ${top(`<span class="rc-badge" aria-label="${t('done')}">${ICON.check}<span class="wide-only">${t('done')}</span></span>`)}
        <div class="rc-letter">${letter}</div>
        <p class="rc-desc">${t('quote', esc(x.description))}</p>
      </div>`;
  }
  if (mine) {
    return `
      <div class="round-card ${role} mine" data-letter="${letter}">
        ${top()}
        <div class="rc-letter">${letter}</div>
        ${x.plannedAt ? planChip(letter, { action: 'plan' }) : `<p class="rc-ideas">${ideas(letter)}</p>`}
        <div class="rc-actions">
          ${x.plannedAt
            ? `<button class="rc-cta" data-action="log" data-letter="${letter}">${ICON.check}<span class="wide-only">${t('logOur', letter)}</span><span class="narrow-only">${t('logShort')}</span></button>
               <button class="rc-icon" data-action="calendar" data-letter="${letter}" aria-label="${t('addToCalendar')}" title="${t('addToCalendar')}">${ICON.calPlus}</button>`
            : `<button class="rc-cta" data-action="plan" data-letter="${letter}">${ICON.calPlus}<span class="wide-only">${t('planTheDate')}</span><span class="narrow-only">${t('planShort')}</span></button>
               <button class="rc-icon" data-action="log" data-letter="${letter}" aria-label="${t('alreadyDoneLog')}" title="${t('alreadyDoneLog')}">${ICON.check}</button>`}
        </div>
      </div>`;
  }
  return `
    <div class="round-card ${role} theirs" data-letter="${letter}">
      ${top()}
      <div class="rc-letter">${letter}</div>
      ${x.plannedAt
        ? `<p class="rc-wait">${t('hasPlan', esc(owner.name))}</p>${planChip(letter)}`
        : `<p class="rc-wait">${t('isPlanning', esc(owner.name))}<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>`}
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
  if (!mine) return isDoneCard(theirs) ? t('hlLastOne') : t('hlLastTheirs', pName);
  if (mine.pick) return theirs && !theirs.pick ? t('hlPickedYourTurn', pName, theirs.letter) : t('hlPickAny');
  if (!theirs) return isDoneCard(mine) ? t('hlLastOne') : t('hlLastMine');
  if (isDoneCard(mine) && theirs.pick) return t('hlNiceStillPick', pName);
  if (isDoneCard(mine) && !isDoneCard(theirs)) return t('hlNiceTheirTurn', pName);
  if (!isDoneCard(mine) && isDoneCard(theirs)) return t('hlTheyreDone', pName);
  const mineX = d.letters[mine.letter];
  if (mineX.plannedAt > Date.now()) return t('hlComingUp', mine.letter);
  if (mineX.plannedAt) return t('hlHowWas', mine.letter);
  if (!theirs.pick && d.letters[theirs.letter]?.plannedAt) return t('hlTheyHavePlan', pName);
  if (roundInCycle(d) === 1) return t('hlPlanWith', mine.letter);
  return t('hlTwoLetters');
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
    PREDONE: t('tilePre', letter),
    ACTIVE: t('tileActive', letter),
    UNUSED: canPick ? t('tilePick', letter) : t('tileUnused', letter),
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
    <section class="sec board">
      <div class="sec-head">
        <h2 class="h-sec">${t('theAlphabet')}</h2>
        <span class="count"><b>${done}</b>/26</span>
      </div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="26" aria-valuenow="${done}">
        <span class="bar-seg honey" style="width:${(pre / 26) * 100}%"></span><span class="bar-seg p1" style="width:${(by('p1') / 26) * 100}%"></span><span class="bar-seg p2" style="width:${(by('p2') / 26) * 100}%"></span>
      </div>
      ${pickable ? `<p class="board-hint">${t('tapOpen')}</p>` : ''}
      <div class="grid ${pickable ? 'picking' : ''}">${ALPHABET.map((l) => tile(l, prev, pickable)).join('')}</div>
      <p class="fine legend"><span><i class="lg done"></i>${t('lgDone')}</span><span><i class="lg active"></i>${t('lgActive')}</span><span><i class="lg unused"></i>${t('lgUnused', left)}</span></p>
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
            <span class="memory-desc muted-desc">${t('preDesc')}</span>
            <span class="memory-meta">${t('preMeta')}</span>
          </span>
        </button>
      </li>`;
  }
  const who = x.assignedTo === state.role ? t('yourPick') : t('theirPick', esc(d.players[x.assignedTo]?.name));
  return `
    <li>
      <button class="memory" data-action="tile" data-letter="${letter}">
        <span class="badge ${x.assignedTo}">${letter}</span>
        <span class="memory-text">
          <span class="memory-desc">${esc(x.description)}</span>
          <span class="memory-meta">${who} · ${fmtDate(dateOf(x))}${x.location ? ` · ${esc(x.location)}` : ''}</span>
        </span>
      </button>
    </li>`;
}

function renderDashboard(prev) {
  state.redraw = () => renderDashboard();
  const d = state.data;
  const cards = currentCards(d);
  const memories = ALPHABET.filter((l) => d.letters[l].status === 'DONE')
    .sort((a, b) => d.letters[b].completedAt - d.letters[a].completedAt);
  const pre = ALPHABET.filter((l) => d.letters[l].status === 'PREDONE');

  mount('dashboard', `
    <main class="screen dash">
      ${header()}
      <div class="dash-grid">
        <section class="sec round">
          <p class="eyebrow">${t('roundOf', roundInCycle(d), totalRounds(d))}</p>
          <h1 class="h-md">${roundHeadline(d, cards)}</h1>
          <div class="round-cards">${cards.map(roundCard).join('')}</div>
        </section>
        ${board(prev)}
        <section class="sec memories">
          <div class="sec-head"><h2 class="h-sec">${t('memoryBook')}</h2>${memories.length ? `<span class="count">${t('nDates', memories.length)}</span>` : ''}</div>
          ${memories.length
            ? `<ul class="memory-list">${memories.map(memoryItem).join('')}</ul>`
            : `<p class="empty">${t('memoryEmpty')}</p>`}
          ${pre.length ? `
            <div class="pre-note">
              <p class="fine">${t('preNote')}</p>
              <div class="pre-chips">${pre.map((l) => `<button class="badge honey sm" data-action="tile" data-letter="${l}" aria-label="${t('fillInLetter', l)}">${l}</button>`).join('')}</div>
            </div>` : ''}
        </section>
      </div>
    </main>`);
}

function renderCompleted(prev) {
  state.redraw = () => renderCompleted();
  const d = state.data;
  const times = ALPHABET.map((l) => d.letters[l]).filter((x) => x.status === 'DONE').map(dateOf).filter(Boolean);
  const days = times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 864e5)) : 0;
  const cycles = d.cycle || 1;
  mount('completed', `
    <main class="screen dash">
      ${header()}
      <section class="celebrate">
        <div class="hero-tiles" aria-hidden="true"><span class="tile-xl p1">A</span><span class="tile-xl honey">♡</span><span class="tile-xl p2">Z</span></div>
        <p class="eyebrow">${t('seriesComplete')}</p>
        <h1>${t('allDone')}</h1>
        <div class="stats">
          <div><b>26</b><span>${t('statDates')}</span></div>
          <div><b>${days}</b><span>${t('statDays', days)}</span></div>
          <div><b>${cycles}</b><span>${t('statAlphabets', cycles)}</span></div>
        </div>
        <div class="export-row">
          <button class="btn primary" data-action="export-png">${ICON.image}<span>${t('saveRecap')}</span></button>
          <button class="btn soft" data-action="export-text">${ICON.text}<span>${t('copyAsText')}</span></button>
        </div>
      </section>
      <section class="sec memories">
        <div class="sec-head"><h2 class="h-sec">${t('yourAlphabet')}</h2></div>
        <ul class="memory-list">${ALPHABET.map(memoryItem).join('')}</ul>
      </section>
      <div class="center-text again">
        <button class="btn ghost" data-action="start-over">${t('newAlphabet')}</button>
      </div>
    </main>`);

  const justFinished = prev && prev.status !== 'COMPLETED';
  if (justFinished || !state.celebrated) {
    state.celebrated = true;
    setTimeout(() => confetti(), 250);
  }
}

/* ------------------------------------------------------------------ sheets */

/**
 * `inPlace` swaps the content of an already-open sheet without replaying its
 * entrance animation (used when the settings sheet re-renders itself).
 */
function openSheet(html, { onMount, className = '', inPlace = false } = {}) {
  const scroller = sheet.querySelector('.sheet-scroll');
  sheet.className = `sheet ${className}`;
  if (inPlace && sheet.open && scroller) {
    scroller.innerHTML = html;
    sheet.querySelector('.sheet-close')?.setAttribute('aria-label', t('close'));
  } else {
    sheet.innerHTML = `
      <div class="sheet-card">
        <button class="icon-btn sheet-close" data-action="close-sheet" aria-label="${t('close')}">${ICON.close}</button>
        <div class="sheet-scroll" tabindex="-1" autofocus>${html}</div>
      </div>`;
  }
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
  const ideas = ideasFor(letter);
  openSheet(`
    <form class="sheet-body" data-form="log" data-letter="${letter}" data-edit="${edit ? '1' : ''}">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <h2 class="h-md">${edit ? t('editYourDate', letter) : t('whatDidYouDo', letter)}</h2>
      <p class="muted">${t('fewWords')}</p>
      ${descField(value, t('logPlaceholder', ideas[0]))}
      ${edit ? '' : `
        <div class="ideas">
          <span class="fine">${t('quickStart')}</span>
          ${ideas.map((i) => `<button type="button" class="chip" data-action="idea" data-value="${esc(i)}">${esc(i)}</button>`).join('')}
        </div>`}
      <button class="btn primary block">${edit ? t('saveChanges') : t('saveOurDate', letter)}</button>
    </form>`, { className: x.assignedTo, onMount: (el) => wireTextarea(el) });
}

function openDetailSheet(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const canEdit = x.assignedTo === state.role || x.filledBy === state.role;
  openSheet(`
    <div class="sheet-body">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <p class="eyebrow">${x.assignedTo === state.role ? t('yourPick') : t('theirPick', esc(d.players[x.assignedTo]?.name))} · ${fmtDateLong(dateOf(x))}</p>
      <p class="quote">${t('quote', esc(x.description))}</p>
      ${x.location ? `<p class="muted where">${ICON.pin}<span>${esc(x.location)}</span></p>` : ''}
      ${canEdit ? `<button class="btn soft block" data-action="edit" data-letter="${letter}">${ICON.edit}<span>${t('editDescription')}</span></button>` : ''}
    </div>`, { className: x.assignedTo });
}

/** Manual mode: choose your letter for this round. */
function openPickSheet(preselect = null) {
  const d = state.data;
  const open = ALPHABET.filter((l) => d.letters[l].status === 'UNUSED');
  const sel = open.includes(preselect) ? preselect : null;
  const ideaLine = (l) => `${t('ideas')} ${ideasFor(l).join(' · ')}`;
  openSheet(`
    <form class="sheet-body" data-form="pick">
      <p class="eyebrow">${t('roundOf', roundInCycle(d), totalRounds(d))}</p>
      <h2 class="h-md">${t('pickTitle')}</h2>
      <p class="muted">${t('pickLede')}</p>
      <div class="pick-grid ${state.role}">
        ${open.map((l) => `<label class="pick-opt"><input type="radio" name="letter" value="${l}" ${l === sel ? 'checked' : ''} required><span>${l}</span></label>`).join('')}
      </div>
      <p class="fine pick-ideas">${sel ? esc(ideaLine(sel)) : '&nbsp;'}</p>
      <button class="btn primary block" ${sel ? '' : 'disabled'}>${sel ? t('takeLetter', sel) : t('chooseLetter')}</button>
    </form>`, {
    className: state.role,
    onMount: (el) => {
      const btn = el.querySelector('button.btn.primary');
      const ideas = el.querySelector('.pick-ideas');
      el.querySelector('form').addEventListener('change', (e) => {
        const l = e.target.value;
        btn.disabled = false;
        btn.textContent = t('takeLetter', l);
        ideas.textContent = ideaLine(l);
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
          <h2 class="h-md">${x.plannedAt ? t('moveDate', letter) : t('whensDate', letter)}</h2>
          <p class="muted">${t('headsUp', esc(pName))}</p>
        </div>
      </div>
      ${datePicker({ name: 'when', value: x.plannedAt || tomorrowEvening(), time: true, min: Date.now(), label: t('dateAndTime'), role: x.assignedTo })}
      <div class="plan-fields">
        <label class="label" for="plan-where">${ICON.pin}${t('where')} <span class="opt-tag">${t('optional')}</span></label>
        <input id="plan-where" name="where" class="input" maxlength="${MAX_LOCATION}" value="${esc(x.location || '')}" placeholder="${t('wherePlaceholder')}" autocomplete="off">
      </div>
      <div class="sheet-actions">
        ${x.plannedAt ? `<button type="button" class="btn ghost" data-action="clear-plan" data-letter="${letter}">${t('remove')}</button>` : ''}
        <button class="btn primary">${ICON.check}<span>${t('saveTheDate')}</span></button>
      </div>
    </form>`, { className: `wide ${x.assignedTo}`, onMount: wireDatePickers });
}

function calEvent(letter) {
  const d = state.data;
  const x = d.letters[letter];
  const ownerName = d.players[x.assignedTo]?.name;
  return {
    uid: `${state.id}-${d.cycle || 1}-${letter}@abc-dates`,
    title: t('calTitle', letter, partner()?.name ?? '').trim(),
    start: x.plannedAt,
    location: x.location || '',
    details: t('calDetails', letter, ownerName),
    url: spaceUrl(state.id),
  };
}

function openCalendarSheet(letter, { proactive = false, justSaved = false } = {}) {
  const d = state.data;
  const x = d.letters[letter];
  if (!x.plannedAt) return;
  const mine = x.assignedTo === state.role;
  const eyebrow = proactive
    ? t('plannedThe', esc(d.players[x.plannedBy || x.assignedTo]?.name), letter)
    : justSaved ? t('savedHeart') : mine ? t('yourLDate', letter) : t('theirLDate', esc(d.players[x.assignedTo]?.name), letter);
  openSheet(`
    <div class="sheet-body">
      ${calBadge(x.plannedAt, x.assignedTo)}
      <p class="eyebrow">${eyebrow}</p>
      <h2 class="h-md">${esc(fmtWhenLong(x.plannedAt))}</h2>
      ${x.location ? `<p class="muted where">${ICON.pin}<span>${esc(x.location)}</span></p>` : ''}
      <p class="muted">${proactive ? t('wantCalendar') : t('addSoNoForget')}</p>
      <div class="cal-actions">
        <button class="btn primary block" data-action="ics" data-letter="${letter}">${ICON.calPlus}<span>${t('addToCalendar')}</span></button>
        <a class="btn soft block" href="${esc(googleCalendarUrl(calEvent(letter)))}" target="_blank" rel="noopener">${t('googleCalendar')}</a>
      </div>
      <div class="row center">
        ${mine && x.status === 'ACTIVE' ? `<button class="btn ghost sm" data-action="plan" data-letter="${letter}">${ICON.edit}<span>${t('change')}</span></button>` : ''}
        <button class="btn ghost sm" data-action="close-sheet">${proactive || justSaved ? t('notNow') : t('close')}</button>
      </div>
    </div>`, { className: x.assignedTo });
}

function openHappenedSheet(letter) {
  const x = state.data.letters[letter];
  openSheet(`
    <div class="sheet-body">
      <div class="sheet-letter ${x.assignedTo}">${letter}</div>
      <h2 class="h-md">${t('didHappen', letter)}</h2>
      <p class="muted">${t('plannedFor', esc(fmtWhen(x.plannedAt)), x.location ? esc(x.location) : '')}</p>
      <button class="btn primary block" data-action="log" data-letter="${letter}">${ICON.check}<span>${t('yesLog')}</span></button>
      <button class="btn soft block" data-action="plan" data-letter="${letter}">${ICON.calendar}<span>${t('notYet')}</span></button>
    </div>`, { className: x.assignedTo });
}

/** Fill in a letter that was marked "already done" when the series started. */
function openFillSheet(letter) {
  const d = state.data;
  const pRole = otherRole(state.role);
  openSheet(`
    <form class="sheet-body" data-form="fill" data-letter="${letter}">
      <div class="sheet-letter honey">${letter}</div>
      <h2 class="h-md">${t('fillTitle', letter)}</h2>
      <p class="muted">${t('fillLede')}</p>
      ${descField('', t('logPlaceholder', ideasFor(letter)[0]))}
      <fieldset class="opt plan-fields">
        <legend class="label">${t('whoPlanned')}</legend>
        ${segmented('by', [
          { value: state.role, label: esc(me().name), role: state.role },
          { value: pRole, label: esc(d.players[pRole]?.name), role: pRole },
        ], state.role)}
      </fieldset>
      <fieldset class="opt plan-fields">
        <legend class="label">${ICON.calendar}${t('whenWasIt')} <span class="opt-tag">${t('optional')}</span></legend>
        ${datePicker({ name: 'date', value: null, time: false, max: Date.now(), optional: true, label: t('dateOfDate'), role: 'honey' })}
      </fieldset>
      <div class="sheet-actions">
        <button class="btn primary block">${t('addToBook')}</button>
      </div>
    </form>`, { className: 'wide honey', onMount: (el) => { wireTextarea(el, { focus: false }); wireDatePickers(el); } });
}

function openStartOverSheet() {
  openSheet(`
    <form class="sheet-body" data-form="start-over">
      <h2 class="h-md">${t('startOverQ')}</h2>
      <p class="muted">${t('startOverLede')}</p>
      ${optionsPanel({ draw: drawMode(state.data) })}
      <div class="row end">
        <button type="button" class="btn ghost" data-action="close-sheet">${t('cancel')}</button>
        <button class="btn danger">${t('startOver')}</button>
      </div>
    </form>`);
}

/** Language + light/dark — available everywhere, also before joining a series. */
function prefsBlock() {
  return `
    <div class="set-block prefs">
      ${LANGS.length > 1 ? `
      <fieldset class="opt">
        <legend class="label">${t('language')}</legend>
        ${segmented('pref-lang', LANGS.map((l) => ({ value: l.code, label: l.label })), getLang())}
      </fieldset>` : ''}
      <fieldset class="opt">
        <legend class="label">${t('appearance')}</legend>
        ${segmented('pref-theme', [
          { value: 'system', label: t('themeSystem'), icon: ICON.auto },
          { value: 'light', label: t('themeLight'), icon: ICON.sun },
          { value: 'dark', label: t('themeDark'), icon: ICON.moon },
        ], getTheme())}
      </fieldset>
    </div>`;
}

async function openSettings({ inPlace = false } = {}) {
  const d = state.data;
  const inSeries = d && state.role && state.id;
  const title = `<h2 class="h-md">${t('settings')}</h2>`;
  if (!inSeries) {
    openSheet(`<div class="sheet-body left">${title}${prefsBlock()}</div>`, { className: 'wide', inPlace });
    return;
  }

  let keys = state.keys?.id === state.id ? state.keys.keys : null;
  if (!keys) {
    openSheet(`<div class="sheet-body left">${title}${prefsBlock()}<div class="loader sm"><i></i><i></i><i></i></div></div>`, { className: 'wide', inPlace });
    keys = await getKeys(state.id);
    state.keys = { id: state.id, keys };
    if (!sheet.open) return;
    inPlace = true;
  }
  const myRole = state.role;
  const pRole = otherRole(myRole);
  const myKey = keys[myRole];
  const pKey = keys[pRole];
  const myName = esc(me().name);
  const pName = partner() ? esc(partner().name) : '';
  openSheet(`
    <div class="sheet-body left">
      ${title}
      ${prefsBlock()}

      <form class="set-block" data-form="rename">
        <label class="label" for="rename"><span class="dot ${myRole}"></span>${t('yourName')}</label>
        <div class="row">
          <input id="rename" name="name" class="input" maxlength="${MAX_NAME}" value="${myName}" required>
          <button class="btn soft">${t('save')}</button>
        </div>
      </form>

      ${myKey ? `
      <div class="set-block devices">
        <h3 class="h-xs">${t('otherDevices')}</h3>
        <p class="muted">${t('otherDevicesLede', myName)}</p>
        ${linkBox(personalUrl(state.id, myKey), { shareTitle: t('myLinkTitle') })}
        <p class="fine">${t('orTypeCode')} <code class="code-pill">${formatCode(state.id, myKey)}</code></p>
      </div>` : ''}

      ${partner() && pKey ? `
      <div class="set-block lost">
        <h3 class="h-xs">${t('lostAccess', pName)}</h3>
        <p class="muted">${t('lostAccessLede', pName)}</p>
        ${linkBox(personalUrl(state.id, pKey), { label: t('copyTheirLink', pName), shareTitle: t('yourLinkTitle') })}
      </div>` : ''}

      ${partner() ? `
      <div class="set-block switch">
        <h3 class="h-xs">${t('notMe', myName)}</h3>
        <p class="muted">${t('switchLede')}</p>
        ${codeForm({ id: state.id })}
      </div>` : ''}

      ${d.status !== 'WAITING' ? `
      <div class="set-block danger">
        <h3 class="h-xs">${t('startOver')}</h3>
        <p class="muted">${t('startOverSettingsLede')}</p>
        <button class="btn ghost danger" data-action="start-over">${t('newAlphabet')}</button>
      </div>` : ''}

      <p class="fine">${t('spaceCode')} <code class="code-pill">${state.id}</code> · ${t('lettersMode', drawMode(d) === 'manual')}</p>
    </div>`, { className: 'wide', inPlace });
}

/* ---------------------------------------------------- realtime + reveals */

function onSeries(d) {
  if (!d) {
    renderLocked(state.id, t('seriesGone'));
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
          ? `<span class="badge sm honey">${l}</span><span>${t('newsFilled', pName, l, esc(x.description))}</span>`
          : `<span class="badge sm ${pRole}">${l}</span><span>${t('newsLogged', pName, l, esc(x.description))}</span>`,
        letter: l,
      });
    } else if (x.status === 'ACTIVE' && x.assignedTo === pRole && drawMode(d) === 'manual' && x.drawnAt > since) {
      events.push({ at: x.drawnAt, html: `<span class="badge sm ${pRole}">${l}</span><span>${t('newsPicked', pName, l)}</span>` });
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
    if (needsPick(d, state.role)) toast(roundInCycle(d) === 1 ? t('nudgeFirst') : t('nudgeNext', roundInCycle(d)));
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
    title: first ? (d.cycle > 1 ? t('revealFresh') : t('revealBegin')) : t('roundOf', roundInCycle(d), totalRounds(d)),
    subtitle: first ? (letters.length > 1 ? t('revealFirstMany') : t('revealFirstOne')) : t('revealFreshLetters'),
    pool,
    cards: letters.map((l) => ({
      letter: l,
      role: d.letters[l].assignedTo,
      name: esc(d.players[d.letters[l].assignedTo].name),
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
    toast(role ? t('deviceConnected') : t('codeNoMatch'), { tone: role ? '' : 'error' });
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
        if (span) span.textContent = t('copied');
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
    case 'toggle': {
      const target = document.getElementById(el.getAttribute('aria-controls'));
      if (!target) break;
      const open = target.hidden;
      target.hidden = !open;
      el.setAttribute('aria-expanded', String(open));
      if (open && el.dataset.focus) target.querySelector(el.dataset.focus)?.focus();
      break;
    }
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
        toast(t('dateRemoved'));
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
        else toast(t('theirLetterThisRound', letter, esc(partner().name)));
      }
      break;
    }
    case 'start-over':
      openStartOverSheet();
      break;
    case 'export-text':
      if (await copyText(exportText(d))) toast(t('recapCopied'));
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

document.addEventListener('change', (e) => {
  // Settings: appearance applies instantly; language re-renders the page and the sheet in place.
  if (e.target.name === 'pref-theme') {
    setTheme(e.target.value);
    return;
  }
  if (e.target.name === 'pref-lang') {
    setLang(e.target.value);
    state.redraw?.();
    openSettings({ inPlace: true });
    return;
  }

  // Live summary + limits for the "Options" panel.
  const panel = e.target.closest('.options');
  if (!panel) return;
  const checked = panel.querySelectorAll('input[name="pre"]:checked');
  if (e.target.name === 'pre' && 26 - checked.length < MIN_OPEN) {
    e.target.checked = false;
    toast(t('leaveOne'));
  }
  const draw = panel.querySelector('input[name="draw"]:checked')?.value;
  const preCount = panel.querySelectorAll('input[name="pre"]:checked').length;
  const hint = panel.querySelector('.options-hint');
  if (hint) hint.textContent = optionsSummary(draw, preCount);
  const badge = panel.closest('form')?.querySelector('.opt-badge');
  if (badge) badge.hidden = draw !== 'manual' && !preCount;
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (!navigator.onLine) {
    toast(t('offline'), { tone: 'error' });
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
        if (err?.code === 'errJoined') renderLocked(state.id);
      }
    });
  }

  if (kind === 'code') {
    const parsed = parseCode(form.code.value);
    if (!parsed) {
      toast(t('codesLookLike', `${'X'.repeat(SPACE_LEN)}-XXXXX`), { tone: 'error' });
      return;
    }
    const switching = state.data && state.id === parsed.id && state.role;
    if (switching) {
      await busy(button, async () => {
        const role = await claimRole(parsed.id, parsed.key, state.uid, state.role);
        if (role) {
          closeSheet();
          toast(t('nowPlaysAs', esc(state.data.players[role].name)));
        } else toast(t('codeDidntWork'), { tone: 'error' });
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
        toast(t('saved'));
      } else {
        const res = await completeLetter(state.id, letter, desc, state.role);
        closeSheet();
        const card = document.querySelector(`.round-card[data-letter="${letter}"], .tile[data-letter="${letter}"]`);
        sparkle(card, 18);
        if (!res.drew.length && !res.completed) toast(t('inTheBook', letter));
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
      toast(t('yoursNow', letter));
    });
  }

  if (kind === 'plan') {
    const letter = form.dataset.letter;
    const plannedAt = new Date(form.when.value).getTime();
    if (!Number.isFinite(plannedAt)) {
      toast(t('pickDateFirst'), { tone: 'error' });
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
      toast(t('inMemoryBook', letter));
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
      toast(t('nameUpdated'));
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
  renderLoading(t('warmingUp'));
  try {
    const user = await ensureUser();
    state.uid = user.uid;
    route();
  } catch (err) {
    console.error(err);
    state.redraw = null;
    mount('error', `
      <main class="screen center narrow">
        <h1 class="h-md">${t('cantConnect')}</h1>
        <p class="muted">${t('cantConnectLede')}</p>
        <button class="btn primary" onclick="location.reload()">${t('reload')}</button>
      </main>`);
  }
})();
