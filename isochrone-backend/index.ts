// src/index.ts
import express from "express";
import { Pool } from "pg";
import cors from "cors";
import { createClient } from "redis";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";

const app = express();
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
const PROFILES = {
  walk: { speed: 1.4, factors: { 104: 0.5 } },
  stroller: { speed: 1.2, factors: { 104: 0, 103: 0.6, 107: 0.6 } },
  wheelchair: { speed: 0.9, factors: { 104: 0, 103: 0, 107: 0, 105: 0.9 } },
} as const;

type ProfileName = keyof typeof PROFILES;

// Time slices the client paints with a 10-step sequential ramp.
const BANDS = 10;

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

app.get("/api/profiles", (_, res) => {
  res.json(Object.keys(PROFILES));
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

  if (Math.max(...durations) > MAX_MINUTES) {
    return res
      .status(400)
      .json({ error: `minutes must be ${MAX_MINUTES} or less` });
  }

  const vertexKey = `vertex:${latNum.toFixed(5)},${lonNum.toFixed(5)}`;
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
      "SELECT id FROM ways_vertices_pgr WHERE main_component ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1",
      [lonNum, latNum]
    );
    vertexId = vertexRes.rows[0]?.id;
    if (!vertexId) throw new Error("No nearest vertex found");

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
  const redisKey = `net:${latNum.toFixed(5)},${lonNum.toFixed(
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
      )} AS reverse_cost FROM ways WHERE ${bbox}',
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
         FROM dd JOIN ways w ON w.id = dd.edge
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

app.listen(port, () => {
  console.log(`🚀 Isochrone backend running at http://localhost:${port}`);
});
