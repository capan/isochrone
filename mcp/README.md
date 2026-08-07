# isochrone-mcp

MCP server for pedestrian isochrones: from a point, the actual street network
reachable within a time budget — not a convex hull — for **walk**, **stroller**,
**wheelchair** and **bike** profiles (stairs and rough surfaces slow or block
strollers and wheelchairs; cycle paths are bike-only).
Backed by [iso.huseyincapan.dev](https://iso.huseyincapan.dev)
(OSM → pgRouting). **Berlin is always covered; other areas can be imported on demand.**

This is a portfolio project. The API it calls is a single small VPS with a
60 req/min rate limit — fine for interactive agent use, not for batch jobs.

<img src="https://raw.githubusercontent.com/capan/isochrone/main/mcp/demo.gif" width="660" alt="Claude answering a reachability question, then the isochrone drawn on the map">


## Install

```bash
claude mcp add isochrone -- npx -y isochrone-mcp
```

Or in any MCP client config:

```json
{ "mcpServers": { "isochrone": { "command": "npx", "args": ["-y", "isochrone-mcp"] } } }
```

## Tool: `reachable_area` — how far can I get?

| arg | | |
|---|---|---|
| `lat`, `lon` | required | origin (WGS84) |
| `minutes` | optional | time budget. Faster profiles allow fewer minutes (walk 25, bike 10) because the work grows with the area searched. Omit for the profile's default. |
| `profile` | `walk` \| `stroller` \| `wheelchair` \| `bike` | mobility profile |
| `target` | optional `{lat, lon}` | is this destination reachable, and when? |
| `include_places` | default `true` | also count what's reachable by group |
| `include_geometry` | default `false` | also return the raw GeoJSON bands |

Returns a prose summary: total street length reached, N–S/E–W extent, arrival
band for the target if given, and a link to view the isochrone on the map.

```
15 min (walk) from 52.52, 13.405 reaches 132.3 km of streets, spanning
3.0 km N–S × 3.5 km E–W in 10 arrival-time bands.
Target 52.522, 13.41 is reachable: arrival ~7.5–9.0 min (band 6 of 10).
Places within reach: 414 food, 284 shops, 200 culture, 166 outdoors, 51 money.
Map: https://iso.huseyincapan.dev/?lat=52.52&lon=13.405&profile=walk
```

## Tool: `places_nearby` — what can I get to?

Lists actual places with how long each takes to reach. Called without `group`
or `kinds` it returns a breakdown by group and invites you to pick one, rather
than an arbitrary mixture of the nearest things.

| arg | | |
|---|---|---|
| `lat`, `lon` | required | origin (WGS84) |
| `minutes`, `profile` | optional | as above |
| `group` | optional | food, shops, culture, health, learning, outdoors, money |
| `kinds` | optional | specific kinds, e.g. `["cafe","bakery"]`; wins over `group` |
| `limit` | default 15 | how many to list, nearest first |

```
8 pharmacy places within 15 min (walk) of 52.5219, 13.4132; nearest 3:
· 3.1 min — Bezirksapotheke am Roten Rathaus (pharmacy)
· 3.8 min — Panorama Apotheke (pharmacy)
· 5.8 min — Alexa Apotheke (pharmacy)
```

Point it at your own deployment with `ISOCHRONE_API=https://your-host`.

## Caveats

- Berlin is always covered. Elsewhere depends on whether somebody has
  imported that area on the map yet; if not, you get an "outside coverage"
  error naming the nearest coverage, and anyone can add a 5×5 km area from
  the map in under a minute.
- The bike profile ignores one-way restrictions: the data doesn't record
  where contraflow cycling is allowed, and in Berlin it usually is.
- Stroller/wheelchair speed factors are reasoned estimates, not calibrated
  measurements.
