#!/usr/bin/env node
/**
 * LOCAL TEST HARNESS ONLY — never deploy.
 *
 * A minimal stand-in for the Supabase HTTP gateway (Auth, PostgREST RPC and
 * Storage) so the real EDIBELL frontend (supabase-js) can be driven end to end
 * in a browser against the real migrations on a local PostgreSQL, without
 * Docker. Every database call runs exactly like PostgREST does: one
 * transaction, `SET LOCAL ROLE authenticated|anon`, JWT claims in
 * `request.jwt.claims`, so RLS, grants and SECURITY DEFINER rules apply.
 * Auth is simplified (auto-confirmed email, scrypt password hashes in a side
 * table). Realtime is not emulated; the app falls back to polling.
 *
 *   EDIBELL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/edibell_e2e node tests/e2e/local-supabase.mjs
 */
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 54321);
const SECRET = "local-test-secret-not-for-production";
const pool = new pg.Pool({ connectionString: process.env.EDIBELL_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/edibell_e2e" });
const files = new Map(); // `${bucket}/${path}` -> { type, body }

await pool.query(`create table if not exists auth.local_passwords (user_id uuid primary key references auth.users(id) on delete cascade, salt text, hash text)`);

const b64u = b => Buffer.from(b).toString("base64url");
function jwt(user) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 }));
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  const [h, b, s] = (token ?? "").split(".");
  if (!h || !b || !s) return null;
  const exp = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  if (exp !== s) return null;
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  return claims.exp * 1000 > Date.now() ? claims : null;
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const userJson = u => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: u.created_at, user_metadata: u.raw_user_meta_data ?? {}, app_metadata: { provider: "email" }, identities: [{ id: u.id, provider: "email" }], created_at: u.created_at });
const session = u => ({ access_token: jwt(u), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `r.${u.id}.${crypto.randomBytes(8).toString("hex")}`, user: userJson(u) });

async function asRole(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${claims ? "authenticated" : "anon"}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? { role: "anon" })]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", ...(isBuf ? {} : { "Content-Type": "application/json" }), ...headers });
  res.end(isBuf ? body : body === undefined ? "" : JSON.stringify(body));
}
const readBody = req => new Promise(r => { const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => r(Buffer.concat(chunks))); });
const pgErr = e => ({ code: e.code ?? "XX000", message: e.message, details: e.detail ?? null, hint: e.hint ?? null });

http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204);
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const raw = await readBody(req);
    const json = () => { try { return JSON.parse(raw.toString() || "{}"); } catch { return {}; } };
    const claims = verify((req.headers.authorization ?? "").replace(/^Bearer /, ""));

    // ---------------- Auth ----------------
    if (p === "/auth/v1/signup" && req.method === "POST") {
      const b = json();
      const exists = await pool.query("select 1 from auth.users where email = lower($1)", [b.email]);
      if (exists.rowCount) return send(res, 422, { code: "user_already_exists", msg: "User already registered", message: "User already registered" });
      if (!b.password || b.password.length < 6) return send(res, 422, { code: "weak_password", msg: "Password should be at least 6 characters.", message: "Password should be at least 6 characters." });
      try {
        const u = (await pool.query("insert into auth.users (email, raw_user_meta_data) values (lower($1), $2) returning *", [b.email, JSON.stringify(b.data ?? {})])).rows[0];
        const salt = crypto.randomBytes(8).toString("hex");
        await pool.query("insert into auth.local_passwords values ($1, $2, $3)", [u.id, salt, hashPw(b.password, salt)]);
        return send(res, 200, session(u));
      } catch (e) { return send(res, 500, { code: "unexpected_failure", msg: "Database error saving new user", message: "Database error saving new user", detail: e.message }); }
    }
    if (p === "/auth/v1/token" && req.method === "POST") {
      const b = json();
      if (url.searchParams.get("grant_type") === "password") {
        const r = await pool.query("select u.*, lp.salt, lp.hash from auth.users u join auth.local_passwords lp on lp.user_id = u.id where u.email = lower($1)", [b.email]);
        const u = r.rows[0];
        if (!u || hashPw(b.password, u.salt) !== u.hash) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials", message: "Invalid login credentials" });
        return send(res, 200, session(u));
      }
      if (url.searchParams.get("grant_type") === "refresh_token") {
        const id = String(b.refresh_token ?? "").split(".")[1];
        const u = (await pool.query("select * from auth.users where id = $1", [id])).rows[0];
        return u ? send(res, 200, session(u)) : send(res, 400, { error: "invalid_grant", message: "Invalid Refresh Token" });
      }
    }
    if (p === "/auth/v1/user") {
      if (!claims) return send(res, 401, { message: "invalid JWT" });
      const u = (await pool.query("select * from auth.users where id = $1", [claims.sub])).rows[0];
      if (req.method === "PUT") {
        const b = json();
        if (b.password) { const salt = crypto.randomBytes(8).toString("hex"); await pool.query("update auth.local_passwords set salt = $2, hash = $3 where user_id = $1", [u.id, salt, hashPw(b.password, salt)]); }
      }
      return send(res, 200, userJson(u));
    }
    if (p === "/auth/v1/settings") return send(res, 200, { disable_signup: false, mailer_autoconfirm: true, external: { email: true } });
    if (p.startsWith("/rest/v1/") && !p.startsWith("/rest/v1/rpc/")) {
      const table = p.slice(9);
      try { const out = await asRole(claims, c => c.query(`select * from public.${table.replace(/\W/g, "")} limit 1`)); return send(res, 200, out.rows); }
      catch (e) { return send(res, 401, pgErr(e)); }
    }
    if (p === "/auth/v1/logout") return send(res, 204);
    if (p === "/auth/v1/recover") return send(res, 200, {});

    // ---------------- PostgREST RPC ----------------
    const rpc = p.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const args = json();
      const names = Object.keys(args);
      const sql = `select public.${rpc[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as v`;
      const values = names.map(n => (args[n] !== null && typeof args[n] === "object" && !Array.isArray(args[n]) ? JSON.stringify(args[n]) : args[n]));
      try {
        const out = await asRole(claims, c => c.query(sql, values));
        return send(res, 200, out.rows[0].v);
      } catch (e) {
        if (e.code === "42883") return send(res, 404, { code: "PGRST202", message: `Could not find the function public.${rpc[1]}`, details: null, hint: null });
        return send(res, e.code === "42501" ? 403 : 400, pgErr(e));
      }
    }

    // ---------------- Storage ----------------
    const pub = p.match(/^\/storage\/v1\/object\/public\/([\w-]+)\/(.+)$/);
    if (pub && req.method === "GET") {
      const bucket = (await pool.query("select public from storage.buckets where id = $1", [pub[1]])).rows[0];
      const f = files.get(`${pub[1]}/${decodeURIComponent(pub[2])}`);
      if (!bucket) return send(res, 400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      if (!bucket.public || !f) return send(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
      return send(res, 200, f.body, { "Content-Type": f.type });
    }
    const sign = p.match(/^\/storage\/v1\/object\/sign\/([\w-]+)\/(.+)$/);
    if (sign && req.method === "POST") {
      const name = decodeURIComponent(sign[2]);
      const ok = await asRole(claims, c => c.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [sign[1], name]));
      if (!ok.rowCount) return send(res, 400, { message: "Object not found" });
      return send(res, 200, { signedURL: `/object/sign/${sign[1]}/${encodeURIComponent(name)}?token=local` });
    }
    const getSigned = p.match(/^\/storage\/v1\/object\/sign\/([\w-]+)\/(.+)$/);
    if (getSigned && req.method === "GET") {
      const f = files.get(`${getSigned[1]}/${decodeURIComponent(getSigned[2])}`);
      return f ? send(res, 200, f.body, { "Content-Type": f.type }) : send(res, 404, { message: "Object not found" });
    }
    const obj = p.match(/^\/storage\/v1\/object\/([\w-]+)\/(.+)$/);
    if (obj && req.method === "GET") {
      const exists = (await pool.query("select 1 from storage.buckets where id = $1", [obj[1]])).rowCount;
      return send(res, 400, { statusCode: "404", error: exists ? "not_found" : "Bucket not found", message: exists ? "Object not found" : "Bucket not found" });
    }
    if (obj && req.method === "POST") {
      const [_, bucketId, rawName] = obj; const name = decodeURIComponent(rawName);
      const bucket = (await pool.query("select * from storage.buckets where id = $1", [bucketId])).rows[0];
      if (!bucket) return send(res, 404, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
      let type = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];
      let body = raw;
      if (type === "multipart/form-data") {
        // supabase-js sends Blobs as multipart: take the file part.
        const boundary = "--" + /boundary=([^;]+)/.exec(String(req.headers["content-type"]))[1];
        for (const part of raw.toString("latin1").split(boundary)) {
          const m = /^\r\nContent-Disposition: form-data; name="[^"]*"; filename="[^"]*"\r\nContent-Type: ([^\r]+)\r\n\r\n([\s\S]*)\r\n$/i.exec(part);
          if (m) { type = m[1].trim(); body = Buffer.from(m[2], "latin1"); }
        }
      }
      if (bucket.allowed_mime_types && !bucket.allowed_mime_types.includes(type)) return send(res, 400, { statusCode: "415", error: "invalid_mime_type", message: `mime type ${type} is not supported` });
      if (bucket.file_size_limit && body.length > Number(bucket.file_size_limit)) return send(res, 400, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
      try {
        await asRole(claims, c => c.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucketId, name, claims?.sub ?? null]));
      } catch (e) { return send(res, 400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }); }
      files.set(`${bucketId}/${name}`, { type, body });
      return send(res, 200, { Key: `${bucketId}/${name}`, Id: crypto.randomUUID() });
    }
    const del = p.match(/^\/storage\/v1\/object\/([\w-]+)$/);
    if (del && req.method === "DELETE") {
      const { prefixes = [] } = json();
      const out = await asRole(claims, c => c.query("delete from storage.objects where bucket_id = $1 and name = any($2) returning name", [del[1], prefixes]));
      for (const r of out.rows) files.delete(`${del[1]}/${r.name}`);
      return send(res, 200, out.rows);
    }
    if (p.startsWith("/realtime/")) return send(res, 404, { message: "Realtime is not emulated in the local test harness" });
    return send(res, 404, { message: `Not emulated: ${req.method} ${p}` });
  } catch (e) {
    console.error(e);
    return send(res, 500, { message: String(e?.message ?? e) });
  }
}).listen(PORT, () => console.log(`local Supabase test gateway on http://localhost:${PORT}`));
