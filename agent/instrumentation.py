"""
AgentTrail - Instrumentation Middleware

Wraps every tool call in an OTel span, tags/propagates taint via span
attributes (baggage-style manual propagation kept simple for hackathon
reliability), runs the policy engine, and mirrors each event to the
Agent Trail live panel via a WebSocket broadcaster.

Design choice: rather than reading spans back OUT of SigNoz for the live
panel (adds a dependency on SigNoz query latency during the demo), we
mirror events to the frontend at EMIT time. SigNoz remains the system of
record for dashboards/alerts; the panel is a live tap on the same stream.
"""

import threading
import time
import uuid
import json
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode, NonRecordingSpan, set_span_in_context, SpanKind

from policy import classify_content, evaluate_call, Decision, PolicyResult, Tag

tracer = trace.get_tracer("agent-guardian")

# Session-level taint state: which tags are "in scope" for the current
# agent run, accumulated as tools produce tagged output. Simple dict
# instead of a general dataflow graph -> fast to build, good enough to demo.
class TaintContext:
    def __init__(self, session_id: str = None):
        self.session_id = session_id or str(uuid.uuid4())
        self.active_tags = set()  # tags currently "carried" by the agent's working memory
        self.history = []
        self.root_span_context = None  # lazily created -- see _session_parent_context

    def absorb(self, tags: set):
        self.active_tags |= tags

    def snapshot(self):
        return sorted(t.value if hasattr(t, "value") else t for t in self.active_tags)


def _session_parent_context(ctx: "TaintContext"):
    """Every span for a session -- tool-call decisions AND taint-tagging
    events -- shares one trace_id, so opening ANY ONE span in SigNoz's
    Trace Explorer shows the WHOLE session as a real parent/child
    waterfall instead of an unordered flat list of independent
    one-span traces (which is what this looked like before: every tool
    call got its own random trace_id, so "see everything for this
    session" meant manually filtering+sorting a list, and taint events
    had no span at all).

    A Claude Code session spans many independent HTTP requests to
    hook_server.py (a new thread per request, no shared call stack), so
    this can't rely on OTel's ambient current-span context the way
    normal nested calls do -- each span's parent is set explicitly from
    a stored SpanContext instead. The root span is created once per
    session and ended immediately: it's a trace-ID anchor, not a
    meaningful duration (a session doesn't have a clean "done" moment we
    could hook to end it later, and the SDK's BatchSpanProcessor only
    exports a span once it ends)."""
    if ctx.root_span_context is None:
        # Fixed name, not f"session:{ctx.session_id}" -- embedding the
        # unique session id in the SPAN NAME (rather than just the
        # session.id ATTRIBUTE, which was already set) makes every
        # session its own distinct "operation name" from SigNoz's
        # perspective. That's unbounded cardinality: found by actually
        # re-checking the Services page after the fix and seeing
        # "overflow_operation" persist -- each new session was creating
        # a brand new top-level op name forever, hitting whatever cap
        # SigNoz has on distinct root operations, same failure mode as
        # before the fix, just reintroduced a different way.
        root_span = tracer.start_span("session", kind=SpanKind.SERVER)
        root_span.set_attribute("session.id", ctx.session_id)
        ctx.root_span_context = root_span.get_span_context()
        root_span.end()
    return set_span_in_context(NonRecordingSpan(ctx.root_span_context))


# The toy agent is one short-lived process per run, so a single module-level
# context is correct for it. hook_server.py is a long-running process that
# serves MANY distinct Claude Code sessions over its lifetime, so it can't
# share this one singleton -- doing so would merge unrelated sessions into
# the same incident card and leak taint tags between them (session A reads
# a secret, unrelated session B inherits the tag and gets blocked for no
# reason). _session_contexts keys a separate TaintContext per Claude Code
# session_id; get_taint_context(None) returns the toy agent's singleton.
taint_ctx = TaintContext()
_session_contexts = {}
_session_contexts_lock = threading.Lock()


def get_taint_context(session_id: str = None) -> TaintContext:
    if not session_id:
        return taint_ctx
    with _session_contexts_lock:
        if session_id not in _session_contexts:
            _session_contexts[session_id] = TaintContext(session_id=session_id)
        return _session_contexts[session_id]


RELAY_INGEST_URL = "http://localhost:8766/event"


def broadcast(event: dict):
    """Send an event to the Agent Trail panel via the relay's HTTP ingest
    endpoint. The relay runs as a SEPARATE process, so this must go over
    the network (HTTP), not a direct Python import/function call — module
    state isn't shared across processes."""
    try:
        import urllib.request
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            RELAY_INGEST_URL, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # relay not running; instrumentation still works standalone


@contextmanager
def traced_tool_call(tool_name: str, target: str, params: dict):
    """Use as: with traced_tool_call("call_api", url, {...}) as ctx: ... 
    ctx.decision tells the caller whether to actually execute the tool."""

    start = time.time()
    policy_result = evaluate_call(tool_name, target, params, taint_ctx.active_tags)

    with tracer.start_as_current_span(f"tool.{tool_name}", context=_session_parent_context(taint_ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(taint_ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", taint_ctx.session_id)
        span.set_attribute("source", "toy_agent")

        event = {
            "type": "tool_call",
            "session_id": taint_ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": taint_ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "ts": start,
        }
        broadcast(event)

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        class Ctx:
            decision = policy_result.decision
            reasons = policy_result.reasons

        yield Ctx()

        span.set_attribute("duration_ms", int((time.time() - start) * 1000))


def precheck(tool_name: str, target: str, params: dict, override_reason: str = None, session_id: str = None) -> PolicyResult:
    """Decision + telemetry only, no execution — for callers that don't run
    the tool themselves (the Claude Code PreToolUse hook adapter: Claude
    Code executes the tool after we hand back allow/deny/ask, we never
    touch the filesystem/shell/network here).

    override_reason: short-circuits straight to BLOCK (used for the hard
    path denylist in policy.check_path_denylist, which applies regardless
    of taint state and shouldn't wait on evaluate_call's taint-based rules).

    session_id: Claude Code's own session id. hook_server.py is one
    long-running process serving many distinct Claude Code sessions, so
    each needs its own isolated TaintContext (see get_taint_context) --
    without this, an unrelated session could inherit another session's
    taint tags, or two sessions would render as one merged incident card.
    """
    ctx = get_taint_context(session_id)

    if override_reason:
        policy_result = PolicyResult(Decision.BLOCK, 100, [override_reason])
    else:
        policy_result = evaluate_call(tool_name, target, params, ctx.active_tags)

    with tracer.start_as_current_span(f"tool.{tool_name}", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", ctx.session_id)
        span.set_attribute("source", "claude_code_hook")

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        broadcast({
            "type": "tool_call",
            "session_id": ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "ts": time.time(),
            "source": "claude_code",
        })

    return policy_result


def record_confirm_resolution(tool_name: str, target: str, approved: bool, session_id: str = None):
    """A pending_confirm decision doesn't end at evaluate_call() anymore --
    a human resolves it. Broadcast the actual outcome so the panel/
    telemetry stream reflects what really happened, not just the
    pre-human-input pause. Also a real span, linked into the session's
    trace like everything else."""
    ctx = get_taint_context(session_id)

    with tracer.start_as_current_span("confirm.resolution", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("approved", approved)
        span.set_attribute("session.id", ctx.session_id)

    broadcast({
        "type": "confirm_resolution",
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "decision": "allow" if approved else "block",
        "ts": time.time(),
    })


def web_confirm(tool_name: str, target: str, reasons: list, session_id: str = None, timeout: float = 110.0):
    """Broadcast a confirm_request (the panel shows Approve/Deny buttons)
    and poll the relay for a decision. Shared by tools.py's toy-agent
    confirm flow and hook_server.py's Claude Code PENDING_CONFIRM path --
    same mechanism, same panel, either front-end.

    Returns True/False if a human resolved it via the panel, or None if
    the timeout elapsed with the relay still reachable (caller should
    default-deny -- fail safe, not fail open). Raises ConnectionError if
    the relay itself was never reachable at all, so each caller can use
    its own non-panel fallback (tools.py's CLI prompt, Claude Code's own
    native "ask" dialog).
    """
    import urllib.error
    import urllib.request
    import uuid

    ctx = get_taint_context(session_id)
    confirm_id = str(uuid.uuid4())
    broadcast({
        "type": "confirm_request",
        "id": confirm_id,
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "reasons": reasons,
        "ts": time.time(),
    })

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://localhost:8766/confirm-status?id={confirm_id}", timeout=3) as resp:
                data = json.loads(resp.read())
        except (urllib.error.URLError, OSError) as e:
            raise ConnectionError("relay unreachable") from e
        if data.get("resolved"):
            return bool(data.get("approved"))
        time.sleep(1)
    return None  # genuine timeout -- relay was reachable, nobody answered


def record_tool_output(tool_name: str, target: str, output_text: str, source_hint: str = "", session_id: str = None):
    """Call after a tool executes successfully: classify the OUTPUT and
    absorb any new taint tags into the session context so downstream
    tool calls inherit them (this is the propagation step).

    session_id: see precheck() -- this is the function that actually
    absorbs taint, so it's the one that most needs per-session isolation
    (otherwise one Claude Code session's secret read taints every other
    session hitting the same hook_server.py process).

    This used to be invisible to SigNoz entirely -- classify_content()
    ran, taint got absorbed, but no span was ever created, so "data
    entered the agent and got tagged PII" (literally the PRD's G2) never
    showed up anywhere but our own WebSocket stream. Now it's a real
    span, linked into the same per-session trace as the tool-call spans."""
    ctx = get_taint_context(session_id)
    result = classify_content(output_text, source_hint=source_hint)

    with tracer.start_as_current_span("taint.classify", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("new_tags", ",".join(t.value for t in result.tags if t != Tag.PUBLIC))
        span.set_attribute("session.id", ctx.session_id)

    ctx.absorb(result.tags)

    broadcast({
        "type": "taint_update",
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "new_tags": [t.value for t in result.tags if t != Tag.PUBLIC],
        "ts": time.time(),
    })
    return result
