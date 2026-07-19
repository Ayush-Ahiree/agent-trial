import React, { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { T, STATUS, TAG_LABELS, humanReason, eventSeverity } from "./theme.jsx";
import { groupBySession, timeAgo } from "./sessionUtils.js";
import { useEventStream } from "./useEventStream.js";
import { buildTrail, layoutSerpentine } from "./pathLayout.js";

/**
 * Live path-tracing view. This used to be a hub-and-spoke star (every
 * action linked straight back to one center "AGENT" node) -- that's not
 * a path, it's just "everything touched," with no way to tell what
 * happened after what. Now each session is an actual chain: step 1 -> 2
 * -> 3 in call order, so you can ask Claude Code to "fix the taskbar
 * issue" and watch the trail extend live, file by file, tool by tool,
 * until it's done.
 *
 * A straight line (top-down or left-right) runs off the edge of the
 * view once a session racks up more than a handful of steps, so
 * positions are laid out in a serpentine ("S"/boustrophedon) grid sized
 * to the actual container width instead (see pathLayout.js) -- long
 * sessions wrap back and forth and stay in frame.
 *
 * Defaults to auto-following the most recently active session (so a
 * brand-new task takes over the view the moment it starts); clicking an
 * older session in the sidebar pins the view there until you click
 * "Follow live" again.
 */

const START_COLOR = T.coolInk;

export default function AgentTrail({ wsUrl = "ws://localhost:8765" }) {
  const { events, connected } = useEventStream(wsUrl);
  const [pinnedSession, setPinnedSession] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const fgRef = useRef();
  const wrapRef = useRef();
  const [size, setSize] = useState({ width: 0, height: 0 });

  const sessions = useMemo(() => groupBySession(events), [events]);
  const activeSessionId = pinnedSession || (sessions[0] && sessions[0].sessionId);
  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) || null;
  const following = !pinnedSession;

  const { nodes, links } = useMemo(() => {
    const trail = buildTrail(activeSession);
    layoutSerpentine(trail.nodes, size.width || 900, { colSpacing: 110, rowSpacing: 90 });
    return trail;
  }, [activeSession, size.width]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // keep the whole trail in frame as it grows
  useEffect(() => {
    if (fgRef.current && nodes.length > 1) {
      const t = setTimeout(() => fgRef.current.zoomToFit(400, 40), 250);
      return () => clearTimeout(t);
    }
  }, [nodes.length, size.width]);

  // deselect a node that no longer exists (switched session)
  useEffect(() => {
    if (selectedNode && !nodes.some((n) => n.id === selectedNode.id)) setSelectedNode(null);
  }, [nodes, selectedNode]);

  const nodeCanvasObject = (node, ctx, globalScale) => {
    const isStart = node.id === "start";
    const color = isStart ? START_COLOR : STATUS[node.severity].color;
    const radius = isStart ? 8 : 9;
    const isSelected = selectedNode && selectedNode.id === node.id;

    if (!isStart && node.severity === "critical") {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 5, 0, 2 * Math.PI);
      ctx.strokeStyle = T.critical;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    if (!isStart) {
      ctx.fillStyle = T.onAccent;
      ctx.font = `700 ${9 / globalScale}px ${T.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(node.step), node.x, node.y + 0.5);
    }

    const fontSize = 10.5 / globalScale;
    ctx.font = `${fontSize}px ${T.font}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = T.inkSecondary;
    ctx.fillText(node.label, node.x + radius + 5, node.y);
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "hidden", fontFamily: T.font }}>
      <div ref={wrapRef} style={{ flex: "2 1 0%", minWidth: 0, position: "relative", overflow: "hidden" }}>
        {nodes.length <= 1 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: T.inkMuted, textAlign: "center", padding: 20 }}>
            Waiting for a session to trace — ask Claude Code to do something, or run the toy agent.
          </div>
        )}
        <ForceGraph2D
          ref={fgRef}
          width={size.width || undefined}
          height={size.height || undefined}
          graphData={{ nodes, links }}
          nodeCanvasObject={nodeCanvasObject}
          nodeLabel={() => ""}
          linkColor={() => "rgba(23,20,14,0.18)"}
          linkWidth={1.5}
          linkDirectionalParticles={2}
          linkDirectionalParticleWidth={2.5}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleColor={(link) => {
            const t = link.target;
            const severity = typeof t === "object" ? t.severity : null;
            return severity ? STATUS[severity].color : T.good;
          }}
          onNodeClick={(node) => (node.event ? setSelectedNode(node) : setSelectedNode(null))}
          backgroundColor={T.page}
          cooldownTicks={100}
        />
      </div>

      <div style={{ flex: "1 0 300px", minWidth: 0, maxWidth: 360, borderLeft: `1px solid ${T.border}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 500, fontFamily: T.fontSerif }}>Live Path</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.inkMuted }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? T.good : T.inkMuted, display: "inline-block" }} />
              {connected ? "Connected" : "Disconnected"}
            </div>
          </div>
          {!following && (
            <button
              onClick={() => setPinnedSession(null)}
              style={{ marginTop: 8, fontSize: 11, background: `${T.good}22`, color: T.good, border: `1px solid ${T.good}`, borderRadius: 999, padding: "4px 10px", cursor: "pointer" }}
            >
              ● Follow live session
            </button>
          )}
        </div>

        <div style={{ padding: 10, borderBottom: `1px solid ${T.border}`, maxHeight: 220, overflowY: "auto" }}>
          <div style={{ fontSize: 11, color: T.inkMuted, marginBottom: 6 }}>Sessions</div>
          {sessions.length === 0 && <div style={{ fontSize: 12, opacity: 0.5 }}>No sessions yet.</div>}
          {sessions.map((s, i) => (
            <SessionPill
              key={s.sessionId}
              session={s}
              active={s.sessionId === activeSessionId}
              isLive={i === 0 && following}
              onClick={() => setPinnedSession(i === 0 ? null : s.sessionId)}
            />
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {selectedNode && selectedNode.event ? (
            <NodeDetail event={selectedNode.event} step={selectedNode.step} />
          ) : (
            <div style={{ fontSize: 12, opacity: 0.5, textAlign: "center", marginTop: 20 }}>Click a step in the path for details.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionPill({ session, active, isLive, onClick }) {
  const status = STATUS[session.severity];
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 8px",
        marginBottom: 4,
        borderRadius: 8,
        background: active ? T.surfaceRaised : "transparent",
        border: `1px solid ${active ? status.color + "55" : "transparent"}`,
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: status.color, flexShrink: 0 }} />
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.headline}</span>
      </div>
      {isLive && (
        <span style={{ fontSize: 9, color: T.good, fontWeight: 700, flexShrink: 0, letterSpacing: 0.3 }}>● LIVE</span>
      )}
    </div>
  );
}

function NodeDetail({ event, step }) {
  const status = STATUS[eventSeverity(event)];
  const visibleTags = (event.tags || []).filter((t) => TAG_LABELS[t]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: T.inkMuted }}>Step {step}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, padding: "1px 7px 1px 5px", borderRadius: 999, background: `${status.color}1f`, color: status.color, fontWeight: 600 }}>
          <status.Icon size={10} color={status.color} />
          {status.label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{event.tool}</div>
      <div style={{ fontSize: 12, opacity: 0.8, wordBreak: "break-all", marginBottom: 8 }}>{event.target}</div>
      {event.reasons && event.reasons.length > 0 && (
        <div style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 8 }}>{event.reasons.map(humanReason).join(", ")}</div>
      )}
      {visibleTags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {visibleTags.map((t) => (
            <span key={t} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
              {TAG_LABELS[t]}
            </span>
          ))}
        </div>
      )}
      {event.risk_score !== undefined && (
        <div style={{ fontSize: 11, opacity: 0.6 }}>risk score: {event.risk_score}</div>
      )}
      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>{timeAgo(event.ts)}</div>
    </div>
  );
}
