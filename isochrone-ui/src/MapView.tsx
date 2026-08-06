import { useEffect, useRef } from "react";
import L from "leaflet";

const MAX_MINUTES = 15;
const PROFILES = ["walk", "stroller", "wheelchair"];

// Sequential single-hue ramp, light→dark = near→far. Starts at step 250, the
// lightest that still clears contrast against the basemap.
const RAMP = [
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
];

// Deep-link support: /?lat=52.52&lon=13.405&profile=wheelchair loads with
// that isochrone drawn — the MCP server's "view on map" links point here.
const urlParams = new URLSearchParams(window.location.search);
const urlProfile = urlParams.get("profile") ?? "";
const initialProfile = PROFILES.includes(urlProfile) ? urlProfile : PROFILES[0];
const urlLat = parseFloat(urlParams.get("lat") ?? "");
const urlLon = parseFloat(urlParams.get("lon") ?? "");

export default function MapView() {
  const mapRef = useRef<L.Map | null>(null);
  const isochroneRef = useRef<L.LayerGroup | null>(null);
  // refs, not state: the map effect runs once and would capture a stale value
  const profileRef = useRef(initialProfile);
  const lastClickRef = useRef<[number, number] | null>(null);
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
    }

    const map = L.map("map").setView([52.52, 13.405], 13);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
      map
    );


    const updateIsochrones = async (lat: number, lng: number) => {
      if (isochroneRef.current) {
        map.removeLayer(isochroneRef.current);
      }

      const layers: L.Layer[] = [];

      try {
        const res = await fetch(
          `/api/isochrone?lat=${lat}&lon=${lng}&minutes=${MAX_MINUTES}` +
            `&profile=${profileRef.current}`
        );
        const data = await res.json();

        // farthest band first, so nearer streets draw on top at junctions
        const features = [...data.geojson.features].sort(
          (a, b) => b.properties.band - a.properties.band
        );

        for (const feature of features) {
          const band: number = feature.properties.band;
          const until = (data.minutes / data.bands) * band;

          const layer = L.geoJSON(feature, {
            style: { color: RAMP[band - 1], weight: 2, opacity: 0.9 },
          })
            // identity never rests on color alone
            .bindTooltip(`≤ ${until.toFixed(1)} min`, { sticky: true })
            .addTo(map);

          layers.push(layer);
        }

        if (!features.length) {
          console.warn("No reachable streets for this origin/profile");
        }
      } catch (err) {
        console.error("Isochrone network fetch failed", err);
      }

      isochroneRef.current = L.layerGroup(layers).addTo(map);
    };

    const step = 0.002;

    const snap = (val: number) => {
      return Math.round(val / step) * step;
    };

    const debouncedUpdate = debounce((lat: number, lng: number) => {
      const snappedLat = parseFloat(snap(lat).toFixed(5));
      const snappedLng = parseFloat(snap(lng).toFixed(5));
      lastClickRef.current = [snappedLat, snappedLng];
      updateIsochrones(snappedLat, snappedLng);
    }, 600);

    // lets the profile picker re-run the last click
    redrawRef.current = () => {
      if (lastClickRef.current) updateIsochrones(...lastClickRef.current);
    };

    map.on("click", (e: L.LeafletMouseEvent) => {
      debouncedUpdate(e.latlng.lat, e.latlng.lng);
    });

    if (!isNaN(urlLat) && !isNaN(urlLon)) {
      map.setView([urlLat, urlLon], 14);
      lastClickRef.current = [urlLat, urlLon];
      updateIsochrones(urlLat, urlLon);
    }
  }, []);

  return (
    <>
      <select
        defaultValue={initialProfile}
        onChange={(e) => {
          profileRef.current = e.target.value;
          redrawRef.current();
        }}
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          zIndex: 1000,
          padding: "6px 10px",
          font: "14px system-ui",
        }}
      >
        {PROFILES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <div
        style={{
          position: "absolute",
          bottom: 24,
          right: 10,
          zIndex: 1000,
          background: "rgba(255,255,255,0.92)",
          padding: "8px 10px",
          borderRadius: 4,
          font: "12px system-ui",
          color: "#52514e",
        }}
      >
        <div style={{ marginBottom: 4, color: "#0b0b0b" }}>walking time</div>
        <div style={{ display: "flex" }}>
          {RAMP.map((c) => (
            <div key={c} style={{ width: 16, height: 10, background: c }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>0</span>
          <span>{MAX_MINUTES} min</span>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: 10,
          zIndex: 1000,
          background: "rgba(255,255,255,0.92)",
          padding: "8px 10px",
          borderRadius: 4,
          font: "12px system-ui",
          color: "#52514e",
        }}
      >
        <div style={{ marginBottom: 4, color: "#0b0b0b" }}>
          ask Claude about reachability — MCP server:
        </div>
        <code style={{ userSelect: "all", font: "11px ui-monospace, monospace" }}>
          claude mcp add isochrone -- npx -y isochrone-mcp
        </code>
      </div>

      <div id="map" style={{ height: "100vh" }} />
    </>
  );
}

// Simple debounce utility
function debounce(fn: (...args: any[]) => void, delay: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: any[]) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}
