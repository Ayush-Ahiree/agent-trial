import React, { useMemo, useState } from "react";
import { T, STATUS, TAG_LABELS, humanReason } from "./theme.jsx";
import { buildTrail, layoutSerpentine } from "./pathLayout.js";

const START_COLOR = T.coolInk;
const WIDTH = 300;

/**
 * Lightweight SVG path view embedded in an expanded Feed session card --
 * same serpentine layout as the full Graph tab, but plain SVG (no
 * react-force-graph instance) since several of these can be mounted at
 * once if more than one card is expanded.
 */
export default function MiniPathGraph({ session }) {
  const [selected, setSelected] = useState(null);

  const { nodes, links } = useMemo(() => {
    const trail = buildTrail(session);
    layoutSerpentine(trail.nodes, WIDTH, { colSpacing: 54, rowSpacing: 46 });
    return trail;
  }, [session]);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  const bounds = useMemo(() => {
    const xs = nodes.map((n) => n.fx);
    const ys = nodes.map((n) => n.fy);
    const pad = 24;
    return {
      minX: Math.min(...xs) - pad,
      minY: Math.min(...ys) - pad,
      maxX: Math.max(...xs) + pad,
      maxY: Math.max(...ys) + pad,
    };
  }, [nodes]);

  const vbWidth = bounds.maxX - bounds.minX;
  const vbHeight = bounds.maxY - bounds.minY;

  if (nodes.length <= 1) {
    return <div style={{ fontSize: 11, color: T.inkMuted, padding: 8 }}>No steps yet.</div>;
  }

  return (
    <div>
      <svg
        width="100%"
        height={Math.min(220, Math.max(90, vbHeight))}
        viewBox={`${bounds.minX} ${bounds.minY} ${vbWidth} ${vbHeight}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {links.map((l, i) => {
          const s = byId[l.source];
          const t = byId[l.target];
          return <line key={i} x1={s.fx} y1={s.fy} x2={t.fx} y2={t.fy} stroke="rgba(23,20,14,0.2)" strokeWidth={1.5} />;
        })}
        {nodes.map((n) => {
          const isStart = n.isStart;
          const color = isStart ? START_COLOR : STATUS[n.severity].color;
          const r = isStart ? 7 : 8;
          const isSelected = selected && selected.id === n.id;
          return (
            <g key={n.id} onClick={() => (n.event ? setSelected(n) : null)} style={{ cursor: n.event ? "pointer" : "default" }}>
              {!isStart && n.severity === "critical" && <circle cx={n.fx} cy={n.fy} r={r + 4} fill="none" stroke={T.critical} strokeWidth={1.5} />}
              {isSelected && <circle cx={n.fx} cy={n.fy} r={r + 3} fill="none" stroke={T.ink} strokeWidth={1.2} />}
              <circle cx={n.fx} cy={n.fy} r={r} fill={color} />
              {!isStart && (
                <text x={n.fx} y={n.fy + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={8} fontWeight={700} fill={T.onAccent}>
                  {n.step}
                </text>
              )}
              <title>{isStart ? n.label : `${n.label} — ${STATUS[n.severity].label}`}</title>
            </g>
          );
        })}
      </svg>
      {selected && selected.event && <MiniDetail event={selected.event} step={selected.step} />}
    </div>
  );
}

function MiniDetail({ event, step }) {
  const status = STATUS[event.decision === "block" ? "critical" : event.decision === "pending_confirm" ? "warning" : (event.risk_score || 0) > 0 ? "flagged" : "clean"];
  const visibleTags = (event.tags || []).filter((t) => TAG_LABELS[t]);
  return (
    <div style={{ marginTop: 6, padding: 8, background: T.page, borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ color: T.inkMuted }}>Step {step}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, padding: "1px 6px 1px 4px", borderRadius: 999, background: `${status.color}1f`, color: status.color, fontWeight: 600 }}>
          <status.Icon size={9} color={status.color} />
          {status.label}
        </span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{event.tool}</div>
      <div style={{ opacity: 0.75, wordBreak: "break-all", marginBottom: 4 }}>{event.target}</div>
      {event.reasons && event.reasons.length > 0 && <div style={{ opacity: 0.6 }}>{event.reasons.map(humanReason).join(", ")}</div>}
      {visibleTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          {visibleTags.map((t) => (
            <span key={t} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 999, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
              {TAG_LABELS[t]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
