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

// 7. Negative signal: bike/school pair (deliberately absent from precomputed field)
//    is omitted from results. Mirrors the genuine fixture halfway through a 13.5h
//    precompute. All other profile/layer pairs are populated.
{
  const res = await suggest({ profile: "bike", w: "school:3,groceries:1" });
  check(
    res.status === 200,
    "request with unavailable profile/layer pair (bike+school) succeeds",
    `HTTP ${res.status}`
  );
  if (res.body.cells) {
    let schoolAbsent = true;
    for (const cell of res.body.cells) {
      if ("school" in cell.layers) {
        schoolAbsent = false;
        break;
      }
    }
    check(
      schoolAbsent,
      "school is absent from all bike result layers (fixture gap)",
      schoolAbsent ? "✓" : "found in at least one cell"
    );
  }
}

// 8. Profile handling: walk, wheelchair, and bike succeed; stroller returns 400
{
  const wheelchair = await suggest({ profile: "wheelchair", w: "groceries:2" });
  check(
    wheelchair.status === 200,
    "profile=wheelchair succeeds",
    `HTTP ${wheelchair.status}`
  );

  const bike = await suggest({ profile: "bike", w: "groceries:2" });
  check(
    bike.status === 200,
    "profile=bike succeeds",
    `HTTP ${bike.status}`
  );

  const stroller = await suggest({ profile: "stroller", w: "groceries:2" });
  check(
    stroller.status === 400,
    "profile=stroller returns 400",
    `HTTP ${stroller.status}`
  );
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

  // Invalid profile (stroller) lists valid profiles in error message
  const badProfile = await suggest({ profile: "stroller", w: "groceries:1" });
  const hasValidProfiles = badProfile.body.error?.includes("walk") && badProfile.body.error?.includes("wheelchair") && badProfile.body.error?.includes("bike");
  check(
    badProfile.status === 400 && hasValidProfiles,
    "invalid profile error lists valid profiles (walk, wheelchair, bike)",
    hasValidProfiles ? "✓" : `${badProfile.body.error?.slice(0, 60) ?? "no error"}`
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

// 11. Bike profile basic: returns 200, available=true, has cells
{
  const res = await suggest({ profile: "bike", w: "groceries:3,health:2,school:1" });
  check(res.status === 200, "bike profile returns 200", `HTTP ${res.status}`);
  check(res.body.available === true, "bike result has available=true", `available=${res.body.available}`);
  check(
    Array.isArray(res.body.cells) && res.body.cells.length > 0,
    "bike result has non-empty cells array",
    `${res.body.cells?.length ?? 0} cells`
  );
}

// 12. Bike invariants: at most 10 cells, non-increasing scores, 700m spread
{
  const res = await suggest({ profile: "bike", w: "groceries:3,health:2" });
  if (res.body.available && Array.isArray(res.body.cells)) {
    // Check at most 10 cells
    check(
      res.body.cells.length <= 10,
      "bike result has at most 10 cells",
      `${res.body.cells.length} cells`
    );

    // Check scores are non-increasing
    let sorted = true;
    for (let i = 1; i < res.body.cells.length; i++) {
      if (res.body.cells[i].score > res.body.cells[i - 1].score) {
        sorted = false;
        break;
      }
    }
    check(sorted, "bike cells sorted by descending score");

    // Check no two cells within 700m (same logic as test 5)
    if (res.body.cells.length > 1) {
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
      check(ok, "bike: no two cells within 700m", `min distance ${minDist.toFixed(0)}m`);
    }
  }
}

// 13. Per-profile decay: bike scores (300s decay) must vary more than walk scores
//     (900s decay). Without per-profile decay, bike would compress toward 1.0.
//     For a multi-layer bike vector, score range must be meaningful (use 0.2 as
//     threshold; tight but loose enough to not be brittle on re-seeds).
{
  const res = await suggest({ profile: "bike", w: "groceries:3,health:2,dining:1" });
  if (res.body.available && Array.isArray(res.body.cells) && res.body.cells.length > 1) {
    const scores = res.body.cells.map(c => c.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore;
    const ok = range >= 0.2;
    check(
      ok,
      "bike scores span meaningful range (≥0.2), not compressed at 1.0",
      `range ${(maxScore - minScore).toFixed(3)}, min ${minScore.toFixed(3)}, max ${maxScore.toFixed(3)}`
    );
  }
}

// 14. Tie determinism: same URL returns cells in identical order both times,
//     especially for single-layer queries (w=groceries:1) that put many cells
//     at exactly 1.0 and would produce arbitrary ordering without tiebreakers.
{
  const params = { profile: "walk", w: "groceries:1" };
  const res1 = await suggest(params);
  const res2 = await suggest(params);

  if (res1.body.cells && res2.body.cells && res1.body.cells.length === res2.body.cells.length) {
    let sameOrder = true;
    for (let i = 0; i < res1.body.cells.length; i++) {
      if (res1.body.cells[i].lat !== res2.body.cells[i].lat ||
          res1.body.cells[i].lon !== res2.body.cells[i].lon) {
        sameOrder = false;
        break;
      }
    }
    check(
      sameOrder,
      "same request returns cells in identical order (tie determinism)",
      sameOrder ? "✓" : "ordering differs"
    );
  }
}

console.log(`\n${14 - failed}/${14}`);
process.exit(failed ? 1 : 0);
