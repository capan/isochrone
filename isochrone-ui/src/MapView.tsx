import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import HelpPanel from "./HelpPanel";

// Shown once per browser, and any time via the button or a #how link. A first
// visitor has no way to guess that the dark region is data they can request.
const SEEN_HELP_KEY = "isochrone.seen-help";
const seenHelp = () => {
  try {
    return localStorage.getItem(SEEN_HELP_KEY) === "1";
  } catch {
    return true; // no storage: don't nag on every load
  }
};

// Preferred budget. The server caps faster profiles lower (a bike covers 3x
// the ground per minute, and cost tracks area), so the real value per profile
// comes from /api/profiles and this is only ever an upper bound.
const MAX_MINUTES = 15;
const PROFILES = ["walk", "stroller", "wheelchair", "bike"];

// Emoji rather than an icon dependency; the text label stays next to them, so
// nothing depends on reading a glyph correctly.
const PROFILE_ICONS: Record<string, string> = {
  walk: "🚶",
  stroller: "🚼",
  wheelchair: "♿",
  bike: "🚲",
};

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
  // profile → server-imposed minute cap, filled from /api/profiles on load
  const capsRef = useRef<Record<string, number>>({});
  const [shownMinutes, setShownMinutes] = useState(MAX_MINUTES);

  const claimArea = (id: number) => {
    if (typeof id !== "number" || mineRef.current.has(id)) return;
    mineRef.current.add(id);
    saveMine([...mineRef.current]);
  };

  // the only two things worth re-rendering for; the map itself stays imperative
  const [offer, setOffer] = useState<{ lat: number; lon: number } | null>(null);
  // id → status text. A map, not a single value: the server queues imports, so
  // the UI must let you start a second one while the first is still running.
  const [jobs, setJobs] = useState<Record<number, string>>({});
  const setJob = (id: number, text: string | null) =>
    setJobs((j) => {
      if (text === null) {
        const { [id]: _gone, ...rest } = j;
        return rest;
      }
      return { ...j, [id]: text };
    });
  // mirrors profileRef so the picker can render which one is active; the map
  // effect still reads the ref, which never goes stale inside its closure
  const [profile, setProfile] = useState(initialProfile);
  const [caps, setCaps] = useState<Record<string, number>>({});
  const [help, setHelp] = useState(
    () => window.location.hash === "#how" || !seenHelp()
  );

  const closeHelp = () => {
    setHelp(false);
    try {
      localStorage.setItem(SEEN_HELP_KEY, "1");
    } catch {
      /* nothing to remember it with; the button is still there */
    }
    if (window.location.hash === "#how")
      history.replaceState(null, "", window.location.pathname + window.location.search);
  };

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

    // A real Leaflet control rather than an absolutely positioned button:
    // Leaflet stacks and spaces the top-left corner itself, so this can't
    // land on top of the zoom buttons whatever size they end up.
    const HelpControl = L.Control.extend({
      onAdd() {
        const btn = L.DomUtil.create("button", "help-control");
        btn.type = "button";
        btn.textContent = "How it works";
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => setHelp(true));
        return btn;
      },
    });
    new HelpControl({ position: "topleft" }).addTo(map);

    areasRef.current = L.layerGroup().addTo(map);

    // The caps live on the server; asking beats restating them here.
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((list: { name: string; maxMinutes: number }[]) => {
        for (const p of list) capsRef.current[p.name] = p.maxMinutes;
        setCaps({ ...capsRef.current });
        setShownMinutes(
          Math.min(MAX_MINUTES, capsRef.current[profileRef.current] ?? MAX_MINUTES)
        );
      })
      .catch(() => {
        /* fall back to MAX_MINUTES; the server still enforces the real cap */
      });

    // Every visitor polls the same registry, so an import someone else started
    // shows up on your map while it runs.
    const refreshAreas = async () => {
      try {
        const [res, covRes] = await Promise.all([
          fetch("/api/areas"),
          fetch("/api/coverage"),
        ]);
        const areas: Area[] = await res.json();
        const coverage = await covRes.json();
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
        const ready = areas.filter((a) => a.status === "ready");
        const pending = areas.filter(
          (a) => a.status === "queued" || a.status === "importing"
        );
        const ring = (a: Area): L.LatLngTuple[] => [
          [a.min_lat, a.min_lon],
          [a.min_lat, a.max_lon],
          [a.max_lat, a.max_lon],
          [a.max_lat, a.min_lon],
        ];

        // One polygon over the world, with the *merged* coverage punched out.
        // Per-area holes would overlap, and SVG evenodd re-fills a doubly
        // punched region — overlapping imports showed as dark patches inside
        // covered ground. ST_Union server-side removes the overlaps entirely.
        // Passing inner rings too is correct under evenodd: a pocket enclosed
        // by coverage flips back to veiled, which is what it is.
        const rings = (geom: any): L.LatLngTuple[][] => {
          if (!geom) return [];
          const polys =
            geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
          return polys.flatMap((poly: number[][][]) =>
            poly.map((r) => r.map(([lon, lat]) => [lat, lon] as L.LatLngTuple))
          );
        };

        L.polygon(
          [
            [
              [-85, -180],
              [85, -180],
              [85, 180],
              [-85, 180],
            ] as L.LatLngTuple[],
            ...rings(coverage),
          ],
          {
            stroke: false,
            fillColor: "#0b1622",
            fillOpacity: 0.3,
            interactive: false,
          }
        ).addTo(group);

        // No outline for other people's areas — the veil edge already marks
        // where coverage ends, and per-box borders crisscrossed into noise.
        // Only your own imports get a line, so you can find them.
        for (const a of ready) {
          if (!mineRef.current.has(a.id)) continue;
          L.rectangle(ring(a), {
            color: "#7c4dff",
            weight: 2,
            opacity: 0.85,
            fill: false,
            interactive: false,
          }).addTo(group);
        }

        // In-flight imports keep the marching ants, plus a permanent label so
        // the "someone else is doing this" signal needs no hover.
        for (const a of pending) {
          const mine = mineRef.current.has(a.id);
          L.rectangle(ring(a), {
            color: mine ? "#7c4dff" : "#e08c00",
            weight: 2,
            opacity: 0.95,
            fillOpacity: 0.08,
            dashArray: "6 6",
            className: "area-importing",
            interactive: false,
          })
            .bindTooltip(
              `${a.status === "importing" ? "importing" : "queued"} — ${
                mine ? "your request" : "someone else"
              }`,
              { permanent: true, direction: "center", className: "area-label" }
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
      const minutes = Math.min(
        MAX_MINUTES,
        capsRef.current[profileRef.current] ?? MAX_MINUTES
      );
      setShownMinutes(minutes);

      try {
        const res = await fetch(
          `/api/isochrone?lat=${lat}&lon=${lng}&minutes=${minutes}` +
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
    let id = -1;
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
        return showToast(job.error ?? `Import request failed (${res.status})`);
      }
      claimArea(job.id);
      id = job.id;

      if (job.reused) {
        refreshAreasRef.current();
        return updateRef.current(lat, lon);
      }

      setJob(id, "queued…");
      refreshAreasRef.current();
      // Poll rather than hold a connection open for the whole import. The 5s
      // overlay poll already redraws the map, so this must not also refresh
      // the area list — doing both tripled every client's request rate.
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await (await fetch(`/api/areas/${job.id}`)).json();
        if (s.status === "ready") {
          setJob(id, null);
          showToast("Area imported");
          refreshAreasRef.current();
          // Only jump to it if the map is still where the request was made —
          // yanking the view out from under someone who has moved on is worse
          // than making them click once.
          const at = lastClickRef.current;
          if (at && at[0] === lat && at[1] === lon) updateRef.current(lat, lon);
          return;
        }
        if (s.status === "failed") {
          setJob(id, null);
          return showToast(`Import failed: ${s.error ?? "unknown error"}`);
        }
        setJob(
          id,
          s.status === "importing"
            ? "importing streets…"
            : `queued — ${s.ahead} ahead`
        );
      }
    } catch {
      if (id > 0) setJob(id, null);
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

      {offer && (
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
        </div>
      )}

      {/* Progress lives out of the way, bottom-centre: imports run in a queue
          on the server, so the map stays fully usable while they do — click
          elsewhere, switch profile, or queue another area. */}
      {Object.keys(jobs).length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1050,
            background: "rgba(255,255,255,0.94)",
            padding: "7px 12px",
            borderRadius: 20,
            font: "12px system-ui",
            color: "#33383d",
            boxShadow: "0 1px 5px rgba(0,0,0,0.25)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span className="import-pulse" />
          {Object.keys(jobs).length === 1
            ? Object.values(jobs)[0]
            : `${Object.keys(jobs).length} imports running`}
        </div>
      )}

      {/* Segmented control, not a dropdown: four options is few enough to show
          at once, and the time budget differs per profile — worth seeing
          before you pick, not after the legend changes under you. */}
      <div
        role="group"
        aria-label="mobility profile"
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          zIndex: 1000,
          display: "flex",
          gap: 2,
          padding: 3,
          background: "rgba(255,255,255,0.94)",
          borderRadius: 9,
          boxShadow: "0 1px 5px rgba(0,0,0,0.28)",
          font: "13px system-ui",
        }}
      >
        {PROFILES.map((p) => {
          const active = p === profile;
          return (
            <button
              key={p}
              aria-pressed={active}
              title={caps[p] ? `${p} — up to ${caps[p]} min` : p}
              onClick={() => {
                profileRef.current = p;
                setProfile(p);
                redrawRef.current();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                border: "none",
                borderRadius: 7,
                cursor: "pointer",
                padding: "6px 9px",
                font: "inherit",
                fontWeight: active ? 600 : 400,
                lineHeight: 1.1,
                // Light tint, not a dark fill: the bike and wheelchair emoji
                // are natively blue and disappeared against a blue button, and
                // whitening them via filter would flatten the stroller sign
                // into a solid block.
                color: active ? "#12447f" : "#33383d",
                background: active ? "#dbe8fa" : "transparent",
                boxShadow: active ? "inset 0 0 0 1px #9dc0ea" : "none",
              }}
            >
              <span style={{ fontSize: 15 }} aria-hidden="true">
                {PROFILE_ICONS[p]}
              </span>
              {/* label hidden on narrow screens by CSS, never on its own */}
              <span className="profile-label">{p}</span>
            </button>
          );
        })}
      </div>

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
        <div style={{ marginBottom: 4, color: "#0b0b0b" }}>travel time</div>
        {/* flex:1 rather than a fixed 16px — the legend box is as wide as its
            widest row, and a fixed ramp left a gap before the "15 min" label */}
        <div style={{ display: "flex" }}>
          {RAMP.map((c) => (
            <div key={c} style={{ flex: 1, height: 10, background: c }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>0</span>
          <span>{shownMinutes} min</span>
        </div>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              width: 13,
              height: 8,
              background: "rgba(11,22,34,0.3)",
            }}
          />
          not imported
          <span
            style={{ width: 13, height: 8, border: "2px solid #7c4dff" }}
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

      {help && <HelpPanel onClose={closeHelp} />}

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
