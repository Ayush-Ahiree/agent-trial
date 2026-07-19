import React, { useEffect, useState, useCallback, useMemo } from "react";
import { T, STATUS, TOOL_META, SOURCE_META, TAG_LABELS, humanReason, eventSeverity, IconChevron, IconAlert } from "./theme.jsx";
import { groupBySession, timeAgo } from "./sessionUtils.js";
import { useEventStream } from "./useEventStream.js";
import MiniPathGraph from "./MiniPathGraph.jsx";

/**
 * Chronological event feed -- the default AgentTrail view. Replaces the
 * force-graph as the primary UI: for a security-review workflow you want
 * to read "what happened, in order, and did anything need my attention"
 * at a glance, not decode node layout or raw policy-engine field names.
 *
 * Events are grouped into per-session incident cards: a single agent run
 * can fire many events in under a second (e.g. a prompt-injection attempt
 * that gets blocked 3 different ways), and a flat list makes that read as
 * noise instead of one story. Anything non-clean auto-expands.
 *
 * Also owns the pause/confirm back-channel: a `confirm_request` event
 * pins a banner with Approve/Deny buttons here. Clicking POSTs the
 * decision to the relay's /confirm-response endpoint, which the paused
 * tool call (tools.py's _web_confirm, polling /confirm-status) picks up.
 */

export default function EventFeed({ wsUrl = "ws://localhost:8765" }) {
  const { events, pending, connected, resolveConfirm } = useEventStream(wsUrl);
  const [expandedKey, setExpandedKey] = useState(null);
  const [sessionOverrides, setSessionOverrides] = useState({});
  const [, forceTick] = useState(0);

  const sessions = useMemo(() => groupBySession(events), [events]);

  // keep relative timestamps ("2m ago") fresh without needing a new event
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const toggleSession = useCallback((sessionId, currentEffective) => {
    setSessionOverrides((prev) => ({ ...prev, [sessionId]: !currentEffective }));
  }, []);

  const totals = useMemo(
    () => ({
      sessions: sessions.length,
      blocked: sessions.reduce((n, s) => n + s.blocked, 0),
      asked: sessions.reduce((n, s) => n + s.asked, 0),
      flagged: sessions.reduce((n, s) => n + s.flagged, 0),
    }),
    [sessions]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "hidden", fontFamily: T.font }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sessions.length ? 10 : 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.2 }}>Event Feed</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: T.inkMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? T.good : T.inkMuted, display: "inline-block" }} />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
        {sessions.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <StatTile label="Sessions" value={totals.sessions} />
            <StatTile label="Blocked" value={totals.blocked} color={totals.blocked ? T.critical : undefined} />
            <StatTile label="Needs Approval" value={totals.asked} color={totals.asked ? T.warning : undefined} />
            <StatTile label="Flagged" value={totals.flagged} color={totals.flagged ? T.serious : undefined} />
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div style={{ padding: 10, background: "rgba(250,178,25,0.08)", borderBottom: `1px solid ${T.warning}55` }}>
          {pending.map((item) => (
            <ConfirmBanner key={item.id} item={item} onResolve={resolveConfirm} />
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {events.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: 32, textAlign: "center" }}>
            Waiting for events — run the toy agent or trigger a Claude Code hook.
          </div>
        )}
        {sessions.map((session) => {
          const defaultExpanded = session.severity !== "clean";
          const effectiveExpanded = sessionOverrides.hasOwnProperty(session.sessionId)
            ? sessionOverrides[session.sessionId]
            : defaultExpanded;
          return (
            <SessionCard
              key={session.sessionId}
              session={session}
              expanded={effectiveExpanded}
              onToggle={() => toggleSession(session.sessionId, effectiveExpanded)}
              expandedEventKey={expandedKey}
              onToggleEvent={(key) => setExpandedKey(expandedKey === key ? null : key)}
            />
          );
        })}
      </div>
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div style={{ background: T.surfaceRaised, border: `1px solid ${T.border}`, borderRadius: 8, padding: "6px 12px", minWidth: 64 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.inkMuted, marginTop: 1 }}>{label}</div>
    </div>
  );
}

function ConfirmBanner({ item, onResolve }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", marginBottom: 6, background: T.surfaceRaised, borderRadius: 10, border: `1px solid ${T.warning}55` }}>
      <div style={{ fontSize: 12.5, minWidth: 0, display: "flex", gap: 10, alignItems: "flex-start" }}>
        <IconAlert size={16} color={T.warning} style={{ marginTop: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 600 }}>Confirmation needed — {TOOL_META[item.tool]?.label || item.tool}</div>
          <div style={{ opacity: 0.85, wordBreak: "break-all", marginTop: 2 }}>{item.target}</div>
          <div style={{ opacity: 0.6, marginTop: 2 }}>{(item.reasons || []).map(humanReason).join(", ")}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
        <PillButton label="Approve" color={T.good} onClick={() => onResolve(item, true)} />
        <PillButton label="Deny" color={T.critical} onClick={() => onResolve(item, false)} />
      </div>
    </div>
  );
}

function PillButton({ label, color, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? color : `${color}22`,
        color: hover ? "#0d0d0d" : color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "6px 14px",
        fontWeight: 600,
        fontSize: 12,
        cursor: "pointer",
        transition: "all 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

function SourceBadge({ source }) {
  const meta = SOURCE_META[source];
  const Icon = meta.Icon;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, background: T.surfaceRaised, border: `1px solid ${T.border}`, borderRadius: 999, padding: "2px 8px", fontSize: 10.5, color: T.inkSecondary, flexShrink: 0 }}>
      <Icon size={11} color={T.inkSecondary} />
      {meta.label}
    </div>
  );
}

function SessionCard({ session, expanded, onToggle, expandedEventKey, onToggleEvent }) {
  const status = STATUS[session.severity];
  const parts = [];
  if (session.blocked) parts.push(`${session.blocked} blocked`);
  if (session.asked) parts.push(`${session.asked} needs approval`);
  if (session.flagged) parts.push(`${session.flagged} flagged`);
  const summary = parts.length ? parts.join(" · ") : "All clean";

  const orderedEvents = [...session.events].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return (
    <div style={{ marginBottom: 8, borderRadius: 12, overflow: "hidden", border: `1px solid ${status.color}40`, background: T.surface, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>
      <div
        onClick={onToggle}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", cursor: "pointer", gap: 10, borderLeft: `3px solid ${status.color}` }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flex: 1 }}>
          <IconChevron expanded={expanded} size={13} color={T.inkMuted} />
          <status.Icon size={16} color={status.color} style={{ flexShrink: 0 }} />
          <SourceBadge source={session.source} />
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.headline}</div>
          <div style={{ fontSize: 12, color: T.inkSecondary, whiteSpace: "nowrap" }}>{summary}</div>
        </div>
        <div style={{ fontSize: 11, color: T.inkMuted, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
          {session.total} event{session.total !== 1 ? "s" : ""} · {timeAgo(session.lastTs)}
        </div>
      </div>
      {expanded && (
        <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${T.border}` }}>
          <div style={{ flex: "1 1 0%", minWidth: 0, padding: "4px 10px 10px" }}>
            {orderedEvents.map((event) => (
              <EventRow key={event._key} event={event} expanded={expandedEventKey === event._key} onToggle={() => onToggleEvent(event._key)} />
            ))}
          </div>
          <div style={{ flex: "0 0 300px", borderLeft: `1px solid ${T.border}`, padding: 10, background: T.page }}>
            <div style={{ fontSize: 10.5, color: T.inkMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>Path</div>
            <MiniPathGraph session={session} />
          </div>
        </div>
      )}
    </div>
  );
}

function EventRow({ event, expanded, onToggle }) {
  const severity = eventSeverity(event);
  const status = STATUS[severity];
  const time = event.ts ? new Date(event.ts * 1000).toLocaleTimeString() : "";
  const toolMeta = TOOL_META[event.tool];
  const ToolIcon = toolMeta?.Icon;

  let title, detailText;
  if (event.type === "tool_call") {
    title = `${toolMeta?.label || event.tool} — ${status.label}`;
    detailText = event.reasons && event.reasons.length ? event.reasons.map(humanReason).join(", ") : null;
  } else if (event.type === "taint_update") {
    title = `${toolMeta?.label || event.tool} — classified this data`;
    detailText = null;
  } else if (event.type === "confirm_resolution") {
    title = `${toolMeta?.label || event.tool} — ${event.decision === "allow" ? "Approved by user" : "Denied by user"}`;
    detailText = null;
  } else {
    title = event.type;
    detailText = null;
  }

  const visibleTags = (event.tags || event.new_tags || []).filter((t) => TAG_LABELS[t]);

  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        gap: 10,
        padding: "8px 8px",
        marginTop: 4,
        borderRadius: 8,
        background: expanded ? T.surfaceRaised : "transparent",
        cursor: "pointer",
        transition: "background 120ms ease",
      }}
    >
      {ToolIcon && <ToolIcon size={14} color={T.inkMuted} style={{ marginTop: 2, flexShrink: 0 }} />}
      <div style={{ opacity: 0.5, flexShrink: 0, width: 70, fontSize: 11, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{time}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</span>
          <StatusChip severity={severity} />
        </div>
        <div style={{ opacity: 0.7, wordBreak: "break-all", fontSize: 12, marginTop: 2 }}>{event.target}</div>
        {detailText && <div style={{ opacity: 0.55, marginTop: 2, fontSize: 11.5 }}>{detailText}</div>}
        {visibleTags.length > 0 && (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {visibleTags.map((t) => (
              <span key={t} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 999, background: T.surfaceRaised, border: `1px solid ${T.border}`, color: T.inkSecondary }}>
                {TAG_LABELS[t]}
              </span>
            ))}
          </div>
        )}

        {expanded && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
            <DetailRow label="session" value={event.session_id} />
            {event.risk_score !== undefined && <DetailRow label="risk score" value={event.risk_score} />}
            {event.source && <DetailRow label="source" value={event.source} />}
            <DetailRow label="timestamp" value={event.ts ? new Date(event.ts * 1000).toISOString() : ""} />
            <pre style={{ marginTop: 8, padding: 8, background: T.page, borderRadius: 6, overflowX: "auto", opacity: 0.8, fontSize: 11 }}>
              {JSON.stringify(stripInternal(event), null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ severity }) {
  const status = STATUS[severity];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, padding: "1px 7px 1px 5px", borderRadius: 999, background: `${status.color}1f`, color: status.color, fontWeight: 600 }}>
      <status.Icon size={10} color={status.color} />
      {status.label}
    </span>
  );
}

function DetailRow({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ opacity: 0.7, marginTop: 2, fontSize: 11.5 }}>
      <span style={{ opacity: 0.6 }}>{label}:</span> {String(value)}
    </div>
  );
}

function stripInternal(event) {
  const { _key, ...rest } = event;
  return rest;
}
