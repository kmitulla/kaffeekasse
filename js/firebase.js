// Initialisierung von Firebase (App, Auth, Firestore mit Offline-Cache)
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  updateProfile,
  signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Offline-Persistenz: Daten werden lokal gespeichert und automatisch
// synchronisiert, sobald wieder Internet da ist.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Legt ein Konto über eine zweite, getrennte Firebase-Instanz an,
// damit der Master dabei selbst angemeldet bleibt.
export async function secondaryCreateUser(email, password) {
  const app2 = initializeApp(firebaseConfig, "zweitinstanz-" + Date.now());
  try {
    const auth2 = getAuth(app2);
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
  signOut,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
};
