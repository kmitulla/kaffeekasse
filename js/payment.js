// Zahlungsoptionen für den Ausgleich: PayPal.me-Links (mit Betrag)
// und EPC-QR-Codes ("Girocode") für SEPA-Überweisungen, die jede
// deutsche Banking-App scannen kann.
import qrcode from "./qrcode.js";

// Die Bibliothek kodiert standardmäßig nur Latin-1 – für Umlaute in
// Namen (z. B. "Müller") auf echtes UTF-8 umstellen (EPC-Zeichensatz 1).
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

// PayPal.me-Namen normalisieren. Akzeptiert auch komplette Links
// ("https://paypal.me/MaxMuster") und liefert nur den Nutzernamen –
// oder "" bei ungültiger Eingabe.
export function normalizePaypal(input) {
  if (typeof input !== "string") return "";
  const s = input.trim()
    .replace(/^(https?:\/\/)?(www\.)?(paypal\.com\/)?(paypal\.me\/)?@?/i, "")
    .split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9]{1,20}$/.test(s) ? s : "";
}

// Link, der PayPal (App am Handy, Website am PC) direkt mit
// vorausgefülltem Betrag öffnet.
export function paypalMeLink(user, cents) {
  const base = `https://paypal.me/${encodeURIComponent(user)}`;
  if (!cents || cents <= 0) return base;
  return `${base}/${(cents / 100).toFixed(2)}EUR`;
}

// IBAN: Leerzeichen raus, Großschreibung
export function normalizeIban(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// IBAN in 4er-Gruppen anzeigen
export function formatIban(s) {
  return normalizeIban(s).replace(/(.{4})/g, "$1 ").trim();
}

// Echte IBAN-Prüfung (Mod-97, ISO 13616) – fängt Tippfehler ab.
export function validIban(iban) {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// EPC-QR-Code-Inhalt (EPC069-12, Version 002, UTF-8, SEPA-Überweisung).
// Banking-App scannt: Name, IBAN, Betrag und Verwendungszweck sind
// automatisch ausgefüllt. (Ein Datum sieht der Standard nicht vor.)
export function epcQrData({ name, iban, cents, remittance }) {
  return [
    "BCD",                                  // Service-Tag
    "002",                                  // Version (BIC optional)
    "1",                                    // Zeichensatz: UTF-8
    "SCT",                                  // SEPA Credit Transfer
    "",                                     // BIC (bei 002 nicht nötig)
    (name || "").slice(0, 70),              // Empfänger
    normalizeIban(iban),                    // IBAN
    `EUR${(cents / 100).toFixed(2)}`,       // Betrag
    "",                                     // Purpose-Code
    "",                                     // strukturierte Referenz
    (remittance || "").slice(0, 140)        // Verwendungszweck
  ].join("\n");
}

// QR-Code als SVG (skalierbar, ECC-Level M wie von der EPC empfohlen)
export function qrSvg(data) {
  const qr = qrcode(0, "M");
  qr.addData(data, "Byte");
  qr.make();
  // margin 16 = 4 Module Ruhezone (bei cellSize 4), wie im QR-Standard
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

// Für Tests: Roh-Matrix erzeugen
export function qrMatrix(data) {
  const qr = qrcode(0, "M");
  qr.addData(data, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}
