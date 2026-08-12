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
  name: string | null;
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

// --- "where should I live" questionnaire --------------------------------
// Mirrors isochrone-backend/layers.ts REACH_LAYERS. Kept as a local literal
// union rather than an import: nothing else in this file imports backend
// modules, and the set only changes in lockstep with a backend release.
type ReachLayer =
  | "groceries"
  | "health"
  | "kindergarten"
  | "school"
  | "playground"
  | "greenspace"
  | "dining";

const LAYER_LABEL: Record<ReachLayer, string> = {
  groceries: "groceries",
  health: "pharmacy/doctor",
  kindergarten: "kindergarten",
  school: "school",
  playground: "playground",
  greenspace: "green space",
  dining: "dining",
};

type SuggestCell = {
  lat: number;
  lon: number;
  score: number;
  layers: Partial<Record<ReachLayer, number>>;
  // null until the backend has reverse-geocoded it; results are useful without
  // one, so this never blocks the response (see withPlaceNames in index.ts).
  name?: string | null;
};

// Sub-minute reach is the normal case in inner Berlin, not an edge case, and
// Math.round turned all of it into "0′" — a whole panel of zeroes reads as
// broken data rather than as "it is right there".
const reachLabel = (secs: number) =>
  secs < 60 ? "<1′" : `${Math.round(secs / 60)}′`;

// Ten results whose scores differ in the fourth decimal are not a ranking, and
// printing "100% match" ten times says so in the least useful way. Measured on
// the default answers: 1.0000, 1.0000, 1.0000, 1.0000, 0.9978 … 0.9942 — a
// spread of 0.6%, all of which rounds to 100. So only claim a ranking when the
// numbers support one.
const SUGGEST_TIE_EPSILON = 0.02;
const scoresAreTied = (cells: SuggestCell[]) =>
  cells.length > 1 &&
  cells[0].score - cells[cells.length - 1].score < SUGGEST_TIE_EPSILON;

// Five questions set weights; the answers are typed as a closed union each,
// which is what keeps the answer space closed — 4·3·2·3·3·3 = 648 sets once
// T-017 added the dog household option and the cycling profile, up from T-016's
// 324. That closure is what lets the backend warm every possible answer into
// redis at startup; a free-text or numeric answer here would blow it open and
// take the warm pass with it.
type SuggestAnswers = {
  household: "alone" | "kids_u6" | "kids_school" | "with_dog";
  groceries: "often" | "weekly";
  health: "important" | "nice" | "not";
  green: "lot" | "some" | "not";
  dining: "often" | "sometimes" | "rarely";
};

const DEFAULT_SUGGEST_ANSWERS: SuggestAnswers = {
  household: "alone",
  groceries: "weekly",
  health: "nice",
  green: "some",
  dining: "sometimes",
};

type WeightQuestion = {
  id: keyof SuggestAnswers;
  kind: "weight";
  label: string;
  options: {
    value: string;
    label: string;
    weights: Partial<Record<ReachLayer, number>>;
  }[];
};
type MobilityQuestion = {
  id: "mobility";
  kind: "profile";
  label: string;
  options: { value: "walk" | "wheelchair" | "bike"; label: string }[];
};
type SuggestQuestion = WeightQuestion | MobilityQuestion;

// One table drives both the buttons and the weight vector sent to
// /api/suggest, so the two can't drift. "mobility" is the exception: it picks
// `profile`, not a weight — wheelchair is a different graph traversal (stairs
// impassable) and bike a faster one, neither a taste to be scored, so neither
// enters the weight sum.
const SUGGEST_QUESTIONS: SuggestQuestion[] = [
  {
    id: "household",
    kind: "weight",
    label: "Who's moving?",
    options: [
      { value: "alone", label: "Just me", weights: {} },
      {
        value: "kids_u6",
        label: "With kids under 6",
        weights: { kindergarten: 3, playground: 2 },
      },
      {
        value: "kids_school",
        label: "With school-age kids",
        weights: { school: 3, playground: 2 },
      },
      // Not a dog layer — 71 dog parks across Berlin is too sparse to carry
      // one (T-017). A dog's daily need is green space, which already has a
      // question and a layer, so this option just aims that dial at max and
      // says so in the UI (see the "with a dog" note in the modal).
      {
        value: "with_dog",
        label: "With a dog",
        weights: { greenspace: 3 },
      },
    ],
  },
  {
    id: "mobility",
    kind: "profile",
    label: "How do you get around?",
    options: [
      { value: "walk", label: "Walking" },
      { value: "wheelchair", label: "Wheelchair" },
      { value: "bike", label: "Cycling" },
    ],
  },
  {
    id: "groceries",
    kind: "weight",
    label: "Food shopping?",
    options: [
      { value: "often", label: "Most days", weights: { groceries: 3 } },
      { value: "weekly", label: "Once a week", weights: { groceries: 1 } },
    ],
  },
  {
    id: "health",
    kind: "weight",
    label: "Doctors and pharmacies nearby?",
    options: [
      { value: "important", label: "Important", weights: { health: 3 } },
      { value: "nice", label: "Nice to have", weights: { health: 1 } },
      { value: "not", label: "Not really", weights: { health: 0 } },
    ],
  },
  {
    id: "green",
    kind: "weight",
    label: "Green space?",
    options: [
      { value: "lot", label: "A lot", weights: { greenspace: 3 } },
      { value: "some", label: "Some", weights: { greenspace: 1 } },
      { value: "not", label: "Not much", weights: { greenspace: 0 } },
    ],
  },
  {
    id: "dining",
    kind: "weight",
    label: "Eating and drinking out?",
    options: [
      { value: "often", label: "Often", weights: { dining: 3 } },
      { value: "sometimes", label: "Sometimes", weights: { dining: 1 } },
      { value: "rarely", label: "Rarely", weights: { dining: 0 } },
    ],
  },
];

// Groceries always carries a non-zero weight (3 or 1, never 0 — the question
// has no "not really" option), so sum(w) can never be zero and the backend's
// score = sum(w_i * layer_i) / sum(w_i) never divides by it.
//
// Max, not last-write: "with a dog" (household) and the green space question
// can both set `greenspace`, and Object.assign would just let question order
// decide, silently dropping the dog's request whenever green space happened
// to be answered afterwards with a lower value. The higher ask always wins.
const buildSuggestWeights = (
  answers: SuggestAnswers
): Partial<Record<ReachLayer, number>> => {
  const w: Partial<Record<ReachLayer, number>> = {};
  for (const q of SUGGEST_QUESTIONS) {
    if (q.kind !== "weight") continue;
    const opt = q.options.find((o) => o.value === answers[q.id]);
    if (!opt) continue;
    for (const [k, v] of Object.entries(opt.weights) as [ReachLayer, number][]) {
      w[k] = Math.max(w[k] ?? 0, v);
    }
  }
  return w;
};

// Dropping zero weights here, not just in buildSuggestWeights: a weight of 0
// ("not really") is a real answer but not a request term the endpoint wants —
// it already treats an absent layer as "don't care".
const suggestQueryParam = (w: Partial<Record<ReachLayer, number>>) =>
  Object.entries(w)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

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
  // Suggestion markers get their own layer group, same pattern as places: a
  // second set of dots the isochrone/places lifecycle must not clear.
  const suggestLayerRef = useRef<L.LayerGroup | null>(null);
  const drawSuggestRef = useRef<(cells: SuggestCell[]) => void>(() => {});
  const focusSuggestionRef = useRef<(c: SuggestCell) => void>(() => {});
  const suggestAbortRef = useRef<AbortController | null>(null);
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

  // "Where should I live" questionnaire. One state object for the five
  // weight-bearing answers (mirrors the `jobs`/`caps` grouping already used
  // here), profile kept separate since it also drives the isochrone picker
  // vocabulary — walk, wheelchair or (T-017) bike.
  //
  // `suggestAnswers`/`suggestProfile` are the *committed* answer set: the one
  // the map is drawn from. The modal (T-017) edits a separate draft copy and
  // only writes back on "Show me" — closing by Escape or the backdrop must
  // discard in-progress edits, not redraw the map with them.
  const [suggestAnswers, setSuggestAnswers] = useState<SuggestAnswers>(
    DEFAULT_SUGGEST_ANSWERS
  );
  const [suggestProfile, setSuggestProfile] = useState<
    "walk" | "wheelchair" | "bike"
  >("walk");
  const [suggestModalOpen, setSuggestModalOpen] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState<SuggestAnswers>(suggestAnswers);
  const [draftProfile, setDraftProfile] = useState<
    "walk" | "wheelchair" | "bike"
  >(suggestProfile);
  // Returns focus to whichever button opened the modal ("Discover…" the first
  // time, "edit answers" afterwards) — both render into this one ref, never
  // both at once.
  const discoverBtnRef = useRef<HTMLButtonElement | null>(null);
  // Suggestions are now a mode you enter (T-017), not a control that queries
  // on every render. This stays false until the first "Show me", so the
  // fetch effect below has something to gate on: mounting must not fire a
  // request nobody asked for.
  const suggestAskedRef = useRef(false);
  const [suggestCells, setSuggestCells] = useState<SuggestCell[]>([]);
  const [suggestState, setSuggestState] = useState<
    "idle" | "loading" | "ok" | "empty" | "unavailable" | "error"
  >("idle");
  const [suggestReason, setSuggestReason] = useState("");

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

    // Suggestion markers: styled entirely through circleMarker options (no
    // CSS class), so "best clearly distinguished" holds regardless of
    // stylesheet — rank 1 is bigger and amber, the rest are smaller and blue.
    suggestLayerRef.current = L.layerGroup().addTo(map);
    drawSuggestRef.current = (cells: SuggestCell[]) => {
      const g = suggestLayerRef.current;
      if (!g) return;
      g.clearLayers();
      cells.forEach((c, i) => {
        L.circleMarker([c.lat, c.lon], {
          radius: i === 0 ? 12 : 8,
          weight: 2,
          color: "#fff",
          fillColor: i === 0 ? "#ffb703" : "#3a86ff",
          fillOpacity: 0.92,
        })
          // The name, not the score: "100% match" on ten pins is noise, and the
          // pin's own position already says where it is. DOM node rather than a
          // string for the same reason as the popup below — Nominatim's text is
          // not ours to render as markup.
          .bindTooltip(
            Object.assign(document.createElement("span"), {
              textContent: c.name ?? `#${i + 1}`,
            }),
            { direction: "top" }
          )
          .on("click", () => focusSuggestionRef.current(c))
          .addTo(g);
      });
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
          // Do not guess at the cause. This fires on a 200 with no bands, which
          // means the click DID snap to a routable vertex — the server's 400
          // covers the "no street nearby" case with an exact distance. So the
          // spot is on the network and simply cannot reach anything in the time
          // budget: measured on vertex 70954, whose only edge is a 1,764m path,
          // 21 minutes on foot and therefore empty at 15. The old copy blamed
          // "stairs or rough surfaces", which is wrong for walk in particular —
          // stairs are passable there at half speed (PROFILES in layers.ts).
          showToast(
            `Nothing reachable within ${data.minutes} min from here on "${profileRef.current}". Try more minutes, or another profile.`
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

  // Same interaction as focusPlace: click a result, the map moves there.
  // Coordinates only in the popup — the endpoint deliberately returns no
  // name (T-016 non-goal: reverse-geocoding N results per request would sit
  // behind the 1 req/s geocodeSlot() gate).
  const focusSuggestion = (c: SuggestCell) => {
    const map = mapRef.current;
    if (!map) return;
    // Switch to the profile the questionnaire was answered with. A suggestion
    // earned its place by cycling reach or wheelchair reach; drawing it as a
    // walk would show a different shape than the one that was ranked, which is
    // the sort of quiet mismatch this project keeps getting caught by.
    if (profileRef.current !== suggestProfile) {
      profileRef.current = suggestProfile;
      setProfile(suggestProfile);
    }
    // 14, not 16: a 15-minute walk is roughly a 1.25km radius and overflows the
    // viewport at 16, so the isochrone we just drew would be mostly off-screen.
    map.setView([c.lat, c.lon], 14);
    // Draw the reach from here. Clicking a result and getting only a pin left
    // the two halves of the product disconnected — the suggestion says "this
    // place is close to everything" and the isochrone is what shows it.
    // updateIsochrones owns the marker and lastClickRef, so switching profile
    // afterwards redraws at this spot rather than the last map click.
    updateRef.current(c.lat, c.lon);
    L.popup({ closeButton: false, className: "place-popup" })
      .setLatLng([c.lat, c.lon])
      // A DOM node, not an HTML string: the name comes from Nominatim, and
      // setContent would render it as markup. textContent cannot, and is less
      // code than an escape helper — same reason the toast at showToast does it.
      .setContent(
        Object.assign(document.createElement("b"), {
          textContent: c.name ?? `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`,
        })
      )
      .openOn(map);
    if (window.innerWidth <= 720) setPanelOpen(false);
  };
  focusSuggestionRef.current = focusSuggestion;

  // Opens with a fresh copy of the committed answers, so repeated edit/cancel
  // cycles can't leak a half-typed draft from a previous open.
  const openSuggestModal = () => {
    setDraftAnswers({ ...suggestAnswers });
    setDraftProfile(suggestProfile);
    setSuggestModalOpen(true);
  };

  // Escape / backdrop / × all end here: the draft is simply discarded, and
  // focus goes back to whichever button opened the modal.
  const closeSuggestModal = () => {
    setSuggestModalOpen(false);
    discoverBtnRef.current?.focus();
  };

  // "Show me": the only path that commits the draft. Spreading draftAnswers
  // into a new object guarantees a fresh reference even when nothing in it
  // changed, so the fetch effect's dependency array always sees a change and
  // fires — otherwise clicking "Show me" a second time with identical
  // answers would silently do nothing.
  const submitSuggest = () => {
    suggestAskedRef.current = true;
    setSuggestAnswers({ ...draftAnswers });
    setSuggestProfile(draftProfile);
    setSuggestModalOpen(false);
    discoverBtnRef.current?.focus();
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

  // Answers → weights → /api/suggest, debounced so five questions changing in
  // quick succession fire one request, not five. No routing call happens
  // here — this is the whole point of T-016: the field is precomputed, so
  // re-ranking on every answer costs one Postgres aggregate, not a traversal.
  //
  // Runs on `suggestAnswers`/`suggestProfile`, the committed values, not the
  // modal's draft — so this still only fires once per "Show me" (T-017), not
  // once per button press inside the modal.
  useEffect(() => {
    if (!suggestAskedRef.current) return; // nobody has clicked "Show me" yet
    const t = setTimeout(() => {
      const w = suggestQueryParam(buildSuggestWeights(suggestAnswers));
      if (!w) return; // groceries always weights >0; defensive only
      suggestAbortRef.current?.abort();
      const ac = new AbortController();
      suggestAbortRef.current = ac;
      setSuggestState("loading");
      fetch(`/api/suggest?profile=${suggestProfile}&w=${encodeURIComponent(w)}`, {
        signal: ac.signal,
      })
        .then((r) => r.json())
        .then((d: { available: boolean; reason?: string; cells?: SuggestCell[] }) => {
          if (!d.available) {
            setSuggestCells([]);
            setSuggestReason(d.reason ?? "");
            setSuggestState("unavailable");
            drawSuggestRef.current([]);
            return;
          }
          const cells = d.cells ?? [];
          setSuggestCells(cells);
          setSuggestState(cells.length ? "ok" : "empty");
          drawSuggestRef.current(cells);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return; // superseded by a newer answer
          setSuggestCells([]);
          // Not "empty": a redis or postgres blip telling someone there are no
          // good places to live, when the truth is we failed to look, is the
          // one wrong answer this panel must never give.
          setSuggestState("error");
          drawSuggestRef.current([]);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [suggestAnswers, suggestProfile]);

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

  // Fallback only now: names are fetched once server-side at import time (see
  // runImport), not here — reverse-geocoding on every render would still be a
  // Nominatim call per area per viewer. Used for pre-existing areas (never
  // backfilled), failed lookups, and areas still importing (name isn't set
  // until ready).
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

  // Layers actually asked about, in the current answer set — drives which
  // per-cell times (or "no X in 30 min") each result row prints.
  const currentWeights = buildSuggestWeights(suggestAnswers);
  const suggestLayers = (Object.keys(currentWeights) as ReachLayer[]).filter(
    (l) => (currentWeights[l] ?? 0) > 0
  );

  // Compact stand-in for the questions once "Show me" has been clicked — the
  // panel shows what was asked, not the ranked list (T-017: that lives on
  // the map).
  const suggestSummary = SUGGEST_QUESTIONS.map((q) => {
    const value = q.kind === "profile" ? suggestProfile : suggestAnswers[q.id];
    return q.options.find((o) => o.value === value)?.label;
  })
    .filter(Boolean)
    .join(" · ");

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

          <section className="suggest">
            <div className="places-head">
              <h2>Where should I live?</h2>
            </div>
            <p className="muted suggest-honesty">
              Ranks reachability only — not rent, not noise, not transit.
            </p>

            {suggestState === "idle" ? (
              // T-017: no always-visible questionnaire. Suggestions are a
              // mode you enter, not a control that crowds this panel.
              <button
                ref={discoverBtnRef}
                type="button"
                className="discover-btn"
                onClick={openSuggestModal}
              >
                Discover suitable living locations in Berlin
              </button>
            ) : (
              <>
                <div className="suggest-summary">
                  <p className="suggest-summary-text">{suggestSummary}</p>
                  <button
                    ref={discoverBtnRef}
                    type="button"
                    className="linkish"
                    onClick={openSuggestModal}
                  >
                    edit answers
                  </button>
                </div>

                {suggestState === "unavailable" && (
                  <p className="muted">
                    {suggestReason ||
                      "Suggestions are only available for Berlin right now."}
                  </p>
                )}
                {suggestState === "loading" && (
                  <p className="muted">Ranking…</p>
                )}
                {suggestState === "empty" && (
                  <p className="muted">No matches for this answer set.</p>
                )}
                {suggestState === "error" && (
                  <p className="suggest-miss">
                    Could not reach the server — this is not a result, try again.
                  </p>
                )}

                {suggestState === "ok" && suggestCells.length > 0 && (
                  <>
                    <p className="muted suggest-tie-note">
                      {scoresAreTied(suggestCells)
                        ? `${suggestCells.length} areas, all equally close to what you picked — they are alternatives, not a ranking.`
                        : `${suggestCells.length} areas, best first.`}
                    </p>
                    <ul className="place-list suggest-results">
                      {suggestCells.map((c, i) => (
                        <li key={`${c.lat},${c.lon}`}>
                          <button onClick={() => focusSuggestion(c)} title="Show on map">
                            {/* Plain enumeration, not a score. A bare bullet
                                read as a broken list marker, and a normalised
                                0-100 would be worse than either: stretching
                                1.0000-0.9942 across a full range manufactures a
                                large-looking difference out of 0.6%. The note
                                above already says these are alternatives, so
                                the number is just "which one am I looking at".
                                Revisit once density gives a real spread. */}
                            <span className="pl-min suggest-rank">{i + 1}</span>
                            <span className="pl-body">
                              <span className="pl-name">
                                {c.name ??
                                  `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`}
                              </span>
                              <span className="pl-kind suggest-layers">
                                {suggestLayers.map((layer) => {
                                  const secs = c.layers[layer];
                                  return (
                                    <span
                                      key={layer}
                                      className={
                                        secs == null
                                          ? "suggest-layer suggest-miss"
                                          : "suggest-layer"
                                      }
                                    >
                                      {secs == null
                                        ? `no ${LAYER_LABEL[layer]} in 30 min`
                                        : `${LAYER_LABEL[layer]} ${reachLabel(secs)}`}
                                    </span>
                                  );
                                })}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>

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
                          ? a.name ?? coords(a)
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
      {suggestModalOpen && (
        <SuggestModal
          answers={draftAnswers}
          profile={draftProfile}
          onAnswer={(id, value) =>
            setDraftAnswers((a) => ({ ...a, [id]: value }))
          }
          onProfile={setDraftProfile}
          onSubmit={submitSuggest}
          onClose={closeSuggestModal}
        />
      )}
    </div>
  );
}

// T-017: the questionnaire moved off the always-visible panel and into this
// modal, opened by the "Discover…" button and closed by "Show me", Escape or
// the backdrop. It edits a draft only — MapView commits it on submit, so
// dismissing the modal any other way is a no-op on the map.
function SuggestModal({
  answers,
  profile,
  onAnswer,
  onProfile,
  onSubmit,
  onClose,
}: {
  answers: SuggestAnswers;
  profile: "walk" | "wheelchair" | "bike";
  onAnswer: (id: keyof SuggestAnswers, value: string) => void;
  onProfile: (value: "walk" | "wheelchair" | "bike") => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Focus moves into the modal on open; MapView returns it to the trigger
    // button on close (both close paths route through onClose/onSubmit).
    dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Minimal Tab wrap — no focus-trap library — so Tab can't leak past
      // the modal onto the map hidden behind the backdrop.
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // Fixed, full-viewport, above the map's z-index: this is also what stops
    // the map scrolling or zooming while the modal is open — the backdrop
    // physically intercepts every pointer and wheel event before Leaflet
    // ever sees one.
    <div className="suggest-modal-backdrop" onClick={onClose}>
      <div
        className="suggest-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Where should I live?"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="suggest-modal-head">
          <h2>Where should I live?</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="muted suggest-honesty">
          Ranks reachability only — not rent, not noise, not transit.
        </p>

        {SUGGEST_QUESTIONS.map((q) => (
          <div className="suggest-q" key={q.id}>
            <div className="suggest-q-label">{q.label}</div>
            <div className="seg" role="group" aria-label={q.label}>
              {q.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={
                    q.kind === "profile"
                      ? profile === o.value
                      : answers[q.id] === o.value
                  }
                  onClick={() =>
                    q.kind === "profile"
                      ? onProfile(o.value as "walk" | "wheelchair" | "bike")
                      : onAnswer(q.id, o.value)
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>

            {q.id === "mobility" && profile === "bike" && (
              <p className="muted suggest-note">
                Bike ignores one-way streets, so results are slightly
                optimistic on contraflow.
              </p>
            )}
            {q.id === "household" && answers.household === "with_dog" && (
              <p className="muted suggest-note">
                read as: green space matters a lot
              </p>
            )}
          </div>
        ))}

        <button type="button" className="suggest-submit" onClick={onSubmit}>
          Show me
        </button>
      </div>
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
