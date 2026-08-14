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

// ~32 requests total by default: this is the only check script that spends its
// budget on one endpoint in a burst. The limiter allows 60 requests/minute per IP,
// and a 60-sample run (old ~20 req limit) consumed the whole window —
// check-suggest.mjs and check.mjs then failed with 429s that looked exactly like
// real regressions. With ~32 requests (SAMPLES=20 + DIM_SAMPLES=10), we stay
// comfortably under the limit; if you see 429, wait ~65s rather than reporting
// a failure. Raise via SAMPLES=/DIM_SAMPLES= only when running this script alone.
const SAMPLES = parseInt(process.env.SAMPLES ?? "20", 10);
const DIM_SAMPLES = parseInt(process.env.DIM_SAMPLES ?? "10", 10);

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

// The other direction: dimmed ground (inside ready areas but outside all coverage
// polygons) must be importable. Until T-023 fixed it, 1,185 km² of the 3,045 km²
// of ready bboxes was dimmed AND unimportable — 39%, answering `no street nearby`
// where the veil claimed nothing — and this script read 5/5 throughout, because
// it only ever asserted the other direction. A person clicking Altlandsberg found
// it. Not failures: `outside coverage` is correct (offers the import), and
// HTTP 200 is fine (mask is approximate, dimmed point can still be within
// MAX_SNAP_METERS of a street — that click works and nothing false is promised).
const areasRes = await fetch(`${API}/api/areas`);
check(areasRes.status === 200, "GET /api/areas", `HTTP ${areasRes.status}`);
const areas = await areasRes.json();
const readyAreas = Array.isArray(areas) ? areas.filter(a => a.status === "ready") : [];
check(readyAreas.length > 0, "found ready areas for dimming check", `${readyAreas.length}`);

// Sample points inside ready bboxes that fall outside all coverage polygons.
// These are exactly the points the veil dims.
const dimmedSamples = [];
let dimGuard = 0;
while (dimmedSamples.length < DIM_SAMPLES && dimGuard++ < DIM_SAMPLES * 400) {
  const area = readyAreas[Math.floor(rnd() * readyAreas.length)];
  const x = area.min_lon + rnd() * (area.max_lon - area.min_lon);
  const y = area.min_lat + rnd() * (area.max_lat - area.min_lat);
  // Keep only points outside every polygon's outer ring (holes are not dimmed).
  if (polys.every(p => !inRing(p[0], x, y))) {
    dimmedSamples.push([y, x]);
  }
}
check(
  dimmedSamples.length === DIM_SAMPLES,
  `sampled ${DIM_SAMPLES} dimmed points`,
  `${dimmedSamples.length}`
);

// A dimmed point that returns `no street nearby` is unimportable: the resolver
// matched an area for a point the veil says is uncovered, but the UI offers the
// import button only for `outside coverage`. That ground is unfixable.
const unimportable = [];
for (const [lat, lon] of dimmedSamples) {
  const r = await fetch(
    `${API}/api/isochrone?lat=${lat}&lon=${lon}&profile=walk&minutes=15`
  );
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    // body.error is the machine-readable code, body.detail the prose. Compare the
    // code: detail carries a measured distance and is never equal to it, so
    // reading detail here silently makes this assertion unfailable.
    if (body.error === "no street nearby") {
      unimportable.push({ lat, lon, detail: body.detail ?? body.error });
    }
  }
}
check(
  unimportable.length === 0,
  "every dimmed point is importable",
  unimportable.length
    ? `${unimportable.length}/${dimmedSamples.length} unimportable, e.g. ${unimportable[0].lat.toFixed(4)},${unimportable[0].lon.toFixed(4)}: ${unimportable[0].detail}`
    : `${dimmedSamples.length}/${dimmedSamples.length} importable`
);

const TOTAL = 9;
console.log(`\n${TOTAL - failed}/${TOTAL}`);
process.exit(failed ? 1 : 0);
