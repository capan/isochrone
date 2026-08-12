// scripts/precompute-reach.ts
//
// Offline batch job for T-016 ("where should I live"). Fills
// <schema>.reach_cells and <schema>.reach: for every grid cell, the seconds
// to the nearest place in each of the 7 REACH_LAYERS, for each of the 3
// REACH_PROFILES (21 traversals total). See
// tickets/todo/T-016-livability-suggestions.md for the design and the
// measurements this script is built around, and
// tickets/todo/T-017-bike-modal-dog.md for why the traversal cap is now
// per-profile rather than a single constant.
//
// DO NOT RUN THIS AGAINST PRODUCTION, OR ANY LIVE DATABASE. A full-city
// pgr_drivingDistance takes 21.8 minutes on the CX23 (berlin.ways_vertices_pgr
// = 649,899 rows, berlin.ways = 809,619 rows) — that is expected here, this
// script is offline and unattended, but it means the traversal cannot be
// babysat. Worse: pgRouting ignores statement_timeout and pg_cancel_backend
// while it is inside its C loop, so a runaway traversal can only be stopped
// with pg_terminate_backend from a second session, and that lands minutes
// late. Run this against a copy of the database on a machine that is not
// serving traffic.
//
// Note there is NO code-level guard enforcing this, despite ADR-0015 claiming
// one — PGHOST defaults to 127.0.0.1, which is a default, not a refusal. The
// rule is documentation only. ADR-0019 records the one run that overrode it
// (Berlin, 2026-08-12, on the box, by owner decision) and what it measured.
//
// Expected runtime, both figures now measured on the full Berlin graph rather
// than projected (the earlier ~39 min/traversal here was an extrapolation of
// the n^2.18 curve about 10x past its data points, and overshot by 1.8x):
//
//   M5 laptop, 2026-08-12:  ~400s per traversal, 2h20m for all 21
//   Hetzner CX23 (2 vCPU):  ~1300s per traversal, ~7.6h for all 21
//
// Cost is graph-size bound, not source-count bound — nearest-of-N costs the
// same as nearest-of-one (see the super-source trick below). Measured: dining
// has 12,179 POIs and playground 5,620, and their walk traversals differ by
// under 2%. The bike traversal costs about the same as walk per pair despite
// the higher speed, because its cap is chosen to explore the same ~2.5km
// footprint (see REACH_CAP_SECONDS in layers.ts) rather than several times
// more of the graph.
// Idempotent and resumable: an operator can lose the ssh session and rerun
// the identical command; already-complete (layer, profile) pairs are
// skipped, not recomputed (see "resumability" below).
//
// Invocation — run from scripts/, the same way precompute.ts does
// ("start:pre" in scripts/package.json), because scripts/ is the ESM package
// (package.json "type":"module") and its tsconfig is what makes an
// extension-less import of isochrone-backend/layers.ts resolve at all
// (experimentalSpecifierResolution: "node"):
//
//   cd scripts && node --loader ts-node/esm precompute-reach.ts
//
// Same env vars index.ts reads, same defaults. SCHEMA exists only so this can
// be smoke-tested against a small graph; it is not a way to run this per
// imported area (T-016 is Berlin-only, see the ticket's non-goals):
//
//   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... SCHEMA=berlin \
//     node --loader ts-node/esm precompute-reach.ts

import { Pool, PoolClient } from "pg";
import { createRequire } from "node:module";
import path from "node:path";
// Type-only: erased at compile time, so it does not hit the runtime
// ESM<->CJS interop problem the require() below exists to route around.
import type { ReachProfile } from "../isochrone-backend/layers";

// scripts/ is an ESM package (package.json "type":"module"); isochrone-backend/
// compiles to CommonJS. A static `import` of layers.ts across that boundary hits
// Node's still-experimental ESM<->CJS interop for TS-compiled output (measured:
// named imports fail with "named export not found", and — on this box's Node
// 26 — even a namespace import throws ERR_REQUIRE_CYCLE_MODULE inside ts-node's
// loader). A synchronous require(), forced through ts-node's classic CommonJS
// compile hook, sidesteps that entirely: it compiles layers.ts under its own
// (CommonJS) tsconfig and hands back the real module.exports object, no
// loader-interop guessing involved.
const req = createRequire(path.join(process.cwd(), "package.json"));
req("ts-node/register");
const layers = req("../isochrone-backend/layers") as typeof import("../isochrone-backend/layers");
const {
  REACH_LAYERS,
  REACH_PROFILES,
  REACH_CAP_SECONDS,
  REACH_CELL_DEGREES,
  costExpr,
} = layers;
type ReachLayer = keyof typeof REACH_LAYERS;

const SCHEMA = process.env.SCHEMA ?? "berlin";

const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "password",
  database: process.env.PGDATABASE ?? "osm_db",
  // 5454, not pg's 5432: docker-compose publishes the db there and index.ts
  // carries the same default. Omitting it sends an operator to ECONNREFUSED
  // against a stack that is running fine.
  port: parseInt(process.env.PGPORT ?? "5454", 10),
  // Serial batch job, one traversal at a time by design — max:1 so a bug that
  // fires two combinations concurrently contends for the connection instead
  // of contending for CPU on a graph traversal that already takes an hour.
  max: 1,
});

// Comfortably above any real vertex id (main graph tops out at 649,899) —
// same constant the ticket's traversal form uses.
const SUPER_SOURCE = 2_000_000_000;

const elapsed = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function ensureTables(client: PoolClient) {
  // Deliberately duplicated with index.ts's startup block, not left to it: an
  // operator runs this against a fresh restore on a machine where the app has
  // never started, so the tables may genuinely not exist yet. Both sides are
  // CREATE ... IF NOT EXISTS and must stay byte-identical in shape — if they
  // ever disagree, the traversal writes rows the endpoint cannot read.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.reach_cells (
      id   serial PRIMARY KEY,
      geom geometry(Point,4326) NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.reach (
      cell_id integer  NOT NULL REFERENCES ${SCHEMA}.reach_cells(id),
      layer   text     NOT NULL,
      profile text     NOT NULL,
      seconds smallint NOT NULL,
      PRIMARY KEY (cell_id, layer, profile)
    );
    CREATE INDEX IF NOT EXISTS idx_reach_layer_profile ON ${SCHEMA}.reach (layer, profile);
  `);
}

async function populateReachCells(client: PoolClient) {
  const {
    rows: [{ n: existing }],
  } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.reach_cells`
  );
  if (existing > 0) {
    // Guard the resume path against REACH_CELL_DEGREES having changed since the
    // run that filled this table. The traversal joins its output back to
    // reach_cells by re-running the identical snap and comparing for equality,
    // so a changed constant matches nothing, commits a near-empty row set, and
    // combinationDone then marks the pair complete — a silent partial result at
    // hour 12 of a 13.5-hour run, which is the worst way to find out.
    const {
      rows: [{ n: expected }],
    } = await client.query<{ n: number }>(
      `SELECT count(DISTINCT ST_SnapToGrid(geom, ${REACH_CELL_DEGREES}))::int AS n
         FROM ${SCHEMA}.ways_vertices_pgr WHERE main_component`
    );
    if (expected !== existing) {
      throw new Error(
        `${SCHEMA}.reach_cells holds ${existing} cells but the current ` +
          `REACH_CELL_DEGREES=${REACH_CELL_DEGREES} yields ${expected}. The grid ` +
          `changed since this table was filled. Drop ${SCHEMA}.reach and ` +
          `${SCHEMA}.reach_cells and start over — resuming would silently ` +
          `produce partial rows.`
      );
    }
    console.log(`reach_cells: already populated (${existing} cells)`);
    return;
  }
  console.log(
    `reach_cells: populating from ${SCHEMA}.ways_vertices_pgr WHERE main_component...`
  );
  const t0 = Date.now();
  // Same grid the POI dedup snaps to (index.ts ST_SnapToGrid, ~0.0006deg).
  // Reusing it — rather than picking a resolution for this feature — is what
  // lets a cell's id be looked up later by re-running the identical snap on a
  // vertex's geom and comparing for equality, no KNN needed at insert time.
  const { rowCount } = await client.query(
    `INSERT INTO ${SCHEMA}.reach_cells (geom)
       SELECT DISTINCT ST_SnapToGrid(geom, ${REACH_CELL_DEGREES})
         FROM ${SCHEMA}.ways_vertices_pgr
        WHERE main_component
       ON CONFLICT (geom) DO NOTHING`
  );
  console.log(
    `reach_cells: inserted ${rowCount} cells (${elapsed(t0)}) — measured 134,280 for Berlin`
  );
}

async function combinationDone(
  client: PoolClient,
  layer: string,
  profile: string
): Promise<boolean> {
  // A combination's insert runs inside one transaction (below), so any row
  // present for (layer, profile) means the whole pair committed — there is no
  // half-filled state a kill can leave behind that this check would miss.
  const r = await client.query(
    `SELECT 1 FROM ${SCHEMA}.reach WHERE layer = $1 AND profile = $2 LIMIT 1`,
    [layer, profile]
  );
  return (r.rowCount ?? 0) > 0;
}

async function buildSourceVertices(
  client: PoolClient,
  kinds: readonly string[],
  layer: string,
  profile: string
) {
  const poiCount = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.pois p
       JOIN public.areas a ON a.schema_name = $2
      WHERE p.kind = ANY($1::text[]) AND ST_Contains(a.bbox, p.geom)`,
    [kinds, SCHEMA]
  );

  // Temp table, not a giant inline VALUES list — this is the source set the
  // traversal below is wired to. DISTINCT because several POIs commonly snap
  // to the same nearest vertex (a row of shops on one street), and a vertex
  // wired in twice would cost nothing extra but is worth not doing.
  await client.query(`DROP TABLE IF EXISTS src`);
  await client.query(
    `CREATE TEMP TABLE src AS
       SELECT DISTINCT nearest.vid
         FROM public.pois p
         JOIN public.areas a ON a.schema_name = $2
         JOIN LATERAL (
           SELECT v.id AS vid
             FROM ${SCHEMA}.ways_vertices_pgr v
            WHERE v.main_component
            ORDER BY v.geom <-> p.geom
            LIMIT 1
         ) nearest ON true
        WHERE p.kind = ANY($1::text[]) AND ST_Contains(a.bbox, p.geom)`,
    [kinds, SCHEMA]
  );
  const vertexCount = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM src`
  );

  console.log(
    `${layer}/${profile}: ${poiCount.rows[0].n} POIs -> ${vertexCount.rows[0].n} distinct vertices ` +
      `(snapping is free — 1,405 supermarkets measured at 1.2s)`
  );
  return vertexCount.rows[0].n;
}

async function runTraversal(
  client: PoolClient,
  layer: string,
  profile: ReachProfile
): Promise<number> {
  console.log(
    `${layer}/${profile}: starting pgr_drivingDistance from the virtual super-source ` +
      `(cap ${REACH_CAP_SECONDS[profile]}s). This is the step that can run long — a full-city ` +
      `traversal did not finish in 10 minutes when measured. statement_timeout will not ` +
      `help; only pg_terminate_backend can stop it.`
  );
  const t0 = Date.now();

  // One Dijkstra from a zero-cost virtual super-source (id 2000000000) wired
  // to every source vertex settles each real vertex at its distance to the
  // NEAREST member of src, by construction — nearest-of-N costs the same as
  // nearest-of-one, so the source set is never iterated over. That is the
  // trick the whole feature runs on (see the ticket).
  //
  // Insert is wrapped in one transaction: it is a single INSERT...SELECT, so
  // it is already atomic, but the transaction makes that explicit and means a
  // kill mid-run leaves nothing for combinationDone() to see, hence nothing
  // to skip incorrectly on resume.
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO ${SCHEMA}.reach (cell_id, layer, profile, seconds)
         SELECT rc.id, $1::text, $2::text,
                ROUND(MIN(dd.agg_cost)::numeric)::smallint AS seconds
           FROM pgr_drivingDistance(
                  $$SELECT id, source, target,
                           ${costExpr(profile)} AS cost,
                           ${costExpr(profile)} AS reverse_cost
                      FROM ${SCHEMA}.ways
                     UNION ALL
                    SELECT ${SUPER_SOURCE} + row_number() OVER (), ${SUPER_SOURCE}, vid, 0, 0
                      FROM src$$,
                  ${SUPER_SOURCE}, ${REACH_CAP_SECONDS[profile]}, false
                ) dd
           JOIN ${SCHEMA}.ways_vertices_pgr v ON v.id = dd.node
           JOIN ${SCHEMA}.reach_cells rc ON rc.geom = ST_SnapToGrid(v.geom, ${REACH_CELL_DEGREES})
          WHERE dd.node < ${SUPER_SOURCE}
          GROUP BY rc.id`,
      [layer, profile]
    );
    await client.query("COMMIT");
    console.log(`${layer}/${profile}: done — ${ins.rowCount} cells reached (${elapsed(t0)})`);
    return ins.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`${layer}/${profile} failed: ${(err as Error).message}`);
  }
}

async function printSummary(client: PoolClient) {
  const { rows } = await client.query<{
    layer: string;
    profile: string;
    cells: number;
    pct: string;
    mean_s: string;
    max_s: number;
  }>(
    `SELECT layer, profile, count(*) AS cells,
            ROUND(100.0 * count(*) / NULLIF((SELECT count(*) FROM ${SCHEMA}.reach_cells), 0), 1) AS pct,
            ROUND(AVG(seconds)::numeric, 0) AS mean_s,
            MAX(seconds) AS max_s
       FROM ${SCHEMA}.reach
      GROUP BY layer, profile
      ORDER BY layer, profile`
  );
  console.log("\n=== reach summary ===");
  console.table(
    rows.map((r) => ({
      layer: r.layer,
      profile: r.profile,
      cells: r.cells,
      "% of cells": r.pct,
      "mean s": r.mean_s,
      "max s": r.max_s,
    }))
  );
}

async function main() {
  const client = await pool.connect();
  // One session for the whole run: the source-vertex temp table has to
  // survive across the queries that build it, traverse from it and aggregate
  // it, and a pooled connection with max:1 is not guaranteed to be the same
  // physical session between calls unless explicitly checked out once here.
  try {
    await ensureTables(client);
    await populateReachCells(client);

    const areaCheck = await client.query(
      `SELECT 1 FROM public.areas WHERE schema_name = $1`,
      [SCHEMA]
    );
    if ((areaCheck.rowCount ?? 0) === 0) {
      throw new Error(
        `no public.areas row for schema_name='${SCHEMA}' — cannot determine the bbox to scope POI queries`
      );
    }

    const layerNames = Object.keys(REACH_LAYERS) as ReachLayer[];
    for (const layer of layerNames) {
      const kinds = REACH_LAYERS[layer];
      for (const profile of REACH_PROFILES) {
        if (await combinationDone(client, layer, profile)) {
          console.log(`${layer}/${profile}: already in ${SCHEMA}.reach, skipping`);
          continue;
        }
        const sources = await buildSourceVertices(client, kinds, layer, profile);
        // A layer with no POIs in this bbox would otherwise build the whole
        // 810k-edge graph, reach nothing, insert nothing — and so never count
        // as done, repeating the same wasted traversal on every future run.
        // Warn loudly instead: a silently absent layer scores 0 everywhere and
        // the questionnaire question driving it stops meaning anything.
        if (sources === 0) {
          console.warn(
            `${layer}/${profile}: ⚠️ no POIs in ${SCHEMA} — skipping traversal. ` +
              `This layer will be absent from scoring.`
          );
          continue;
        }
        await runTraversal(client, layer, profile);
      }
    }

    await printSummary(client);
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`precompute-reach: failed — ${(err as Error).message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
