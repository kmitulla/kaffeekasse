// Angriffs- und Kompatibilitätstests für firestore.rules gegen den Emulator.
// Aufruf: node rules.test.mjs <pfad-zu-firestore.rules> [--report-only]
import fs from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from "@firebase/rules-unit-testing";
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, addDoc,
  serverTimestamp, Timestamp
} from "firebase/firestore";

const rulesPath = process.argv[2] || new URL("../../firestore.rules", import.meta.url).pathname;
const reportOnly = process.argv.includes("--report-only");
const MASTER_EMAIL = "k.mitulla@gmail.com";
const T = "TEAM01";

const env = await initializeTestEnvironment({
  projectId: "demo-kk",
  firestore: { rules: fs.readFileSync(rulesPath, "utf8"), host: "127.0.0.1", port: 8080 }
});

const pw = (email) => ({ email, firebase: { sign_in_provider: "password" } });
const as = {
  master: () => env.authenticatedContext("master", pw(MASTER_EMAIL)).firestore(),
  fakeMaster: () => env.authenticatedContext("faker", { email: MASTER_EMAIL, firebase: { sign_in_provider: "google.com" } }).firestore(),
  adm: () => env.authenticatedContext("adm", pw("adm@firma.de")).firestore(),
  adm2: () => env.authenticatedContext("adm2", pw("adm2@firma.de")).firestore(),
  ali: () => env.authenticatedContext("ali", pw("ali@firma.de")).firestore(),
  bob: () => env.authenticatedContext("bob", pw("bob@firma.de")).firestore(),
  eve: () => env.authenticatedContext("eve", pw("eve@firma.de")).firestore(),
  rem: () => env.authenticatedContext("rem", pw("rem@firma.de")).firestore(),
  out: () => env.authenticatedContext("out", pw("out@firma.de")).firestore(),
  blk: () => env.authenticatedContext("blk", pw("blk@firma.de")).firestore(),
  neu: () => env.authenticatedContext("neu", pw("neu@firma.de")).firestore(),
  anon: () => env.unauthenticatedContext().firestore()
};

const now = Timestamp.now();
async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const user = (uid, approved, teams = [T]) => setDoc(doc(db, "users", uid),
      { name: uid, email: `${uid}@firma.de`, teams, approved, createdAt: now });
    await user("master", true); await setDoc(doc(db, "users", "master"),
      { name: "Kevin", email: MASTER_EMAIL, teams: [T], approved: true, createdAt: now });
    for (const u of ["adm", "adm2", "ali", "bob", "eve", "rem", "out"]) await user(u, true, u === "out" ? [] : [T]);
    await user("blk", false);
    await setDoc(doc(db, "teams", T), { name: "Büro", ownerUid: "master", createdBy: "master", createdAt: now });
    const mem = (uid, role, active = true) => setDoc(doc(db, "teams", T, "members", uid),
      { name: uid, role, active, joinedAt: now, startDate: "2026-01-01" });
    await mem("master", "owner"); await mem("adm", "admin"); await mem("adm2", "admin");
    await mem("ali", "user"); await mem("bob", "user"); await mem("eve", "user");
    await mem("rem", "user", false); await mem("blk", "user");
    await setDoc(doc(db, "teams", T, "expenses", "e_eve"), {
      type: "expense", title: "Milch", amount: 600, date: "2026-10-01", paidBy: "eve",
      shares: { eve: 50, ali: 50 }, createdBy: "eve", createdAt: now });
    await setDoc(doc(db, "teams", T, "expenses", "e_ali"), {
      type: "expense", title: "Kaffee", amount: 1200, date: "2026-10-02", paidBy: "ali",
      shares: { eve: 50, ali: 50 }, createdBy: "ali", createdAt: now });
    await setDoc(doc(db, "teams", T, "settlements", "s_pend"), {
      from: "eve", to: "ali", amount: 300, status: "pending", createdBy: "eve", createdAt: now });
    await setDoc(doc(db, "teams", T, "settlements", "s_conf"), {
      from: "bob", to: "ali", amount: 300, status: "confirmed", createdBy: "bob", createdAt: now, confirmedAt: now });
    await setDoc(doc(db, "teams", T, "reminders", "ali_bob"), {
      from: "ali", to: "bob", amount: 300, createdAt: now, count: 1 });
  });
}

const XSS = '<img src=x onerror="alert(document.cookie)">';
const attacks = [
  ["Admin macht Zweitkonto zum Besitzer (Rechteausweitung)", () =>
    setDoc(doc(as.adm(), "teams", T, "members", "evil2"), { name: "x", role: "owner", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22" })],
  ["Admin befördert User eigenmächtig zum Admin", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "bob"), { role: "admin" })],
  ["Admin entfernt anderen Admin", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "adm2"), { active: false })],
  ["Beitritt mit Schadcode im Startdatum (gespeichertes XSS)", () =>
    setDoc(doc(as.out(), "teams", T, "members", "out"), { name: "Out", role: "user", active: true, joinedAt: serverTimestamp(), startDate: XSS })],
  ["Beitritt mit eingeschleusten Extra-Feldern (iban fremd)", () =>
    setDoc(doc(as.out(), "teams", T, "members", "out"), { name: "Out", role: "user", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22", iban: "DE00ANGREIFER" })],
  ["Beitritt in nicht existierendes Team (Datenmüll)", () =>
    setDoc(doc(as.out(), "teams", "GIBTSNICHT", "members", "out"), { name: "Out", role: "user", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22" })],
  ["Riesiger Name (5000 Zeichen, UI-Lahmlegung)", () =>
    updateDoc(doc(as.eve(), "teams", T, "members", "eve"), { name: "A".repeat(5000) })],
  ["Geld stehlen: 'Erhalt bestätigen' mit negativem Betrag", () =>
    addDoc(collection(as.eve(), "teams", T, "settlements"), { from: "ali", to: "eve", amount: -5000, status: "confirmed", createdBy: "eve", createdAt: serverTimestamp(), confirmedAt: serverTimestamp() })],
  ["Geld stehlen: Ausgabe mit negativem Betrag", () =>
    addDoc(collection(as.eve(), "teams", T, "expenses"), { type: "expense", title: "x", amount: -10000, date: "2026-10-22", paidBy: "ali", shares: { eve: 100 }, createdBy: "eve", createdAt: serverTimestamp() })],
  ["Absturz provozieren: Betrag als Text", () =>
    addDoc(collection(as.eve(), "teams", T, "expenses"), { type: "expense", title: "x", amount: "abc", date: XSS, paidBy: "eve", shares: { eve: 100 }, createdBy: "eve", createdAt: serverTimestamp() })],
  ["Eigene Ausgabe heimlich in 'Verrechnung' umwandeln", () =>
    updateDoc(doc(as.eve(), "teams", T, "expenses", "e_eve"), { type: "adjustment", targetUid: "ali" })],
  ["Eigene Ausgabe einem anderen unterschieben (createdBy)", () =>
    updateDoc(doc(as.eve(), "teams", T, "expenses", "e_eve"), { createdBy: "ali" })],
  ["Zahlung an sich selbst / Betrag 0", () =>
    addDoc(collection(as.eve(), "teams", T, "settlements"), { from: "eve", to: "eve", amount: 0, status: "pending", createdBy: "eve", createdAt: serverTimestamp() })],
  ["Empfänger bestätigt mit negativem Betrag", () =>
    updateDoc(doc(as.ali(), "teams", T, "settlements", "s_pend"), { status: "confirmed", confirmedAt: serverTimestamp(), amount: -300 })],
  ["Fremde Zahlungserinnerung kapern", () =>
    setDoc(doc(as.eve(), "teams", T, "reminders", "ali_bob"), { from: "eve", to: "bob", amount: 99999, createdAt: serverTimestamp(), count: 99 })],
  ["Entferntes Mitglied löscht Eintrag, um wieder beizutreten", () =>
    deleteDoc(doc(as.rem(), "teams", T, "members", "rem"))],
  ["Profil-E-Mail auf Master-Adresse fälschen (in Liste verstecken)", () =>
    updateDoc(doc(as.eve(), "users", "eve"), { email: MASTER_EMAIL })],
  ["Profil mit erfundenen Feldern (approvedAt)", () =>
    updateDoc(doc(as.eve(), "users", "eve"), { approvedAt: serverTimestamp(), role: "admin" })],
  ["Neues Konto legt Profil mit Zusatzfeldern an", () =>
    setDoc(doc(as.neu(), "users", "neu"), { name: "Neu", email: "neu@firma.de", teams: ["TEAM01"], approved: false, createdAt: serverTimestamp(), approvedAt: serverTimestamp() })],
  ["Anonym: Passwort-Anfragen-Spam ohne Anmeldung", () =>
    addDoc(collection(as.anon(), "pwResets"), { email: "spam@spam.de", requestedAt: serverTimestamp(), status: "open" })],
  ["Gefälschter Master (Google-Login mit Master-E-Mail) liest alle Konten", () =>
    getDocs(collection(as.fakeMaster(), "users"))],
  ["Gefälschter Master schaltet sich selbst frei", () =>
    setDoc(doc(as.fakeMaster(), "users", "faker"), { name: "x", email: MASTER_EMAIL, teams: [], approved: true, createdAt: serverTimestamp() })],
  ["Admin ändert IBAN eines Users ohne Spur (Zahlungsumleitung)", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "bob"), { iban: "DE89370400440532013000" })],
  ["Admin ändert IBAN eines anderen Admins", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "adm2"), { iban: "DE89370400440532013000", payUpdatedBy: "adm", payUpdatedAt: serverTimestamp() })],
  ["Zeilenumbruch im Kontoinhaber (QR-Code-Felder verschieben)", () =>
    updateDoc(doc(as.eve(), "teams", T, "members", "eve"), { payName: "Eva\nDE00ANGREIFER", payUpdatedBy: "eve", payUpdatedAt: serverTimestamp() })],
  ["Steuerzeichen im Namen", () =>
    updateDoc(doc(as.eve(), "teams", T, "members", "eve"), { name: "Eva\u0000\u001b[31m" })],
  ["Schadcode als IBAN speichern", () =>
    updateDoc(doc(as.eve(), "teams", T, "members", "eve"), { iban: XSS, payUpdatedBy: "eve", payUpdatedAt: serverTimestamp() })],
  ["Team-Besitz (ownerUid) umschreiben", () =>
    updateDoc(doc(as.master(), "teams", T), { ownerUid: "eve" })],
  // Regressionen (waren schon vorher dicht)
  ["Außenstehender liest Ausgaben", () => getDocs(collection(as.out(), "teams", T, "expenses"))],
  ["Gesperrtes Konto liest Ausgaben", () => getDocs(collection(as.blk(), "teams", T, "expenses"))],
  ["Anonym liest Ausgaben", () => getDocs(collection(as.anon(), "teams", T, "expenses"))],
  ["User legt Verrechnung an", () =>
    addDoc(collection(as.eve(), "teams", T, "expenses"), { type: "adjustment", title: "x", targetUid: "ali", amount: 100, shares: { eve: 100 }, date: "2026-10-22", createdBy: "eve", createdAt: serverTimestamp() })],
  ["User ändert fremde Ausgabe", () => updateDoc(doc(as.eve(), "teams", T, "expenses", "e_ali"), { amount: 1 })],
  ["User schaltet sich selbst frei", () => updateDoc(doc(as.blk(), "users", "blk"), { approved: true })],
  ["Normaler User legt Team an", () =>
    setDoc(doc(as.eve(), "teams", "EVILTEAM"), { name: "x", ownerUid: "eve", createdBy: "eve", createdAt: serverTimestamp() })]
];

const legit = [
  ["Neues Konto legt Profil an", () =>
    setDoc(doc(as.neu(), "users", "neu"), { name: "Neu", email: "neu@firma.de", teams: [], approved: false, createdAt: serverTimestamp() })],
  ["Eigenen Namen im Profil ändern", () => updateDoc(doc(as.eve(), "users", "eve"), { name: "Eva" })],
  ["Team per Code beitreten (Profil + Mitglied)", async () => {
    await setDoc(doc(as.out(), "teams", T, "members", "out"), { name: "Out", role: "user", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22" });
    await updateDoc(doc(as.out(), "users", "out"), { teams: [T] });
  }],
  ["Ausgabe anlegen", () =>
    addDoc(collection(as.eve(), "teams", T, "expenses"), { type: "expense", title: "Zucker", amount: 250, date: "2026-10-22", paidBy: "eve", shares: { eve: 33.33, ali: 33.33, bob: 33.34 }, createdBy: "eve", createdAt: serverTimestamp() })],
  ["Eigene Ausgabe bearbeiten", () =>
    updateDoc(doc(as.eve(), "teams", T, "expenses", "e_eve"), { type: "expense", title: "Milch 2", amount: 700, date: "2026-10-03", paidBy: "eve", shares: { eve: 100 } })],
  ["Admin bearbeitet fremde Ausgabe", () => updateDoc(doc(as.adm(), "teams", T, "expenses", "e_ali"), { amount: 1300 })],
  ["Eigene Ausgabe löschen", () => deleteDoc(doc(as.eve(), "teams", T, "expenses", "e_eve"))],
  ["'Ich habe gezahlt' melden", () =>
    addDoc(collection(as.bob(), "teams", T, "settlements"), { from: "bob", to: "ali", amount: 450, status: "pending", createdBy: "bob", createdAt: serverTimestamp() })],
  ["Empfänger bestätigt mit angepasstem Betrag", () =>
    updateDoc(doc(as.ali(), "teams", T, "settlements", "s_pend"), { status: "confirmed", confirmedAt: serverTimestamp(), amount: 350 })],
  ["Empfänger verbucht Erhalt direkt", () =>
    addDoc(collection(as.ali(), "teams", T, "settlements"), { from: "bob", to: "ali", amount: 200, status: "confirmed", createdBy: "ali", createdAt: serverTimestamp(), confirmedAt: serverTimestamp() })],
  ["Admin erfasst Zahlung zwischen anderen", () =>
    addDoc(collection(as.adm(), "teams", T, "settlements"), { from: "bob", to: "ali", amount: 100, status: "confirmed", createdBy: "adm", createdAt: serverTimestamp(), confirmedAt: serverTimestamp() })],
  ["Admin setzt Zahlung zurück auf offen", () =>
    updateDoc(doc(as.adm(), "teams", T, "settlements", "s_conf"), { status: "pending", confirmedAt: null, amount: 300 })],
  ["Zahler zieht Meldung zurück", () => deleteDoc(doc(as.eve(), "teams", T, "settlements", "s_pend"))],
  ["Erinnerung senden + erneut erinnern", async () => {
    await setDoc(doc(as.eve(), "teams", T, "reminders", "eve_bob"), { from: "eve", to: "bob", amount: 500, createdAt: serverTimestamp(), count: 1 });
    await setDoc(doc(as.eve(), "teams", T, "reminders", "eve_bob"), { from: "eve", to: "bob", amount: 500, createdAt: serverTimestamp(), count: 2 });
  }],
  ["Schuldner löscht Erinnerung", () => deleteDoc(doc(as.bob(), "teams", T, "reminders", "ali_bob"))],
  ["Eigene Zahlungsdaten setzen", () =>
    updateDoc(doc(as.eve(), "teams", T, "members", "eve"), { paypal: "EveMuster", iban: "DE89370400440532013000", payName: "Eva Muster", payUpdatedBy: "eve", payUpdatedAt: serverTimestamp() })],
  ["Admin setzt Zahlungsdaten eines Users (mit Spur)", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "bob"), { iban: "DE89370400440532013000", payUpdatedBy: "adm", payUpdatedAt: serverTimestamp() })],
  ["Admin passt Startdatum eines Users an", () => updateDoc(doc(as.adm(), "teams", T, "members", "bob"), { startDate: "2026-02-01" })],
  ["Admin entfernt User (deaktivieren)", () =>
    updateDoc(doc(as.adm(), "teams", T, "members", "ali"), { active: false, removedAt: serverTimestamp() })],
  ["Admin aktiviert User wieder", () => updateDoc(doc(as.adm(), "teams", T, "members", "rem"), { active: true })],
  ["Admin legt Verrechnung an", () =>
    addDoc(collection(as.adm(), "teams", T, "expenses"), { type: "adjustment", title: "Verrechnung: x wurde entfernt", targetUid: "rem", amount: -450, shares: { ali: 50, bob: 50 }, date: "2026-10-22", createdBy: "adm", createdAt: serverTimestamp() })],
  ["Admin legt Gruppe an", () =>
    addDoc(collection(as.adm(), "teams", T, "presets"), { name: "Team Milch", shares: { ali: 50, bob: 50 } })],
  ["Besitzer befördert User zum Admin", () => updateDoc(doc(as.master(), "teams", T, "members", "bob"), { role: "admin" })],
  ["Besitzer ändert Statistik-Einstellungen", () =>
    updateDoc(doc(as.master(), "teams", T), { statsConfig: { period: "all", tiles: ["total"], cats: ["kaffee"] } })],
  ["Master: Konten auflisten und freischalten", async () => {
    await getDocs(collection(as.master(), "users"));
    await updateDoc(doc(as.master(), "users", "blk"), { approved: true, approvedAt: serverTimestamp() });
  }],
  ["Master: Nutzer anlegen + Team zuweisen (Admin)", async () => {
    await setDoc(doc(as.master(), "users", "neu2"), { name: "Neu2", email: "neu2@firma.de", teams: [T], approved: true, approvedAt: serverTimestamp(), createdAt: serverTimestamp() });
    await setDoc(doc(as.master(), "teams", T, "members", "neu2"), { name: "Neu2", role: "admin", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22" });
  }],
  ["Master: neues Team anlegen (inkl. Besitzer-Eintrag)", async () => {
    const db = as.master();
    await setDoc(doc(db, "teams", "NEWTEAM8"), { name: "Neues Team", ownerUid: "master", createdBy: "master", createdAt: serverTimestamp() });
    await setDoc(doc(db, "teams", "NEWTEAM8", "members", "master"), { name: "Kevin", role: "owner", active: true, joinedAt: serverTimestamp(), startDate: "2026-10-22" });
  }],
  ["Mitglied verlässt Team", () => deleteDoc(doc(as.eve(), "teams", T, "members", "eve"))],
  ["Besitzer löscht Team komplett (wie die App)", async () => {
    const db = as.master();
    for (const sub of ["expenses", "settlements", "presets", "reminders", "members"]) {
      const snap = await getDocs(collection(db, "teams", T, sub));
      for (const d of snap.docs) if (!(sub === "members" && d.id === "master")) await deleteDoc(d.ref);
    }
    await deleteDoc(doc(db, "teams", T));
    await deleteDoc(doc(db, "teams", T, "members", "master"));
  }],
  ["Mitglied liest Team-Daten", async () => {
    await getDoc(doc(as.ali(), "teams", T));
    await getDocs(collection(as.ali(), "teams", T, "members"));
    await getDocs(collection(as.ali(), "teams", T, "expenses"));
    await getDocs(collection(as.ali(), "teams", T, "settlements"));
    await getDocs(collection(as.ali(), "teams", T, "reminders"));
    await getDocs(collection(as.ali(), "teams", T, "presets"));
  }]
];

let attackHits = 0, legitFails = 0;
console.log(`\nRegeln: ${rulesPath}\n\n--- ANGRIFFE (müssen ABGELEHNT werden) ---`);
for (const [name, fn] of attacks) {
  await seed();
  let ok;
  try { await fn(); ok = true; } catch (e) { ok = false; if (!String(e).includes("PERMISSION_DENIED") && !String(e).includes("permission")) console.log("     (Fehler:", String(e).slice(0, 120), ")"); }
  if (ok) attackHits++;
  console.log(`${ok ? "  ❌ MÖGLICH  " : "  ✅ blockiert"}  ${name}`);
}
console.log(`\n--- LEGITIME ABLÄUFE (müssen ERLAUBT sein) ---`);
for (const [name, fn] of legit) {
  await seed();
  let ok, err = "";
  try { await fn(); ok = true; } catch (e) { ok = false; err = String(e).slice(0, 160); }
  if (!ok) legitFails++;
  console.log(`${ok ? "  ✅ erlaubt  " : "  ❌ KAPUTT   "}  ${name}${ok ? "" : "  -> " + err}`);
}
console.log(`\nERGEBNIS: ${attackHits} von ${attacks.length} Angriffen möglich, ${legitFails} von ${legit.length} legitimen Abläufen kaputt.`);
await env.cleanup();
process.exit(reportOnly ? 0 : (attackHits || legitFails ? 1 : 0));
