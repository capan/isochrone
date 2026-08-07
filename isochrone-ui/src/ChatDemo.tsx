import { useEffect, useRef, useState } from "react";

// A scripted transcript, not a live chat — there is deliberately no input box,
// because pretending to be a model we do not host would be a lie.
//
// Every number below is real output captured from the deployed MCP server
// against production on 2026-08-07. If the API changes shape, re-capture it
// rather than editing the numbers by hand.
type Turn = { role: "user" | "tool" | "claude"; text: string };

const SCRIPT: Turn[] = [
  { role: "user", text: "How far can I walk from Alexanderplatz in 15 minutes?" },
  { role: "tool", text: "reachable_area" },
  {
    role: "claude",
    text:
      "15 min on foot reaches 96.4 km of streets, spanning 2.0 km N–S × 2.1 km E–W.\n" +
      "Within reach: 414 food, 284 shops, 200 culture, 166 outdoors, 51 money.",
  },
  { role: "user", text: "Any pharmacies in that?" },
  { role: "tool", text: "places_nearby" },
  {
    role: "claude",
    text:
      "8 pharmacies, nearest first:\n" +
      "· 3.1 min — Bezirksapotheke am Roten Rathaus\n" +
      "· 3.8 min — Panorama Apotheke\n" +
      "· 5.8 min — Alexa Apotheke",
  },
];

// One glyph at a time, ~4.5s for the whole exchange. Fast enough not to
// outstay its welcome, slow enough to read as it appears.
const CHUNK = 1;
const TICK_MS = 14;

// `active` is the parent <details> being open. The content of a closed
// <details> is still mounted, so without this the animation would play to
// completion in the background and be over before anyone opened the section.
export default function ChatDemo({ active }: { active: boolean }) {
  const [shown, setShown] = useState(0); // characters revealed across the script
  const [done, setDone] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const total = SCRIPT.reduce((n, t) => n + t.text.length, 0);

  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // start over each time the section is opened
  useEffect(() => {
    if (!active) {
      setShown(0);
      setDone(false);
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (reduced) {
      setShown(total);
      setDone(true);
      return;
    }
    if (done) return;
    const id = setInterval(() => {
      setShown((n) => {
        if (n >= total) {
          setDone(true);
          clearInterval(id);
          return n;
        }
        return n + CHUNK;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, done, reduced, total]);

  // keep the newest line in view while it types
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  // walk the script, handing each turn its share of the revealed characters
  let budget = shown;
  const rendered: { turn: Turn; text: string; typing: boolean }[] = [];
  for (const turn of SCRIPT) {
    if (budget <= 0) break;
    const text = turn.text.slice(0, budget);
    rendered.push({ turn, text, typing: budget < turn.text.length });
    budget -= turn.text.length;
  }

  return (
    <div>
      <div
        ref={boxRef}
        aria-label="Example conversation with an assistant using this map"
        style={{
          background: "#12161c",
          borderRadius: 6,
          padding: "10px 11px",
          maxHeight: 210,
          overflowY: "auto",
          font: "11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
          color: "#c9d1d9",
        }}
      >
        {rendered.map(({ turn, text, typing }, i) => {
          if (turn.role === "tool") {
            return (
              <div key={i} style={{ color: "#6e7681", margin: "5px 0 3px" }}>
                ⚙ called <span style={{ color: "#8b949e" }}>{text}</span>
                {typing && <Cursor />}
              </div>
            );
          }
          const user = turn.role === "user";
          return (
            <div
              key={i}
              style={{
                margin: user ? "7px 0 0" : "0 0 4px",
                color: user ? "#7ee787" : "#c9d1d9",
                whiteSpace: "pre-wrap",
              }}
            >
              {user && <span style={{ color: "#484f58" }}>› </span>}
              {text}
              {typing && <Cursor />}
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 5,
          fontSize: 10.5,
          color: "#9aa1a9",
        }}
      >
        <span>Real answers from the MCP server, replayed.</span>
        {done && (
          <button
            onClick={() => {
              setShown(0);
              setDone(false);
            }}
            style={{
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              color: "#2a63b5",
              font: "inherit",
              textDecoration: "underline",
            }}
          >
            replay
          </button>
        )}
      </div>
    </div>
  );
}

const Cursor = () => (
  <span
    style={{
      display: "inline-block",
      width: 6,
      height: 11,
      marginLeft: 1,
      verticalAlign: "-1px",
      background: "#c9d1d9",
    }}
    className="chat-cursor"
  />
);
