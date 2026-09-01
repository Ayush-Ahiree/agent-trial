// Hosted backend + Supabase config, read from Vite env vars (set in
// frontend/.env, see .env.example). Falls back to the local self-host
// backend's default ports when unset, so `npm run start` still works
// against `python cli.py start` with zero config -- only a real
// deployment needs a real .env.

export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8090";
export const WS_BASE = import.meta.env.VITE_WS_BASE || "ws://localhost:8765";
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// Hosted mode requires real Supabase config; without it, App.jsx skips
// the login gate entirely and behaves like the original local-only build.
export const HOSTED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
