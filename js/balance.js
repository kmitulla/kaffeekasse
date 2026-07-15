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

// Verteilt einen Betrag (Cent) nach Prozenten exakt – Rundungsreste
// werden nach dem Größte-Reste-Verfahren verteilt, sodass die Summe
// immer genau dem Gesamtbetrag entspricht.
export function splitByPercent(amountCents, sharesPct) {
  const uids = Object.keys(sharesPct);
  const raw = uids.map(uid => {
    const exact = amountCents * (sharesPct[uid] / 100);
    return { uid, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let used = raw.reduce((s, r) => s + r.floor, 0);
  let remainder = amountCents - used;
  raw.sort((a, b) => b.rest - a.rest);
  const result = {};
  for (const r of raw) {
    result[r.uid] = r.floor + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
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

  for (const e of expenses) {
    if (e.type === "adjustment") {
      add(e.targetUid, -e.amount);
      const parts = splitByPercent(Math.abs(e.amount), e.shares);
      const sign = e.amount < 0 ? -1 : 1;
      for (const uid of Object.keys(parts)) add(uid, sign * parts[uid]);
    } else {
      add(e.paidBy, e.amount);
      const parts = splitByPercent(e.amount, e.shares);
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
