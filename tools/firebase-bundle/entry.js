// Nur die Teile des Firebase-SDK, die die App wirklich nutzt.
export { initializeApp, deleteApp } from "firebase/app";
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  updateProfile, signOut, connectAuthEmulator
} from "firebase/auth";
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, clearIndexedDbPersistence, connectFirestoreEmulator,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
} from "firebase/firestore";
