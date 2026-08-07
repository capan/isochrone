import { useEffect, useRef, useState } from "react";
import ChatDemo from "./ChatDemo";

// Onboarding, in the app rather than the README: nothing on the map tells a
// first-time visitor that the dark region is data they can ask for.
//
// Only the three steps and the legend are open by default. The background and
// the caveats are real, but a first visitor needs to know what to click, and
// a panel that needs scrolling to reach the point does not get read.
const RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];

const Row = ({
  swatch,
  children,
}: {
  swatch: React.CSSProperties;
  children: React.ReactNode;
}) => (
  <li style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
    <span
      style={{
        display: "inline-block",
        width: 20,
        height: 10,
        marginRight: 8,
        flex: "none",
        ...swatch,
      }}
    />
    <span>{children}</span>
  </li>
);

const Section = ({
  title,
  children,
  onToggle,
  defaultOpen,
}: {
  title: string;
  children: React.ReactNode;
  onToggle?: (open: boolean) => void;
  defaultOpen?: boolean;
}) => {
  const ref = useRef<HTMLDetailsElement | null>(null);
  // A section opened by a deep link is usually below the fold.
  useEffect(() => {
    if (defaultOpen) ref.current?.scrollIntoView({ block: "nearest" });
  }, [defaultOpen]);
  return (
  <details
    ref={ref}
    open={defaultOpen}
    style={{ borderTop: "1px solid #eceef1", padding: "8px 0 0" }}
    onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}
  >
    <summary
      style={{
        cursor: "pointer",
        font: "600 13px system-ui",
        color: "#33383d",
        marginBottom: 6,
      }}
    >
      {title}
    </summary>
    <div style={{ color: "#5b6470", paddingBottom: 6 }}>{children}</div>
  </details>
  );
};

export default function HelpPanel({
  onClose,
  focus,
}: {
  onClose: () => void;
  focus?: "assistant";
}) {
  // Opened from "see what you can ask": expand that section and let the
  // transcript start immediately, rather than making people hunt for it.
  const [assistantOpen, setAssistantOpen] = useState(focus === "assistant");
  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 2000,
        background: "rgba(8,12,18,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="How this map works"
        style={{
          background: "#fff",
          color: "#23282d",
          borderRadius: 10,
          maxWidth: 460,
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "18px 20px 20px",
          font: "13px/1.45 system-ui",
          boxShadow: "0 8px 30px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, font: "600 16px system-ui" }}>
            How this map works
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              font: "18px system-ui",
              cursor: "pointer",
              color: "#9aa1a9",
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>

        <ol style={{ margin: "0 0 14px", paddingLeft: 18 }}>
          <li style={{ marginBottom: 5 }}>
            Click the lit part of the map to see what you can reach from there.
          </li>
          <li style={{ marginBottom: 5 }}>
            Switch profile, top right. Steps block strollers and wheelchairs.
            Cycle paths are used only by the bike.
          </li>
          <li>
            Dark areas have no data yet. Click one to import it, about 5×5 km
            and usually under a minute.
          </li>
        </ol>

        <ul style={{ margin: "0 0 14px", padding: 0, listStyle: "none" }}>
          <Row
            swatch={{ background: `linear-gradient(90deg, ${RAMP.join(",")})` }}
          >
            arrival time, light is sooner
          </Row>
          <Row swatch={{ background: "rgba(11,22,34,0.18)" }}>not imported</Row>
          <Row swatch={{ border: "2px solid #7c4dff" }}>you requested it</Row>
          <Row swatch={{ border: "2px dashed #e08c00" }}>importing now</Row>
        </ul>

        <Section title="How it works">
          <p style={{ margin: "0 0 8px" }}>
            OpenStreetMap data sits in PostGIS as a routing graph. Each request
            starts at the vertex nearest your click and walks outwards until
            the time limit runs out, returning every street it reaches with its
            arrival time.
          </p>
          <p style={{ margin: 0 }}>
            The streets themselves are drawn. A shape wrapped around them would
            suggest you can cross the middle of a block, a river or a rail
            yard.
          </p>
        </Section>

        <Section title="Limits and caveats">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li style={{ marginBottom: 4 }}>
              Stroller and wheelchair speeds are estimates. Differences between
              profiles are more reliable than the exact minutes.
            </li>
            <li style={{ marginBottom: 4 }}>
              The bike ignores one-way streets. The data does not record where
              contraflow cycling is allowed, and in Berlin it usually is.
            </li>
            <li style={{ marginBottom: 4 }}>
              Each profile has its own time limit, because a bike covers more
              ground per minute and the work grows with the area searched.
            </li>
            <li>
              Imported areas are cached, and the least recently used are
              dropped if disk runs short. They can be imported again.
            </li>
          </ul>
        </Section>

        <Section
          title="Ask an AI assistant"
          onToggle={setAssistantOpen}
          defaultOpen={focus === "assistant"}
        >
          {/* The install command alone tells a visitor nothing about what the
              server does. The questions are the feature; the command is how
              you get it. */}
          <p style={{ margin: "0 0 8px" }}>
            An MCP server lets Claude answer questions about this map in words:
          </p>
          <ChatDemo active={assistantOpen} />
          <p style={{ margin: "9px 0 6px" }}>
            It reads the same data as this map, and links back to it:
          </p>

          <code
            style={{
              display: "block",
              userSelect: "all",
              background: "#f3f4f6",
              color: "#33383d",
              padding: "6px 8px",
              borderRadius: 4,
              font: "11px ui-monospace, monospace",
            }}
          >
            claude mcp add isochrone -- npx -y isochrone-mcp
          </code>
        </Section>

        <p
          style={{
            margin: "12px 0 0",
            color: "#9aa1a9",
            fontSize: 11,
            borderTop: "1px solid #eceef1",
            paddingTop: 8,
          }}
        >
          Data © OpenStreetMap contributors ·{" "}
          <a
            href="https://github.com/capan/isochrone"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#6b7280" }}
          >
            source
          </a>
        </p>
      </div>
    </div>
  );
}
