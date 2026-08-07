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
const places = (args) => client.callTool({ name: "places_nearby", arguments: args });

const { tools } = await client.listTools();
assert(tools.some((t) => t.name === "reachable_area"), "reachable_area registered");
assert(tools.some((t) => t.name === "places_nearby"), "places_nearby registered");

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
// Not Paris any more: anyone can import an area now, and somebody imported
// Paris. Null Island is the only spot safe to assume nobody will ask for.
const r4 = await call({ lat: 0, lon: 0 });
assert(r4.isError, "Null Island should error");
assert(/coverage/i.test(text(r4)), `coverage prose: ${text(r4)}`);

// bike: a distinct profile with its own, lower minute cap
const rb = await call({ lat: 52.52, lon: 13.405, profile: "bike" });
assert(!rb.isError, `bike errored: ${text(rb)}`);
assert(/\(bike\)/.test(text(rb)), `bike labelled: ${text(rb)}`);
// the default must respect the server's cap, not the generic 15
assert(/^10 min \(bike\)/.test(text(rb)), `bike default minutes: ${text(rb)}`);

// asking for more than a profile allows comes back as prose, not a 500
const rc = await call({ lat: 52.52, lon: 13.405, profile: "bike", minutes: 20 });
assert(rc.isError, "over-cap bike should error");
assert(/10 or less/.test(text(rc)), `cap message: ${text(rc)}`);

// the summary now says what is reachable, not just how far
assert(/Places within reach: .*food/.test(text(r1)), `place counts: ${text(r1)}`);

// unfiltered: a breakdown and a prompt, never an arbitrary mixture
const ru = await places({ lat: 52.52, lon: 13.405 });
assert(!ru.isError, `unfiltered errored: ${text(ru)}`);
assert(/food/.test(text(ru)), `breakdown by group: ${text(ru)}`);
assert(/Ask which/.test(text(ru)), `invites a follow-up: ${text(ru)}`);
assert(!/·/.test(text(ru)), "unfiltered must not list individual places");

// places_nearby: named results with arrival times
const rp = await places({ lat: 52.52, lon: 13.405, group: "food", limit: 5 });
assert(!rp.isError, `places errored: ${text(rp)}`);
assert(/min —/.test(text(rp)), `place lines: ${text(rp)}`);
assert(text(rp).split("\n").length >= 3, "several places listed");

// a specific kind narrows it
const rk = await places({ lat: 52.52, lon: 13.405, kinds: ["pharmacy"], limit: 5 });
assert(!rk.isError, `kind filter errored: ${text(rk)}`);
assert(/pharmacy|No pharmacy/.test(text(rk)), `kind filter: ${text(rk)}`);

// an unknown group explains itself instead of returning nothing
const rg = await places({ lat: 52.52, lon: 13.405, group: "nonsense" });
assert(rg.isError && /Unknown group/.test(text(rg)), `bad group: ${text(rg)}`);

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
