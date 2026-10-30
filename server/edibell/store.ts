/**
 * Tiny durable store (JSON file) with synchronous, all-or-nothing transactions.
 *
 * Node runs this code on a single thread and `transact` never awaits, so each
 * transaction is atomic with respect to every other request in this process:
 * the QR "check then mark complete" step cannot interleave with a second scan.
 * Swap this module for MySQL/Postgres (SELECT ... FOR UPDATE) if you scale to
 * more than one server process.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AnimalNeedDTO, DietType, Destination, FoodOrigin, FoodState, RequestStatus, Role, Unit,
} from "../../shared/edibell";

export interface UserRec {
  id: string;
  role: Role;
  email: string;
  passwordHash: string;
  salt: string;
  contactName: string;
  orgName: string;
  orgType: string;
  phone: string;
  address: string;
  area: string;
  city: string;
  pincode: string;
  capacity: number | null;
  species: string[];
  registrationNo: string;
  about: string;
  createdAt: string;
}

export interface DonationRec {
  id: string;
  donorId: string;
  destination: Destination;
  title: string;
  category: string;
  description: string;
  quantity: number;
  unit: Unit;
  reserved: number;
  collected: number;
  photos: string[];
  ingredients: string;
  allergens: string[];
  allergenNotes: string;
  dietType: DietType | null;
  foodOrigin: FoodOrigin;
  preparedAt: string;
  foodState: FoodState;
  packaging: string;
  storage: string;
  handlingNotes: string;
  expiryAt: string;
  readyAt: string;
  pickupStart: string;
  pickupEnd: string;
  address: string;
  area: string;
  city: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
  animalSpecies: string[];
  animalSafetyConfirmed: boolean;
  status: "active" | "completed" | "cancelled" | "expired";
  createdAt: string;
}

export interface RequestRec {
  id: string;
  donationId: string;
  donorId: string;
  requesterId: string;
  requesterRole: "ngo" | "animal";
  quantity: number;
  message: string;
  beneficiaries: number | null;
  animalSpecies: string[];
  animalCount: number | null;
  status: RequestStatus;
  /** Opaque 20-char Crockford base32 pickup code. Created ONCE, when the donor accepts. */
  qrToken: string | null;
  qrIssuedAt: string | null;
  qrExpiresAt: string | null;
  qrUsedAt: string | null;
  declineReason: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  completedAt: string | null;
}

export interface NotificationRec {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export type NeedRec = Omit<AnimalNeedDTO, "org">;

export interface Db {
  version: 1;
  secret: string;
  users: UserRec[];
  donations: DonationRec[];
  requests: RequestRec[];
  notifications: NotificationRec[];
  needs: NeedRec[];
}

export const DATA_DIR = path.resolve(process.env.EDIBELL_DATA_DIR || path.join(process.cwd(), "data"));
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const FILE = path.join(DATA_DIR, "edibell.json");

let current: Db | null = null;

function fresh(): Db {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString("hex"),
    users: [], donations: [], requests: [], notifications: [], needs: [],
  };
}

function persist(db: Db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function getDb(): Db {
  if (current) return current;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    current = JSON.parse(fs.readFileSync(FILE, "utf8")) as Db;
  } else {
    current = fresh();
    persist(current);
  }
  return current;
}

/** Test helper: drop the in-memory copy so the next getDb() reloads from disk. */
export function resetStoreForTests(wipe = false) {
  current = null;
  if (wipe && fs.existsSync(FILE)) fs.rmSync(FILE);
}

/**
 * Run `fn` on a working copy. If it throws, nothing is saved (rollback).
 * If it returns, the copy becomes the live state and is written to disk.
 * `fn` MUST be synchronous.
 */
export function transact<T>(fn: (db: Db) => T): T {
  const live = getDb();
  const work = JSON.parse(JSON.stringify(live)) as Db;
  const result = fn(work);
  if ((result as unknown) instanceof Promise) throw new Error("transact() callbacks must be synchronous");
  persist(work);
  current = work;
  return result;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
