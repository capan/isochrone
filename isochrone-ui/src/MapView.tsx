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

// Coverage is Berlin; letting users pan to Paris just invites clicks the API
// will refuse. Server-truth bbox lives in postgres — this is a padded copy
// (same known duplication as PROFILES/MAX_MINUTES).
const BERLIN_BOUNDS = L.latLngBounds([52.32, 13.06], [52.69, 13.79]);

export default function MapView() {
  const mapRef = useRef<L.Map | null>(null);
  const isochroneRef = useRef<L.LayerGroup | null>(null);
  // refs, not state: the map effect runs once and would capture a stale value
  const profileRef = useRef(initialProfile);
  const lastClickRef = useRef<[number, number] | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const markerRef = useRef<L.CircleMarker | null>(null);
  const toastRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = (msg: string) => {
    const el = toastRef.current;
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => (el.style.display = "none"), 5000);
  };

  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
    }

    const map = L.map("map", {
      maxBounds: BERLIN_BOUNDS.pad(0.05),
      maxBoundsViscosity: 1.0,
      minZoom: 10,
    }).setView([52.52, 13.405], 13);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
      map
    );


    const updateIsochrones = async (lat: number, lng: number) => {
      if (isochroneRef.current) {
        map.removeLayer(isochroneRef.current);
      }

      // pin the origin — the lightest band alone doesn't read as "you are
      // here". circleMarker, not marker: default icon PNGs don't survive vite.
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      } else {
        markerRef.current = L.circleMarker([lat, lng], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#d33",
          fillOpacity: 1,
        }).addTo(map);
      }

      const layers: L.Layer[] = [];

      try {
        const res = await fetch(
          `/api/isochrone?lat=${lat}&lon=${lng}&minutes=${MAX_MINUTES}` +
            `&profile=${profileRef.current}`
        );
        const data = await res.json();

        if (!res.ok) {
          showToast(data.detail ?? data.error ?? `Request failed (${res.status})`);
          isochroneRef.current = L.layerGroup([]).addTo(map);
          return;
        }

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
          showToast(
            `No reachable streets here for "${profileRef.current}" — stairs or surfaces may block this origin`
          );
        }
      } catch (err) {
        console.error("Isochrone network fetch failed", err);
        showToast("Could not reach the isochrone service — try again in a moment");
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
      <div
        ref={toastRef}
        style={{
          display: "none",
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1100,
          maxWidth: "80vw",
          background: "#b3261e",
          color: "#fff",
          padding: "8px 14px",
          borderRadius: 4,
          font: "13px system-ui",
          boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
        }}
      />

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
