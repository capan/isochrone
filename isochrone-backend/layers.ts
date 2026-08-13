// Shared routing and scoring contract, imported by index.ts and by
// scripts/precompute-reach.ts.
//
// PROFILES and costExpr live here rather than in index.ts because the
// precompute has to traverse the graph with the *identical* cost expression the
// live endpoint uses. Two copies of it is the T-012 failure again: a pair that
// must agree, kept in two files, silently diverging.
//
// --- layers -------------------------------------------------------------
//
// Shared by the server and scripts/precompute-reach.ts on purpose: the two must
// agree on the layer set or the endpoint scores columns the precompute never
// filled. T-012 exists because exactly this kind of pair drifted once already.
//
// Seven layers, not PLACE_GROUPS' 57 kinds. The groups themselves are too broad
// to reuse here — "shops" contains hairdresser and florist, which say nothing
// about where to live. Every kind below is present in public.pois; measured
// Berlin counts as of 2026-08-11 are in the comments.
export const REACH_LAYERS = {
  dining: ["restaurant", "cafe", "fast_food", "bar", "pub"], // 12,179
  greenspace: ["park", "garden", "nature_reserve"], //           6,298
  playground: ["playground"], //                                5,615
  groceries: ["supermarket", "convenience", "bakery", "butcher", "greengrocer"], // 3,956
  health: ["pharmacy", "doctors", "clinic"], //                  2,480
  kindergarten: ["kindergarten"], //                            2,409
  school: ["school"], //                                        1,102
} as const;

export type ReachLayer = keyof typeof REACH_LAYERS;

// `stroller` is absent on purpose: its speed factors are uncalibrated estimates
// and must not be published as if measured.
export const REACH_PROFILES = ["walk", "wheelchair", "bike"] as const;

export type ReachProfile = (typeof REACH_PROFILES)[number];

// A profile is not just which field you read — it changes what "close" MEANS,
// and both numbers below have to move with it.
//
// The cap keeps the table to one row per *reachable* cell/layer: beyond it,
// absence is the answer. The decay is where a layer's score reaches zero, and is
// deliberately shorter than the cap so a 28-minute supermarket scores ~0 without
// being indistinguishable from no supermarket at all.
//
// Why bike is 600s and not 1800s: at 4.2 m/s a 1800s cap is a 7.5km radius and a
// 900s decay puts zero at 3.8km. Almost every cell in inner Berlin is within
// 3.8km of a supermarket, so every layer would score ~1, the scores would
// compress and the ranking would be noise. 600s lands bike on the same 2.5km
// footprint as walking — selective, and costing about the same to traverse
// because it explores the same area rather than 9x of it.
export const REACH_CAP_SECONDS: Record<ReachProfile, number> = {
  walk: 1800, //       2.5 km at 1.4 m/s
  wheelchair: 1800, // 1.6 km at 0.9 m/s
  bike: 600, //        2.5 km at 4.2 m/s
};

export const REACH_DECAY_SECONDS: Record<ReachProfile, number> = {
  walk: 900,
  wheelchair: 900,
  bike: 300,
};

// Same grid the POI dedup already snaps to (index.ts, ST_SnapToGrid 0.0006):
// ~41m x 67m at 52.5°N. Measured 134,280 cells for Berlin's 618,345
// main-component vertices — a 4.6x reduction. Do not introduce a second
// resolution; two grids that nearly agree are worse than one that is coarse.
export const REACH_CELL_DEGREES = 0.0006;

// Results are thinned so no two are closer than this, or the top ten are ten
// adjacent cells on the same street.
//
// Enforced greedily on a real distance, not by snapping to a grid: a grid
// guarantees one result per cell and says nothing about the gap *between*
// cells, so two cells either side of a boundary can be arbitrarily close.
// Measured before the fix, with a 0.01° grid: 139m between two results.
export const REACH_SPREAD_METERS = 700;

// Kept as the cheap pre-filter ahead of the greedy pass — it thins ~134k cells
// to a few hundred candidates without the O(n²) distance comparisons.
export const REACH_SPREAD_DEGREES = 0.01;

// How far anything — a user's click, or a POI being wired into the source set —
// may be from the routable graph before it stops counting as "here".
//
// One constant, used by both /api/isochrone and the precompute, because two
// nearly-agreeing snap limits are the same mistake as two nearly-agreeing grids
// (see REACH_CELL_DEGREES above). It lived in index.ts as a local MAX_SNAP_M for
// the click path only, which is exactly how the precompute came to have no bound
// at all: the guard existed, in a place the precompute could not see it.
//
// For clicks: a click farther than this from any routable street is outside the
// imported area. In-city snaps measure 7-67m; Paris would otherwise snap to
// Berlin's westernmost vertex and return a silent empty result.
//
// For POIs the same unbounded snap is worse than a silent empty result, because
// the super-source wires each source vertex at ZERO cost — so a POI is treated
// as sitting ON its nearest vertex however far away it really is. And a.bbox is
// a bounding BOX covering Brandenburg land with no imported streets, so
// Falkensee POIs snapped onto whichever Berlin boundary vertex was closest and
// stacked zeros on it. Measured: vertex 70954, a path dead end 1,764m from the
// nearest junction in an allotment strip off Havelländer Weg, collected 84 POIs
// from 1,468-3,950m away, read 0s for all four questionnaire layers, and ranked
// first at a perfect 1.0 while the nearest real shop was 2.8km off. 274 cells
// were wrong this way — 0.05% of rows and 100% of what a user saw, because a
// perfect score sorts to the top of every ranking.
//
// 500 works for both because the snap distribution is bimodal with a 12x gap:
// p50 25.7m, p99 226.1m, then p99.5 2,861m and a worst case of 15,711m. Anything
// from 300m to 1km separates real from teleported, so this is not a value worth
// tuning — it only has to land in the gap.
export const MAX_SNAP_METERS = 500;

// --- density (T-019) --------------------------------------------------------
//
// "Graph gates, density ranks." Seconds-to-nearest answers "is there one?", and
// in a dense city the answer is always yes — four cells scoring exactly 1.0000
// held 308, 111, 75 and 32 restaurants within 800m, and the score called them
// identical. Reachability is a good gate and a useless ranking.
//
// So each reach row also carries `nearby`: how many POIs of that layer sit
// within the profile's density radius. Straight-line, not graph distance.
// Validated rather than assumed: Spearman rank correlation against the
// graph-true reachable count over a sample of cells is 0.983, while the absolute
// ratio wanders between 0.50 and 1.52. Ranking needs the order, not the
// magnitude, and the graph still decides what is reachable at all — a layer with
// no reach row contributes nothing however many POIs are nearby.
export const DENSITY_DETOUR_FACTOR = 0.75;

// decay x speed is how far the score reaches; the detour factor turns that
// along-the-graph distance into the straight-line radius that contains it.
// Measured: walk 945m, wheelchair 608m, bike 945m — walk and bike come out
// identical, which is not a coincidence but ADR-0017 working as intended (bike's
// 300s decay was chosen to cover the same footprint as walk's 900s).
export const densityRadiusMeters = (profile: ReachProfile) =>
  Math.round(
    REACH_DECAY_SECONDS[profile] * PROFILES[profile].speed * DENSITY_DETOUR_FACTOR
  );

// What counts as "plenty" per layer, so one layer cannot swamp the others —
// dining is 27x school, so a shared constant would make every score a dining
// score. Measured over all 134,280 Berlin cells at the walk radius:
//
//   layer          p90   p99   p99.9   max
//   dining         181   486     584   621
//   greenspace      49   338     775   784
//   groceries       52   110     140   155
//   health          29    81     116   145
//   playground      53    77      95   106
//   kindergarten    27    50      60    69
//   school          11    18      22    25
//
// p99, and the first attempt used p90 and did not work. The ten results of any
// query are the densest cells in the city by construction — they live in the
// extreme tail, not at p90 — so a p90 bar capped every one of them at 1.0 and
// reproduced the exact saturation density was added to fix: groceries-only
// returned ten cells holding 55 to 140 shops, all scoring 1.0000. p99 puts that
// same spread across 0.86 to 1.00. Not the max, which is outlier-driven
// (greenspace 784 is one cell ringed by many tiny garden polygons).
//
// Measured at the walk radius and reused for all profiles. Wheelchair's radius
// is smaller so its counts run lower against the same bar, which shifts its
// absolute scores down but not its ranking — every cell in one query is compared
// at the same radius, and ranking is all this feeds.
export const DENSITY_PLENTY: Record<keyof typeof REACH_LAYERS, number> = {
  dining: 486,
  greenspace: 338,
  groceries: 110,
  health: 81,
  playground: 77,
  kindergarten: 50,
  school: 18,
};

// Reachability keeps half the weight, density earns the other half:
//
//   layer_score = reach x (DENSITY_FLOOR + (1 - DENSITY_FLOOR) x density)
//
// Multiplying by density alone would zero a layer that IS reachable but sits in
// a thin area, and a straight-line radius is not exact enough to justify that.
// The floor keeps the graph primary and lets density order what the gate lets
// through. Measured on the four cells that used to tie at 1.0000: they now score
// 1.00, 0.95, 0.91, 0.83 on dining.
export const DENSITY_FLOOR = 0.5;

// The one place this is expressed. Both the server's backfill and the offline
// precompute call it, because T-018 was caused by a guard that existed in
// index.ts where the precompute could not see it.
//
// Projected to EPSG:25833 (UTM 33N, correct for Berlin) and compared as planar
// metres. NOT geography: the same join with ::geography did not finish in ten
// minutes, because each of ~7.7M candidate pairs pays spheroid math.
//
// Written against the base tables on purpose. The first version wrapped both
// sides in CTEs, which have no indexes, so the spatial join degraded to a nested
// loop and one profile was still running after 11 minutes. `ST_Transform` is
// immutable enough to index, so idx_pois_geom_utm and idx_reach_cells_geom_utm
// (created as migrations in index.ts) let the planner do this as an index join
// instead — 5.8s for dining in the temp-table equivalent. Both indexes must
// exist or this is slow rather than wrong; the migration log says if they do not.
export const nearbyUpdateSql = (schema: string, profile: ReachProfile) => {
  const radius = densityRadiusMeters(profile);
  const layerValues = Object.entries(REACH_LAYERS)
    .map(([layer, kinds]) => `('${layer}', ARRAY[${kinds.map((k) => `'${k}'`).join(",")}])`)
    .join(", ");
  return `
    WITH lk(layer, kinds) AS (VALUES ${layerValues}),
    counted AS (
      SELECT c.id AS cell_id, lk.layer, count(*)::int AS n
        FROM ${schema}.reach_cells c
        JOIN lk ON true
        JOIN public.pois p
          ON p.kind = ANY(lk.kinds)
         AND ST_DWithin(
               ST_Transform(c.geom, 25833),
               ST_Transform(p.geom, 25833),
               ${radius})
       GROUP BY c.id, lk.layer
    )
    UPDATE ${schema}.reach r
       SET nearby = LEAST(counted.n, 32767)
      FROM counted
     WHERE r.cell_id = counted.cell_id
       AND r.layer = counted.layer
       AND r.profile = '${profile}';

    -- Second statement, and not optional. The join above only touches rows that
    -- HAVE a nearby POI, so without this every "reachable within the cap but
    -- nothing inside the density radius" row stays NULL — 72,339 of them for
    -- walk. NULL has to keep meaning exactly one thing ("not backfilled"),
    -- because scoreSuggestions reads it as "score as if density did not exist";
    -- letting it also mean zero would score the emptiest cells as the fullest.
    UPDATE ${schema}.reach
       SET nearby = 0
     WHERE profile = '${profile}' AND nearby IS NULL`;
};

// Coverage is drawn from the graph's own footprint, not from an area's bbox.
//
// A bbox is a rectangle and a city is not. Berlin's bbox is 1,793 km² while the
// graph only has streets in at most 1,012 km² of it, so 44% of the undimmed map
// was advertising data that is not there — a click 5,828m north-west of Frohnau,
// out past Velten, sat inside the rectangle and got refused by MAX_SNAP_METERS.
// The overlay was promising what the click check would deny.
//
// The mask is every routable vertex snapped to COVERAGE_GRID_DEGREES, each cell
// expanded by COVERAGE_EXPAND_DEGREES, unioned, then simplified.
//
// These three numbers are a budget, not taste. The mask MUST be a subset of
// "within MAX_SNAP_METERS of a routable vertex", or it undims ground the click
// check will refuse — the exact bug it was built to fix. Worst-case distance
// from a mask point to the vertex that put it there:
//
//   (GRID/2 + EXPAND + SIMPLIFY) degrees
//
// GRID/2 because ST_SnapToGrid moves a vertex up to half a cell before anything
// else happens, EXPAND because the box reaches that far past the snapped point,
// SIMPLIFY because ST_SimplifyPreserveTopology may push a boundary outward by
// its tolerance. At 52.5°N one degree is 111,320m of latitude and 67,800m of
// longitude, so the diagonal is ~130,340 m/deg:
//
//   (0.001 + 0.002 + 0.0005) x 130,340 = 456m  <= 500m  ✅
//
// The first version used 0.01/0.005/0.002 and reasoned that a ~680m x 1,110m
// cell was "close to MAX_SNAP_METERS". That was the wrong bound: cell size is
// not the error, GRID/2 + EXPAND + SIMPLIFY is, and those settings allowed
// 1,564m. Measured on the shipped mask: 15 of 400 sampled points were beyond
// 500m, worst 919m, and a click on Nuthestraße in Potsdam sat inside the mask
// while the nearest street was 835m away. With the numbers above, 0 of 598
// sampled points violate, worst 314m.
//
// Cost of being right: Berlin's mask goes from 215 points / 3.5KB to 3,095
// points / 48KB, and from 1,118 km² to 979 km² — it now under-claims slightly,
// which is the safe direction. Verify with the sampling query in
// scripts/check-coverage.mjs after changing any of these.
export const COVERAGE_GRID_DEGREES = 0.002;
export const COVERAGE_EXPAND_DEGREES = 0.002;
export const COVERAGE_SIMPLIFY_DEGREES = 0.0005;

// Weights are answers to questions, not free parameters: a closed 0..3 range is
// what keeps the whole answer space enumerable (648 combinations since T-017
// added the dog household option and the bike profile; 324 before), which is
// what makes warming the cache to 100% possible.
export const REACH_MAX_WEIGHT = 3;

// --- profiles (moved from index.ts, unchanged) ---------------------------

// Walking speed in m/s, plus per-way-type multipliers (0 = impassable).
// tag_id values come from the `configuration` table osm2pgrouting writes:
// 103 path, 104 steps, 105 living_street, 107 track.
// tag_id 113 (dedicated cycleway) is impassable on foot, so the three
// pedestrian profiles are unchanged by its arrival.
//
// `bike` at 4.2 m/s ≈ 15 km/h, an ordinary urban cycling average. It rides
// footways and pedestrian zones at pushing pace rather than treating them as
// walls, because a rider dismounts rather than turns back.
//
// It deliberately ignores one-way restrictions: osm2pgrouting records the
// `oneway` tag but not `oneway:bicycle=no`, and Berlin permits contraflow
// cycling on most one-way streets — enforcing the column we have would block
// streets riders legally use, which is the more wrong of the two answers.
export const PROFILES = {
  walk: { speed: 1.4, factors: { 104: 0.5, 113: 0 } },
  stroller: { speed: 1.2, factors: { 104: 0, 103: 0.6, 107: 0.6, 113: 0 } },
  wheelchair: {
    speed: 0.9,
    factors: { 104: 0, 103: 0, 107: 0, 105: 0.9, 113: 0 },
  },
  bike: {
    speed: 4.2,
    factors: { 104: 0, 101: 0.25, 102: 0.3, 103: 0.6, 107: 0.5 },
  },
} as const;

export type ProfileName = keyof typeof PROFILES;

// Builds the cost expression pgr_drivingDistance routes on. Numbers only —
// no user input reaches this string (profile names are whitelisted by callers).
//
// Note for anything reading berlin.ways directly: cost is recomputed from
// length_m here, never read from the stored cost_s column, which contains
// negative values (min -11.5 measured 2026-08-11) and is not what this app
// routes on.
export const costExpr = (name: ProfileName) => {
  const { speed, factors } = PROFILES[name];
  const cases = Object.entries(factors).map(
    ([tag, f]) =>
      `WHEN tag_id = ${tag} THEN ${f === 0 ? "-1" : `length_m / ${speed * f}`}`
  );
  return cases.length
    ? `CASE ${cases.join(" ")} ELSE length_m / ${speed} END`
    : `length_m / ${speed}`;
};
