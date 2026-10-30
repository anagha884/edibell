/**
 * EDIBELL domain logic. Pure Node (no Express) so it can be unit-tested directly.
 * Every state change happens inside `transact()`: validate first, then mutate.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ALLERGENS, ANIMAL_CATEGORIES, ANIMAL_SPECIES, DIET_TYPES, FOOD_ORIGINS, FOOD_STATES, HUMAN_CATEGORIES,
  IMPACT_ASSUMPTIONS, KG_CO2E_PER_KG_FOOD, KG_PER_MEAL, QR_PREFIX, ROLE_DESTINATION, UNITS, parsePickupCode, toKg,
  type Availability, type Destination, type DonationDTO, type ImpactDTO, type NotificationDTO, type OrgSummary,
  type QrDTO, type QrState, type RequestDTO, type Role, type ScanFailure, type ScanResult, type Unit, type UserDTO,
  type AnimalNeedDTO, type PublicStats,
} from "../../shared/edibell";
import {
  UPLOAD_DIR, getDb, newId, transact,
  type Db, type DonationRec, type NeedRec, type RequestRec, type UserRec,
} from "./store";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const bad = (m: string) => new HttpError(400, m);
const forbidden = (m: string) => new HttpError(403, m);
const notFound = (m = "Not found") => new HttpError(404, m);
const conflict = (m: string) => new HttpError(409, m);

const GRACE_MS = 30 * 60 * 1000; // QR stays valid 30 min after the pickup window closes
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// tiny validators (no external deps)
// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
function str(o: Obj, k: string, opts: { required?: boolean; max?: number; label?: string } = {}): string {
  const label = opts.label ?? k;
  const v = o[k];
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  if (opts.required && !s) throw bad(`${label} is required.`);
  if (s.length > (opts.max ?? 2000)) throw bad(`${label} is too long.`);
  return s;
}
function num(o: Obj, k: string, opts: { required?: boolean; min?: number; max?: number; label?: string } = {}): number | null {
  const label = opts.label ?? k;
  const v = o[k];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw bad(`${label} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
  if (opts.min !== undefined && n < opts.min) throw bad(`${label} must be at least ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw bad(`${label} must be at most ${opts.max}.`);
  return n;
}
function oneOf<T extends string>(o: Obj, k: string, list: readonly T[], label = k): T {
  const v = str(o, k, { required: true, label });
  if (!(list as readonly string[]).includes(v)) throw bad(`${label} is not valid.`);
  return v as T;
}
function strArr(o: Obj, k: string, allowed?: readonly string[], max = 20): string[] {
  const v = o[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${k} must be a list.`);
  const out = Array.from(new Set(v.map(x => String(x).trim()).filter(Boolean)));
  if (out.length > max) throw bad(`${k} has too many entries.`);
  if (allowed) for (const x of out) if (!allowed.includes(x)) throw bad(`${k} contains an unknown option: ${x}`);
  return out;
}
function date(o: Obj, k: string, label: string, required = true): string {
  const s = str(o, k, { required, label });
  if (!s) return "";
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw bad(`${label} is not a valid date/time.`);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// passwords & sessions
// ---------------------------------------------------------------------------
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function registerUser(input: unknown): UserDTO {
  const o = asObj(input);
  const role = oneOf(o, "role", ["donor", "ngo", "animal"] as const, "Account type");
  const email = str(o, "email", { required: true, max: 200, label: "Email" }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid email address.");
  const password = str(o, "password", { required: true, max: 200, label: "Password" });
  if (password.length < 8) throw bad("Password must be at least 8 characters.");
  const contactName = str(o, "contactName", { required: true, max: 120, label: "Contact person" });
  const orgName = str(o, "orgName", { required: true, max: 160, label: "Organization name" });
  const city = str(o, "city", { required: true, max: 100, label: "City" });
  const salt = crypto.randomBytes(16).toString("hex");
  return transact(db => {
    if (db.users.some(u => u.email === email)) throw conflict("An account with this email already exists.");
    const u: UserRec = {
      id: newId("usr"), role, email, salt, passwordHash: hashPassword(password, salt),
      contactName, orgName, orgType: str(o, "orgType", { max: 80 }), phone: str(o, "phone", { max: 40 }),
      address: str(o, "address", { max: 300 }), area: str(o, "area", { max: 100 }), city,
      pincode: str(o, "pincode", { max: 12 }),
      capacity: num(o, "capacity", { min: 0, max: 1_000_000 }),
      species: role === "animal" ? strArr(o, "species", ANIMAL_SPECIES) : [],
      registrationNo: str(o, "registrationNo", { max: 80 }), about: str(o, "about", { max: 600 }),
      createdAt: nowIso(),
    };
    db.users.push(u);
    pushNotification(db, u.id, "welcome", "Welcome to EDIBELL",
      role === "donor" ? "Create your first donation to start rescuing surplus food."
        : role === "ngo" ? "Browse available food and send your first pickup request."
          : "Browse animal-suitable food and post your feed needs.", ROLE_HOME_PATH[role]);
    return toUserDTO(u);
  });
}

const ROLE_HOME_PATH: Record<Role, string> = { donor: "/donor", ngo: "/ngo", animal: "/animal" };
/** Role-relative deep link for a recipient (NGO / animal org) page. */
const rp = (role: Role, sub: string) => `${ROLE_HOME_PATH[role]}/${sub}`;

export function loginUser(input: unknown): UserDTO {
  const o = asObj(input);
  const email = str(o, "email", { required: true, label: "Email" }).toLowerCase();
  const password = str(o, "password", { required: true, label: "Password" });
  const role = oneOf(o, "role", ["donor", "ngo", "animal"] as const, "Account type");
  const u = getDb().users.find(x => x.email === email);
  // Constant-ish work whether or not the user exists, same message for all failures.
  const salt = u?.salt ?? "0".repeat(32);
  const candidate = Buffer.from(hashPassword(password, salt), "hex");
  const stored = Buffer.from(u?.passwordHash ?? "0".repeat(128), "hex");
  const ok = !!u && candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  if (!ok || !u) throw new HttpError(401, "Incorrect email or password.");
  if (u.role !== role) throw new HttpError(401, `This email is registered as a ${ROLE_LABEL_LOCAL[u.role]}. Choose that account type to log in.`);
  return toUserDTO(u);
}
const ROLE_LABEL_LOCAL: Record<Role, string> = { donor: "Food Donor", ngo: "NGO Partner", animal: "Animal Welfare Organization" };

export function getUser(id: string): UserRec | null {
  return getDb().users.find(u => u.id === id) ?? null;
}

export function toUserDTO(u: UserRec): UserDTO {
  const { passwordHash: _p, salt: _s, ...rest } = u;
  return rest;
}

export function updateProfile(userId: string, input: unknown): UserDTO {
  const o = asObj(input);
  return transact(db => {
    const u = db.users.find(x => x.id === userId);
    if (!u) throw notFound("Account not found");
    const next = {
      contactName: str(o, "contactName", { required: true, max: 120, label: "Contact person" }),
      orgName: str(o, "orgName", { required: true, max: 160, label: "Organization name" }),
      orgType: str(o, "orgType", { max: 80 }), phone: str(o, "phone", { max: 40 }),
      address: str(o, "address", { max: 300 }), area: str(o, "area", { max: 100 }),
      city: str(o, "city", { required: true, max: 100, label: "City" }), pincode: str(o, "pincode", { max: 12 }),
      capacity: num(o, "capacity", { min: 0, max: 1_000_000 }),
      species: u.role === "animal" ? strArr(o, "species", ANIMAL_SPECIES) : [],
      registrationNo: str(o, "registrationNo", { max: 80 }), about: str(o, "about", { max: 600 }),
    };
    Object.assign(u, next);
    return toUserDTO(u);
  });
}

export function changePassword(userId: string, input: unknown) {
  const o = asObj(input);
  const current = str(o, "currentPassword", { required: true, label: "Current password" });
  const next = str(o, "newPassword", { required: true, max: 200, label: "New password" });
  if (next.length < 8) throw bad("New password must be at least 8 characters.");
  transact(db => {
    const u = db.users.find(x => x.id === userId);
    if (!u) throw notFound("Account not found");
    const a = Buffer.from(hashPassword(current, u.salt), "hex");
    const b = Buffer.from(u.passwordHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, "Current password is incorrect.");
    u.salt = crypto.randomBytes(16).toString("hex");
    u.passwordHash = hashPassword(next, u.salt);
  });
}

// ---------------------------------------------------------------------------
// helpers: DTO building
// ---------------------------------------------------------------------------
function orgSummary(u: UserRec | undefined, reveal: boolean): OrgSummary {
  if (!u) return { id: "", name: "Unknown organization", type: "", role: "donor", capacity: null, species: [], area: "", city: "", about: "" };
  const base: OrgSummary = {
    id: u.id, name: u.orgName, type: u.orgType, role: u.role, capacity: u.capacity, species: u.species,
    area: u.area, city: u.city, about: u.about,
  };
  if (reveal) { base.phone = u.phone; base.address = [u.address, u.area, u.city, u.pincode].filter(Boolean).join(", "); base.contactName = u.contactName; }
  return base;
}

function remainingOf(d: DonationRec): number {
  return Math.max(0, Math.round((d.quantity - d.reserved - d.collected) * 1000) / 1000);
}

function availabilityOf(d: DonationRec, at = Date.now()): Availability {
  if (d.status === "cancelled") return "cancelled";
  if (d.status === "completed") return "completed";
  if (d.status === "expired" || Date.parse(d.pickupEnd) + GRACE_MS < at || Date.parse(d.expiryAt) < at) return "expired";
  return remainingOf(d) <= 0 ? "fully-reserved" : "available";
}

function qrStateOf(r: RequestRec, at = Date.now()): QrState | null {
  if (!r.qrToken) return r.status === "cancelled" ? "cancelled" : null;
  if (r.status === "completed" || r.qrUsedAt) return "used";
  if (r.status === "cancelled" || r.status === "declined") return "cancelled";
  if (r.status === "expired" || (r.qrExpiresAt && Date.parse(r.qrExpiresAt) < at)) return "expired";
  return "valid";
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toDonationDTO(db: Db, d: DonationRec, viewer: { id: string; role: Role }, extra: { reveal?: boolean } = {}): DonationDTO {
  const donor = db.users.find(u => u.id === d.donorId);
  const mine = db.requests.filter(r => r.donationId === d.id && r.requesterId === viewer.id);
  const latest = mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const reveal = viewer.id === d.donorId || !!extra.reveal || mine.some(r => r.status === "accepted" || r.status === "completed");
  const dto: DonationDTO = {
    id: d.id, destination: d.destination, title: d.title, category: d.category, description: d.description,
    quantity: d.quantity, unit: d.unit, remaining: remainingOf(d), reserved: d.reserved, collected: d.collected,
    photos: d.photos, ingredients: d.ingredients, allergens: d.allergens, allergenNotes: d.allergenNotes,
    dietType: d.dietType, foodOrigin: d.foodOrigin, preparedAt: d.preparedAt, foodState: d.foodState,
    packaging: d.packaging, storage: d.storage, handlingNotes: d.handlingNotes, expiryAt: d.expiryAt,
    readyAt: d.readyAt, pickupStart: d.pickupStart, pickupEnd: d.pickupEnd, area: d.area, city: d.city,
    pincode: d.pincode, latitude: reveal ? d.latitude : null, longitude: reveal ? d.longitude : null,
    animalSpecies: d.animalSpecies, animalSafetyConfirmed: d.animalSafetyConfirmed,
    status: d.status, availability: availabilityOf(d), createdAt: d.createdAt,
    donor: orgSummary(donor, reveal),
    myRequest: latest ? { id: latest.id, status: latest.status } : null,
  };
  if (reveal) dto.address = d.address;
  if (viewer.id === d.donorId) dto.pendingRequests = db.requests.filter(r => r.donationId === d.id && r.status === "pending").length;
  return dto;
}

function toRequestDTO(db: Db, r: RequestRec, viewerId: string): RequestDTO {
  const d = db.donations.find(x => x.id === r.donationId)!;
  const donor = db.users.find(u => u.id === r.donorId);
  const requester = db.users.find(u => u.id === r.requesterId);
  const revealToRequester = r.status === "accepted" || r.status === "completed";
  const viewerIsDonor = viewerId === r.donorId;
  const viewerIsRequester = viewerId === r.requesterId;
  return {
    id: r.id, donationId: r.donationId, status: r.status, quantity: r.quantity, unit: d.unit, message: r.message,
    beneficiaries: r.beneficiaries, animalSpecies: r.animalSpecies, animalCount: r.animalCount,
    declineReason: r.declineReason, createdAt: r.createdAt, decidedAt: r.decidedAt, completedAt: r.completedAt,
    qrState: qrStateOf(r), qrExpiresAt: r.qrExpiresAt,
    donation: {
      id: d.id, title: d.title, category: d.category, destination: d.destination, photos: d.photos.slice(0, 1),
      pickupStart: d.pickupStart, pickupEnd: d.pickupEnd, area: d.area, city: d.city,
      address: viewerIsDonor || (viewerIsRequester && revealToRequester) ? d.address : undefined,
      unit: d.unit, quantity: d.quantity, foodState: d.foodState, allergens: d.allergens, expiryAt: d.expiryAt,
      animalSpecies: d.animalSpecies, status: d.status,
    },
    // Donors always see who is asking (name, type, capacity); contact details once accepted.
    requester: orgSummary(requester, viewerIsDonor && (r.status === "accepted" || r.status === "completed")),
    donor: orgSummary(donor, viewerIsRequester && revealToRequester),
  };
}

function pushNotification(db: Db, userId: string, type: string, title: string, body: string, link = "") {
  db.notifications.push({ id: newId("ntf"), userId, type, title, body, link, read: false, createdAt: nowIso() });
}

// ---------------------------------------------------------------------------
// expiry sweep (cheap; call at the start of API requests)
// ---------------------------------------------------------------------------
export function sweepExpired() {
  const at = Date.now();
  const db = getDb();
  const needs =
    db.requests.some(r => (r.status === "pending" || r.status === "accepted") && (() => {
      const d = db.donations.find(x => x.id === r.donationId);
      return !d || availabilityOf(d, at) === "expired" || (r.qrExpiresAt ? Date.parse(r.qrExpiresAt) < at : false);
    })()) || db.donations.some(d => d.status === "active" && availabilityOf(d, at) === "expired");
  if (!needs) return;
  transact(w => {
    for (const r of w.requests) {
      if (r.status !== "pending" && r.status !== "accepted") continue;
      const d = w.donations.find(x => x.id === r.donationId);
      if (!d) continue;
      const donationExpired = availabilityOf(d, at) === "expired";
      const qrExpired = r.qrExpiresAt ? Date.parse(r.qrExpiresAt) < at : false;
      if (donationExpired || qrExpired) {
        if (r.status === "accepted") d.reserved = Math.max(0, round(d.reserved - r.quantity));
        r.status = "expired"; r.updatedAt = nowIso();
        pushNotification(w, r.requesterId, "request-expired", "Pickup request expired",
          `Your request for "${d.title}" expired before pickup was completed.`, rp(r.requesterRole, "requests"));
      }
    }
    for (const d of w.donations) if (d.status === "active" && availabilityOf(d, at) === "expired") d.status = d.collected > 0 ? "completed" : "expired";
  });
}
const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// photos
// ---------------------------------------------------------------------------
const MAX_PHOTO_BYTES = 900 * 1024;
function savePhotos(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw bad("Photos must be a list.");
  if (input.length > 4) throw bad("You can attach up to 4 photos.");
  const urls: string[] = [];
  for (const item of input) {
    const s = String(item);
    if (/^\/api\/edibell\/uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(s)) { urls.push(s); continue; }
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m) throw bad("Photos must be JPEG, PNG or WebP images.");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_PHOTO_BYTES) throw bad("Each photo must be under 900 KB.");
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    urls.push(`/api/edibell/uploads/${name}`);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// donations
// ---------------------------------------------------------------------------
export function createDonation(donorId: string, input: unknown): DonationDTO {
  const o = asObj(input);
  const destination = oneOf(o, "destination", ["human", "animal"] as const, "Food is for");
  const categories: readonly string[] = destination === "human" ? HUMAN_CATEGORIES : ANIMAL_CATEGORIES;
  const title = str(o, "title", { required: true, max: 120, label: "Food name" });
  const category = oneOf(o, "category", categories as readonly string[], "Food category");
  const quantity = num(o, "quantity", { required: true, min: 0.01, max: 100000, label: "Quantity" })!;
  const unit = oneOf(o, "unit", UNITS, "Unit");
  const foodState = oneOf(o, "foodState", FOOD_STATES, "Food state");
  const foodOrigin = oneOf(o, "foodOrigin", FOOD_ORIGINS, "Food origin");
  const preparedAt = date(o, "preparedAt", "Preparation date & time");
  const expiryAt = date(o, "expiryAt", "Safe-use deadline");
  const readyAt = date(o, "readyAt", "Ready for collection");
  const pickupStart = date(o, "pickupStart", "Pickup window start");
  const pickupEnd = date(o, "pickupEnd", "Pickup window end");
  const address = str(o, "address", { required: true, max: 300, label: "Pickup address" });
  const area = str(o, "area", { required: true, max: 100, label: "Area" });
  const city = str(o, "city", { required: true, max: 100, label: "City" });
  const t = (s: string) => Date.parse(s);
  const now = Date.now();
  if (t(pickupEnd) <= t(pickupStart)) throw bad("Pickup window end must be after its start.");
  if (t(pickupEnd) <= now) throw bad("Pickup window must end in the future.");
  if (t(readyAt) > t(pickupEnd)) throw bad("Ready-for-collection time must be before the pickup window ends.");
  if (t(preparedAt) > now + 5 * 60_000) throw bad("Preparation time cannot be in the future.");
  if (t(expiryAt) <= now) throw bad("The safe-use deadline has already passed.");
  if (t(expiryAt) < t(pickupStart)) throw bad("Food must stay safe at least until the pickup window starts.");

  let dietType: DonationRec["dietType"] = null;
  let animalSpecies: string[] = [];
  let animalSafetyConfirmed = false;
  if (destination === "human") {
    dietType = oneOf(o, "dietType", DIET_TYPES, "Diet type");
    if (foodOrigin === "plate-leftover") throw bad("Food left on plates or returned by customers can't go to people. Choose 'Animal feed' and list suitable species instead.");
    if (o.humanSafetyConfirmed !== true) throw bad("Please confirm the human-food safety declaration.");
  } else {
    animalSpecies = strArr(o, "animalSpecies", ANIMAL_SPECIES);
    if (animalSpecies.length === 0) throw bad("Select at least one animal species this food is suitable for.");
    if (o.animalSafetyConfirmed !== true) throw bad("Please confirm the food is free of chocolate, alcohol, xylitol, spoiled items and cooked bones.");
    animalSafetyConfirmed = true;
  }
  const record: DonationRec = {
    id: newId("don"), donorId, destination, title, category,
    description: str(o, "description", { max: 1500 }), quantity, unit, reserved: 0, collected: 0,
    photos: savePhotos(o.photos),
    ingredients: str(o, "ingredients", { max: 1000 }),
    allergens: strArr(o, "allergens", ALLERGENS), allergenNotes: str(o, "allergenNotes", { max: 400 }),
    dietType, foodOrigin, preparedAt, foodState,
    packaging: str(o, "packaging", { required: true, max: 120, label: "Packaging status" }),
    storage: str(o, "storage", { required: true, max: 160, label: "Storage / handling" }),
    handlingNotes: str(o, "handlingNotes", { max: 600 }),
    expiryAt, readyAt, pickupStart, pickupEnd, address, area, city, pincode: str(o, "pincode", { max: 12 }),
    latitude: num(o, "latitude", { min: -90, max: 90 }), longitude: num(o, "longitude", { min: -180, max: 180 }),
    animalSpecies, animalSafetyConfirmed, status: "active", createdAt: nowIso(),
  };
  return transact(db => {
    db.donations.push(record);
    pushNotification(db, donorId, "donation-created", "Donation published",
      `"${title}" is now visible to ${destination === "human" ? "NGO partners" : "animal welfare organizations"}.`, "/donor/donations");
    // Tell matching recipients.
    const recipientRole: Role = destination === "human" ? "ngo" : "animal";
    for (const u of db.users) {
      if (u.role !== recipientRole) continue;
      if (u.city && u.city.toLowerCase() !== city.toLowerCase()) continue;
      pushNotification(db, u.id, "new-donation", "New food available",
        `${title} · ${quantity} ${unit} in ${area}, ${city}`, rp(u.role, "finder"));
    }
    return toDonationDTO(db, record, { id: donorId, role: "donor" });
  });
}

export function listMyDonations(donorId: string): DonationDTO[] {
  const db = getDb();
  return db.donations.filter(d => d.donorId === donorId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(d => toDonationDTO(db, d, { id: donorId, role: "donor" }));
}

export function cancelDonation(donorId: string, donationId: string) {
  transact(db => {
    const d = db.donations.find(x => x.id === donationId);
    if (!d || d.donorId !== donorId) throw notFound("Donation not found");
    if (d.status !== "active") throw conflict(`This donation is already ${d.status}.`);
    d.status = d.collected > 0 ? "completed" : "cancelled";
    for (const r of db.requests) {
      if (r.donationId !== d.id || (r.status !== "pending" && r.status !== "accepted")) continue;
      r.status = "cancelled"; r.updatedAt = nowIso();
      pushNotification(db, r.requesterId, "donation-cancelled", "Donation cancelled by donor",
        `"${d.title}" is no longer available.`, rp(r.requesterRole, "requests"));
    }
    d.reserved = 0;
  });
}

// Marketplace -----------------------------------------------------------------
export interface MarketQuery {
  q?: string; category?: string; species?: string; location?: string; availability?: string;
  minQty?: string; maxDistanceKm?: string; lat?: string; lng?: string;
  pickupFrom?: string; pickupTo?: string; sort?: string; diet?: string; foodState?: string;
}

export function browseMarket(viewer: { id: string; role: Role }, q: MarketQuery): DonationDTO[] {
  if (viewer.role === "donor") throw forbidden("Donors can't browse the marketplace.");
  const dest = ROLE_DESTINATION[viewer.role];
  const db = getDb();
  const at = Date.now();
  const text = (q.q ?? "").toLowerCase().trim();
  const loc = (q.location ?? "").toLowerCase().trim();
  const minQty = q.minQty ? Number(q.minQty) : 0;
  const origin = q.lat && q.lng && Number.isFinite(Number(q.lat)) && Number.isFinite(Number(q.lng))
    ? { lat: Number(q.lat), lng: Number(q.lng) } : null;
  const maxKm = q.maxDistanceKm ? Number(q.maxDistanceKm) : null;
  const from = q.pickupFrom ? Date.parse(q.pickupFrom) : NaN;
  const to = q.pickupTo ? Date.parse(q.pickupTo) : NaN;
  const wantAll = q.availability === "all";

  const rows = db.donations
    .filter(d => d.destination === dest && d.status === "active")
    .filter(d => { const a = availabilityOf(d, at); return a === "available" || (wantAll && a === "fully-reserved"); })
    .filter(d => !text || [d.title, d.description, d.ingredients, d.category, d.area, d.city,
      db.users.find(u => u.id === d.donorId)?.orgName ?? ""].join(" ").toLowerCase().includes(text))
    .filter(d => !q.category || d.category === q.category)
    .filter(d => !q.species || d.animalSpecies.includes(q.species))
    .filter(d => !q.diet || d.dietType === q.diet)
    .filter(d => !q.foodState || d.foodState === q.foodState)
    .filter(d => !loc || `${d.area} ${d.city} ${d.pincode}`.toLowerCase().includes(loc))
    .filter(d => !minQty || remainingOf(d) >= minQty)
    .filter(d => Number.isNaN(from) || Date.parse(d.pickupEnd) >= from)
    .filter(d => Number.isNaN(to) || Date.parse(d.pickupStart) <= to)
    .map(d => {
      const dto = toDonationDTO(db, d, viewer);
      dto.distanceKm = origin && d.latitude != null && d.longitude != null
        ? round(haversineKm(origin, { lat: d.latitude, lng: d.longitude })) : null;
      return dto;
    })
    .filter(d => maxKm === null || d.distanceKm == null || d.distanceKm <= maxKm);

  const sort = q.sort ?? "soonest";
  rows.sort((a, b) => {
    if (sort === "nearest") return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    if (sort === "newest") return b.createdAt.localeCompare(a.createdAt);
    if (sort === "quantity") return b.remaining - a.remaining;
    if (sort === "expiry") return a.expiryAt.localeCompare(b.expiryAt);
    return a.pickupStart.localeCompare(b.pickupStart);
  });
  return rows;
}

export function getDonationFor(viewer: { id: string; role: Role }, id: string): DonationDTO {
  const db = getDb();
  const d = db.donations.find(x => x.id === id);
  if (!d) throw notFound("Donation not found");
  if (viewer.role === "donor") {
    if (d.donorId !== viewer.id) throw notFound("Donation not found");
  } else if (d.destination !== ROLE_DESTINATION[viewer.role]) {
    throw notFound("Donation not found");
  }
  return toDonationDTO(db, d, viewer);
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------
export function createRequest(requester: { id: string; role: Role }, input: unknown): RequestDTO {
  if (requester.role === "donor") throw forbidden("Donor accounts can't request donations.");
  const o = asObj(input);
  const donationId = str(o, "donationId", { required: true, label: "Donation" });
  const message = str(o, "message", { max: 600 });
  const quantity = num(o, "quantity", { required: true, min: 0.01, label: "Quantity" })!;
  const beneficiaries = num(o, "beneficiaries", { min: 0, max: 1_000_000 });
  const animalCount = num(o, "animalCount", { min: 0, max: 1_000_000 });
  return transact(db => {
    const d = db.donations.find(x => x.id === donationId);
    if (!d || d.destination !== ROLE_DESTINATION[requester.role as "ngo" | "animal"]) throw notFound("Donation not found");
    const availability = availabilityOf(d);
    if (availability !== "available") throw conflict(availability === "fully-reserved"
      ? "All of this food has already been reserved." : `This donation is ${availability}.`);
    const remaining = remainingOf(d);
    if (quantity > remaining + 1e-9) throw bad(`Only ${remaining} ${d.unit} is still available.`);
    if (db.requests.some(r => r.donationId === d.id && r.requesterId === requester.id && (r.status === "pending" || r.status === "accepted")))
      throw conflict("You already have an active request for this donation.");
    let animalSpecies: string[] = [];
    if (requester.role === "animal") {
      animalSpecies = strArr(o, "animalSpecies", ANIMAL_SPECIES);
      if (animalSpecies.length === 0) throw bad("Select which animals this food is for.");
      const overlap = animalSpecies.filter(s => d.animalSpecies.includes(s));
      if (overlap.length !== animalSpecies.length) throw bad("The donor marked this food as suitable only for: " + d.animalSpecies.join(", ") + ".");
    }
    const r: RequestRec = {
      id: newId("req"), donationId: d.id, donorId: d.donorId, requesterId: requester.id,
      requesterRole: requester.role as "ngo" | "animal", quantity: round(quantity), message,
      beneficiaries, animalSpecies, animalCount, status: "pending",
      qrToken: null, qrIssuedAt: null, qrExpiresAt: null, qrUsedAt: null, declineReason: "",
      createdAt: nowIso(), updatedAt: nowIso(), decidedAt: null, completedAt: null,
    };
    db.requests.push(r);
    const org = db.users.find(u => u.id === requester.id)!;
    pushNotification(db, d.donorId, "request-received", "New pickup request",
      `${org.orgName} requested ${r.quantity} ${d.unit} of "${d.title}".`, "/donor/requests");
    return toRequestDTO(db, r, requester.id);
  });
}

export function listRequestsFor(user: { id: string; role: Role }, status?: string): RequestDTO[] {
  const db = getDb();
  const mine = db.requests.filter(r => (user.role === "donor" ? r.donorId : r.requesterId) === user.id)
    .filter(r => !status || status === "all" || r.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine.map(r => toRequestDTO(db, r, user.id));
}

export function decideRequest(donorId: string, requestId: string, input: unknown): RequestDTO {
  const o = asObj(input);
  const decision = oneOf(o, "decision", ["accept", "decline"] as const, "Decision");
  const reason = str(o, "reason", { max: 300 });
  return transact(db => {
    const r = db.requests.find(x => x.id === requestId);
    if (!r || r.donorId !== donorId) throw notFound("Request not found");
    const d = db.donations.find(x => x.id === r.donationId)!;
    if (r.status !== "pending") throw conflict(`This request is already ${r.status}.`);
    if (decision === "decline") {
      r.status = "declined"; r.declineReason = reason; r.decidedAt = nowIso(); r.updatedAt = nowIso();
      pushNotification(db, r.requesterId, "request-declined", "Request declined",
        `"${d.title}" — ${reason || "the donor couldn't fulfil this request."}`, rp(r.requesterRole, "requests"));
      return toRequestDTO(db, r, donorId);
    }
    const availability = availabilityOf(d);
    if (availability === "expired" || availability === "cancelled" || availability === "completed")
      throw conflict(`This donation is ${availability}, so the request can't be accepted.`);
    if (r.quantity > remainingOf(d) + 1e-9) throw conflict(`Only ${remainingOf(d)} ${d.unit} is left — decline this request or ask the NGO to reduce it.`);
    d.reserved = round(d.reserved + r.quantity);
    r.status = "accepted"; r.decidedAt = nowIso(); r.updatedAt = nowIso();
    r.qrToken = generatePickupCode();           // created exactly once, here
    r.qrIssuedAt = nowIso();
    r.qrExpiresAt = new Date(Date.parse(d.pickupEnd) + GRACE_MS).toISOString();
    pushNotification(db, r.requesterId, "request-accepted", "Request accepted — your pickup QR is ready",
      `Show your pickup QR at ${d.area}, ${d.city} during the pickup window.`, rp(r.requesterRole, "pickup"));
    return toRequestDTO(db, r, donorId);
  });
}

export function cancelRequest(requesterId: string, requestId: string): RequestDTO {
  return transact(db => {
    const r = db.requests.find(x => x.id === requestId);
    if (!r || r.requesterId !== requesterId) throw notFound("Request not found");
    if (r.status !== "pending" && r.status !== "accepted") throw conflict(`A ${r.status} request can't be cancelled.`);
    const d = db.donations.find(x => x.id === r.donationId)!;
    if (r.status === "accepted") d.reserved = Math.max(0, round(d.reserved - r.quantity));
    r.status = "cancelled"; r.updatedAt = nowIso();   // token stays on record but is now rejected by scan()
    const org = db.users.find(u => u.id === requesterId)!;
    pushNotification(db, r.donorId, "request-cancelled", "Request cancelled",
      `${org.orgName} cancelled their request for "${d.title}".`, "/donor/requests");
    return toRequestDTO(db, r, requesterId);
  });
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function generatePickupCode(): string {
  const bytes = crypto.randomBytes(20);            // 100 bits of entropy are used
  let out = "";
  for (let i = 0; i < 20; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

/** Recipient-only. Returns the SAME code every time; never creates a new one. */
export function getPickupQr(requester: { id: string; role: Role }, requestId: string): QrDTO {
  if (requester.role === "donor") throw forbidden("Only NGOs and animal welfare organizations have pickup QR codes.");
  const db = getDb();
  const r = db.requests.find(x => x.id === requestId);
  if (!r || r.requesterId !== requester.id) throw notFound("Request not found");   // never reveal other orgs' codes
  const state = qrStateOf(r);
  if (!r.qrToken) throw conflict("A QR code is created only after the donor accepts your request.");
  const live = state === "valid";
  return {
    requestId: r.id, state: state ?? "cancelled",
    code: live ? r.qrToken : null,
    payload: live ? QR_PREFIX + r.qrToken : null,
    expiresAt: r.qrExpiresAt, usedAt: r.qrUsedAt,
    request: toRequestDTO(db, r, requester.id),
  };
}

const failures = new Map<string, { count: number; lockedUntil: number; windowStart: number }>();
const MAX_FAILS = 8, WINDOW_MS = 10 * 60_000, LOCK_MS = 10 * 60_000;
export function resetScanLimiterForTests() { failures.clear(); }

function noteFailure(donorId: string) {
  const at = Date.now();
  const f = failures.get(donorId) ?? { count: 0, lockedUntil: 0, windowStart: at };
  if (at - f.windowStart > WINDOW_MS) { f.count = 0; f.windowStart = at; }
  f.count += 1;
  if (f.count >= MAX_FAILS) f.lockedUntil = at + LOCK_MS;
  failures.set(donorId, f);
}

const MESSAGES: Record<ScanFailure, string> = {
  invalid: "Invalid QR code. It wasn't issued by EDIBELL or can't be recognised.",
  expired: "This QR code has expired. Ask the organization to contact you and re-arrange pickup.",
  used: "This QR code was already used. The donation has been collected.",
  cancelled: "This pickup was cancelled, so the QR code is no longer valid.",
  mismatched: "This QR code belongs to a different donor's donation. Do not hand over this food.",
  "not-accepted": "This request has not been accepted, so it can't be completed.",
  "rate-limited": "Too many failed scans. Please wait a few minutes and try again.",
};

/**
 * Donor-only. The ONLY way a donation pickup becomes "completed".
 * Runs as one synchronous transaction, so two simultaneous scans of the same code
 * cannot both succeed: the second sees status === "completed".
 */
export function scanPickupCode(donorId: string, raw: unknown): ScanResult {
  const fail = (failure: ScanFailure, countIt = true): ScanResult => {
    if (countIt) noteFailure(donorId);
    return { ok: false, failure, message: MESSAGES[failure] };
  };
  const lock = failures.get(donorId);
  if (lock && lock.lockedUntil > Date.now()) return fail("rate-limited", false);

  const code = parsePickupCode(typeof raw === "string" ? raw : "");
  if (!code) return fail("invalid");

  return transact((db): ScanResult => {
    const match = db.requests.find(r => {
      if (!r.qrToken) return false;
      const a = Buffer.from(r.qrToken), b = Buffer.from(code);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!match) return fail("invalid");
    if (match.donorId !== donorId) return fail("mismatched");
    const d = db.donations.find(x => x.id === match.donationId);
    if (!d || d.donorId !== donorId) return fail("mismatched");
    if (match.status === "completed" || match.qrUsedAt) return fail("used");
    if (match.status === "cancelled" || match.status === "declined" || d.status === "cancelled") return fail("cancelled");
    if (match.status === "expired" || (match.qrExpiresAt && Date.parse(match.qrExpiresAt) < Date.now())) return fail("expired");
    if (match.status !== "accepted") return fail("not-accepted");

    // --- all checks passed: complete exactly once ---
    const at = nowIso();
    match.status = "completed"; match.qrUsedAt = at; match.completedAt = at; match.updatedAt = at;
    d.reserved = Math.max(0, round(d.reserved - match.quantity));
    d.collected = round(d.collected + match.quantity);
    if (d.collected + 1e-9 >= d.quantity) d.status = "completed";
    const org = db.users.find(u => u.id === match.requesterId);
    pushNotification(db, match.requesterId, "pickup-completed", "Pickup confirmed",
      `${d.title} (${match.quantity} ${d.unit}) was handed over and verified.`, rp(match.requesterRole, "history"));
    pushNotification(db, donorId, "pickup-completed", "Donation handed over",
      `${org?.orgName ?? "The organization"} collected ${match.quantity} ${d.unit} of "${d.title}".`, "/donor/donations");
    failures.delete(donorId);
    return { ok: true, message: `Pickup verified. ${match.quantity} ${d.unit} of ${d.title} handed to ${org?.orgName ?? "the organization"}.`, request: toRequestDTO(db, match, donorId) };
  });
}

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------
export function impactFor(user: { id: string; role: Role }): ImpactDTO {
  const db = getDb();
  const donations = user.role === "donor" ? db.donations.filter(d => d.donorId === user.id) : [];
  const completedReqs = db.requests.filter(r => r.status === "completed" && (user.role === "donor" ? r.donorId : r.requesterId) === user.id);
  const dById = new Map(db.donations.map(d => [d.id, d]));
  let humanKg = 0, animalKg = 0;
  const byCat = new Map<string, number>(), byMonth = new Map<string, number>(), bySpecies = new Map<string, number>();
  for (const r of completedReqs) {
    const d = dById.get(r.donationId)!;
    const kg = toKg(r.quantity, d.unit as Unit);
    if (d.destination === "human") humanKg += kg; else animalKg += kg;
    byCat.set(d.category, (byCat.get(d.category) ?? 0) + kg);
    const m = (r.completedAt ?? r.createdAt).slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + kg);
    if (d.destination === "animal") for (const s of (r.animalSpecies.length ? r.animalSpecies : d.animalSpecies)) bySpecies.set(s, (bySpecies.get(s) ?? 0) + kg / Math.max(1, (r.animalSpecies.length || d.animalSpecies.length)));
  }
  const totalListedKg = donations.reduce((s, d) => s + toKg(d.quantity, d.unit), 0);
  const arr = (m: Map<string, number>, k: string, v: string) => [...m].map(([a, b]) => ({ [k]: a, [v]: round(b) })) as never;
  const completedKg = humanKg + animalKg;
  return {
    totalDonations: donations.length,
    completedDonations: donations.filter(d => d.status === "completed").length,
    totalFoodKg: round(totalListedKg), completedFoodKg: round(completedKg),
    humanFoodKg: round(humanKg), animalFeedKg: round(animalKg),
    mealsSupported: Math.round(humanKg / KG_PER_MEAL),
    co2eAvoidedKg: round(completedKg * KG_CO2E_PER_KG_FOOD),
    completedPickups: completedReqs.length,
    pendingRequests: db.requests.filter(r => r.status === "pending" && (user.role === "donor" ? r.donorId : r.requesterId) === user.id).length,
    activeListings: donations.filter(d => availabilityOf(d) === "available").length,
    byCategory: (arr(byCat, "category", "kg") as { category: string; kg: number }[]).sort((a, b) => b.kg - a.kg),
    byMonth: (arr(byMonth, "month", "kg") as { month: string; kg: number }[]).sort((a, b) => a.month.localeCompare(b.month)),
    bySpecies: (arr(bySpecies, "species", "kg") as { species: string; kg: number }[]).sort((a, b) => b.kg - a.kg),
    assumptions: IMPACT_ASSUMPTIONS,
  };
}

export function publicStats(): PublicStats {
  const db = getDb();
  const completed = db.requests.filter(r => r.status === "completed");
  const dById = new Map(db.donations.map(d => [d.id, d]));
  const kg = completed.reduce((s, r) => s + toKg(r.quantity, dById.get(r.donationId)!.unit), 0);
  return {
    donors: db.users.filter(u => u.role === "donor").length,
    ngos: db.users.filter(u => u.role === "ngo").length,
    animalOrgs: db.users.filter(u => u.role === "animal").length,
    completedPickups: completed.length, foodRescuedKg: round(kg),
  };
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------
export function listNotifications(userId: string): NotificationDTO[] {
  return getDb().notifications.filter(n => n.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
    .map(({ userId: _u, ...n }) => n);
}
export function markNotificationsRead(userId: string, ids?: string[]) {
  transact(db => { for (const n of db.notifications) if (n.userId === userId && (!ids || ids.includes(n.id))) n.read = true; });
}

// ---------------------------------------------------------------------------
// animal feed needs ("Animal requests")
// ---------------------------------------------------------------------------
function toNeedDTO(db: Db, n: NeedRec): AnimalNeedDTO {
  return { ...n, org: orgSummary(db.users.find(u => u.id === n.orgId), false) };
}
export function createNeed(orgId: string, input: unknown): AnimalNeedDTO {
  const o = asObj(input);
  const rec: NeedRec = {
    id: newId("need"), orgId, title: str(o, "title", { required: true, max: 120, label: "Title" }),
    species: strArr(o, "species", ANIMAL_SPECIES), animalCount: num(o, "animalCount", { required: true, min: 1, max: 1_000_000, label: "Number of animals" })!,
    categories: strArr(o, "categories", ANIMAL_CATEGORIES),
    quantityPerWeek: num(o, "quantityPerWeek", { required: true, min: 0.1, max: 1_000_000, label: "Quantity per week" })!,
    unit: oneOf(o, "unit", UNITS, "Unit"), notes: str(o, "notes", { max: 600 }), status: "open", createdAt: nowIso(),
  };
  if (rec.species.length === 0) throw bad("Select at least one species.");
  return transact(db => {
    db.needs.push(rec);
    for (const u of db.users) if (u.role === "donor") pushNotification(db, u.id, "animal-need", "New animal feed need",
      `${db.users.find(x => x.id === orgId)!.orgName} needs feed for ${rec.species.join(", ")}.`, "/donor");
    return toNeedDTO(db, rec);
  });
}
export function listNeeds(opts: { orgId?: string; openOnly?: boolean }): AnimalNeedDTO[] {
  const db = getDb();
  return db.needs.filter(n => (!opts.orgId || n.orgId === opts.orgId) && (!opts.openOnly || n.status === "open"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(n => toNeedDTO(db, n));
}
export function closeNeed(orgId: string, id: string) {
  transact(db => {
    const n = db.needs.find(x => x.id === id && x.orgId === orgId);
    if (!n) throw notFound("Need not found");
    n.status = "closed";
  });
}
