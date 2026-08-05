// smoke check: banded network comes back complete, and mobility profiles shrink.
// Run with the backend up: node scripts/check.mjs
const LOCS = [
  [52.5, 13.42],
  [52.52, 13.405],
  [52.49, 13.39],
];
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
    `http://localhost:3001/api/isochrone?lat=${lat}&lon=${lon}&minutes=15&profile=${profile}`
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
  if (!ordered) failed++;
  console.log(
    `${ordered ? "✅" : "❌"} profiles ${lat},${lon} → ` +
      PROFILES.map((p) => `${p} ${km[p].toFixed(1)}km`).join("  ") +
      (km.walk > 5 && km.stroller < 1 ? "   ⚠️ stranded off-foot" : "")
  );
}

process.exit(failed ? 1 : 0);
