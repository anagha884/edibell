/**
 * Test harness that calls the EDIBELL database API exactly the way Supabase's
 * Data API (PostgREST) does: one transaction per call, `SET LOCAL ROLE
 * authenticated|anon`, and the caller's JWT claims in `request.jwt.claims`.
 * That means RLS policies, grants and SECURITY DEFINER functions are all
 * exercised for real against PostgreSQL.
 */
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.EDIBELL_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/edibell_test",
  max: 12,
});

export type Caller = { id: string | null; role: "authenticated" | "anon" };
export const anon: Caller = { id: null, role: "anon" };
export const as = (id: string): Caller => ({ id, role: "authenticated" });

/** Run SQL as a browser client. Returns rows or throws the Postgres error. */
export async function q<T = Record<string, unknown>>(who: Caller, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${who.role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who.id ? { sub: who.id, role: who.role } : { role: "anon" })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Call a public RPC function with JSON-able args and return its single value. */
export async function rpc<T = any>(who: Caller, fn: string, ...args: unknown[]): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await q<{ v: T }>(who, `select public.${fn}(${placeholders}) as v`, args.map(a => (a !== null && typeof a === "object" && !Array.isArray(a) ? JSON.stringify(a) : a)));
  return rows[0].v;
}

/** Superuser access, used only to set up fixtures (e.g. what GoTrue does on sign-up). */
export async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

let seq = 0;
/** Equivalent of supabase.auth.signUp({ email, password, options: { data: meta } }). */
export async function signUp(meta: Record<string, unknown>, email?: string): Promise<string> {
  const e = email ?? `user${Date.now()}_${++seq}@example.org`;
  const rows = await admin<{ id: string }>("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [e, JSON.stringify(meta)]);
  return rows[0].id;
}

export const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export function donorMeta(over: Record<string, unknown> = {}) {
  return { role: "donor", contactName: "Asha Rao", orgName: "Green Valley Hotel", orgType: "Hotel", phone: "+91 90000 00001", address: "12 MG Road", area: "Indiranagar", city: "Bengaluru", pincode: "560038", ...over };
}
export function ngoMeta(over: Record<string, unknown> = {}) {
  return { role: "ngo", contactName: "Ravi Kumar", orgName: "Hope Community Kitchen", orgType: "Community Kitchen", phone: "+91 90000 00002", address: "4 Church St", area: "Shivajinagar", city: "Bengaluru", capacity: 120, registrationNo: "KA/TRUST/123", ...over };
}
export function animalMeta(over: Record<string, unknown> = {}) {
  return { role: "animal", contactName: "Meera Iyer", orgName: "Happy Paws Shelter", orgType: "Animal Shelter", phone: "+91 90000 00003", address: "8 Lake Rd", area: "HSR Layout", city: "Bengaluru", capacity: 60, species: ["Dogs", "Cattle / Cows"], ...over };
}

export function humanListing(over: Record<string, unknown> = {}) {
  return {
    destination: "human", title: "Vegetable biryani", category: "Cooked meals", description: "Freshly cooked, untouched", quantity: 10, unit: "kg",
    dietType: "vegetarian", foodOrigin: "cooked-not-served", foodState: "hot", packaging: "Covered trays / vessels", storage: "Kept hot (above 60°C)",
    ingredients: "Rice, vegetables, spices", allergens: [], preparedAt: hours(-1), expiryAt: hours(6), readyAt: hours(0), pickupStart: hours(0.5), pickupEnd: hours(3),
    address: "12 MG Road, Indiranagar, Bengaluru", area: "Indiranagar", city: "Bengaluru", pincode: "560038", latitude: 12.9784, longitude: 77.6408,
    pickupContactName: "Asha Rao", pickupContactPhone: "+91 90000 00001",
    safetyChecklist: { hygienic: true, temperatureControlled: true, notServed: true, notSpoiled: true }, photos: [], ...over,
  };
}
export function animalListing(over: Record<string, unknown> = {}) {
  return {
    destination: "animal", title: "Raw vegetable trimmings", category: "Raw vegetable trimmings", quantity: 15, unit: "kg",
    foodOrigin: "untouched-surplus", foodState: "not-applicable", packaging: "Bags / loose", storage: "Room temperature, dry place",
    ingredients: "Cabbage leaves, carrot peels", animalSpecies: ["Cattle / Cows", "Goats & sheep"], preparedAt: hours(-2), expiryAt: hours(10),
    readyAt: hours(0), pickupStart: hours(0.5), pickupEnd: hours(4), address: "12 MG Road", area: "Indiranagar", city: "Bengaluru",
    pickupContactName: "Asha Rao", pickupContactPhone: "+91 90000 00001",
    safetyChecklist: { notSpoiled: true, noToxicItems: true, noCookedBones: true, lowSaltSpice: true }, ...over,
  };
}

/** Assert that a promise rejects with a Postgres error whose message matches. */
export async function rejects(p: Promise<unknown>, re: RegExp): Promise<string> {
  try { await p; } catch (e) {
    const m = (e as Error).message;
    if (!re.test(m)) throw new Error(`Expected error matching ${re}, got: ${m}`);
    return m;
  }
  throw new Error(`Expected rejection matching ${re}, but it succeeded`);
}
