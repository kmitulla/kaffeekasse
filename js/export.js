// Export nach Excel (.xlsx) und PDF – ohne externe Bibliotheken.
// XLSX = ZIP-Archiv mit XML-Dateien; PDF wird direkt als Bytes erzeugt.

// ---------- Hilfen ----------
const te = new TextEncoder();

function xmlEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- ZIP (Store, ohne Kompression) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  // files: [{name, data: Uint8Array}]
  const chunks = [];
  const central = [];
  let offset = 0;
  const num = (n, len) => {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (n >>> (8 * i)) & 0xff;
    return a;
  };
  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.data);
    const local = [
      num(0x04034b50, 4), num(20, 2), num(0x0800, 2), num(0, 2),
      num(0, 2), num(0, 2),
      num(crc, 4), num(f.data.length, 4), num(f.data.length, 4),
      num(name.length, 2), num(0, 2)
    ];
    central.push({ name, crc, size: f.data.length, offset });
    for (const c of local) { chunks.push(c); }
    chunks.push(name, f.data);
    offset += local.reduce((s, c) => s + c.length, 0) + name.length + f.data.length;
  }
  const cdStart = offset;
  for (const e of central) {
    const rec = [
      num(0x02014b50, 4), num(20, 2), num(20, 2), num(0x0800, 2), num(0, 2),
      num(0, 2), num(0, 2),
      num(e.crc, 4), num(e.size, 4), num(e.size, 4),
      num(e.name.length, 2), num(0, 2), num(0, 2), num(0, 2), num(0, 2),
      num(0, 4), num(e.offset, 4)
    ];
    for (const c of rec) chunks.push(c);
    chunks.push(e.name);
    offset += rec.reduce((s, c) => s + c.length, 0) + e.name.length;
  }
  chunks.push(
    num(0x06054b50, 4), num(0, 2), num(0, 2),
    num(central.length, 2), num(central.length, 2),
    num(offset - cdStart, 4), num(cdStart, 4), num(0, 2)
  );
  return new Blob(chunks, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ---------- XLSX ----------
function colLetter(i) {
  let s = "";
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function sheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof v === "number" && isFinite(v)) {
        return `<c r="${ref}"><v>${v}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

// sheets: [{name, rows: [[Zelle, ...], ...]}]
export function makeXlsx(sheets) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) =>
    `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
</Relationships>`;
  const files = [
    { name: "[Content_Types].xml", data: te.encode(contentTypes) },
    { name: "_rels/.rels", data: te.encode(rels) },
    { name: "xl/workbook.xml", data: te.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: te.encode(wbRels) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: te.encode(sheetXml(s.rows)) }))
  ];
  return zipStore(files);
}

// ---------- PDF ----------
// Text als Latin-1/WinAnsi (deckt Umlaute und € ab)
function pdfEncode(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    let code = ch.codePointAt(0);
    if (ch === "€") code = 0x80;
    else if (ch === "–" || ch === "—") code = 0x2d;
    else if (ch === "→") { out += "->"; continue; }
    else if (code > 255) code = 63; // '?'
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += "\\";
    out += String.fromCharCode(code);
  }
  return out;
}

// sections: [{heading, headers:[..], rows:[[..]], widths:[relative..]}]
export function makePdf(title, subtitle, sections) {
  const W = 595.28, H = 841.89, M = 42;
  const usable = W - 2 * M;
  const pages = [];
  let lines = [];
  let y = H - M;

  const put = (x, yy, size, bold, text) =>
    lines.push(`BT /F${bold ? 2 : 1} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfEncode(text)}) Tj ET`);
  const rule = (yy) =>
    lines.push(`0.75 w 0.62 0.6 0.58 RG ${M} ${yy.toFixed(1)} m ${(W - M).toFixed(1)} ${yy.toFixed(1)} l S`);
  const newPage = () => { pages.push(lines.join("\n")); lines = []; y = H - M; };
  const need = (h) => { if (y - h < M) newPage(); };

  const clip = (text, maxChars) => {
    const s = String(text ?? "");
    return s.length > maxChars ? s.slice(0, maxChars - 1) + "…" : s;
  };

  put(M, y - 14, 18, true, title); y -= 22;
  if (subtitle) { put(M, y - 10, 10, false, subtitle); y -= 18; }
  y -= 6;

  for (const sec of sections) {
    need(46);
    y -= 14;
    put(M, y, 13, true, sec.heading);
    y -= 8;
    const wsum = sec.widths.reduce((a, b) => a + b, 0);
    const colW = sec.widths.map(w => w / wsum * usable);
    const colX = colW.map((_, i) => M + colW.slice(0, i).reduce((a, b) => a + b, 0));
    const maxChars = colW.map(w => Math.max(4, Math.floor(w / 4.7)));

    const headerRow = () => {
      need(30);
      y -= 13;
      sec.headers.forEach((h, i) => put(colX[i], y, 8.5, true, clip(h, maxChars[i])));
      y -= 4;
      rule(y);
      y -= 2;
    };
    headerRow();
    if (!sec.rows.length) {
      need(14); y -= 11;
      put(M, y, 9, false, "– keine Einträge –");
    }
    for (const row of sec.rows) {
      if (y - 12 < M) { newPage(); headerRow(); }
      y -= 11;
      row.forEach((cell, i) => put(colX[i], y, 8.5, false, clip(cell, maxChars[i])));
    }
    y -= 6;
  }
  pages.push(lines.join("\n"));

  // PDF-Datei zusammensetzen
  const objs = [];
  const pageObjIds = pages.map((_, i) => 5 + i * 2);
  objs.push(`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`);
  objs.push(`2 0 obj << /Type /Pages /Count ${pages.length} /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] >> endobj`);
  objs.push(`3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj`);
  objs.push(`4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj`);
  pages.forEach((content, i) => {
    const id = 5 + i * 2;
    objs.push(`${id} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >> endobj`);
    objs.push(`${id + 1} 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`);
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) { offsets.push(pdf.length); pdf += o + "\n"; }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}
