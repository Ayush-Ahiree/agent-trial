# argox (AgentTrail Python SDK)

Not published to PyPI yet -- install from source for now:

```bash
pip install -e /path/to/agent-trial/sdk/python
```

For agents that aren't Claude Code (LangChain tools, OpenAI Agents SDK,
a homegrown loop) and so have no PreToolUse/PostToolUse hook mechanism
to plug into. Wrap your own tool calls with two lines:

```python
import argox as at

def write_file(path, content):
    result = at.check("write_file", path)
    if not result.allowed:
        raise PermissionError(result.reason)

    output = _actually_write(path, content)

    at.record_output("write_file", path, output)
    return output
```

`action` is a generic verb -- `read_file` / `write_file` / `run_shell` /
`call_api` get real policy rules (path denylist, dangerous shell
detection, taint-based secret/PII exfil checks). Any other string still
gets a decision back (default-allow), just without a verb-specific rule.

## Config

Reads `AGENTTRAIL_API_KEY` (the same key `argox connect` writes for
Claude Code) and optionally `AGENTTRAIL_API_BASE` from the environment,
or pass them explicitly:

```python
at.configure(api_key="...", api_base="https://your-instance")
```

## Sessions

Pass the same `session_id` across an agent run's tool calls to group them
into one session/trace on the dashboard, and so later `check()` calls
inherit taint tags absorbed by earlier `record_output()` calls (e.g. a
`call_api` right after a `read_file` that returned a secret gets flagged
even though the call itself looks benign in isolation). Omit it and each
call is treated as its own session.

## Errors vs. denials

A policy "deny" is a normal, successful `check()` result
(`result.allowed is False`) -- not an exception. `ArgoxError` is only
raised for auth/network/protocol failures talking to the backend itself.
`check()` never raises on a deny, so callers must check `.allowed`.
