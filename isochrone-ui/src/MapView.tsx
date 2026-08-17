import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import L from "leaflet";
import HelpPanel from "./HelpPanel";
import { areaCharacter } from "./character";

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

// How to say "a trip of N minutes" for each profile. The click popup hardcoded
// "walk" and kept saying it with bike selected — reported against a screenshot
// reading "10 min walk" beneath a lit-up bike pill, with the minutes and the
// counts already correct. One verb cannot cover all four without being wrong
// ("walk" for bike) or presumptuous ("roll" for wheelchair), so each gets its
// own phrase.
const PROFILE_TRIP: Record<string, string> = {
  walk: "on foot",
  stroller: "with a stroller",
  wheelchair: "by wheelchair",
  bike: "by bike",
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

// Suggestion heatmap ramp (T-021): five stops, red→amber→green, interpolated
// to a smooth 255-step lookup table once at load rather than per pixel — a
// city-sized grid is up to ~42,000 cells and redoing the hex math per pixel
// per redraw would be wasted work. Lightness rises with score (not a plain
// hue sweep) so the ramp still separates worst from best under red-green
// colour blindness or in greyscale. One ramp for every basemap, unlike
// BASEMAPS[].ramp above — that one forks per theme because its far end has
// to stay visible against a dark tile; this ramp sits on an opaque canvas
// and doesn't have that problem.
const HEAT_STOPS: [number, string][] = [
  [0, "#8c1d1d"],
  [0.25, "#d94f04"],
  [0.5, "#f0a202"],
  [0.75, "#a6c34d"],
  [1, "#e8f5a3"],
];
const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
// HEAT_LUT[v - 1] is the colour for score byte v (1..255); byte 0 means "no
// data" and is handled separately (fully transparent) without a lookup.
const HEAT_LUT: [number, number, number][] = Array.from({ length: 255 }, (_, i) => {
  const t = i / 254;
  let hi = HEAT_STOPS.findIndex(([stop]) => t <= stop);
  if (hi <= 0) hi = 1; // t=0 still interpolates within the first segment
  const [t0, c0] = HEAT_STOPS[hi - 1];
  const [t1, c1] = HEAT_STOPS[hi];
  const f = (t - t0) / (t1 - t0 || 1);
  const [r0, g0, b0] = hexToRgb(c0);
  const [r1, g1, b1] = hexToRgb(c1);
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
});

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
  // How many places of each layer sit within the profile's density radius. Absent
  // on a field whose density has not been backfilled, so every read is optional.
  nearby?: Partial<Record<ReachLayer, number>>;
};

// /api/suggest-grid: a whole-city percentile heatmap, not per-cell reach
// numbers — see MapView's drawHeat for the byte layout this decodes.
type SuggestGrid = {
  available: boolean;
  origin?: { lat: number; lon: number };
  step?: number;
  cols?: number;
  rows?: number;
  scores?: string; // base64
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
    // Labels match the profile pills above the map, and the API's profile
    // names, exactly. "Cycling" here next to a "bike" pill read as two
    // different things when picking one visibly switched the other.
    options: [
      { value: "walk", label: "Walk" },
      { value: "wheelchair", label: "Wheelchair" },
      { value: "bike", label: "Bike" },
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
  // T-031: non-null exactly when a click produced isochrone bands — drives
  // both the ramp legend's visibility and the map popup summary below. Reset
  // to null on every failure path (offer, error, empty) alongside the
  // isochrone layer itself, so the two never disagree about "did this work".
  const [clickSummary, setClickSummary] = useState<{ lat: number; lon: number } | null>(
    null
  );
  // Whether the summary popup is the one currently on the map, tracked apart
  // from clickSummary because the two answer different questions: clickSummary
  // means "a click produced bands" and also gates the ramp legend, while this
  // means "our popup is open right now". Conflating them made the popup effect
  // reopen a popup the user had just dismissed as soon as any dependency
  // changed, and steal the map back from a place popup they had opened since —
  // Leaflet allows exactly one popup, so reopening ours closes theirs.
  const summaryPopupRef = useRef<L.Popup | null>(null);
  const summaryOpenRef = useRef(false);
  // Which clickSummary the open popup belongs to, so a change of contents (a
  // chip toggle, a profile switch, places arriving) updates it in place rather
  // than tearing it down and opening a new one at the same spot. Compared by
  // identity, not coordinates: clicks snap to a ~200m grid, so dismissing a
  // popup and clicking roughly the same place again produces the same lat/lon,
  // and a value comparison would decide nothing had changed and open nothing.
  // Every successful draw hands us a fresh object, which is the honest signal.
  const summarySourceRef = useRef<{ lat: number; lon: number } | null>(null);
  // Right rail defaults open; the toggle just gets it out of the way, it
  // never affects whether Discover has been used (suggestState still owns that).
  const [railOpen, setRailOpen] = useState(true);
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
  // T-035 round 2: the collapsed sheet's peek height (see --peek in
  // index.css) is measured here instead of hardcoded — see the effect
  // below, right after the JSX refs it needs.
  const panelRef = useRef<HTMLElement | null>(null);
  const sheetHandleRef = useRef<HTMLButtonElement | null>(null);
  const mobilitySegRef = useRef<HTMLDivElement | null>(null);
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
  // The city heatmap, fetched alongside /api/suggest but on its own request —
  // its own imageOverlay ref and abort controller so a slow grid can never
  // block or race the ten markers above.
  const heatLayerRef = useRef<L.ImageOverlay | null>(null);
  const drawHeatRef = useRef<(grid: SuggestGrid) => void>(() => {});
  const suggestGridAbortRef = useRef<AbortController | null>(null);
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
  // Drives the heatmap legend only — the layer itself lives imperatively on
  // heatLayerRef, same split as isochroneRef/shownMinutes above.
  const [heatAvailable, setHeatAvailable] = useState(false);

  // T-031: one shared "something is loading" signal for the thin bar at the
  // top of the map (see .loading-bar below), covering the five requests that
  // previously gave no feedback at all. A counter, not a boolean — two of
  // these fire in parallel by design (/api/suggest and /api/suggest-grid on
  // every questionnaire answer; a map click firing the isochrone then
  // /api/amenities), and a boolean would flip off while the other was still
  // in flight. Every increment is paired with a decrement in a `finally`, so
  // an early return, an aborted request and a thrown error all still release
  // it — see the five call sites below. No ref needed alongside the state:
  // every reader here only ever bumps the counter with a functional update,
  // never reads its current value synchronously.
  const [loadingCount, setLoadingCount] = useState(0);
  const beginLoading = () => setLoadingCount((c) => c + 1);
  const endLoading = () => setLoadingCount((c) => Math.max(0, c - 1));

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
    // T-031: the right rail is a tall fixed panel pinned to the right edge,
    // which would sit directly on top of Leaflet's default bottom-right
    // attribution. Move attribution to the one corner nothing else claims.
    map.attributionControl.setPosition("bottomleft");

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

    // Dedicated pane for the heatmap, created once here rather than per
    // draw. zIndex 350 sits strictly between tilePane (200, the basemap) and
    // the default overlayPane (400, where the veil, the isochrone bands and
    // every marker live) — Leaflet's own documented z-index stacking then
    // keeps the heatmap under all of those, rather than betting on insertion
    // order into a renderer Leaflet owns.
    map.createPane("heat");
    map.getPane("heat")!.style.zIndex = "350";

    areasRef.current = L.layerGroup().addTo(map);

    // Suggestion heatmap: one <img>, not up to ~42,000 Leaflet shapes. A
    // canvas exactly cols×rows — one real pixel per grid cell — lets the
    // browser do the upscaling; image-rendering:pixelated (see .heat-overlay
    // in index.css) keeps that scaling blocky rather than inventing gradient
    // between measurements that were never taken (each cell is a real
    // ~163m×267m on the ground). Always removes the previous layer first, so
    // re-answering the questionnaire replaces it instead of stacking a
    // second one, and `available: false` leaves nothing behind.
    const drawHeat = (grid: SuggestGrid) => {
      if (heatLayerRef.current) {
        map.removeLayer(heatLayerRef.current);
        heatLayerRef.current = null;
      }
      const { available, origin, step, cols, rows, scores } = grid;
      if (!available || !origin || !step || !cols || !rows || !scores) {
        setHeatAvailable(false);
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(scores), (c) => c.charCodeAt(0));
      } catch {
        setHeatAvailable(false); // malformed base64: draw nothing, not garbage
        return;
      }
      if (bytes.length !== cols * rows) {
        setHeatAvailable(false);
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setHeatAvailable(false);
        return;
      }
      const img = ctx.createImageData(cols, rows);
      // Row 0 = northmost, col 0 = westmost, index r*cols+c — maps straight
      // onto canvas pixel (c, r) with no flip (see the wire contract).
      for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i];
        const p = i * 4;
        if (v === 0) {
          img.data[p + 3] = 0; // no data: fully transparent
          continue;
        }
        const [r, g, b] = HEAT_LUT[v - 1];
        img.data[p] = r;
        img.data[p + 1] = g;
        img.data[p + 2] = b;
        img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);

      const bounds: L.LatLngBoundsExpression = [
        [origin.lat - rows * step, origin.lon],
        [origin.lat, origin.lon + cols * step],
      ];
      heatLayerRef.current = L.imageOverlay(canvas.toDataURL(), bounds, {
        opacity: 0.6, // tuned so the basemap still reads through
        interactive: false,
        className: "heat-overlay",
        pane: "heat", // stacking below the veil/markers comes from this, not add order
      }).addTo(map);
      setHeatAvailable(true);
    };
    drawHeatRef.current = drawHeat;

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

    // Suggestion markers carry their rank. The panel lists them 1..10 and the
    // map drew ten identical dots, so matching a result to its pin meant
    // hovering each one — reported with a screenshot of the plain blue dots.
    // divIcon rather than circleMarker because a circle cannot hold text; the
    // styling stays inline for the reason the circles did, so "best clearly
    // distinguished" survives regardless of the stylesheet — rank 1 is bigger
    // and amber, the rest smaller and blue. The only interpolated value is the
    // loop index, which is ours; the area's name stays a text node in the
    // tooltip below, because Nominatim's text is not ours to render as markup.
    suggestLayerRef.current = L.layerGroup().addTo(map);
    drawSuggestRef.current = (cells: SuggestCell[]) => {
      const g = suggestLayerRef.current;
      if (!g) return;
      g.clearLayers();
      cells.forEach((c, i) => {
        const best = i === 0;
        const d = best ? 26 : 21;
        L.marker([c.lat, c.lon], {
          icon: L.divIcon({
            // Empty, not omitted: Leaflet's default divIcon class paints a
            // white box behind the pin.
            className: "",
            iconSize: [d, d],
            iconAnchor: [d / 2, d / 2],
            html:
              `<div style="width:${d}px;height:${d}px;border-radius:50%;` +
              `background:${best ? "#ffb703" : "#3a86ff"};` +
              `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);` +
              `color:#fff;font:700 ${best ? 13 : 11}px system-ui;` +
              `display:flex;align-items:center;justify-content:center;` +
              `box-sizing:border-box;">${i + 1}</div>`,
          }),
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

    // 5s forever, unconditionally, was 720 requests/hour per open tab — a
    // phone's radio and battery for a list that changes a few times a day.
    // Clear the timer outright while hidden rather than leaving it running
    // and early-returning on tick: a no-op fetch still wakes the radio, so
    // the point is to not make the request at all. `areaTimer` is nulled
    // whenever stopped so the visibilitychange handler below can guard
    // against stacking a second interval if it fires while already visible.
    let areaTimer: ReturnType<typeof setInterval> | null = null;
    const stopAreaTimer = () => {
      if (areaTimer) {
        clearInterval(areaTimer);
        areaTimer = null;
      }
    };
    const startAreaTimer = () => {
      if (!areaTimer) areaTimer = setInterval(refreshAreas, 5000);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopAreaTimer();
      } else {
        // Coming back to stale data is the reward for returning; refresh
        // once immediately, then resume the 5s cadence. Calls refreshAreas
        // directly, not refreshAreasRef.current — both are the same function
        // for this mount's lifetime, and the ref exists only so startImport,
        // which is outside this effect's closure, can reach it.
        refreshAreas();
        startAreaTimer();
      }
    };
    if (!document.hidden) startAreaTimer();
    document.addEventListener("visibilitychange", onVisibilityChange);

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

      // This function owns lastClickRef. It used to be stamped by each caller
      // instead — the map click, the deep link, the search result — and
      // focusSuggestion, which calls straight in here, was the one that never
      // did. So after clicking a ranked suggestion the profile picker's redraw
      // had either a stale coordinate or none at all, and switching walk→bike
      // did nothing whatsoever. Reported from the edge-split branch. Setting it
      // where every path already converges is also what makes the comment in
      // focusSuggestion true rather than aspirational.
      lastClickRef.current = [lat, lng];

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

      // T-031: the primary interaction (click → bands) had no loading signal
      // at all. beginLoading/endLoading wrap the whole request-to-draw span,
      // not just the fetch, so the bar stays up through layer building too.
      // The `finally` is what makes the decrement unconditional across every
      // exit this function has: the stale-gen returns below (both inside the
      // try and inside the catch), the outside-coverage/error return, a
      // thrown error, and the ordinary path all funnel through it.
      beginLoading();
      try {
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
            setClickSummary(null);
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
          setClickSummary(null);
        }

        if (gen !== drawGenRef.current) return;
        clearIsochrone();
        isochroneRef.current = L.layerGroup(layers).addTo(map);
        // Bands drawn (not just a 200): the "nothing reachable" case above still
        // clears the layer to empty, and the popup has nothing worth summarising.
        setClickSummary(layers.length ? { lat, lon: lng } : null);
        if (layers.length) loadPlacesRef.current(lat, lng);
      } finally {
        endLoading();
      }
    };
    updateRef.current = updateIsochrones;

    const step = 0.002;

    const snap = (val: number) => {
      return Math.round(val / step) * step;
    };

    const debouncedUpdate = debounce((lat: number, lng: number) => {
      const snappedLat = parseFloat(snap(lat).toFixed(5));
      const snappedLng = parseFloat(snap(lng).toFixed(5));
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
      updateIsochrones(urlLat, urlLon);
    }

    // The sidebar collapses and expands, and Leaflet caches container size.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(document.getElementById("map")!);

    return () => {
      stopAreaTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ro.disconnect();
    };
  }, []);

  // T-035 round 2: the bottom sheet's collapsed "peek" height used to be a
  // hardcoded pixel constant in index.css, hand-recalibrated twice (T-032,
  // T-035) and wrong both times — see the comment on --peek there for the
  // measured 147px (pointer:fine) / 200px (pointer:coarse) split that made
  // "one constant" a dead end. Measured instead: sheet-handle's top to the
  // mobility .seg row's bottom is exactly the collapsed header stack, on
  // both pointer types and any viewport width, so read it from the DOM.
  // ResizeObserver already batches to at most one callback per frame across
  // both observed elements, so no extra debounce is needed here.
  // useLayoutEffect, and measure() called directly rather than left to the
  // observer's first delivery: ResizeObserver reports on an animation frame,
  // so on a plain useEffect the sheet paints once at the CSS fallback and
  // then snaps to the measured value. Worse, a document whose frames are
  // frozen — a background tab, an offscreen iframe — gets no delivery at all
  // and silently keeps the fallback, which is the fine/coarse leak this whole
  // change exists to remove. Measured 2026-08-17 in a hidden tab: zero
  // callbacks in 800ms, even after forcing a real size change. The observer
  // stays for what comes later (pointer type, font load, rotation); the
  // synchronous call is what makes the first paint correct.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const top = sheetHandleRef.current;
    const bottom = mobilitySegRef.current;
    if (!panel || !top || !bottom) return;
    const measure = () => {
      // The panel's own translateY offset (open vs. collapsed) shifts both
      // elements by the same amount, so it cancels out of this difference —
      // safe to measure in either state.
      const px = bottom.getBoundingClientRect().bottom - top.getBoundingClientRect().top;
      if (px > 0) panel.style.setProperty("--peek", `${Math.round(px) + 6}px`); // +6: slack off the viewport edge
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(top);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, []);

  // Amenities are a second request, so they get their own generation guard —
  // same overtaking problem the isochrone had.
  const loadPlaces = async (lat: number, lon: number, filter = kindFilter) => {
    const gen = ++placesGenRef.current;
    setPlacesState("loading");
    setVisible(60);
    void filter; // filtering happens client-side now; fetch every kind once
    // T-031: `finally` covers both stale-gen returns above, the !r.ok early
    // return, the catch block, and the ordinary success path.
    beginLoading();
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
    } finally {
      endLoading();
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
  // Picking a mobility option previews it immediately: the pill above the map
  // moves and, if somewhere is already selected, its isochrone redraws in the
  // new profile. Answering "how do you get around" and watching nothing change
  // until "Show me" made the question feel disconnected from the map behind it.
  //
  // Only the map view is previewed — the *answers* stay draft until submit, so
  // closing with X still discards them. The profile pill is a view setting
  // rather than part of the answer set, and leaving the map on the last profile
  // the user actually clicked is truer than snapping it back.
  //
  // redrawRef is a no-op when nothing has been clicked yet, so opening the
  // questionnaire cold and flipping profiles costs nothing.
  const previewProfile = (p: "walk" | "wheelchair" | "bike") => {
    setDraftProfile(p);
    profileRef.current = p;
    setProfile(p);
    redrawRef.current();
  };

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
  // What the map was showing before the questionnaire opened, so cancelling can
  // undo a profile preview. Stored rather than assumed to be suggestProfile:
  // the pills include stroller, which the questionnaire cannot express, and
  // snapping a stroller view to "walk" on cancel would discard a choice the
  // user made outside this modal.
  const profileBeforeModalRef = useRef(profile);

  const openSuggestModal = () => {
    setDraftAnswers({ ...suggestAnswers });
    setDraftProfile(suggestProfile);
    profileBeforeModalRef.current = profileRef.current;
    setSuggestModalOpen(true);
  };

  // Escape / backdrop / × all end here: the draft is simply discarded, and
  // focus goes back to whichever button opened the modal. That now includes any
  // profile previewed while it was open — otherwise cancelling could leave the
  // pill on "bike" while the committed summary line still read "Walk", which is
  // the mismatch the preview was added to remove.
  const closeSuggestModal = () => {
    if (profileRef.current !== profileBeforeModalRef.current) {
      profileRef.current = profileBeforeModalRef.current;
      setProfile(profileBeforeModalRef.current);
      redrawRef.current();
    }
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
    // T-031: begun only past the q.length guard above, since that return
    // exits before any request starts — nothing to release for it. `finally`
    // then covers the !r.ok early return, the catch, and the success path.
    beginLoading();
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
    } finally {
      endLoading();
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
      // T-031: .finally, not try/finally — this is a .then chain, not
      // async/await. It runs whether the chain resolves, rejects with the
      // superseded-request AbortError caught below, or rejects with anything
      // else, so the counter always comes back down.
      beginLoading();
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
        })
        .finally(() => endLoading());

      // Whole-city heatmap, fetched in parallel with the markers above — a
      // second fetch() call, not awaited between them, so a slow grid can
      // never delay the ten pins. Same abort-on-superseded guard as the
      // fetch above, its own AbortController: aborting the in-flight request
      // when a newer answer set arrives is what stops a stale response from
      // painting over a fresh one, the same out-of-order race drawGenRef
      // guards elsewhere in this file for isochrone clicks.
      suggestGridAbortRef.current?.abort();
      const gridAc = new AbortController();
      suggestGridAbortRef.current = gridAc;
      beginLoading();
      fetch(`/api/suggest-grid?profile=${suggestProfile}&w=${encodeURIComponent(w)}`, {
        signal: gridAc.signal,
      })
        .then((r) => (r.ok ? r.json() : { available: false }))
        .then((d: SuggestGrid) => drawHeatRef.current(d))
        .catch((err) => {
          if (err?.name === "AbortError") return; // superseded by a newer answer
          drawHeatRef.current({ available: false }); // network blip: no heatmap, not a stale one
        })
        .finally(() => endLoading());
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

  // T-031: shared by the left panel's chips and the map popup's chips, so
  // whichever one you click, the same state drives the same filter — see
  // ACCEPT in the spec.
  const toggleKindFilter = (label: string) => {
    const next = kindFilter === label ? null : label;
    setKindFilter(next);
    setVisible(60);
    const grp = groups.find((x) => x.label === next);
    drawPlacesRef.current(
      grp ? placesRef.current.filter((pl) => grp.kinds.includes(pl.kind)) : placesRef.current
    );
  };

  // Layers actually asked about, in the current answer set — drives which
  // per-cell times (or "no X in 30 min") each result row prints.
  const currentWeights = buildSuggestWeights(suggestAnswers);
  const suggestLayers = (Object.keys(currentWeights) as ReachLayer[]).filter(
    (l) => (currentWeights[l] ?? 0) > 0
  );

  // Set-relative "more X · less Y" per card, computed once for the whole
  // list (not per card) since it needs every cell's counts to find the
  // spread — see character.ts for why this replaced raw counts (T-019).
  const suggestCharacter = areaCharacter(suggestCells, suggestLayers);

  // The per-cell reach line reads "everything within <1'" on every card, not
  // just often — the scoring gate above already excluded anything slower, so
  // there is nothing left for a per-card line to distinguish (see the reach
  // comment further down). Rather than print the same clause ten times, hoist
  // it into the note once, and only once every cell clears every asked-about
  // layer with the same rounded label; a single miss or a differing label
  // falls back to the existing per-card behaviour.
  const suggestReachLabels =
    suggestLayers.length > 0
      ? suggestCells.map((c) =>
          suggestLayers.every((l) => c.layers[l] != null)
            ? reachLabel(
                Math.max(...suggestLayers.map((l) => c.layers[l] as number))
              )
            : null
        )
      : [];
  const suggestUniformReach =
    suggestReachLabels.length > 0 &&
    suggestReachLabels.every((l) => l !== null && l === suggestReachLabels[0])
      ? suggestReachLabels[0]
      : null;

  // "these ten" was a lie the moment fewer than ten cells qualified — say
  // "these N" instead, so the sentence stays true at any result count.
  const suggestNoteText = `${
    scoresAreTied(suggestCells)
      ? `${suggestCells.length} areas, all equally close to what you picked. They are alternatives, not a ranking.`
      : `${suggestCells.length} areas, best first.`
  }${
    suggestUniformReach ? ` Everything is within ${suggestUniformReach} in all of them.` : ""
  } More and less are relative to these ${suggestCells.length} areas, not to Berlin.`;

  // Compact stand-in for the questions once "Show me" has been clicked — the
  // panel shows what was asked, not the ranked list (T-017: that lives on
  // the map).
  const suggestSummary = SUGGEST_QUESTIONS.map((q) => {
    const value = q.kind === "profile" ? suggestProfile : suggestAnswers[q.id];
    return q.options.find((o) => o.value === value)?.label;
  })
    .filter(Boolean)
    .join(" · ");

  // T-031: the click result moved off the sidebar and onto the map as a
  // popup — a compact summary (walk time, total reachable, the seven group
  // chips), not the full list, which still lives in the left panel. Rebuilt
  // from scratch on every relevant change rather than patched in place: the
  // content is a handful of DOM nodes, and focusPlace/focusSuggestion below
  // already build fresh L.popup() instances the same way, so this matches
  // the existing convention instead of adding a new one.
  //
  // ponytail: the chip click handler below duplicates toggleKindFilter's
  // four lines rather than calling it, so this effect's dependency array can
  // stay honest (toggleKindFilter is redefined every render and would force
  // a rebuild — and a popup reopen — on every keystroke in the search box).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!clickSummary) {
      // Close ours, not whatever happens to be open: map.closePopup() with no
      // argument shuts the current popup, which after a click on a place in
      // the list is theirs, not ours.
      if (summaryPopupRef.current) map.closePopup(summaryPopupRef.current);
      summarySourceRef.current = null;
      return;
    }
    const { lat, lon } = clickSummary;

    const wrap = document.createElement("div");
    wrap.className = "click-popup";

    const head = document.createElement("div");
    head.className = "click-popup-head";
    head.textContent = `${shownMinutes} min ${
      PROFILE_TRIP[profile] ?? profile
    } · ${places.length.toLocaleString()} places within reach`;
    wrap.appendChild(head);

    if (groups.length) {
      const chips = document.createElement("div");
      chips.className = "chips click-popup-chips";
      for (const g of groups) {
        const n = places.reduce((c, pl) => c + (g.kinds.includes(pl.kind) ? 1 : 0), 0);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.disabled = !n;
        btn.setAttribute("aria-pressed", String(kindFilter === g.label));
        if (kindFilter === g.label) {
          btn.style.background = g.color;
          btn.style.borderColor = g.color;
          btn.style.color = "#fff";
        }
        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = g.icon;
        btn.append(icon, ` ${g.label}`);
        if (n > 0) {
          const nSpan = document.createElement("span");
          nSpan.className = "chip-n";
          nSpan.textContent = String(n);
          btn.appendChild(nSpan);
        }
        // Same kindFilter state the sidebar chips drive (see toggleKindFilter
        // above) — deliberately inlined, not called, see the comment above.
        btn.addEventListener("click", () => {
          const next = kindFilter === g.label ? null : g.label;
          setKindFilter(next);
          setVisible(60);
          const grp = groups.find((x) => x.label === next);
          drawPlacesRef.current(
            grp
              ? placesRef.current.filter((pl) => grp.kinds.includes(pl.kind))
              : placesRef.current
          );
        });
        chips.appendChild(btn);
      }
      wrap.appendChild(chips);
    }

    // A new click opens a popup. Anything else — chips, profile, places
    // arriving — only refreshes the one already open, and does nothing at all
    // if it is not: the user either dismissed it or is reading a different one,
    // and re-opening over that is how this effect used to discard both.
    if (clickSummary === summarySourceRef.current) {
      if (summaryOpenRef.current) summaryPopupRef.current?.setContent(wrap);
      return;
    }

    const popup = L.popup({ className: "click-popup-wrap", autoPan: false })
      .setLatLng([lat, lon])
      .setContent(wrap);
    // "remove" fires however it closes — the ×, Escape, or Leaflet swapping in
    // somebody else's popup — so the flag cannot drift from what is on screen.
    popup.on("remove", () => {
      if (summaryPopupRef.current === popup) summaryOpenRef.current = false;
    });
    summaryPopupRef.current = popup;
    summarySourceRef.current = clickSummary;
    summaryOpenRef.current = true;
    popup.openOn(map);
    // profile is in here because the heading names it; without it the popup
    // kept the wording from whichever profile was active when it opened.
  }, [clickSummary, places, groups, kindFilter, shownMinutes, profile]);

  return (
    <div className="app">
      <aside className={`panel${panelOpen ? " open" : ""}`} ref={panelRef}>
        <button
          className="sheet-handle"
          ref={sheetHandleRef}
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

          <div className="seg" role="group" aria-label="mobility profile" ref={mobilitySegRef}>
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

          {/* Only once bands are actually drawn — before the first click, or
              after a click that came back empty/offer/error, this legend
              would be answering a question nobody asked yet. */}
          {clickSummary && (
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
          )}

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
                    onClick={() => toggleKindFilter(g.label)}
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
                yet. They are still being fetched. Check back shortly.
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

          {/* T-031: Discover moved off the left panel onto its own right-edge
              rail (see the .rail CSS) — nested here, rather than as a sibling
              of <aside className="panel">, so a narrow viewport can fold it
              straight into the bottom sheet's own scroll flow as one more
              section instead of needing a second fixed panel that would not
              fit next to it. Known weakness of this design, being compared
              against two alternative layouts on separate branches. */}
          {/* No collapsed-state class: the rail's body is conditionally
              rendered below, so there is nothing for CSS to hide. */}
          <aside className="rail">
            <section className="suggest">
              <div className="places-head">
                <h2>Where should I live?</h2>
                <button
                  type="button"
                  className="rail-toggle"
                  aria-expanded={railOpen}
                  aria-label={railOpen ? "Collapse Discover" : "Expand Discover"}
                  onClick={() => setRailOpen((o) => !o)}
                >
                  {railOpen ? "−" : "+"}
                </button>
              </div>

              {railOpen && (
                <>
                  <p className="muted suggest-honesty">
                    Ranks reachability only. Not rent, not noise, not transit.
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
                          Could not reach the server. This is not a result, so try again.
                        </p>
                      )}

                      {suggestState === "ok" && suggestCells.length > 0 && (
                        <>
                          <p className="muted suggest-tie-note">
                            {/* "more dining" is meaningless without a referent, and
                                the wrong referent is worse than none: every result
                                here is a top-200 cell in the city, so a Berlin-wide
                                baseline would label all ten "dense in everything"
                                and just restate the selection criterion. */}
                            {suggestNoteText}
                          </p>
                          <ul className="place-list suggest-results">
                            {suggestCells.map((c, i) => {
                              const misses = suggestLayers.filter(
                                (layer) => c.layers[layer] == null
                              );
                              const reachable = suggestLayers.filter(
                                (layer) => c.layers[layer] != null
                              );
                              const maxSecs = reachable.length
                                ? Math.max(
                                    ...reachable.map((layer) => c.layers[layer] as number)
                                  )
                                : null;
                              const { more, less } = suggestCharacter[i];
                              return (
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
                                      {/* Hidden once every card would say the same
                                          thing — see suggestUniformReach above. */}
                                      {!suggestUniformReach &&
                                        (misses.length > 0 || maxSecs != null) && (
                                          <span className="pl-kind suggest-layers">
                                            {misses.map((layer) => (
                                              <span
                                                key={layer}
                                                className="suggest-layer suggest-miss"
                                              >
                                                {`no ${LAYER_LABEL[layer]} in 30 min`}
                                              </span>
                                            ))}
                                            {maxSecs != null && (
                                              <span className="suggest-layer">
                                                {`everything within ${reachLabel(maxSecs)}`}
                                              </span>
                                            )}
                                          </span>
                                        )}
                                      {/* The reach time is "<1′" on every layer of
                                          every result — the scoring gate already
                                          excluded anything slower, so it can't tell
                                          two results apart. What used to differentiate
                                          them was the raw nearby count, but T-019
                                          validated that count as a straight-line proxy
                                          for the graph-true reachable count and found it
                                          wanders 0.50-1.52x — useless for magnitude,
                                          though its rank order still correlates at 0.983
                                          Spearman. So printing it as a number invited a
                                          magnitude reading it can't support. This line
                                          says the same thing as an ordinal comparison
                                          instead — see character.ts. */}
                                      {/* areaCharacter needs at least 3 cells to build a
                                          comparison set; below that it skips every layer
                                          and more/less come back empty for a reason that
                                          has nothing to do with the results being flat.
                                          "an even mix" would assert a comparison that
                                          never happened, so below 3 say nothing. */}
                                      {suggestCells.length >= 3 && (
                                        // Each clause is its own flex item (row 1 above
                                        // does the same for misses/reach) so a wrap
                                        // breaks between clauses, not mid-clause or
                                        // straight after a now-deleted "·" separator.
                                        <span className="pl-kind suggest-layers suggest-character">
                                          {more.length === 0 && less.length === 0 ? (
                                            <span className="suggest-layer">an even mix</span>
                                          ) : (
                                            <>
                                              {more.length > 0 && (
                                                <span className="suggest-layer">
                                                  {`more ${more
                                                    .map((layer) => LAYER_LABEL[layer])
                                                    .join(" & ")}`}
                                                </span>
                                              )}
                                              {less.length > 0 && (
                                                <span className="suggest-layer">
                                                  {`less ${LAYER_LABEL[less[0]]}`}
                                                </span>
                                              )}
                                            </>
                                          )}
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      )}
                    </>
                  )}

                  {heatAvailable && (
                    <div className="ramp heat-ramp">
                      <div className="ramp-bar">
                        {HEAT_STOPS.map(([, c]) => (
                          <i key={c} style={{ background: c }} />
                        ))}
                      </div>
                      {/* Percentile rank always spreads the full ramp, even when the
                          real spread between the best and worst cell is tiny — same
                          honesty fix as the "alternatives, not a ranking" line
                          above. An absolute reading of these colours would be a lie. */}
                      <p className="muted heat-legend-note">
                        worse ← compared with the rest of Berlin → better
                      </p>
                    </div>
                  )}
                </>
              )}
            </section>
          </aside>

          {/* Demoted meta (T-031): evidence the importer works and the MCP
              install line, neither of which answers anything about the
              current click — collapsed by default, following HelpPanel's
              existing <details> convention. */}
          {recent.length > 0 && (
            <details className="recent">
              <summary>
                {recent.length} area{recent.length === 1 ? "" : "s"} added recently
              </summary>
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
            </details>
          )}

          <details className="panel-foot">
            <summary>Ask Claude about this map</summary>
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
          </details>
        </div>
      </aside>

      <div className="map-wrap">
        {/* T-031: the one shared loading signal — see loadingCount above.
            Indeterminate, so no aria-valuenow/min/max: their presence is what
            tells a screen reader this has a real percentage, which would be a
            lie here. role+aria-label alone is the correct indeterminate
            progressbar per WAI-ARIA. */}
        {loadingCount > 0 && (
          <div className="loading-bar" role="progressbar" aria-label="Loading" />
        )}
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
          onProfile={previewProfile}
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
          Ranks reachability only. Not rent, not noise, not transit.
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
