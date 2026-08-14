// Assertion script for the coverage overlay (ADR-0020).
//
//   node scripts/check-coverage.mjs
//   API=https://iso.huseyincapan.dev node scripts/check-coverage.mjs
//
// The one property that matters: undimmed ground must be clickable. The overlay
// says "there is data here" and /api/isochrone decides whether there really is,
// using MAX_SNAP_METERS. If the mask is bigger than what the snap accepts, the
// map promises what the click denies — which shipped twice, first as a bbox
// (44% of Berlin's rectangle had no streets) and then as a mask whose grid
// arithmetic was wrong (15 of 400 points beyond 500m, worst 919m).
//
// So this samples real points inside the served polygon and clicks them.
const API = process.env.API ?? "http://localhost";

// 20, not more, because this is the only check script that spends its budget on
// one endpoint in a burst. The limiter allows 60 requests/minute per IP, and a
// 60-sample run consumed the whole window — check-suggest.mjs and check.mjs then
// failed with 429s that looked exactly like real regressions. Raise via
// SAMPLES= only when running this script alone.
const SAMPLES = parseInt(process.env.SAMPLES ?? "20", 10);

let failed = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` → ${extra}` : ""}`);
};

const res = await fetch(`${API}/api/coverage`);
check(res.status === 200, "GET /api/coverage", `HTTP ${res.status}`);
const geo = await res.json();
check(
  geo && (geo.type === "MultiPolygon" || geo.type === "Polygon"),
  "coverage is a polygon geometry",
  geo?.type ?? "null"
);

const polys = geo.type === "MultiPolygon" ? geo.coordinates : [geo.coordinates];
check(polys.length > 0, "coverage has at least one polygon", `${polys.length}`);

// Deterministic pseudo-random point in a polygon's bbox, rejected until inside.
// Ray casting rather than a dependency; the outer ring is all that matters here
// because holes are ground we correctly do not claim.
const inRing = (ring, x, y) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const samples = [];
let guard = 0;
while (samples.length < SAMPLES && guard++ < SAMPLES * 400) {
  const ring = polys[Math.floor(rnd() * polys.length)][0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs));
  const y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys));
  if (inRing(ring, x, y)) samples.push([y, x]);
}
check(samples.length === SAMPLES, `sampled ${SAMPLES} points inside coverage`, `${samples.length}`);

// The assertion. A refused click inside the mask is the bug; an empty-but-200
// isochrone is fine, that spot is on the network and just cannot reach far.
const refused = [];
for (const [lat, lon] of samples) {
  const r = await fetch(
    `${API}/api/isochrone?lat=${lat}&lon=${lon}&profile=walk&minutes=15`
  );
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    refused.push({ lat, lon, detail: body.detail ?? body.error ?? `HTTP 400` });
  }
}
check(
  refused.length === 0,
  "every sampled point inside coverage is clickable",
  refused.length
    ? `${refused.length}/${samples.length} refused, e.g. ${refused[0].lat.toFixed(4)},${refused[0].lon.toFixed(4)}: ${refused[0].detail}`
    : `${samples.length}/${samples.length} accepted`
);

const TOTAL = 5;
console.log(`\n${TOTAL - failed}/${TOTAL}`);
process.exit(failed ? 1 : 0);
