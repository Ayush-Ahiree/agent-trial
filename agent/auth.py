"""
AgentTrail - Auth for the hosted (multi-tenant) backend.

Two credential types for two callers, per the plan:
  - API keys: Claude Code hooks (via the npm CLI's config) -> project-scoped,
    sent as `Authorization: Bearer <key>`.
  - Supabase JWT: the dashboard (logged-in user) -> resolves to a user_id,
    which then gets checked against project ownership in db.py.
"""

import hashlib
import os
import secrets

import jwt  # PyJWT
from jwt import PyJWKClient

API_KEY_PREFIX = "atk_"
SUPABASE_URL = os.environ.get("SUPABASE_URL")
# Legacy-project fallback only -- Supabase projects created since the
# asymmetric-signing-keys rollout issue ES256 tokens (see verify_jwt),
# which a shared secret can't verify at all. Found live: a real signed-up
# user's token had header {"alg": "ES256", "kid": ...}, and HS256-only
# verification rejected every genuine session with a 401.
SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")

_jwks_client = None


def generate_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def key_prefix_for_display(key: str) -> str:
    # enough to recognize a key in a list without ever re-showing the secret
    return key[: len(API_KEY_PREFIX) + 6] + "…"


def _jwks():
    global _jwks_client
    if _jwks_client is None:
        if not SUPABASE_URL:
            raise RuntimeError("SUPABASE_URL not set -- required to verify Supabase's ES256 JWTs (agent/main.py)")
        _jwks_client = PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")
    return _jwks_client


def verify_jwt(token: str) -> str:
    """Verify a Supabase-issued access token, return the user's id (`sub`).
    Raises jwt.PyJWTError (or KeyError on a malformed header) on anything
    invalid/expired -- callers should catch that and respond 401.

    Branches on the token's own `alg`: current Supabase projects sign with
    an asymmetric key (ES256 as of writing) verified against the
    project's public JWKS; only older projects still on a shared HS256
    secret need SUPABASE_JWT_SECRET at all.
    """
    alg = jwt.get_unverified_header(token).get("alg")
    if alg == "HS256":
        if not SUPABASE_JWT_SECRET:
            raise RuntimeError("SUPABASE_JWT_SECRET not set -- required for this (legacy HS256) Supabase project")
        payload = jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], audience="authenticated")
    else:
        signing_key = _jwks().get_signing_key_from_jwt(token)
        payload = jwt.decode(token, signing_key.key, algorithms=[alg], audience="authenticated")
    return payload["sub"]
