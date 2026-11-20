import {
  arrayRemove, arrayUnion, doc, getDoc, onSnapshot, runTransaction, updateDoc, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.js';

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export const MAX_DESC = 80;
export const MAX_NAME = 24;

// No 0/O/1/I so codes survive being read out loud or typed from a screenshot.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SPACE_LEN = 6;
export const KEY_LEN = 5;

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

function freshLetters() {
  const letters = {};
  for (const l of ALPHABET) letters[l] = { status: 'UNUSED', assignedTo: null, description: '' };
  return letters;
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

const newPlayer = (name, uid) => ({ name, uids: [uid], seenRound: 0, seenAt: Date.now() });

export async function createSeries(name, uid) {
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
      players: { p1: newPlayer(name, uid), p2: null },
      letters: freshLetters(),
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
    if (!snap.exists()) throw new Error('This space no longer exists.');
    const data = snap.data();
    if (data.status !== 'WAITING' || data.players.p2) throw new Error('Someone already joined this space.');
    if (data.players.p1.uids.includes(uid)) throw new Error('You created this space — send the link to your partner instead.');

    const letters = structuredClone(data.letters);
    const round = (data.round || 0) + 1;
    drawRound(letters, round);
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

/**
 * Marks a letter done and, if that closes the round, draws the next two letters —
 * all in one transaction, so two simultaneous submissions can never draw four letters.
 * Returns { drew: [...letters], completed: bool }.
 */
export async function completeLetter(id, letter, description, role) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const data = snap.data();
    const current = data.letters[letter];
    if (current.status !== 'ACTIVE' || current.assignedTo !== role) {
      throw new Error('That letter isn’t yours to log anymore.');
    }
    const letters = structuredClone(data.letters);
    letters[letter] = { ...current, status: 'DONE', description, completedAt: Date.now() };

    const update = { letters, updatedAt: Date.now() };
    let drew = [];
    let completed = false;
    const roundOpen = ALPHABET.some((l) => letters[l].status === 'ACTIVE');
    if (!roundOpen) {
      const round = (data.round || 0) + 1;
      drew = drawRound(letters, round);
      if (drew.length) update.round = round;
      else {
        update.status = 'COMPLETED';
        update.completedAt = Date.now();
        completed = true;
      }
    }
    tx.update(seriesRef(id), update);
    return { drew, completed };
  });
}

export function editDescription(id, letter, description) {
  return updateDoc(seriesRef(id), {
    [`letters.${letter}.description`]: description,
    updatedAt: Date.now(),
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

/** Wipes all 26 letters and immediately draws a fresh first round for the same couple. */
export async function startOver(id) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(seriesRef(id));
    const data = snap.data();
    const letters = freshLetters();
    const round = (data.round || 0) + 1;
    drawRound(letters, round);
    tx.update(seriesRef(id), {
      letters,
      round,
      status: 'ACTIVE',
      cycle: (data.cycle || 1) + 1,
      completedAt: null,
      updatedAt: Date.now(),
    });
  });
}

export const progress = (data) => ALPHABET.filter((l) => data.letters[l].status === 'DONE').length;
