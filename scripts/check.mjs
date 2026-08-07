// smoke check: banded network comes back complete, and mobility profiles shrink.
// Run with the backend up:  node scripts/check.mjs
// Against a deployment:     API=https://iso.example.com node scripts/check.mjs
const API = process.env.API ?? "http://localhost:3001";
const LOCS = [
  [52.5, 13.42],
  [52.52, 13.405],
  [52.49, 13.39],
  [52.515, 13.4], // used to snap to a 13-node island; see main_component.sql
];

// A walk isochrone that reaches almost nothing means the origin snapped to a
// disconnected fragment of the graph.
const MIN_WALK_KM = 10;
const PROFILES = ["walk", "stroller", "wheelchair"];

// total length of a MultiLineString in rough km — the real measure of reach
const lengthKm = (geom) => {
  const lines =
    geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
  let km = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1];
      const [x2, y2] = line[i];
      const dy = (y2 - y1) * 111;
      const dx = (x2 - x1) * 111 * Math.cos((y1 * Math.PI) / 180);
      km += Math.hypot(dx, dy);
    }
  }
  return km;
};

const get = async (lat, lon, profile) => {
  const res = await fetch(
    `${API}/api/isochrone?lat=${lat}&lon=${lon}&minutes=15&profile=${profile}`
  );
  return res.json();
};

let failed = 0;

for (const [lat, lon] of LOCS) {
  const data = await get(lat, lon, "walk");
  const bands = data.geojson.features.map((f) => f.properties.band);
  // every band present, in order, none missing
  const complete =
    bands.length === data.bands && bands.every((b, i) => b === i + 1);
  if (!complete) failed++;
  console.log(
    `${complete ? "✅" : "❌"} bands ${lat},${lon} → ${bands.length}/${
      data.bands
    } [${bands.join(",")}]`
  );
}

// a wheelchair can never out-reach a walker over the same 15 minutes
for (const [lat, lon] of LOCS) {
  const km = {};
  for (const p of PROFILES) {
    const data = await get(lat, lon, p);
    km[p] = data.geojson.features.reduce(
      (sum, f) => sum + lengthKm(f.geometry),
      0
    );
  }
  // non-increasing, with slack: bands are simplified independently, so equal
  // street sets can differ in the last decimals
  const atMost = (a, b) => a <= b * 1.01 + 0.01;
  const ordered =
    atMost(km.stroller, km.walk) && atMost(km.wheelchair, km.stroller);
  // the walk graph is fully connected, so no origin should route nowhere
  const onMainComponent = km.walk >= MIN_WALK_KM;
  if (!ordered || !onMainComponent) failed++;
  console.log(
    `${ordered && onMainComponent ? "✅" : "❌"} profiles ${lat},${lon} → ` +
      PROFILES.map((p) => `${p} ${km[p].toFixed(1)}km`).join("  ") +
      (onMainComponent ? "" : `   ❌ walk under ${MIN_WALK_KM}km — island?`) +
      (km.walk > 5 && km.stroller < 1 ? "   ⚠️ stranded off-foot" : "")
  );
}

// T-011: amenities must say whether the area's POIs ever loaded. Berlin ships
// with its own, so an empty list here would mean genuinely nothing in reach —
// never "we don't know". `false` for a covered point is the bug this guards.
{
  const r = await fetch(
    `${API}/api/amenities?lat=52.52&lon=13.405&profile=walk&minutes=15`
  );
  const d = await r.json();
  const ok = d.poisLoaded === true && d.count > 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "✅" : "❌"} amenities → poisLoaded=${d.poisLoaded} count=${d.count}`
  );
}

process.exit(failed ? 1 : 0);
