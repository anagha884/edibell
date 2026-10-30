#!/usr/bin/env node
/**
 * EDIBELL ↔ Supabase connection check.   Run:  pnpm check:supabase
 *
 * Reads proj/.env.local (then proj/.env), checks the values are safe to ship to
 * browsers, and talks to your Supabase project with the PUBLIC key only:
 *   - is the project reachable and the key accepted?
 *   - are the EDIBELL migrations applied (database functions present)?
 *   - do the storage buckets exist?
 *   - what are the Auth sign-up / email-confirmation settings?
 * It never prints keys and never writes data.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = {};
for (const f of [".env", ".env.local"]) {          // .env.local overrides .env (same as Vite)
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const url = (process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const key = (process.env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const maps = (process.env.VITE_GEOAPIFY_API_KEY ?? env.VITE_GEOAPIFY_API_KEY ?? "").trim();

let failures = 0;
const ok = m => console.log(`  ✔ ${m}`);
const bad = m => { failures++; console.log(`  ✘ ${m}`); };
const info = m => console.log(`  • ${m}`);

console.log("\nEDIBELL Supabase check\n");
const envFile = [".env.local", ".env"].find(f => fs.existsSync(path.join(root, f)));
envFile ? ok(`Found ${path.join("proj", envFile)}`) : bad("No proj/.env.local file. Copy proj/.env.example to proj/.env.local and fill it in.");

const jwtRole = k => { try { return JSON.parse(Buffer.from(k.split(".")[1], "base64url").toString()).role; } catch { return null; } };
if (!url || !key) { bad("VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY are empty."); finish(); }
if (/YOUR-|placeholder/i.test(url + key)) { bad("Values are still the placeholders from .env.example."); finish(); }
if (/^sb_secret_/.test(key) || jwtRole(key) === "service_role") {
  bad("VITE_SUPABASE_ANON_KEY is a SECRET / service_role key. Replace it with the publishable (anon) key and rotate the secret key in Supabase."); finish();
}
ok(`Key type: ${key.startsWith("sb_publishable_") ? "publishable" : jwtRole(key) === "anon" ? "legacy anon (JWT)" : "unrecognised format (check it is the publishable/anon key)"}`);
let host = "";
try { host = new URL(url).host; ok(`Project URL host: ${host}`); } catch { bad("VITE_SUPABASE_URL is not a valid URL."); finish(); }

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
async function req(p, init = {}) {
  try {
    const r = await fetch(`${url}${p}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    let body = null; const t = await r.text(); try { body = JSON.parse(t); } catch { body = t; }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: String(e?.cause?.code ?? e?.message ?? e) }; }
}

const settings = await req("/auth/v1/settings");
if (settings.status === 0) { bad(`Cannot reach ${host} (${settings.body}). Check the URL and your internet connection.`); finish(); }
if (settings.status === 401 || settings.status === 403) { bad("Supabase rejected the key (401/403). Re-copy the publishable/anon key for THIS project."); finish(); }
if (settings.status !== 200) { bad(`Auth settings returned HTTP ${settings.status}. Is this the right project URL?`); finish(); }
ok("Project reachable and key accepted (Auth)");
if (settings.body?.disable_signup) bad("Sign-ups are disabled in Supabase Auth. Enable them so organizations can register.");
else ok("Email sign-up is enabled");
info(settings.body?.mailer_autoconfirm ? "Email confirmation is OFF: new accounts are active immediately (EDIBELL's chosen setting)." : "Email confirmation is ON: users must click an email link before logging in. EDIBELL is set up with it OFF (Authentication → Sign In / Providers → Email → Confirm email).");

const stats = await req("/rest/v1/rpc/public_stats", { method: "POST", body: "{}" });
if (stats.status === 200 && stats.body && typeof stats.body === "object") {
  ok("EDIBELL database functions found (migrations applied)");
  info(`Live data: ${stats.body.donors} donors, ${stats.body.ngos} NGOs, ${stats.body.animalOrgs} animal orgs, ${stats.body.completedPickups} verified pickups.`);
} else if (stats.status === 404 || stats.body?.code === "PGRST202") {
  bad("EDIBELL migrations are NOT applied (function public.public_stats not found). Run proj/supabase/setup_all.sql in the SQL Editor, or `npx supabase db push`.");
} else {
  bad(`public_stats returned HTTP ${stats.status}: ${typeof stats.body === "object" ? stats.body?.message : stats.body}`);
}

const prof = await req("/rest/v1/rpc/get_my_profile", { method: "POST", body: "{}" });
if (prof.status === 401 || prof.status === 403 || prof.status === 404) ok("Anonymous callers cannot use account functions (expected)");
else if (prof.status === 200 && prof.body === null) ok("Anonymous profile lookup returns nothing (expected)");
else info(`get_my_profile as anonymous returned HTTP ${prof.status}`);

const leak = await req("/rest/v1/profiles?select=id&limit=1");
if (leak.status === 200 && Array.isArray(leak.body) && leak.body.length > 0) bad("SECURITY: anonymous visitors can read the profiles table. Re-apply the migrations.");
else ok("Anonymous visitors cannot read organization profiles");

for (const bucket of ["food-photos", "org-documents"]) {
  const r = await req(`/storage/v1/object/${bucket === "food-photos" ? "public/" : ""}${bucket}/__edibell_check__.jpg`);
  const msg = JSON.stringify(r.body ?? "");
  if (/bucket not found/i.test(msg)) bad(`Storage bucket "${bucket}" is missing (it is created by the last migration).`);
  else ok(`Storage bucket "${bucket}" exists`);
}

maps ? ok("Geoapify key is set (test the address search in the app)") : info("VITE_GEOAPIFY_API_KEY is empty: address search/map is off; typed addresses and directions links still work.");
finish();

function finish() {
  console.log(failures ? `\n${failures} problem(s) found. Fix them, then run \`pnpm check:supabase\` again and restart \`pnpm dev\`.\n` : "\nAll checks passed. Restart `pnpm dev` if it was already running.\n");
  process.exit(failures ? 1 : 0);
}
