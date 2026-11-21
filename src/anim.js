import { ALPHABET } from './game.js';
import { t } from './i18n.js';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Slot-machine roll on an element's text, decelerating onto `final`. */
export async function rollLetter(el, final, { duration = 1300, pool = ALPHABET } = {}) {
  if (reducedMotion()) {
    el.textContent = final;
    return;
  }
  const start = performance.now();
  let last = '';
  while (performance.now() - start < duration) {
    const t = (performance.now() - start) / duration;
    let next;
    do next = pool[Math.floor(Math.random() * pool.length)];
    while (next === last && pool.length > 1);
    el.textContent = last = next;
    el.animate(
      [{ transform: 'translateY(-30%)', opacity: 0.2 }, { transform: 'translateY(0)', opacity: 1 }],
      { duration: 90, easing: 'ease-out' },
    );
    await wait(40 + 220 * t * t); // ease-out: ticks get slower
  }
  el.textContent = final;
  el.animate(
    [{ transform: 'scale(1.35)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }],
    { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1.4)' },
  );
}

/**
 * Full-screen reveal of a freshly drawn round.
 * cards: [{ letter, role, name, mine, done }]
 * Resolves when the player taps "Let's go".
 */
export function playReveal({ title, subtitle, cards, pool }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'reveal';
    root.innerHTML = `
      <div class="reveal-inner">
        <p class="eyebrow reveal-fade">${title}</p>
        <h2 class="reveal-title reveal-fade">${subtitle}</h2>
        <div class="reveal-cards">
          ${cards.map((c) => `
            <div class="reveal-slot">
              <div class="flip ${c.role}">
                <div class="flip-face flip-back"><span>?</span></div>
                <div class="flip-face flip-front">
                  <span class="reveal-letter">&nbsp;</span>
                  ${c.done ? `<span class="reveal-done">${t('revealDone')}</span>` : ''}
                </div>
              </div>
              <div class="reveal-owner">
                <span class="dot ${c.role}"></span>${c.mine ? t('revealYours') : c.name}
              </div>
            </div>`).join('')}
        </div>
        <button class="btn primary reveal-go" type="button">${t('letsGo')}</button>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('no-scroll');

    const finish = () => {
      root.classList.add('leaving');
      document.body.classList.remove('no-scroll');
      setTimeout(() => root.remove(), 350);
      resolve();
    };
    root.querySelector('.reveal-go').addEventListener('click', finish);

    requestAnimationFrame(() => root.classList.add('open'));

    const slots = [...root.querySelectorAll('.reveal-slot')];
    (async () => {
      await wait(reducedMotion() ? 0 : 550);
      await Promise.all(slots.map(async (slot, i) => {
        await wait(reducedMotion() ? 0 : i * 650);
        slot.querySelector('.flip').classList.add('flipped');
        await wait(reducedMotion() ? 0 : 280);
        await rollLetter(slot.querySelector('.reveal-letter'), cards[i].letter, { pool });
        slot.classList.add('landed');
        if (cards[i].mine) sparkle(slot.querySelector('.flip'));
      }));
      root.classList.add('settled');
    })();
  });
}

/** A small burst of dots around an element. */
export function sparkle(el, count = 14) {
  if (reducedMotion() || !el) return;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colors = ['var(--p1)', 'var(--p2)', 'var(--honey)'];
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    s.style.left = `${cx}px`;
    s.style.top = `${cy}px`;
    s.style.background = colors[i % colors.length];
    document.body.appendChild(s);
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist = Math.max(rect.width, rect.height) * (0.55 + Math.random() * 0.35);
    s.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.15,.7,.3,1)' },
    ).onfinish = () => s.remove();
  }
}

/** Lightweight confetti on a throwaway canvas. */
export function confetti({ duration = 2600, count = 140 } = {}) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = (canvas.width = innerWidth * dpr);
  const H = (canvas.height = innerHeight * dpr);
  const probe = document.createElement('i');
  document.body.appendChild(probe);
  const colors = ['--p1', '--p2', '--honey', '--ink'].map((v) => {
    probe.style.color = `var(${v})`;
    return getComputedStyle(probe).color;
  });
  probe.remove();
  const parts = Array.from({ length: count }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.35,
    vx: (Math.random() - 0.5) * 18 * dpr,
    vy: (-Math.random() * 16 - 6) * dpr,
    r: (4 + Math.random() * 5) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
    shape: Math.random() > 0.5 ? 'rect' : 'circle',
  }));
  const start = performance.now();
  const frame = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - duration * 0.6) / (duration * 0.4));
    for (const p of parts) {
      p.vy += 0.45 * dpr;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      if (p.shape === 'rect') ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      else {
        ctx.beginPath();
        ctx.arc(0, 0, p.r / 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

let toastStack;
export function toast(html, { duration = 3800, tone = '' } = {}) {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toasts';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
  }
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.innerHTML = html;
  toastStack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, duration);
}
