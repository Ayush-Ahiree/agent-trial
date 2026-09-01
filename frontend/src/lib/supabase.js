import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

// Only constructed when hosted config is actually present (see
// config.js's HOSTED flag) -- App.jsx never touches this in local-only mode.
export const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
