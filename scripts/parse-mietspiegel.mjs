// Turns the Berlin Mietspiegel 2026 rent table (PDF) into a flat JSON lookup
// keyed by Wohnlage x Bezugsfertigkeit x Wohnfläche, so the backend can later
// resolve a reference rent without parsing a PDF at runtime.
// Run with:  node scripts/parse-mietspiegel.mjs <path-to-pdf>
//
// The PDF prints three tables side by side (einfache / mittlere / gute
// Wohnlage) with explanatory prose running down the right margin, so a
// single `pdftotext -layout` line can contain up to three table rows plus a
// fragment of unrelated text. We don't try to parse by column x-position —
// that's what makes the marginal prose dangerous to sit next to. Instead we
// scan each line for repeating (Zeile, text, lower, mean, upper) groups; the
// prose never matches because it has no three-euro-amounts-in-a-row shape.
// Which of the three tables a row belongs to is read off the Zeile number
// itself: einfache is 1-67, mittlere 68-129, gute 130+ (measured from the
// 2026 edition; the next edition may need these bounds re-checked).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(SCRIPT_DIR, "..", "isochrone-backend", "mietspiegel-2026.json");
const SOURCE_URL = "https://mietspiegel.berlin.de/wp-content/uploads/2026/05/mietspiegeltabelle2026.pdf";

const MITTEL_STARTS_AT = 68;
const GUTE_STARTS_AT = 130;

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("usage: node scripts/parse-mietspiegel.mjs <path-to-pdf>");
  process.exit(1);
}

const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });

// Matches one table row: a Zeile number, then whatever text sits between it
// and its three money values (Bezugsfertigkeit + Wohnfläche, or just
// Wohnfläche on a continuation row), then untere Spanne / Mittelwert / obere
// Spanne. Applied with /g so multiple matches on one line pick up all three
// tables in turn; matching stops once no 3-euro-amount run is found, which
// is exactly the point where the right-margin prose starts.
const ENTRY_RE = /(\d{1,3})\s+(.+?)(\d+,\d{2})\s*€\s+(\d+,\d{2})\s*€\s+(\d+,\d{2})\s*€/g;

// Bezugsfertigkeit is present only on the first row of a build-year group;
// this recognises it so it can be stripped off the front of the combined
// text and forward-filled on the blank continuation rows.
// Case-insensitive: the einfache table prints "bis 1918", mittlere/gute print
// "Bis 1918" for the same band — stored value is lowercased below either way.
const BEZUGSFERTIGKEIT_RE = /^(bis\s+\d{4}|\d{4}\s+bis\s+\d{4}(?:\s+(?:West|Ost\*))?\*{0,2})\s*/i;

const eur = (s) => Number.parseFloat(s.replace(",", "."));

function splitBezugsfertigkeit(text) {
  const m = text.match(BEZUGSFERTIGKEIT_RE);
  if (!m) return { bezugsfertigkeit: null, rest: text };
  // Footnote markers (*, **) are provenance, not part of the value.
  const bezugsfertigkeit = m[1].replace(/\s+/g, " ").replace(/\*/g, "").replace(/^Bis/, "bis").trim();
  return { bezugsfertigkeit, rest: text.slice(m[0].length) };
}

function parseWohnflaeche(raw) {
  const t = raw.replace(/\s+/g, " ").trim();
  // Three build-year bands (2010-2015, 2016-2019, alle Wohnflächen) don't
  // split by floor area at all, so the row applies to any size. Represented
  // as minSqm 0 rather than null so it still counts as "at least one bound
  // present" and reads as "from 0 up" instead of "unknown".
  if (/^alle Wohnfl(ä|ae)chen$/i.test(t)) return { minSqm: 0, maxSqm: null };
  let m;
  if ((m = t.match(/^bis unter (\d+)\s*m²$/))) return { minSqm: null, maxSqm: Number(m[1]) };
  if ((m = t.match(/^(\d+)\s*m²\s*bis unter (\d+)\s*m²$/)))
    return { minSqm: Number(m[1]), maxSqm: Number(m[2]) };
  if ((m = t.match(/^ab\s+(\d+)\s*m²$/))) return { minSqm: Number(m[1]), maxSqm: null };
  throw new Error(`unrecognised Wohnfläche text: "${t}"`);
}

const rawRows = [];
for (const line of text.split("\n")) {
  ENTRY_RE.lastIndex = 0;
  let m;
  while ((m = ENTRY_RE.exec(line))) {
    const [, zeileStr, combinedText, lower, mean, upper] = m;
    rawRows.push({
      zeile: Number(zeileStr),
      combinedText,
      lower: eur(lower),
      mean: eur(mean),
      upper: eur(upper),
    });
  }
}

const wohnlageFor = (zeile) =>
  zeile >= GUTE_STARTS_AT ? "gut" : zeile >= MITTEL_STARTS_AT ? "mittel" : "einfach";

// Group by Wohnlage and sort by Zeile before forward-filling Bezugsfertigkeit
// — each table carries its own independent fill state, and rows for the
// same Zeile can arrive out of order because the three tables are printed
// side by side rather than one after another.
const byWohnlage = { einfach: [], mittel: [], gut: [] };
for (const r of rawRows) byWohnlage[wohnlageFor(r.zeile)].push(r);
for (const wohnlage of Object.keys(byWohnlage)) byWohnlage[wohnlage].sort((a, b) => a.zeile - b.zeile);

const rows = [];
for (const [wohnlage, entries] of Object.entries(byWohnlage)) {
  let lastBezugsfertigkeit = null;
  for (const entry of entries) {
    const { bezugsfertigkeit, rest } = splitBezugsfertigkeit(entry.combinedText);
    if (bezugsfertigkeit) lastBezugsfertigkeit = bezugsfertigkeit;
    const { minSqm, maxSqm } = parseWohnflaeche(rest);
    rows.push({
      zeile: entry.zeile,
      wohnlage,
      bezugsfertigkeit: lastBezugsfertigkeit,
      minSqm,
      maxSqm,
      lower: entry.lower,
      mean: entry.mean,
      upper: entry.upper,
    });
  }
}
rows.sort((a, b) => a.zeile - b.zeile);

const output = {
  edition: 2026,
  stichtag: "2025-09-01",
  source: SOURCE_URL,
  unit: "EUR/m2/month net cold",
  adjustments: {
    noHeatingOrBathPre1949Eur: -0.33,
    condition:
      "Deduct from the applicable row's lower/mean/upper for flats bezugsfertig bis 1949 " +
      "without Sammelheizung and/or without Bad, with WC in the flat (IWC).",
    // The PDF's next sentence, and the reason this is not just a number: the
    // deduction rests on too few observed rents to qualify, so it sits OUTSIDE
    // the qualifizierter Mietspiegel. The table itself carries a statutory
    // presumption of correctness under BGB §558d; this deduction does not.
    // Anything that tells a tenant their rent is unlawful must not lean on it.
    qualifiedMietspiegel: false,
    qualifiedMietspiegelNote:
      "Dieser Abschlag kann nicht dem Anwendungsbereich des qualifizierten " +
      "Mietspiegels zugeordnet werden (geringe Zahl an Mietwerten).",
  },
  // Footnote markers stripped from bezugsfertigkeit; they assign Wende-era flats
  // to a band rather than changing any price. Kept because a 1990/91 East Berlin
  // build is otherwise ambiguous between the two bands.
  bandNotes: {
    "1973 bis 1990 Ost": "mit Wendewohnungen",
    "1991 bis 2001": "ohne Wendewohnungen",
  },
  rows,
};

// --- self-check: fail loudly rather than commit a silently mis-parsed table ---
function assertTrue(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const zeilen = rows.map((r) => r.zeile).sort((a, b) => a - b);
const maxZeile = zeilen[zeilen.length - 1];
for (let i = 0; i < maxZeile; i++) {
  assertTrue(zeilen[i] === i + 1, `Zeile ${i + 1} missing or duplicated (found ${zeilen[i]} at that position)`);
}

const wohnlagen = new Set(rows.map((r) => r.wohnlage));
assertTrue(wohnlagen.size === 3, `expected exactly 3 wohnlage values, got ${[...wohnlagen].join(", ")}`);
for (const wohnlage of wohnlagen) {
  const zRange = rows.filter((r) => r.wohnlage === wohnlage).map((r) => r.zeile);
  const other = rows.filter((r) => r.wohnlage !== wohnlage).map((r) => r.zeile);
  const overlap = zRange.filter((z) => other.includes(z));
  assertTrue(overlap.length === 0, `zeile range for ${wohnlage} overlaps another wohnlage: ${overlap.join(", ")}`);
}

for (const r of rows) {
  assertTrue(r.lower > 0 && r.lower <= r.mean && r.mean <= r.upper, `row ${r.zeile}: expected 0 < lower <= mean <= upper, got ${r.lower}/${r.mean}/${r.upper}`);
  assertTrue(!!r.bezugsfertigkeit, `row ${r.zeile}: missing bezugsfertigkeit (forward-fill failed)`);
  assertTrue(r.minSqm !== null || r.maxSqm !== null, `row ${r.zeile}: minSqm and maxSqm both null`);
}

const row1 = rows.find((r) => r.zeile === 1);
assertTrue(
  row1 &&
    row1.wohnlage === "einfach" &&
    row1.bezugsfertigkeit === "bis 1918" &&
    row1.maxSqm === 35 &&
    row1.lower === 6.53 &&
    row1.mean === 9.58 &&
    row1.upper === 13.43,
  `row 1 spot-check failed: ${JSON.stringify(row1)}`,
);
const row68 = rows.find((r) => r.zeile === 68);
assertTrue(row68 && row68.wohnlage === "mittel", `row 68 spot-check failed: ${JSON.stringify(row68)}`);
const row130 = rows.find((r) => r.zeile === 130);
assertTrue(row130 && row130.wohnlage === "gut", `row 130 spot-check failed: ${JSON.stringify(row130)}`);

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");

console.log(`wrote ${rows.length} rows to ${path.relative(process.cwd(), OUT_PATH)}`);
for (const wohnlage of ["einfach", "mittel", "gut"]) {
  console.log(`  ${wohnlage}: ${rows.filter((r) => r.wohnlage === wohnlage).length}`);
}
