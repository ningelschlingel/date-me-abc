import { ALPHABET } from './game.js';

const dateOf = (x) => x.dateAt ?? x.completedAt;

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export function exportText(data) {
  const { p1, p2 } = data.players;
  const lines = ALPHABET.map((l) => {
    const x = data.letters[l];
    if (x.status === 'PREDONE') return `${l} — (done before we started)`;
    if (x.status !== 'DONE') return `${l} — …`;
    const who = data.players[x.assignedTo]?.name;
    return `${l} — ${x.description}  (${who}, ${fmtDate(dateOf(x))})`;
  });
  return [`ABC Dates · ${p1.name} & ${p2?.name ?? ''}`, '', ...lines, '', 'A to Z, together. ♡'].join('\n');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Renders a tall recap card (always light theme so it prints/shares nicely). */
export async function renderRecapPNG(data) {
  await Promise.all([
    document.fonts.load('600 64px Fraunces'),
    document.fonts.load('italic 400 32px Fraunces'),
    document.fonts.load('500 30px "DM Sans"'),
    document.fonts.load('400 22px "DM Sans"'),
  ]).catch(() => {});

  const C = {
    bg: '#F6F0E6', card: '#FFFCF7', ink: '#2A2631', soft: '#7A7282', line: '#E9E0D3',
    p1: '#D9694E', p1s: '#F7DED5', p2: '#2F7F78', p2s: '#D3E8E4', honey: '#E7B34A',
  };
  const W = 1080;
  const PAD = 72;
  const ROW_X = PAD + 40;
  const TEXT_X = ROW_X + 96;
  const TEXT_W = W - TEXT_X - PAD - 40;

  // Measure pass
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '500 30px "DM Sans"';
  const rows = ALPHABET.map((l) => {
    const x = data.letters[l];
    const done = x.status === 'DONE';
    const pre = x.status === 'PREDONE';
    const lines = done ? wrap(measure, x.description || '—', TEXT_W, 2) : [pre ? 'Done before we started' : '—'];
    return { l, x, done, pre, lines, h: 34 + lines.length * 38 + 30 };
  });
  const HEADER = 300;
  const FOOTER = 130;
  const H = HEADER + rows.reduce((s, r) => s + r.h, 0) + FOOTER + 40;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = C.soft;
  ctx.font = '500 24px "DM Sans"';
  ctx.letterSpacing = '4px';
  ctx.textAlign = 'center';
  ctx.fillText('ABC DATES', W / 2, 108);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = C.ink;
  ctx.font = '600 72px Fraunces';
  const names = `${data.players.p1.name} & ${data.players.p2?.name ?? ''}`;
  ctx.fillText(names, W / 2, 190);
  ctx.font = 'italic 400 30px Fraunces';
  ctx.fillStyle = C.soft;
  const first = Math.min(...rows.filter((r) => r.done).map((r) => dateOf(r.x)));
  const last = Math.max(...rows.filter((r) => r.done).map((r) => dateOf(r.x)));
  ctx.fillText(
    Number.isFinite(first) ? `${fmtDate(first)} – ${fmtDate(last)}` : 'from A to Z',
    W / 2,
    242,
  );

  // Card
  roundRect(ctx, PAD, HEADER - 10, W - PAD * 2, H - HEADER - FOOTER + 20, 36);
  ctx.fillStyle = C.card;
  ctx.fill();

  let y = HEADER + 20;
  ctx.textAlign = 'left';
  rows.forEach((r, i) => {
    const color = r.pre ? '#A9781C' : r.x.assignedTo === 'p2' ? C.p2 : C.p1;
    const soft = r.pre ? '#F8EACB' : r.x.assignedTo === 'p2' ? C.p2s : C.p1s;
    // Badge
    roundRect(ctx, ROW_X, y + 12, 68, 68, 20);
    ctx.fillStyle = r.done || r.pre ? soft : C.bg;
    ctx.fill();
    ctx.fillStyle = r.done || r.pre ? color : C.soft;
    ctx.font = '600 40px Fraunces';
    ctx.textAlign = 'center';
    ctx.fillText(r.l, ROW_X + 34, y + 60);
    ctx.textAlign = 'left';
    // Description
    ctx.fillStyle = r.done ? C.ink : C.soft;
    ctx.font = '500 30px "DM Sans"';
    r.lines.forEach((line, j) => ctx.fillText(line, TEXT_X, y + 42 + j * 38));
    // Meta
    if (r.done) {
      ctx.font = '400 22px "DM Sans"';
      ctx.fillStyle = C.soft;
      const who = data.players[r.x.assignedTo]?.name ?? '';
      ctx.fillText(`${who}’s pick · ${fmtDate(dateOf(r.x))}`, TEXT_X, y + 42 + r.lines.length * 38 + 2);
    }
    y += r.h;
    if (i < rows.length - 1) {
      ctx.fillStyle = C.line;
      ctx.fillRect(TEXT_X, y - 6, W - TEXT_X - PAD - 40, 2);
    }
  });

  // Footer
  ctx.textAlign = 'center';
  ctx.fillStyle = C.ink;
  ctx.font = 'italic 400 34px Fraunces';
  ctx.fillText('A to Z, together.', W / 2, H - 70);
  [C.p1, C.honey, C.p2].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(W / 2 - 28 + i * 28, H - 36, 7, 0, Math.PI * 2);
    ctx.fill();
  });

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function saveOrShareImage(blob, filename) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: 'Our ABC Dates' });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
