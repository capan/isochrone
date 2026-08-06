// src/index.ts
import express from "express";
import { Pool } from "pg";
import cors from "cors";
import { createClient } from "redis";
import rateLimit from "express-rate-limit";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

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
const PROFILES = {
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
type ProfileName = keyof typeof PROFILES;

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
    CREATE INDEX IF NOT EXISTS idx_areas_bbox ON public.areas USING GIST (bbox);
  `);
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

  // A crash mid-import leaves a row claiming 'importing' forever, and its
  // schema half-built; re-queue it so the worker redoes it cleanly.
  const stuck = await pool.query(
    `UPDATE public.areas SET status = 'queued' WHERE status = 'importing'
     RETURNING id`
  );
  if (stuck.rowCount) console.log(`↻ re-queued ${stuck.rowCount} stuck import(s)`);
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
       SELECT id, schema_name FROM public.areas
        WHERE status = 'ready'
          AND ST_Contains(bbox, ST_SetSRID(ST_MakePoint($1, $2), 4326))
        ORDER BY ST_Area(bbox) ASC
        LIMIT 1
     ), touch AS (
       UPDATE public.areas SET last_used_at = now()
        WHERE id = (SELECT id FROM pick)
          AND (last_used_at IS NULL OR last_used_at < now() - interval '10 minutes')
     )
     SELECT schema_name FROM pick`,
    [lon, lat]
  );
  // `matched` distinguishes "no area covers this point" from "an area covers
  // it but the click landed off the pedestrian network" — the two produce
  // very different advice, and only the first is fixable by importing.
  return {
    schema: (r.rows[0]?.schema_name as string) ?? DEFAULT_SCHEMA,
    matched: Boolean(r.rows[0]),
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

// A click farther than this from any routable street is outside the imported
// area. In-city snaps measure 7–67m; Paris would otherwise snap to Berlin's
// westernmost vertex and return a silent empty result.
const MAX_SNAP_M = 500;

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

// Builds the cost expression pgr_drivingDistance routes on. Numbers only —
// no user input reaches this string (profile names are whitelisted below).
const costExpr = (name: ProfileName) => {
  const { speed, factors } = PROFILES[name];
  const cases = Object.entries(factors).map(
    ([tag, f]) =>
      `WHEN tag_id = ${tag} THEN ${f === 0 ? "-1" : `length_m / ${speed * f}`}`
  );
  return cases.length
    ? `CASE ${cases.join(" ")} ELSE length_m / ${speed} END`
    : `length_m / ${speed}`;
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
    `SELECT id, schema_name, status, created_at,
            ST_YMin(bbox) AS min_lat, ST_XMin(bbox) AS min_lon,
            ST_YMax(bbox) AS max_lat, ST_XMax(bbox) AS max_lon
       FROM public.areas ORDER BY created_at`
  );
  res.json(r.rows);
});

// Merged coverage as one geometry. The map veils everything *outside* this,
// and overlapping boxes would otherwise punch the veil twice and re-fill the
// overlap (SVG evenodd), showing a dark patch inside covered ground.
app.get("/api/coverage", pollLimiter, async (_, res) => {
  const r = await pool.query(
    `SELECT ST_AsGeoJSON(ST_Union(bbox))::jsonb AS g
       FROM public.areas WHERE status = 'ready'`
  );
  res.json(r.rows[0]?.g ?? null);
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
const importLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: parseInt(process.env.IMPORT_LIMIT ?? "10", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Only real imports should cost quota. Without this a mistyped box or a
  // repeat request for an area that already exists burns the same budget as
  // an actual osm2pgrouting run — the smoke check alone spends three.
  skipFailedRequests: true,
  message: {
    error: "Import limit reached (10/hour). Try again later.",
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
  const existing = await pool.query(
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

  drainQueue(); // fire and forget; the worker serializes
  res.status(202).json({
    id,
    status: "queued",
    ahead,
    poll: `/api/areas/${id}`,
    estimateSeconds: eachSeconds * (ahead + 1),
  });
});

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
      headers: { "User-Agent": "isochrone/0.1 (+https://iso.huseyincapan.dev)" },
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

    await pool.query(`UPDATE public.areas SET status = 'ready' WHERE id = $1`, [
      areaId,
    ]);
    console.log(
      `✅ imported ${schemaName} (${counts.rows[0].ways} ways) in ${
        Date.now() - start
      }ms — ${Math.round(await importedMb())}MB of ${MAX_IMPORT_MB}MB used`
    );
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

  const vertexKey = `vertex:${schema}:${latNum.toFixed(5)},${lonNum.toFixed(5)}`;
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
    const vertexRes = await pool.query(
      `SELECT id, ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
       FROM ${schema}.ways_vertices_pgr WHERE main_component
       ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
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
  const redisKey = `net:${schema}:${latNum.toFixed(5)},${lonNum.toFixed(
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

ensureAreasTable()
  .then(drainQueue)
  .catch((err) =>
    console.error("⚠️ could not ensure areas table:", (err as Error).message)
  );

app.listen(port, () => {
  console.log(`🚀 Isochrone backend running at http://localhost:${port}`);
});
