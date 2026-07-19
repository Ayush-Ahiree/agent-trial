import React from "react";

/**
 * Shared design tokens + icons + human-readable label maps, used by both
 * EventFeed.jsx and AgentTrail.jsx so the two tabs read as one system
 * instead of drifting apart. Status palette validated via the dataviz
 * skill's six-checks validator against the dark surface below; every
 * status pairs an icon with a label, never color alone.
 */

export const T = {
  page: "#0d0d0d",
  surface: "#1a1a19",
  surfaceRaised: "#212120",
  border: "rgba(255,255,255,0.10)",
  ink: "#ffffff",
  inkSecondary: "#c3c2b7",
  inkMuted: "#898781",
  gridline: "#2c2c2a",
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

export const STATUS = {
  clean: { color: T.good, label: "Allowed", Icon: IconCheck },
  flagged: { color: T.serious, label: "Flagged", Icon: IconFlag },
  warning: { color: T.warning, label: "Needs Approval", Icon: IconAlert },
  critical: { color: T.critical, label: "Blocked", Icon: IconX },
};

export const TOOL_META = {
  read_file: { label: "Read file", Icon: IconFile },
  write_file: { label: "Wrote file", Icon: IconFile },
  run_shell: { label: "Ran command", Icon: IconTerminal },
  call_api: { label: "Made network request", Icon: IconGlobe },
};

export const SOURCE_META = {
  claude_code: { label: "Claude Code", Icon: IconClaude },
  toy_agent: { label: "Toy Agent", Icon: IconBot },
};

export const TAG_LABELS = {
  pii: "Personal Info",
  secret: "Secret",
  internal_only: "Internal Only",
  user_uploaded: "User Uploaded",
  // "public" is intentionally omitted -- showing it teaches the user nothing
};

const REASON_LABELS = {
  dangerous_shell_pattern: "Matches a known dangerous command pattern",
  secret_data_exfil_attempt: "Would send previously-read secret data outside the system",
  pii_crossing_trust_boundary: "Would send personal information outside the system",
  internal_data_crossing_trust_boundary: "Would send internal-only data outside the system",
  external_destination_untainted: "New external destination — allowed, flagged for review",
};

export function humanReason(reason) {
  if (!reason) return null;
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith("path_denylist:shell_reference:")) {
    const frag = reason.split(":").slice(2).join(":");
    return `Command references a protected path (${frag})`;
  }
  if (reason.startsWith("path_denylist:")) {
    return `This path is protected (matches ${reason.slice("path_denylist:".length)})`;
  }
  return reason.replace(/_/g, " ");
}

export function eventSeverity(event) {
  if (event.decision === "block") return "critical";
  if (event.decision === "pending_confirm") return "warning";
  if (event.decision === "allow" && (event.risk_score || 0) > 0) return "flagged";
  return "clean";
}

// --- icons: small inline SVGs, 16x16 viewBox, explicit color prop (never
// currentColor-as-text-color) so they work as plain data ---

export function IconChevron({ expanded, size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease", flexShrink: 0 }}>
      <path d="M6 4l4 4-4 4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCheck({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconX({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconAlert({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M8 2.2l6.2 10.8H1.8L8 2.2z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <line x1="8" y1="6.5" x2="8" y2="9.3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.7" fill={color} />
    </svg>
  );
}

export function IconFlag({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 2v12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 2.6h7.5l-1.8 2.7 1.8 2.7H4" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFile({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 1.5h5l3 3v10h-8z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTerminal({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
      <path d="M4 6.2l2.4 1.9L4 10" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10" x2="11.5" y2="10" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconGlobe({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="1.8" y1="8" x2="14.2" y2="8" stroke={color} strokeWidth="1.3" />
    </svg>
  );
}

export function IconBot({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="8" y1="5.5" x2="8" y2="3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="2.2" r="0.9" fill={color} />
      <circle cx="6" cy="9" r="0.9" fill={color} />
      <circle cx="10" cy="9" r="0.9" fill={color} />
    </svg>
  );
}

export function IconClaude({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path
        d="M8 1.5l1.6 4.2 4.4.4-3.4 2.9 1.1 4.3L8 10.9l-3.7 2.4 1.1-4.3-3.4-2.9 4.4-.4z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
