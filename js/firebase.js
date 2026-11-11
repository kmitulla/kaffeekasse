// Initialisierung von Firebase (App, Auth, Firestore mit Offline-Cache).
// Das SDK liegt lokal in js/vendor/firebase.js (gebaut aus einer fest
// gepinnten Version, siehe tools/firebase-bundle) – es wird nichts von
// fremden Servern nachgeladen.
import {
  initializeApp, deleteApp,
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  updateProfile, signOut,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, clearIndexedDbPersistence,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
} from "./vendor/firebase.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

// Angemeldet bleiben (IndexedDB, sonst localStorage). Bewusst OHNE
// Popup-/Redirect-Unterstützung: die App nutzt nur E-Mail + Passwort,
// so werden keine Google-Skripte oder fremden iframes geladen.
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence]
});

// Offline-Persistenz: Daten werden lokal gespeichert und automatisch
// synchronisiert, sobald wieder Internet da ist.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Abmelden UND die lokal gespeicherten Team-Daten (Ausgaben, IBANs …)
// vom Gerät löschen – wichtig auf geteilten PCs/Handys.
export async function signOutAndClear() {
  try { await signOut(auth); } catch { /* trotzdem aufräumen */ }
  try { await terminate(db); } catch { /* weiter */ }
  try {
    await clearIndexedDbPersistence(db);
  } catch (err) {
    // Firebase verweigert das Löschen, solange eine frühere Instanz der
    // Seite noch als aktiv gilt – dann die lokale Datenbank direkt löschen.
    console.warn("Cache-Löschen über Firebase nicht möglich, lösche direkt:", err?.code || err);
    await deleteFirestoreDatabases();
  }
  try { localStorage.removeItem("kk-team"); } catch { /* egal */ }
  location.replace(location.pathname);
}

async function deleteFirestoreDatabases() {
  let names = [];
  try {
    names = (await indexedDB.databases()).map(d => d.name).filter(n => n && n.startsWith("firestore/"));
  } catch {
    names = [`firestore/[DEFAULT]/${firebaseConfig.projectId}/main`];
  }
  await Promise.all(names.map(name => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = () => resolve();
    // Ist die App noch in einem anderen Tab offen, wird gelöscht, sobald
    // dieser geschlossen wird – nicht ewig darauf warten.
    req.onblocked = () => setTimeout(resolve, 1500);
  })));
}

// Legt ein Konto über eine zweite, getrennte Firebase-Instanz an,
// damit der Master dabei selbst angemeldet bleibt. Diese Instanz
// speichert nichts dauerhaft.
export async function secondaryCreateUser(email, password) {
  const app2 = initializeApp(firebaseConfig, "zweitinstanz-" + Date.now());
  try {
    const auth2 = initializeAuth(app2, { persistence: inMemoryPersistence });
    const cred = await createUserWithEmailAndPassword(auth2, email, password);
    const uid = cred.user.uid;
    await signOut(auth2);
    return uid;
  } finally {
    await deleteApp(app2).catch(() => {});
  }
}

export {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  updateProfile,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
};
