// Assertion script for the livability suggestions endpoint (T-016).
// Checks scoring, ranking, validation, and caching against a precomputed reach field.
//
//   node scripts/check-suggest.mjs
//   API=https://iso.huseyincapan.dev node scripts/check-suggest.mjs
const API = process.env.API ?? "http://localhost:3001";

// Haversine distance in meters between two lat/lon points.
const haversineM = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

let failed = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` → ${extra}` : ""}`);
};

const suggest = async (params) => {
  const url = `${API}/api/suggest?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  return {
    url,
    status: res.status,
    body: await res.json(),
    headers: res.headers,
  };
};

// 1. available: true with non-empty cells array
{
  const res = await suggest({ profile: "walk", w: "groceries:3,health:2,school:1" });
  check(res.status === 200, "GET /api/suggest returns 200", `HTTP ${res.status}`);
  check(res.body.available === true, "available is true (data loaded)", `available=${res.body.available}`);
  check(
    Array.isArray(res.body.cells) && res.body.cells.length > 0,
    "cells is a non-empty array",
    `${res.body.cells?.length ?? 0} cells`
  );
}

// 2. Type checking: lat, lon are numbers, score is 0-1, layers is an object
{
  const res = await suggest({ profile: "walk", w: "groceries:3,health:2" });
  if (res.body.available && Array.isArray(res.body.cells)) {
    let allValid = true;
    for (const cell of res.body.cells) {
      const hasNumLat = typeof cell.lat === "number";
      const hasNumLon = typeof cell.lon === "number";
      const hasScore = typeof cell.score === "number" && cell.score >= 0 && cell.score <= 1;
      const hasLayers = typeof cell.layers === "object" && cell.layers !== null;
      if (!hasNumLat || !hasNumLon || !hasScore || !hasLayers) {
        allValid = false;
        break;
      }
    }
    check(allValid, "every cell has numeric lat/lon, score ∈ [0,1], layers object");
  }
}

// 3. Scores in non-increasing order
{
  const res = await suggest({ profile: "walk", w: "groceries:2,school:1" });
  if (res.body.available && Array.isArray(res.body.cells)) {
    let sorted = true;
    for (let i = 1; i < res.body.cells.length; i++) {
      if (res.body.cells[i].score > res.body.cells[i - 1].score) {
        sorted = false;
        break;
      }
    }
    check(sorted, "cells sorted by descending score");
  }
}

// 4. At most 10 cells
{
  const res = await suggest({ profile: "walk", w: "groceries:3,health:3,school:3,dining:3" });
  check(
    res.body.cells?.length <= 10,
    "at most 10 cells returned",
    `${res.body.cells?.length ?? 0} cells`
  );
}

// 5. No two cells within 700m (haversine), report minimum distance
{
  const res = await suggest({ profile: "walk", w: "groceries:2,health:2" });
  if (res.body.available && Array.isArray(res.body.cells) && res.body.cells.length > 1) {
    let minDist = Infinity;
    for (let i = 0; i < res.body.cells.length; i++) {
      for (let j = i + 1; j < res.body.cells.length; j++) {
        const d = haversineM(
          res.body.cells[i].lat,
          res.body.cells[i].lon,
          res.body.cells[j].lat,
          res.body.cells[j].lon
        );
        minDist = Math.min(minDist, d);
      }
    }
    const ok = minDist >= 700;
    check(ok, "no two cells within 700m", `min distance ${minDist.toFixed(0)}m`);
  }
}

// 6. Weight sensitivity: changing weights changes the ranking
{
  const res1 = await suggest({ profile: "walk", w: "groceries:3,school:0" });
  const res2 = await suggest({ profile: "walk", w: "groceries:1,school:3" });
  const top1 = res1.body.cells?.[0];
  const top2 = res2.body.cells?.[0];
  const different =
    top1 && top2 && (top1.lat !== top2.lat || top1.lon !== top2.lon);
  check(
    different,
    "weight changes affect ranking",
    different ? `top cell ${top1.lat},${top1.lon} vs ${top2.lat},${top2.lon}` : "no change"
  );
}

// 7. Negative signal: greenspace layer (no rows in seeded field) is omitted from results
{
  const res = await suggest({ profile: "walk", w: "groceries:2,greenspace:2" });
  check(
    res.status === 200,
    "request with unavailable layer (greenspace) succeeds",
    `HTTP ${res.status}`
  );
  if (res.body.cells) {
    let greenspaceAbsent = true;
    for (const cell of res.body.cells) {
      if ("greenspace" in cell.layers) {
        greenspaceAbsent = false;
        break;
      }
    }
    check(
      greenspaceAbsent,
      "greenspace is absent from all cell layers",
      greenspaceAbsent ? "✓" : "found in at least one cell"
    );
  }
}

// 8. Profile handling: wheelchair succeeds, stroller and bike return 400
{
  const wheelchair = await suggest({ profile: "wheelchair", w: "groceries:2" });
  check(
    wheelchair.status === 200,
    "profile=wheelchair succeeds",
    `HTTP ${wheelchair.status}`
  );

  const stroller = await suggest({ profile: "stroller", w: "groceries:2" });
  check(
    stroller.status === 400,
    "profile=stroller returns 400",
    `HTTP ${stroller.status}`
  );

  const bike = await suggest({ profile: "bike", w: "groceries:2" });
  check(bike.status === 400, "profile=bike returns 400", `HTTP ${bike.status}`);
}

// 9. 400 errors with error message
{
  // Unknown layer
  const badLayer = await suggest({ profile: "walk", w: "nosuchlayer:3" });
  check(
    badLayer.status === 400 && badLayer.body.error,
    "unknown layer returns 400 with error",
    `${badLayer.status} ${badLayer.body.error?.slice(0, 40) ?? ""}`
  );

  // Out-of-range weight (9 > max 3)
  const badWeight = await suggest({ profile: "walk", w: "groceries:9" });
  check(
    badWeight.status === 400 && badWeight.body.error,
    "out-of-range weight returns 400 with error",
    `${badWeight.status} ${badWeight.body.error?.slice(0, 40) ?? ""}`
  );

  // Malformed token (no colon)
  const malformed = await suggest({ profile: "walk", w: "groceries" });
  check(
    malformed.status === 400 && malformed.body.error,
    "malformed weight token returns 400 with error",
    `${malformed.status} ${malformed.body.error?.slice(0, 40) ?? ""}`
  );

  // All-zero weights
  const allZero = await suggest({ profile: "walk", w: "groceries:0,school:0" });
  check(
    allZero.status === 400 && allZero.body.error,
    "all-zero weights returns 400 with error",
    `${allZero.status} ${allZero.body.error?.slice(0, 40) ?? ""}`
  );

  // Missing w parameter
  const noW = await suggest({ profile: "walk" });
  check(
    noW.status === 400 && noW.body.error,
    "missing w parameter returns 400 with error",
    `${noW.status} ${noW.body.error?.slice(0, 40) ?? ""}`
  );
}

// 10. Caching: same URL twice returns identical JSON
{
  const params = { profile: "walk", w: "groceries:2,health:1,school:1" };
  const res1 = await suggest(params);
  const res2 = await suggest(params);
  const same = JSON.stringify(res1.body) === JSON.stringify(res2.body);
  check(same, "same request returns identical JSON (cached)", same ? "✓" : "responses differ");
}

console.log(`\n${10 - failed}/${10}`);
process.exit(failed ? 1 : 0);
