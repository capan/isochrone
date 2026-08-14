// src/index.ts
import express from "express";
import { Pool } from "pg";
import cors from "cors";
import { createClient } from "redis";
import rateLimit, { MemoryStore } from "express-rate-limit";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  REACH_LAYERS,
  REACH_PROFILES,
  REACH_DECAY_SECONDS,
  ReachProfile,
  REACH_SPREAD_DEGREES,
  REACH_SPREAD_METERS,
  REACH_MAX_WEIGHT,
  DENSITY_PLENTY,
  DENSITY_FLOOR,
  nearbyUpdateSql,
  MAX_SNAP_METERS,
  COVERAGE_GRID_DEGREES,
  COVERAGE_EXPAND_DEGREES,
  COVERAGE_SIMPLIFY_DEGREES,
  PROFILES,
  ProfileName,
  costExpr,
} from "./layers";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());
const port = parseInt(process.env.PORT ?? "3001", 10);

// A 60-minute walk costs ~25s of CPU and returns ~4.5MB — anyone could send
// that in a loop, so this is a DoS control, not just a UX limit.
const MAX_MINUTES = parseInt(process.env.MAX_MINUTES ?? "25", 10);

// Caddy is the only thing in front, so trust exactly one hop. Without this
// every request looks like it came from the proxy and the whole internet
// shares one bucket; trusting blindly instead lets clients spoof the header.
app.set("trust proxy", 1);

let cacheHits = 0;
let cacheMisses = 0;

const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT ?? "6363", 10),
  },
  database: 1,
  // fail commands immediately while disconnected instead of queueing them,
  // so a redis outage can't make /healthz hang
  disableOfflineQueue: true,
});
// Without this, a dropped socket is an unhandled 'error' event and node exits.
redis.on("error", (err) => console.error("⚠️ redis:", (err as Error).message));
redis.connect().catch(console.error);

// The cache is an optimization, not a dependency: if redis is down the API
// should get slower, not fall over.
const cacheGet = async (key: string) => {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
};
const cacheSet = async (key: string, value: string, ttlSeconds: number) => {
  try {
    await redis.set(key, value, { EX: ttlSeconds });
  } catch {
    /* cache write failures are not request failures */
  }
};

app.use(cors());

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.PGHOST ?? "127.0.0.1",
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "password",
  database: process.env.PGDATABASE ?? "osm_db",
  port: parseInt(process.env.PGPORT ?? "5454", 10),
  // import_city.sh imports each city into its own schema
  options: `-c search_path=${process.env.CITY ?? "berlin"},public`,
  // backstop for anything that gets past MAX_MINUTES
  statement_timeout: 15000,
});

// MAX_MINUTES bounds CPU, but it was calibrated at walking speed: cost tracks
// the *area* the bbox pre-filter hands pgRouting, so 25min of cycling covers
// 9x the ground and measured 21s on the production box — past the 15s
// statement_timeout and back into the DoS vector the cap exists to close.
// Bounding reach instead keeps every profile's cost comparable.
//
// Measured cold on the CX23 (bike from Alexanderplatz): 2016m→1.8s,
// 2520m→3.3s, 3024m→8.0s, 3780m→21.1s. 2520m buys the bike twice the walking
// radius — enough that the two profiles plainly differ — for 3.3s, where the
// next step up costs 8s of first-click latency to gain little.
const MAX_REACH_M = parseInt(process.env.MAX_REACH_M ?? "2520", 10);

const maxMinutesFor = (p: ProfileName) =>
  Math.min(MAX_MINUTES, Math.floor(MAX_REACH_M / (60 * PROFILES[p].speed)));

// Time slices the client paints with a 10-step sequential ramp.
const BANDS = 10;

// --- self-service area import ------------------------------------------
// Each imported area gets its own schema (osm2pgrouting numbers vertices from
// 1 on every import, so one shared table would need id remapping; a schema
// also makes deletion a DROP instead of a bloat-generating DELETE).
const DEFAULT_SCHEMA = process.env.CITY ?? "berlin";

// osm2pgrouting assigns the tag_ids that PROFILES keys off. There are two
// mapconfig.xml files in this repo and only this one is pedestrian-tagged —
// the other is car-oriented (steps=122), which would silently apply the
// wheelchair rules to the wrong way types.
const MAPCONFIG = process.env.MAPCONFIG ??
  path.join(__dirname, "../overpass/osm-imports/mapconfig.xml");
const MAIN_COMPONENT_SQL = process.env.MAIN_COMPONENT_SQL ??
  path.join(__dirname, "../scripts/main_component.sql");
const OVERPASS_URL =
  process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL =
  process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL =
  process.env.NOMINATIM_REVERSE_URL ?? "https://nominatim.openstreetmap.org/reverse";

// Both OSM services want an identifying agent in their usage policy, and
// Overpass's Apache goes further: it answers Node's default UA ("node") with a
// 406 before the query is ever parsed.
const USER_AGENT = "isochrone/0.1 (+https://iso.huseyincapan.dev)";

// The UI offers a 5×5km box, so this has to sit above 25. Remember the buffer
// roughly triples it: 25km² requested imports ~85km².
const MAX_AREA_KM2 = parseFloat(process.env.MAX_AREA_KM2 ?? "30");

// Imports are permanent and the box has 40GB. Postgres refusing writes is a
// far worse failure than an area being evicted, so stay well short.
//
// Enforced by measuring after each import rather than estimating before one:
// 6.5MB/km² holds for dense Berlin but overpredicts a sparse rural box by
// ~50×, which would evict half the cache to make room for 3MB.
const MAX_IMPORT_MB = parseInt(process.env.MAX_IMPORT_MB ?? "4000", 10);

// Real bytes, not an estimate of what we think we wrote. Only area_* schemas
// count — the shipped city isn't part of the user-imported budget.
const importedMb = async () => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) / 1048576.0 AS mb
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname LIKE 'area\\_%'`
  );
  return parseFloat(r.rows[0].mb);
};

// Overpass 429s if you sprint through a queue; these are politeness, not tuning.
const OVERPASS_PAUSE_MS = parseInt(process.env.OVERPASS_PAUSE_MS ?? "5000", 10);
const RETRY_PAUSE_MS = parseInt(process.env.RETRY_PAUSE_MS ?? "20000", 10);
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Import a wider box than we serve: an isochrone starting near the edge walks
// out past it, and a clipped network looks like a real answer instead of a
// missing one. MAX_MINUTES at walking speed is the furthest anyone can get.
const BUFFER_M = MAX_MINUTES * 60 * PROFILES.walk.speed;

// The Overpass filter is derived from mapconfig rather than restated, so it
// can't drift into fetching ways osm2pgrouting would then discard.
const walkableHighways = () => {
  const xml = fs.readFileSync(MAPCONFIG, "utf8");
  const block = xml.match(/<tag_name name="highway"[\s\S]*?<\/tag_name>/)?.[0] ?? "";
  return [...block.matchAll(/tag_value name="([^"]+)"/g)].map((m) => m[1]);
};

// Guards the worker loop, not the API: requests are queued in `public.areas`
// and drained one at a time so two osm2pgrouting runs can't fight over a
// 2-vCPU box — nobody is turned away, they just wait their turn.
let importInFlight = false;

// "jobs in front of this one" — defined once so the number returned at enqueue
// and the number the poller reports can't disagree.
const aheadSql = (alias: string) =>
  `SELECT count(*) FROM public.areas q
    WHERE q.status IN ('queued','importing') AND q.created_at < ${alias}.created_at`;

const ensureAreasTable = async () => {
  // POIs are points, unrelated to any routing graph, so they live in one
  // global table: Berlin was loaded from its own extract, imported areas add
  // to it, and overlapping imports dedup on the OSM id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.pois (
      osm_type char(1) NOT NULL,
      osm_id   bigint  NOT NULL,
      category text    NOT NULL,
      kind     text    NOT NULL,
      name     text,
      geom     geometry(Point,4326) NOT NULL,
      PRIMARY KEY (osm_type, osm_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pois_geom ON public.pois USING GIST (geom);
    CREATE INDEX IF NOT EXISTS idx_pois_kind ON public.pois (kind);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.areas (
      id            serial PRIMARY KEY,
      schema_name   text UNIQUE,
      bbox          geometry(Polygon, 4326) NOT NULL,
      imported_bbox geometry(Polygon, 4326) NOT NULL,
      status        text NOT NULL DEFAULT 'queued',
      error         text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS error text;
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
    -- NULL = the POI fetch never succeeded for this area. A *successful* fetch
    -- stamps it even when it returns nothing, which is the only way to tell a
    -- genuinely amenity-free rural box from one whose fetch failed.
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS pois_at timestamptz;
    -- NULL = never reverse-geocoded, or the lookup failed. The UI falls back to
    -- coordinates in that case. No backfill for existing rows: this is stamped
    -- once, at import time, same as pois_at.
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS name text;
    -- NULL = the graph footprint has not been dissolved for this area yet, and
    -- /api/coverage falls back to its bbox. Backfilled once at startup rather
    -- than by a migration, because it is derived data that any schema can
    -- regenerate from its own vertices. See COVERAGE_GRID_DEGREES in layers.ts
    -- for why the overlay must not be drawn from bbox.
    ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS coverage geometry(MultiPolygon, 4326);
    CREATE INDEX IF NOT EXISTS idx_areas_bbox ON public.areas USING GIST (bbox);
  `);
  // Names for suggestion results, keyed on coordinates rather than cell_id
  // because cell ids are reassigned by every precompute while the grid is
  // deterministic. NULL name = Nominatim answered but had nothing, which is a
  // real answer and must not be retried on a loop; the row's existence is what
  // stops the retry. Separate from the Redis revgeo: cache on purpose — that
  // one has a 7-day TTL and does not survive a flush, and re-asking a public
  // service for 275 places every time someone clears a cache is not acceptable
  // use of it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.place_names (
      lat  numeric(8,4) NOT NULL,
      lon  numeric(8,4) NOT NULL,
      name text,
      looked_up_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (lat, lon)
    );
  `);
  // T-016: the reach field — seconds from every routable cell to its nearest
  // amenity, per layer and profile — precomputed offline by
  // scripts/precompute-reach.ts (see layers.ts for why offline, and why
  // absence rather than a sentinel value means unreachable). Lives in
  // DEFAULT_SCHEMA, not public, because it is derived from that schema's
  // graph the same way ways_vertices_pgr is; imported area_* schemas never
  // get one (see /api/suggest below). Created empty here so a fresh stack has
  // these tables rather than missing them — the endpoint can then tell "no
  // data yet" (empty) from a genuine bug (missing) instead of throwing.
  //
  // Guarded like the shipped-city INSERT below: DEFAULT_SCHEMA itself may not
  // exist yet on a fresh deployment with no city imported, and CREATE TABLE
  // inside a schema that doesn't exist throws.
  await pool
    .query(
      `CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.reach_cells (
         id   serial PRIMARY KEY,
         geom geometry(Point,4326) NOT NULL UNIQUE
       );
       CREATE TABLE IF NOT EXISTS ${DEFAULT_SCHEMA}.reach (
         cell_id integer  NOT NULL REFERENCES ${DEFAULT_SCHEMA}.reach_cells(id),
         layer   text     NOT NULL,
         profile text     NOT NULL,
         seconds smallint NOT NULL,
         PRIMARY KEY (cell_id, layer, profile)
       );
       CREATE INDEX IF NOT EXISTS idx_reach_layer_profile
         ON ${DEFAULT_SCHEMA}.reach (layer, profile);`
    )
    .catch((err) =>
      console.log(`ℹ️ no ${DEFAULT_SCHEMA} schema for reach tables yet:`, err.message)
    );

  // Each of these runs as its OWN statement, with its own catch, deliberately.
  // Grouping migrations into one multi-statement query means the slowest one
  // takes the rest down with it: `CREATE INDEX ... USING GIST` over 134,280 cells
  // exceeds the 15s statement_timeout, and when it did, the `ALTER ... ADD COLUMN
  // nearby` in the same block rolled back — which then failed all 648 warm-pass
  // answers and, because that left the naming set empty, produced a `VALUES ()`
  // syntax error three layers away. The same shape cost us the coverage column
  // earlier (ADR-0020), so it is fixed here rather than noted again.
  //
  // statement_timeout is lifted per statement, on one dedicated client, because
  // index builds are legitimately slower than any request should ever be.
  const migrations: [string, string][] = [
    [
      "reach.nearby",
      `ALTER TABLE ${DEFAULT_SCHEMA}.reach ADD COLUMN IF NOT EXISTS nearby smallint`,
    ],
    [
      "reach_cells GIST",
      `CREATE INDEX IF NOT EXISTS idx_reach_cells_geom
         ON ${DEFAULT_SCHEMA}.reach_cells USING GIST (geom)`,
    ],
    // Functional indexes on the projected geometry. Without BOTH of these the
    // density join has no index to use and falls back to a nested loop over
    // 134,280 cells x 24,986 POIs — measured still running after 11 minutes,
    // against 5.8s with them.
    [
      "reach_cells UTM GIST",
      `CREATE INDEX IF NOT EXISTS idx_reach_cells_geom_utm
         ON ${DEFAULT_SCHEMA}.reach_cells USING GIST (ST_Transform(geom, 25833))`,
    ],
    [
      "pois UTM GIST",
      `CREATE INDEX IF NOT EXISTS idx_pois_geom_utm
         ON public.pois USING GIST (ST_Transform(geom, 25833))`,
    ],
  ];
  for (const [label, sql] of migrations) {
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = 0");
      await client.query(sql);
    } catch (err) {
      console.log(`ℹ️ migration ${label} skipped:`, (err as Error).message);
    } finally {
      // The pool reuses this connection for requests, where an unlimited
      // statement_timeout is exactly what the 15s default exists to prevent.
      await client.query("SET statement_timeout = '15s'").catch(() => {});
      client.release();
    }
  }

  // The shipped city is a schema, not an imported area. Give it a row so the
  // map can draw every covered region from one endpoint instead of special
  // casing it. Harmless if the schema isn't present (fresh deployment).
  await pool
    .query(
      `INSERT INTO public.areas (schema_name, bbox, imported_bbox, status)
       SELECT $1, ST_SetSRID(ST_Extent(geom)::geometry, 4326),
                  ST_SetSRID(ST_Extent(geom)::geometry, 4326), 'ready'
         FROM ${DEFAULT_SCHEMA}.ways_vertices_pgr WHERE main_component
        HAVING ST_Extent(geom) IS NOT NULL
       ON CONFLICT (schema_name) DO NOTHING`,
      [DEFAULT_SCHEMA]
    )
    .catch((err) =>
      console.log(`ℹ️ no ${DEFAULT_SCHEMA} schema to register:`, err.message)
    );

  // The shipped city's POIs came from its own extract, not from Overpass, so
  // stamp it loaded — otherwise the backfill sweep would try to re-fetch a
  // whole city's amenities through the public API, one bbox the size of Berlin.
  await pool.query(
    `UPDATE public.areas SET pois_at = now()
      WHERE schema_name = $1 AND pois_at IS NULL`,
    [DEFAULT_SCHEMA]
  );

  // Every area imported before pois_at existed reads as "never loaded", and
  // most of them loaded fine. Re-fetching them all would be a few thousand
  // needless Overpass calls for rows already sitting in public.pois — so take
  // the evidence that is already here and only sweep what it can't vouch for.
  const stamped = await pool.query(
    `UPDATE public.areas a SET pois_at = a.created_at
      WHERE a.pois_at IS NULL
        AND EXISTS (SELECT 1 FROM public.pois p WHERE p.geom && a.bbox)
     RETURNING id`
  );
  if (stamped.rowCount) {
    console.log(`🍽️ ${stamped.rowCount} area(s) already had POIs; marked loaded`);
  }

  // A crash mid-import leaves a row claiming 'importing' forever, and its
  // schema half-built; re-queue it so the worker redoes it cleanly.
  const stuck = await pool.query(
    `UPDATE public.areas SET status = 'queued' WHERE status = 'importing'
     RETURNING id`
  );
  if (stuck.rowCount) console.log(`↻ re-queued ${stuck.rowCount} stuck import(s)`);
};

// Dissolve a schema's routable vertices into the polygon the map should veil
// around. See COVERAGE_GRID_DEGREES in layers.ts for the measurements and for
// why a bbox is the wrong shape.
//
// main_component only, matching the vertex snap in /api/isochrone: a click that
// lands on a disconnected fragment routes nowhere, so drawing it as covered
// would reintroduce the same lie at a smaller scale.
const computeCoverage = async (areaId: number, schemaName: string) => {
  const r = await pool.query<{ g: string | null; had_vertices: boolean }>(
    `WITH g AS (
       SELECT DISTINCT ST_SnapToGrid(geom, $1) AS c
         FROM ${schemaName}.ways_vertices_pgr
        WHERE main_component
     ),
     m AS (
       SELECT ST_SimplifyPreserveTopology(ST_Union(ST_Expand(c, $2)), $3) AS mask
         FROM g
     -- Clipped to the area's own bbox, which is not cosmetic. ST_Expand pushes
     -- the mask up to EXPAND degrees (~222m) past vertices on the box edge, and
     -- /api/isochrone selects a schema by bbox containment — so an unclipped
     -- mask claims a rim that no schema will ever route, and the click is
     -- refused inside undimmed ground. Measured before clipping: 33 of 40
     -- sampled points refused, one of them 6,086m from any street, because
     -- area_61's mask spilled outside area_61's bbox into a part of Berlin that
     -- Berlin's own mask correctly excludes.
     --
     -- ST_CollectionExtract(..., 3) rather than ST_Multi: where the mask meets
     -- the bbox edge along a line or at a point, ST_Intersection returns a
     -- GeometryCollection of polygons plus lower-dimensional scraps. ST_Multi
     -- promotes that collection without flattening it, and the UPDATE into the
     -- MultiPolygon column then raises "Geometry type (GeometryCollection) does
     -- not match column type (MultiPolygon)" — measured on area_36 in prod.
     -- CollectionExtract(3) keeps only the polygonal parts; ST_Multi on top of
     -- it is redundant here specifically because the destination column is
     -- geometry(MultiPolygon,4326) and its typmod coerces a bare Polygon on
     -- assignment — CollectionExtract itself can still return a plain Polygon
     -- for a non-collection input, so don't drop the cast if this expression
     -- is ever reused against an untyped target. It also turns a fully
     -- degenerate intersection (nothing polygonal survives) into an EMPTY
     -- MultiPolygon rather than NULL, so had_vertices below is what tells
     -- storeCoverage apart from the "no routable vertices at all" case — an
     -- EMPTY mask must not be stored, or the area vanishes from the veil
     -- instead of falling back to its bbox.
     ), clip AS (
       SELECT ST_CollectionExtract(ST_Intersection(m.mask, a.bbox), 3) AS g,
              m.mask IS NOT NULL AS had_vertices
         FROM m JOIN public.areas a ON a.id = $4
     )
     SELECT CASE WHEN ST_IsEmpty(g) THEN NULL ELSE g::text END AS g, had_vertices
       FROM clip`,
    [
      COVERAGE_GRID_DEGREES,
      COVERAGE_EXPAND_DEGREES,
      COVERAGE_SIMPLIFY_DEGREES,
      areaId,
    ]
  );
  const row = r.rows[0];
  return {
    mask: row?.g ?? null,
    // True only when vertices existed but clipping left nothing polygonal —
    // distinct from "no routable vertices" so storeCoverage can log the truth.
    emptyIntersection: Boolean(row?.had_vertices) && !row?.g,
  };
};

const storeCoverage = async (areaId: number, schemaName: string) => {
  try {
    const { mask, emptyIntersection } = await computeCoverage(areaId, schemaName);
    if (emptyIntersection) {
      console.warn(
        `⚠️ ${schemaName}: mask/bbox intersection had no polygonal area, coverage left as bbox`
      );
      return;
    }
    if (!mask) {
      console.warn(`⚠️ ${schemaName}: no routable vertices, coverage left as bbox`);
      return;
    }
    await pool.query(`UPDATE public.areas SET coverage = $2 WHERE id = $1`, [
      areaId,
      mask,
    ]);
  } catch (err) {
    // A failed dissolve must not fail an import or block startup — the COALESCE
    // in /api/coverage keeps serving the bbox, which is what shipped before.
    console.error(`⚠️ coverage for ${schemaName} failed:`, (err as Error).message);
  }
};

// Fills reach.nearby from THIS machine's public.pois (T-019). Deliberately
// computed where it is served rather than shipped in the dump: the count is a
// straight-line spatial join, cheap enough to redo (~6s per profile, measured),
// and recomputing locally is what keeps density free of the build-vs-serve POI
// drift that ADR-0022 records for `seconds`.
//
// Runs when any row is missing it — after a restore, or after the POI sweep has
// changed what is on the ground. Uses nearbyUpdateSql from layers.ts so the
// server and scripts/precompute-reach.ts cannot disagree about the radius or the
// projection; a guard that lived in only one of them is what caused T-018.
const backfillNearby = async () => {
  try {
    const todo = await pool.query<{ profile: string }>(
      `SELECT DISTINCT profile FROM ${DEFAULT_SCHEMA}.reach WHERE nearby IS NULL`
    );
    if (!todo.rowCount) return;
    const t0 = Date.now();
    for (const { profile } of todo.rows) {
      if (!(REACH_PROFILES as readonly string[]).includes(profile)) continue;
      // Own client with the timeout lifted: this is a spatial join over every
      // cell and every POI of seven layers — 5.8s for dining alone, measured —
      // so it cannot run under the 15s request timeout. It is startup work, not
      // request work, and nothing serves from it until it lands.
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = 0");
        await client.query(nearbyUpdateSql(DEFAULT_SCHEMA, profile as ReachProfile));
      } finally {
        await client.query("SET statement_timeout = '15s'").catch(() => {});
        client.release();
      }
    }
    console.log(
      `📊 density backfilled for ${todo.rowCount} profile(s) in ${Date.now() - t0}ms`
    );
  } catch (err) {
    // Never fatal. A NULL nearby scores exactly as the field did before density
    // existed (see COALESCE in scoreSuggestions), so the feature degrades to the
    // old behaviour rather than breaking the endpoint.
    if ((err as any).code === "42P01" || (err as any).code === "42703") return;
    console.error("⚠️ density backfill failed:", (err as Error).message);
  }
};

// One-off per area, not a migration: derived from vertices, so any schema can
// regenerate it. Serial rather than concurrent — this runs at startup alongside
// the queue drain and the suggest warm pass, and Berlin's dissolve alone reads
// 618,345 vertices.
const backfillCoverage = async () => {
  let pending;
  try {
    pending = await pool.query<{ id: number; schema_name: string }>(
      `SELECT id, schema_name FROM public.areas
        WHERE status = 'ready' AND coverage IS NULL ORDER BY created_at`
    );
  } catch (err) {
    // Same 42703 case as /api/coverage: the column's ALTER lost to a precompute
    // holding public.areas. Nothing to backfill into yet — the endpoint is
    // serving bboxes and the next restart will pick this up.
    if ((err as any).code !== "42703") throw err;
    console.warn("⚠️ areas.coverage missing; serving bboxes until it exists");
    return;
  }
  if (!pending.rowCount) return;
  const t0 = Date.now();
  for (const row of pending.rows) await storeCoverage(row.id, row.schema_name);
  console.log(
    `🗺️ dissolved coverage for ${pending.rowCount} area(s) in ${
      Date.now() - t0
    }ms`
  );
};

// Which schema answers for this point: the smallest imported area containing
// it, else the city this deployment shipped with.
//
// The same statement stamps last_used_at so eviction can be least-recently-
// used rather than merely oldest. The stamp is throttled to once per 10
// minutes per area, so the common case updates no rows and writes no WAL —
// that is what makes LRU affordable on a read path.
const resolveSchema = async (lat: number, lon: number) => {
  const r = await pool.query(
    `WITH pick AS (
       SELECT id, schema_name, pois_at FROM public.areas
        WHERE status = 'ready'
          AND ST_Contains(bbox, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        -- Smallest-bbox-wins ties when two imports overlap and are the same
        -- size: measured on prod, area_27 and area_33 both bbox to 24.98 km²
        -- and both contain 40.8634,29.3493, so ST_Area alone flipped a coin
        -- and landed on area_27, whose nearest routable vertex to that point
        -- is 1715m — refused — while area_33's is 198m and its mask actually
        -- covers the point. Preferring the area whose coverage contains the
        -- point first means the resolver agrees with the veil, which is built
        -- from this exact COALESCE(coverage, bbox) expression (see /api/coverage).
        -- Safe under DESC only because public.areas.bbox is NOT NULL: that
        -- keeps COALESCE(coverage, bbox) always a real geometry, so ST_Contains
        -- here is never NULL — a NULL would sort ahead of true under DESC and
        -- pick the wrong area.
        ORDER BY ST_Contains(COALESCE(coverage, bbox), ST_SetSRID(ST_MakePoint($1, $2), 4326)) DESC,
                 ST_Area(bbox) ASC
        LIMIT 1
     ), touch AS (
       UPDATE public.areas SET last_used_at = now()
        WHERE id = (SELECT id FROM pick)
          AND (last_used_at IS NULL OR last_used_at < now() - interval '10 minutes')
     )
     SELECT schema_name, pois_at IS NOT NULL AS pois_loaded FROM pick`,
    [lon, lat]
  );
  // `matched` distinguishes "no area covers this point" from "an area covers
  // it but the click landed off the pedestrian network" — the two produce
  // very different advice, and only the first is fixable by importing.
  return {
    schema: (r.rows[0]?.schema_name as string) ?? DEFAULT_SCHEMA,
    matched: Boolean(r.rows[0]),
    // No row means we fell back to the shipped city, whose POIs came with it.
    poisLoaded: r.rows[0] ? (r.rows[0].pois_loaded as boolean) : true,
  };
};

// Imported areas are a cache, not durable state: every one of them can be
// rebuilt from Overpass on demand. So when the budget is tight, drop the
// least recently used rather than refusing the newcomer.
const evictToFit = async () => {
  let used = await importedMb();
  while (used > MAX_IMPORT_MB) {
    const victim = await pool.query(
      `SELECT id, schema_name FROM public.areas
        WHERE status = 'ready' AND schema_name LIKE 'area\\_%'
        ORDER BY COALESCE(last_used_at, created_at) ASC
        LIMIT 1`
    );
    const row = victim.rows[0];
    if (!row) return false; // nothing evictable left; caller must refuse
    await pool.query(`DROP SCHEMA IF EXISTS ${row.schema_name} CASCADE`);
    await pool.query(`DELETE FROM public.areas WHERE id = $1`, [row.id]);
    coverageBboxes.delete(row.schema_name);
    const now = await importedMb();
    console.log(
      `🧹 evicted ${row.schema_name} (least recently used) — freed ${Math.round(
        used - now
      )}MB`
    );
    used = now;
  }
  return true;
};

// Moved to layers.ts as MAX_SNAP_METERS so the precompute is bound by the same
// number — it was unbounded until this constant was shared, see that comment.
const MAX_SNAP_M = MAX_SNAP_METERS;

// Coverage extent for the 400 message, memoized per schema — a single cached
// string would go stale the moment a new area is imported.
const coverageBboxes = new Map<string, string>();
const getCoverage = async (schema: string) => {
  if (!coverageBboxes.has(schema)) {
    const r = await pool.query(
      `SELECT ST_Extent(geom)::text AS b FROM ${schema}.ways_vertices_pgr WHERE main_component`
    );
    coverageBboxes.set(schema, r.rows[0]?.b ?? "unknown");
  }
  return coverageBboxes.get(schema);
};

// Checked before the rate limiter so monitoring never consumes quota.
app.get("/healthz", async (_, res) => {
  const checks: Record<string, string> = {};
  try {
    await pool.query("SELECT 1");
    checks.postgres = "ok";
  } catch (err) {
    checks.postgres = (err as Error).message;
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = (err as Error).message;
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({ healthy, checks });
});

// The overlay polls these continuously to show other people's imports, and
// they are trivial reads. Charging them against the interactive budget meant
// three imports could exhaust it — same reasoning as /healthz above.
const pollLimiter = rateLimit({
  windowMs: 60_000,
  limit: parseInt(process.env.POLL_LIMIT ?? "240", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Polling too fast." },
});

app.get("/api/areas", pollLimiter, async (_, res) => {
  const r = await pool.query(
    `SELECT id, schema_name, status, created_at, name,
            ST_YMin(bbox) AS min_lat, ST_XMin(bbox) AS min_lon,
            ST_YMax(bbox) AS max_lat, ST_XMax(bbox) AS max_lon
       FROM public.areas ORDER BY created_at`
  );
  res.json(r.rows);
});

// Merged coverage as one geometry. The map veils everything *outside* this,
// and overlapping boxes would otherwise punch the veil twice and re-fill the
// overlap (SVG evenodd), showing a dark patch inside covered ground.
//
// COALESCE(coverage, bbox): the dissolved graph footprint where it has been
// computed, the old rectangle where it has not, so an area that has not been
// dissolved yet over-claims exactly as it always did rather than vanishing.
//
// The 42703 branch is not paranoia, it is measured. ALTER TABLE public.areas ADD
// COLUMN needs ACCESS EXCLUSIVE, and precompute-reach.ts joins public.areas
// inside the transaction that wraps each ~400s traversal, so the column cannot
// be added while a precompute is running — a 150s lock_timeout was not close to
// enough. When that ALTER fails it takes the whole DDL block down with it, which
// left this endpoint 500ing on a 5-second poll. Deploying code that assumes its
// own migration succeeded is the bug; falling back to bbox is the fix.
//
// Do NOT wait indefinitely for that lock instead: a queued ACCESS EXCLUSIVE
// request blocks every ACCESS SHARE behind it, which would stall the precompute
// rather than the migration.
// Cached, because the union is not cheap and the poll is per-client: measured
// 290ms and 283KB for 35 areas, every 5 seconds, which is ~6% of one CX23 core
// per visitor before anyone has asked for an isochrone. The mask got 14x bigger
// when its grid was tightened to stop over-claiming (COVERAGE_GRID_DEGREES),
// which is what made this worth caching rather than just recomputing.
//
// Keyed on a fingerprint rather than invalidated by hand: coverage changes when
// an area becomes ready, is evicted, or gets its mask backfilled, and those
// writes are spread across the importer, the evictor and startup. Three counts
// over a 35-row table cost microseconds and cannot silently go stale the way a
// forgotten invalidation call can. Express's ETag then turns the repeat polls
// into 304s with no body, so the wire cost is already near zero — this is about
// the database, not the network.
let coverageCache: { key: string; body: unknown } | null = null;

app.get("/api/coverage", pollLimiter, async (_, res) => {
  const withCoverage = `SELECT ST_AsGeoJSON(ST_Union(COALESCE(coverage, bbox)))::jsonb AS g
                          FROM public.areas WHERE status = 'ready'`;
  const bboxOnly = `SELECT ST_AsGeoJSON(ST_Union(bbox))::jsonb AS g
                      FROM public.areas WHERE status = 'ready'`;

  let key = "nokey";
  try {
    const f = await pool.query(
      `SELECT count(*)::text || ':' || COALESCE(max(id), 0)::text || ':' ||
              count(coverage)::text AS k
         FROM public.areas WHERE status = 'ready'`
    );
    key = f.rows[0].k;
    if (coverageCache?.key === key) {
      res.json(coverageCache.body);
      return;
    }
  } catch (err) {
    if ((err as any).code !== "42703") throw err; // column not added yet
  }

  let r;
  try {
    r = await pool.query(withCoverage);
  } catch (err) {
    if ((err as any).code !== "42703") throw err; // 42703 = undefined_column
    r = await pool.query(bboxOnly);
  }
  const body = r.rows[0]?.g ?? null;
  if (key !== "nokey") coverageCache = { key, body };
  res.json(body);
});

app.get("/api/areas/:id", pollLimiter, async (req: any, res: any) => {
  const r = await pool.query(
    `SELECT id, schema_name, status, error, (${aheadSql("a")})::int AS ahead
       FROM public.areas a WHERE id = $1`,
    [parseInt(req.params.id, 10)]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "No such area" });
  res.json(r.rows[0]);
});

// Generous for a human clicking a map, fast to hit with a script.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: parseInt(process.env.RATE_LIMIT ?? "60", 10),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, slow down." },
  })
);

// Objects, not bare names: the per-profile minute cap has to reach the client,
// or the UI asks for 15 minutes of cycling and gets a 400 it can't explain.
app.get("/api/profiles", (_, res) => {
  res.json(
    (Object.keys(PROFILES) as ProfileName[]).map((name) => ({
      name,
      maxMinutes: maxMinutesFor(name),
    }))
  );
});

// Geocoding for the search box. Proxied rather than called from the browser:
// Nominatim's policy wants an identifying User-Agent (a page cannot set one),
// caps callers at one request a second, and asks that repeats be cached — all
// three are properties of the whole site, not of one visitor's tab.
//
// One request a second, enforced by chaining rather than by comparing against
// a "last call" timestamp: two concurrent visitors read the same timestamp and
// fire together. Each caller waits for the previous link and appends its own
// 1s gap, so turns start exactly a second apart however long a fetch takes.
let geocodeGate: Promise<unknown> = Promise.resolve();
const geocodeSlot = () => {
  const mine = geocodeGate;
  geocodeGate = mine.then(() => sleep(1000));
  return mine;
};

// One human-readable name per imported area, fetched once at import time (see
// the call site in runImport). Shares geocodeSlot's 1-req/s gate rather than
// opening a second path to Nominatim, and must never reject: an area that
// routes but has no name is still useful, same rule loadPois follows.
const reverseGeocode = async (lat: number, lon: number): Promise<string | null> => {
  const key = `revgeo:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = await cacheGet(key);
  if (cached) return JSON.parse(cached as string);

  await geocodeSlot();
  let name: string | null = null;
  try {
    // zoom=12 is town/city granularity. The default (18) returns a building
    // address, which is wrong for a 5x5km box centred on nothing in particular.
    const r = await fetch(
      `${NOMINATIM_REVERSE_URL}?format=jsonv2&zoom=12&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
    );
    if (r.ok) {
      const displayName = ((await r.json()) as any)?.display_name as string | undefined;
      // display_name is a full postal chain; the first two segments are the
      // useful part — "Pankow, Berlin, Deutschland" → "Pankow, Berlin". Drop
      // the second when it only restates the first: 52.4785,12.8385 reverses
      // to "Ketzin, Ketzin/Havel, Havelland, ..." and the answer is "Ketzin".
      if (displayName) {
        const parts = displayName.split(",").map((s) => s.trim()).filter(Boolean);
        const redundant =
          parts.length > 1 &&
          (parts[1].startsWith(parts[0]) || parts[0].startsWith(parts[1]));
        name = parts.slice(0, redundant ? 1 : 2).join(", ").slice(0, 80) || null;
      }
    }
  } catch {
    // Cached below regardless — a repeated failure should not be a repeated request.
  }
  await cacheSet(key, JSON.stringify(name), 60 * 60 * 24 * 7);
  return name;
};

app.get("/api/search", async (req: any, res: any) => {
  const q = String(req.query.q ?? "").trim().slice(0, 120);
  if (q.length < 2)
    return res.status(400).json({ error: "Type at least two characters." });

  // A week: place names do not move, and this is the cache their policy asks
  // for. Misses are cached too — a typo repeated is still a request saved.
  const key = `geocode:${q.toLowerCase()}`;
  const cached = await cacheGet(key);
  if (cached) return res.json(JSON.parse(cached));

  await geocodeSlot();
  try {
    const r = await fetch(
      `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
    );
    if (!r.ok) {
      return res.status(503).json({
        error: "Place search is busy right now. Try again in a moment.",
      });
    }
    const results = ((await r.json()) as any[]).map((p) => ({
      name: p.display_name as string,
      lat: parseFloat(p.lat),
      lon: parseFloat(p.lon),
    }));
    await cacheSet(key, JSON.stringify(results), 60 * 60 * 24 * 7);
    res.json(results);
  } catch {
    res.status(503).json({ error: "Could not reach the place search service." });
  }
});

app.get("/api/cache-stats", (_, res) => {
  res.json({
    cacheHits,
    cacheMisses,
    hitRate:
      cacheHits + cacheMisses > 0
        ? `${((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(2)}%`
        : "N/A",
  });
});

// Importing is orders of magnitude more expensive than a query: Overpass is a
// shared public resource and each area costs disk forever.
// Per IP, not global: ten people each importing one area is fine and they all
// get served — the queue orders them, it doesn't turn anyone away.
// ⚠️ The deployed value lives in docker-compose.yml (`IMPORT_LIMIT:
// ${IMPORT_LIMIT:-3}`), which sets the variable unconditionally — so this
// fallback never fires under compose. Change it there, not here. What is left
// here is only what a bare `npx ts-node` run gets, kept conservative on
// purpose: local testing should not out-import the deployment.
const IMPORT_LIMIT = parseInt(process.env.IMPORT_LIMIT ?? "1", 10);

// Shared by the rate limiter and the handler: a payload only costs quota if it
// could actually start an import. Anything malformed or oversized must reach
// the handler and be answered on its merits — being told "rate limited" when
// the real problem is a 1° box is a maddening thing to debug.
const parseBox = (body: any) => {
  const nums = [body?.minLat, body?.minLon, body?.maxLat, body?.maxLon].map(Number);
  if (nums.some((n) => !isFinite(n))) return { ok: false as const, why: "nan" };
  const [s, w, n, e] = nums;
  if (s >= n || w >= e) return { ok: false as const, why: "order" };
  const midLat = (s + n) / 2;
  const heightKm = (n - s) * 111.32;
  const widthKm = (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const areaKm2 = heightKm * widthKm;
  return {
    ok: areaKm2 <= MAX_AREA_KM2,
    why: "size", s, w, n, e, midLat, heightKm, widthKm, areaKm2,
  };
};

// Own store and key function so a failed import can hand the slot back. The
// budget is small enough that spending a slot on an area which then fails to
// build would lock someone out for an hour having got nothing.
const importStore = new MemoryStore();
const importKey = (req: any) => String(req.ip ?? "unknown");
const pendingKey = new Map<number, string>();

const refundImport = (areaId: number) => {
  const key = pendingKey.get(areaId);
  if (!key) return;
  pendingKey.delete(areaId);
  Promise.resolve(importStore.decrement(key)).catch(() => {});
  console.log(`↩︎ refunded import slot for a failed area`);
};

const importLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: IMPORT_LIMIT,
  store: importStore,
  keyGenerator: importKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Only real imports should cost quota. Without this a mistyped box burns the
  // same budget as an actual osm2pgrouting run.
  skipFailedRequests: true,
  // Nor should clicking somewhere already covered. That was tolerable at ten
  // an hour; at three, exploring a city you have already imported would lock
  // you out. The lookup is one indexed query, and the handler reuses it.
  skip: async (req: any) => {
    // Malformed or too big: let the handler explain the actual problem.
    const box = parseBox(req.body);
    if (!box.ok || box.s === undefined) return true;
    try {
      const { s, w, n, e } = box;
      const r = await pool.query(
        `SELECT id, schema_name FROM public.areas
          WHERE status = 'ready'
            AND ST_Contains(bbox, ST_MakeEnvelope($1, $2, $3, $4, 4326))
          LIMIT 1`,
        [w, s, e, n]
      );
      if (r.rows[0]) {
        req.existingArea = r.rows[0];
        return true;
      }
    } catch {
      /* if the check fails, charge the request rather than let it through */
    }
    return false;
  },
  message: {
    error: `Import limit reached (${IMPORT_LIMIT}/hour). Try again later.`,
  },
});

app.post("/api/areas", importLimiter, async (req: any, res: any) => {
  const { minLat, minLon, maxLat, maxLon } = req.body ?? {};
  const nums = [minLat, minLon, maxLat, maxLon].map(Number);

  if (nums.some((n) => !isFinite(n))) {
    return res
      .status(400)
      .json({ error: "Need numeric minLat, minLon, maxLat, maxLon" });
  }
  const [s, w, n, e] = nums;
  if (s >= n || w >= e) {
    return res.status(400).json({ error: "min must be less than max" });
  }

  // Rough but honest at city scale; the cap only needs the right magnitude.
  const midLat = (s + n) / 2;
  const heightKm = (n - s) * 111.32;
  const widthKm = (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const areaKm2 = heightKm * widthKm;
  if (areaKm2 > MAX_AREA_KM2) {
    return res.status(400).json({
      error: `Area is ${areaKm2.toFixed(1)}km²; max is ${MAX_AREA_KM2}km²`,
    });
  }

  // Already covered? Serving an existing area beats importing a duplicate.
  // The rate limiter already ran this lookup to decide whether to charge the
  // request; reuse its answer rather than asking twice.
  const existing = req.existingArea
    ? { rows: [req.existingArea] }
    : await pool.query(
        `SELECT id, schema_name FROM public.areas
          WHERE status = 'ready'
            AND ST_Contains(bbox, ST_MakeEnvelope($1, $2, $3, $4, 4326))
          LIMIT 1`,
        [w, s, e, n]
      );
  if (existing.rows[0]) {
    // id included so the client can claim it locally even when it was
    // somebody else's import that already covered this spot.
    return res.json({
      id: existing.rows[0].id,
      status: "ready",
      schema: existing.rows[0].schema_name,
      reused: true,
    });
  }

  // Make room before starting rather than after, so a full budget fails fast.
  if (!(await evictToFit())) {
    return res.status(507).json({
      error:
        `Import budget of ${MAX_IMPORT_MB}MB is full and there is nothing ` +
        `left to evict. Ask the operator to raise MAX_IMPORT_MB.`,
    });
  }

  // Queued, not rejected: the box can only run one import at a time, but that
  // is this machine's problem, not the second person's.
  const dLat = BUFFER_M / 111320;
  const dLon = BUFFER_M / (111320 * Math.cos((midLat * Math.PI) / 180));
  const ins = await pool.query(
    `INSERT INTO public.areas (bbox, imported_bbox, status)
     VALUES (ST_MakeEnvelope($1,$2,$3,$4,4326),
             ST_MakeEnvelope($5,$6,$7,$8,4326), 'queued')
     RETURNING id`,
    [w, s, e, n, w - dLon, s - dLat, e + dLon, n + dLat]
  );
  const id: number = ins.rows[0].id;
  // Counted in its own statement: a subquery in RETURNING cannot see the row
  // it is inserting, which made the first job report a queue position of -1.
  const q = await pool.query(
    `UPDATE public.areas SET schema_name = $2 WHERE id = $1
     RETURNING (${aheadSql("areas")})::int AS ahead`,
    [id, `area_${id}`]
  );
  const ahead: number = q.rows[0].ahead;

  // ~1s/km² of imported area was measured on dense Berlin; sparse areas beat
  // it comfortably, so this reads as an upper bound rather than a promise.
  const bufferKm = (BUFFER_M / 1000) * 2;
  const eachSeconds = Math.max(
    15,
    Math.round((heightKm + bufferKm) * (widthKm + bufferKm))
  );

  pendingKey.set(id, importKey(req));
  drainQueue(); // fire and forget; the worker serializes
  res.status(202).json({
    id,
    status: "queued",
    ahead,
    poll: `/api/areas/${id}`,
    estimateSeconds: eachSeconds * (ahead + 1),
  });
});

// The five OSM keys Berlin's own extract was filtered on (`osmium tags-filter
// nwr/amenity nwr/shop nwr/tourism nwr/historic nwr/leisure`). On-demand
// imports fetched only the first two, so *every* kind under leisure (park,
// playground, pitch, sports_centre, swimming_pool…) and most of culture
// (tourism, historic) could not exist outside Berlin — two of the seven groups
// were permanently greyed out in every imported area, with nothing saying why.
// Measured on production: Berlin 20,323 outdoors / 3,803 culture, an imported
// area 0 / 0.
//
// Order is precedence, not preference: the first key an object carries decides
// its category.
const POI_TAGS = ["amenity", "shop", "tourism", "historic", "leisure"] as const;

// Widening the tag set only helps areas that get re-fetched, and every area
// already carries a pois_at stamp, so the sweep would skip them forever.
// Re-sweep anything stamped before the wider query shipped; once each has been
// redone the clause matches nothing and the sweep goes quiet again. Cheaper
// than a version column and it needs no manual SQL step at deploy time.
const POI_TAGS_SINCE = process.env.POI_TAGS_SINCE ?? "2026-08-08T00:00:00Z";

// POIs live in one global table, independent of the routing schemas, so this
// is additive: it can run during an import or long afterwards, and running it
// twice costs nothing (ON CONFLICT DO NOTHING on the OSM id).
//
// `out center` gives ways a point without us assembling their geometry, and
// `nwr` is one statement rather than four selectors. The pause before asking
// is not politeness padding: when this follows the graph fetch of the same
// import, firing immediately earned a 504 every time.
//
// Returns true only if Overpass actually answered. Stamping pois_at on the way
// out — even for zero rows — is what lets a genuinely amenity-free rural box
// be told apart from one whose fetch failed.
const loadPois = async (
  areaId: number,
  label: string,
  s: number, w: number, n: number, e: number
) => {
  try {
    const poiQuery =
      `[out:json][timeout:180];(` +
      POI_TAGS.map((t) => `nwr["${t}"](${s},${w},${n},${e});`).join("") +
      `);out center tags;`;
    let pr: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(attempt === 0 ? 3000 : 15000);
      pr = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT },
        body: new URLSearchParams({ data: poiQuery }),
        signal: AbortSignal.timeout(150_000),
      });
      if (pr.ok) break;
      console.log(`↻ ${label}: POI fetch got ${pr.status}, retrying`);
    }
    if (!pr?.ok) throw new Error(`Overpass ${pr?.status}`);
    const els = (await pr.json()).elements ?? [];
    const rows = els
      .map((el: any) => {
        const y = el.lat ?? el.center?.lat;
        const x = el.lon ?? el.center?.lon;
        // First match wins, so an object tagged both leisure=park and
        // amenity=cafe files under the amenity — the same precedence the
        // pedestrian-facing groups assume.
        const cat = POI_TAGS.find((t) => el.tags?.[t]) ?? null;
        if (y == null || x == null || !cat) return null;
        return [el.type[0], el.id, cat, el.tags[cat], el.tags.name ?? null, x, y];
      })
      .filter(Boolean);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const values = chunk
        .map((_: unknown, j: number) => {
          const b = j * 7;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},ST_SetSRID(ST_MakePoint($${b + 6},$${b + 7}),4326))`;
        })
        .join(",");
      await pool.query(
        `INSERT INTO public.pois (osm_type, osm_id, category, kind, name, geom)
         VALUES ${values} ON CONFLICT DO NOTHING`,
        chunk.flat()
      );
    }
    await pool.query(`UPDATE public.areas SET pois_at = now() WHERE id = $1`, [
      areaId,
    ]);
    console.log(`🍽️ ${label}: ${rows.length} POIs`);
    return true;
  } catch (err) {
    // pois_at stays NULL, which is the whole signal: the sweep will come back
    // for it, and until then /api/amenities admits it doesn't know yet.
    console.error(`⚠️ POI fetch for ${label} failed:`, (err as Error).message);
    return false;
  }
};

// One import at a time, oldest first. The areas table is the queue — a broker
// would buy nothing while there is a single app process.
// ponytail: single-process worker. Two app replicas would need
// SELECT ... FOR UPDATE SKIP LOCKED here, or a real broker.
const runImport = async (areaId: number) => {
  const start = Date.now();
  const row = (
    await pool.query(
      `SELECT schema_name, attempts,
              ST_YMin(imported_bbox) AS s, ST_XMin(imported_bbox) AS w,
              ST_YMax(imported_bbox) AS n, ST_XMax(imported_bbox) AS e
         FROM public.areas WHERE id = $1`,
      [areaId]
    )
  ).rows[0];
  const schemaName: string = row.schema_name;
  const attempts: number = row.attempts;
  const [bs, bw, bn, be] = [row.s, row.w, row.n, row.e];
  const osmFile = path.join(os.tmpdir(), `area-${areaId}.osm`);

  try {
    await pool.query(
      `UPDATE public.areas SET status = 'importing' WHERE id = $1`,
      [areaId]
    );

    const query =
      `[out:xml][timeout:90];way["highway"~"^(${walkableHighways().join("|")})$"]` +
      `(${bs},${bw},${bn},${be});(._;>;);out body;`;
    const osm = await fetch(OVERPASS_URL, {
      method: "POST",
      // Node's default UA ("node") is rejected by Overpass's Apache with a 406
      // before the query is ever parsed; their usage policy wants an
      // identifying agent anyway.
      headers: { "User-Agent": USER_AGENT },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!osm.ok) {
      const err: any = new Error(`Overpass returned ${osm.status}`);
      // 429 = their fair-use slot limit, 504 = query timed out under load.
      // Both mean "later", not "never".
      err.retryable = osm.status === 429 || osm.status === 504;
      throw err;
    }
    fs.writeFileSync(osmFile, Buffer.from(await osm.arrayBuffer()));

    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await execFileAsync(
      "osm2pgrouting",
      [
        "-f", osmFile,
        "-d", process.env.PGDATABASE ?? "osm_db",
        "-U", process.env.PGUSER ?? "postgres",
        "-W", process.env.PGPASSWORD ?? "password",
        "-h", process.env.PGHOST ?? "127.0.0.1",
        "-p", process.env.PGPORT ?? "5454",
        "-c", MAPCONFIG,
        "--schema", schemaName,
        "--clean",
      ],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }
    );

    // Same post-processing import_city.sh does — indexes, then cost in walking
    // seconds (main_component reads cost, so it has to run after).
    const setup = await pool.connect();
    try {
      await setup.query("SET statement_timeout = 300000");
      // osm2pgrouting 2.3.8 (Debian) writes gid/the_geom; 3.0.0 (brew, and
      // what Berlin was imported with) writes id/geom. Normalize to the
      // newer names so one query shape works whichever tool built the schema.
      await setup.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = '${schemaName}' AND table_name = 'ways'
                        AND column_name = 'gid') THEN
            EXECUTE 'ALTER TABLE ${schemaName}.ways RENAME COLUMN gid TO id';
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = '${schemaName}' AND table_name = 'ways'
                        AND column_name = 'the_geom') THEN
            EXECUTE 'ALTER TABLE ${schemaName}.ways RENAME COLUMN the_geom TO geom';
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = '${schemaName}' AND table_name = 'ways_vertices_pgr'
                        AND column_name = 'the_geom') THEN
            EXECUTE 'ALTER TABLE ${schemaName}.ways_vertices_pgr RENAME COLUMN the_geom TO geom';
          END IF;
        END $$;
      `);
      await setup.query(
        `CREATE INDEX ON ${schemaName}.ways(source);
         CREATE INDEX ON ${schemaName}.ways(target);
         CREATE INDEX ON ${schemaName}.ways USING GIST(geom);`
      );
      // osm2pgrouting occasionally emits a way with no length or geometry
      // (degenerate OSM input). It can't be routed on, and a NULL length makes
      // a NULL cost, which pgr_connectedComponents rejects outright — taking
      // the whole area's component flagging down with it.
      const junk = await setup.query(
        `DELETE FROM ${schemaName}.ways WHERE length_m IS NULL OR geom IS NULL`
      );
      if (junk.rowCount) {
        console.log(`🧹 ${schemaName}: dropped ${junk.rowCount} way(s) with no length/geometry`);
      }
      await setup.query(
        `UPDATE ${schemaName}.ways SET
           cost         = ROUND((length_m / CASE WHEN tag_id = 104 THEN 0.7 ELSE 1.4 END)::numeric, 2),
           reverse_cost = ROUND((length_m / CASE WHEN tag_id = 104 THEN 0.7 ELSE 1.4 END)::numeric, 2)`
      );
    } finally {
      setup.release();
    }

    // Run the canonical file rather than restating its logic here — a second
    // copy of the component flagging is exactly how the warmers drifted.
    await execFileAsync(
      "psql",
      [
        "-h", process.env.PGHOST ?? "127.0.0.1",
        "-p", process.env.PGPORT ?? "5454",
        "-U", process.env.PGUSER ?? "postgres",
        "-d", process.env.PGDATABASE ?? "osm_db",
        // Without this psql prints the error, carries on, and exits 0 — which
        // is how an area whose component flagging failed was still marked
        // ready, then answered every click with "No nearest vertex found".
        "-v", "ON_ERROR_STOP=1",
        "-v", `schema=${schemaName}`,
        "-f", MAIN_COMPONENT_SQL,
      ],
      {
        timeout: 300_000,
        env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "password" },
      }
    );

    // Additive and independent of the graph, so a failure here must not fail
    // the import — and, since T-011, must not be the end of it either: the
    // sweep below retries whatever this leaves unstamped.
    await loadPois(areaId, schemaName, bs, bw, bn, be);

    // Assert the graph is actually routable before advertising it. A schema
    // with ways but no main component routes nowhere, and the only symptom
    // used to be a 500 on the first click — long after the import "succeeded".
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM ${schemaName}.ways)::int AS ways,
              (SELECT count(*) FROM ${schemaName}.ways_vertices_pgr
                WHERE main_component)::int AS routable`
    );
    if (!counts.rows[0].ways) throw new Error("no walkable ways in this area");
    if (!counts.rows[0].routable) {
      throw new Error("import produced no routable vertices");
    }

    // The one moment per area to do this: the requested bbox (where the person
    // actually clicked, not the buffered imported_bbox) is still in scope, and
    // doing this on read instead would put Nominatim on the /api/areas polling
    // path. reverseGeocode never rejects, so a failed lookup just leaves NULL.
    const centre = (
      await pool.query(
        `SELECT ST_Y(ST_Centroid(bbox)) AS lat, ST_X(ST_Centroid(bbox)) AS lon
           FROM public.areas WHERE id = $1`,
        [areaId]
      )
    ).rows[0];
    const name = await reverseGeocode(centre.lat, centre.lon);

    await pool.query(
      `UPDATE public.areas SET status = 'ready', name = $2 WHERE id = $1`,
      [areaId, name]
    );
    // After 'ready', not before: the veil should lift the moment the area can be
    // routed on, and a dissolve failure must not strand a good import as
    // permanently unready.
    await storeCoverage(areaId, schemaName);
    console.log(
      `✅ imported ${schemaName} (${counts.rows[0].ways} ways) in ${
        Date.now() - start
      }ms — ${Math.round(await importedMb())}MB of ${MAX_IMPORT_MB}MB used`
    );
    pendingKey.delete(areaId);
    // Measured, not predicted. The area just imported sorts newest, so it is
    // never its own victim.
    await evictToFit();
  } catch (err) {
    console.error(`❌ import of ${schemaName} failed:`, err);
    // A half-imported schema would answer queries with a broken graph. The row
    // stays so the poller can report the failure instead of 404ing.
    await pool
      .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
      .catch(() => {});
    const retryable = (err as any).retryable === true && attempts + 1 < MAX_ATTEMPTS;
    await pool
      .query(
        `UPDATE public.areas
            SET status = $3, error = $2, attempts = attempts + 1
          WHERE id = $1`,
        [areaId, (err as Error).message.slice(0, 500), retryable ? "queued" : "failed"]
      )
      .catch(() => {});
    if (retryable) {
      console.log(`↻ ${schemaName} will retry (attempt ${attempts + 2})`);
      await sleep(RETRY_PAUSE_MS);
    } else {
      refundImport(areaId);
    }
  } finally {
    fs.rmSync(osmFile, { force: true });
  }
};

const drainQueue = async () => {
  if (importInFlight) return;
  importInFlight = true;
  try {
    for (;;) {
      const next = await pool.query(
        `SELECT id FROM public.areas WHERE status = 'queued'
          ORDER BY attempts, created_at LIMIT 1`
      );
      if (!next.rows[0]) return;
      await runImport(next.rows[0].id);
      // Public Overpass is a shared resource: back-to-back imports earned a
      // 429 within seconds. Pace the queue rather than sprint through it.
      await sleep(OVERPASS_PAUSE_MS);
    }
  } catch (err) {
    console.error("⚠️ queue drain stopped:", (err as Error).message);
  } finally {
    importInFlight = false;
  }
};

// A queued retry has nothing to wake it, so re-check periodically.
setInterval(() => void drainQueue(), 30_000).unref?.();

// T-011: an area whose POI fetch failed keeps pois_at NULL, and the import it
// belonged to is long over. Retry it here instead, one area per tick, so the
// retry is not bounded by the lifetime of the job that first tried.
//
// Shares importInFlight with drainQueue: two concurrent Overpass calls from
// this box is exactly what earns the 429s the pacing exists to avoid.
//
// ponytail: no attempt counter. One area every 10 minutes is a low enough
// ceiling that a permanently unfetchable bbox is not worth a column — add one
// if the logs ever fill with the same id.
const POI_SWEEP_MS = parseInt(process.env.POI_SWEEP_MS ?? "600000", 10);

const sweepPois = async () => {
  if (importInFlight) return;
  importInFlight = true;
  try {
    // Most recently *used* first, not oldest: the area someone just imported
    // and is looking at right now is the one with a person waiting on it.
    // Reuses the stamp LRU eviction already maintains.
    //
    // The same buffered box the import used — a served area walks out past its
    // own edge, so its amenities have to as well.
    // `schema_name LIKE area_%` is a hard guard, not a tidy-up: the shipped
    // city is a row in this table too, its POIs came from a local extract, and
    // sweeping it would ask the public Overpass API for a Berlin-sized bbox.
    // It used to be excluded only by having been stamped at bootstrap, which
    // the POI_TAGS_SINCE clause below would have undone.
    const next = await pool.query(
      `SELECT id, schema_name,
              ST_YMin(imported_bbox) AS s, ST_XMin(imported_bbox) AS w,
              ST_YMax(imported_bbox) AS n, ST_XMax(imported_bbox) AS e
         FROM public.areas
        WHERE status = 'ready'
          AND schema_name LIKE 'area\\_%'
          AND (pois_at IS NULL OR pois_at < $1)
        ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1`,
      [POI_TAGS_SINCE]
    );
    const a = next.rows[0];
    if (!a) return;
    console.log(`🔁 backfilling POIs for ${a.schema_name}`);
    await loadPois(a.id, a.schema_name, a.s, a.w, a.n, a.e);
  } catch (err) {
    console.error("⚠️ POI sweep stopped:", (err as Error).message);
  } finally {
    importInFlight = false;
  }
};

setInterval(() => void sweepPois(), POI_SWEEP_MS).unref?.();

// Destinations worth searching for, grouped. Defined here and served to the
// client so the two can't drift: the UI colours, filters and labels all come
// from this list. The raw extract is three-quarters parking bays, benches and
// waste baskets, so everything is stored and only these kinds are queryable.
const PLACE_GROUPS = [
  {
    label: "food", icon: "\u{1F37D}", color: "#e8590c",
    kinds: ["restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream",
            "bakery", "biergarten", "food_court"],
  },
  {
    label: "shops", icon: "\u{1F6CD}", color: "#ae3ec9",
    kinds: ["supermarket", "convenience", "butcher", "greengrocer", "clothes",
            "books", "florist", "hardware", "optician", "department_store",
            "mall", "kiosk", "hairdresser"],
  },
  {
    label: "culture", icon: "\u{1F3DB}", color: "#c2255c",
    // `memorial` is deliberately absent: Berlin maps every Stolperstein
    // individually, and 475 brass pavement stones swamped a 15-minute walk.
    // The rows are still stored — one word re-adds them.
    kinds: ["museum", "artwork", "gallery", "attraction",
            "monument", "castle", "ruins", "viewpoint", "theatre", "cinema",
            "arts_centre"],
  },
  {
    label: "health", icon: "\u{2695}", color: "#2f9e44",
    kinds: ["pharmacy", "doctors", "dentist", "clinic", "hospital", "veterinary"],
  },
  {
    label: "learning", icon: "\u{1F393}", color: "#0c8599",
    kinds: ["school", "kindergarten", "university", "college", "library"],
  },
  {
    label: "outdoors", icon: "\u{1F333}", color: "#74b816",
    kinds: ["park", "playground", "garden", "pitch", "sports_centre",
            "fitness_centre", "swimming_pool", "nature_reserve", "dog_park"],
  },
  {
    label: "money", icon: "\u{1F4B6}", color: "#f59f00",
    kinds: ["bank", "atm", "post_office", "bureau_de_change"],
  },
];

const AMENITY_KINDS = PLACE_GROUPS.flatMap((g) => g.kinds);

// The reachable-edge set, as a CTE. Shared so the isochrone and the amenity
// lookup can never disagree about what "reachable" means.
const reachableEdgesSql = (
  schema: string,
  profile: ProfileName,
  maxCost: number,
  lat: number,
  lon: number
) => {
  const reachM = maxCost * PROFILES[profile].speed;
  const dLat = reachM / 111320;
  const dLon = reachM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox =
    `geom && ST_Expand(ST_SetSRID(ST_MakePoint(${lon.toFixed(6)}, ` +
    `${lat.toFixed(6)}), 4326), ${dLon.toFixed(6)}, ${dLat.toFixed(6)})`;
  return `SELECT edge, agg_cost FROM pgr_drivingDistance(
      'SELECT id::integer AS id, source::integer, target::integer,
        ${costExpr(profile)} AS cost, ${costExpr(profile)} AS reverse_cost
       FROM ${schema}.ways WHERE ${bbox}',
      (SELECT v.id FROM ${schema}.ways_vertices_pgr v
        WHERE v.main_component
          AND EXISTS (
            SELECT 1 FROM ${schema}.ways w
             WHERE (w.source = v.id OR w.target = v.id)
               AND (${costExpr(profile)}) > 0
          )
        ORDER BY v.geom <-> ST_SetSRID(ST_MakePoint(${lon.toFixed(6)}, ${lat.toFixed(
    6
  )}), 4326) LIMIT 1)::integer,
      ${maxCost}::double precision)
     WHERE edge > 0`;
};

app.get("/api/amenities", async (req: any, res: any) => {
  const start = Date.now();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const profile = (req.query.profile ?? "walk") as ProfileName;
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
    return res.status(400).json({ error: "Unknown profile" });
  }
  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "Invalid lat or lon" });
  }
  const cap = maxMinutesFor(profile);
  const minutes = Math.min(cap, parseInt(req.query.minutes ?? "15", 10) || 15);

  // Whitelisted against AMENITY_KINDS, so nothing user-supplied reaches SQL.
  const wanted = String(req.query.kinds ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => AMENITY_KINDS.includes(k));
  const kinds = wanted.length ? wanted : AMENITY_KINDS;
  // The whole set, not a page. A 25-min walk from Alexanderplatz — the worst
  // realistic case — is 2,148 places: ~35KB gzipped, one query instead of one
  // per page, and the client gets an exact total and free scrolling. The cap
  // is only a safety valve.
  const limit = Math.min(3000, parseInt(req.query.limit ?? "3000", 10) || 3000);

  const { schema, poisLoaded } = await resolveSchema(lat, lon);
  // `poi3` since the vertex snap became profile-aware: a click that had landed
  // on a cycleway-only vertex cached an empty place list on foot, and those are
  // the entries the fix repairs. The original `poi2` bump was for poisLoaded
  // joining the body. A 24h TTL outlives any deploy, so bump the prefix on the
  // next change too — it beats remembering to flush.
  const key = `poi3:${schema}:${lat.toFixed(5)},${lon.toFixed(
    5
  )}:${minutes}:${profile}:${kinds.join("|")}:${limit}`;

  try {
    const cached = await cacheGet(key);
    if (cached) {
      cacheHits++;
      return res.json(JSON.parse(cached));
    }
    cacheMisses++;

    // Joining POIs against each reachable edge keeps the GIST index in play.
    // Collecting the edges into one geometry first and casting to geography
    // measured 286s against 0.5s for this shape.
    const r = await pool.query(
      `WITH dd AS (${reachableEdgesSql(schema, profile, minutes * 60, lat, lon)}),
       hits AS (
         SELECT p.osm_type, p.osm_id, p.kind, p.category, p.name, p.geom,
                MIN(dd.agg_cost) AS cost_s
           FROM dd
           JOIN ${schema}.ways w ON w.id = dd.edge
           JOIN public.pois p
             ON p.geom && ST_Expand(w.geom, 0.00045)
            AND ST_DWithin(p.geom, w.geom, 0.00045)
          WHERE p.kind = ANY($1::text[])
          GROUP BY p.osm_type, p.osm_id, p.kind, p.category, p.name, p.geom
       ),
       -- OSM often maps one place as both a node and a building way, so the
       -- same cafe arrives twice. Collapse same kind + same name within a
       -- ~60m grid cell; two branches further apart stay separate, and
       -- unnamed POIs fall back to their id so they never merge.
       deduped AS (
         SELECT DISTINCT ON (kind, COALESCE(name, osm_type || osm_id::text),
                             ST_SnapToGrid(geom, 0.0006))
                kind, category, name, geom, cost_s
           FROM hits
          ORDER BY kind, COALESCE(name, osm_type || osm_id::text),
                   ST_SnapToGrid(geom, 0.0006), cost_s
       )
       SELECT kind, category, name,
              ROUND(ST_Y(geom)::numeric, 6) AS lat,
              ROUND(ST_X(geom)::numeric, 6) AS lon,
              ROUND((cost_s / 60)::numeric, 1) AS minutes
         FROM deduped
        ORDER BY cost_s
        LIMIT $2`,
      [kinds, limit]
    );

    const body = {
      profile,
      minutes,
      poisLoaded,
      count: r.rows.length,
      truncated: r.rows.length === limit,
      items: r.rows,
    };
    // Never cache a "don't know yet": the sweep will fill this area in, and a
    // 24h cached empty list would outlive the fix by a day.
    if (poisLoaded) await cacheSet(key, JSON.stringify(body), 60 * 60 * 24);
    console.log(`🍽️ ${r.rows.length} amenities in ${Date.now() - start}ms`);
    res.json(body);
  } catch (err) {
    console.error("❌ amenities error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/place-groups", (_, res) => {
  res.json(PLACE_GROUPS);
});

// --- livability suggestions (T-016) -----------------------------------------
// GET /api/suggest scores DEFAULT_SCHEMA.reach (berlin.reach in production) —
// precomputed offline by scripts/precompute-reach.ts (layers.ts explains why
// offline, and why an absent row means unreachable rather than a sentinel
// value) — against a user's weight vector. No routing on this path: it is
// one aggregate over ~134,280 precomputed cells, which is what lets the
// questionnaire re-rank the whole map without a pgRouting call. Berlin only;
// an imported area_* schema never gets a reach field of its own, so there is
// no schema-resolution step here the way /api/isochrone and /api/amenities have.

// Weight 0 means "ignore this layer", not "score it at zero", so those
// entries are dropped rather than carried through as no-op joins. Sorted so
// the same answer set keys the cache the same way regardless of arrival order.
const normalizeWeights = (weights: Record<string, number>): [string, number][] =>
  Object.entries(weights)
    .filter(([, w]) => w > 0)
    .sort(([a], [b]) => a.localeCompare(b));

// suggest2: bumped from suggest1 for T-017 — the decay went from a single
// REACH_DECAY_SECONDS to a per-profile lookup (bike scores on 300s, not
// 900s) and the answer space grew from 324 to 648, so both the scoring
// formula and the key space changed. Bump this prefix whenever
// DEFAULT_SCHEMA.reach is reloaded with a different shape, or the score
// formula below changes — same precedent as poi2 above (/api/amenities).
// T-016's verification lost half an hour to stale entries under an
// unchanged prefix; do not repeat that.
//
// suggest3: bumped again because the tie-break moved from lat/lon to
// md5(cell_id) (see the spread CTE). The scores are identical; the ten cells
// chosen out of a tied set are not, so every suggest2: entry holds a
// southern-edge answer this code would no longer produce. This bump is also
// what makes the completed Berlin precompute safe to cut over to — the reach
// table was reloaded with a different shape, which is the first condition
// above, and it caught us anyway during local verification: 14/14 passed
// against suggest2: entries warmed while the field was still half-computed.
//
// suggest4: density joined the formula (T-019), so every score changes and the
// body gained a `nearby` key. Both reasons on their own would require this.
const suggestCacheKey = (profile: string, entries: [string, number][]) =>
  `suggest4:${profile}:${entries.map(([l, w]) => `${l}:${w}`).join(",")}`;

// ST_SnapToGrid guarantees at most one candidate per coarse cell but nothing
// about the gap BETWEEN cells — two candidates straddling a grid boundary can
// land a few metres apart. Measured against a real reach field: 139m between
// two "spread" results, for a 700m criterion. So the grid snap below is kept
// only as a cheap pre-filter (LIMIT 200 instead of 10), and the actual 10 are
// picked greedily by real distance in scoreSuggestions.
//
// Haversine, not raw degree deltas: at 52.5°N one degree of longitude is only
// ~68% the width of one degree of latitude, so comparing lat/lon deltas
// directly gives a thinning radius that is correct north-south and ~30% too
// small east-west.
const haversineM = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s)); // 6,371,000m = mean Earth radius
};

// Runs the scored aggregate and caches it. Shared by the live endpoint below
// and the warm pass near the bottom of this file, so the two can never
// disagree about the formula.
const scoreSuggestions = async (profile: string, entries: [string, number][]) => {
  const layers = entries.map(([l]) => l);
  const weights = entries.map(([, w]) => w);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // DEFAULT_SCHEMA.reach is empty until the precompute has run, and absent
  // entirely on a fresh stack whose DEFAULT_SCHEMA hasn't been imported yet
  // (see ensureAreasTable above). Both read the same to the caller — "not
  // ready", not a 500 — so the UI can hide the panel on `available: false`.
  let hasRows = false;
  try {
    const has = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM ${DEFAULT_SCHEMA}.reach LIMIT 1) AS has_rows`
    );
    hasRows = has.rows[0].has_rows;
  } catch (err) {
    if ((err as any).code !== "42P01") throw err; // 42P01 = undefined_table
  }
  if (!hasRows) {
    return {
      available: false as const,
      reason: "suggestions have not been computed yet",
    };
  }

  // layer_score = 0 at REACH_DECAY_SECONDS[profile], 1 at 0s; GREATEST clamps
  // a walk past the decay window rather than letting it go negative. A
  // missing row never gets joined, which is the "no pharmacy within reach"
  // signal falling out of the LEFT-JOIN-shaped absence for free (the join
  // below is an inner join for exactly this reason — a row that never
  // matches contributes 0 by not existing, same result, one fewer NULL to
  // coalesce).
  // The decay is looked up per profile, not a shared constant (T-017): at
  // 4.2 m/s a 900s decay puts a bike score's zero point at 3.8km, which
  // covers almost all of inner Berlin and compresses every score to ~1. 300s
  // is what keeps bike selective (see layers.ts).
  // totalWeight is constant across every row this query returns, so it is a
  // bind parameter computed once in JS rather than recomputed per cell.
  const decaySeconds = REACH_DECAY_SECONDS[profile as ReachProfile];
  const r = await pool.query(
    `WITH weights(layer, w) AS (
       SELECT unnest($1::text[]), unnest($2::int[])
     ),
     -- T-019: reachability gates, density ranks. reach is the old term; the
     -- density factor is DENSITY_FLOOR plus the rest earned by how many places
     -- of that layer are nearby, log-scaled against the layer's own "plenty"
     -- (DENSITY_PLENTY, the measured p90 — dining's 185 is 17x school's 11, so a
     -- shared scale would make every score a dining score).
     --
     -- COALESCE(nearby, plenty) so a field whose density has not been backfilled
     -- yet scores exactly as it did before this change, rather than collapsing to
     -- the floor. log-scaled because the difference between 1 and 10 restaurants
     -- matters and the difference between 300 and 310 does not.
     plenty(layer, p) AS (
       SELECT unnest($7::text[]), unnest($8::int[])
     ),
     scored AS (
       SELECT r.cell_id,
              -- float8 throughout, not numeric. Postgres's numeric ln() is
              -- arbitrary-precision and measured 30x slower than the float8 one
              -- (2.12s vs 0.07s over 500k rows), which alone took a cold scoring
              -- query from ~1.0s to ~3.5s and would have tripled the startup warm
              -- pass. Nothing here needs exact decimal arithmetic — the result is
              -- rounded to 4 places and used to sort.
              (SUM(
                 wt.w
                 * GREATEST(0, 1 - r.seconds::float8 / $3::float8)
                 * ($9::float8 + (1 - $9::float8) * LEAST(1::float8,
                     ln(1 + COALESCE(r.nearby, pl.p)::float8) / ln(1 + pl.p::float8)))
               ) / $4)::double precision AS score,
              jsonb_object_agg(r.layer, r.seconds) AS layers,
              jsonb_object_agg(r.layer, COALESCE(r.nearby, 0)) AS nearby
         FROM ${DEFAULT_SCHEMA}.reach r
         JOIN weights wt ON wt.layer = r.layer
         JOIN plenty pl ON pl.layer = r.layer
        WHERE r.profile = $5
        GROUP BY r.cell_id
     ),
     -- Best-scoring cell per ~700m coarse cell (REACH_SPREAD_DEGREES) — a
     -- cheap pre-filter only. It bounds candidates per grid cell, not the gap
     -- between cells, so the real 700m spread is enforced afterwards in JS
     -- (see REACH_SPREAD_METERS above); this over-fetches past the eventual
     -- 10 so that greedy thinning still has enough candidates left to pick
     -- 10 mutually-distant ones from.
     spread AS (
       SELECT DISTINCT ON (ST_SnapToGrid(c.geom, $6))
              c.id AS cell_id, c.geom, s.score, s.layers, s.nearby
         FROM scored s
         JOIN ${DEFAULT_SCHEMA}.reach_cells c ON c.id = s.cell_id
        -- Score ties are broken deterministically, but deliberately NOT by
        -- coordinate. A single-layer weight vector (reachable from the
        -- questionnaire: groceries:1 and every other answer at zero) puts every
        -- cell collocated with a shop at exactly 1.0 — 37 of them for groceries
        -- in Berlin — and an unordered tie means the same question can answer
        -- differently after a restart, with the cache then freezing whichever
        -- order that run happened to produce.
        --
        -- Ordering those ties by latitude, which is what this did first, turned
        -- out worse than non-determinism. Measured against the complete field:
        -- bike / groceries:3,health:2,dining:1 has 230 cells at exactly 1.0,
        -- spanning 52.3866–52.6350 — the full 27km of the city — and lat-order
        -- returned the southernmost ten, a 5.7km band on the city limit. Mitte
        -- and Prenzlauer Berg scored identically and were never shown. Any
        -- saturated query pointed at the same edge of the map.
        --
        -- md5 of the cell id is stable across restarts and cache warms, which
        -- is all the coordinate sort was actually buying, and it samples the
        -- tied set uniformly instead of sorting it geographically.
        ORDER BY ST_SnapToGrid(c.geom, $6), s.score DESC, md5(c.id::text)
     )
     SELECT ROUND(ST_Y(geom)::numeric, 6)::double precision AS lat,
            ROUND(ST_X(geom)::numeric, 6)::double precision AS lon,
            ROUND(score::numeric, 4)::double precision AS score,
            layers,
            nearby
       FROM spread
      ORDER BY score DESC, md5(cell_id::text)
      LIMIT 200`,
    [
      layers,
      weights,
      decaySeconds,
      totalWeight,
      profile,
      REACH_SPREAD_DEGREES,
      layers,
      layers.map((l) => DENSITY_PLENTY[l as keyof typeof REACH_LAYERS]),
      DENSITY_FLOOR,
    ]
  );

  // Greedy by score: r.rows is already ordered descending, so the first
  // accepted cell is always the best-scoring one, and every later accept is
  // the best-scoring cell that doesn't crowd an earlier pick.
  const picked: {
    lat: number;
    lon: number;
    score: number;
    layers: Record<string, number>;
    nearby: Record<string, number>;
  }[] = [];
  for (const row of r.rows) {
    const tooClose = picked.some(
      (p) => haversineM(p.lat, p.lon, row.lat, row.lon) < REACH_SPREAD_METERS
    );
    if (tooClose) continue;
    picked.push(row);
    if (picked.length === 10) break;
  }

  const body = {
    available: true as const,
    cells: picked.map((row) => ({
      lat: row.lat,
      lon: row.lon,
      score: row.score,
      // Seconds per requested layer; a layer absent here is a layer this cell
      // cannot reach within REACH_CAP_SECONDS[profile], which is the point the
      // whole feature is built to make ("no pharmacy in 30 min").
      layers: row.layers,
      // How many places of each layer are within the profile's density radius —
      // the half of the score reachability cannot see (T-019). This is what
      // separates a cell with 308 restaurants from one with 32 when both are
      // standing on top of one.
      nearby: row.nearby,
    })),
  };
  // Long TTL: the field only changes on reimport/reload, which the version
  // prefix above already accounts for — this is not the /api/amenities case
  // where an expiry is doing real work.
  await cacheSet(
    suggestCacheKey(profile, entries),
    JSON.stringify(body),
    60 * 60 * 24 * 7
  );
  return body;
};

// --- naming suggestion results (T-016 follow-up) ----------------------------
//
// "#1 100% match" tells a Berliner nothing; "Lausitzer Platz, Kreuzberg" tells
// them everything. zoom=16, not the zoom=12 reverseGeocode uses for imported
// areas: at 12 every cell in the city reverses to "Berlin" and ten results
// share one label. 16 returns road + suburb, which is the granularity that
// distinguishes them.
//
// The work is bounded and small. The questionnaire's answer space is closed
// (648 combinations) and only 275 distinct cells appear across all of them, so
// this asks Nominatim 275 questions once, at its 1 req/s limit — about five
// minutes, then never again.
const placeNameLabel = (address: Record<string, string> | undefined) => {
  if (!address) return null;
  // road is usually the recognisable half ("Lausitzer Platz"), suburb the
  // orienting half ("Kreuzberg"). quarter is the fallback for a cell that
  // snapped between named roads; borough for the outer districts where
  // Nominatim returns no suburb.
  const near = address.road ?? address.quarter ?? address.neighbourhood ?? null;
  const area = address.suburb ?? address.borough ?? address.city ?? null;
  if (near && area && near !== area) return `${near}, ${area}`.slice(0, 80);
  return (near ?? area)?.slice(0, 80) ?? null;
};

const fetchPlaceName = async (lat: number, lon: number) => {
  await geocodeSlot();
  try {
    const r = await fetch(
      `${NOMINATIM_REVERSE_URL}?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) }
    );
    if (!r.ok) return undefined; // transient — no row written, so it retries
    return placeNameLabel(((await r.json()) as any)?.address);
  } catch {
    return undefined;
  }
};

// In-flight guard: ten results arriving on every poll would otherwise queue the
// same lookup repeatedly behind the 1 req/s gate and starve the fresh ones.
const namingInFlight = new Set<string>();

const fillPlaceNames = async (cells: { lat: number; lon: number }[]) => {
  for (const { lat, lon } of cells) {
    const k = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (namingInFlight.has(k)) continue;
    namingInFlight.add(k);
    try {
      const name = await fetchPlaceName(lat, lon);
      if (name === undefined) continue; // fetch failed; leave it unnamed
      await pool.query(
        `INSERT INTO public.place_names (lat, lon, name) VALUES ($1, $2, $3)
         ON CONFLICT (lat, lon) DO UPDATE SET name = EXCLUDED.name, looked_up_at = now()`,
        [lat.toFixed(4), lon.toFixed(4), name]
      );
    } catch (err) {
      console.error(`⚠️ naming ${k} failed:`, (err as Error).message);
    } finally {
      namingInFlight.delete(k);
    }
  }
};

// Decorates on the way OUT of the cache, not on the way in. The scored answer is
// cached for 7 days; names arrive minutes later and would otherwise be frozen as
// null until the cache expired.
const withPlaceNames = async (body: any) => {
  if (!body?.cells?.length) return body;
  const r = await pool.query<{ lat: string; lon: string; name: string | null }>(
    `SELECT lat::text, lon::text, name FROM public.place_names
      WHERE (lat, lon) IN (${body.cells
        .map((_: unknown, i: number) => `($${i * 2 + 1}::numeric, $${i * 2 + 2}::numeric)`)
        .join(",")})`,
    body.cells.flatMap((c: any) => [c.lat.toFixed(4), c.lon.toFixed(4)])
  );
  const byKey = new Map(
    r.rows.map((row) => [`${(+row.lat).toFixed(4)},${(+row.lon).toFixed(4)}`, row.name])
  );
  const missing: { lat: number; lon: number }[] = [];
  const cells = body.cells.map((c: any) => {
    const k = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
    if (!byKey.has(k)) missing.push({ lat: c.lat, lon: c.lon });
    return { ...c, name: byKey.get(k) ?? null };
  });
  // Deliberately not awaited: a first-time answer returns coordinates now and
  // gains names on the next request, rather than blocking the response behind a
  // 1 req/s external service.
  if (missing.length) void fillPlaceNames(missing);
  return { ...body, cells };
};

app.get("/api/suggest", async (req: any, res: any) => {
  const profile = String(req.query.profile ?? "walk");
  // REACH_PROFILES, not all of PROFILES: stroller and bike have no
  // precomputed reach field (layers.ts explains why).
  if (!(REACH_PROFILES as readonly string[]).includes(profile)) {
    return res
      .status(400)
      .json({ error: `Unknown profile. Try: ${REACH_PROFILES.join(", ")}` });
  }

  const rawWeights: Record<string, number> = {};
  const raw = String(req.query.w ?? "").trim();
  for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
    const [layer, wStr] = token.split(":");
    if (!layer || !Object.prototype.hasOwnProperty.call(REACH_LAYERS, layer)) {
      return res.status(400).json({
        error: `Unknown layer in "${token}". Try: ${Object.keys(REACH_LAYERS).join(", ")}`,
      });
    }
    if (!wStr || !/^\d+$/.test(wStr) || parseInt(wStr, 10) > REACH_MAX_WEIGHT) {
      return res.status(400).json({
        error: `Weight in "${token}" must be an integer 0..${REACH_MAX_WEIGHT}`,
      });
    }
    // Last one wins on a repeated layer rather than double-joining it below
    // and silently doubling its weight.
    rawWeights[layer] = parseInt(wStr, 10);
  }

  const entries = normalizeWeights(rawWeights);
  if (!entries.length) {
    return res.status(400).json({
      error: "Need at least one layer with a non-zero weight, e.g. w=groceries:3",
    });
  }

  // No `limit` param: it would multiply the 648-answer cache space by however
  // many values callers invent, for no user-visible gain. Fixed at 10 inside
  // scoreSuggestions.
  const key = suggestCacheKey(profile, entries);
  const cached = await cacheGet(key);
  if (cached) {
    cacheHits++;
    return res.json(await withPlaceNames(JSON.parse(cached as string)));
  }
  cacheMisses++;

  try {
    res.json(await withPlaceNames(await scoreSuggestions(profile, entries)));
  } catch (err) {
    console.error("❌ suggest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/isochrone", async (req: any, res: any) => {
  const start = Date.now();
  const { lat, lon, minutes } = req.query;
  const profile = (req.query.profile ?? "walk") as ProfileName;

  console.log(
    `➡️ Incoming /api/isochrone query: lat=${lat}, lon=${lon}, minutes=${minutes}, profile=${profile}`
  );

  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
    return res
      .status(400)
      .json({ error: `Unknown profile. Try: ${Object.keys(PROFILES).join(", ")}` });
  }

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum) || isNaN(lonNum)) {
    return res.status(400).json({ error: "Invalid lat or lon" });
  }

  const durations = String(minutes ?? "")
    .split(",")
    .map((m) => parseInt(m.trim()))
    .filter((m) => !isNaN(m) && m > 0);

  if (durations.length === 0) {
    return res.status(400).json({ error: "Invalid minutes list" });
  }

  const cap = maxMinutesFor(profile);
  if (Math.max(...durations) > cap) {
    return res.status(400).json({
      error: `minutes must be ${cap} or less for profile "${profile}"`,
      detail:
        cap < MAX_MINUTES
          ? `Faster profiles get fewer minutes so every request covers a ` +
            `similar area: ${Math.round(MAX_REACH_M)}m of reach.`
          : undefined,
    });
  }

  // Which imported area serves this point. Cache keys carry it too: the same
  // coordinates snap to a different vertex id in a different schema.
  const { schema, matched } = await resolveSchema(latNum, lonNum);

  // Profile is part of the key because the snap below is now profile-dependent:
  // the same click resolves to different vertices for walk and bike, and a
  // shared key would serve one profile's answer to the other.
  const vertexKey = `vertex2:${schema}:${profile}:${latNum.toFixed(5)},${lonNum.toFixed(5)}`;
  let vertexIdStr = await cacheGet(vertexKey);
  let vertexId: number;

  if (vertexIdStr) {
    cacheHits++;
    vertexId = parseInt(vertexIdStr);
    console.log(`📦 Vertex cache hit for ${vertexKey}`);
  } else {
    cacheMisses++;
    // main_component only: the geometrically nearest vertex is often on a
    // disconnected fragment (5.7% of Berlin's vertices), which routes nowhere.
    // Populated by scripts/main_component.sql.
    //
    // main_component is necessary but NOT sufficient, because it is computed on
    // the profile-blind graph while costExpr removes edges per profile. A vertex
    // whose only edges are cycleway (tag_id 113) is well connected in general and
    // completely isolated on foot, so the traversal reaches nothing and the
    // endpoint returns 200 with zero bands — indistinguishable from "nowhere to
    // go" and impossible to act on. Measured on Berlin: 14,926 of 618,345
    // main_component vertices are stranded on foot (2.4%) and 36,796 for
    // wheelchair (6.0%). Reported case: 52.546,13.36 in Wedding snapped to
    // vertex 585731, 22m away, both of whose edges are cycleway.
    //
    // So require at least one edge this profile can actually use. The KNN scan
    // stops at the first vertex that passes, which for most clicks is still the
    // nearest one; idx_berlin_v2_source/target make the check cheap.
    const vertexRes = await pool.query(
      `SELECT v.id, ST_Distance(v.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
       FROM ${schema}.ways_vertices_pgr v
       WHERE v.main_component
         AND EXISTS (
           SELECT 1 FROM ${schema}.ways w
            WHERE (w.source = v.id OR w.target = v.id)
              AND (${costExpr(profile as ProfileName)}) > 0
         )
       ORDER BY v.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
      [lonNum, latNum]
    );
    const row = vertexRes.rows[0];
    // Throwing here reached the client as an HTML stack trace exposing the
    // source path. It means the schema has no routable vertex at all, which
    // is a broken import rather than a bad request.
    if (!row) {
      console.error(`❌ ${schema} has no routable vertices`);
      return res.status(503).json({
        error: "coverage unavailable",
        detail:
          `The data for this area (${schema}) is incomplete and cannot be ` +
          `routed on. It needs re-importing.`,
      });
    }

    if (row.dist_m > MAX_SNAP_M) {
      // Inside an imported area, importing again would change nothing: the
      // spot is simply off the walkable network (a field, a lake, a motorway
      // verge). Say so instead of offering a pointless import.
      if (matched) {
        return res.status(400).json({
          error: "no street nearby",
          detail:
            `This area is imported, but the nearest walkable street is ` +
            `${Math.round(row.dist_m)}m away — farther than the ${MAX_SNAP_M}m ` +
            `snapping limit. Click closer to a road or path.`,
        });
      }
      return res.status(400).json({
        error: "outside coverage",
        detail: `Nearest routable street is ${Math.round(
          row.dist_m / 1000
        )}km away. Imported coverage here is ${schema} (bbox ${await getCoverage(
          schema
        )}). POST /api/areas with a bbox to import a new area.`,
      });
    }
    vertexId = row.id;

    // only successful snaps are cached, so the guard can't be bypassed
    await cacheSet(vertexKey, vertexId.toString(), 60 * 60 * 24);
  }

  // The reachable set IS the street network — one query at the longest
  // duration returns every edge with its arrival time, grouped into BANDS
  // equal-width time slices the client colors as a ramp.
  const duration = Math.max(...durations);
  const maxCost = duration * 60;

  // Nothing past straight-line max speed × time is reachable, so hand
  // pgr_drivingDistance only the edges inside that box — otherwise it builds a
  // graph from all ~720k city edges on every request.
  const reachM = maxCost * PROFILES[profile].speed;
  const dLat = reachM / 111320;
  const dLon = reachM / (111320 * Math.cos((latNum * Math.PI) / 180));
  const bbox =
    `geom && ST_Expand(ST_SetSRID(ST_MakePoint(${lonNum.toFixed(
      6
    )}, ${latNum.toFixed(6)}), 4326), ` +
    `${dLon.toFixed(6)}, ${dLat.toFixed(6)})`;
  // net2: bumped when the vertex snap became profile-aware. Every answer cached
  // under net: for a click that had snapped to a profile-stranded vertex is an
  // empty FeatureCollection, and those are exactly the ones the fix repairs —
  // leaving the prefix alone would have served the bug for another 24 hours.
  // Same precedent as poi2 and suggest3: bump whenever the computation behind
  // the value changes, not just its shape.
  const redisKey = `net2:${schema}:${latNum.toFixed(5)},${lonNum.toFixed(
    5
  )}:${duration}:${profile}`;

  try {
    const cached = await cacheGet(redisKey);
    if (cached) {
      console.log(`📦 Network cache hit for ${redisKey}`);
      cacheHits++;
      res.json(JSON.parse(cached));
      return;
    }

    const result = await pool.query(
      `WITH dd AS (
         SELECT edge, agg_cost
         FROM pgr_drivingDistance(
           'SELECT id::integer AS id, source::integer, target::integer, ${costExpr(
             profile
           )} AS cost, ${costExpr(
        profile
      )} AS reverse_cost FROM ${schema}.ways WHERE ${bbox}',
           $1::integer,
           $2::double precision
         )
         WHERE edge > 0
       ),
       banded AS (
         SELECT LEAST(
                  $3::integer,
                  GREATEST(1, CEIL(dd.agg_cost / ($2::double precision / $3::integer)))
                )::integer AS band,
                ST_Collect(w.geom) AS geom
         FROM dd JOIN ${schema}.ways w ON w.id = dd.edge
         GROUP BY 1
       )
       SELECT COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'type', 'Feature',
             -- 6 decimals is ~10cm; far beyond what any zoom level renders
             'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00003), 6)::jsonb,
             'properties', jsonb_build_object('band', band)
           ) ORDER BY band
         ),
         '[]'::jsonb
       ) AS features
       FROM banded;`,
      [vertexId, maxCost, BANDS]
    );

    const responseObj = {
      profile,
      minutes: duration,
      bands: BANDS,
      geojson: {
        type: "FeatureCollection",
        features: result.rows?.[0]?.features ?? [],
      },
    };

    await cacheSet(redisKey, JSON.stringify(responseObj), 60 * 60 * 24);

    console.log(
      `✅ Network (${responseObj.geojson.features.length} bands) in ${
        Date.now() - start
      }ms`
    );
    res.json(responseObj);
  } catch (err) {
    console.error("❌ Isochrone network error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// In production the built UI is served from here, so there's no second
// web server to run. In dev this directory doesn't exist and vite proxies.
const uiDist = process.env.UI_DIST ?? path.join(__dirname, "../isochrone-ui/dist");
if (fs.existsSync(uiDist)) {
  app.use(express.static(uiDist));
  console.log(`📦 Serving UI from ${uiDist}`);
}

// --- suggestion cache warm pass (T-016, extended T-017) ---------------------
// The questionnaire (isochrone-ui/MapView.tsx) is six fixed-choice questions
// with 4 x 3 x 2 x 3 x 3 x 3 = 648 possible answers, so the whole answer space
// is enumerable — kept here as a literal table rather than imported from the
// UI, since the two only have to agree on the *answer space*, not on copy or
// option order. A slider-based questionnaire would make this key space
// unbounded, which is a second, independent reason (besides ADR-0014's
// geocode rate gate) the questionnaire stays fixed-choice rather than
// continuous.
//
// T-017 grew this from 324: "Who's moving?" gained a fourth option ("with a
// dog", below) and mobility gained cycling (REACH_PROFILES growing to 3 in
// layers.ts already does that half for free).
//
// The dog option is not a new layer — it sets greenspace to weight 3. The
// green space question can also set greenspace, independently, so the two
// answers are merged by MAX below, not last-write — mirrors
// buildSuggestWeights in isochrone-ui/src/MapView.tsx, which merges the same
// way for the same reason: household=dog + greenspace="not much" must still
// warm `greenspace:3`, because that's the w= string the UI actually sends
// (max(3, 0)), not `greenspace:0`. Object spread here would drop the dog's
// ask whenever the green space question's answer landed later in the merge
// order, warming a key no real request constructs. See T-017 ticket for why
// dog_park/vet/pet POIs are too sparse to carry their own layer.
//
// This is a mirrored rule, not a shared function: the UI bundle deliberately
// does not import backend modules (it keeps its own literal ReachLayer
// union for the same reason), so buildSuggestWeights and the merge below
// must be kept in agreement by hand. T-012 is the scar from exactly this
// kind of pair drifting silently — if you change one, change the other.
const Q_MOVING = [
  {},
  { kindergarten: 3, playground: 2 },
  { school: 3, playground: 2 },
  { greenspace: 3 }, // "with a dog"
] as const;
const Q_MOBILITY = REACH_PROFILES;
const Q_GROCERIES = [{ groceries: 3 }, { groceries: 1 }] as const;
const Q_HEALTH = [{ health: 3 }, { health: 1 }, { health: 0 }] as const;
const Q_GREENSPACE = [{ greenspace: 3 }, { greenspace: 1 }, { greenspace: 0 }] as const;
const Q_DINING = [{ dining: 3 }, { dining: 1 }, { dining: 0 }] as const;

// Mirrors buildSuggestWeights' merge in MapView.tsx (comment above explains
// why it's mirrored rather than shared): the higher ask always wins when two
// questions write the same layer, rather than whichever was spread last.
const mergeWeightsMax = (
  ...parts: readonly Partial<Record<string, number>>[]
): Record<string, number> => {
  const w: Record<string, number> = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part)) w[k] = Math.max(w[k] ?? 0, v ?? 0);
  }
  return w;
};

const WARM_ANSWERS: { profile: string; weights: Record<string, number> }[] = [];
for (const moving of Q_MOVING) {
  for (const profile of Q_MOBILITY) {
    for (const groceries of Q_GROCERIES) {
      for (const health of Q_HEALTH) {
        for (const greenspace of Q_GREENSPACE) {
          for (const dining of Q_DINING) {
            WARM_ANSWERS.push({
              profile,
              weights: mergeWeightsMax(moving, groceries, health, greenspace, dining),
            });
          }
        }
      }
    }
  }
}

// Guards against overlap with itself, not with drainQueue/sweepPois — nothing
// else calls scoreSuggestions in a loop. Serial and awaited on purpose: this
// is a 2-vCPU box, and 648 concurrent aggregates would compete for exactly
// the postgres connections real traffic needs.
let warmingInFlight = false;
const warmSuggestCache = async () => {
  if (warmingInFlight) return;
  warmingInFlight = true;
  try {
    let hasRows = false;
    try {
      const has = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM ${DEFAULT_SCHEMA}.reach LIMIT 1) AS has_rows`
      );
      hasRows = has.rows[0].has_rows;
    } catch (err) {
      if ((err as any).code !== "42P01") throw err;
    }
    if (!hasRows) {
      console.log(
        `ℹ️ ${DEFAULT_SCHEMA}.reach is empty; skipping the suggestion cache warm pass`
      );
      // ponytail: one-shot at startup, no periodic recheck. The precompute is
      // an offline artifact loaded once, and the process restarts after it
      // lands (same deploy step as any other schema change) — add a recheck
      // loop only if that assumption stops holding.
      return;
    }
    const start = Date.now();
    console.log(`🔥 warming ${WARM_ANSWERS.length} suggestion answer sets...`);
    // Every cell the questionnaire can ever surface, collected as a side effect
    // of warming rather than by a second sweep: 275 of them across all 648
    // answers, which is the whole naming budget (see fillPlaceNames).
    const everShown = new Map<string, { lat: number; lon: number }>();
    // Different answers collapse onto the same cache key — "not really" and
    // "not much" both drop their layer, and mergeWeightsMax folds overlapping
    // household/greenspace picks together. 648 answers, 501 distinct keys, so a
    // naive loop spent 23% of the pass recomputing scores it had already cached.
    // Cheap to skip now that each query is a full scan of the reach field.
    const warmed = new Set<string>();
    for (const answer of WARM_ANSWERS) {
      const entries = normalizeWeights(answer.weights);
      if (!entries.length) continue; // no combination above produces this; kept defensive
      const key = suggestCacheKey(answer.profile, entries);
      if (warmed.has(key)) continue;
      warmed.add(key);
      try {
        const body = await scoreSuggestions(answer.profile, entries);
        for (const c of (body as any).cells ?? [])
          everShown.set(`${c.lat.toFixed(4)},${c.lon.toFixed(4)}`, { lat: c.lat, lon: c.lon });
      } catch (err) {
        console.error(
          `⚠️ suggest warm pass: ${suggestCacheKey(answer.profile, entries)} failed:`,
          (err as Error).message
        );
      }
    }
    console.log(
      `🔥 suggest warm pass done: ${warmed.size} distinct keys from ${
        WARM_ANSWERS.length
      } answer sets in ${Date.now() - start}ms`
    );

    // Guard the empty case: if every answer failed, `VALUES ` below has nothing
    // to interpolate and Postgres reports `syntax error at or near ")"` — which
    // is what a missing reach.nearby column looked like from three layers away.
    // An empty set here means the warm pass produced nothing, which the errors
    // above have already said.
    if (!everShown.size) return;

    // Not awaited: this is ~275 requests at Nominatim's 1 req/s, so about five
    // minutes. Startup must not wait for it, and results are useful unnamed.
    const unnamed = await pool.query<{ lat: string; lon: string }>(
      `SELECT v.lat::text, v.lon::text
         FROM (VALUES ${[...everShown.values()]
           .map((_, i) => `($${i * 2 + 1}::numeric, $${i * 2 + 2}::numeric)`)
           .join(",")}) AS v(lat, lon)
         LEFT JOIN public.place_names p ON p.lat = v.lat AND p.lon = v.lon
        WHERE p.lat IS NULL`,
      [...everShown.values()].flatMap((c) => [c.lat.toFixed(4), c.lon.toFixed(4)])
    );
    if (unnamed.rowCount) {
      console.log(
        `🏷️ naming ${unnamed.rowCount} of ${everShown.size} result places (~${Math.ceil(
          unnamed.rowCount / 60
        )} min at 1 req/s)`
      );
      void fillPlaceNames(
        unnamed.rows.map((r) => ({ lat: +r.lat, lon: +r.lon }))
      ).then(() => console.log(`🏷️ place naming complete`));
    }
  } finally {
    warmingInFlight = false;
  }
};

ensureAreasTable()
  .then(backfillCoverage)
  // Before the warm pass, not after: warming caches scored answers, and warming
  // against NULL density would freeze 648 pre-density answers for 7 days.
  .then(backfillNearby)
  .then(drainQueue)
  .then(warmSuggestCache)
  .catch((err) =>
    console.error("⚠️ could not ensure areas table:", (err as Error).message)
  );

app.listen(port, () => {
  console.log(`🚀 Isochrone backend running at http://localhost:${port}`);
});
