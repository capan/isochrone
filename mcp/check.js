// self-check: spawns server.js over stdio like a real MCP client and hits the
// real API. Run: node check.js   (or ISOCHRONE_API=http://localhost:3001 node check.js)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const client = new Client({ name: "isochrone-mcp-check", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.js", import.meta.url))],
    env: process.env.ISOCHRONE_API ? { ISOCHRONE_API: process.env.ISOCHRONE_API } : undefined,
  })
);

const text = (r) => r.content.find((c) => c.type === "text").text;
const call = (args) => client.callTool({ name: "reachable_area", arguments: args });

const { tools } = await client.listTools();
assert(tools.some((t) => t.name === "reachable_area"), "tool registered");

// plain summary
const r1 = await call({ lat: 52.52, lon: 13.405 });
assert(!r1.isError, `summary errored: ${text(r1)}`);
assert(/km of streets/.test(text(r1)), "summary has street-km");
assert(/N–S/.test(text(r1)), "summary has extent");
assert(/\/\?lat=52\.52&lon=13\.405&profile=walk/.test(text(r1)), "summary has map deep link");

// target inside reach (Alexanderplatz → ~600m away)
const r2 = await call({ lat: 52.52, lon: 13.405, target: { lat: 52.522, lon: 13.41 } });
assert(/is reachable: arrival ~\d/.test(text(r2)), `target reachable: ${text(r2)}`);

// target far outside reach
const r3 = await call({ lat: 52.52, lon: 13.405, minutes: 5, target: { lat: 52.45, lon: 13.3 } });
assert(/NOT reachable/.test(text(r3)), `target unreachable: ${text(r3)}`);

// outside coverage → prose error, not empty success
const r4 = await call({ lat: 48.8566, lon: 2.3522 });
assert(r4.isError, "Paris should error");
assert(/coverage/i.test(text(r4)), `coverage prose: ${text(r4)}`);

// cap enforced by schema before any fetch
await assert.rejects(call({ lat: 52.52, lon: 13.405, minutes: 60 }).then((r) => {
  if (r.isError) throw new Error(text(r)); // schema rejection may surface either way
}), "minutes=60 must not succeed");

// geometry only on request
assert(!JSON.stringify(r1.content).includes("FeatureCollection"), "no geometry by default");
const r5 = await call({ lat: 52.52, lon: 13.405, include_geometry: true });
assert(r5.content.some((c) => c.text?.includes('"FeatureCollection"')), "geometry on request");

await client.close();
console.log("✅ mcp/check.js passed");
