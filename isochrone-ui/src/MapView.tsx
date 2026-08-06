import { useEffect, useRef, useState } from "react";
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

// Half-width of the box offered when someone clicks outside coverage: 2.5km
// each way = a 5×5km area. The server buffers this by another 2.1km on every
// side, so it actually imports ~85km² — keep MAX_AREA_KM2 above 25.
const IMPORT_HALF_M = 2500;

type Area = {
  id: number;
  schema_name: string | null;
  status: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

// Which areas this browser asked for. Not identity — someone else may have
// imported the same box first, and clearing site data forgets it — but it is
// enough to tell "the one I just requested" from everyone else's.
const MINE_KEY = "isochrone.my-areas";
const loadMine = (): number[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(MINE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : [];
  } catch {
    return []; // private mode, or someone hand-edited it
  }
};
const saveMine = (ids: number[]) => {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(ids));
  } catch {
    /* storage is a nicety; the map works without it */
  }
};

export default function MapView() {
  const mapRef = useRef<L.Map | null>(null);
  const isochroneRef = useRef<L.LayerGroup | null>(null);
  // refs, not state: the map effect runs once and would capture a stale value
  const profileRef = useRef(initialProfile);
  const lastClickRef = useRef<[number, number] | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const updateRef = useRef<(lat: number, lon: number) => void>(() => {});
  const refreshAreasRef = useRef<() => void>(() => {});
  const markerRef = useRef<L.CircleMarker | null>(null);
  const areasRef = useRef<L.LayerGroup | null>(null);
  const toastRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mineRef = useRef<Set<number>>(new Set(loadMine()));

  const claimArea = (id: number) => {
    if (typeof id !== "number" || mineRef.current.has(id)) return;
    mineRef.current.add(id);
    saveMine([...mineRef.current]);
  };

  // the only two things worth re-rendering for; the map itself stays imperative
  const [offer, setOffer] = useState<{ lat: number; lon: number } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const showToast = (msg: string) => {
    const el = toastRef.current;
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => (el.style.display = "none"), 6000);
  };

  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.remove();
    }

    // No maxBounds: coverage is drawn on the map now, so a fence would only
    // stop people reaching the areas they are allowed to import.
    const map = L.map("map").setView([52.52, 13.405], 13);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
      map
    );

    areasRef.current = L.layerGroup().addTo(map);

    // Every visitor polls the same registry, so an import someone else started
    // shows up on your map while it runs.
    const refreshAreas = async () => {
      try {
        const res = await fetch("/api/areas");
        const areas: Area[] = await res.json();
        const group = areasRef.current;
        if (!group) return;
        group.clearLayers();
        // Drop remembered ids the server no longer has (evicted areas), so the
        // list can't grow forever. Only on a successful fetch.
        const live = new Set(areas.map((a) => a.id));
        if (mineRef.current.size) {
          const kept = [...mineRef.current].filter((id) => live.has(id));
          if (kept.length !== mineRef.current.size) {
            mineRef.current = new Set(kept);
            saveMine(kept);
          }
        }
        for (const a of areas) {
          if (a.status === "failed") continue;
          const pending = a.status !== "ready";
          const mine = mineRef.current.has(a.id);
          L.rectangle(
            [
              [a.min_lat, a.min_lon],
              [a.max_lat, a.max_lon],
            ],
            {
              color: mine ? "#2a78d6" : pending ? "#e08c00" : "#3a7d44",
              weight: pending ? 2 : mine ? 2 : 1,
              opacity: pending ? 0.95 : mine ? 0.8 : 0.5,
              fillOpacity: pending ? 0.1 : mine ? 0.06 : 0.03,
              dashArray: pending ? "6 6" : undefined,
              className: pending ? "area-importing" : "area-ready",
              interactive: false,
            }
          )
            .bindTooltip(
              pending
                ? `${a.status === "importing" ? "importing now" : "queued"} — ${
                    mine ? "your request" : "someone else is adding this area"
                  }`
                : mine
                ? "you requested this area"
                : "covered",
              { sticky: true }
            )
            .addTo(group);
        }
      } catch {
        /* the overlay is decoration; a failed poll must not break the map */
      }
    };
    refreshAreasRef.current = refreshAreas;
    refreshAreas();
    const areaTimer = setInterval(refreshAreas, 5000);

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
          // Outside coverage is now an offer, not a dead end.
          if (data.error === "outside coverage") {
            setOffer({ lat, lon: lng });
          } else {
            showToast(data.detail ?? data.error ?? `Request failed (${res.status})`);
          }
          isochroneRef.current = L.layerGroup([]).addTo(map);
          return;
        }

        setOffer(null);

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
    updateRef.current = updateIsochrones;

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
      setOffer(null);
      debouncedUpdate(e.latlng.lat, e.latlng.lng);
    });

    if (!isNaN(urlLat) && !isNaN(urlLon)) {
      map.setView([urlLat, urlLon], 14);
      lastClickRef.current = [urlLat, urlLon];
      updateIsochrones(urlLat, urlLon);
    }

    return () => clearInterval(areaTimer);
  }, []);

  const startImport = async () => {
    if (!offer) return;
    const { lat, lon } = offer;
    const dLat = IMPORT_HALF_M / 111320;
    const dLon = IMPORT_HALF_M / (111320 * Math.cos((lat * Math.PI) / 180));
    setOffer(null);
    setImporting("requesting…");
    try {
      const res = await fetch("/api/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minLat: lat - dLat,
          minLon: lon - dLon,
          maxLat: lat + dLat,
          maxLon: lon + dLon,
        }),
      });
      const job = await res.json();
      if (!res.ok) {
        setImporting(null);
        return showToast(job.error ?? `Import request failed (${res.status})`);
      }
      claimArea(job.id);

      if (job.reused) {
        setImporting(null);
        refreshAreasRef.current();
        return updateRef.current(lat, lon);
      }

      refreshAreasRef.current();
      // Poll rather than hold a connection open for the whole import. The 5s
      // overlay poll already redraws the map, so this must not also refresh
      // the area list — doing both tripled every client's request rate.
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await (await fetch(`/api/areas/${job.id}`)).json();
        if (s.status === "ready") {
          setImporting(null);
          showToast("Area imported — drawing your isochrone");
          return updateRef.current(lat, lon);
        }
        if (s.status === "failed") {
          setImporting(null);
          return showToast(`Import failed: ${s.error ?? "unknown error"}`);
        }
        setImporting(
          s.status === "importing"
            ? "importing streets…"
            : `queued — ${s.ahead} ahead`
        );
      }
    } catch {
      setImporting(null);
      showToast("Could not reach the import service");
    }
  };

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

      {(offer || importing) && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1100,
            background: "rgba(255,255,255,0.96)",
            padding: "10px 14px",
            borderRadius: 4,
            font: "13px system-ui",
            color: "#0b0b0b",
            boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {importing ? (
            <>
              <span className="import-pulse" />
              <span>{importing}</span>
            </>
          ) : (
            <>
              <span>Nothing imported here yet.</span>
              <button
                onClick={startImport}
                style={{
                  font: "13px system-ui",
                  padding: "5px 10px",
                  cursor: "pointer",
                }}
              >
                Import 5×5 km area
              </button>
            </>
          )}
        </div>
      )}

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
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 13,
              height: 8,
              border: "1px solid #3a7d44",
              background: "rgba(58,125,68,0.06)",
            }}
          />
          covered
          <span
            style={{
              width: 13,
              height: 8,
              border: "2px solid #2a78d6",
              background: "rgba(42,120,214,0.08)",
            }}
          />
          yours
          <span
            style={{ width: 13, height: 8, border: "2px dashed #e08c00" }}
          />
          importing
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
