// smoke check for the self-service importer: a point outside coverage can be
// imported on demand, and routes afterwards.
//
// Idempotent by design — it asks for the same small box every run, so the
// first run imports and every later run gets the dedup path instead of
// hammering Overpass and growing the disk.
//
//   node scripts/check-areas.mjs
//   API=https://iso.huseyincapan.dev node scripts/check-areas.mjs
const API = process.env.API ?? "http://localhost:3001";

// Ketzin/Havel — well outside Berlin's import, small and definitely walkable.
const LAT = 52.4785;
const LON = 12.8534;
const HALF_M = 1000;
const dLat = HALF_M / 111320;
const dLon = HALF_M / (111320 * Math.cos((LAT * Math.PI) / 180));

const box = {
  minLat: LAT - dLat,
  minLon: LON - dLon,
  maxLat: LAT + dLat,
  maxLon: LON + dLon,
};

let failed = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` → ${extra}` : ""}`);
};

const isochrone = (lat, lon) =>
  fetch(`${API}/api/isochrone?lat=${lat}&lon=${lon}&minutes=15`).then(
    async (r) => ({ status: r.status, body: await r.json() })
  );

// 1. the registry is reachable and knows about the shipped city
const areas = await (await fetch(`${API}/api/areas`)).json();
check(Array.isArray(areas), "GET /api/areas returns a list");
check(
  areas.some((a) => a.status === "ready"),
  "at least one ready area is registered",
  `${areas.length} total`
);

// 2. request the area — either a fresh job or the dedup path
const res = await fetch(`${API}/api/areas`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(box),
});
const job = await res.json();
check(res.ok, `POST /api/areas accepted (${res.status})`, JSON.stringify(job));

if (job.reused) {
  console.log("   (already imported — dedup path, no Overpass call)");
} else {
  // 3. poll to completion. Imports measured at 2-10s; allow for a queue.
  const deadline = Date.now() + 5 * 60_000;
  let status = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await (await fetch(`${API}/api/areas/${job.id}`)).json();
    if (s.status !== status) {
      status = s.status;
      console.log(`   status: ${status}${s.error ? ` (${s.error})` : ""}`);
    }
    if (status === "ready" || status === "failed") break;
  }
  check(status === "ready", "import reached 'ready'", status);
}

// 4. the point that was outside coverage now routes
const after = await isochrone(LAT, LON);
check(after.status === 200, "imported point returns an isochrone", `HTTP ${after.status}`);
if (after.status === 200) {
  const bands = after.body.geojson.features.map((f) => f.properties.band);
  // Sparse rural networks legitimately leave gaps, so assert reach, not a
  // complete 1..10 set the way the Berlin check does.
  check(bands.length > 0, "isochrone has bands", `${bands.length}/${after.body.bands}`);
}

// 5. asking again is a no-op, not a second import
const again = await (
  await fetch(`${API}/api/areas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(box),
  })
).json();
check(again.reused === true, "repeat request dedups instead of re-importing");

// 6. the size cap still refuses oversized boxes
const huge = await fetch(`${API}/api/areas`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ minLat: 52, minLon: 12, maxLat: 53, maxLon: 13 }),
});
check(huge.status === 400, "oversized box rejected", `HTTP ${huge.status}`);

process.exit(failed ? 1 : 0);
