# isochrone

Click anywhere on the map and see the street network you can actually reach on
foot within 15 minutes — coloured by arrival time, with mobility profiles that
account for stairs and unpaved paths.

OSM data → PostGIS + pgRouting → Express → Leaflet.

## How it works

`pgr_drivingDistance` walks the street graph from the vertex nearest your click
until the time budget runs out, and returns every reachable edge with its
arrival time. Those edges are grouped into 10 equal time bands and drawn
directly — no hull, so the map shows the streets you can reach rather than a
blob implying you can cross the middle of a block.

Edge cost is `length / speed` in seconds, computed per request from the
selected profile, so a profile is a few numbers rather than a schema change:

| profile | speed | stairs | unpaved |
|---|---|---|---|
| `walk` | 1.4 m/s | half speed | normal |
| `stroller` | 1.2 m/s | impassable | 0.6× |
| `wheelchair` | 0.9 m/s | impassable | impassable |

These factors are estimates, not measurements — see *Calibration* below.

## Dev

Needs Postgres (PostGIS + pgRouting) on 5454 and Redis on 6363:

    docker compose up -d db redis

Import a city (needs `osm2pgrouting`, `osmium-tool` and `libpq` on PATH —
`export PATH="/opt/homebrew/opt/libpq/bin:$PATH"` on macOS):

    cd overpass/osm-imports && ./import_city.sh germany berlin

Then:

    cd isochrone-backend && npm i && npm start   # :3001
    cd isochrone-ui && npm i && npm run dev      # :5173, proxies /api

## Deploy

    cp .env.example .env      # change PGPASSWORD
    docker compose up -d --build

The app container serves both the API and the built UI on :3001, so there's no
separate web server. The database starts empty — run `import_city.sh` against
the exposed port (5454) once, and it persists in the `pgdata` volume.

`CITY` selects which schema to query and must match the imported one
(`import_city.sh greater-london` creates schema `greater_london`).

## Checks

    node scripts/check.mjs     # needs the backend running

Asserts every time band comes back and that reach is non-increasing across
`walk` → `stroller` → `wheelchair`.

## Warming the cache

`scripts/precompute.ts` and the RabbitMQ `producer.ts`/`worker.ts` pair drive
the backend over HTTP rather than reimplementing the routing SQL, so they can't
drift out of sync with it. Live queries are ~0.4s, so this is only worth
running for a city-wide sweep.

## Known gaps

- **Graph islands.** The vertex nearest a click can sit on a disconnected
  fragment — `52.515,13.400` reaches 13 nodes. Fix is a one-time
  `pgr_connectedComponents` table for the vertex lookup to join against.
- **Calibration.** The speeds above are guesses. Google's Isochrones API
  (Preview) supports `WALK` and returns GeoJSON, so the `walk` profile could be
  calibrated against it. It has no stroller/wheelchair mode, so those stay
  unvalidated.
- **Stranded origins** render as a tiny blob rather than saying "unreachable
  with this profile".
