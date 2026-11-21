import {
  arrayRemove, arrayUnion, doc, getDoc, onSnapshot, runTransaction, updateDoc, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.js';
import { t } from './i18n.js';

/** An Error with a translated message and a stable code callers can check. */
const gameError = (code, ...args) => Object.assign(new Error(t(code, ...args)), { code });

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export const MAX_DESC = 80;
export const MAX_NAME = 24;
export const MAX_LOCATION = 80;
/** At least this many letters must stay open when pre-marking letters as done. */
export const MIN_OPEN = 1;

// No 0/O/1/I so codes survive being read out loud or typed from a screenshot.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SPACE_LEN = 6;
export const KEY_LEN = 5;

/*
 * Letter statuses
 *   UNUSED   still in the bag
 *   ACTIVE   drawn/picked for the current round, assigned to a player
 *   DONE     logged (description, dateAt, assignedTo = who planned it)
 *   PREDONE  marked as "already done" when the series started; details can be filled in later
 *
 * Draw modes (series.settings.draw)
 *   random   two letters are drawn automatically at the start of each round
 *   manual   each player picks their own letter at the start of each round
 */

function randomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return out;
}

export const seriesRef = (id) => doc(db, 'series', id);
const keysRef = (id) => doc(db, 'series', id, 'private', 'keys');
const claimRef = (id, uid) => doc(db, 'series', id, 'claims', uid);

export const otherRole = (role) => (role === 'p1' ? 'p2' : 'p1');
export const drawMode = (d) => d?.settings?.draw ?? 'random';

export function roleOf(data, uid) {
  if (!data) return null;
  if (data.players.p1?.uids?.includes(uid)) return 'p1';
  if (data.players.p2?.uids?.includes(uid)) return 'p2';
  return null;
}

/** "NFS4KQ-UQB7X" style personal code (space + personal key). */
export const formatCode = (id, key) => `${id}-${key}`;

export function parseCode(input) {
  const clean = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== SPACE_LEN + KEY_LEN) return null;
  return { id: clean.slice(0, SPACE_LEN), key: clean.slice(SPACE_LEN) };
}

/* ------------------------------------------------------------ derived state */

export const isDone = (x) => x.status === 'DONE' || x.status === 'PREDONE';
export const progress = (d) => ALPHABET.filter((l) => isDone(d.letters[l])).length;
export const roundLetters = (d) =>
  ALPHABET.filter((l) => d.letters[l].round === d.round && (d.letters[l].status === 'ACTIVE' || d.letters[l].status === 'DONE'));
const hasUnused = (letters) => ALPHABET.some((l) => letters[l].status === 'UNUSED');

/** Number of rounds this alphabet will take (pre-marked letters don't need a round). */
export function totalRounds(d) {
  const skipped = ALPHABET.filter((l) => d.letters[l].status === 'PREDONE' || d.letters[l].retro).length;
  return Math.max(1, Math.ceil((26 - skipped) / 2));
}
/**
 * `round` never resets, so the label subtracts where this alphabet began. Series created before
 * `cycleStartRound` existed fall back to the earliest round among their drawn letters — after a
 * reset, every drawn letter belongs to the current alphabet.
 */
export function roundInCycle(d) {
  const drawnRounds = ALPHABET.map((l) => d.letters[l].round).filter(Number.isFinite);
  const start = d.cycleStartRound ?? Math.min(d.round, ...drawnRounds);
  return Math.max(1, d.round - start + 1);
}

/** In manual mode: does `role` still have to pick a letter this round? */
export function needsPick(d, role) {
  if (d.status !== 'ACTIVE' || drawMode(d) !== 'manual' || !hasUnused(d.letters)) return false;
  return !roundLetters(d).some((l) => d.letters[l].assignedTo === role);
}

/**
 * A round is finished when nothing is ACTIVE and every player who *could* have
 * a letter this round has logged one (random mode draws both up front).
 */
function roundFinished(d, letters) {
  const cur = ALPHABET.filter((l) => letters[l].round === d.round && letters[l].status !== 'UNUSED' && letters[l].status !== 'PREDONE');
  if (cur.some((l) => letters[l].status === 'ACTIVE')) return false;
  if (!hasUnused(letters)) return true;
  if (drawMode(d) === 'random') return true;
  return ['p1', 'p2'].every((p) => cur.some((l) => letters[l].assignedTo === p));
}

/* ------------------------------------------------------------ letter setup */

function freshLetters(premarked = []) {
  const letters = {};
  for (const l of ALPHABET) {
    letters[l] = premarked.includes(l)
      ? { status: 'PREDONE', assignedTo: null, description: '' }
      : { status: 'UNUSED', assignedTo: null, description: '' };
  }
  return letters;
}

function cleanOptions({ draw = 'random', premarked = [] } = {}) {
  const pre = [...new Set(premarked)].filter((l) => ALPHABET.includes(l));
  if (26 - pre.length < MIN_OPEN) throw gameError('errLeaveOne');
  return { draw: draw === 'manual' ? 'manual' : 'random', premarked: pre };
}

/** Mutates `letters`: draws up to two unused letters, one per player (random who gets which). */
function drawRound(letters, round) {
  const pool = ALPHABET.filter((l) => letters[l].status === 'UNUSED');
  const picks = [];
  while (picks.length < 2 && pool.length) picks.push(pool.splice(randomInt(pool.length), 1)[0]);
  const roles = randomInt(2) ? ['p1', 'p2'] : ['p2', 'p1'];
  const now = Date.now();
  picks.forEach((l, i) => {
    letters[l] = { status: 'ACTIVE', assignedTo: roles[i], description: '', round, drawnAt: now };
  });
  return picks;
}

/** Opens the next round on `update` (mutating `letters`), or completes the series. */
function advance(d, letters, update) {
  if (!hasUnused(letters)) {
    update.status = 'COMPLETED';
    update.completedAt = Date.now();
    return { drew: [], completed: true };
  }
  const round = (d.round || 0) + 1;
  update.round = round;
  const drew = drawMode(d) === 'random' ? drawRound(letters, round) : [];
  return { drew, completed: false };
}

const newPlayer = (name, uid) => ({ name, uids: [uid], seenRound: 0, seenAt: Date.now(), seenPlanAt: Date.now() });

/* ------------------------------------------------------------ series lifecycle */

export async function createSeries(name, uid, options) {
  const { draw, premarked } = cleanOptions(options);
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomCode(SPACE_LEN);
    const key = randomCode(KEY_LEN);
    const batch = writeBatch(db);
    batch.set(seriesRef(id), {
      status: 'WAITING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      round: 0,
      cycle: 1,
      cycleStartRound: 1,
      settings: { draw },
      players: { p1: newPlayer(name, uid), p2: null },
      letters: freshLetters(premarked),
    });
    batch.set(keysRef(id), { p1: key });
    try {
      await batch.commit();
      return id;
    } catch (err) {
      // An ID collision shows up as permission-denied (it'd be an update, not a create). Retry.
      if (attempt === 3) throw err;
    }
  }
}

/** Fetches a series if this device is allowed to see it. Returns null when hidden/missing. */
export async function peekSeries(id) {
  try {
    const snap = await getDoc(seriesRef(id));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

export async function joinSeries(id, name, uid) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    if (!snap.exists()) throw gameError('errGone');
    const data = snap.data();
    if (data.status !== 'WAITING' || data.players.p2) throw gameError('errJoined');
    if (data.players.p1.uids.includes(uid)) throw gameError('errOwn');

    const letters = structuredClone(data.letters);
    const round = (data.round || 0) + 1;
    if (drawMode(data) === 'random') drawRound(letters, round);
    tx.update(seriesRef(id), {
      'players.p2': newPlayer(name, uid),
      status: 'ACTIVE',
      round,
      letters,
      updatedAt: Date.now(),
    });
    tx.set(keysRef(id), { p2: randomCode(KEY_LEN) }, { merge: true });
  });
}

/**
 * Binds this device to whichever player owns `key`. If the device currently plays as the
 * other role (switch player), it's removed from that role in the same batch.
 */
export async function claimRole(id, key, uid, currentRole = null) {
  for (const role of ['p1', 'p2']) {
    if (role === currentRole) continue;
    const batch = writeBatch(db);
    batch.set(claimRef(id, uid), { player: role, key, at: Date.now() });
    const update = { [`players.${role}.uids`]: arrayUnion(uid) };
    if (currentRole) update[`players.${currentRole}.uids`] = arrayRemove(uid);
    batch.update(seriesRef(id), update);
    try {
      await batch.commit();
      return role;
    } catch {
      /* wrong role for this key (or invalid key) — try the next one */
    }
  }
  return null;
}

export async function getKeys(id) {
  try {
    const snap = await getDoc(keysRef(id));
    return snap.exists() ? snap.data() : {};
  } catch {
    return {};
  }
}

export function subscribe(id, onData, onError) {
  return onSnapshot(
    seriesRef(id),
    (snap) => onData(snap.exists() ? snap.data() : null),
    onError,
  );
}

/** Wipes the alphabet and starts a new one for the same couple, with fresh options. */
export async function startOver(id, options) {
  const { draw, premarked } = cleanOptions(options);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const data = snap.data();
    const letters = freshLetters(premarked);
    const round = (data.round || 0) + 1;
    if (draw === 'random') drawRound(letters, round);
    tx.update(seriesRef(id), {
      letters,
      round,
      cycleStartRound: round,
      settings: { ...(data.settings || {}), draw },
      status: 'ACTIVE',
      cycle: (data.cycle || 1) + 1,
      completedAt: null,
      updatedAt: Date.now(),
    });
  });
}

/* ------------------------------------------------------------ gameplay */

/** Manual mode: claim an unused letter for this round. Transaction guards against both picking the same one. */
export async function pickLetter(id, letter, role) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const data = snap.data();
    if (data.letters[letter].status !== 'UNUSED') throw gameError('errTaken', letter);
    if (!needsPick(data, role)) throw gameError('errHaveLetter');
    tx.update(seriesRef(id), {
      [`letters.${letter}`]: { status: 'ACTIVE', assignedTo: role, description: '', round: data.round, drawnAt: Date.now() },
      updatedAt: Date.now(),
    });
  });
}

/**
 * Marks a letter done and, if that finishes the round, opens the next one — all in one
 * transaction, so two simultaneous submissions can never draw four letters.
 * Returns { drew: [...letters], completed: bool }.
 */
export async function completeLetter(id, letter, description, role) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const data = snap.data();
    const current = data.letters[letter];
    if (current.status !== 'ACTIVE' || current.assignedTo !== role) {
      throw gameError('errNotYours');
    }
    const now = Date.now();
    const letters = structuredClone(data.letters);
    // If a date was planned and has passed, that's when it happened.
    const dateAt = current.plannedAt && current.plannedAt <= now ? current.plannedAt : now;
    letters[letter] = { ...current, status: 'DONE', description, completedAt: now, dateAt };

    const update = { letters, updatedAt: now };
    let result = { drew: [], completed: false };
    if (roundFinished(data, letters)) result = advance(data, letters, update);
    tx.update(seriesRef(id), update);
    return result;
  });
}

/** Fills in a letter that was pre-marked as done when the series started. */
export async function fillPredone(id, letter, { description, dateAt, plannedBy }, role) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const x = snap.data().letters[letter];
    if (x.status !== 'PREDONE') throw gameError('errFilled');
    const now = Date.now();
    tx.update(seriesRef(id), {
      [`letters.${letter}`]: {
        status: 'DONE', assignedTo: plannedBy, description, retro: true,
        dateAt: dateAt || now, completedAt: now, filledBy: role,
      },
      updatedAt: now,
    });
  });
}

export function editDescription(id, letter, description) {
  return updateDoc(seriesRef(id), {
    [`letters.${letter}.description`]: description,
    updatedAt: Date.now(),
  });
}

/** Sets (or clears, with plannedAt = null) the date, time and place for an active letter. */
export function setPlan(id, letter, { plannedAt, location = '' }, role) {
  const now = Date.now();
  return updateDoc(seriesRef(id), {
    [`letters.${letter}.plannedAt`]: plannedAt ?? null,
    [`letters.${letter}.location`]: plannedAt ? location : '',
    [`letters.${letter}.plannedBy`]: role,
    [`letters.${letter}.planUpdatedAt`]: now,
    updatedAt: now,
  });
}

export function renamePlayer(id, role, name) {
  return updateDoc(seriesRef(id), { [`players.${role}.name`]: name, updatedAt: Date.now() });
}

export function markRoundSeen(id, role, round) {
  return updateDoc(seriesRef(id), { [`players.${role}.seenRound`]: round });
}

export function markNewsSeen(id, role, at) {
  return updateDoc(seriesRef(id), { [`players.${role}.seenAt`]: at });
}

export function markPlanSeen(id, role, at) {
  return updateDoc(seriesRef(id), { [`players.${role}.seenPlanAt`]: at });
}
