import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase browser configuration.
 *
 * Values come from `proj/.env.local` (or `proj/.env`), loaded by Vite at
 * startup — restart `pnpm dev` after editing. Only the PUBLIC project URL and
 * publishable / anon key belong here. Secret / service_role keys are refused.
 */
const rawUrl = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

function decodeJwtRole(key: string): string | null {
  const part = key.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).role ?? null; } catch { return null; }
}

export type SupabaseConfigProblem = "missing" | "placeholder" | "bad-url" | "secret-key" | null;

function checkConfig(): SupabaseConfigProblem {
  if (!rawUrl || !rawKey) return "missing";
  if (/YOUR-|your-project|placeholder|<|>/i.test(rawUrl + rawKey)) return "placeholder";
  try { const u = new URL(rawUrl); if (!/^https?:$/.test(u.protocol)) return "bad-url"; } catch { return "bad-url"; }
  if (/^sb_secret_/i.test(rawKey) || decodeJwtRole(rawKey) === "service_role") return "secret-key";
  return null;
}

export const supabaseConfigProblem = checkConfig();
/** True when a usable project URL and public (anon / publishable) key are set. */
export const supabaseConfigured = supabaseConfigProblem === null;

const MESSAGES: Record<Exclude<SupabaseConfigProblem, null>, string> = {
  missing: "EDIBELL's backend is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to proj/.env.local (see README → Setup), then restart the app.",
  placeholder: "EDIBELL's backend is not configured: proj/.env.local still contains placeholder values. Paste your Supabase Project URL and publishable (anon) key, then restart the app.",
  "bad-url": "VITE_SUPABASE_URL in proj/.env.local is not a valid URL. It should look like https://<project-ref>.supabase.co. Fix it and restart the app.",
  "secret-key": "Security stop: VITE_SUPABASE_ANON_KEY contains a SECRET / service_role key. Never put that key in the website. Replace it with the publishable (anon) key from Supabase → Project Settings → API Keys, rotate the secret key, and restart the app.",
};
export const SUPABASE_SETUP_MESSAGE = supabaseConfigProblem ? MESSAGES[supabaseConfigProblem] : "";

/**
 * The browser Supabase client. Row Level Security and the database functions
 * enforce every permission; this key only identifies the project.
 */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(rawUrl, rawKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

if (!supabaseConfigured && typeof console !== "undefined") console.warn(`[EDIBELL] ${SUPABASE_SETUP_MESSAGE}`);

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error(SUPABASE_SETUP_MESSAGE);
  return supabase;
}

export const FOOD_PHOTO_BUCKET = "food-photos";
export const ORG_DOCUMENT_BUCKET = "org-documents";

/** Public URL of a food photo stored at `path` in the food-photos bucket. */
export function photoUrl(path: string): string {
  if (!path || /^(https?:|data:|blob:)/.test(path)) return path;
  return supabase ? supabase.storage.from(FOOD_PHOTO_BUCKET).getPublicUrl(path).data.publicUrl : "";
}
