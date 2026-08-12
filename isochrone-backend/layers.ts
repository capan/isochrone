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

// Coverage is drawn from the graph's own footprint, not from an area's bbox.
//
// A bbox is a rectangle and a city is not. Berlin's bbox is 1,793 km² while the
// graph only has streets in at most 1,012 km² of it, so 44% of the undimmed map
// was advertising data that is not there — a click 5,828m north-west of Frohnau,
// out past Velten, sat inside the rectangle and got refused by MAX_SNAP_METERS.
// The overlay was promising what the click check would deny.
//
// The mask is every routable vertex snapped to this grid, each cell expanded to
// a full box, unioned and simplified. Measured on Berlin: 1,479 cells, 425 ring
// points, 215 after simplification, 3,499 bytes of GeoJSON, covering 1,118 km².
// 3.4KB is cheap enough that this can be served on every poll.
//
// 0.01° is ~680m x 1,110m at 52.5°N, so a cell is generous by up to ~550m at its
// edges — deliberately close to MAX_SNAP_METERS above. The overlay and the snap
// limit are then answering the same question at the same resolution, which is
// what stops them disagreeing again. Do not tighten one without the other.
export const COVERAGE_GRID_DEGREES = 0.01;
export const COVERAGE_SIMPLIFY_DEGREES = 0.002;

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
