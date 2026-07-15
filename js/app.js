// ==========================================================
// Kaffeekasse – Hauptlogik
// ==========================================================
import {
  auth, db,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove
} from "./firebase.js";
import {
  formatCents, parseEuro, splitByPercent, equalPercents,
  computeBalances, simplifyDebts
} from "./balance.js";

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
  online: navigator.onLine,
  pendingWrites: false,
  teamNameCache: {}
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ROLE_LABEL = { owner: "Benutzer", admin: "Admin", user: "User" };
const ROLE_BADGE = { owner: "badge-owner", admin: "badge-admin", user: "badge-user" };

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
function emojiFor(title) {
  const t = (title || "").toLowerCase();
  if (/(kaffee|espresso|bohne|coffee)/.test(t)) return "☕️";
  if (/milch/.test(t)) return "🥛";
  if (/zucker|süßstoff/.test(t)) return "🍬";
  if (/wasser|sprudel/.test(t)) return "💧";
  if (/tee/.test(t)) return "🍵";
  if (/kuchen|geb(ä|a)ck|keks|donut|croissant/.test(t)) return "🍰";
  if (/filter|becher|tasse|maschine|entkalker|reinig/.test(t)) return "🧰";
  if (/verrechnung/.test(t)) return "⚖️";
  return "🛒";
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
  for (const v of ["view-loading", "view-auth", "view-noteam", "view-app"]) {
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
      await setDoc(doc(db, "users", cred.user.uid), {
        name, email, teams: [], createdAt: serverTimestamp()
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

$("auth-forgot").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  if (!email) { toast("Bitte zuerst deine E-Mail eintragen."); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("E-Mail zum Zurücksetzen wurde gesendet.");
  } catch (err) {
    toast(authErrorText(err));
  }
});

$("noteam-signout").addEventListener("click", () => signOut(auth));
$("noteam-back").addEventListener("click", () => showView("app"));

// ---------------------------------------------------------
// Start: Auth-Status beobachten
// ---------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  cleanupTeam();
  if (state.profileUnsub) { state.profileUnsub(); state.profileUnsub = null; }
  state.user = user;
  if (!user) {
    state.profile = null;
    showView("auth");
    return;
  }
  showView("loading");

  // Profil beobachten (Name, Teamliste)
  const ref = doc(db, "users", user.uid);
  state.profileUnsub = onSnapshot(ref, async (snap) => {
    if (!snap.exists()) {
      // Profil fehlt (z. B. Konto existierte schon) -> anlegen
      await setDoc(ref, {
        name: user.displayName || user.email.split("@")[0],
        email: user.email, teams: [], createdAt: serverTimestamp()
      });
      return;
    }
    state.profile = snap.data();
    $("avatar-initials").textContent = initials(state.profile.name);
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
  if (!name) { errEl.textContent = "Bitte einen Teamnamen eingeben."; errEl.classList.remove("hidden"); return; }
  try {
    await createTeam(name);
    toast("Team erstellt! 🎉");
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
    toast("Willkommen im Team! 🎉");
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
      <div class="item-icon">${emojiFor(e.title)}</div>
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
    my > 0 ? "Du bekommst noch Geld 🙂" : my < 0 ? "Du schuldest noch Geld" : "Alles ausgeglichen ✨";

  // Offene Zahlungen, die auf MEINE Bestätigung warten
  const toConfirm = state.settlements.filter(s => s.status === "pending" && s.to === uid);
  $("pending-confirm-section").classList.toggle("hidden", toConfirm.length === 0);
  $("pending-confirm-list").innerHTML = toConfirm.map(s => `
    <div class="list-item">
      <div class="item-icon">💶</div>
      <div class="item-main">
        <div class="item-title">${esc(memberNameReal(s.from))} hat dir ${formatCents(s.amount)} gezahlt</div>
        <div class="item-sub">Bestätige, sobald das Geld da ist</div>
      </div>
      <button class="btn btn-small btn-primary" data-confirm="${esc(s.id)}">Bestätigen</button>
    </div>`).join("");
  $("pending-confirm-list").querySelectorAll("[data-confirm]").forEach(b =>
    b.addEventListener("click", () => confirmSettlement(b.dataset.confirm)));

  // Meine offenen Beträge (vereinfachte Schulden, die mich betreffen)
  const debts = simplifyDebts(state.balances).filter(d => d.from === uid || d.to === uid);
  const myPending = state.settlements.filter(s => s.status === "pending" && s.from === uid);
  let html = "";
  for (const d of debts) {
    if (d.from === uid) {
      const pend = myPending.find(p => p.to === d.to);
      html += `
        <div class="list-item">
          <div class="item-icon">💸</div>
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
          <div class="item-icon">🪙</div>
          <div class="item-main">
            <div class="item-title">${esc(memberNameReal(d.from))} → Du</div>
            <div class="item-sub">Offen</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <span class="item-amount positive">${formatCents(d.amount)}</span>
            <button class="btn btn-small btn-secondary" data-received="${esc(d.from)}" data-amount="${d.amount}">Erhalten ✓</button>
          </div>
        </div>`;
    }
  }
  $("my-debts-list").innerHTML = html || `<div class="empty-note">Nichts offen – alles ausgeglichen 🎉</div>`;
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
}

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
        <div class="item-icon">${d.from === uid || d.to === uid ? "⭐️" : "🔁"}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberName(d.from))} → ${esc(memberName(d.to))}</div>
        </div>
        <span class="item-amount">${formatCents(d.amount)}</span>
      </div>`).join("")
    : `<div class="empty-note">Alle Salden sind ausgeglichen 🎉</div>`;

  const rows = Object.entries(state.balances)
    .filter(([mUid, b]) => b !== 0 || state.members[mUid]?.active !== false)
    .sort((a, b) => b[1] - a[1]);
  $("settle-balances").innerHTML = rows.map(([mUid, b]) => {
    const m = state.members[mUid];
    const gone = m?.active === false;
    return `
      <div class="list-item">
        <div class="item-icon">${gone ? "🚪" : "👤"}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberNameReal(mUid))}${gone ? " (entfernt)" : ""}</div>
        </div>
        <span class="item-amount ${b > 0 ? "positive" : b < 0 ? "negative" : ""}">${(b > 0 ? "+" : "")}${formatCents(b).replace("-", "−")}</span>
      </div>`;
  }).join("") || `<div class="empty-note">Keine Mitglieder.</div>`;

  const hist = state.settlements.slice(0, 25);
  $("settle-history").innerHTML = hist.length
    ? hist.map(s => `
      <div class="list-item">
        <div class="item-icon">${s.status === "confirmed" ? "✅" : "⏳"}</div>
        <div class="item-main">
          <div class="item-title">${esc(memberName(s.from))} → ${esc(memberName(s.to))}</div>
          <div class="item-sub">
            <span class="badge ${s.status === "confirmed" ? "badge-confirmed" : "badge-pending"}">
              ${s.status === "confirmed" ? "Ausgeglichen" : "Wartet auf Bestätigung"}</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="item-amount">${formatCents(s.amount)}</span>
          ${s.status === "pending" && s.to === uid
            ? `<button class="btn btn-small btn-primary" data-confirm="${esc(s.id)}">Bestätigen</button>` : ""}
        </div>
      </div>`).join("")
    : `<div class="empty-note">Noch keine Ausgleichszahlungen.</div>`;
  $("settle-history").querySelectorAll("[data-confirm]").forEach(b =>
    b.addEventListener("click", () => confirmSettlement(b.dataset.confirm)));
}

async function confirmSettlement(id) {
  await updateDoc(doc(db, "teams", state.teamId, "settlements", id), {
    status: "confirmed", confirmedAt: serverTimestamp()
  });
  toast("Zahlung bestätigt ✅");
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
      <p class="muted small">${kind === "pay"
        ? "Der Empfänger muss die Zahlung anschließend bestätigen – erst dann gilt sie als ausgeglichen."
        : "Damit bestätigst du, dass du das Geld bereits erhalten hast."}</p>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="settle-cancel">Abbrechen</button>
      <button class="btn btn-primary" id="settle-ok">${kind === "pay" ? "Als bezahlt melden" : "Erhalt bestätigen"}</button>
    </div>`);
  $("settle-cancel").addEventListener("click", closeModal);
  $("settle-ok").addEventListener("click", async () => {
    const cents = parseEuro($("settle-amount").value);
    if (!cents || cents <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
    const uid = state.user.uid;
    const data = kind === "pay"
      ? { from: uid, to: otherUid, amount: cents, status: "pending", createdBy: uid, createdAt: serverTimestamp() }
      : { from: otherUid, to: uid, amount: cents, status: "confirmed", createdBy: uid, createdAt: serverTimestamp(), confirmedAt: serverTimestamp() };
    await addDoc(collection(db, "teams", state.teamId, "settlements"), data);
    closeModal();
    toast(kind === "pay" ? "Gemeldet – wartet auf Bestätigung ⏳" : "Zahlung verbucht ✅");
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
        <div class="item-icon">${inactive ? "🚪" : "👤"}</div>
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
          <div class="item-icon">👥</div>
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
    toast("Code kopiert 📋");
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
    sumEl.textContent = `Summe: ${sum} %` + (Math.abs(sum - 100) < 0.01 ? " ✓" : " (muss 100 % sein)");
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
// Ausgabe anlegen / bearbeiten
// ---------------------------------------------------------
$("btn-add-expense").addEventListener("click", () => openExpenseModal(null));

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
  $("exp-cancel").addEventListener("click", closeModal);

  if (!canEdit) {
    $("modal-box").querySelectorAll("input, select, .chip").forEach(el => { el.disabled = true; });
  }

  if (canEdit) {
    $("exp-save").addEventListener("click", async () => {
      const title = $("exp-title").value.trim();
      const amount = parseEuro($("exp-amount").value);
      const date = $("exp-date").value;
      const paidBy = $("exp-payer").value;
      if (!title) { toast("Bitte eintragen, was gekauft wurde."); return; }
      if (!amount || amount <= 0) { toast("Bitte einen gültigen Betrag eingeben."); return; }
      if (!date) { toast("Bitte ein Datum wählen."); return; }
      const shares = picker.getShares();
      if (!shares) return;

      const data = { type: "expense", title, amount, date, paidBy, shares };
      if (existing) {
        await updateDoc(doc(db, "teams", state.teamId, "expenses", expenseId), data);
        toast("Ausgabe aktualisiert ✅");
      } else {
        await addDoc(collection(db, "teams", state.teamId, "expenses"), {
          ...data, createdBy: state.user.uid, createdAt: serverTimestamp()
        });
        toast("Ausgabe gespeichert ✅");
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
  $("preset-save").addEventListener("click", async () => {
    const name = $("preset-name").value.trim();
    if (!name) { toast("Bitte einen Namen eingeben."); return; }
    const shares = picker.getShares();
    if (!shares) return;
    if (existing) {
      await updateDoc(doc(db, "teams", state.teamId, "presets", presetId), { name, shares });
    } else {
      await addDoc(collection(db, "teams", state.teamId, "presets"), { name, shares });
    }
    closeModal();
    toast("Gruppe gespeichert ✅");
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
      toast("Gespeichert ✅");
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
  $("rm-ok").addEventListener("click", async () => {
    const shares = picker.getShares();
    if (!shares) return;
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
          <div class="item-icon">${r.id === state.teamId ? "✅" : "👥"}</div>
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
    toast("Name gespeichert ✅");
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
