# ABC Dates

A tiny, serverless web app for couples: draw a random letter each, plan a date that starts with it, log what you did, repeat until A–Z is done.

Vanilla JS + Vite, hand-written CSS, Firebase (Anonymous Auth + Firestore). No framework, no backend.

## Setup (one time)

In the [Firebase console](https://console.firebase.google.com/project/date-me-abc):

1. **Authentication → Sign-in method → Anonymous → Enable.**
2. **Firestore Database → Create database** (production mode, any region).
3. Deploy the security rules and the site:

```bash
npm install
firebase login          # if not already
npm run deploy          # vite build + firebase deploy (hosting + firestore rules)
```

## Development

```bash
npm run dev       # against the real Firebase project
npm run dev:emu   # against local Auth + Firestore emulators (needs Java)
```

To play both sides locally, open the invite link in a private window (each browser profile = one anonymous user).

## How it works

```
src/
  main.js      routing, screens, sheets, realtime handling, plan prompts
  game.js      all Firestore reads/writes (create, join, claim, pick, complete, plan, reset)
  calendar.js  .ics file + Google Calendar link for planned dates
  anim.js      draw/reveal animation, confetti, sparkles, toasts
  export.js    copy-as-text and the PNG recap (drawn on a canvas)
  ideas.js     three date ideas per letter
  style.css    design tokens (light + dark), layout, animations
firestore.rules
```

### Data model

One document per couple at `series/{id}` (`id` is a 6-char code like `NFS4KQ`):

```js
{
  status: 'WAITING' | 'ACTIVE' | 'COMPLETED',
  createdAt, updatedAt, completedAt,
  round: 3,             // global round counter, increases every round (also across resets)
  cycle: 1,             // how many alphabets this couple has started
  cycleStartRound: 1,   // round number where the current alphabet began
  settings: { draw: 'random' | 'manual' },
  players: {
    p1: { name, uids: [deviceUid, ...], seenRound, seenAt, seenPlanAt },
    p2: { ... } | null
  },
  letters: {
    A: { status: 'DONE', assignedTo: 'p1', description, round, drawnAt, completedAt, dateAt, location? },
    B: { status: 'ACTIVE', assignedTo: 'p2', description: '', round, drawnAt,
         plannedAt?, location?, plannedBy?, planUpdatedAt? },
    C: { status: 'PREDONE', assignedTo: null, description: '' },   // ticked off before starting
    D: { status: 'UNUSED', assignedTo: null, description: '' },
    F: { status: 'DONE', retro: true, filledBy: 'p2', assignedTo: 'p1', dateAt, ... }, // a filled-in PREDONE
    ...
  }
}
```

- **Draw modes.** In `random` mode, two letters are drawn when a round opens. In `manual` mode, each player picks one unused letter. Picking is a transaction too, so if both of you grab the same letter at once, exactly one gets it.
- **Rounds.** A round ends when nothing is `ACTIVE` and each player has logged a letter in it, or when there are no unused letters left. That also covers the last round when only one letter remains.
- **Pre-marked letters (`PREDONE`).** These count as done and are never drawn. Either player can fill one in later (what you did, when, who planned it); it then becomes `DONE` with `retro: true`.
- **Plans.** The owner of an active letter can set `plannedAt` and `location`. The partner gets a one-time "add to calendar" pop-up (tracked with `seenPlanAt`). An hour after the planned time, the owner is asked "Did it happen?". When the date is logged, a past `plannedAt` becomes its `dateAt`.
- **"Seen" tracking.** `seenRound` drives the letter-draw reveal: if `round > seenRound`, that player hasn't seen the newest letters yet, so the flip-and-roll animation plays the next time they open the app. `seenAt` drives the toasts for partner activity since your last visit ("Sam logged their B date…", "Sam picked K", "Sam filled in F").
- **No double draws.** Completing a letter and opening the next round happen inside one `runTransaction`. If both players submit at the same moment, Firestore retries one of the transactions, which then sees the round has already moved on.

### Multiple devices

Anonymous auth gives each *browser* its own uid, so each player keeps a **list** of device uids.

- **Invite link** `…/s/NFS4KQ`: lets exactly one person join as player 2. After that, nobody new can open it.
- **Personal link** `…/s/NFS4KQ#k=UQB7X`, or the typed code `NFS4KQ-UQB7X`: adds the current device to *that* player. Each player finds theirs under **Settings → Your other devices**. The key is in the URL hash, so it is never sent to a server, and the app strips it from the address bar once used.
- **Lost access.** Each partner can see the other's personal link under Settings, so if one of you clears the browser or gets a new phone, the other can send the link back. **Settings → Not you?** switches a device to the other player.

Keys live in `series/{id}/private/keys` (members only). A new device proves it knows a key by writing `series/{id}/claims/{uid}` in the same batch that adds its uid. The security rules check the key against the stored one.

### Security rules summary

- Anyone signed in can read a series only while it's `WAITING`; after that, only member devices can read it.
- Only member devices can update the series. They can't edit the device lists in a normal update.
- Joining is allowed once, only while `WAITING`, and not by the creator's own device.
- Descriptions and locations must be at most 80 characters, and names 1–24 characters. Only the letters that changed are validated, to stay within Firestore's 1000-expression budget per request.
