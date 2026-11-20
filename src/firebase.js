import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

// Firebase web config is public by design — access is enforced by firestore.rules.
const firebaseConfig = {
  apiKey: 'AIzaSyAvXcDggWI0wFc3Hx74UiOYcBXIl4Fhmog',
  authDomain: 'date-me-abc.firebaseapp.com',
  projectId: 'date-me-abc',
  storageBucket: 'date-me-abc.firebasestorage.app',
  messagingSenderId: '610481394186',
  appId: '1:610481394186:web:1d78c5537b10ccd0f805f3',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// `npm run dev:emu` talks to the local emulators instead of production.
if (import.meta.env.VITE_EMULATOR) {
  const host = location.hostname;
  connectAuthEmulator(auth, `http://${host}:${import.meta.env.VITE_AUTH_PORT || 9099}`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, Number(import.meta.env.VITE_FIRESTORE_PORT || 8080));
}

/** Resolves with the (anonymous) user for this browser, creating one if needed. */
export function ensureUser() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, async (user) => {
      stop();
      if (user) return resolve(user);
      try {
        const cred = await signInAnonymously(auth);
        resolve(cred.user);
      } catch (err) {
        reject(err);
      }
    });
  });
}
