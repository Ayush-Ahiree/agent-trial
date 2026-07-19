/**
 * Shared session-grouping logic used by both EventFeed.jsx (incident
 * cards) and AgentTrail.jsx (path graph), so "what counts as a session,
 * what's its headline, what's its source" stays identical across tabs
 * instead of two components quietly disagreeing with each other.
 */

export function sessionSource(events) {
  return events.some((e) => e.source === "claude_code") ? "claude_code" : "toy_agent";
}

export function deriveHeadline(events) {
  const first = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0)).find((e) => e.type === "tool_call");
  if (!first || !first.target) return "session";
  if (first.tool === "call_api") {
    try {
      return new URL(first.target).hostname;
    } catch {
      return first.target;
    }
  }
  const parts = first.target.split("/");
  return parts[parts.length - 1] || first.target;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function groupBySession(events) {
  const bySession = new Map();
  for (const e of events) {
    const sid = e.session_id || "unknown";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(e);
  }
  const sessions = Array.from(bySession.entries()).map(([sessionId, evts]) => {
    const blocked = evts.filter((e) => e.decision === "block").length;
    const asked = evts.filter((e) => e.decision === "pending_confirm").length;
    const flagged = evts.filter((e) => e.decision === "allow" && (e.risk_score || 0) > 0).length;
    let severity = "clean";
    if (blocked > 0) severity = "critical";
    else if (asked > 0) severity = "warning";
    else if (flagged > 0) severity = "flagged";
    return {
      sessionId,
      events: evts,
      blocked,
      asked,
      flagged,
      severity,
      source: sessionSource(evts),
      headline: deriveHeadline(evts),
      total: evts.length,
      lastTs: Math.max(...evts.map((e) => e.ts || 0)),
    };
  });
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return sessions;
}

// Stable per-event identity (not Math.random()): needed so a page refresh
// (restored from localStorage) and the relay's replay-on-connect buffer
// don't produce two copies of the same event when both land at once.
export function eventIdentity(event) {
  return `${event.ts}|${event.type}|${event.tool}|${event.target}`;
}
