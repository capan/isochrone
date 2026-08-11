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
