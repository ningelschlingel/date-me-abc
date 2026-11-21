/*
 * A touch-friendly date (+ optional time) picker that writes into a hidden input,
 * so forms keep reading `form.<name>.value` exactly like a native date field:
 *   time: true  → "YYYY-MM-DDTHH:MM" (local)       time: false → "YYYY-MM-DD"
 * An empty value means "no date" (only possible with `optional`).
 */

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (ms) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
const sameDay = (a, b) => a != null && b != null && startOfDay(a) === startOfDay(b);

const ICON = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};

/** First day of the week for the user's locale (0 = Sunday … 6 = Saturday). */
function weekStart() {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch { /* old browser */ }
  return 1;
}

function toValue(ms, time) {
  if (ms == null) return '';
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

const fmt = (ms, opts) => new Date(ms).toLocaleDateString(undefined, opts);
const fmtTime = (h, m) => new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function relative(ms) {
  const days = Math.round((startOfDay(ms) - startOfDay(Date.now())) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days < 7) return `in ${days} days`;
  if (days >= 7 && days < 14) return 'next week';
  if (days >= 14 && days < 60) return `in ${Math.round(days / 7)} weeks`;
  if (days < -1 && days > -14) return `${-days} days ago`;
  if (days <= -14 && days > -60) return `${Math.round(-days / 7)} weeks ago`;
  return '';
}

/**
 * @param {object} o
 * @param {string} o.name      hidden input name
 * @param {number|null} o.value initial ms (null = nothing chosen)
 * @param {boolean} o.time     include time controls
 * @param {number} [o.min]     earliest selectable day (ms)
 * @param {number} [o.max]     latest selectable day (ms)
 * @param {boolean} [o.optional] allow clearing
 * @param {string} [o.label]   accessible group label
 * @param {string} [o.role]    p1 | p2 | honey — tints the selection
 */
export function datePicker({ name, value = null, time = true, min = null, max = null, optional = false, label = 'Date', role = '' }) {
  return `
    <div class="dp ${role}${time ? ' has-time' : ''}" data-dp role="group" aria-label="${label}"
      data-time="${time ? 1 : ''}" data-min="${min ?? ''}" data-max="${max ?? ''}" data-optional="${optional ? 1 : ''}" data-value="${value ?? ''}">
      <input type="hidden" name="${name}" value="${toValue(value, time)}">
      <div class="dp-summary" aria-live="polite"></div>
      ${time ? '<div class="dp-quick" role="list"></div>' : ''}
      <div class="dp-main">
        <div class="dp-cal">
          <div class="dp-head">
            <button type="button" class="dp-nav" data-dp="prev" aria-label="Previous month">${ICON.prev}</button>
            <button type="button" class="dp-title" data-dp="mode" aria-label="Choose month and year"></button>
            <button type="button" class="dp-nav" data-dp="next" aria-label="Next month">${ICON.next}</button>
          </div>
          <div class="dp-body"></div>
        </div>
        ${time ? `
        <div class="dp-time">
          <p class="dp-time-label">Time</p>
          <div class="dp-times" role="list"></div>
          <div class="dp-steppers">
            <div class="dp-step" data-unit="h">
              <button type="button" class="dp-step-btn" data-dp="h-" aria-label="Earlier hour">${ICON.minus}</button>
              <output class="dp-step-val" data-out="h"></output>
              <button type="button" class="dp-step-btn" data-dp="h+" aria-label="Later hour">${ICON.plus}</button>
            </div>
            <span class="dp-colon" aria-hidden="true">:</span>
            <div class="dp-step" data-unit="m">
              <button type="button" class="dp-step-btn" data-dp="m-" aria-label="15 minutes earlier">${ICON.minus}</button>
              <output class="dp-step-val" data-out="m"></output>
              <button type="button" class="dp-step-btn" data-dp="m+" aria-label="15 minutes later">${ICON.plus}</button>
            </div>
          </div>
        </div>` : ''}
      </div>
    </div>`;
}

const TIMES = [[10, 0], [12, 30], [15, 0], [18, 0], [19, 0], [20, 30]];

/** Attach behaviour to every `[data-dp]` picker inside `root`. */
export function wireDatePickers(root) {
  root.querySelectorAll('div[data-dp]').forEach(wire);
}

function wire(el) {
  const time = !!el.dataset.time;
  const optional = !!el.dataset.optional;
  const min = el.dataset.min ? startOfDay(+el.dataset.min) : null;
  const max = el.dataset.max ? startOfDay(+el.dataset.max) : null;
  const input = el.querySelector('input[type="hidden"]');
  const first = weekStart();

  const init = el.dataset.value ? +el.dataset.value : null;
  const st = {
    day: init == null ? null : startOfDay(init), // selected day (ms at midnight)
    h: init == null ? 19 : new Date(init).getHours(),
    m: init == null ? 0 : new Date(init).getMinutes(),
    view: new Date(init ?? (max != null && Date.now() > max ? max : Date.now())),
    mode: 'days',
  };
  st.view = new Date(st.view.getFullYear(), st.view.getMonth(), 1);

  const allowed = (dayMs) => (min == null || dayMs >= min) && (max == null || dayMs <= max);
  const valueMs = () => (st.day == null ? null : new Date(st.day).setHours(st.h, st.m, 0, 0));

  function commit() {
    input.value = toValue(valueMs(), time);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderSummary() {
    const s = el.querySelector('.dp-summary');
    if (st.day == null) {
      s.innerHTML = `<span class="dp-sum-date is-empty">${optional ? 'No date — that’s fine' : 'Pick a day'}</span>`;
      return;
    }
    const rel = relative(st.day);
    s.innerHTML = `
      <span class="dp-sum-date">${fmt(st.day, { weekday: 'long', day: 'numeric', month: 'long', ...(new Date(st.day).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}</span>
      <span class="dp-sum-meta">${time ? `<b>${fmtTime(st.h, st.m)}</b>` : ''}${rel ? `<span>${rel}</span>` : ''}
        ${optional ? '<button type="button" class="dp-clear" data-dp="clear">Clear</button>' : ''}</span>`;
  }

  function quickDays() {
    const today = startOfDay(Date.now());
    const out = [];
    if (new Date().getHours() < 20) out.push({ label: 'Tonight', day: today, h: 19, m: 0 });
    out.push({ label: 'Tomorrow', day: today + DAY });
    for (const dow of [5, 6, 0]) { // next Fri, Sat, Sun beyond tomorrow
      let d = today + 2 * DAY;
      while (new Date(d).getDay() !== dow) d += DAY;
      out.push({ label: fmt(d, { weekday: 'short' }), sub: new Date(d).getDate(), day: d });
    }
    return out.filter((q) => allowed(q.day));
  }

  function renderQuick() {
    const q = el.querySelector('.dp-quick');
    if (!q) return;
    q.innerHTML = quickDays().map((x, i) => {
      const on = sameDay(x.day, st.day) && (x.h == null || (x.h === st.h && x.m === st.m));
      return `<button type="button" role="listitem" class="dp-chip${on ? ' on' : ''}" data-dp="quick" data-i="${i}" aria-pressed="${on}">
        ${x.label}${x.sub ? ` <small>${x.sub}</small>` : ''}</button>`;
    }).join('');
  }

  function renderDays() {
    const y = st.view.getFullYear();
    const mo = st.view.getMonth();
    el.querySelector('.dp-title').innerHTML =
      `<span>${fmt(st.view, { month: 'long', year: 'numeric' })}</span>${ICON.chevron}`;
    const lead = (new Date(y, mo, 1).getDay() - first + 7) % 7;
    const count = new Date(y, mo + 1, 0).getDate();
    const today = startOfDay(Date.now());
    const dows = Array.from({ length: 7 }, (_, i) => fmt(new Date(2023, 0, 1 + ((first + i) % 7)), { weekday: 'narrow' }));
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="dp-pad"></span>';
    for (let d = 1; d <= count; d++) {
      const ms = new Date(y, mo, d).getTime();
      const sel = ms === st.day;
      const ok = allowed(ms) || sel;
      cells += `<button type="button" class="dp-day${sel ? ' sel' : ''}${ms === today ? ' today' : ''}" data-dp="day" data-day="${ms}"
        ${ok ? '' : 'disabled'} aria-pressed="${sel}" aria-label="${fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' })}">${d}</button>`;
    }
    el.querySelector('.dp-body').innerHTML = `
      <div class="dp-dow" aria-hidden="true">${dows.map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="dp-grid">${cells}</div>`;
    const prevEnd = new Date(y, mo, 0).getTime();
    const nextStart = new Date(y, mo + 1, 1).getTime();
    el.querySelector('[data-dp="prev"]').disabled = min != null && prevEnd < min;
    el.querySelector('[data-dp="next"]').disabled = max != null && nextStart > max;
  }

  function renderMonths() {
    const y = st.view.getFullYear();
    el.querySelector('.dp-title').innerHTML = `<span>${y}</span>${ICON.chevron}`;
    const cells = Array.from({ length: 12 }, (_, mo) => {
      const start = new Date(y, mo, 1).getTime();
      const end = new Date(y, mo + 1, 0).getTime();
      const ok = (min == null || end >= min) && (max == null || start <= max);
      const cur = st.day != null && new Date(st.day).getFullYear() === y && new Date(st.day).getMonth() === mo;
      return `<button type="button" class="dp-month${cur ? ' sel' : ''}" data-dp="month" data-m="${mo}" ${ok ? '' : 'disabled'}>${fmt(start, { month: 'short' })}</button>`;
    }).join('');
    el.querySelector('.dp-body').innerHTML = `<div class="dp-months">${cells}</div>`;
    el.querySelector('[data-dp="prev"]').disabled = min != null && new Date(y - 1, 11, 31).getTime() < min;
    el.querySelector('[data-dp="next"]').disabled = max != null && new Date(y + 1, 0, 1).getTime() > max;
  }

  function renderTime() {
    if (!time) return;
    el.querySelector('[data-out="h"]').textContent = pad(st.h);
    el.querySelector('[data-out="m"]').textContent = pad(st.m);
    el.querySelector('.dp-times').innerHTML = TIMES.map(([h, m]) => {
      const on = h === st.h && m === st.m;
      return `<button type="button" role="listitem" class="dp-chip${on ? ' on' : ''}" data-dp="time" data-h="${h}" data-m="${m}" aria-pressed="${on}">${fmtTime(h, m)}</button>`;
    }).join('');
  }

  function render() {
    el.classList.toggle('months', st.mode === 'months');
    el.querySelector('[data-dp="prev"]').setAttribute('aria-label', st.mode === 'months' ? 'Previous year' : 'Previous month');
    el.querySelector('[data-dp="next"]').setAttribute('aria-label', st.mode === 'months' ? 'Next year' : 'Next month');
    if (st.mode === 'months') renderMonths();
    else renderDays();
    renderSummary();
    renderQuick();
    renderTime();
  }

  function bump(el2) {
    el2?.animate?.([{ transform: 'scale(0.9)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.3,1.4,.5,1)' });
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dp]');
    if (!b || b.disabled) return;
    const act = b.dataset.dp;
    const step = st.mode === 'months' ? 12 : 1;
    if (act === 'prev' || act === 'next') {
      st.view = new Date(st.view.getFullYear(), st.view.getMonth() + (act === 'next' ? step : -step), 1);
      render();
      el.querySelector(`[data-dp="${act}"]`).focus();
      return;
    }
    if (act === 'mode') {
      st.mode = st.mode === 'days' ? 'months' : 'days';
      render();
      el.querySelector('.dp-title').focus();
      return;
    }
    if (act === 'month') {
      st.view = new Date(st.view.getFullYear(), +b.dataset.m, 1);
      st.mode = 'days';
      render();
      return;
    }
    if (act === 'day') {
      st.day = +b.dataset.day;
    } else if (act === 'quick') {
      const q = quickDays()[+b.dataset.i];
      st.day = q.day;
      if (q.h != null) [st.h, st.m] = [q.h, q.m];
      st.view = new Date(new Date(q.day).getFullYear(), new Date(q.day).getMonth(), 1);
      st.mode = 'days';
    } else if (act === 'time') {
      st.h = +b.dataset.h;
      st.m = +b.dataset.m;
    } else if (act === 'h-' || act === 'h+') {
      st.h = (st.h + (act === 'h+' ? 1 : 23)) % 24;
    } else if (act === 'm-' || act === 'm+') {
      const total = (st.h * 60 + Math.round(st.m / 15) * 15 + (act === 'm+' ? 15 : -15) + 1440) % 1440;
      [st.h, st.m] = [Math.floor(total / 60), total % 60];
    } else if (act === 'clear') {
      st.day = null;
    } else return;
    render();
    commit();
    // keep focus on the equivalent control after re-render, and give it a little bounce
    const sel = act === 'day' ? `.dp-day[data-day="${st.day}"]`
      : act === 'quick' ? `.dp-chip[data-i="${b.dataset.i}"]`
        : act === 'time' ? `.dp-chip[data-h="${b.dataset.h}"][data-m="${b.dataset.m}"]`
          : act === 'clear' ? '.dp-title' : `[data-dp="${act}"]`;
    const target = el.querySelector(sel);
    target?.focus({ preventScroll: true });
    if (act === 'day' || act === 'quick' || act === 'time') bump(el.querySelector('.dp-day.sel'));
    if (act !== 'clear') bump(el.querySelector('.dp-summary'));
  });

  // Arrow keys move between days, like a native calendar grid.
  el.addEventListener('keydown', (e) => {
    const b = e.target.closest('.dp-day');
    if (!b) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const target = new Date(+b.dataset.day + delta * DAY + 12 * 3600e3); // +12h dodges DST edges
    const ms = startOfDay(target.getTime());
    if (!allowed(ms)) return;
    if (target.getMonth() !== st.view.getMonth()) {
      st.view = new Date(target.getFullYear(), target.getMonth(), 1);
      render();
    }
    el.querySelector(`.dp-day[data-day="${ms}"]`)?.focus();
  });

  render();
}
