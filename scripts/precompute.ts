import fs from "fs";

// Warms the backend's redis cache by asking it for each grid point. The routing
// SQL, cost profiles and cache keys live in isochrone-backend/index.ts — this
// script deliberately owns none of them, so it can't drift out of sync.
const API = process.env.API ?? "http://localhost:3001";
const PROFILE = process.env.PROFILE ?? "walk";
const MINUTES = parseInt(process.env.MINUTES ?? "15", 10);

console.log(`🚀 Warming ${MINUTES}min / ${PROFILE} isochrones via ${API}`);

const getArgValue = (name: string, defaultValue: number): number => {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg ? parseFloat(arg.split("=")[1]) : defaultValue;
};

const minLat = getArgValue("MINLAT", 52.47);
const maxLat = getArgValue("MAXLAT", 52.57);
const minLon = getArgValue("MINLON", 13.35);
const maxLon = getArgValue("MAXLON", 13.5);
const step = getArgValue("STEP", 0.002);
const BATCH_SIZE = 4;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const jobs: [number, number][] = [];
for (let lat = minLat; lat <= maxLat; lat += step) {
  for (let lon = minLon; lon <= maxLon; lon += step) {
    jobs.push([parseFloat(lat.toFixed(5)), parseFloat(lon.toFixed(5))]);
  }
}

let totalDuration = 0;
let completedJobs = 0;
const totalJobs = jobs.length;

async function warm(lat: number, lon: number) {
  const start = Date.now();
  try {
    const res = await fetch(
      `${API}/api/isochrone?lat=${lat}&lon=${lon}&minutes=${MINUTES}&profile=${PROFILE}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const elapsed = Date.now() - start;
    totalDuration += elapsed;
    completedJobs++;
    console.log(
      `✅ ${lat},${lon} — ${data.geojson.features.length} bands ` +
        `(${completedJobs}/${totalJobs}) ${elapsed}ms ` +
        `(avg: ${(totalDuration / completedJobs).toFixed(2)}ms)`
    );
  } catch (err) {
    const elapsed = Date.now() - start;
    totalDuration += elapsed;
    completedJobs++;
    console.error(`❌ ${lat},${lon} — ${elapsed}ms:`, (err as Error).message);
  }
}

for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
  await Promise.all(jobs.slice(i, i + BATCH_SIZE).map(([la, lo]) => warm(la, lo)));
  await sleep(500); // small pause to avoid overload
}

fs.writeFileSync(
  "performance.txt",
  `
📍 Precompute Report
Area: [${minLat}, ${minLon}] to [${maxLat}, ${maxLon}]
Coordinate Count: ${completedJobs}
Average Time: ${(totalDuration / completedJobs).toFixed(2)}ms
Total Time: ${(totalDuration / 1000).toFixed(2)}s
Profile: ${PROFILE}
Minutes: ${MINUTES}
`.trim()
);
console.log("📝 Performance report saved to performance.txt");
