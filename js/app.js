// ==========================================================
// Kaffeekasse – Hauptlogik
// ==========================================================
import {
  auth, db,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  updateProfile, signOut,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove,
  secondaryCreateUser
} from "./firebase.js";
import { makeXlsx, makePdf, download } from "./export.js";
import { icon } from "./icons.js";
import {
  formatCents, parseEuro, splitByPercent, equalPercents,
  computeBalances, simplifyDebts
} from "./balance.js";
import { MASTER_EMAIL } from "./firebase-config.js";

// ---------------------------------------------------------
// Zustand
// ---------------------------------------------------------
const state = {
  user: null,
  profile: null,
  teamId: null,
  team: null,
  members: {},        // uid -> Mitgliedsdaten
  expenses: [],
  settlements: [],
  presets: [],
  balances: {},
  activeTab: "dashboard",
  teamUnsubs: [],
  profileUnsub: null,
  usersUnsub: null,
  allUsers: [],
  pwResetsUnsub: null,
  pwResets: [],
  online: navigator.onLine,
  pendingWrites: false,
  teamNameCache: {}
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ROLE_LABEL = { owner: "Benutzer", admin: "Admin", user: "User" };
const ROLE_BADGE = { owner: "badge-owner", admin: "badge-admin", user: "badge-user" };

function isMasterUser() {
  return (state.user?.email || "").toLowerCase() === MASTER_EMAIL.toLowerCase();
}

function myRole() {
  const m = state.members[state.user?.uid];
  return m ? m.role : "user";
}
function isAdmin() { return ["owner", "admin"].includes(myRole()); }
function isOwner() { return myRole() === "owner"; }

function memberName(uid) {
  if (uid === state.user?.uid) return "Du";
  return state.members[uid]?.name || "Unbekannt";
}
function memberNameReal(uid) {
  return state.members[uid]?.name || "Unbekannt";
}
function activeMembers() {
  return Object.entries(state.members)
    .filter(([, m]) => m.active !== false)
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function fmtDateTime(ts) {
  if (!ts?.seconds) return "";
  return new Date(ts.seconds * 1000).toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  }) + " Uhr";
}

// Kategorien für Diagramme & Statistiken (aus dem Titel erkannt)
const CATEGORIES = [
  { key: "kaffee", label: "Kaffee", icon: "coffee", re: /(kaffee|espresso|bohne|coffee)/ },
  { key: "milch", label: "Milch", icon: "milk", re: /(milch|hafer|oat)/ },
  { key: "zucker", label: "Zucker", icon: "sugar", re: /(zucker|süßstoff|sirup)/ },
  { key: "tee", label: "Tee", icon: "tea", re: /tee/ },
  { key: "wasser", label: "Wasser", icon: "water", re: /(wasser|sprudel)/ },
  { key: "suesses", label: "Süßes & Gebäck", icon: "cake", re: /(kuchen|geb(ä|a)ck|keks|donut|croissant|schoko|süß|eis)/ },
  { key: "zubehoer", label: "Zubehör", icon: "box", re: /(filter|becher|tasse|maschine|entkalker|reinig|löffel)/ }
];
const CAT_OTHER = { key: "sonstiges", label: "Sonstiges", icon: "cart" };

// Schutz gegen Doppelklick: sperrt einen Button sofort; erst nach
// kurzer Zeit wieder frei (falls der Dialog offen bleibt).
function lockOnce(btn) {
  if (!btn || btn.dataset.lock) return false;
  btn.dataset.lock = "1";
  btn.disabled = true;
  setTimeout(() => { delete btn.dataset.lock; btn.disabled = false; }, 3000);
  return true;
}

// Firestore-Schreibvorgänge NICHT abwarten: bei schlechter Verbindung
// hängt das Promise, lokal ist die Änderung aber sofort da (Offline-Cache).
function fireWrite(promise, errMsg) {
  promise.catch(err => {
    console.error(err);
    toast(errMsg || "Speichern fehlgeschlagen – bitte prüfen.");
  });
}
function categoryFor(title) {
  const t = (title || "").toLowerCase();
  return CATEGORIES.find(c => c.re.test(t)) || CAT_OTHER;
}

// Beträge nach der Eingabe immer als "12,00" formatieren
function wireMoneyInput(el) {
  if (!el) return;
  el.addEventListener("blur", () => {
    const cents = parseEuro(el.value);
    if (cents !== null) el.value = (cents / 100).toFixed(2).replace(".", ",");
  });
}

// Datumsfelder: Kalender direkt beim Antippen öffnen (PC & Handy)
document.addEventListener("click", (e) => {
  const inp = e.target.closest('input[type="date"]');
  if (inp && !inp.disabled && typeof inp.showPicker === "function") {
    try { inp.showPicker(); } catch { /* braucht Nutzer-Geste, ignorieren */ }
  }
});

function iconFor(title) {
  if (/verrechnung/i.test(title || "")) return "scale";
  return categoryFor(title).icon;
}
function initials(name) {
  return (name || "?").trim().split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase() || "?";
}

// ---------------------------------------------------------
// Toast & Modal
// ---------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function openModal(html) {
  $("modal-box").innerHTML = html;
  $("modal-backdrop").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("modal-backdrop").classList.add("hidden");
  $("modal-box").innerHTML = "";
  document.body.style.overflow = "";
}
$("modal-backdrop").addEventListener("click", (e) => {
  if (e.target === $("modal-backdrop")) closeModal();
});

// ---------------------------------------------------------
// Sync-Status (online / offline / ausstehend)
// ---------------------------------------------------------
function renderSync() {
  const pill = $("sync-pill");
  const label = $("sync-label");
  pill.classList.remove("offline", "pending");
  if (!state.online) {
    pill.classList.add("offline");
    label.textContent = state.pendingWrites ? "Offline · Sync ausstehend" : "Offline";
  } else if (state.pendingWrites) {
    pill.classList.add("pending");
    label.textContent = "Synchronisiert …";
  } else {
    label.textContent = "Online · synchron";
  }
}
window.addEventListener("online", () => { state.online = true; renderSync(); });
window.addEventListener("offline", () => { state.online = false; renderSync(); });
// Auf schmalen Handys wird nur der Punkt gezeigt – Antippen nennt den Status
$("sync-pill").addEventListener("click", () => toast("Status: " + $("sync-label").textContent));

const pendingFlags = {};
function setPending(key, val) {
  pendingFlags[key] = val;
  state.pendingWrites = Object.values(pendingFlags).some(Boolean);
  renderSync();
}

// ---------------------------------------------------------
// Ansichten umschalten
// ---------------------------------------------------------
function showView(name) {
  for (const v of ["view-loading", "view-auth", "view-reset", "view-pending", "view-noteam", "view-app"]) {
    $(v).classList.toggle("hidden", v !== `view-${name}`);
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["dashboard", "expenses", "settle", "team"]) {
    $(`tab-${t}`).classList.toggle("hidden", t !== tab);
  }
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".tab-btn").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ---------------------------------------------------------
// Auth
// ---------------------------------------------------------
let authMode = "login";
$("auth-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  authMode = btn.dataset.mode;
  document.querySelectorAll("#auth-tabs .seg-btn").forEach(b =>
    b.classList.toggle("active", b === btn));
  $("auth-name-field").classList.toggle("hidden", authMode !== "register");
  $("auth-submit").textContent = authMode === "register" ? "Konto erstellen" : "Anmelden";
  $("auth-error").classList.add("hidden");
});

function authErrorText(err) {
  const c = err?.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found"))
    return "E-Mail oder Passwort ist falsch.";
  if (c.includes("email-already-in-use")) return "Diese E-Mail ist bereits registriert.";
  if (c.includes("weak-password")) return "Das Passwort muss mindestens 6 Zeichen haben.";
  if (c.includes("invalid-email")) return "Bitte eine gültige E-Mail-Adresse eingeben.";
  if (c.includes("too-many-requests")) return "Zu viele Versuche – bitte kurz warten.";
  if (c.includes("network")) return "Keine Internetverbindung.";
  return "Das hat leider nicht geklappt. (" + c + ")";
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const pass = $("auth-password").value;
  const errEl = $("auth-error");
  errEl.classList.add("hidden");
  $("auth-submit").disabled = true;
  try {
    if (authMode === "register") {
      const name = $("auth-name").value.trim();
      if (!name) throw { code: "custom", message: "Bitte gib deinen Namen ein." };
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      const isMaster = email.toLowerCase() === MASTER_EMAIL.toLowerCase();
      await setDoc(doc(db, "users", cred.user.uid), {
        name, email, teams: [], approved: isMaster, createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (err) {
    errEl.textContent = err.code === "custom" ? err.message : authErrorText(err);
    errEl.classList.remove("hidden");
  } finally {
    $("auth-submit").disabled = false;
  }
});

// "Passwort vergessen": erzeugt eine Anfrage, die der Verwalter
// freigeben muss – erst dann geht die Zurücksetzungs-E-Mail raus.
$("auth-forgot").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  if (!email || !email.includes("@")) { toast("Bitte zuerst deine E-Mail eintragen."); return; }
  try {
    await addDoc(collection(db, "pwResets"), {
      email, requestedAt: serverTimestamp(), status: "open"
    });
    toast("Der Verwalter wurde informiert und gibt die Zurücksetzung frei. Du bekommst dann eine E-Mail.");
  } catch (err) {
    console.error(err);
    toast("Anfrage konnte nicht gesendet werden.");
  }
});

$("noteam-signout").addEventListener("click", () => signOut(auth));
$("noteam-back").addEventListener("click", () => showView("app"));
$("pending-signout").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------
// Master: Konten freischalten
// ---------------------------------------------------------
function pendingUsers() {
  return state.allUsers.filter(u =>
    u.approved !== true && (u.email || "").toLowerCase() !== MASTER_EMAIL.toLowerCase());
}

function openResets() {
  return state.pwResets.filter(r => r.status === "open");
}

// Zurücksetzungs-E-Mail senden – mit Rücksprung-Link zur App.
// Falls die Domain (noch) nicht in Firebase autorisiert ist, wird
// automatisch ohne Rücksprung-Link gesendet, damit die E-Mail immer rausgeht.
async function sendResetMail(email) {
  const settings = { url: location.origin + location.pathname };
  try {
    await sendPasswordResetEmail(auth, email, settings);
  } catch (err) {
    if ((err?.code || "").includes("unauthorized-continue-uri")) {
      await sendPasswordResetEmail(auth, email);
    } else {
      throw err;
    }
  }
}

function renderMasterUI() {
  const master = state.user && isMasterUser();
  $("master-card").classList.toggle("hidden", !master);
  $("noteam-master").classList.toggle("hidden", !master);
  $("create-team-section").classList.toggle("hidden", !master);
  $("noteam-sub").textContent = master
    ? "Erstelle ein Team oder tritt einem bei."
    : "Tritt mit einem Einladungscode einem Team bei.";
  if (!master) return;
  const n = pendingUsers().length + openResets().length;
  const parts = [];
  if (pendingUsers().length) parts.push(`${pendingUsers().length} Freischaltung(en)`);
  if (openResets().length) parts.push(`${openResets().length} Passwort-Anfrage(n)`);
  $("master-card-sub").textContent = parts.length ? `Offen: ${parts.join(", ")}` : "Nichts offen";
  $("master-card-badge").classList.toggle("hidden", n === 0);
  $("master-card-badge").textContent = n;
  $("noteam-master").textContent = n
    ? `Benutzerverwaltung (${n} offen)` : "Benutzerverwaltung";
  // Offene Liste live aktualisieren
  if ($("ua-list")) renderUserAdminList();
}

$("master-card").addEventListener("click", openUserAdminModal);
$("noteam-master").addEventListener("click", openUserAdminModal);

function userStatus(u) {
  if (u.approved === true) return "aktiv";
  return u.blockedAt ? "gesperrt" : "wartet";
}
const UA_STATUS = {
  wartet: { icon: "clock", cls: "warn", label: "Wartet auf Freischaltung", order: 0 },
  gesperrt: { icon: "ban", cls: "bad", label: "Gesperrt", order: 1 },
  aktiv: { icon: "check", cls: "ok", label: "Freigeschaltet", order: 2 }
};
const uaState = { search: "", filter: "alle" };

function openUserAdminModal() {
  uaState.search = "";
  uaState.filter = "alle";
  openModal(`
    <div class="section-head" style="margin-bottom:10px">
      <h3 class="modal-title" style="margin-bottom:0">Benutzerverwaltung</h3>
      <button class="btn btn-small btn-primary" id="ua-create">+ Nutzer anlegen</button>
    </div>
    <div id="ua-resets"></div>
    <input type="search" class="search-input" id="ua-search" placeholder="Nach Name oder E-Mail suchen …">
    <div class="filter-row" id="ua-filters">
      ${["alle", "wartet", "aktiv", "gesperrt"].map(f =>
        `<button class="filter-chip ${f === "alle" ? "active" : ""}" data-f="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
    </div>
    <div class="stack-list" id="ua-list"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ua-close">Schließen</button>
    </div>`);
  $("ua-close").addEventListener("click", closeModal);
  $("ua-create").addEventListener("click", openCreateUserModal);
  $("ua-search").addEventListener("input", () => {
    uaState.search = $("ua-search").value.trim().toLowerCase();
    renderUserAdminList();
  });
  $("ua-filters").querySelectorAll("[data-f]").forEach(chip =>
    chip.addEventListener("click", () => {
      uaState.filter = chip.dataset.f;
      $("ua-filters").querySelectorAll(".filter-chip").forEach(c =>
        c.classList.toggle("active", c === chip));
      renderUserAdminList();
    }));
  renderUserAdminList();
}

function renderUserAdminList() {
  const box = $("ua-list");
  if (!box) return;

  // Offene Passwort-Anfragen
  const resetsBox = $("ua-resets");
  const resets = openResets();
  resetsBox.innerHTML = resets.length ? `
    <h3 class="section-title" style="margin-top:0">Passwort-Anfragen</h3>
    <div class="stack-list" style="margin-bottom:14px">
      ${resets.map(r => `
        <div class="list-item compact">
          <div class="item-icon">${icon("lock", 18)}</div>
          <div class="item-main">
            <div class="item-title">${esc(r.email)}</div>
            <div class="item-sub">Angefragt: ${esc(fmtDateTime(r.requestedAt) || "–")}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px">
            <button class="btn btn-small btn-primary" data-rok="${esc(r.id)}">Freigeben</button>
            <button class="btn btn-small btn-secondary" data-rno="${esc(r.id)}">Ablehnen</button>
          </div>
        </div>`).join("")}
    </div>` : "";
  resetsBox.querySelectorAll("[data-rok]").forEach(b =>
    b.addEventListener("click", async (e) => {
      const r = state.pwResets.find(x => x.id === b.dataset.rok);
      if (!r || !lockOnce(e.currentTarget)) return;
      try {
        // Nur EINE E-Mail senden – jede neue E-Mail macht ältere Links ungültig.
        await sendResetMail(r.email);
        // Alle offenen Anfragen dieser Person zusammen abhaken.
        const same = state.pwResets.filter(x =>
          x.status === "open" && x.email.toLowerCase() === r.email.toLowerCase());
        for (const x of same) {
          fireWrite(updateDoc(doc(db, "pwResets", x.id), { status: "done", doneAt: serverTimestamp() }));
        }
        toast(`Zurücksetzungs-E-Mail an ${r.email} gesendet. Nur der Link aus dieser (neuesten) E-Mail funktioniert.`);
      } catch (err) {
        console.error(err);
        toast("E-Mail konnte nicht gesendet werden.");
      }
    }));
  resetsBox.querySelectorAll("[data-rno]").forEach(b =>
    b.addEventListener("click", async () => {
      await deleteDoc(doc(db, "pwResets", b.dataset.rno));
      toast("Anfrage abgelehnt.");
    }));

  const users = state.allUsers
    .filter(u => (u.email || "").toLowerCase() !== MASTER_EMAIL.toLowerCase())
    .filter(u => !uaState.search
      || (u.name || "").toLowerCase().includes(uaState.search)
      || (u.email || "").toLowerCase().includes(uaState.search))
    .filter(u => uaState.filter === "alle" || userStatus(u) === uaState.filter)
    .sort((a, b) => UA_STATUS[userStatus(a)].order - UA_STATUS[userStatus(b)].order
      || (a.name || "").localeCompare(b.name || ""));

  box.innerHTML = users.length ? users.map(u => {
    const st = UA_STATUS[userStatus(u)];
    const lines = [
      esc(u.email || ""),
      `Registriert: ${fmtDateTime(u.createdAt) || "–"}`,
      u.approvedAt ? `Freigeschaltet: ${fmtDateTime(u.approvedAt)}` : "",
      u.blockedAt && u.approved !== true ? `Gesperrt: ${fmtDateTime(u.blockedAt)}` : ""
    ].filter(Boolean).join("<br>");
    return `
      <div class="list-item compact tappable" data-detail="${esc(u.uid)}">
        <div class="item-icon ${st.cls}">${icon(st.icon, 18)}</div>
        <div class="item-main">
          <div class="item-title">${esc(u.name || "Ohne Name")}</div>
          <div class="item-sub">${lines}</div>
        </div>
        ${u.approved === true
          ? `<button class="btn btn-small btn-danger" data-block="${esc(u.uid)}">Sperren</button>`
          : `<button class="btn btn-small btn-primary" data-approve="${esc(u.uid)}">Freischalten</button>`}
      </div>`;
  }).join("") : `<div class="empty-note">Keine Konten gefunden.</div>`;

  box.querySelectorAll("[data-detail]").forEach(el =>
    el.addEventListener("click", () => openUserDetailModal(el.dataset.detail)));
  box.querySelectorAll("[data-approve]").forEach(b =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateDoc(doc(db, "users", b.dataset.approve), {
        approved: true, approvedAt: serverTimestamp()
      });
      toast("Konto freigeschaltet.");
    }));
  box.querySelectorAll("[data-block]").forEach(b =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Dieses Konto sperren? Die Person kann die App dann nicht mehr benutzen, bis du sie wieder freischaltest.")) return;
      await updateDoc(doc(db, "users", b.dataset.block), {
        approved: false, blockedAt: serverTimestamp()
      });
      toast("Konto gesperrt.");
    }));
}

// Teamname mit Cache laden
async function getTeamName(teamId) {
  if (!state.teamNameCache[teamId]) {
    try {
      const snap = await getDoc(doc(db, "teams", teamId));
      state.teamNameCache[teamId] = snap.exists() ? snap.data().name : teamId;
    } catch { state.teamNameCache[teamId] = teamId; }
  }
  return state.teamNameCache[teamId];
}

// ---------- Master: Nutzer-Detail (Teams verwalten, Passwort) ----------
async function openUserDetailModal(uid) {
  const u = state.allUsers.find(x => x.uid === uid);
  if (!u || !isMasterUser()) return;

  // Team-Mitgliedschaften des Nutzers laden
  const userTeams = [];
  for (const tid of u.teams || []) {
    const name = await getTeamName(tid);
    let member = null;
    try {
      const snap = await getDoc(doc(db, "teams", tid, "members", uid));
      if (snap.exists()) member = snap.data();
    } catch { /* kein Zugriff */ }
    userTeams.push({ tid, name, member });
  }
  const myTeams = state.profile?.teams || [];
  const addable = [];
  for (const tid of myTeams) {
    if (!(u.teams || []).includes(tid)) addable.push({ tid, name: await getTeamName(tid) });
  }

  const st = UA_STATUS[userStatus(u)];
  openModal(`
    <h3 class="modal-title">${esc(u.name || "Ohne Name")}</h3>
    <p class="muted small" style="margin-bottom:12px">${esc(u.email || "")} · ${st.label}</p>
    <div class="stack">
      <h3 class="section-title" style="margin-top:0">Teams</h3>
      ${userTeams.length ? userTeams.map(t => `
        <div class="list-item compact">
          <div class="item-icon">${t.member?.active === false ? icon("personOut") : icon("people")}</div>
          <div class="item-main">
            <div class="item-title">${esc(t.name)}</div>
            <div class="item-sub">${t.member ? (t.member.active === false ? "Entfernt" : ROLE_LABEL[t.member.role] || t.member.role) : "Kein Mitgliedseintrag"}</div>
          </div>
          ${t.member && t.member.role !== "owner" && t.member.active !== false ? `
            <div style="display:flex;flex-direction:column;gap:5px">
              <select class="pct-input" style="width:auto" data-role-team="${esc(t.tid)}">
                <option value="user" ${t.member.role === "user" ? "selected" : ""}>User</option>
                <option value="admin" ${t.member.role === "admin" ? "selected" : ""}>Admin</option>
              </select>
              <button class="btn btn-small btn-danger" data-rmteam="${esc(t.tid)}">Entfernen</button>
            </div>` : ""}
        </div>`).join("") : `<div class="empty-note">In keinem Team.</div>`}
      ${addable.length ? `
      <h3 class="section-title">Zu Team hinzufügen</h3>
      <div style="display:flex;gap:8px">
        <select id="ud-add-team" class="pct-input" style="width:auto;flex:1">
          ${addable.map(t => `<option value="${esc(t.tid)}">${esc(t.name)}</option>`).join("")}
        </select>
        <select id="ud-add-role" class="pct-input" style="width:auto">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button class="btn btn-small btn-primary" id="ud-add">Hinzufügen</button>
      </div>` : ""}
      <h3 class="section-title">Passwort</h3>
      <button class="btn btn-secondary" id="ud-pwreset">Zurücksetzungs-E-Mail senden</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ud-back">Zurück</button>
    </div>`);

  $("ud-back").addEventListener("click", openUserAdminModal);
  $("ud-pwreset").addEventListener("click", async () => {
    try {
      await sendResetMail(u.email);
      toast(`Zurücksetzungs-E-Mail an ${u.email} gesendet.`);
    } catch (err) {
      console.error(err);
      toast("E-Mail konnte nicht gesendet werden.");
    }
  });
  $("modal-box").querySelectorAll("[data-role-team]").forEach(sel =>
    sel.addEventListener("change", async () => {
      await updateDoc(doc(db, "teams", sel.dataset.roleTeam, "members", uid), { role: sel.value });
      toast("Rolle geändert.");
    }));
  $("modal-box").querySelectorAll("[data-rmteam]").forEach(b =>
    b.addEventListener("click", async () => {
      if (!confirm(`${u.name} wirklich aus dem Team entfernen? Ein offener Saldo bleibt im Team sichtbar und kann dort verrechnet werden.`)) return;
      await updateDoc(doc(db, "teams", b.dataset.rmteam, "members", uid), {
        active: false, removedAt: serverTimestamp()
      });
      await updateDoc(doc(db, "users", uid), { teams: arrayRemove(b.dataset.rmteam) });
      toast("Aus dem Team entfernt.");
      openUserDetailModal(uid);
    }));
  const addBtn = $("ud-add");
  if (addBtn) addBtn.addEventListener("click", async () => {
    const tid = $("ud-add-team").value;
    const role = $("ud-add-role").value;
    await setDoc(doc(db, "teams", tid, "members", uid), {
      name: u.name || "Neu", role, active: true,
      joinedAt: serverTimestamp(), startDate: todayStr()
    });
    await updateDoc(doc(db, "users", uid), { teams: arrayUnion(tid) });
    toast("Zum Team hinzugefügt.");
    openUserDetailModal(uid);
  });
}

// ---------- Master: Nutzer direkt anlegen ----------
function openCreateUserModal() {
  const myTeams = state.profile?.teams || [];
  openModal(`
    <h3 class="modal-title">Nutzer anlegen</h3>
    <div class="stack">
      <div class="field">
        <label>Name</label>
        <input type="text" id="cu-name" placeholder="z. B. Max">
      </div>
      <div class="field">
        <label>E-Mail</label>
        <input type="email" id="cu-email" placeholder="name@firma.de">
      </div>
      <div class="field">
        <label>Passwort (optional)</label>
        <input type="text" id="cu-pass" placeholder="Leer lassen: Person legt es per E-Mail selbst fest">
      </div>
      ${myTeams.length ? `
      <div class="field">
        <label>Direkt zu Team hinzufügen (optional)</label>
        <select id="cu-team">
          <option value="">– Kein Team –</option>
          ${myTeams.map(t => `<option value="${esc(t)}">${esc(state.teamNameCache[t] || t)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Rolle im Team</label>
        <select id="cu-role">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </div>` : ""}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="cu-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="cu-save">Anlegen</button>
    </div>`);
  // Teamnamen nachladen (falls noch nicht im Cache)
  (async () => {
    for (const t of myTeams) {
      const name = await getTeamName(t);
      const opt = $("cu-team")?.querySelector(`option[value="${t}"]`);
      if (opt) opt.textContent = name;
    }
  })();
  $("cu-cancel").addEventListener("click", openUserAdminModal);
  $("cu-save").addEventListener("click", async () => {
    const name = $("cu-name").value.trim();
    const email = $("cu-email").value.trim();
    const pass = $("cu-pass").value;
    const team = $("cu-team")?.value || "";
    const role = $("cu-role")?.value || "user";
    if (!name) { toast("Bitte einen Namen eingeben."); return; }
    if (!email.includes("@")) { toast("Bitte eine gültige E-Mail eingeben."); return; }
    if (pass && pass.length < 6) { toast("Das Passwort braucht mindestens 6 Zeichen."); return; }
    $("cu-save").disabled = true;
    try {
      // Ohne Passwort: Zufallspasswort + E-Mail zum Selbst-Festlegen
      const pw = pass || Array.from(crypto.getRandomValues(new Uint8Array(18)),
        b => "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"[b % 54]).join("");
      const uid = await secondaryCreateUser(email, pw);
      await setDoc(doc(db, "users", uid), {
        name, email, teams: team ? [team] : [],
        approved: true, approvedAt: serverTimestamp(), createdAt: serverTimestamp()
      });
      if (team) {
        await setDoc(doc(db, "teams", team, "members", uid), {
          name, role, active: true,
          joinedAt: serverTimestamp(), startDate: todayStr()
        });
      }
      if (!pass) {
        await sendResetMail(email);
        toast(`Konto angelegt – ${email} bekommt eine E-Mail zum Passwort-Festlegen.`);
      } else {
        toast("Konto angelegt und freigeschaltet.");
      }
      openUserAdminModal();
    } catch (err) {
      console.error(err);
      toast(authErrorText(err));
      $("cu-save").disabled = false;
    }
  });
}

// ---------------------------------------------------------
// Passwort über den Link aus der E-Mail neu festlegen.
// (Firebase Console: Authentication > Templates > Aktions-URL auf die
// App-Adresse stellen, dann öffnet der E-Mail-Link diese Seite.)
// ---------------------------------------------------------
const urlParams = new URLSearchParams(location.search);
const resetOobCode = urlParams.get("mode") === "resetPassword" ? urlParams.get("oobCode") : null;
let resetEmail = null;

function resetErrorText(err) {
  const c = err?.code || "";
  if (c.includes("expired-action-code"))
    return "Dieser Link ist abgelaufen. Wichtig: Ein Link gilt nur begrenzte Zeit, "
      + "nur einmal – und es zählt immer die zuletzt gesendete E-Mail.";
  if (c.includes("invalid-action-code"))
    return "Dieser Link ist ungültig oder wurde bereits verwendet. "
      + "Falls du mehrere E-Mails bekommen hast: Es funktioniert nur der Link aus der neuesten.";
  if (c.includes("user-disabled") || c.includes("user-not-found"))
    return "Zu diesem Link gibt es kein aktives Konto.";
  return "Der Link konnte nicht geprüft werden. (" + c + ")";
}

async function initResetFlow() {
  state.resetMode = true;
  showView("reset");
  try {
    resetEmail = await verifyPasswordResetCode(auth, resetOobCode);
    $("reset-email-info").textContent = "für " + resetEmail;
    $("reset-form").classList.remove("hidden");
  } catch (err) {
    console.warn(err);
    $("reset-email-info").textContent = "";
    $("reset-invalid-text").textContent = resetErrorText(err);
    $("reset-email-field").classList.remove("hidden");
    $("reset-invalid").classList.remove("hidden");
  }
}

$("reset-submit").addEventListener("click", async (e) => {
  const p1 = $("reset-pass1").value;
  const p2 = $("reset-pass2").value;
  const errEl = $("reset-error");
  errEl.classList.add("hidden");
  const fail = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  if (p1.length < 6) { fail("Das Passwort braucht mindestens 6 Zeichen."); return; }
  if (p1 !== p2) { fail("Die Passwörter stimmen nicht überein."); return; }
  if (!lockOnce(e.currentTarget)) return;
  try {
    await confirmPasswordReset(auth, resetOobCode, p1);
    $("reset-form").classList.add("hidden");
    $("reset-done").classList.remove("hidden");
    toast("Passwort geändert.");
  } catch (err) {
    console.warn(err);
    $("reset-form").classList.add("hidden");
    $("reset-invalid-text").textContent = resetErrorText(err);
    $("reset-email-field").classList.remove("hidden");
    $("reset-invalid").classList.remove("hidden");
  }
});

$("reset-request-new").addEventListener("click", async (e) => {
  const email = resetEmail || $("reset-email-input").value.trim();
  if (!email.includes("@")) { toast("Bitte deine E-Mail eintragen."); return; }
  if (!lockOnce(e.currentTarget)) return;
  try {
    await addDoc(collection(db, "pwResets"), {
      email, requestedAt: serverTimestamp(), status: "open"
    });
    toast("Der Verwalter wurde informiert und gibt die Zurücksetzung frei.");
  } catch (err) {
    console.error(err);
    toast("Anfrage konnte nicht gesendet werden.");
  }
});

$("reset-back").addEventListener("click", () => {
  // Parameter aus der Adresse entfernen und die App normal starten
  location.href = location.pathname;
});

if (resetOobCode) initResetFlow();

// ---------------------------------------------------------
// Start: Auth-Status beobachten
// ---------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  // Während des Passwort-Zurücksetzens keine Ansicht wechseln
  if (state.resetMode) return;
  cleanupTeam();
  if (state.profileUnsub) { state.profileUnsub(); state.profileUnsub = null; }
  if (state.usersUnsub) { state.usersUnsub(); state.usersUnsub = null; }
  if (state.pwResetsUnsub) { state.pwResetsUnsub(); state.pwResetsUnsub = null; }
  state.allUsers = [];
  state.pwResets = [];
  state.user = user;
  switchTab("dashboard");
  if (!user) {
    state.profile = null;
    showView("auth");
    return;
  }
  showView("loading");

  // Master: alle Konten + Passwort-Anfragen beobachten
  if (isMasterUser()) {
    state.usersUnsub = onSnapshot(collection(db, "users"), (snap) => {
      const list = [];
      snap.forEach(d => list.push({ uid: d.id, ...d.data() }));
      state.allUsers = list;
      renderMasterUI();
    }, err => console.error("users:", err));
    state.pwResetsUnsub = onSnapshot(collection(db, "pwResets"), (snap) => {
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (b.requestedAt?.seconds || 0) - (a.requestedAt?.seconds || 0));
      state.pwResets = list;
      renderMasterUI();
    }, err => console.error("pwResets:", err));
  }
  renderMasterUI();

  // Profil beobachten (Name, Teamliste)
  const ref = doc(db, "users", user.uid);
  state.profileUnsub = onSnapshot(ref, async (snap) => {
    if (!snap.exists()) {
      // Profil fehlt (z. B. Konto existierte schon) -> anlegen
      await setDoc(ref, {
        name: user.displayName || user.email.split("@")[0],
        email: user.email, teams: [], approved: isMasterUser(),
        createdAt: serverTimestamp()
      });
      return;
    }
    state.profile = snap.data();
    $("avatar-initials").textContent = initials(state.profile.name);

    // Noch nicht vom Master freigeschaltet? -> Warte-Ansicht
    if (!isMasterUser() && state.profile.approved !== true) {
      cleanupTeam();
      showView("pending");
      return;
    }

    const teams = state.profile.teams || [];
    if (teams.length === 0) {
      cleanupTeam();
      showView("noteam");
      return;
    }
    let wanted = localStorage.getItem("kk-team");
    if (!teams.includes(wanted)) wanted = teams[0];
    if (state.teamId !== wanted) {
      attachTeam(wanted);
    }
    showView("app");
  }, (err) => {
    console.error("Profil-Listener:", err);
  });
});

// ---------------------------------------------------------
// Team anlegen / beitreten
// ---------------------------------------------------------
function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // ohne I,L,O,0,1
  let c = "";
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function createTeam(name) {
  const uid = state.user.uid;
  const code = genCode();
  await setDoc(doc(db, "teams", code), {
    name, ownerUid: uid, createdBy: uid, createdAt: serverTimestamp()
  });
  await setDoc(doc(db, "teams", code, "members", uid), {
    name: state.profile?.name || "Ich",
    role: "owner", active: true,
    joinedAt: serverTimestamp(), startDate: todayStr()
  });
  await updateDoc(doc(db, "users", uid), { teams: arrayUnion(code) });
  localStorage.setItem("kk-team", code);
  return code;
}

async function joinTeam(code) {
  const uid = state.user.uid;
  const snap = await getDoc(doc(db, "teams", code));
  if (!snap.exists()) throw new Error("Kein Team mit diesem Code gefunden.");
  const memberRef = doc(db, "teams", code, "members", uid);
  const existing = await getDoc(memberRef);
  if (existing.exists()) {
    if (existing.data().active === false)
      throw new Error("Du wurdest aus diesem Team entfernt. Bitte einen Admin, dich wieder zu aktivieren.");
  } else {
    await setDoc(memberRef, {
      name: state.profile?.name || "Neu",
      role: "user", active: true,
      joinedAt: serverTimestamp(), startDate: todayStr()
    });
  }
  await updateDoc(doc(db, "users", uid), { teams: arrayUnion(code) });
  localStorage.setItem("kk-team", code);
}

$("btn-create-team").addEventListener("click", async () => {
  const name = $("new-team-name").value.trim();
  const errEl = $("noteam-error");
  errEl.classList.add("hidden");
  if (!isMasterUser()) {
    errEl.textContent = "Nur der Verwalter kann neue Teams erstellen.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!name) { errEl.textContent = "Bitte einen Teamnamen eingeben."; errEl.classList.remove("hidden"); return; }
  try {
    await createTeam(name);
    toast("Team erstellt!");
  } catch (err) {
    console.error(err);
    errEl.textContent = "Team konnte nicht erstellt werden.";
    errEl.classList.remove("hidden");
  }
});

$("btn-join-team").addEventListener("click", async () => {
  const code = $("join-code").value.trim().toUpperCase();
  const errEl = $("noteam-error");
  errEl.classList.add("hidden");
  if (code.length < 4) { errEl.textContent = "Bitte einen gültigen Code eingeben."; errEl.classList.remove("hidden"); return; }
  try {
    await joinTeam(code);
    toast("Willkommen im Team!");
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message || "Beitritt fehlgeschlagen.";
    errEl.classList.remove("hidden");
  }
});

// ---------------------------------------------------------
// Team-Daten live beobachten
// ---------------------------------------------------------
function cleanupTeam() {
  state.teamUnsubs.forEach(u => u());
  state.teamUnsubs = [];
  state.teamId = null;
  state.team = null;
  state.members = {};
  state.expenses = [];
  state.settlements = [];
  state.presets = [];
}

function attachTeam(teamId) {
  cleanupTeam();
  state.teamId = teamId;
  localStorage.setItem("kk-team", teamId);

  const base = doc(db, "teams", teamId);

  state.teamUnsubs.push(onSnapshot(base, (snap) => {
    if (!snap.exists()) {
      // Team wurde gelöscht -> aus eigener Liste entfernen
      updateDoc(doc(db, "users", state.user.uid), { teams: arrayRemove(teamId) }).catch(() => {});
      return;
    }
    state.team = snap.data();
    $("header-team-name").textContent = state.team.name;
    $("invite-code").textContent = teamId;
    renderAll();
  }));

  state.teamUnsubs.push(onSnapshot(collection(base, "members"), (snap) => {
    const m = {};
    snap.forEach(d => { m[d.id] = d.data(); });
    state.members = m;
    renderAll();
  }, err => console.error("members:", err)));

  state.teamUnsubs.push(onSnapshot(
    query(collection(base, "expenses"), orderBy("date", "desc")),
    { includeMetadataChanges: true },
    (snap) => {
      setPending("expenses", snap.metadata.hasPendingWrites);
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => b.date === a.date
        ? (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)
        : (b.date > a.date ? 1 : -1));
      state.expenses = list;
      renderAll();
    }, err => console.error("expenses:", err)));

  state.teamUnsubs.push(onSnapshot(
    collection(base, "settlements"),
    { includeMetadataChanges: true },
    (snap) => {
      setPending("settlements", snap.metadata.hasPendingWrites);
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      state.settlements = list;
      renderAll();
    }, err => console.error("settlements:", err)));

  state.teamUnsubs.push(onSnapshot(collection(base, "presets"), (snap) => {
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    state.presets = list;
    renderAll();
  }, err => console.error("presets:", err)));
}

// ---------------------------------------------------------
// Rendering
// ---------------------------------------------------------
function renderAll() {
  if (!state.teamId) return;
  state.balances = computeBalances(state.expenses, state.settlements);
  renderDashboard();
  renderExpenses();
  renderSettle();
  renderTeam();
  renderSync();
}

function expenseSubline(e) {
  if (e.type === "adjustment") {
    return `Verrechnung · ${fmtDate(e.date)}`;
  }
  const n = Object.keys(e.shares || {}).length;
  return `${memberNameReal(e.paidBy)} · ${fmtDate(e.date)} · ${n} Person${n === 1 ? "" : "en"}`;
}

function expenseItemHTML(e) {
  return `
    <div class="list-item tappable" data-eid="${esc(e.id)}">
      <div class="item-icon">${icon(iconFor(e.title))}</div>
      <div class="item-main">
        <div class="item-title">${esc(e.title)}</div>
        <div class="item-sub">${esc(expenseSubline(e))}</div>
      </div>
      <div class="item-amount">${formatCents(Math.abs(e.amount))}</div>
    </div>`;
}

// ---------- Dashboard ----------
function renderDashboard() {
  const uid = state.user.uid;
  const my = state.balances[uid] || 0;
  const el = $("my-balance");
  el.textContent = (my > 0 ? "+" : "") + formatCents(my).replace("-", "−");
  el.classList.toggle("positive", my > 0);
  el.classList.toggle("negative", my < 0);
  $("my-balance-hint").textContent =
    my > 0 ? "Du bekommst noch Geld" : my < 0 ? "Du schuldest noch Geld" : "Alles ausgeglichen";

  // Offene Zahlungen, die auf MEINE Bestätigung warten
  const toConfirm = state.settlements.filter(s => s.status === "pending" && s.to === uid);
  $("pending-confirm-section").classList.toggle("hidden", toConfirm.length === 0);
  $("pending-confirm-list").innerHTML = toConfirm.map(s => `
    <div class="list-item">
      <div class="item-icon">${icon("banknote")}</div>
      <div class="item-main">
        <div class="item-title">${esc(memberNameReal(s.from))} hat dir ${formatCents(s.amount)} gezahlt</div>
        <div class="item-sub">Bestätige, sobald das Geld da ist</div>
      </div>
      <button class="btn btn-small btn-primary" data-confirm="${esc(s.id)}">Bestätigen</button>
    </div>`).join("");
  $("pending-confirm-list").querySelectorAll("[data-confirm]").forEach(b =>
    b.addEventListener("click", () => openConfirmSettleModal(b.dataset.confirm)));

  // Meine offenen Beträge (vereinfachte Schulden, die mich betreffen)
  const debts = simplifyDebts(state.balances).filter(d => d.from === uid || d.to === uid);
  const myPending = state.settlements.filter(s => s.status === "pending" && s.from === uid);
  let html = "";
  for (const d of debts) {
    if (d.from === uid) {
      const pend = myPending.find(p => p.to === d.to);
      html += `
        <div class="list-item">
          <div class="item-icon warn">${icon("send")}</div>
          <div class="item-main">
            <div class="item-title">Du → ${esc(memberNameReal(d.to))}</div>
            <div class="item-sub">${pend ? "Als bezahlt gemeldet – wartet auf Bestätigung" : "Offen"}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <span class="item-amount negative">${formatCents(d.amount)}</span>
            ${pend
              ? `<button class="btn btn-small btn-secondary" data-cancel="${esc(pend.id)}">Zurückziehen</button>`
              : `<button class="btn btn-small btn-primary" data-pay="${esc(d.to)}" data-amount="${d.amount}">Ich habe bezahlt</button>`}
          </div>
        </div>`;
    } else {
      html += `
        <div class="list-item">
          <div class="item-icon ok">${icon("receive")}</div>
          <div class="item-main">
            <div class="item-title">${esc(memberNameReal(d.from))} → Du</div>
            <div class="item-sub">Offen</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <span class="item-amount positive">${formatCents(d.amount)}</span>
            <button class="btn btn-small btn-secondary" data-received="${esc(d.from)}" data-amount="${d.amount}">Erhalten</button>
          </div>
        </div>`;
    }
  }
  $("my-debts-list").innerHTML = html || `<div class="empty-note">Nichts offen – alles ausgeglichen.</div>`;
  $("my-debts-list").querySelectorAll("[data-pay]").forEach(b =>
    b.addEventListener("click", () => openSettleModal("pay", b.dataset.pay, parseInt(b.dataset.amount, 10))));
  $("my-debts-list").querySelectorAll("[data-received]").forEach(b =>
    b.addEventListener("click", () => openSettleModal("received", b.dataset.received, parseInt(b.dataset.amount, 10))));
  $("my-debts-list").querySelectorAll("[data-cancel]").forEach(b =>
    b.addEventListener("click", async () => {
      await deleteDoc(doc(db, "teams", state.teamId, "settlements", b.dataset.cancel));
      toast("Meldung zurückgezogen.");
    }));

  const recent = state.expenses.filter(e => e.type !== "adjustment").slice(0, 5);
  $("recent-expenses").innerHTML = recent.length
    ? recent.map(expenseItemHTML).join("")
    : `<div class="empty-note">Noch keine Ausgaben. Tippe auf +, um die erste einzutragen.</div>`;
  $("recent-expenses").querySelectorAll("[data-eid]").forEach(el2 =>
    el2.addEventListener("click", () => openExpenseModal(el2.dataset.eid)));

  renderExpenseChart();
  renderBalanceChart();
  renderStats();
}

// ---------- Diagramme ----------
const chartCfg = Object.assign(
  { dim: "person", period: "90" },
  JSON.parse(localStorage.getItem("kk-chart") || "{}"));

function periodStartDate(period) {
  if (period === "all") return "0000-00-00";
  const d = new Date();
  d.setDate(d.getDate() - parseInt(period, 10));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

$("chart-dim").value = chartCfg.dim;
$("chart-period").value = chartCfg.period;
for (const id of ["chart-dim", "chart-period"]) {
  $(id).addEventListener("change", () => {
    chartCfg.dim = $("chart-dim").value;
    chartCfg.period = $("chart-period").value;
    localStorage.setItem("kk-chart", JSON.stringify(chartCfg));
    renderExpenseChart();
  });
}

function renderExpenseChart() {
  const from = periodStartDate(chartCfg.period);
  const exps = state.expenses.filter(e => e.type !== "adjustment" && e.date >= from);
  const groups = new Map();
  for (const e of exps) {
    let key, label;
    if (chartCfg.dim === "person") {
      key = e.paidBy; label = memberNameReal(e.paidBy);
    } else if (chartCfg.dim === "cat") {
      const c = categoryFor(e.title); key = c.key; label = c.label;
    } else {
      key = e.date.slice(0, 7); label = `${e.date.slice(5, 7)}/${e.date.slice(0, 4)}`;
    }
    const g = groups.get(key) || { label, sum: 0 };
    g.sum += e.amount;
    groups.set(key, g);
  }
  let rows = [...groups.entries()];
  rows = chartCfg.dim === "month"
    ? rows.sort((a, b) => a[0].localeCompare(b[0]))
    : rows.sort((a, b) => b[1].sum - a[1].sum);
  if (!rows.length) {
    $("chart-expenses").innerHTML = `<div class="empty-note">Keine Ausgaben im gewählten Zeitraum.</div>`;
    return;
  }
  const max = Math.max(...rows.map(([, g]) => g.sum));
  $("chart-expenses").innerHTML = rows.map(([, g]) => `
    <div class="bar-row" title="${esc(g.label)}: ${formatCents(g.sum)}">
      <div class="bar-label">${esc(g.label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(2, Math.round(g.sum / max * 100))}%"></div>
        <span class="bar-val">${formatCents(g.sum)}</span>
      </div>
    </div>`).join("");
}

function renderBalanceChart() {
  const rows = Object.entries(state.balances)
    .filter(([uid, b]) => state.members[uid]?.active !== false || b !== 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    $("chart-balances").innerHTML = `<div class="empty-note">Noch keine Daten.</div>`;
    return;
  }
  const max = Math.max(1, ...rows.map(([, b]) => Math.abs(b)));
  $("chart-balances").innerHTML = rows.map(([uid, b]) => {
    const w = Math.max(2, Math.round(Math.abs(b) / max * 100));
    const val = (b > 0 ? "+" : b < 0 ? "−" : "") + formatCents(Math.abs(b));
    return `
      <div class="dbar-row" title="${esc(memberNameReal(uid))}: ${val}">
        <div class="dbar-label">${esc(memberNameReal(uid))}</div>
        <div class="dbar-neg">${b < 0 ? `<span class="bar-val">${val}</span><div class="dbar-fill" style="width:${w}%"></div>` : ""}</div>
        <div class="dbar-axis"></div>
        <div class="dbar-pos">${b > 0 ? `<div class="dbar-fill" style="width:${w}%"></div><span class="bar-val">${val}</span>` : b === 0 ? `<span class="bar-val muted">0,00 €</span>` : ""}</div>
      </div>`;
  }).join("");
}

// ---------- Statistiken (für den Besitzer konfigurierbar) ----------
const STAT_TILES = {
  total: "Gesamtausgaben",
  avgMonth: "Ø pro Monat",
  avgExpense: "Ø pro Ausgabe",
  count: "Anzahl Ausgaben"
};
const DEFAULT_STATS = { period: "all", tiles: ["total", "avgMonth", "avgExpense"], cats: ["kaffee", "milch"] };
function statsCfg() {
  return Object.assign({}, DEFAULT_STATS, state.team?.statsConfig || {});
}
const PERIOD_LABEL = { 30: "30 Tage", 90: "90 Tage", 365: "1 Jahr", all: "gesamt" };

function renderStats() {
  $("btn-stats-config").classList.toggle("hidden", !isOwner());
  const cfg = statsCfg();
  const from = periodStartDate(cfg.period);
  const exps = state.expenses.filter(e => e.type !== "adjustment" && e.date >= from);
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const months = new Set(exps.map(e => e.date.slice(0, 7))).size || 1;
  const pl = PERIOD_LABEL[cfg.period] || "gesamt";

  const tiles = [];
  const tileValue = {
    total: formatCents(total),
    avgMonth: formatCents(Math.round(total / months)),
    avgExpense: formatCents(exps.length ? Math.round(total / exps.length) : 0),
    count: String(exps.length)
  };
  for (const key of cfg.tiles || []) {
    if (STAT_TILES[key]) tiles.push({ label: `${STAT_TILES[key]} (${pl})`, value: tileValue[key] });
  }
  for (const catKey of cfg.cats || []) {
    const c = CATEGORIES.find(x => x.key === catKey) || CAT_OTHER;
    const sum = exps.filter(e => categoryFor(e.title).key === c.key).reduce((s, e) => s + e.amount, 0);
    tiles.push({ label: `${c.label} (${pl})`, value: formatCents(sum) });
  }
  $("stats-grid").innerHTML = tiles.length
    ? tiles.map(t => `
      <div class="stat-tile">
        <div class="stat-label">${esc(t.label)}</div>
        <div class="stat-value">${esc(t.value)}</div>
      </div>`).join("")
    : `<div class="empty-note" style="grid-column:1/-1">Keine Statistiken ausgewählt.</div>`;
}

$("btn-stats-config").addEventListener("click", () => {
  if (!isOwner()) return;
  const cfg = statsCfg();
  openModal(`
    <h3 class="modal-title">Statistiken anpassen</h3>
    <div class="stack">
      <div class="field">
        <label>Zeitraum</label>
        <select id="sc-period">
          ${Object.entries(PERIOD_LABEL).map(([k, v]) =>
            `<option value="${k}" ${cfg.period === k ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Kennzahlen</label>
        ${Object.entries(STAT_TILES).map(([k, v]) => `
          <div class="participant-row">
            <input type="checkbox" id="sc-t-${k}" ${cfg.tiles?.includes(k) ? "checked" : ""}>
            <label for="sc-t-${k}">${v}</label>
          </div>`).join("")}
      </div>
      <div class="field">
        <label>Kategorien (Summe im Zeitraum)</label>
        ${[...CATEGORIES, CAT_OTHER].map(c => `
          <div class="participant-row">
            <input type="checkbox" id="sc-c-${c.key}" ${cfg.cats?.includes(c.key) ? "checked" : ""}>
            <label for="sc-c-${c.key}">${c.label}</label>
          </div>`).join("")}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="sc-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="sc-save">Speichern</button>
    </div>`);
  $("sc-cancel").addEventListener("click", closeModal);
  $("sc-save").addEventListener("click", async () => {
    const newCfg = {
      period: $("sc-period").value,
      tiles: Object.keys(STAT_TILES).filter(k => $(`sc-t-${k}`).checked),
      cats: [...CATEGORIES, CAT_OTHER].map(c => c.key).filter(k => $(`sc-c-${k}`).checked)
    };
    await updateDoc(doc(db, "teams", state.teamId), { statsConfig: newCfg });
    closeModal();
    toast("Statistiken gespeichert.");
  });
});

// ---------- Ausgaben ----------
function renderExpenses() {
  const list = state.expenses;
  $("expense-list").innerHTML = list.length
    ? list.map(expenseItemHTML).join("")
    : `<div class="empty-note">Noch keine Ausgaben vorhanden.</div>`;
  $("expense-list").querySelectorAll("[data-eid]").forEach(el =>
    el.addEventListener("click", () => openExpenseModal(el.dataset.eid)));
}

// ---------- Ausgleich ----------
function renderSettle() {
  const uid = state.user.uid;
  const debts = simplifyDebts(state.balances);
  $("settle-suggestions").innerHTML = debts.length
    ? debts.map(d => `
      <div class="list-item">
        <div class="item-icon">${d.from === uid || d.to === uid ? icon("star") : icon("swap")}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberName(d.from))} → ${esc(memberName(d.to))}</div>
        </div>
        <span class="item-amount">${formatCents(d.amount)}</span>
      </div>`).join("")
    : `<div class="empty-note">Alle Salden sind ausgeglichen.</div>`;

  const rows = Object.entries(state.balances)
    .filter(([mUid, b]) => b !== 0 || state.members[mUid]?.active !== false)
    .sort((a, b) => b[1] - a[1]);
  $("settle-balances").innerHTML = rows.map(([mUid, b]) => {
    const m = state.members[mUid];
    const gone = m?.active === false;
    return `
      <div class="list-item">
        <div class="item-icon">${gone ? icon("personOut") : icon("person")}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberNameReal(mUid))}${gone ? " (entfernt)" : ""}</div>
        </div>
        <span class="item-amount ${b > 0 ? "positive" : b < 0 ? "negative" : ""}">${(b > 0 ? "+" : "")}${formatCents(b).replace("-", "−")}</span>
      </div>`;
  }).join("") || `<div class="empty-note">Keine Mitglieder.</div>`;

  const admin = isAdmin();
  const hist = state.settlements.slice(0, 50);
  $("settle-history").innerHTML = hist.length
    ? hist.map(s => `
      <div class="list-item ${admin ? "tappable" : ""}" data-sid="${esc(s.id)}">
        <div class="item-icon ${s.status === "confirmed" ? "ok" : "warn"}">${icon(s.status === "confirmed" ? "check" : "clock")}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberName(s.from))} → ${esc(memberName(s.to))}
            <span class="badge ${s.status === "confirmed" ? "badge-confirmed" : "badge-pending"}">
              ${s.status === "confirmed" ? "Ausgeglichen" : "Wartet auf Bestätigung"}</span>
          </div>
          <div class="item-sub">Gemeldet: ${esc(fmtDateTime(s.createdAt) || "–")}</div>
          ${s.status === "confirmed" ? `<div class="item-sub">Bestätigt: ${esc(fmtDateTime(s.confirmedAt) || "–")}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="item-amount">${formatCents(s.amount)}</span>
          ${s.status === "pending" && s.to === uid
            ? `<button class="btn btn-small btn-primary" data-confirm="${esc(s.id)}">Bestätigen</button>` : ""}
        </div>
      </div>`).join("")
    : `<div class="empty-note">Noch keine Ausgleichszahlungen.</div>`;
  $("settle-history").querySelectorAll("[data-confirm]").forEach(b =>
    b.addEventListener("click", (e) => { e.stopPropagation(); openConfirmSettleModal(b.dataset.confirm); }));
  if (admin) {
    $("settle-history").querySelectorAll("[data-sid]").forEach(el =>
      el.addEventListener("click", () => openSettlementAdminModal(el.dataset.sid)));
  }
}

// Admin/Benutzer: Ausgleichszahlung bearbeiten, löschen, rückgängig machen
function openSettlementAdminModal(id) {
  const s = state.settlements.find(x => x.id === id);
  if (!s || !isAdmin()) return;
  openModal(`
    <h3 class="modal-title">Zahlung bearbeiten</h3>
    <p class="muted small" style="margin-bottom:12px">
      ${esc(memberNameReal(s.from))} → ${esc(memberNameReal(s.to))}<br>
      Gemeldet: ${esc(fmtDateTime(s.createdAt) || "–")}
      ${s.confirmedAt ? `<br>Bestätigt: ${esc(fmtDateTime(s.confirmedAt))}` : ""}</p>
    <div class="stack">
      <div class="field">
        <label>Betrag (€)</label>
        <input type="text" id="sa-amount" inputmode="decimal" value="${(s.amount / 100).toFixed(2).replace(".", ",")}">
      </div>
      <div class="field">
        <label>Status</label>
        <select id="sa-status">
          <option value="pending" ${s.status === "pending" ? "selected" : ""}>Wartet auf Bestätigung</option>
          <option value="confirmed" ${s.status === "confirmed" ? "selected" : ""}>Ausgeglichen (bestätigt)</option>
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="sa-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="sa-save">Speichern</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="sa-delete">Zahlung löschen (rückgängig machen)</button>
    </div>`);
  wireMoneyInput($("sa-amount"));
  $("sa-cancel").addEventListener("click", closeModal);
  $("sa-save").addEventListener("click", async (e) => {
    const cents = parseEuro($("sa-amount").value);
    if (!cents || cents <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
    if (!lockOnce(e.currentTarget)) return;
    const status = $("sa-status").value;
    const updates = { amount: cents, status };
    if (status === "confirmed" && !s.confirmedAt) updates.confirmedAt = serverTimestamp();
    if (status === "pending") updates.confirmedAt = null;
    await updateDoc(doc(db, "teams", state.teamId, "settlements", id), updates);
    closeModal();
    toast("Zahlung aktualisiert.");
  });
  $("sa-delete").addEventListener("click", async () => {
    if (!confirm("Diese Zahlung wirklich löschen? Die Beträge gelten dann wieder als offen.")) return;
    await deleteDoc(doc(db, "teams", state.teamId, "settlements", id));
    closeModal();
    toast("Zahlung gelöscht.");
  });
}

const confirmingIds = new Set();
// Bestätigungs-Dialog: Empfänger prüft die gemeldete Zahlung, kann den
// tatsächlich erhaltenen Betrag anpassen (z. B. 6,25 € gemeldet, aber
// 10 € bar erhalten – oder eine Teil-/Anzahlung) und bestätigt dann.
function openConfirmSettleModal(id) {
  const s = state.settlements.find(x => x.id === id);
  if (!s || s.status !== "pending" || s.to !== state.user.uid) return;
  const owed = debtBetween(s.from, s.to); // was der Zahler dir aktuell schuldet
  openModal(`
    <h3 class="modal-title">Zahlung bestätigen</h3>
    <p class="muted small" style="margin-bottom:12px">
      ${esc(memberNameReal(s.from))} hat gemeldet, dir <b>${formatCents(s.amount)}</b> gezahlt zu haben.
      Passe den Betrag an, falls du etwas anderes erhalten hast, und bestätige,
      sobald das Geld da ist.</p>
    <div class="stack">
      <div class="field">
        <label>Tatsächlich erhalten (€)</label>
        <input type="text" id="cs-amount" inputmode="decimal" value="${(s.amount / 100).toFixed(2).replace(".", ",")}">
      </div>
      <p class="muted small" id="cs-hint" style="display:none"></p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="cs-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="cs-ok">Erhalt bestätigen</button>
    </div>`);
  wireMoneyInput($("cs-amount"));
  const refreshHint = () => {
    const cents = parseEuro($("cs-amount").value) || 0;
    const el = $("cs-hint");
    if (cents <= 0 || owed <= 0) { el.style.display = "none"; return; }
    if (cents > owed) {
      el.style.display = "";
      el.textContent = `${formatCents(cents - owed)} mehr als offen – das wird `
        + `${memberNameReal(s.from)} als Guthaben bei dir gutgeschrieben (du schuldest es zurück).`;
    } else if (cents < owed) {
      el.style.display = "";
      el.textContent = `Teilzahlung – ${memberNameReal(s.from)} schuldet dir danach noch ${formatCents(owed - cents)}.`;
    } else {
      el.style.display = "none";
    }
  };
  $("cs-amount").addEventListener("input", refreshHint);
  refreshHint();
  $("cs-cancel").addEventListener("click", closeModal);
  $("cs-ok").addEventListener("click", (e) => {
    const cents = parseEuro($("cs-amount").value);
    if (!cents || cents <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
    if (!lockOnce(e.currentTarget)) return;
    confirmSettlement(id, cents);
    closeModal();
  });
}

function confirmSettlement(id, amount) {
  const s = state.settlements.find(x => x.id === id);
  // Schutz: nur offene Zahlungen, und jede nur ein einziges Mal
  if (!s || s.status !== "pending" || confirmingIds.has(id)) return;
  confirmingIds.add(id);
  setTimeout(() => confirmingIds.delete(id), 5000);
  const updates = { status: "confirmed", confirmedAt: serverTimestamp() };
  // Betrag nur mitschreiben, wenn der Empfänger ihn angepasst hat.
  if (typeof amount === "number" && amount > 0 && amount !== s.amount) updates.amount = amount;
  fireWrite(updateDoc(doc(db, "teams", state.teamId, "settlements", id), updates),
    "Bestätigen fehlgeschlagen.");
  toast("Zahlung bestätigt.");
}

// Ausgleich melden/bestätigen (mit anpassbarem Betrag)
function openSettleModal(kind, otherUid, suggested) {
  const title = kind === "pay"
    ? `Zahlung an ${memberNameReal(otherUid)} melden`
    : `Zahlung von ${memberNameReal(otherUid)} erhalten`;
  openModal(`
    <h3 class="modal-title">${esc(title)}</h3>
    <div class="stack">
      <div class="field">
        <label>Betrag (€)</label>
        <input type="text" id="settle-amount" inputmode="decimal" value="${(suggested / 100).toFixed(2).replace(".", ",")}">
      </div>
      <p class="muted small" id="settle-extra-hint" style="display:none"></p>
      <p class="muted small">${kind === "pay"
        ? "Der Empfänger muss die Zahlung anschließend bestätigen – erst dann gilt sie als ausgeglichen."
        : "Damit bestätigst du, dass du das Geld bereits erhalten hast."}</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="settle-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="settle-ok">${kind === "pay" ? "Als bezahlt melden" : "Erhalt bestätigen"}</button>
    </div>`);
  wireMoneyInput($("settle-amount"));
  // Guthaben-Hinweis bei Überzahlung. Wer zu viel zahlt, bekommt die
  // Differenz als Guthaben bei genau der anderen Person gutgeschrieben.
  const refreshExtraHint = () => {
    const cents = parseEuro($("settle-amount").value) || 0;
    const extra = cents - suggested;
    const el = $("settle-extra-hint");
    if (cents <= 0 || suggested <= 0) { el.style.display = "none"; return; }
    if (extra > 0) {
      // Überzahlung -> Guthaben bei genau der anderen Person
      el.style.display = "";
      el.textContent = kind === "pay"
        ? `${formatCents(extra)} mehr als offen – das wird dir als Guthaben bei `
          + `${memberNameReal(otherUid)} gutgeschrieben (${memberNameReal(otherUid)} schuldet es dir zurück).`
        : `${formatCents(extra)} mehr als offen – das wird ${memberNameReal(otherUid)} als Guthaben `
          + `bei dir gutgeschrieben (du schuldest es zurück).`;
    } else if (extra < 0) {
      // Teilzahlung / Anzahlung -> Rest bleibt offen
      el.style.display = "";
      el.textContent = kind === "pay"
        ? `Teilzahlung – du schuldest ${memberNameReal(otherUid)} danach noch ${formatCents(-extra)}.`
        : `Teilzahlung – ${memberNameReal(otherUid)} schuldet dir danach noch ${formatCents(-extra)}.`;
    } else {
      el.style.display = "none";
    }
  };
  $("settle-amount").addEventListener("input", refreshExtraHint);
  refreshExtraHint();
  $("settle-cancel").addEventListener("click", closeModal);
  $("settle-ok").addEventListener("click", (e) => {
    const cents = parseEuro($("settle-amount").value);
    if (!cents || cents <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
    const uid = state.user.uid;
    // Schutz 1: Button sperrt sich sofort (kein Mehrfach-Klick möglich)
    if (!lockOnce(e.currentTarget)) return;
    // Schutz 2: Gibt es bereits eine offene Meldung an diese Person,
    // wird KEINE zweite erzeugt.
    if (kind === "pay" && state.settlements.some(s =>
        s.status === "pending" && s.from === uid && s.to === otherUid)) {
      closeModal();
      toast("Es gibt bereits eine offene Meldung an diese Person.");
      return;
    }
    const data = kind === "pay"
      ? { from: uid, to: otherUid, amount: cents, status: "pending", createdBy: uid, createdAt: serverTimestamp() }
      : { from: otherUid, to: uid, amount: cents, status: "confirmed", createdBy: uid, createdAt: serverTimestamp(), confirmedAt: serverTimestamp() };
    // Schutz 3: nicht auf den Server warten – die Änderung ist lokal
    // sofort da und wird im Hintergrund synchronisiert. So gibt es
    // kein "Hängen", während dessen man mehrfach drücken könnte.
    fireWrite(addDoc(collection(db, "teams", state.teamId, "settlements"), data), "Melden fehlgeschlagen.");
    closeModal();
    toast(kind === "pay" ? "Gemeldet – wartet auf Bestätigung." : "Zahlung verbucht.");
  });
}

// Wie viel schuldet `from` aktuell an `to`? (aus den vorgeschlagenen
// Zahlungen abgeleitet). Positiv = from schuldet to, negativ = to schuldet from.
function debtBetween(from, to) {
  const debts = simplifyDebts(state.balances);
  const d = debts.find(x => x.from === from && x.to === to);
  if (d) return d.amount;
  const r = debts.find(x => x.from === to && x.to === from);
  if (r) return -r.amount;
  return 0;
}

// Zahlung zwischen zwei Personen erfassen. Admins dürfen beliebige
// Paare erfassen (sofort ausgeglichen). Normale Nutzer nur eigene
// Zahlungen (als Zahler melden oder als Empfänger bestätigen) –
// passend zu den Firestore-Regeln.
function openRecordPaymentModal() {
  const admin = isAdmin();
  const me = state.user.uid;
  const members = activeMembers();
  if (members.length < 2) { toast("Dafür braucht es mindestens zwei aktive Mitglieder."); return; }

  const defFrom = admin ? members[0].uid : me;
  const defTo = admin
    ? (members.find(m => m.uid !== defFrom)?.uid || members[1].uid)
    : (members.find(m => m.uid !== me)?.uid || members[0].uid);
  const optionsFor = (sel) => members
    .map(m => `<option value="${esc(m.uid)}" ${m.uid === sel ? "selected" : ""}>${esc(m.name)}</option>`)
    .join("");

  openModal(`
    <h3 class="modal-title">Zahlung erfassen</h3>
    <p class="muted small" style="margin-bottom:12px">Wer hat wem Geld gegeben? Der Betrag wird
      direkt zwischen genau diesen beiden Personen verrechnet.</p>
    <div class="stack">
      <div class="field">
        <label>Von (zahlt)</label>
        <select id="rp-from">${optionsFor(defFrom)}</select>
      </div>
      <div class="field">
        <label>An (bekommt)</label>
        <select id="rp-to">${optionsFor(defTo)}</select>
      </div>
      <div class="field">
        <label>Betrag (€)</label>
        <input type="text" id="rp-amount" inputmode="decimal" placeholder="0,00">
      </div>
      <p class="muted small" id="rp-hint"></p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="rp-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="rp-ok">Erfassen</button>
    </div>`);

  wireMoneyInput($("rp-amount"));
  $("rp-cancel").addEventListener("click", closeModal);

  const refreshHint = () => {
    const from = $("rp-from").value, to = $("rp-to").value;
    const cents = parseEuro($("rp-amount").value) || 0;
    const el = $("rp-hint");
    if (from === to) { el.textContent = "Bitte zwei verschiedene Personen wählen."; return; }
    const owed = debtBetween(from, to); // >0: from schuldet to
    if (cents <= 0) {
      el.textContent = owed > 0
        ? `Offen: ${memberNameReal(from)} schuldet ${memberNameReal(to)} noch ${formatCents(owed)}.`
        : owed < 0
          ? `Hinweis: Aktuell schuldet eher ${memberNameReal(to)} an ${memberNameReal(from)} (${formatCents(-owed)}).`
          : `Zwischen den beiden ist aktuell nichts offen.`;
      return;
    }
    const base = Math.max(owed, 0);
    if (cents > base) {
      const extra = cents - base;
      el.textContent = `${formatCents(extra)} mehr als offen – das wird `
        + `${memberNameReal(from)} als Guthaben bei ${memberNameReal(to)} gutgeschrieben `
        + `(${memberNameReal(to)} schuldet den Betrag dann zurück).`;
    } else {
      el.textContent = `Verbleibt offen: ${formatCents(base - cents)}.`;
    }
  };
  ["rp-from", "rp-to", "rp-amount"].forEach(id => {
    $(id).addEventListener("input", refreshHint);
    $(id).addEventListener("change", refreshHint);
  });
  refreshHint();

  $("rp-ok").addEventListener("click", (e) => {
    const from = $("rp-from").value, to = $("rp-to").value;
    const cents = parseEuro($("rp-amount").value);
    if (from === to) { toast("Bitte zwei verschiedene Personen wählen."); return; }
    if (!cents || cents <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
    // Status passend zu den Berechtigungen bestimmen.
    let status;
    if (admin) status = "confirmed";
    else if (from === me) status = "pending";
    else if (to === me) status = "confirmed";
    else { toast("Nur Admins können Zahlungen zwischen anderen Personen erfassen."); return; }
    if (!lockOnce(e.currentTarget)) return;
    const data = { from, to, amount: cents, status, createdBy: me, createdAt: serverTimestamp() };
    if (status === "confirmed") data.confirmedAt = serverTimestamp();
    fireWrite(addDoc(collection(db, "teams", state.teamId, "settlements"), data), "Erfassen fehlgeschlagen.");
    closeModal();
    toast(status === "confirmed" ? "Zahlung verbucht." : "Gemeldet – wartet auf Bestätigung.");
  });
}

// ---------- Team ----------
function renderTeam() {
  const admin = isAdmin();
  $("btn-add-preset").classList.toggle("hidden", !admin);
  $("btn-delete-team").classList.toggle("hidden", !isOwner());

  const members = Object.entries(state.members)
    .map(([uid, m]) => ({ uid, ...m }))
    .sort((a, b) => (a.active === false ? 1 : 0) - (b.active === false ? 1 : 0)
      || (a.name || "").localeCompare(b.name || ""));

  $("member-list").innerHTML = members.map(m => {
    const bal = state.balances[m.uid] || 0;
    const inactive = m.active === false;
    return `
      <div class="list-item ${admin || m.uid === state.user.uid ? "tappable" : ""}" data-member="${esc(m.uid)}">
        <div class="item-icon">${inactive ? icon("personOut") : icon("person")}</div>
        <div class="item-main">
          <div class="item-title">${esc(m.name)}${m.uid === state.user.uid ? " (du)" : ""}
            <span class="badge ${ROLE_BADGE[m.role] || "badge-user"}">${ROLE_LABEL[m.role] || m.role}</span>
            ${inactive ? '<span class="badge badge-user">Entfernt</span>' : ""}
          </div>
          <div class="item-sub">Dabei seit ${fmtDate(m.startDate)}</div>
        </div>
        <span class="item-amount ${bal > 0 ? "positive" : bal < 0 ? "negative" : ""}">${(bal > 0 ? "+" : "")}${formatCents(bal).replace("-", "−")}</span>
      </div>`;
  }).join("");
  $("member-list").querySelectorAll("[data-member]").forEach(el => {
    const uid = el.dataset.member;
    if (isAdmin() || uid === state.user.uid) {
      el.addEventListener("click", () => openMemberModal(uid));
    }
  });

  $("preset-list").innerHTML = state.presets.length
    ? state.presets.map(p => {
      const names = Object.keys(p.shares || {}).map(memberNameReal).join(", ");
      return `
        <div class="list-item ${admin ? "tappable" : ""}" data-preset="${esc(p.id)}">
          <div class="item-icon">${icon("people")}</div>
          <div class="item-main">
            <div class="item-title">${esc(p.name)}</div>
            <div class="item-sub">${esc(names)}</div>
          </div>
        </div>`;
    }).join("")
    : `<div class="empty-note">Noch keine Gruppen angelegt.</div>`;
  if (admin) {
    $("preset-list").querySelectorAll("[data-preset]").forEach(el =>
      el.addEventListener("click", () => openPresetModal(el.dataset.preset)));
  }
}

$("btn-copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.teamId);
    toast("Code kopiert.");
  } catch {
    toast("Code: " + state.teamId);
  }
});

// ---------------------------------------------------------
// Beteiligten-Auswahl (für Ausgaben & Presets & Verrechnung)
// ---------------------------------------------------------
function participantPickerHTML(pickId, preselected, customPct, excludeUid) {
  const members = activeMembers().filter(m => m.uid !== excludeUid);
  const presetChips = state.presets.length && !excludeUid
    ? `<div class="chip-row">
        <button type="button" class="chip" data-chip="__all">Alle</button>
        ${state.presets.map(p => `<button type="button" class="chip" data-chip="${esc(p.id)}">${esc(p.name)}</button>`).join("")}
      </div>` : "";
  return `
    ${presetChips}
    <div id="${pickId}">
      ${members.map(m => {
        // Neue Mitglieder sind erst ab ihrem Startdatum vorausgewählt
        const sel = preselected
          ? preselected[m.uid] !== undefined
          : (!m.startDate || m.startDate <= todayStr());
        const pct = preselected && preselected[m.uid] !== undefined ? preselected[m.uid] : "";
        return `
          <div class="participant-row">
            <input type="checkbox" id="${pickId}-${m.uid}" data-uid="${esc(m.uid)}" ${sel ? "checked" : ""}>
            <label for="${pickId}-${m.uid}">${esc(m.name)}</label>
            <input type="number" class="pct-input ${customPct ? "" : "hidden"}" data-pct="${esc(m.uid)}"
              min="0" max="100" step="0.01" value="${pct}" placeholder="%">
          </div>`;
      }).join("")}
    </div>
    <div class="participant-row" style="border:0">
      <input type="checkbox" id="${pickId}-custom" ${customPct ? "checked" : ""}>
      <label for="${pickId}-custom">Anteile in % anpassen</label>
    </div>
    <p class="pct-sum hidden" id="${pickId}-sum"></p>`;
}

function wirePicker(pickId) {
  const root = $(pickId).parentElement;
  const customToggle = $(`${pickId}-custom`);
  const sumEl = $(`${pickId}-sum`);

  function selectedUids() {
    return [...$(pickId).querySelectorAll("input[type=checkbox]:checked")].map(c => c.dataset.uid);
  }
  function refresh() {
    const custom = customToggle.checked;
    $(pickId).querySelectorAll(".pct-input").forEach(inp => {
      const checked = $(`${pickId}-${inp.dataset.pct}`).checked;
      inp.classList.toggle("hidden", !custom || !checked);
    });
    sumEl.classList.toggle("hidden", !custom);
    if (custom) {
      const uids = selectedUids();
      // leere Felder gleichmäßig vorbelegen
      const empty = uids.filter(u => !$(pickId).querySelector(`[data-pct="${u}"]`).value);
      if (empty.length === uids.length && uids.length) {
        const eq = equalPercents(uids);
        uids.forEach(u => { $(pickId).querySelector(`[data-pct="${u}"]`).value = eq[u]; });
      }
      updateSum();
    }
  }
  function updateSum() {
    const uids = selectedUids();
    let sum = 0;
    uids.forEach(u => { sum += parseFloat($(pickId).querySelector(`[data-pct="${u}"]`).value || "0"); });
    sum = Math.round(sum * 100) / 100;
    sumEl.textContent = `Summe: ${sum} %` + (Math.abs(sum - 100) < 0.01 ? " – passt" : " (muss 100 % sein)");
    sumEl.classList.toggle("ok", Math.abs(sum - 100) < 0.01);
    sumEl.classList.toggle("bad", Math.abs(sum - 100) >= 0.01);
  }

  customToggle.addEventListener("change", refresh);
  $(pickId).querySelectorAll("input[type=checkbox]").forEach(c =>
    c.addEventListener("change", () => {
      if (customToggle.checked) {
        const uids = selectedUids();
        const eq = uids.length ? equalPercents(uids) : {};
        $(pickId).querySelectorAll(".pct-input").forEach(inp => {
          inp.value = eq[inp.dataset.pct] !== undefined ? eq[inp.dataset.pct] : "";
        });
      }
      refresh();
    }));
  $(pickId).querySelectorAll(".pct-input").forEach(inp =>
    inp.addEventListener("input", updateSum));

  root.querySelectorAll("[data-chip]").forEach(chip =>
    chip.addEventListener("click", () => {
      const id = chip.dataset.chip;
      let shares = null;
      if (id !== "__all") {
        const p = state.presets.find(x => x.id === id);
        shares = p?.shares || {};
      }
      $(pickId).querySelectorAll("input[type=checkbox]").forEach(c => {
        c.checked = shares ? shares[c.dataset.uid] !== undefined : true;
      });
      if (shares && Object.values(shares).some(v => v !== null)) {
        customToggle.checked = true;
        $(pickId).querySelectorAll(".pct-input").forEach(inp => {
          inp.value = shares[inp.dataset.pct] !== undefined ? shares[inp.dataset.pct] : "";
        });
      } else if (!shares) {
        customToggle.checked = false;
      }
      refresh();
    }));

  refresh();
  return {
    // liefert {uid: prozent} oder null bei Fehler
    getShares() {
      const uids = selectedUids();
      if (!uids.length) { toast("Bitte mindestens eine Person auswählen."); return null; }
      if (!customToggle.checked) return equalPercents(uids);
      const shares = {};
      let sum = 0;
      for (const u of uids) {
        const v = parseFloat($(pickId).querySelector(`[data-pct="${u}"]`).value || "0");
        if (!(v >= 0)) { toast("Ungültiger Prozentwert."); return null; }
        shares[u] = Math.round(v * 100) / 100;
        sum += shares[u];
      }
      if (Math.abs(Math.round(sum * 100) / 100 - 100) >= 0.01) {
        toast("Die Prozente müssen zusammen 100 % ergeben.");
        return null;
      }
      return shares;
    }
  };
}

// ---------------------------------------------------------
// Export (Excel / PDF, optional mit Zeitbereich)
// ---------------------------------------------------------
$("btn-export").addEventListener("click", () => {
  openModal(`
    <h3 class="modal-title">Export</h3>
    <p class="muted small" style="margin-bottom:12px">Exportiert Ausgaben, Zahlungsverlauf
      und aktuelle Salden. Zeitraum leer lassen = alles.</p>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1">
        <label>Von (optional)</label>
        <input type="date" id="ex-from">
      </div>
      <div class="field" style="flex:1">
        <label>Bis (optional)</label>
        <input type="date" id="ex-to">
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="ex-xlsx">${icon("table", 17)} Excel</button>
      <button class="btn btn-primary" id="ex-pdf">${icon("download", 17)} PDF</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ex-cancel">Abbrechen</button>
    </div>`);
  $("ex-cancel").addEventListener("click", closeModal);
  $("ex-xlsx").addEventListener("click", () => runExport("xlsx"));
  $("ex-pdf").addEventListener("click", () => runExport("pdf"));
});

function buildExportData(from, to) {
  const inRange = (d) => d && (!from || d >= from) && (!to || d <= to);
  const isoOfTs = (ts) => ts?.seconds ? new Date(ts.seconds * 1000).toISOString().slice(0, 10) : "";
  const euro = (cents) => Math.round(cents) / 100;

  const exps = state.expenses.filter(e => inRange(e.date)).slice().reverse();
  const expRows = [["Datum", "Was", "Kategorie", "Bezahlt von", "Betrag (€)", "Beteiligte"]];
  for (const e of exps) {
    if (e.type === "adjustment") {
      expRows.push([fmtDate(e.date), e.title, "Verrechnung", "—", euro(e.amount),
        Object.entries(e.shares).map(([u2, p]) => `${memberNameReal(u2)} ${p}%`).join(", ")]);
    } else {
      expRows.push([fmtDate(e.date), e.title, categoryFor(e.title).label,
        memberNameReal(e.paidBy), euro(e.amount),
        Object.entries(e.shares).map(([u2, p]) => `${memberNameReal(u2)} ${p}%`).join(", ")]);
    }
  }

  const setts = state.settlements
    .filter(s => { const d = isoOfTs(s.createdAt); return !d || inRange(d) || (!from && !to); })
    .slice().reverse();
  const settRows = [["Von", "An", "Betrag (€)", "Status", "Gemeldet am", "Bestätigt am"]];
  for (const s of setts) {
    settRows.push([memberNameReal(s.from), memberNameReal(s.to), euro(s.amount),
      s.status === "confirmed" ? "Ausgeglichen" : "Offen",
      fmtDateTime(s.createdAt) || "–", fmtDateTime(s.confirmedAt) || "–"]);
  }

  const balRows = [["Name", "Saldo (€)"]];
  const bals = Object.entries(state.balances)
    .filter(([uid2, b]) => state.members[uid2]?.active !== false || b !== 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [uid2, b] of bals) balRows.push([memberNameReal(uid2), euro(b)]);

  return { expRows, settRows, balRows };
}

function runExport(format) {
  const from = $("ex-from").value || null;
  const to = $("ex-to").value || null;
  const { expRows, settRows, balRows } = buildExportData(from, to);
  const teamName = state.team?.name || "Team";
  const range = from || to ? `${from ? fmtDate(from) : "Anfang"} – ${to ? fmtDate(to) : "heute"}` : "gesamter Zeitraum";
  const stamp = todayStr();
  try {
    if (format === "xlsx") {
      const blob = makeXlsx([
        { name: "Ausgaben", rows: expRows },
        { name: "Zahlungsverlauf", rows: settRows },
        { name: "Salden", rows: balRows }
      ]);
      download(blob, `Kaffeekasse_${stamp}.xlsx`);
    } else {
      const blob = makePdf(`Kaffeekasse – ${teamName}`,
        `Export vom ${fmtDate(stamp)} · Zeitraum: ${range}`, [
        { heading: "Ausgaben", headers: expRows[0], rows: expRows.slice(1).map(r => [r[0], r[1], r[2], r[3], r[4].toFixed(2).replace(".", ",") + " €", r[5]]), widths: [11, 20, 13, 13, 10, 26] },
        { heading: "Zahlungsverlauf", headers: settRows[0], rows: settRows.slice(1).map(r => [r[0], r[1], r[2].toFixed(2).replace(".", ",") + " €", r[3], r[4], r[5]]), widths: [14, 14, 10, 12, 18, 18] },
        { heading: "Aktuelle Salden", headers: balRows[0], rows: balRows.slice(1).map(r => [r[0], r[1].toFixed(2).replace(".", ",") + " €"]), widths: [30, 15] }
      ]);
      download(blob, `Kaffeekasse_${stamp}.pdf`);
    }
    closeModal();
    toast("Export erstellt.");
  } catch (err) {
    console.error(err);
    toast("Export fehlgeschlagen.");
  }
}

// ---------------------------------------------------------
// Ausgabe anlegen / bearbeiten
// ---------------------------------------------------------
$("btn-add-expense").addEventListener("click", () => openExpenseModal(null));
$("btn-record-payment").addEventListener("click", openRecordPaymentModal);

function openExpenseModal(expenseId) {
  const existing = expenseId ? state.expenses.find(e => e.id === expenseId) : null;
  if (existing && existing.type === "adjustment") {
    openAdjustmentInfoModal(existing);
    return;
  }
  const canEdit = !existing || isAdmin() || existing.createdBy === state.user.uid;
  const members = activeMembers();
  const customPct = existing
    ? Object.values(existing.shares).some((v, _, arr) => Math.abs(v - arr[0]) > 0.011)
    : false;

  openModal(`
    <h3 class="modal-title">${existing ? (canEdit ? "Ausgabe bearbeiten" : "Ausgabe") : "Neue Ausgabe"}</h3>
    <div class="stack">
      <div class="field">
        <label>Was wurde gekauft?</label>
        <input type="text" id="exp-title" placeholder="z. B. Kaffeebohnen" value="${esc(existing?.title || "")}" ${canEdit ? "" : "disabled"}>
      </div>
      <div style="display:flex;gap:10px">
        <div class="field" style="flex:1">
          <label>Betrag (€)</label>
          <input type="text" id="exp-amount" inputmode="decimal" placeholder="0,00"
            value="${existing ? (existing.amount / 100).toFixed(2).replace(".", ",") : ""}" ${canEdit ? "" : "disabled"}>
        </div>
        <div class="field" style="flex:1">
          <label>Datum</label>
          <input type="date" id="exp-date" value="${esc(existing?.date || todayStr())}" ${canEdit ? "" : "disabled"}>
        </div>
      </div>
      <div class="field">
        <label>Bezahlt von</label>
        <select id="exp-payer" ${canEdit ? "" : "disabled"}>
          ${members.map(m => `<option value="${esc(m.uid)}" ${(existing?.paidBy || state.user.uid) === m.uid ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Wer ist beteiligt?</label>
        ${participantPickerHTML("exp-pick", existing?.shares || null, customPct, null)}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="exp-cancel">${canEdit ? "Abbrechen" : "Schließen"}</button>
      ${canEdit ? `<button class="btn btn-primary" id="exp-save">Speichern</button>` : ""}
    </div>
    ${existing && canEdit ? `<div class="modal-actions"><button class="btn btn-danger" id="exp-delete">Ausgabe löschen</button></div>` : ""}
  `);

  const picker = wirePicker("exp-pick");
  wireMoneyInput($("exp-amount"));
  $("exp-cancel").addEventListener("click", closeModal);

  if (!canEdit) {
    $("modal-box").querySelectorAll("input, select, .chip").forEach(el => { el.disabled = true; });
  }

  if (canEdit) {
    $("exp-save").addEventListener("click", (e) => {
      const title = $("exp-title").value.trim();
      const amount = parseEuro($("exp-amount").value);
      const date = $("exp-date").value;
      const paidBy = $("exp-payer").value;
      if (!title) { toast("Bitte eintragen, was gekauft wurde."); return; }
      if (!amount || amount <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
      if (!date) { toast("Bitte ein Datum wählen."); return; }
      const shares = picker.getShares();
      if (!shares) return;
      if (!lockOnce(e.currentTarget)) return;

      const data = { type: "expense", title, amount, date, paidBy, shares };
      if (existing) {
        fireWrite(updateDoc(doc(db, "teams", state.teamId, "expenses", expenseId), data));
        toast("Ausgabe aktualisiert.");
      } else {
        fireWrite(addDoc(collection(db, "teams", state.teamId, "expenses"), {
          ...data, createdBy: state.user.uid, createdAt: serverTimestamp()
        }));
        toast("Ausgabe gespeichert.");
      }
      closeModal();
    });
  }
  if (existing && canEdit) {
    $("exp-delete").addEventListener("click", async () => {
      if (!confirm("Diese Ausgabe wirklich löschen?")) return;
      await deleteDoc(doc(db, "teams", state.teamId, "expenses", expenseId));
      closeModal();
      toast("Ausgabe gelöscht.");
    });
  }
}

function openAdjustmentInfoModal(e) {
  const names = Object.entries(e.shares).map(([u, p]) => `${memberNameReal(u)} (${p} %)`).join(", ");
  openModal(`
    <h3 class="modal-title">Verrechnung</h3>
    <p>${esc(e.title)}</p>
    <p class="muted small" style="margin-top:8px">
      Der Restsaldo von ${formatCents(Math.abs(e.amount))} von ${esc(memberNameReal(e.targetUid))}
      wurde übernommen von: ${esc(names)}.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="adj-close">Schließen</button>
      ${isAdmin() ? `<button class="btn btn-danger" id="adj-delete">Löschen</button>` : ""}
    </div>`);
  $("adj-close").addEventListener("click", closeModal);
  if (isAdmin()) {
    $("adj-delete").addEventListener("click", async () => {
      if (!confirm("Verrechnung wirklich löschen? Der Saldo des entfernten Mitglieds wird dadurch wiederhergestellt.")) return;
      await deleteDoc(doc(db, "teams", state.teamId, "expenses", e.id));
      closeModal();
    });
  }
}

// ---------------------------------------------------------
// Presets / Gruppen
// ---------------------------------------------------------
$("btn-add-preset").addEventListener("click", () => openPresetModal(null));

function openPresetModal(presetId) {
  const existing = presetId ? state.presets.find(p => p.id === presetId) : null;
  const customPct = existing
    ? Object.values(existing.shares).some((v, _, arr) => Math.abs(v - arr[0]) > 0.011)
    : false;
  openModal(`
    <h3 class="modal-title">${existing ? "Gruppe bearbeiten" : "Neue Gruppe"}</h3>
    <div class="stack">
      <div class="field">
        <label>Name der Gruppe</label>
        <input type="text" id="preset-name" placeholder='z. B. "Team Milch"' value="${esc(existing?.name || "")}">
      </div>
      <div class="field">
        <label>Wer gehört dazu?</label>
        ${participantPickerHTML("preset-pick", existing?.shares || null, customPct, null)}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="preset-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="preset-save">Speichern</button>
    </div>
    ${existing ? `<div class="modal-actions"><button class="btn btn-danger" id="preset-delete">Gruppe löschen</button></div>` : ""}
  `);
  const picker = wirePicker("preset-pick");
  $("preset-cancel").addEventListener("click", closeModal);
  $("preset-save").addEventListener("click", async (e) => {
    const name = $("preset-name").value.trim();
    if (!name) { toast("Bitte einen Namen eingeben."); return; }
    const shares = picker.getShares();
    if (!shares) return;
    if (!lockOnce(e.currentTarget)) return;
    if (existing) {
      await updateDoc(doc(db, "teams", state.teamId, "presets", presetId), { name, shares });
    } else {
      await addDoc(collection(db, "teams", state.teamId, "presets"), { name, shares });
    }
    closeModal();
    toast("Gruppe gespeichert.");
  });
  if (existing) {
    $("preset-delete").addEventListener("click", async () => {
      if (!confirm("Gruppe wirklich löschen?")) return;
      await deleteDoc(doc(db, "teams", state.teamId, "presets", presetId));
      closeModal();
    });
  }
}

// ---------------------------------------------------------
// Mitglied verwalten
// ---------------------------------------------------------
function openMemberModal(uid) {
  const m = state.members[uid];
  if (!m) return;
  const me = uid === state.user.uid;
  const admin = isAdmin();
  const owner = isOwner();
  const bal = state.balances[uid] || 0;
  const inactive = m.active === false;

  const canChangeRole = owner && !me && m.role !== "owner";
  const canEditStart = admin && !me || owner;
  const canRemove = (admin && !me && m.role !== "owner") || (owner && !me);

  openModal(`
    <h3 class="modal-title">${esc(m.name)} ${me ? "(du)" : ""}</h3>
    <div class="stack">
      <div class="list-item">
        <div class="item-main"><div class="item-sub">Saldo</div>
          <div class="item-title ${bal > 0 ? "positive" : bal < 0 ? "negative" : ""}">${(bal > 0 ? "+" : "")}${formatCents(bal).replace("-", "−")}</div>
        </div>
        <span class="badge ${ROLE_BADGE[m.role]}">${ROLE_LABEL[m.role]}</span>
      </div>
      ${me ? `
      <div class="field">
        <label>Dein Anzeigename</label>
        <input type="text" id="member-name" value="${esc(m.name)}">
      </div>` : ""}
      ${canChangeRole ? `
      <div class="field">
        <label>Rolle</label>
        <select id="member-role">
          <option value="user" ${m.role === "user" ? "selected" : ""}>User</option>
          <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </div>` : ""}
      ${canEditStart ? `
      <div class="field">
        <label>Dabei seit (frühere Ausgaben betreffen dieses Mitglied nicht)</label>
        <input type="date" id="member-start" value="${esc(m.startDate || todayStr())}">
      </div>` : ""}
      ${inactive && admin ? `<button class="btn btn-secondary" id="member-reactivate">Wieder aktivieren</button>` : ""}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="member-close">Schließen</button>
      ${(me || canChangeRole || canEditStart) ? `<button class="btn btn-primary" id="member-save">Speichern</button>` : ""}
    </div>
    ${canRemove && !inactive ? `<div class="modal-actions"><button class="btn btn-danger" id="member-remove">Mitglied entfernen</button></div>` : ""}
  `);

  $("member-close").addEventListener("click", closeModal);

  const saveBtn = $("member-save");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const updates = {};
    if (me) {
      const name = $("member-name").value.trim();
      if (name && name !== m.name) {
        updates.name = name;
        await updateDoc(doc(db, "users", state.user.uid), { name });
      }
    }
    if (canChangeRole) updates.role = $("member-role").value;
    if (canEditStart && $("member-start")) updates.startDate = $("member-start").value;
    if (Object.keys(updates).length) {
      await updateDoc(doc(db, "teams", state.teamId, "members", uid), updates);
      toast("Gespeichert.");
    }
    closeModal();
  });

  const reactBtn = $("member-reactivate");
  if (reactBtn) reactBtn.addEventListener("click", async () => {
    await updateDoc(doc(db, "teams", state.teamId, "members", uid), { active: true });
    closeModal();
    toast(`${m.name} ist wieder aktiv.`);
  });

  const removeBtn = $("member-remove");
  if (removeBtn) removeBtn.addEventListener("click", () => openRemoveMemberModal(uid));
}

// Mitglied entfernen – ggf. Restsaldo auf andere verteilen
function openRemoveMemberModal(uid) {
  const m = state.members[uid];
  const bal = state.balances[uid] || 0;

  if (bal === 0) {
    openModal(`
      <h3 class="modal-title">${esc(m.name)} entfernen</h3>
      <p class="muted">Der Saldo ist ausgeglichen. Das Mitglied wird aus dem Team entfernt,
        bleibt aber in alten Ausgaben sichtbar.</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="rm-cancel">Abbrechen</button>
        <button class="btn btn-danger" id="rm-ok">Entfernen</button>
      </div>`);
    $("rm-cancel").addEventListener("click", closeModal);
    $("rm-ok").addEventListener("click", async () => {
      await deactivateMember(uid);
      closeModal();
    });
    return;
  }

  const balText = bal < 0
    ? `${esc(m.name)} schuldet dem Team noch <b>${formatCents(-bal)}</b>.`
    : `${esc(m.name)} bekommt noch <b>${formatCents(bal)}</b> vom Team.`;

  openModal(`
    <h3 class="modal-title">${esc(m.name)} entfernen</h3>
    <p class="muted small" style="margin-bottom:14px">${balText}<br>
      Am besten gleicht das Mitglied den Betrag vorher aus. Falls das nicht mehr möglich ist,
      kann der Restbetrag auf die verbleibenden Mitglieder verteilt werden:</p>
    <div class="field">
      <label>Wer übernimmt den Restbetrag?</label>
      ${participantPickerHTML("rm-pick", null, false, uid)}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="rm-cancel">Abbrechen</button>
      <button class="btn btn-danger" id="rm-ok">Verteilen & entfernen</button>
    </div>`);
  const picker = wirePicker("rm-pick");
  $("rm-cancel").addEventListener("click", closeModal);
  $("rm-ok").addEventListener("click", async (e) => {
    const shares = picker.getShares();
    if (!shares) return;
    if (!lockOnce(e.currentTarget)) return;
    await addDoc(collection(db, "teams", state.teamId, "expenses"), {
      type: "adjustment",
      title: `Verrechnung: ${m.name} wurde entfernt`,
      targetUid: uid,
      amount: bal,
      shares,
      date: todayStr(),
      createdBy: state.user.uid,
      createdAt: serverTimestamp()
    });
    await deactivateMember(uid);
    closeModal();
  });
}

async function deactivateMember(uid) {
  await updateDoc(doc(db, "teams", state.teamId, "members", uid), {
    active: false, removedAt: serverTimestamp()
  });
  toast("Mitglied entfernt.");
}

// ---------------------------------------------------------
// Team verlassen / löschen
// ---------------------------------------------------------
$("btn-leave-team").addEventListener("click", async () => {
  const uid = state.user.uid;
  if (isOwner()) {
    toast("Als Benutzer (Inhaber) kannst du das Team nicht verlassen – nur löschen.");
    return;
  }
  const bal = state.balances[uid] || 0;
  if (bal !== 0) {
    toast("Bitte gleiche zuerst deinen Saldo aus (oder ein Admin entfernt dich mit Verrechnung).");
    return;
  }
  if (!confirm("Team wirklich verlassen?")) return;
  await deleteDoc(doc(db, "teams", state.teamId, "members", uid));
  await updateDoc(doc(db, "users", uid), { teams: arrayRemove(state.teamId) });
  toast("Du hast das Team verlassen.");
});

$("btn-delete-team").addEventListener("click", async () => {
  if (!isOwner()) return;
  if (!confirm("Team wirklich ENDGÜLTIG löschen? Alle Ausgaben und Daten gehen verloren.")) return;
  if (!confirm("Bist du ganz sicher? Das kann nicht rückgängig gemacht werden.")) return;
  const teamId = state.teamId;
  const base = doc(db, "teams", teamId);
  try {
    for (const sub of ["expenses", "settlements", "presets", "members"]) {
      const snap = await getDocs(collection(base, sub));
      for (const d of snap.docs) await deleteDoc(d.ref);
    }
    await deleteDoc(base);
    await updateDoc(doc(db, "users", state.user.uid), { teams: arrayRemove(teamId) });
    toast("Team gelöscht.");
  } catch (err) {
    console.error(err);
    toast("Löschen fehlgeschlagen – bitte erneut versuchen.");
  }
});

// ---------------------------------------------------------
// Team-Wechsler
// ---------------------------------------------------------
$("btn-team-switcher").addEventListener("click", async () => {
  const teams = state.profile?.teams || [];
  const rows = [];
  for (const id of teams) {
    if (!state.teamNameCache[id]) {
      try {
        const snap = await getDoc(doc(db, "teams", id));
        state.teamNameCache[id] = snap.exists() ? snap.data().name : id;
      } catch { state.teamNameCache[id] = id; }
    }
    rows.push({ id, name: state.teamNameCache[id] });
  }
  openModal(`
    <h3 class="modal-title">Meine Teams</h3>
    <div class="stack-list">
      ${rows.map(r => `
        <div class="list-item tappable" data-team="${esc(r.id)}">
          <div class="item-icon">${r.id === state.teamId ? icon("check") : icon("people")}</div>
          <div class="item-main"><div class="item-title">${esc(r.name)}</div>
            <div class="item-sub">Code: ${esc(r.id)}</div></div>
        </div>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ts-new">+ Neues Team / beitreten</button>
      <button class="btn btn-primary" id="ts-close">Fertig</button>
    </div>`);
  $("ts-close").addEventListener("click", closeModal);
  $("ts-new").addEventListener("click", () => {
    closeModal();
    $("noteam-back").classList.remove("hidden");
    showView("noteam");
  });
  document.querySelectorAll("[data-team]").forEach(el =>
    el.addEventListener("click", () => {
      attachTeam(el.dataset.team);
      showView("app");
      closeModal();
    }));
});

// ---------------------------------------------------------
// Profil
// ---------------------------------------------------------
$("btn-profile").addEventListener("click", () => {
  openModal(`
    <h3 class="modal-title">Profil</h3>
    <div class="stack">
      <div class="field">
        <label>Dein Name (wird im Team angezeigt)</label>
        <input type="text" id="profile-name" value="${esc(state.profile?.name || "")}">
      </div>
      <div class="field">
        <label>E-Mail</label>
        <input type="text" value="${esc(state.user?.email || "")}" disabled>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="profile-close">Schließen</button>
      <button class="btn btn-primary" id="profile-save">Speichern</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-danger" id="profile-signout">Abmelden</button>
    </div>`);
  $("profile-close").addEventListener("click", closeModal);
  $("profile-save").addEventListener("click", async () => {
    const name = $("profile-name").value.trim();
    if (!name) { toast("Bitte einen Namen eingeben."); return; }
    await updateDoc(doc(db, "users", state.user.uid), { name });
    // Namen auch im aktuellen Team aktualisieren
    if (state.teamId && state.members[state.user.uid]) {
      await updateDoc(doc(db, "teams", state.teamId, "members", state.user.uid), { name });
    }
    closeModal();
    toast("Name gespeichert.");
  });
  $("profile-signout").addEventListener("click", () => { closeModal(); signOut(auth); });
});

// ---------------------------------------------------------
// Service Worker (Offline-Unterstützung)
// ---------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err =>
      console.warn("Service Worker konnte nicht registriert werden:", err));
  });
}

renderSync();
