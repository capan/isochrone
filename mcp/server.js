#!/usr/bin/env node
// isochrone-mcp — two tools over the public isochrone API: `reachable_area`
// (how far can I get) and `places_nearby` (what can I get to). Both answer in
// prose; raw GeoJSON only on request, because 70KB of coordinates is context
// poison for an LLM client.
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

// Place groups come from the API rather than being restated here — the same
// rule the profile caps follow, so adding a group server-side reaches clients
// without a release.
let groupsCache;
const groups = async () => {
  if (groupsCache) return groupsCache;
  try {
    groupsCache = await (await fetch(`${API}/api/place-groups`)).json();
  } catch {
    groupsCache = [];
  }
  return groupsCache;
};

const fetchPlaces = async (lat, lon, minutes, profile) => {
  const r = await fetch(
    `${API}/api/amenities?lat=${lat}&lon=${lon}&minutes=${minutes}&profile=${profile}`
  );
  if (!r.ok) return null;
  return (await r.json()).items ?? [];
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// profile → max minutes, fetched once. If the API is unreachable the caller
// still gets a clear error from the isochrone request itself, so an empty map
// here just means "fall back to the generic default".
let capsCache;
const caps = async () => {
  if (capsCache) return capsCache;
  try {
    const r = await fetch(`${API}/api/profiles`);
    const list = await r.json();
    capsCache = Object.fromEntries(list.map((p) => [p.name, p.maxMinutes]));
  } catch {
    capsCache = {};
  }
  return capsCache;
};

const server = new McpServer({ name: "isochrone-mcp", version: "0.1.0" });

server.registerTool(
  "reachable_area",
  {
    title: "Reachable area on foot or by bike",
    description:
      "Computes the street network reachable from a point within a time budget, " +
      "for walk, stroller, wheelchair or bike profiles (steps and rough surfaces " +
      "slow or block the middle two; cycle paths are bike-only). Returns a " +
      "summary with total street length, extent, and a map link. " +
      "Currently covers Berlin, Germany.",
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Origin latitude (WGS84)"),
      lon: z.number().min(-180).max(180).describe("Origin longitude (WGS84)"),
      minutes: z.number().int().min(1).max(25).optional()
        .describe(
          "Time budget in minutes. Faster profiles allow fewer: walking allows " +
          "up to 25, cycling up to 10, because the work grows with the area " +
          "searched. Omit to use the profile's sensible default."
        ),
      profile: z.enum(["walk", "stroller", "wheelchair", "bike"]).default("walk")
        .describe("Mobility profile"),
      target: z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }).optional()
        .describe("Optional destination: reports whether it's reachable in the time budget and the approximate arrival time"),
      include_places: z.boolean().default(true)
        .describe("Also summarise how many places of each group are reachable (food, shops, culture, health, learning, outdoors, money)"),
      include_geometry: z.boolean().default(false)
        .describe("Also return the raw GeoJSON (10 arrival-time bands, large)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ lat, lon, minutes, profile, target, include_places, include_geometry }) => {
    // Ask the API for the caps rather than restating them: they are derived
    // from a reach budget server-side and would drift the moment it changes.
    minutes = minutes ?? Math.min(15, (await caps())[profile] ?? 15);
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

    if (include_places && totalKm > 0) {
      const items = await fetchPlaces(lat, lon, minutes, profile);
      if (items?.length) {
        const gs = await groups();
        const counts = gs
          .map((g) => [g.label, items.filter((i) => g.kinds.includes(i.kind)).length])
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([label, n]) => `${n} ${label}`);
        lines.push(`Places within reach: ${counts.join(", ")}.`);
      }
    }

    lines.push(`Map: ${API}/?lat=${lat}&lon=${lon}&profile=${profile}`);

    const content = [{ type: "text", text: lines.join("\n") }];
    if (include_geometry) {
      content.push({ type: "text", text: JSON.stringify(data.geojson) });
    }
    return { content };
  }
);

server.registerTool(
  "places_nearby",
  {
    title: "Places reachable from a point",
    description:
      "Lists actual places — cafes, shops, museums, pharmacies, parks — that can " +
      "be reached from a point within a time budget, each with how long it takes " +
      "to get there. Filter by group (food, shops, culture, health, learning, " +
      "outdoors, money) or by specific kinds such as 'cafe' or 'pharmacy'. " +
      "Called without group or kinds it returns a breakdown by group rather "
      + "than an arbitrary mixture, so ask the user which they want. "
      + "Use this for 'what can I get to', and reachable_area for 'how far can I get'. " +
      "Currently covers Berlin, Germany.",
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Origin latitude (WGS84)"),
      lon: z.number().min(-180).max(180).describe("Origin longitude (WGS84)"),
      minutes: z.number().int().min(1).max(25).optional()
        .describe("Time budget in minutes. Omit for the profile's default."),
      profile: z.enum(["walk", "stroller", "wheelchair", "bike"]).default("walk")
        .describe("Mobility profile"),
      group: z.string().optional()
        .describe("Restrict to one group: food, shops, culture, health, learning, outdoors, money"),
      kinds: z.array(z.string()).optional()
        .describe("Restrict to specific kinds, e.g. ['cafe','bakery']. Takes precedence over group."),
      limit: z.number().int().min(1).max(50).default(15)
        .describe("How many to list, nearest first"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ lat, lon, minutes, profile, group, kinds, limit }) => {
    minutes = minutes ?? Math.min(15, (await caps())[profile] ?? 15);

    let items;
    try {
      items = await fetchPlaces(lat, lon, minutes, profile);
    } catch (e) {
      return errResult(`Could not reach the API at ${API} (${e.message}).`);
    }
    if (items === null) {
      return errResult(
        `No places could be looked up there — the point may be outside the ` +
        `imported coverage. Try reachable_area first, which explains why.`
      );
    }

    const gs = await groups();

    // Without a filter the nearest 15 are an arbitrary mixture — a kebab
    // shop, a dentist and a clothes shop tell nobody anything. Report the
    // shape of what's there and let the caller choose.
    if (!group && !kinds?.length) {
      const counts = gs
        .map((g) => [g.label, items.filter((i) => g.kinds.includes(i.kind)).length])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      if (!counts.length) {
        return {
          content: [{
            type: "text",
            text: `No places within ${minutes} min (${profile}) of ${lat}, ${lon}.`,
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: [
            `${items.length} places within ${minutes} min (${profile}) of ` +
            `${lat}, ${lon}: ${counts.map(([l, n]) => `${n} ${l}`).join(", ")}.`,
            `Ask which of these to list — for example group="food", or ` +
            `kinds=["cafe"] for something specific.`,
            `Map: ${API}/?lat=${lat}&lon=${lon}&profile=${profile}`,
          ].join("\n"),
        }],
      };
    }

    let wanted = items;
    let scope = "places";
    if (kinds?.length) {
      const set = new Set(kinds.map((k) => k.toLowerCase()));
      wanted = items.filter((i) => set.has(i.kind));
      scope = kinds.join("/");
    } else if (group) {
      const g = gs.find((x) => x.label === group.toLowerCase());
      if (!g) {
        return errResult(
          `Unknown group "${group}". Available: ${gs.map((x) => x.label).join(", ")}.`
        );
      }
      wanted = items.filter((i) => g.kinds.includes(i.kind));
      scope = g.label;
    }

    if (!wanted.length) {
      return {
        content: [{
          type: "text",
          text:
            `No ${scope} within ${minutes} min (${profile}) of ${lat}, ${lon}` +
            (items.length ? `, though ${plural(items.length, "other place")} are reachable.` : "."),
        }],
      };
    }

    const shown = wanted.slice(0, limit);
    const lines = [
      // naive pluralisation gave "200 matchs"; the noun is always "place"
      `${wanted.length} ${scope === "places" ? "" : scope + " "}` +
      `place${wanted.length === 1 ? "" : "s"} within ` +
      `${minutes} min (${profile}) of ${lat}, ${lon}` +
      (shown.length < wanted.length ? `; nearest ${shown.length}:` : ":"),
      ...shown.map(
        (i) => `· ${i.minutes} min — ${i.name ?? "(unnamed)"} (${i.kind.replace(/_/g, " ")})`
      ),
      `Map: ${API}/?lat=${lat}&lon=${lon}&profile=${profile}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

await server.connect(new StdioServerTransport());
