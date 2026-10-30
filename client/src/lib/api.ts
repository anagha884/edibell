import { useCallback, useEffect, useRef, useState } from "react";
import { photoUrl, requireSupabase, SUPABASE_SETUP_MESSAGE, supabaseConfigured } from "./supabase";

/**
 * EDIBELL data access.
 *
 * Pages address data with short resource paths (e.g. "/donor/requests?status=all").
 * Each path maps to exactly one Supabase database function (RPC) defined in
 * supabase/migrations. There is no local or mock data: every call reads or
 * writes the real database, which enforces roles, ownership and validation.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

type Json = Record<string, unknown>;
type Handler = (m: RegExpMatchArray, query: URLSearchParams, body: Json) => Promise<unknown>;

async function call<T = unknown>(fn: string, args?: Json): Promise<T> {
  if (!supabaseConfigured) throw new ApiError(503, SUPABASE_SETUP_MESSAGE);
  let res: { data: unknown; error: { message: string; code?: string } | null };
  try {
    res = await requireSupabase().rpc(fn, args ?? {});
  } catch {
    throw new ApiError(0, "Can't reach EDIBELL right now. Check your connection and try again.");
  }
  if (res.error) throw toApiError(res.error);
  return withPhotoUrls(res.data) as T;
}

function toApiError(e: { message: string; code?: string }): ApiError {
  const code = e.code ?? "";
  const m = e.message ?? "";
  if (code === "PGRST202" || code === "42883") return new ApiError(500, "The EDIBELL database hasn't been set up yet. Apply the Supabase migrations (see README).", code);
  if (/^permission denied/i.test(m)) return new ApiError(403, "Your account isn't allowed to do that. Please log in again.", code);
  if (/JWT|token is expired|invalid claim/i.test(m)) return new ApiError(401, "Your session has expired. Please log in again.", code);
  if (/violates|duplicate key|null value in column/i.test(m)) return new ApiError(400, "Some of the information isn't valid. Please check the form and try again.", code);
  if (/^(TypeError|Failed to fetch|NetworkError)/i.test(m)) return new ApiError(0, "Can't reach EDIBELL right now. Check your connection and try again.", code);
  const status = code === "P0002" ? 404 : code === "42501" ? 403 : code === "28000" ? 401 : code === "55000" || code === "23505" ? 409 : 400;
  return new ApiError(status, m || "Something went wrong. Please try again.", code);
}

/** Storage paths in `photos` become public URLs; the paths stay in `photoPaths`. */
function withPhotoUrls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withPhotoUrls);
  if (v && typeof v === "object") {
    const o: Json = {};
    for (const [k, val] of Object.entries(v as Json)) {
      if (k === "photos" && Array.isArray(val)) { o.photoPaths = val; o.photos = (val as string[]).map(photoUrl); }
      else o[k] = withPhotoUrls(val);
    }
    return o;
  }
  return v;
}

const queryObject = (q: URLSearchParams): Json => Object.fromEntries([...q.entries()].filter(([, v]) => v !== ""));

const routes: { method: string; re: RegExp; run: Handler }[] = [
  // public
  { method: "GET", re: /^\/stats$/, run: () => call("public_stats") },
  { method: "POST", re: /^\/contact$/, run: (_m, _q, b) => call("submit_contact_message", { p: b }) },
  // account
  { method: "PUT", re: /^\/profile$/, run: (_m, _q, b) => call("update_my_profile", { p: b }).then(user => ({ user })) },
  { method: "GET", re: /^\/documents$/, run: () => call("list_my_documents") },
  { method: "POST", re: /^\/documents$/, run: (_m, _q, b) => call("add_org_document", { p_path: b.path, p_doc_type: b.docType, p_file_name: b.fileName }) },
  // shared
  { method: "GET", re: /^\/impact$/, run: () => call("my_impact") },
  { method: "GET", re: /^\/notifications$/, run: () => call("list_notifications", { p_limit: 100 }) },
  { method: "POST", re: /^\/notifications\/read$/, run: (_m, _q, b) => call("mark_notifications_read", { p_ids: Array.isArray(b.ids) ? b.ids : null }) },
  // donor
  { method: "GET", re: /^\/donations\/mine$/, run: () => call("list_my_listings") },
  { method: "POST", re: /^\/donations$/, run: (_m, _q, b) => call("create_listing", { p: b }) },
  { method: "GET", re: /^\/donations\/([0-9a-f-]{36})$/, run: m => call("get_listing", { p_id: m[1] }) },
  { method: "PUT", re: /^\/donations\/([0-9a-f-]{36})$/, run: (m, _q, b) => call("update_listing", { p_id: m[1], p: b }) },
  { method: "POST", re: /^\/donations\/([0-9a-f-]{36})\/cancel$/, run: (m, _q, b) => call("cancel_listing", { p_id: m[1], p_reason: String(b.reason ?? "") }) },
  { method: "GET", re: /^\/donor\/requests$/, run: (_m, q) => call("list_my_requests", { p_status: q.get("status") || "all" }) },
  { method: "POST", re: /^\/donor\/requests\/([0-9a-f-]{36})\/decision$/, run: (m, _q, b) => call("decide_request", { p_id: m[1], p_decision: b.decision, p_reason: String(b.reason ?? "") }) },
  { method: "POST", re: /^\/donor\/scan$/, run: (_m, _q, b) => call("verify_pickup", { p_code: String(b.code ?? "") }) },
  // recipients
  { method: "GET", re: /^\/market$/, run: (_m, q) => call("browse_listings", { f: queryObject(q) }) },
  { method: "GET", re: /^\/requests\/mine$/, run: (_m, q) => call("list_my_requests", { p_status: q.get("status") || "all" }) },
  { method: "POST", re: /^\/requests$/, run: (_m, _q, b) => call("create_request", { p: b }) },
  { method: "POST", re: /^\/requests\/([0-9a-f-]{36})\/cancel$/, run: m => call("cancel_request", { p_id: m[1] }) },
  { method: "GET", re: /^\/requests\/([0-9a-f-]{36})\/qr$/, run: m => call("get_pickup_pass", { p_request: m[1] }) },
  // animal feed needs
  { method: "GET", re: /^\/needs\/(open|mine)$/, run: m => call("list_animal_needs", { p_scope: m[1] }) },
  { method: "POST", re: /^\/needs$/, run: (_m, _q, b) => call("create_animal_need", { p: b }) },
  { method: "POST", re: /^\/needs\/([0-9a-f-]{36})\/close$/, run: m => call("close_animal_need", { p_id: m[1] }) },
  // administration
  { method: "GET", re: /^\/admin$/, run: () => call("admin_overview") },
  { method: "POST", re: /^\/admin\/organizations\/([0-9a-f-]{36})$/, run: (m, _q, b) => call("admin_set_verification", { p_org: m[1], p_status: b.status, p_note: String(b.note ?? "") }) },
  { method: "POST", re: /^\/admin\/listings\/([0-9a-f-]{36})$/, run: (m, _q, b) => call("admin_review_listing", { p_id: m[1], p_decision: b.decision, p_note: String(b.note ?? "") }) },
  { method: "GET", re: /^\/admin\/messages$/, run: (_m, q) => call("admin_list_contact_messages", { p_status: q.get("status") || "open" }) },
  { method: "POST", re: /^\/admin\/messages\/([0-9a-f-]{36})$/, run: (m, _q, b) => call("admin_set_contact_message_status", { p_id: m[1], p_status: b.status }) },
];

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const [path, search = ""] = url.split("?");
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (m) {
      const out = await r.run(m, new URLSearchParams(search), (body ?? {}) as Json);
      if (method !== "GET") notifyDataChanged();
      return out as T;
    }
  }
  throw new ApiError(404, `Unknown EDIBELL resource: ${method} ${path}`);
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T,>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Change notifications: after any write here, or when a realtime notification
// arrives, every mounted useFetch quietly reloads.
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
export function notifyDataChanged() { listeners.forEach(l => l()); }
export function onDataChanged(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** GET helper with reload, realtime refresh and optional polling. Pass null to skip fetching. */
export function useFetch<T>(url: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(url !== null);
  const seq = useRef(0);

  const load = useCallback(async (quiet = false) => {
    if (url === null) return;
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const out = await api.get<T>(url);
      if (mine === seq.current) { setData(out); setError(""); }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => onDataChanged(() => { if (url !== null) void load(true); }), [load, url]);
  useEffect(() => {
    if (!opts.pollMs || url === null) return;
    const t = window.setInterval(() => { if (!document.hidden) void load(true); }, opts.pollMs);
    return () => window.clearInterval(t);
  }, [load, opts.pollMs, url]);

  return { data, error, loading, reload: () => load(true) };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
