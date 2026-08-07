import { useEffect, useRef, useState, type FormEvent } from "react";
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

const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

// Each style carries its own veil and ramp, because both sit *on top* of the
// basemap and neither survives a theme flip untouched:
//   · the veil marks "not imported" by darkening, and you cannot darken
//     something already dark, so the dark theme lightens instead
//   · the ramp runs light→dark for near→far, and its far end would vanish
//     into a dark basemap, so that theme uses a ramp that stays bright
const BASEMAPS = {
  dark: {
    label: "Dark Matter",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTR,
    veil: "#f2f6fb",
    veilOpacity: 0.1,
    ramp: [
      "#e6f0ff", "#cfe3ff", "#b6d4ff", "#9cc4fd", "#84b4f8",
      "#6ca4f1", "#5793e6", "#4482d8", "#3572c8", "#2a63b5",
    ],
  },
  voyager: {
    label: "Voyager",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTR,
    veil: "#0b1622",
    veilOpacity: 0.24,
    ramp: RAMP,
  },
  osm: {
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    veil: "#0b1622",
    veilOpacity: 0.3,
    ramp: RAMP,
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;

const BASEMAP_KEY = "isochrone.basemap";
const savedBasemap = (): BasemapKey => {
  try {
    const k = localStorage.getItem(BASEMAP_KEY);
    if (k && k in BASEMAPS) return k as BasemapKey;
  } catch {
    /* no storage; fall through to the default */
  }
  // Voyager: enough colour and labelling that an unfamiliar city reads as a
  // place rather than a diagram, which matters more on first load than the
  // contrast Dark Matter gives the bands.
  return "voyager";
};

// Groups (labels, icons, colours, and which kinds belong to each) are served
// by /api/place-groups so the map, the list and the query can't disagree.
type Group = { label: string; icon: string; color: string; kinds: string[] };

type Geo = { name: string; lat: number; lon: number };

type Place = {
  kind: string;
  category: string;
  name: string | null;
  lat: number;
  lon: number;
  minutes: number;
};

// Half-width of the box offered when someone clicks outside coverage: 2.5km
// each way = a 5×5km area. The server buffers this by another 2.1km on every
// side, so it actually imports ~85km² — keep MAX_AREA_KM2 above 25.
const IMPORT_HALF_M = 2500;

type Area = {
  id: number;
  schema_name: string | null;
  status: string;
  created_at: string;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
};

// Intl does the pluralising and the localising; a hand-rolled "3 minutes ago"
// would be a worse version of something already in the runtime.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const [unit, per]: [Intl.RelativeTimeFormatUnit, number] =
    s < 60 ? ["second", 1]
    : s < 3600 ? ["minute", 60]
    : s < 86400 ? ["hour", 3600]
    : ["day", 86400];
  return rtf.format(-Math.round(s / per), unit);
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
  // increments per draw request, so a slow response can tell it has been
  // overtaken and decline to paint itself over a newer one
  const drawGenRef = useRef(0);
  // the coverage fit is a first-load framing, not something the 5s poll redoes
  const didFitRef = useRef(false);
  const [shownMinutes, setShownMinutes] = useState(MAX_MINUTES);
  // ref for the map effect (closes over it once), state for the legend
  const basemapRef = useRef<BasemapKey>(savedBasemap());
  const [basemapKey, setBasemapKey] = useState<BasemapKey>(basemapRef.current);
  const basemap = BASEMAPS[basemapKey];

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
  const [places, setPlaces] = useState<Place[]>([]);
  const placesRef = useRef<Place[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  // kind → group, so a row or a dot can be coloured without scanning
  const groupOfRef = useRef<Record<string, Group>>({});
  // "pending" is not "empty": the area imported, but its amenities never
  // arrived from Overpass and a sweep is still retrying them. Saying "nothing
  // within reach" there is a confident wrong answer (T-011).
  const [placesState, setPlacesState] =
    useState<"idle" | "loading" | "ok" | "empty" | "pending">("idle");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // The API returns every match; this is only how many rows are painted.
  const [visible, setVisible] = useState(60);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // desktop starts with the panel open; on mobile it is a collapsed sheet
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 720
  );
  const placeLayerRef = useRef<L.LayerGroup | null>(null);
  const placesGenRef = useRef(0);
  const drawPlacesRef = useRef<(items: Place[]) => void>(() => {});
  const loadPlacesRef = useRef<(lat: number, lon: number) => void>(() => {});
  const [copied, setCopied] = useState(false);
  const [helpFocus, setHelpFocus] = useState<"assistant" | undefined>(undefined);
  // Only a deep link carries lat+lon, and only the MCP server hands those out,
  // so their presence is the whole "came from an assistant" test.
  const [arrival, setArrival] = useState(!isNaN(urlLat) && !isNaN(urlLon));
  const [help, setHelp] = useState(
    () => window.location.hash === "#how" || !seenHelp()
  );
  // Geocoding goes through /api/search, not straight to Nominatim: their
  // policy wants an identifying User-Agent, which a browser cannot send.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Geo[]>([]);
  const [searchState, setSearchState] =
    useState<"idle" | "loading" | "none" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  // Filled by the same 5s poll that draws the coverage overlay.
  const [areas, setAreas] = useState<Area[]>([]);

  const closeHelp = () => {
    setHelp(false);
    setHelpFocus(undefined);
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

    // L.control.layers already does base-layer switching, so there is no
    // custom control to build — only the follow-on work Leaflet can't know
    // about: the veil and the ramp restyle with the theme.
    // {r} serves @2x tiles on retina. Attribution is a licence requirement;
    // the layer this replaced declared none.
    const layers = {} as Record<BasemapKey, L.TileLayer>;
    const named: Record<string, L.TileLayer> = {};
    for (const key of Object.keys(BASEMAPS) as BasemapKey[]) {
      const cfg = BASEMAPS[key];
      layers[key] = L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        maxZoom: 20,
      });
      named[cfg.label] = layers[key];
    }
    layers[basemapRef.current].addTo(map);
    // topleft, not topright: the profile picker owns the top-right corner, and
    // Leaflet only auto-spaces controls that live in the same corner stack.
    L.control.layers(named, undefined, { position: "topleft" }).addTo(map);

    map.on("baselayerchange", (e: L.LayersControlEvent) => {
      const key = (Object.keys(BASEMAPS) as BasemapKey[]).find(
        (k) => BASEMAPS[k].label === e.name
      );
      if (!key) return;
      basemapRef.current = key;
      setBasemapKey(key);
      try {
        localStorage.setItem(BASEMAP_KEY, key);
      } catch {
        /* the choice just won't survive a reload */
      }
      // Redraw immediately rather than waiting for the 5s poll, and repaint
      // the isochrone so its ramp matches the new theme.
      refreshAreas();
      redrawRef.current();
    });

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
    // Canvas, not SVG: a 25-minute walk in central Berlin is ~2,100 places,
    // and that many individual SVG nodes makes panning crawl.
    const placeRenderer = L.canvas({ padding: 0.3 });
    placeLayerRef.current = L.layerGroup().addTo(map);

    drawPlacesRef.current = (items: Place[]) => {
      const g = placeLayerRef.current;
      if (!g) return;
      g.clearLayers();
      for (const pl of items) {
        L.circleMarker([pl.lat, pl.lon], {
          radius: 4,
          weight: 1.5,
          color: "#fff",
          fillColor: groupOfRef.current[pl.kind]?.color ?? "#f0a202",
          fillOpacity: 1,
          renderer: placeRenderer,
        })
          .bindTooltip(
            `${pl.name ?? pl.kind.replace(/_/g, " ")} · ${pl.minutes} min`,
            { direction: "top" }
          )
          .addTo(g);
      }
    };

    fetch("/api/place-groups")
      .then((r) => r.json())
      .then((gs: Group[]) => {
        setGroups(gs);
        const byKind: Record<string, Group> = {};
        for (const g of gs) for (const k of g.kinds) byKind[k] = g;
        groupOfRef.current = byKind;
        drawPlacesRef.current(placesRef.current);
      })
      .catch(() => {});

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

    // T-005: a first visitor lands inside Berlin and never sees the veil, so
    // "import your own area" never presents itself. Frame the shipped city so
    // its edge — and the dark beyond it — is on screen without panning.
    //
    // fitBounds rather than a hardcoded zoom: the right zoom depends on the
    // viewport, and a number tuned on a laptop shows no edge at all on a
    // phone. The padding is the point, not politeness — it is the band of
    // uncovered ground the veil paints.
    //
    // Fitting /api/coverage instead would zoom out to the whole world, since
    // coverage now spans Berlin, Prague, Munich and Tucson. The shipped city
    // is the row whose schema is not area_* — the same distinction the
    // recently-added list draws, inverted.
    const fitToCity = (areas: Area[]) => {
      // A deep link already names the place to look at; never yank it away.
      if (didFitRef.current || (!isNaN(urlLat) && !isNaN(urlLon))) return;
      const city = areas.find((a) => a.schema_name && !a.schema_name.startsWith("area_"));
      if (!city) return; // fresh deployment with no city seeded yet
      didFitRef.current = true;
      map.fitBounds(
        [
          [city.min_lat, city.min_lon],
          [city.max_lat, city.max_lon],
        ],
        // animate:false so this reads as the starting view, not as the map
        // flying away from you a second after it settled.
        { padding: [50, 50], animate: false }
      );
    };

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
        // The panel list rides the poll that already runs for the overlay —
        // "without any new endpoint" (T-004), and without a second timer.
        setAreas(areas);
        fitToCity(areas);
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
            fillColor: BASEMAPS[basemapRef.current].veil,
            fillOpacity: BASEMAPS[basemapRef.current].veilOpacity,
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
              `${a.status === "importing" ? "importing" : "queued"}: ${
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

    const clearIsochrone = () => {
      if (isochroneRef.current) {
        map.removeLayer(isochroneRef.current);
        isochroneRef.current = null;
      }
      placeLayerRef.current?.clearLayers();
    };

    const updateIsochrones = async (lat: number, lng: number) => {
      // Clearing before the fetch looked right and wasn't: a second click
      // cleared the map while the first request was still in flight, then the
      // first response drew itself afterwards and stayed there forever. Tag
      // each draw instead, drop stale responses, and swap layers in one step
      // once the data is actually in hand.
      const gen = ++drawGenRef.current;

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
        if (gen !== drawGenRef.current) return; // a newer click already won

        if (!res.ok) {
          // Outside coverage is now an offer, not a dead end.
          if (data.error === "outside coverage") {
            setOffer({ lat, lon: lng });
          } else {
            showToast(data.detail ?? data.error ?? `Request failed (${res.status})`);
          }
          clearIsochrone();
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
            style: {
              color: BASEMAPS[basemapRef.current].ramp[band - 1],
              weight: 2,
              opacity: 0.9,
            },
          })
            // identity never rests on color alone
            .bindTooltip(`≤ ${until.toFixed(1)} min`, { sticky: true });

          layers.push(layer);
        }

        if (!features.length) {
          showToast(
            `No reachable streets here for "${profileRef.current}". Stairs or rough surfaces may block this spot.`
          );
        }
      } catch (err) {
        if (gen !== drawGenRef.current) return;
        console.error("Isochrone network fetch failed", err);
        showToast("Could not reach the isochrone service. Try again in a moment.");
      }

      if (gen !== drawGenRef.current) return;
      clearIsochrone();
      isochroneRef.current = L.layerGroup(layers).addTo(map);
      if (layers.length) loadPlacesRef.current(lat, lng);
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
      // Clicking means they got the idea; it also keeps the banner from
      // sharing the top strip with the import offer.
      setArrival(false);
      debouncedUpdate(e.latlng.lat, e.latlng.lng);
    });

    if (!isNaN(urlLat) && !isNaN(urlLon)) {
      map.setView([urlLat, urlLon], 14);
      lastClickRef.current = [urlLat, urlLon];
      updateIsochrones(urlLat, urlLon);
    }

    // The sidebar collapses and expands, and Leaflet caches container size.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(document.getElementById("map")!);

    return () => {
      clearInterval(areaTimer);
      ro.disconnect();
    };
  }, []);

  // Amenities are a second request, so they get their own generation guard —
  // same overtaking problem the isochrone had.
  const loadPlaces = async (lat: number, lon: number, filter = kindFilter) => {
    const gen = ++placesGenRef.current;
    setPlacesState("loading");
    setVisible(60);
    void filter; // filtering happens client-side now; fetch every kind once
    try {
      const r = await fetch(
        `/api/amenities?lat=${lat}&lon=${lon}&profile=${profileRef.current}` +
          `&minutes=${Math.min(MAX_MINUTES, capsRef.current[profileRef.current] ?? MAX_MINUTES)}` +
``
      );
      const d = await r.json();
      if (gen !== placesGenRef.current) return;
      if (!r.ok) {
        setPlaces([]);
        return setPlacesState("empty");
      }
      placesRef.current = d.items ?? [];
      setPlaces(d.items ?? []);
      setPlacesState(
        (d.items ?? []).length ? "ok" : d.poisLoaded === false ? "pending" : "empty"
      );
      drawPlacesRef.current(d.items ?? []);
    } catch {
      if (gen !== placesGenRef.current) return;
      setPlaces([]);
      setPlacesState("empty");
    }
  };
  loadPlacesRef.current = loadPlaces;

  const focusPlace = (pl: Place) => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([pl.lat, pl.lon], Math.max(map.getZoom(), 16));
    L.popup({ closeButton: false, className: "place-popup" })
      .setLatLng([pl.lat, pl.lon])
      .setContent(
        `<b>${pl.name ?? pl.kind.replace(/_/g, " ")}</b><br>${pl.minutes} min away`
      )
      .openOn(map);
    if (window.innerWidth <= 720) setPanelOpen(false);
  };

  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setSearchState("loading");
    setResults([]);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) {
        setSearchError(d.error ?? `Search failed (${r.status})`);
        return setSearchState("error");
      }
      setResults(d);
      setSearchState(d.length ? "idle" : "none");
    } catch {
      setSearchError("Could not reach the place search service.");
      setSearchState("error");
    }
  };

  // Same landing as a deep link, and deliberately the same code path as a
  // click: if the result is outside coverage, updateIsochrones turns that into
  // the import offer on its own.
  const goTo = (r: Geo) => {
    const map = mapRef.current;
    if (!map) return;
    setResults([]);
    setOffer(null);
    // Same reasoning as the map click: acting on the map means the banner has
    // done its job, and it shares the top strip with the import offer.
    setArrival(false);
    map.setView([r.lat, r.lon], 14);
    lastClickRef.current = [r.lat, r.lon];
    updateRef.current(r.lat, r.lon);
    if (window.innerWidth <= 720) setPanelOpen(false);
  };

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
            : `queued, ${s.ahead} ahead`
        );
      }
    } catch {
      if (id > 0) setJob(id, null);
      showToast("Could not reach the import service");
    }
  };

  // Grow the rendered window when the end of the list scrolls into view.
  // Everything is already in memory, so this costs no requests.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visible >= places.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisible((v) => v + 60);
      },
      { root: scrollRef.current, rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, places.length]);

  const kindLabel = (k: string) => k.replace(/_/g, " ");

  // Only user-imported areas: the shipped city is seeded into the same table
  // from its own ST_Extent, and "Berlin, added 2 years ago" is not evidence
  // that anyone is using the importer.
  // `failed` is excluded: this list exists to show the importer works, and a
  // stranger's failed box is the opposite of that. Its schema is dropped
  // anyway, so there is nothing to fly to.
  const recent = areas
    .filter((a) => a.schema_name?.startsWith("area_") && a.status !== "failed")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  // No names: nothing in the schema holds one, and reverse-geocoding on every
  // render would be a Nominatim call per area per viewer. Centre coordinates
  // are at least honest, and the button is the part that matters.
  const coords = (a: Area) =>
    `${((a.min_lat + a.max_lat) / 2).toFixed(3)}, ${(
      (a.min_lon + a.max_lon) / 2
    ).toFixed(3)}`;

  const flyToArea = (a: Area) => {
    const map = mapRef.current;
    if (!map) return;
    // fitBounds, not setView: the box is the thing being shown, and its size
    // is the point — a fixed zoom would crop some and float above others.
    map.fitBounds([
      [a.min_lat, a.min_lon],
      [a.max_lat, a.max_lon],
    ]);
    if (window.innerWidth <= 720) setPanelOpen(false);
  };

  // Counting locally means the chips can show how many of each there are, and
  // switching filters costs nothing — the whole set is already here.
  const countFor = (g: Group) =>
    places.reduce((n, pl) => n + (g.kinds.includes(pl.kind) ? 1 : 0), 0);
  const activeGroup = groups.find((g) => g.label === kindFilter);
  const shown = activeGroup
    ? places.filter((pl) => activeGroup.kinds.includes(pl.kind))
    : places;

  return (
    <div className="app">
      <aside className={`panel${panelOpen ? " open" : ""}`}>
        <button
          className="sheet-handle"
          onClick={() => setPanelOpen((o) => !o)}
          aria-expanded={panelOpen}
        >
          <span />
        </button>

        <div className="panel-scroll" ref={scrollRef}>
          <header className="panel-head">
            <h1>Reachable</h1>
            <button className="linkish" onClick={() => setHelp(true)}>
              How it works
            </button>
          </header>

          <form className="search" onSubmit={runSearch}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a place…"
              aria-label="Search for a place"
            />
            <button type="submit" disabled={searchState === "loading"}>
              {searchState === "loading" ? "…" : "Go"}
            </button>
          </form>

          {searchState === "none" && (
            <p className="muted">
              No place by that name. Try adding a city or country.
            </p>
          )}
          {searchState === "error" && <p className="muted">{searchError}</p>}

          {results.length > 0 && (
            <ul className="results">
              {results.map((r) => (
                <li key={`${r.lat},${r.lon}`}>
                  <button onClick={() => goTo(r)}>{r.name}</button>
                </li>
              ))}
            </ul>
          )}

          <div className="seg" role="group" aria-label="mobility profile">
            {PROFILES.map((p) => (
              <button
                key={p}
                aria-pressed={p === profile}
                title={caps[p] ? `${p}: up to ${caps[p]} min` : p}
                onClick={() => {
                  profileRef.current = p;
                  setProfile(p);
                  redrawRef.current();
                }}
              >
                <span aria-hidden="true">{PROFILE_ICONS[p]}</span>
                <span className="profile-label">{p}</span>
              </button>
            ))}
          </div>

          <div className="ramp">
            <div className="ramp-bar">
              {basemap.ramp.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </div>
            <div className="ramp-scale">
              <span>0</span>
              <span>{shownMinutes} min</span>
            </div>
          </div>

          {!lastClickRef.current && (
            <p className="hint">
              Click the map to see what you can reach. Dark areas have no
              data yet. Click one to import it.
            </p>
          )}

          <section className="places">
            <div className="places-head">
              <h2>Places within reach</h2>
              {places.length > 0 && (
                <span className="count">{shown.length.toLocaleString()}</span>
              )}
            </div>

            <div className="chips">
              {groups.map((g) => {
                const n = countFor(g);
                return (
                  <button
                    key={g.label}
                    disabled={!n}
                    aria-pressed={kindFilter === g.label}
                    style={
                      kindFilter === g.label
                        ? { background: g.color, borderColor: g.color, color: "#fff" }
                        : undefined
                    }
                    onClick={() => {
                      const next = kindFilter === g.label ? null : g.label;
                      setKindFilter(next);
                      setVisible(60);
                      const grp = groups.find((x) => x.label === next);
                      drawPlacesRef.current(
                        grp
                          ? placesRef.current.filter((pl) => grp.kinds.includes(pl.kind))
                          : placesRef.current
                      );
                    }}
                  >
                    <span aria-hidden="true">{g.icon}</span> {g.label}
                    {n > 0 && <span className="chip-n">{n}</span>}
                  </button>
                );
              })}
            </div>

            {placesState === "loading" && <p className="muted">Looking…</p>}
            {placesState === "empty" && (
              <p className="muted">Nothing of that kind within reach.</p>
            )}
            {placesState === "pending" && (
              <p className="muted">
                Streets are imported here, but the amenities haven't arrived
                yet. They are still being fetched — check back shortly.
              </p>
            )}
            {placesState === "idle" && !places.length && (
              <p className="muted">Pick a point on the map first.</p>
            )}

            <ul className="place-list">
              {shown.slice(0, visible).map((pl, i) => (
                <li key={`${pl.kind}-${pl.name}-${i}`}>
                  <button
                    onClick={() => focusPlace(pl)}
                    title="Show on map"
                  >
                    <span className="pl-min">{pl.minutes}′</span>
                    <span
                      className="pl-dot"
                      style={{
                        background: groupOfRef.current[pl.kind]?.color ?? "#adb5bd",
                      }}
                      aria-hidden="true"
                    />
                    <span className="pl-body">
                      <span className="pl-name">{pl.name || kindLabel(pl.kind)}</span>
                      <span className="pl-kind">{kindLabel(pl.kind)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {visible < shown.length && (
                <li ref={sentinelRef} className="loading-more">
                  loading {Math.min(60, shown.length - visible)} more…
                </li>
              )}
            </ul>
          </section>

          {recent.length > 0 && (
            <section className="recent">
              <h2>Recently added</h2>
              <ul>
                {recent.map((a) => (
                  <li key={a.id}>
                    <button
                      onClick={() => flyToArea(a)}
                      title="Show this area"
                    >
                      <span className="re-where">
                        {a.status === "ready"
                          ? coords(a)
                          : `${coords(a)} · ${a.status}`}
                      </span>
                      <span className="re-when">
                        {ago(a.created_at)}
                        {mineRef.current.has(a.id) && (
                          <span className="re-mine"> · yours</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <footer className="panel-foot">
            <div className="foot-title">Ask Claude about this map</div>
            <div className="foot-cmd">
              <code>claude mcp add isochrone -- npx -y isochrone-mcp</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      "claude mcp add isochrone -- npx -y isochrone-mcp"
                    );
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  } catch {
                    /* no clipboard permission; the text is selectable anyway */
                  }
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <button
              className="linkish"
              onClick={() => {
                setHelpFocus("assistant");
                setHelp(true);
              }}
            >
              see what you can ask
            </button>
          </footer>
        </div>
      </aside>

      <div className="map-wrap">
        <div
          ref={toastRef}
          className="toast"
          style={{ display: "none" }}
        />

        {arrival && !offer && (
          <div className="floating arrival">
            <span>
              An AI assistant drew this with the isochrone MCP server.
            </span>
            <button
              className="linkish"
              onClick={() => {
                setHelpFocus("assistant");
                setHelp(true);
              }}
            >
              what it can do
            </button>
            <button
              className="dismiss"
              aria-label="Dismiss"
              onClick={() => setArrival(false)}
            >
              ×
            </button>
          </div>
        )}

        {offer && (
          <div className="floating offer">
            <span>Nothing imported here yet.</span>
            <button onClick={startImport}>Import 5×5 km area</button>
          </div>
        )}

        {Object.keys(jobs).length > 0 && (
          <div className="floating progress">
            <span className="import-pulse" />
            {Object.keys(jobs).length === 1
              ? Object.values(jobs)[0]
              : `${Object.keys(jobs).length} imports running`}
          </div>
        )}

        <div id="map" />
      </div>

      {help && <HelpPanel onClose={closeHelp} focus={helpFocus} />}
    </div>
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
