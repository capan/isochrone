#!/usr/bin/env node
// isochrone-mcp — one tool, `reachable_area`, backed by the public isochrone
// API. Returns a prose summary by default; the raw GeoJSON only on request
// (70KB of coordinates is context poison for an LLM client).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.ISOCHRONE_API ?? "https://iso.huseyincapan.dev";

const KM_PER_DEG_LAT = 111.32;

// equirectangular projection to km, good to <0.1% at city scale
const project = (lat0) => {
  const kx = KM_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return ([lon, lat]) => [lon * kx, lat * KM_PER_DEG_LAT];
};

const linesOf = (geom) =>
  geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];

const pointSegDistKm = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// A target counts as reached if it's within a short walk off the network —
// matches the scale of in-city snap distances (7–67m measured).
const TARGET_SNAP_KM = 0.1;

const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

const server = new McpServer({ name: "isochrone-mcp", version: "0.1.0" });

server.registerTool(
  "reachable_area",
  {
    title: "Pedestrian reachable area",
    description:
      "Computes the street network reachable on foot from a point within a time " +
      "budget, for walk, stroller, or wheelchair mobility profiles (stairs and " +
      "rough surfaces slow or block the latter two). Returns a summary with " +
      "total street length, extent, and a map link. Currently covers Berlin, Germany.",
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Origin latitude (WGS84)"),
      lon: z.number().min(-180).max(180).describe("Origin longitude (WGS84)"),
      minutes: z.number().int().min(1).max(25).default(15)
        .describe("Time budget in minutes (1–25)"),
      profile: z.enum(["walk", "stroller", "wheelchair"]).default("walk")
        .describe("Mobility profile"),
      target: z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }).optional()
        .describe("Optional destination: reports whether it's reachable in the time budget and the approximate arrival time"),
      include_geometry: z.boolean().default(false)
        .describe("Also return the raw GeoJSON (10 arrival-time bands, large)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ lat, lon, minutes, profile, target, include_geometry }) => {
    const url = `${API}/api/isochrone?lat=${lat}&lon=${lon}&minutes=${minutes}&profile=${profile}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return errResult(
        `Could not reach the isochrone API at ${API} (${e.message}). ` +
        `Check ${API}/healthz.`
      );
    }

    if (!res.ok) {
      if (res.status === 429) {
        return errResult("Rate limited (60 requests/min per IP). Wait a minute and retry.");
      }
      let body = {};
      try { body = await res.json(); } catch { /* non-JSON error page */ }
      if (res.status === 400) {
        return errResult([body.error, body.detail].filter(Boolean).join(". ") || "Bad request.");
      }
      return errResult(`API error (HTTP ${res.status}). Check ${API}/healthz.`);
    }

    const data = await res.json();
    const features = data.geojson.features;

    // one pass over the geometry: total length, extent, per-band distance to target
    const toKm = project(lat);
    const [tx, ty] = target ? toKm([target.lon, target.lat]) : [0, 0];
    let totalKm = 0;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    let targetBand = null;
    let targetDistKm = Infinity;
    for (const f of features) {
      for (const line of linesOf(f.geometry)) {
        let prev = null;
        for (const c of line) {
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
          const p = toKm(c);
          if (prev) {
            totalKm += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            if (target) {
              const d = pointSegDistKm([tx, ty], prev, p);
              if (d < targetDistKm) {
                targetDistKm = d;
                targetBand = f.properties.band;
              }
            }
          }
          prev = p;
        }
      }
    }

    const lines = [];
    if (totalKm === 0) {
      lines.push(
        `No streets reachable within ${minutes} min from ${lat}, ${lon} with profile "${profile}".`
      );
    } else {
      const nsKm = (maxLat - minLat) * KM_PER_DEG_LAT;
      const ewKm = (maxLon - minLon) * KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
      lines.push(
        `${minutes} min (${profile}) from ${lat}, ${lon} reaches ` +
        `${totalKm.toFixed(1)} km of streets, spanning ` +
        `${nsKm.toFixed(1)} km N–S × ${ewKm.toFixed(1)} km E–W ` +
        `in ${data.bands} arrival-time bands.`
      );
    }

    if (target) {
      const t = `${target.lat}, ${target.lon}`;
      if (targetDistKm <= TARGET_SNAP_KM) {
        const bandMin = minutes / data.bands;
        lines.push(
          `Target ${t} is reachable: arrival ~${((targetBand - 1) * bandMin).toFixed(1)}–` +
          `${(targetBand * bandMin).toFixed(1)} min (band ${targetBand} of ${data.bands}).`
        );
      } else {
        lines.push(
          `Target ${t} is NOT reachable within ${minutes} min` +
          (targetDistKm < Infinity
            ? ` (nearest reached street is ${targetDistKm.toFixed(2)} km from it).`
            : ".")
        );
      }
    }

    // ponytail: heuristic, no second API call — a non-walk profile reaching
    // almost nothing usually means the origin is stranded for that profile
    if (profile !== "walk" && totalKm < 1) {
      lines.push(
        "This origin may be unreachable for this profile (stairs/surfaces); try profile=walk to compare."
      );
    }

    lines.push(`Map: ${API}/?lat=${lat}&lon=${lon}&profile=${profile}`);

    const content = [{ type: "text", text: lines.join("\n") }];
    if (include_geometry) {
      content.push({ type: "text", text: JSON.stringify(data.geojson) });
    }
    return { content };
  }
);

await server.connect(new StdioServerTransport());
