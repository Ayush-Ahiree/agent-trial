# AgentTrail — MVP Skeleton

Matches PRD Section 9 ("Must-have" build order). This gets you an
end-to-end path: agent loop → instrumented tool calls → taint tagging →
policy engine → SigNoz + live Agent Trail panel.

## Quickstart: connect Claude Code to a running panel

One-time setup (starts the backend the panel/hooks talk to):

```bash
cd agent && pip install -r requirements.txt && python cli.py start
cd ../frontend && npm install && npm start
```

Open the panel — it lands on the **Connect** tab first, which shows a
live up/down check of the relay and hook server plus a single generated
command. Paste that command into a terminal in (or pointing at) the
project you want observed:

```bash
curl -s http://localhost:8090/connect.sh | bash -s -- /path/to/your/project
```

That fetches the connect step fresh from the running backend (so it
always has the right hook URLs baked in — `hook_server.py`'s
`/connect.sh` route, which just execs `cli.py connect` under the hood)
and merges the two required hook blocks into that project's
`.claude/settings.json` — it won't touch other hooks already configured
there, and it no-ops if run again on an already-wired project. Restart
Claude Code in that project afterward (hooks load at session start, not
mid-session) and its tool calls show up live on the Feed tab.

Prefer the terminal over clicking through the panel? `python cli.py
connect /path/to/your/project` does the same merge directly, and
`python cli.py status` / `stop` check / tear down the backend.

SigNoz itself is optional for this flow — the relay and hook server work
standalone (see the SigNoz section below for the full trace-export setup).

## Hosted mode (multi-tenant, no local backend)

Everything above is the local self-host path — you run the backend, you
own the process. There's a second path for a hosted, multi-tenant
deployment with real accounts: `agent/main.py` (FastAPI, Postgres via
Supabase, one project = one API key) instead of `hook_server.py` +
`ws_relay.py`, and the [`agenttrail` npm CLI](cli/) instead of
`cli.py connect` / the `curl | bash` script.

Once a dashboard is deployed and you're logged in, connecting a project
is:

```bash
npx agenttrail login --key <api-key-from-the-dashboard> --api-base https://api.your-domain.example
npx agenttrail connect
```

That writes the hook config *and* the API key into
`.claude/settings.local.json` (gitignored by Claude Code automatically —
the key never reaches git), pointing at the hosted API instead of
localhost.

To stand the hosted backend up yourself:

1. Create a free [Supabase](https://supabase.com) project, run
   `agent/migrations/001_init.sql` against it (SQL editor or `supabase db
   push`), and copy `agent/.env.example` → `.env`, filling in
   `DATABASE_URL` and `SUPABASE_JWT_SECRET` from the project's settings.
2. `cd agent && pip install -r requirements.txt && uvicorn main:app
   --reload` to run it locally, or `flyctl launch` / `flyctl deploy`
   (see `agent/fly.toml`) to put it on Fly.io.
3. Deploy `frontend/` (Vite) to Vercel — see the root `vercel.json` — with
   `VITE_API_BASE` / `VITE_WS_BASE` pointed at the deployed backend and
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from the Supabase
   project (see `frontend/.env.example`).

The frontend falls back to the original local-only UI (no login, talks to
`localhost:8090`/`:8765`) whenever `VITE_SUPABASE_URL` isn't set, so
nothing above changes the plain local self-host flow.

## Real trace hierarchy: one session = one trace in SigNoz

Two related gaps, found by actually asking "can I see everything for one
Claude session in SigNoz" and checking rather than assuming:

1. **Every tool call used to be its own isolated single-span trace** — no
   parent/child linking, so SigNoz's Services page flagged an
   `overflow_operation` dataWarning, and there was no way to open one
   trace and see a session's whole story; you could only filter by
   `session.id` and get a flat, unordered list of independent traces.
2. **Taint-tagging had no span at all.** `record_tool_output()` ran
   `classify_content()` and absorbed the tags, but only ever broadcast a
   WebSocket event to our own panel — the PRD's G2 ("tag data, propagate
   across a multi-step trace") was never actually visible in SigNoz,
   only in our own UI.

Fixed by giving every `TaintContext` (session) a lazily-created root
span, ended immediately (it's a trace-ID anchor, not a meaningful
duration — a session has no clean "done" moment to hook, and a Claude
Code session spans many independent HTTP requests with no shared call
stack to rely on OTel's normal nested-context propagation). Every
subsequent span — tool-call decisions, `taint.classify`, and now
`confirm.resolution` too — explicitly parents to that root via
`set_span_in_context(NonRecordingSpan(...))` instead of the ambient
current-span context. See `instrumentation.py`'s `_session_parent_context`.

Verified directly against ClickHouse (not just "should work"): a real
session's spans — `tool.read_file` → `taint.classify` → `tool.call_api`
(pending_confirm) → `confirm.resolution` (arriving ~120s later, the real
timeout, not faked) — all share one `traceID`, and every child's
`parentSpanID` correctly points to the session's root span.

## What's here

```
agenttrail/
├── agent/
│   ├── agent_loop.py       # ReAct loop, calls Claude with tool schemas
│   ├── tools.py            # read_file / write_file / run_shell / call_api
│   ├── instrumentation.py  # wraps every tool call in an OTel span + taint logic
│   ├── policy.py           # regex-based tagging + block/allow/confirm rules
│   ├── otel_setup.py       # OTLP exporter -> SigNoz collector
│   ├── ws_relay.py         # WebSocket broadcaster feeding the live panel
│   ├── hook_server.py      # Claude Code PreToolUse/PostToolUse HTTP hook adapter
│   ├── alert_webhook_receiver.py  # local receiver for testing SigNoz alert rules
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── EventFeed.jsx   # default view: chronological event log + confirm banner
│       └── AgentTrail.jsx  # the "Uber-map" live graph panel (secondary tab)
├── docker-compose.yml
└── README.md (this file)
```

## Setup

### 1. SigNoz (self-hosted)
Clone SigNoz's own repo and bring up its full stack — don't try to hand-roll
ClickHouse/collector yourself, use their compose file:

```bash
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy/docker
docker compose up -d
```

SigNoz UI: http://localhost:3301
OTel Collector gRPC endpoint: localhost:4317 (this is what our app exports to)

### 2. Agent backend

Two LLM backends are supported, switch via `LLM_BACKEND`:

**Anthropic (default):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages   # if on a managed-env system
export ANTHROPIC_API_KEY=sk-...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &            # start the live relay for the panel
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

**Groq (fast inference, good for a live demo — fewer awkward pauses between tool calls):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages
export LLM_BACKEND=groq
export GROQ_API_KEY=gsk_...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

Groq's API is OpenAI-shaped (same tool-calling flow, different response
format than Anthropic's), so `agent_loop.py` has a separate `_run_agent_groq`
path that speaks that format — both paths go through the same
`tools.py` / `instrumentation.py` / `policy.py`, so nothing about the
security layer changes based on which LLM you pick.

Default model for Groq is `llama-3.3-70b-versatile` (good balance of
tool-calling reliability and speed). If you want raw speed for the live
demo and accept slightly less reliable tool-calling, try a small gpt-oss
model instead — pass it as `run_agent(task, model="...")`.

### 3. Agent Trail panel (frontend)
```bash
cd frontend
npm install
npm start
```
Open the printed local URL — the panel connects to `ws://localhost:8765`
and animates live as the agent runs.

## Wiring order for the hackathon (recommended)

1. Get `agent_loop.py` calling Claude with the 4 tool schemas, no
   instrumentation yet — confirm basic tool-calling works.
2. Drop in `tools.py` + `instrumentation.py` + `policy.py` — confirm spans
   land in SigNoz (check the trace explorer for `service.name: agent-guardian`).
3. Bring up `ws_relay.py` + the React panel — confirm nodes appear live as
   you re-run the agent.
4. Wire the two demo scenarios from the PRD (Section 8): a clean run, then
   an injected malicious doc that triggers a `block`, then a PII-crossing
   scenario that triggers `pending_confirm`.
5. Only then: stretch goals (geo map mode, SigNoz alert rule, replay control).

## Event history (replay + persistence)

Two complementary fixes for "the panel wasn't open yet so I missed it"
(which really happened during testing -- a real block never showed up
because the tab connected after the event fired):

1. **Server-side replay buffer** (`ws_relay.py`): the relay keeps the last
   ~500 events in memory and replays them to any newly-connecting client
   before it joins the live stream. Fixes a fresh tab, a reconnect, or a
   second viewer seeing nothing from before they connected.
2. **Client-side localStorage cache** (`EventFeed.jsx`): the browser tab
   persists what it's seen, so a page refresh restores instantly even if
   the relay process itself restarted. Events use a stable identity
   (`ts|type|tool|target`) instead of a random key so the two mechanisms
   overlapping doesn't produce duplicates.

## Known false-positive fixed: `_is_external()` and `write_file`

`evaluate_call()`'s taint-crossing-boundary rules (secret/PII/internal-only
leaving the system) used to check `tool_name in ("call_api", "write_file")`.
`_is_external()` was written for URLs (it hostname-parses the target), and
every local filesystem path -- relative or absolute -- doesn't have a real
hostname, so it always evaluated as "external." Since `write_file`'s target
in this codebase is *always* a local path (`tools.py`'s `write_file` is a
plain `open(path, "w")`, never a network call), this meant **every single
write_file call was flagged**, and worse, a write_file while SECRET/PII/
internal-only taint was active would get incorrectly BLOCKED as if a local
file save were data leaving the trust boundary. Fixed by restricting those
rules to `call_api` only, which is the one tool that actually crosses the
network. Verified: local writes are clean again, tainted writes no longer
false-block, and the real protection (`call_api` + secret taint -> block)
still fires exactly as before.

## Pause/confirm UI

`pending_confirm` decisions (PII/internal-only data crossing an external
boundary) used to auto-deny. Now there's a real Approve/Deny flow in the
**Feed** tab (the default view):

1. `tools.py`'s `_gate()` broadcasts a `confirm_request` event (with a
   unique id) instead of raising immediately, then polls
   `ws_relay.py`'s new `/confirm-status` endpoint.
2. `EventFeed.jsx` shows it as a banner at the top with Approve/Deny
   buttons; clicking POSTs the decision to `ws_relay.py`'s new
   `/confirm-response` endpoint.
3. The poll picks up the decision (or times out after 120s and defaults
   to deny) and the tool call actually proceeds or raises
   `PolicyPendingConfirm`, same as before. Either way the outcome
   broadcasts as a `confirm_resolution` event so the feed reflects what
   a human actually decided.
4. If the relay/panel isn't reachable at all, it falls back to a `y/N`
   terminal prompt (`tools._cli_confirm`) so the toy agent still works
   standalone.

Verified end-to-end with a real headless browser (Playwright): a live
`pending_confirm` triggered a real banner, clicking Approve/Deny in the
actual rendered page resolved the agent-side poll and the tool either
executed for real or raised the denial, for both outcomes.

**Update:** this now covers Claude Code too, not just the toy agent.
`hook_server.py`'s `PENDING_CONFIRM` path used to return
`permissionDecision: "ask"`, letting Claude Code show its own native
permission dialog — that worked, but it meant Claude Code sessions never
actually used the AgentTrail panel's Approve/Deny UI. The polling logic
was extracted into a shared `instrumentation.web_confirm()` (used by
both `tools.py` and `hook_server.py` now) so a Claude Code
`pending_confirm` broadcasts the exact same panel banner, and the hook's
HTTP response (`allow`/`deny`) is driven by that human click instead of
Claude Code's native dialog. Falls back to `"ask"` only if the relay
itself is unreachable.

This needs the `PreToolUse` hook's timeout raised well above the confirm
poll window (`.claude/settings.json`, now 120s, was 10s) — Claude Code
fails OPEN on a hook timeout regardless of what we'd have decided, so
the hook timeout must outlast `CONFIRM_TIMEOUT_SECONDS` in
`hook_server.py` (110s) or the panel's decision never has a chance to
land in time.

Verified end-to-end with a real browser: simulated a Claude Code
`PostToolUse` (PII-tagged content) then `PreToolUse` (external
`WebFetch`, blocking on the real hook server while it waits) in parallel
with a Playwright script clicking Approve in the actual rendered panel —
the hook server's real HTTP response came back `"allow"` /
`"approved via AgentTrail panel"`. Repeated for Deny — same real
mechanism, response came back `"deny"`.

## Visual design: thebillow.ai

Panel chrome follows thebillow.ai's actual shipped fonts/palette (pulled
from its live CSS, not guessed): **Geist** + **Geist Mono** for UI/data
text, **Newsreader** (serif) reserved for headline moments only — the
wordmark, section titles — the same restrained way Billow uses it, not
sprinkled onto data that needs to stay legible. Warm "paper" surface
(`#faf9f7`) and ink (`#17140e`) replace the earlier near-black dashboard
theme; deep forest green (`#025841`) is the brand accent. All in
`theme.jsx`. The validated status palette (good/warning/serious/
critical) didn't change — those four hex values are documented to work
on both light and dark surfaces.

Fonts load via Google Fonts in `index.html`; verified actually loaded
(not silently falling back) via `document.fonts`.

## Policy tab: edit the path denylist without touching code

`PolicyEditor.jsx` reads/writes `hook_server.py`'s new `GET`/`POST
/policies`, which read/write `policy.py`'s `policies.json` (hot-reloaded
by mtime, no restart needed). `check_path_denylist()` -- called from
`evaluate_call()`, which both the toy agent and the Claude Code hook go
through -- reads from this same file, so an edit in the UI applies to
both front-ends immediately.

`policies.json` is gitignored (seeded with the default 3 patterns on
first run via `_ensure_policies_file()`) since it's live-edited runtime
state, not source.

Verified end-to-end with a real browser: added `*.key` via the UI's
input, confirmed the hook server denies a `.key` file immediately,
confirmed a completely separate toy-agent process (fresh Python
invocation) also blocks it without a restart, then removed it via the
UI's Remove button and confirmed it reverted.

## Event Feed (default panel view)

`EventFeed.jsx` replaced the force-graph as the default view — a
security-review workflow wants "what happened, in order, and does
anything need my attention," which a chronological, color-coded log
communicates far more directly than a node graph.

Click any row to expand it (▸/▾ indicator) and see full details: session
id, risk score, ISO timestamp, and the raw event JSON — not just the
one-line summary.

`theme.jsx` (design tokens + icons), `sessionUtils.js` (session grouping),
and `useEventStream.js` (WS connection + localStorage) are shared between
`EventFeed.jsx` and `AgentTrail.jsx` so the two tabs read as one system,
not two components that quietly drift apart.

## Graph view: a real path, not a hub-and-spoke

`AgentTrail.jsx` used to link every action straight back to one center
"AGENT" node — a star graph of everything touched, not a path (no edge
from step 1 to step 2 to step 3, so you couldn't trace what happened
after what). Rewritten so each session is an actual chain in call order,
with the existing particle animation now flowing along a real trail
instead of radiating from a hub.

- Auto-follows the most recently active session by default — ask Claude
  Code to do something and the view picks up the new session
  automatically. Click an older session in the sidebar to pin the view
  there; a "● Follow live session" button reappears to unpin.
- Each node shows its step number, colored by the same validated status
  palette as the Feed (with the pulsing ring for a block, same as
  before); click one for the detail panel (tool, target, human-readable
  reason, tags, risk score).
- Verified live: a 5-step sequence (2 reads, a shell command, a blocked
  secrets-path read, another shell command) rendered as a real chain,
  in order, with the block's pulsing red ring and correct step numbers.

Positions are laid out in a serpentine ("S") grid sized to the actual
container width (`pathLayout.js`'s `layoutSerpentine`) rather than a
straight line that runs off-screen once a session racks up more than a
handful of steps: row 0 left-to-right, row 1 wraps right-to-left, and so
on. Verified with a 12-step session — wraps cleanly at 8 steps per row
and stays in frame.

The same layout also powers `MiniPathGraph.jsx`, a lightweight SVG path
(no react-force-graph instance, since several can be mounted if more
than one Feed card is expanded) embedded in the **Feed** tab's expanded
session cards — the path for that specific session shows on the side,
so you don't have to switch to the Graph tab to see it.

## Feature F: Claude Code HTTP hook integration

The toy agent and Claude Code are two front-ends on the same backend
(`policy.py` + `instrumentation.py` + `ws_relay.py`, unchanged either way).
`hook_server.py` is the only new component: a thin adapter that translates
Claude Code's `PreToolUse`/`PostToolUse` hook JSON into calls against
`evaluate_call()` / `classify_content()`.

### Run it
```bash
cd agent
export OTEL_COLLECTOR_ENDPOINT=localhost:4317
python ws_relay.py &
python hook_server.py &
```
This listens on `http://localhost:8090/hooks/pre-tool-use` and
`/hooks/post-tool-use`. (Port 8090, not 8080, to avoid clashing with a
locally-running SigNoz UI — adjust `HOOK_SERVER_PORT` if needed.)

### Wire it into a project
Add to that project's `.claude/settings.json` (see this repo's own
`.claude/settings.json` for a working example):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|Edit|Write|Bash",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/pre-tool-use", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Read",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/post-tool-use", "timeout": 10 }] }
    ]
  }
}
```
Policy: `Read`/`Edit`/`Write` are denied on `admin/**`, `.env*`, `secrets/**`
(`policy.check_path_denylist`), regardless of taint state. Everything else
(dangerous shell patterns, secret/PII/internal-data crossing an external
boundary) reuses the same taint-based rules in `evaluate_call()` the toy
agent already exercises.

**Important:** Claude Code reads hook config from `.claude/settings.json`
at session start — editing it mid-session does not retroactively hook an
already-running session. Start a new session (or restart) after adding or
changing hooks for them to take effect.

### Notes
- Non-2xx responses or a hook timeout make Claude Code fail OPEN (the tool
  call proceeds) — `hook_server.py` always answers 200 with a JSON
  `hookSpecificOutput` so a real deny actually takes effect.
- Verified end-to-end via curl against `hook_server.py` directly: legit
  reads allow, `.env`/`admin/**`/`secrets/**` deny via the path rule,
  `rm -rf /`-style commands deny via the shell pattern rule, and a
  `PostToolUse` absorbing a secret tag correctly turns a later external
  `WebFetch` into a deny — all visible as `service.name=agent-guardian`
  spans in SigNoz with `source=claude_code_hook`.

## Notes / things you'll want to adjust before demo day

- `policy.py`'s `ALLOWLISTED_DOMAINS` has a placeholder — put your actual
  internal service domain(s) in there so the boundary check is meaningful.
- `agent_loop.py` auto-denies `pending_confirm` actions for simplicity —
  swap this for a real confirm UI if you have time (Feature C "should-have").
- The relay (`ws_relay.py`) and SigNoz are independent — panel works even
  if SigNoz ingestion has issues, which is a good demo-day safety net.
