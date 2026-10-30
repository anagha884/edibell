/**
 * REST API for EDIBELL, mounted at /api/edibell.
 * Auth: signed, httpOnly session cookie. Every route declares which roles may call it.
 */
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { Role } from "../../shared/edibell";
import * as D from "./domain";
import { UPLOAD_DIR, getDb } from "./store";

const COOKIE = "edibell_session";
const SESSION_MS = 7 * 24 * 3600 * 1000;

interface Authed extends Request { user?: { id: string; role: Role } }

function sign(payload: string): string {
  return crypto.createHmac("sha256", process.env.EDIBELL_SECRET || getDb().secret).update(payload).digest("base64url");
}
function issueSession(req: Request, res: Response, userId: string) {
  const exp = Date.now() + SESSION_MS;
  const payload = `${userId}.${exp}`;
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: "lax", secure, maxAge: SESSION_MS, path: "/" });
}
function readSession(req: Request): { id: string; role: Role } | null {
  const raw = /(?:^|;\s*)edibell_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  if (!raw) return null;
  const parts = decodeURIComponent(raw).split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = sign(`${id}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || Number(exp) < Date.now()) return null;
  const u = D.getUser(id);
  return u ? { id: u.id, role: u.role } : null;
}

const handler = (fn: (req: Authed, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try { const out = fn(req as Authed, res); if (out !== undefined && !res.headersSent) res.json(out); }
  catch (e) { next(e); }
};
const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: "Please log in." });
  if (!roles.includes(s.role)) return res.status(403).json({ error: "Your account type can't use this feature." });
  (req as Authed).user = s;
  next();
};
const q = (req: Request) => req.query as Record<string, string>;
const param = (req: Request, k: string) => String(req.params[k]);

export function edibellRouter(): Router {
  const r = express.Router();

  // CSRF defence for cookie auth: state-changing calls must be JSON (a cross-site <form> can't send that).
  r.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !req.is("application/json"))
      return res.status(415).json({ error: "Requests must be sent as JSON." });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  r.use((_req, _res, next) => { try { D.sweepExpired(); } catch (e) { console.error("[edibell] sweep failed", e); } next(); });

  r.use("/uploads", express.static(UPLOAD_DIR, { fallthrough: false, index: false, setHeaders: res => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "public, max-age=86400"); } }));

  // --- public -------------------------------------------------------------
  r.get("/stats", handler(() => D.publicStats()));
  r.get("/needs/open", handler(() => D.listNeeds({ openOnly: true })));

  // --- auth ---------------------------------------------------------------
  const authLimiter = new Map<string, { n: number; t: number }>();
  const limit = (req: Request) => {
    const k = req.ip ?? "x"; const now = Date.now(); const e = authLimiter.get(k);
    if (!e || now - e.t > 10 * 60_000) { authLimiter.set(k, { n: 1, t: now }); return; }
    if (++e.n > 30) throw new D.HttpError(429, "Too many attempts. Please wait a few minutes.");
  };
  r.post("/auth/register", handler((req, res) => { limit(req); const u = D.registerUser(req.body); issueSession(req, res, u.id); return { user: u }; }));
  r.post("/auth/login", handler((req, res) => { limit(req); const u = D.loginUser(req.body); issueSession(req, res, u.id); return { user: u }; }));
  r.post("/auth/logout", handler((_req, res) => { res.clearCookie(COOKIE, { path: "/" }); return { ok: true }; }));
  r.get("/auth/me", handler(req => {
    const s = readSession(req);
    const u = s ? D.getUser(s.id) : null;
    return { user: u ? D.toUserDTO(u) : null };
  }));
  r.put("/profile", requireRole("donor", "ngo", "animal"), handler(req => ({ user: D.updateProfile(req.user!.id, req.body) })));
  r.post("/profile/password", requireRole("donor", "ngo", "animal"), handler(req => { D.changePassword(req.user!.id, req.body); return { ok: true }; }));

  // --- donor --------------------------------------------------------------
  const donor = requireRole("donor");
  r.post("/donations", donor, handler(req => D.createDonation(req.user!.id, req.body)));
  r.get("/donations/mine", donor, handler(req => D.listMyDonations(req.user!.id)));
  r.post("/donations/:id/cancel", donor, handler(req => { D.cancelDonation(req.user!.id, param(req, "id")); return { ok: true }; }));
  r.get("/donor/requests", donor, handler(req => D.listRequestsFor(req.user!, q(req).status)));
  r.post("/donor/requests/:id/decision", donor, handler(req => D.decideRequest(req.user!.id, param(req, "id"), req.body)));
  r.post("/donor/scan", donor, handler(req => D.scanPickupCode(req.user!.id, (req.body as { code?: unknown })?.code)));

  // --- recipients (NGO + animal) ------------------------------------------
  const recipient = requireRole("ngo", "animal");
  r.get("/market", recipient, handler(req => D.browseMarket(req.user!, q(req))));
  r.get("/requests/mine", recipient, handler(req => D.listRequestsFor(req.user!, q(req).status)));
  r.post("/requests", recipient, handler(req => D.createRequest(req.user!, req.body)));
  r.post("/requests/:id/cancel", recipient, handler(req => D.cancelRequest(req.user!.id, param(req, "id"))));
  r.get("/requests/:id/qr", recipient, handler(req => D.getPickupQr(req.user!, param(req, "id"))));

  // --- shared by every signed-in role ----------------------------------------
  const anyRole = requireRole("donor", "ngo", "animal");
  r.get("/donations/:id", anyRole, handler(req => D.getDonationFor(req.user!, param(req, "id"))));
  r.get("/impact", anyRole, handler(req => D.impactFor(req.user!)));
  r.get("/notifications", anyRole, handler(req => D.listNotifications(req.user!.id)));
  r.post("/notifications/read", anyRole, handler(req => { D.markNotificationsRead(req.user!.id, (req.body as { ids?: string[] })?.ids); return { ok: true }; }));

  // --- animal feed needs --------------------------------------------------
  const animal = requireRole("animal");
  r.get("/needs/mine", animal, handler(req => D.listNeeds({ orgId: req.user!.id })));
  r.post("/needs", animal, handler(req => D.createNeed(req.user!.id, req.body)));
  r.post("/needs/:id/close", animal, handler(req => { D.closeNeed(req.user!.id, param(req, "id")); return { ok: true }; }));

  // --- errors -------------------------------------------------------------
  r.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof D.HttpError) return res.status(err.status).json({ error: err.message });
    const status = (err as { status?: number })?.status;
    if (status && status < 500) return res.status(status).json({ error: (err as Error).message });
    console.error("[edibell]", err);
    res.status(500).json({ error: "Something went wrong on our side. Please try again." });
  });
  return r;
}
