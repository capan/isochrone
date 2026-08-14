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

const suggestGrid = async (params) => {
  const url = `${API}/api/suggest-grid?${new URLSearchParams(params)}`;
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

// 7. Every profile/layer pair is populated. This assertion used to be its
//    inverse — it required school to be ABSENT for bike, because it was written
//    against a field that was still half-computed and school/bike genuinely had
//    no rows yet. The completed run gave that pair 123,203 cells, so the old
//    assertion was asserting the fixture rather than the behaviour, and it kept
//    passing afterwards only because stale suggest2: cache entries were still
//    being served. Assert the real contract instead: a layer with rows shows up.
{
  const res = await suggest({ profile: "bike", w: "school:3,groceries:1" });
  check(
    res.status === 200,
    "bike + school request succeeds",
    `HTTP ${res.status}`
  );
  if (res.body.cells?.length) {
    const withSchool = res.body.cells.filter((c) => "school" in c.layers).length;
    check(
      withSchool > 0,
      "school appears in bike results now that school/bike is populated",
      `${withSchool}/${res.body.cells.length} cells`
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

// 13. Per-profile decay is actually applied (T-017): bike scores on 300s, walk
//     on 900s (REACH_DECAY_SECONDS in layers.ts).
//
//     This used to assert "bike score range >= 0.2, not compressed at 1.0",
//     which was the wrong test for the right worry. Against the complete field
//     the top ten legitimately all score 1.0 — bike/groceries:3,health:2,dining:1
//     has 230 such cells out of 130,541, i.e. 0.18%, which is the decay being
//     selective, not compressed. Top-of-list saturation is expected whenever a
//     grid cell contains one of every requested amenity, and Berlin has hundreds
//     of those. Recompute the score from the seconds the response already
//     reports instead — that pins the decay exactly and cannot be satisfied by
//     the wrong constant.
const DECAY = { walk: 900, wheelchair: 900, bike: 300 };
const PLENTY = { dining: 486, greenspace: 338, groceries: 110, health: 81,
                 playground: 77, kindergarten: 50, school: 18 };
const FLOOR = 0.5;
for (const [profile, w] of [["bike", "school:2,health:2,dining:1"], ["walk", "school:2,health:2,dining:1"]]) {
  const res = await suggest({ profile, w });
  const weights = Object.fromEntries(w.split(",").map((t) => t.split(":")).map(([l, n]) => [l, +n]));
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const cells = res.body.cells ?? [];
  // A cell where every layer is 0s scores 1.0 under any decay, so it cannot
  // distinguish 300 from 900. Only cells with a nonzero reading are evidence.
  const witness = cells.find((c) => Object.values(c.layers).some((s) => s > 0));
  if (!witness) {
    check(false, `${profile}: found a cell with nonzero seconds to check decay against`, "all cells 0s");
  } else {
    // Mirrors scoreSuggestions since T-019: reachability gates, density ranks.
    // These constants must track DENSITY_PLENTY / DENSITY_FLOOR in layers.ts —
    // the whole point of recomputing the score here is to catch the day one of
    // them changes and the other does not.
    const expected =
      Object.entries(witness.layers).reduce((acc, [layer, secs]) => {
        const reach = Math.max(0, 1 - secs / DECAY[profile]);
        const n = witness.nearby?.[layer] ?? 0;
        const density = Math.min(1, Math.log1p(n) / Math.log1p(PLENTY[layer]));
        return acc + weights[layer] * reach * (FLOOR + (1 - FLOOR) * density);
      }, 0) / total;
    const ok = Math.abs(expected - witness.score) < 0.001;
    check(
      ok,
      `${profile} score matches the ${DECAY[profile]}s decay + density formula`,
      `expected ${expected.toFixed(4)}, got ${witness.score.toFixed(4)} from ${JSON.stringify(witness.layers)} nearby ${JSON.stringify(witness.nearby ?? {})}`
    );
  }
}

// 13b. Tie-breaking must not sort the map. Saturated queries have far more
//      perfect cells than the ten returned, and breaking those ties by latitude
//      returned the southernmost ten — a 5.7km band on the city limit, with
//      Mitte and Prenzlauer Berg scoring identically and never shown.
//
//      This used to assert a minimum latitude span, which no longer separates
//      the bug from correct behaviour: since T-019 ranks by density, the winners
//      legitimately cluster in the dense centre (measured span 0.0702 against a
//      0.08 threshold and a 0.0510 span for the actual bug — too close to call).
//      Test the bug's signature instead. Ordering by latitude makes the returned
//      latitudes monotonically increasing within a run of equal scores; md5 does
//      not. That is immune to how tightly density packs the results.
{
  const res = await suggest({ profile: "bike", w: "groceries:3,health:2,dining:1" });
  const cells = res.body.cells ?? [];
  if (cells.length > 2) {
    const ascending = cells.every((c, i) => i === 0 || c.lat >= cells[i - 1].lat);
    const descending = cells.every((c, i) => i === 0 || c.lat <= cells[i - 1].lat);
    check(
      !ascending && !descending,
      "results are not ordered by latitude (md5 tie-break, not a geographic sort)",
      `lats ${cells.map((c) => c.lat.toFixed(3)).join(" ")}`
    );
  }
}

// 14. /api/suggest-grid basic checks: available and dimensions present
{
  const res = await suggestGrid({ profile: "walk", w: "groceries:3,school:2" });
  check(res.status === 200, "GET /api/suggest-grid returns 200", `HTTP ${res.status}`);
  check(res.body.available === true, "grid available is true", `available=${res.body.available}`);
  check(
    typeof res.body.cols === "number" && res.body.cols > 0 && typeof res.body.rows === "number" && res.body.rows > 0,
    "grid has numeric cols and rows > 0",
    `cols=${res.body.cols}, rows=${res.body.rows}`
  );
  check(
    typeof res.body.origin === "object" && typeof res.body.origin.lat === "number" && typeof res.body.origin.lon === "number",
    "grid has numeric origin.lat and origin.lon",
    `origin=${JSON.stringify(res.body.origin)}`
  );
  check(
    typeof res.body.step === "number" && res.body.step > 0,
    "grid has numeric step > 0",
    `step=${res.body.step}`
  );
}

// 15. Decoded scores length matches cols * rows
{
  const res = await suggestGrid({ profile: "walk", w: "groceries:3,school:2" });
  if (res.status === 200 && res.body.scores) {
    const decoded = Buffer.from(res.body.scores, "base64");
    const expected = res.body.cols * res.body.rows;
    check(
      decoded.length === expected,
      "decoded scores length is exactly cols * rows",
      `${decoded.length} bytes vs expected ${expected}`
    );
  }
}

// 16. Scores contain both 0 (no-data) and 255 (best) values
{
  const res = await suggestGrid({ profile: "walk", w: "groceries:3,school:2" });
  if (res.status === 200 && res.body.scores) {
    const decoded = Buffer.from(res.body.scores, "base64");
    const hasZero = decoded.some((b) => b === 0);
    const has255 = decoded.some((b) => b === 255);
    check(hasZero, "scores contain at least one 0 (no-data)", hasZero ? "✓" : "all nonzero");
    check(has255, "scores contain at least one 255 (best)", has255 ? "✓" : "max < 255");
  }
}

// 17. Top suggestion from /api/suggest agrees with the grid heatmap
//     The top cell should have a high score in the grid (>= 230, top decile)
{
  const res = await suggestGrid({ profile: "walk", w: "groceries:3,school:2" });
  const suggestRes = await suggest({ profile: "walk", w: "groceries:3,school:2" });

  if (res.status === 200 && suggestRes.status === 200 && res.body.scores) {
    const decoded = Buffer.from(res.body.scores, "base64");
    const topCell = suggestRes.body.cells?.[0];

    if (topCell) {
      // Compute grid indices from cell lat/lon
      // Row: origin.lat - r*step = cell.lat => r = (origin.lat - cell.lat) / step
      // Col: origin.lon + c*step = cell.lon => c = (cell.lon - origin.lon) / step
      const r = Math.round((res.body.origin.lat - topCell.lat) / res.body.step);
      const c = Math.round((topCell.lon - res.body.origin.lon) / res.body.step);

      if (r >= 0 && r < res.body.rows && c >= 0 && c < res.body.cols) {
        const score = decoded[r * res.body.cols + c];
        const threshold = 230;
        check(
          score >= threshold,
          `top suggestion is in grid top decile (score >= ${threshold})`,
          `grid score at (${r},${c}) = ${score}, suggest score = ${topCell.score.toFixed(4)}`
        );
      } else {
        check(false, "top suggestion in grid bounds", `out of bounds: (${r},${c}) not in [0,${res.body.rows})x[0,${res.body.cols})`);
      }
    }
  }
}

// 18. Invalid inputs to /api/suggest-grid are rejected with matching errors to /api/suggest
//     This ensures validation was not duplicated and cannot drift between endpoints
{
  // Unknown layer
  const gridBadLayer = await suggestGrid({ profile: "walk", w: "nosuchlayer:3" });
  const suggestBadLayer = await suggest({ profile: "walk", w: "nosuchlayer:3" });
  check(
    gridBadLayer.status === 400 && suggestBadLayer.status === 400 &&
    gridBadLayer.body.error === suggestBadLayer.body.error,
    "unknown layer: grid and suggest return same 400 error",
    gridBadLayer.status === 400 ? "✓" : `grid=${gridBadLayer.status}, suggest=${suggestBadLayer.status}`
  );

  // Out-of-range weight (9 > max 3)
  const gridBadWeight = await suggestGrid({ profile: "walk", w: "groceries:9" });
  const suggestBadWeight = await suggest({ profile: "walk", w: "groceries:9" });
  check(
    gridBadWeight.status === 400 && suggestBadWeight.status === 400 &&
    gridBadWeight.body.error === suggestBadWeight.body.error,
    "out-of-range weight: grid and suggest return same 400 error",
    gridBadWeight.status === 400 ? "✓" : `grid=${gridBadWeight.status}, suggest=${suggestBadWeight.status}`
  );

  // Malformed token (no colon)
  const gridMalformed = await suggestGrid({ profile: "walk", w: "groceries" });
  const suggestMalformed = await suggest({ profile: "walk", w: "groceries" });
  check(
    gridMalformed.status === 400 && suggestMalformed.status === 400 &&
    gridMalformed.body.error === suggestMalformed.body.error,
    "malformed weight token: grid and suggest return same 400 error",
    gridMalformed.status === 400 ? "✓" : `grid=${gridMalformed.status}, suggest=${suggestMalformed.status}`
  );

  // All-zero weights
  const gridAllZero = await suggestGrid({ profile: "walk", w: "groceries:0,school:0" });
  const suggestAllZero = await suggest({ profile: "walk", w: "groceries:0,school:0" });
  check(
    gridAllZero.status === 400 && suggestAllZero.status === 400 &&
    gridAllZero.body.error === suggestAllZero.body.error,
    "all-zero weights: grid and suggest return same 400 error",
    gridAllZero.status === 400 ? "✓" : `grid=${gridAllZero.status}, suggest=${suggestAllZero.status}`
  );
}

// 19. stroller profile returns 400 on suggest-grid (no reach field)
{
  const res = await suggestGrid({ profile: "stroller", w: "groceries:2" });
  check(
    res.status === 400,
    "profile=stroller returns 400 on suggest-grid",
    `HTTP ${res.status}`
  );
}

const TOTAL = 15 + 5 + 1 + 2 + 1 + 4 + 1;
console.log(`\n${TOTAL - failed}/${TOTAL}`);
process.exit(failed ? 1 : 0);
