// Geld- und Saldo-Berechnungen.
// Alle Beträge werden intern in Cent (ganze Zahlen) gerechnet,
// damit keine Rundungsfehler entstehen.

export function formatCents(cents) {
  const v = (cents / 100).toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${v} €`;
}

// "12,50" / "12.50" / "12" -> 1250 Cent (oder null bei Unsinn)
export function parseEuro(text) {
  if (typeof text !== "string") return null;
  const norm = text.trim().replace(/\s/g, "").replace(/\./g, ",").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  return Math.round(parseFloat(norm) * 100);
}

// Kleine feste Prüfsumme (FNV-1a): gleiche Eingabe ergibt auf jedem
// Gerät dieselbe Zahl – dient nur als letzter, neutraler Gleichstands-Entscheid.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// "Gleichmäßig aufteilen" wird als 14,28 % … 14,32 % gespeichert (Summe
// muss 100 ergeben). Solche Anteile gelten als exakt gleich, damit nicht
// immer dieselbe Person die paar Hundertstel Prozent mehr trägt.
function isEqualSplit(vals) {
  return Math.max(...vals) - Math.min(...vals) <= 0.01 * vals.length + 1e-9;
}

// Verteilt einen Betrag (Cent) exakt nach Anteilen. Die Summe ergibt
// immer genau den Betrag. Übrige Cents bekommen zuerst die mit dem größten
// Nachkomma-Rest; bei Gleichstand der, der bisher die WENIGSTEN Extra-Cents
// getragen hat (ledger), dann eine feste Prüfsumme. Das Ergebnis hängt
// nicht von der Reihenfolge der Daten ab – jedes Gerät rechnet gleich.
//   seed:   z. B. die Ausgaben-ID
//   ledger: { uid: Extra-Cents bisher } – wird fortgeschrieben
//   burden: true = ein Extra-Cent ist eine Last (Anteil an einer Ausgabe),
//           false = ein Vorteil (z. B. erlassenes Guthaben bei Verrechnung)
export function splitByPercent(amountCents, sharesPct, { seed = "", ledger = null, burden = true } = {}) {
  const uids = Object.keys(sharesPct).sort();
  if (!uids.length) return {};
  const vals = uids.map(u => Number(sharesPct[u]) || 0);
  const equal = isEqualSplit(vals);
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const raw = uids.map((uid, i) => {
    const exact = equal ? amountCents / uids.length : amountCents * vals[i] / total;
    const floor = Math.floor(exact + 1e-9);
    return { uid, floor, rest: exact - floor };
  });
  let remainder = amountCents - raw.reduce((sum, r) => sum + r.floor, 0);
  const led = (uid) => (ledger && ledger[uid]) || 0;
  raw.sort((a, b) => {
    if (Math.abs(b.rest - a.rest) > 1e-9) return b.rest - a.rest;
    const la = led(a.uid), lb = led(b.uid);
    if (la !== lb) return burden ? la - lb : lb - la;
    const ha = hash32(seed + "|" + a.uid), hb = hash32(seed + "|" + b.uid);
    if (ha !== hb) return ha - hb;
    return a.uid < b.uid ? -1 : 1;
  });
  const result = {};
  for (const r of raw) result[r.uid] = r.floor;
  for (let i = 0; remainder > 0; i = (i + 1) % raw.length, remainder--) {
    result[raw[i].uid]++;
    if (ledger) ledger[raw[i].uid] = led(raw[i].uid) + (burden ? 1 : -1);
  }
  for (let i = raw.length - 1; remainder < 0; i = (i - 1 + raw.length) % raw.length, remainder++) {
    result[raw[i].uid]--;
  }
  return result;
}

// Gleiche Prozent-Verteilung für n Personen (Summe exakt 100)
export function equalPercents(uids) {
  const n = uids.length;
  const base = Math.floor(10000 / n) / 100;
  const shares = {};
  let sum = 0;
  uids.forEach((uid, i) => {
    let p = base;
    if (i === n - 1) p = Math.round((100 - sum) * 100) / 100;
    shares[uid] = p;
    sum = Math.round((sum + p) * 100) / 100;
  });
  return shares;
}

// Berechnet die Netto-Salden aller Mitglieder.
// Positiv = bekommt Geld, negativ = schuldet Geld.
// expenses: type 'expense'  -> Zahler +Betrag, Beteiligte -Anteil
//           type 'adjustment' (Verrechnung beim Entfernen eines Mitglieds)
//             -> targetUid wird auf 0 gestellt, die anderen übernehmen
//                den Saldo anteilig
// settlements (nur status 'confirmed'): from +Betrag, to -Betrag
export function computeBalances(expenses, settlements) {
  const bal = {};
  const add = (uid, cents) => { bal[uid] = (bal[uid] || 0) + cents; };
  const ledger = {};

  // Feste Reihenfolge (Datum, dann ID), damit die reihum verteilten
  // Extra-Cents auf jedem Gerät gleich ausfallen.
  const ordered = [...expenses].sort((a, b) => {
    const da = String(a.date || ""), db = String(b.date || "");
    if (da !== db) return da < db ? -1 : 1;
    const ia = String(a.id || ""), ib = String(b.id || "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  for (const e of ordered) {
    const seed = String(e.id || "");
    if (e.type === "adjustment") {
      add(e.targetUid, -e.amount);
      const sign = e.amount < 0 ? -1 : 1;
      const parts = splitByPercent(Math.abs(e.amount), e.shares, { seed, ledger, burden: sign < 0 });
      for (const uid of Object.keys(parts)) add(uid, sign * parts[uid]);
    } else {
      add(e.paidBy, e.amount);
      const parts = splitByPercent(e.amount, e.shares, { seed, ledger, burden: true });
      for (const uid of Object.keys(parts)) add(uid, -parts[uid]);
    }
  }
  for (const s of settlements) {
    if (s.status !== "confirmed") continue;
    add(s.from, s.amount);
    add(s.to, -s.amount);
  }
  return bal;
}

// Vereinfacht die Schulden: Wer zahlt wem wie viel, damit alle
// Salden ausgeglichen sind (Greedy, wie bei Splid).
// Liefert [{from, to, amount}, ...]
export function simplifyDebts(balances) {
  const creditors = [];
  const debtors = [];
  for (const [uid, b] of Object.entries(balances)) {
    if (b > 0) creditors.push({ uid, left: b });
    else if (b < 0) debtors.push({ uid, left: -b });
  }
  creditors.sort((a, b) => b.left - a.left);
  debtors.sort((a, b) => b.left - a.left);

  const result = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const pay = Math.min(creditors[ci].left, debtors[di].left);
    if (pay > 0) result.push({ from: debtors[di].uid, to: creditors[ci].uid, amount: pay });
    creditors[ci].left -= pay;
    debtors[di].left -= pay;
    if (creditors[ci].left === 0) ci++;
    if (debtors[di].left === 0) di++;
  }
  return result;
}
