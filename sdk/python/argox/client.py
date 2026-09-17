"""
Client for AgentTrail's generic /v1/tool-call and /v1/tool-result routes
(agent/main.py) -- lets any Python agent (LangChain tool, OpenAI Agents
SDK function tool, a homegrown loop) get the same policy engine and
dashboard visibility Claude Code gets via its PreToolUse/PostToolUse
hooks, without needing a hook mechanism to exist.

Deliberately does not auto-wire anything (no equivalent of the npm CLI's
`argox connect` here) -- most agent frameworks have no hook-config file to
merge into, so you call check()/record_output() around your own tool
calls instead. Config follows the same env var the npm CLI's hooks use
(AGENTTRAIL_API_KEY) plus AGENTTRAIL_API_BASE for the endpoint.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
import json as _json
from dataclasses import dataclass

DEFAULT_API_BASE = "https://api.agenttrail.dev"  # placeholder until the real domain is live, same as cli/src/config.js


class ArgoxError(Exception):
    """Raised on auth/network/protocol failures talking to the AgentTrail
    backend. Deliberately NOT raised for a policy "deny" -- see
    CheckResult.allowed for that; a deny is an expected, successful
    response from the API, not an error."""


@dataclass
class CheckResult:
    decision: str  # "allow" or "deny" ("ask" without a human to resolve it collapses to "deny", fail-safe)
    reason: str

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"


class Client:
    def __init__(self, api_key: str | None = None, api_base: str | None = None, timeout: float = 15.0):
        self.api_key = api_key or os.environ.get("AGENTTRAIL_API_KEY")
        if not self.api_key:
            raise ArgoxError(
                "no API key -- pass api_key=... or set AGENTTRAIL_API_KEY "
                "(the same key `argox connect` writes for Claude Code)"
            )
        self.api_base = (api_base or os.environ.get("AGENTTRAIL_API_BASE") or DEFAULT_API_BASE).rstrip("/")
        self.timeout = timeout

    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"{self.api_base}{path}",
            data=_json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return _json.loads(resp.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")
            raise ArgoxError(f"{path} -> HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise ArgoxError(f"{path} unreachable: {e}") from e

    def check(self, action: str, target: str, input: dict | None = None, session_id: str | None = None) -> CheckResult:
        """Call BEFORE running the tool. Mirrors precheck()/evaluate_call()
        on the backend -- same engine Claude Code's PreToolUse hook uses.

        action: a generic verb -- "read_file" / "write_file" / "run_shell" /
        "call_api" get real policy rules (path denylist, dangerous shell
        patterns, taint-based exfil checks); any other string still gets a
        decision (default-allows, no error), just no verb-specific rule.
        target: the path / URL / command being acted on.
        input: optional extra params, recorded for telemetry only.
        session_id: group related calls into one session/trace on the
        dashboard -- reuse the same id across an agent run's tool calls.
        """
        data = self._post("/v1/tool-call", {
            "action": action, "target": target, "input": input or {}, "session_id": session_id,
        })
        decision = data.get("decision", "deny")
        if decision == "ask":
            # No interactive dashboard confirmation reached in time (or the
            # relay was briefly unreachable) -- fail closed rather than
            # silently proceed, same "fail safe, not fail open" philosophy
            # web_confirm() already documents on the backend.
            decision = "deny"
        return CheckResult(decision=decision, reason=data.get("reason", ""))

    def record_output(self, action: str, target: str, output, session_id: str | None = None) -> None:
        """Call AFTER the tool runs successfully, with its real output.
        Feeds the taint classifier (PII/secret/internal-only tagging) so
        later check() calls in the same session inherit the right tags --
        e.g. a write_file/call_api right after a read_file that returned a
        secret gets flagged even though the write/call itself looks benign.

        Best-effort: swallows backend errors rather than raising, since a
        telemetry write failing shouldn't take down the caller's agent
        (matches record_tool_output's own DB-failure handling in main.py).
        """
        try:
            self._post("/v1/tool-result", {
                "action": action, "target": target, "output": output, "session_id": session_id,
            })
        except ArgoxError:
            pass


_default_client: Client | None = None


def _client() -> Client:
    global _default_client
    if _default_client is None:
        _default_client = Client()
    return _default_client


def configure(api_key: str | None = None, api_base: str | None = None) -> None:
    """Set the module-level default client explicitly instead of relying
    on AGENTTRAIL_API_KEY/AGENTTRAIL_API_BASE env vars."""
    global _default_client
    _default_client = Client(api_key=api_key, api_base=api_base)


def check(action: str, target: str, input: dict | None = None, session_id: str | None = None) -> CheckResult:
    return _client().check(action, target, input=input, session_id=session_id)


def record_output(action: str, target: str, output, session_id: str | None = None) -> None:
    _client().record_output(action, target, output, session_id=session_id)
