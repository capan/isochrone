# isochrone-mcp

MCP server for pedestrian isochrones: from a point, the actual street network
reachable within a time budget — not a convex hull — for **walk**, **stroller**,
**wheelchair** and **bike** profiles (stairs and rough surfaces slow or block
strollers and wheelchairs; cycle paths are bike-only).
Backed by [iso.huseyincapan.dev](https://iso.huseyincapan.dev)
(OSM → pgRouting). **Currently covers Berlin, Germany.**

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

## Tool: `reachable_area`

| arg | | |
|---|---|---|
| `lat`, `lon` | required | origin (WGS84) |
| `minutes` | optional | time budget. Faster profiles allow fewer minutes (walk 25, bike 10) because the work grows with the area searched. Omit for the profile's default. |
| `profile` | `walk` \| `stroller` \| `wheelchair` \| `bike` | mobility profile |
| `target` | optional `{lat, lon}` | is this destination reachable, and when? |
| `include_geometry` | default `false` | also return the raw GeoJSON bands |

Returns a prose summary: total street length reached, N–S/E–W extent, arrival
band for the target if given, and a link to view the isochrone on the map.

```
15 min (walk) from 52.52, 13.405 reaches 132.3 km of streets, spanning
3.0 km N–S × 3.5 km E–W in 10 arrival-time bands.
Target 52.522, 13.41 is reachable: arrival ~7.5–9.0 min (band 6 of 10).
Map: https://iso.huseyincapan.dev/?lat=52.52&lon=13.405&profile=walk
```

Point it at your own deployment with `ISOCHRONE_API=https://your-host`.

## Caveats

- Berlin only (for now). Anywhere else returns an "outside coverage" error.
- The bike profile ignores one-way restrictions: the data doesn't record
  where contraflow cycling is allowed, and in Berlin it usually is.
- Stroller/wheelchair speed factors are reasoned estimates, not calibrated
  measurements.
