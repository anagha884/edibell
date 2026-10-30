/**
 * End-to-end tests of the EDIBELL database layer (Supabase migrations) against
 * a real PostgreSQL. Run `pnpm test:db` (see README → "Testing").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin, anon, animalListing, animalMeta, as, donorMeta, hours, humanListing, ngoMeta, pool, q, rejects, rpc, signUp,
} from "./harness";

let donor: string, donor2: string, ngo: string, ngo2: string, shelter: string, adminUser: string;

beforeAll(async () => {
  // Fresh database check: a new installation contains no fabricated activity.
  const counts = await admin<{ n: string }>(`select (select count(*) from public.listings) + (select count(*) from public.requests)
    + (select count(*) from public.pickup_completions) + (select count(*) from public.profiles) as n`);
  expect(Number(counts[0].n)).toBe(0);
  donor = await signUp(donorMeta());
  donor2 = await signUp(donorMeta({ orgName: "Sunrise Bakery", orgType: "Bakery" }));
  ngo = await signUp(ngoMeta());
  ngo2 = await signUp(ngoMeta({ orgName: "Little Stars Orphanage", orgType: "Orphanage" }));
  shelter = await signUp(animalMeta());
  adminUser = await signUp(donorMeta({ orgName: "EDIBELL Ops" }));
  await admin("update public.profiles set is_admin = true where id = $1", [adminUser]); // operator action
});
afterAll(async () => { await pool.end(); });

async function uploadPhoto(owner: string, bucket = "food-photos", folder = owner) {
  const name = `${folder}/${crypto.randomUUID()}.jpg`;
  await q(as(owner), "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, owner]);
  return name;
}

describe("fresh installation", () => {
  it("public stats are honest zeros, available without login", async () => {
    const s = await rpc(anon, "public_stats");
    expect(s).toMatchObject({ completedPickups: 0, foodRescuedKg: 0, donors: 2, ngos: 2, animalOrgs: 1 });
  });
});

describe("registration & profiles", () => {
  it("creates role-specific profiles with pending verification", async () => {
    const me = await rpc(as(ngo), "get_my_profile");
    expect(me).toMatchObject({ role: "ngo", orgName: "Hope Community Kitchen", verificationStatus: "pending", isAdmin: false });
    const s = await rpc(as(shelter), "get_my_profile");
    expect(s.species).toEqual(["Dogs", "Cattle / Cows"]);
  });
  it("rejects admin / unknown roles and incomplete sign-ups", async () => {
    await rejects(signUp({ ...donorMeta(), role: "admin" }), /Account type must be/);
    await rejects(signUp(animalMeta({ species: [] })), /at least one species/);
    await rejects(signUp(ngoMeta({ phone: "" })), /Phone is required/);
    await rejects(signUp(donorMeta({ orgType: "Spaceship" })), /Organization type is not valid/);
  });
  it("profile updates can't change role, admin flag or verification", async () => {
    const out = await rpc(as(donor), "update_my_profile", { ...donorMeta(), role: "ngo", isAdmin: true, verificationStatus: "verified", contactName: "Asha R." });
    expect(out).toMatchObject({ role: "donor", isAdmin: false, verificationStatus: "pending", contactName: "Asha R." });
  });
  it("users can read only their own profile row; anon reads nothing", async () => {
    const rows = await q(as(ngo), "select id from public.profiles");
    expect(rows.map(r => r.id)).toEqual([ngo]);
    await rejects(q(anon, "select * from public.profiles"), /permission denied/);
  });
  it("browser roles can't write tables directly", async () => {
    await rejects(q(as(donor), "update public.profiles set is_admin = true where id = $1", [donor]), /permission denied/);
    await rejects(q(as(donor), "insert into public.notifications (user_id, type, title) values ($1, 'x', 'x')", [donor]), /permission denied/);
    await rejects(q(as(ngo), "select * from public.pickup_tokens"), /permission denied/);
    await rejects(q(anon, "select public.create_listing('{}'::jsonb)"), /permission denied/);
  });
});

describe("listings, eligibility and the full QR pickup workflow", () => {
  let listingId: string, requestId: string, code: string;

  it("donor publishes a human-food listing with a photo it uploaded", async () => {
    const photo = await uploadPhoto(donor);
    const d = await rpc(as(donor), "create_listing", humanListing({ photos: [photo] }));
    listingId = d.id;
    expect(d).toMatchObject({ destination: "human", eligibleForHumans: true, eligibleForAnimals: false, availability: "available", remaining: 10, photos: [photo] });
    const notes = await rpc(as(ngo), "list_notifications");
    expect(notes.some((n: any) => n.type === "new-donation")).toBe(true);
  });

  it("photo uploads are limited to donors' own folders", async () => {
    await rejects(uploadPhoto(ngo), /row-level security/);
    await rejects(uploadPhoto(donor, "food-photos", donor2), /row-level security/);
    const foreign = await uploadPhoto(donor2);
    await rejects(rpc(as(donor), "create_listing", humanListing({ photos: [foreign] })), /own account/);
  });

  it("rejects unsafe or invalid listings", async () => {
    await rejects(rpc(as(donor), "create_listing", humanListing({ foodOrigin: "plate-leftover" })), /can't go to people/);
    await rejects(rpc(as(donor), "create_listing", humanListing({ safetyChecklist: { hygienic: true } })), /safety checklist/);
    await rejects(rpc(as(donor), "create_listing", humanListing({ expiryAt: hours(-1) })), /already passed/);
    await rejects(rpc(as(donor), "create_listing", humanListing({ quantity: -3 })), /at least/);
    await rejects(rpc(as(donor), "create_listing", humanListing({ expiryAt: hours(20) })), /Hot cooked food/);
    await rejects(rpc(as(donor), "create_listing", animalListing({ animalSpecies: ["Dogs"], safetyChecklist: { notSpoiled: true, noToxicItems: true, noCookedBones: true, lowSaltSpice: true } })), /onion and garlic/);
    await rejects(rpc(as(ngo), "create_listing", humanListing()), /account type/);
  });

  it("NGOs see human food only; animal orgs see screened animal feed only", async () => {
    const feed = await rpc(as(donor), "create_listing", animalListing());
    const ngoView = await rpc(as(ngo), "browse_listings", {});
    expect(ngoView.map((d: any) => d.id)).toEqual([listingId]);
    expect(ngoView[0].address).toBeUndefined();          // exact address withheld before acceptance
    expect(ngoView[0].latitude).toBeNull();
    const shelterView = await rpc(as(shelter), "browse_listings", {});
    expect(shelterView.map((d: any) => d.id)).toEqual([feed.id]);
    await rejects(rpc(as(shelter), "get_listing", listingId), /not found/);
    await rejects(rpc(as(donor), "browse_listings", {}), /account type/);
    // filters
    expect(await rpc(as(ngo), "browse_listings", { q: "biryani" })).toHaveLength(1);
    expect(await rpc(as(ngo), "browse_listings", { q: "pizza" })).toHaveLength(0);
    expect(await rpc(as(ngo), "browse_listings", { minQty: 50 })).toHaveLength(0);
    const near = await rpc(as(ngo), "browse_listings", { lat: 12.97, lng: 77.64, maxDistanceKm: 5, sort: "nearest" });
    expect(near[0].distanceKm).toBeLessThan(5);
    expect(await rpc(as(shelter), "browse_listings", { species: "Dogs" })).toHaveLength(0);
  });

  it("plate leftovers for animals stay hidden until an administrator approves them", async () => {
    const l = await rpc(as(donor), "create_listing", animalListing({ title: "Plate leftovers (rice, dal)", foodOrigin: "plate-leftover", category: "Cooked rice / grains", foodState: "room-temperature", preparedAt: hours(-1), expiryAt: hours(2) }));
    expect(l).toMatchObject({ reviewStatus: "pending_review", availability: "under-review" });
    expect((await rpc(as(shelter), "browse_listings", {})).some((d: any) => d.id === l.id)).toBe(false);
    await rejects(rpc(as(donor), "admin_review_listing", l.id, "approve", ""), /Administrator/);
    await rpc(as(adminUser), "admin_review_listing", l.id, "approve", "Checked with donor");
    expect((await rpc(as(shelter), "browse_listings", {})).some((d: any) => d.id === l.id)).toBe(true);
  });

  it("NGO requests a valid quantity; over-requests and duplicates are rejected; donor is notified", async () => {
    await rejects(rpc(as(ngo), "create_request", { donationId: listingId, quantity: 11 }), /Only 10/);
    await rejects(rpc(as(ngo), "create_request", { donationId: listingId, quantity: 0 }), /at least/);
    const r = await rpc(as(ngo), "create_request", { donationId: listingId, quantity: 6, message: "Arriving by van", beneficiaries: 40 });
    requestId = r.id;
    expect(r).toMatchObject({ status: "pending", quantity: 6, qrState: null });
    expect(r.donation.address).toBeUndefined();
    await rejects(rpc(as(ngo), "create_request", { donationId: listingId, quantity: 1 }), /already have an active request/);
    const notes = await rpc(as(donor), "list_notifications");
    expect(notes[0]).toMatchObject({ type: "request-received", read: false });
    const incoming = await rpc(as(donor), "list_my_requests", "pending");
    expect(incoming.map((x: any) => x.id)).toEqual([requestId]);
    expect(incoming[0].requester.phone).toBeUndefined();  // contact shared only after acceptance
  });

  it("only the owning donor can decide; nobody else sees the request", async () => {
    await rejects(rpc(as(donor2), "decide_request", requestId, "accept", ""), /not found/);
    await rejects(rpc(as(ngo), "decide_request", requestId, "accept", ""), /account type/);
    expect(await q(as(ngo2), "select * from public.requests")).toHaveLength(0);
    await rejects(rpc(as(ngo), "get_pickup_pass", requestId), /only after the donor accepts/);
  });

  it("accepting reserves stock and creates a pickup pass visible only to the requester", async () => {
    const r = await rpc(as(donor), "decide_request", requestId, "accept", "");
    expect(r).toMatchObject({ status: "accepted", qrState: "valid" });
    const mine = await rpc(as(donor), "list_my_listings");
    expect(mine.find((d: any) => d.id === listingId)).toMatchObject({ reserved: 6, remaining: 4, availability: "available" });
    const pass = await rpc(as(ngo), "get_pickup_pass", requestId);
    code = pass.code;
    expect(pass.state).toBe("valid");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(pass.payload).toBe(`EDIBELL:PICKUP:v1:${code}`);
    expect(pass.request.donation.address).toContain("MG Road");
    expect(pass.request.donor.phone).toBeTruthy();
    // Opening the pass again never creates a different code.
    expect((await rpc(as(ngo), "get_pickup_pass", requestId)).code).toBe(code);
    await rejects(rpc(as(ngo2), "get_pickup_pass", requestId), /not found/);
    await rejects(rpc(as(donor), "get_pickup_pass", requestId), /account type/);
    const n = await rpc(as(ngo), "list_notifications");
    expect(n.some((x: any) => x.type === "request-accepted")).toBe(true);
  });

  it("recipients can't complete a pickup themselves", async () => {
    await rejects(rpc(as(ngo), "verify_pickup", code), /account type/);
  });

  it("an accepted listing can't be edited", async () => {
    await rejects(rpc(as(donor), "update_listing", listingId, humanListing({ quantity: 2 })), /accepted pickup/);
  });

  it("invalid and foreign QR codes never complete anything", async () => {
    expect(await rpc(as(donor), "verify_pickup", "hello world")).toMatchObject({ ok: false, failure: "invalid" });
    expect(await rpc(as(donor), "verify_pickup", "EDIBELL:PICKUP:v1:00000000000000000000")).toMatchObject({ ok: false, failure: "invalid" });
    expect(await rpc(as(donor), "verify_pickup", listingId)).toMatchObject({ ok: false, failure: "invalid" }); // an ID is not a credential
    expect(await rpc(as(donor2), "verify_pickup", code)).toMatchObject({ ok: false, failure: "mismatched" });
    const done = await admin("select * from public.pickup_completions");
    expect(done).toHaveLength(0);
  });

  it("the donor's scan completes the pickup exactly once and updates everything", async () => {
    const res = await rpc(as(donor), "verify_pickup", `EDIBELL:PICKUP:v1:${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10)}`);
    expect(res).toMatchObject({ ok: true });
    expect(res.request).toMatchObject({ status: "completed", qrState: "used" });
    const again = await rpc(as(donor), "verify_pickup", code);
    expect(again).toMatchObject({ ok: false, failure: "used" });
    const completions = await admin("select * from public.pickup_completions where request_id = $1", [requestId]);
    expect(completions).toHaveLength(1);
    expect(Number(completions[0].kg_equivalent)).toBe(6);
    expect(completions[0].verified_by).toBe(donor);

    const listing = (await rpc(as(donor), "list_my_listings")).find((d: any) => d.id === listingId);
    expect(listing).toMatchObject({ reserved: 0, collected: 6, remaining: 4, status: "active" });
    const ngoReqs = await rpc(as(ngo), "list_my_requests", "completed");
    expect(ngoReqs.map((r: any) => r.id)).toEqual([requestId]);
    expect((await rpc(as(ngo), "get_pickup_pass", requestId))).toMatchObject({ state: "used", code: null });

    const dn = await rpc(as(donor), "list_notifications");
    const nn = await rpc(as(ngo), "list_notifications");
    expect(dn.some((n: any) => n.type === "pickup-completed")).toBe(true);
    expect(nn.some((n: any) => n.type === "pickup-completed")).toBe(true);

    const di = await rpc(as(donor), "my_impact");
    expect(di).toMatchObject({ completedPickups: 1, completedFoodKg: 6, humanFoodKg: 6, animalFeedKg: 0, mealsSupported: 15 });
    const ni = await rpc(as(ngo), "my_impact");
    expect(ni).toMatchObject({ completedPickups: 1, completedFoodKg: 6 });
    expect(ni.byPartner[0]).toMatchObject({ name: "Green Valley Hotel", pickups: 1 });
    const stats = await rpc(anon, "public_stats");
    expect(stats).toMatchObject({ completedPickups: 1, foodRescuedKg: 6, humanFoodKg: 6 });
  });

  it("notifications can be marked read", async () => {
    await rpc(as(ngo), "mark_notifications_read", null);
    const nn = await rpc(as(ngo), "list_notifications");
    expect(nn.every((n: any) => n.read)).toBe(true);
    await rpc(as(donor), "mark_notifications_read", null);
  });
});

describe("expired, cancelled and declined passes", () => {
  it("an expired QR is rejected and nothing is completed", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Chapati", category: "Breads & bakery", quantity: 40, unit: "pieces", foodState: "room-temperature" }));
    const r = await rpc(as(ngo2), "create_request", { donationId: l.id, quantity: 10 });
    await rpc(as(donor), "decide_request", r.id, "accept", "");
    const { code } = await rpc(as(ngo2), "get_pickup_pass", r.id);
    await admin("update public.pickup_tokens set expires_at = now() - interval '1 minute' where request_id = $1", [r.id]);
    expect(await rpc(as(donor), "verify_pickup", code)).toMatchObject({ ok: false, failure: "expired" });
    expect(await admin("select 1 from public.pickup_completions where request_id = $1", [r.id])).toHaveLength(0);
    const after = await rpc(as(ngo2), "list_my_requests", "all");
    expect(after.find((x: any) => x.id === r.id)).toMatchObject({ status: "expired" });
    const listing = (await rpc(as(donor), "list_my_listings")).find((d: any) => d.id === l.id);
    expect(listing.reserved).toBe(0);                       // reservation released
  });

  it("a cancelled request's QR is rejected; donor cancel cancels accepted pickups with notice", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Fruit salad", category: "Fruits", foodState: "cold", storage: "Refrigerated (below 5°C)" }));
    const r = await rpc(as(ngo), "create_request", { donationId: l.id, quantity: 2 });
    await rpc(as(donor), "decide_request", r.id, "accept", "");
    const { code } = await rpc(as(ngo), "get_pickup_pass", r.id);
    await rpc(as(ngo), "cancel_request", r.id);
    expect(await rpc(as(donor), "verify_pickup", code)).toMatchObject({ ok: false, failure: "cancelled" });

    const r2 = await rpc(as(ngo2), "create_request", { donationId: l.id, quantity: 3 });
    await rpc(as(donor), "decide_request", r2.id, "accept", "");
    const pass2 = await rpc(as(ngo2), "get_pickup_pass", r2.id);
    const cancelled = await rpc(as(donor), "cancel_listing", l.id, "Spilled during storage");
    expect(cancelled).toMatchObject({ status: "cancelled", reserved: 0 });
    expect(await rpc(as(donor), "verify_pickup", pass2.code)).toMatchObject({ ok: false, failure: "cancelled" });
    const n = await rpc(as(ngo2), "list_notifications");
    expect(n[0]).toMatchObject({ type: "donation-cancelled" });
    await rejects(rpc(as(ngo), "create_request", { donationId: l.id, quantity: 1 }), /cancelled/);
  });

  it("declined requests get no pass", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Idli", category: "Cooked meals" }));
    const r = await rpc(as(ngo), "create_request", { donationId: l.id, quantity: 1 });
    const d = await rpc(as(donor), "decide_request", r.id, "decline", "Promised elsewhere");
    expect(d).toMatchObject({ status: "declined", declineReason: "Promised elsewhere", qrState: null });
    await rejects(rpc(as(ngo), "get_pickup_pass", r.id), /only after the donor accepts/);
  });

  it("pending requests can be edited around; edits notify requesters", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Pulao" }));
    await rpc(as(ngo), "create_request", { donationId: l.id, quantity: 1 });
    const e = await rpc(as(donor), "update_listing", l.id, humanListing({ title: "Veg pulao", quantity: 8 }));
    expect(e).toMatchObject({ title: "Veg pulao", quantity: 8 });
    expect((await rpc(as(ngo), "list_notifications"))[0]).toMatchObject({ type: "listing-updated" });
    await rejects(rpc(as(donor2), "update_listing", l.id, humanListing()), /not found/);
    await rejects(rpc(as(donor), "update_listing", l.id, animalListing()), /pathways/);
  });
});

describe("animal welfare rules", () => {
  it("animal orgs may request only for species the donor marked suitable, and complete via the same QR flow", async () => {
    const l = await rpc(as(donor2), "create_listing", animalListing({ title: "Stale bread (unsold, no mould)", category: "Bread & bakery leftovers", animalSpecies: ["Cattle / Cows"], quantity: 20, unit: "pieces" }));
    await rejects(rpc(as(shelter), "create_request", { donationId: l.id, quantity: 5, animalSpecies: ["Dogs"] }), /suitable only for/);
    await rejects(rpc(as(shelter), "create_request", { donationId: l.id, quantity: 5 }), /Select which animals/);
    await rejects(rpc(as(ngo), "create_request", { donationId: l.id, quantity: 5 }), /not found/);
    const r = await rpc(as(shelter), "create_request", { donationId: l.id, quantity: 5, animalSpecies: ["Cattle / Cows"], animalCount: 12 });
    await rpc(as(donor2), "decide_request", r.id, "accept", "");
    const { code } = await rpc(as(shelter), "get_pickup_pass", r.id);
    expect(await rpc(as(donor2), "verify_pickup", code)).toMatchObject({ ok: true });
    const imp = await rpc(as(shelter), "my_impact");
    expect(imp).toMatchObject({ animalFeedKg: 0.5, humanFoodKg: 0, mealsSupported: 0 });
    expect(imp.bySpecies[0]).toMatchObject({ species: "Cattle / Cows" });
  });

  it("feed needs: only animal orgs post; donors see open needs", async () => {
    await rejects(rpc(as(ngo), "create_animal_need", { title: "x", species: ["Dogs"], animalCount: 2, quantityPerWeek: 1, unit: "kg" }), /account type/);
    const n = await rpc(as(shelter), "create_animal_need", { title: "Daily feed for 40 dogs", species: ["Dogs"], animalCount: 40, quantityPerWeek: 70, unit: "kg" });
    expect((await rpc(as(donor), "list_animal_needs", "open")).map((x: any) => x.id)).toContain(n.id);
    await rpc(as(shelter), "close_animal_need", n.id);
    expect((await rpc(as(donor), "list_animal_needs", "open")).map((x: any) => x.id)).not.toContain(n.id);
  });
});

describe("concurrency and abuse", () => {
  it("simultaneous acceptances never over-allocate stock", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Dal", category: "Curries & dals", quantity: 10 }));
    const a = await rpc(as(ngo), "create_request", { donationId: l.id, quantity: 6 });
    const b = await rpc(as(ngo2), "create_request", { donationId: l.id, quantity: 6 });
    const results = await Promise.allSettled([rpc(as(donor), "decide_request", a.id, "accept", ""), rpc(as(donor), "decide_request", b.id, "accept", "")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.message).toMatch(/Only 4/);
    const row = await admin("select reserved, collected, quantity from public.listings where id = $1", [l.id]);
    expect(Number(row[0].reserved)).toBe(6);
  });

  it("simultaneous scans of one code complete it exactly once", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Sambar rice", quantity: 5 }));
    const r = await rpc(as(ngo), "create_request", { donationId: l.id, quantity: 5 });
    await rpc(as(donor), "decide_request", r.id, "accept", "");
    const { code } = await rpc(as(ngo), "get_pickup_pass", r.id);
    const scans = await Promise.all(Array.from({ length: 6 }, () => rpc(as(donor), "verify_pickup", code)));
    expect(scans.filter(s => s.ok)).toHaveLength(1);
    expect(scans.filter(s => !s.ok).map(s => s.failure)).toEqual(Array(5).fill("used"));
    expect(await admin("select 1 from public.pickup_completions where request_id = $1", [r.id])).toHaveLength(1);
    const l2 = await admin("select status, collected from public.listings where id = $1", [l.id]);
    expect(l2[0]).toMatchObject({ status: "completed" });
    expect(Number(l2[0].collected)).toBe(5);
  });

  it("simultaneous requests from the same org create only one", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Lemon rice", quantity: 9 }));
    const res = await Promise.allSettled([1, 2, 3].map(() => rpc(as(ngo), "create_request", { donationId: l.id, quantity: 1 })));
    expect(res.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });

  it("repeated failed scans are rate limited", async () => {
    for (let i = 0; i < 8; i++) await rpc(as(donor2), "verify_pickup", "nope");
    expect(await rpc(as(donor2), "verify_pickup", "nope")).toMatchObject({ failure: "rate-limited" });
  });

  it("completed quantities are counted once in impact", async () => {
    const totals = await admin<{ n: string; kg: string }>("select count(*) n, sum(kg_equivalent) kg from public.pickup_completions");
    const reqs = await admin<{ n: string }>("select count(*) n from public.requests where status = 'completed'");
    expect(totals[0].n).toBe(reqs[0].n);
    const stats = await rpc(anon, "public_stats");
    expect(stats.foodRescuedKg).toBe(Number(totals[0].kg));
  });
});

describe("housekeeping: reminders and food-safety alerts", () => {
  it("sends pickup reminders once and warns donors before the safe-use deadline", async () => {
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Upma", expiryAt: hours(0.8), pickupStart: hours(0.2), pickupEnd: hours(0.7) }));
    const r = await rpc(as(ngo2), "create_request", { donationId: l.id, quantity: 1 });
    await rpc(as(donor), "decide_request", r.id, "accept", "");
    await rpc(as(ngo2), "list_notifications");
    await rpc(as(ngo2), "list_notifications");
    const n = await rpc(as(ngo2), "list_notifications");
    expect(n.filter((x: any) => x.type === "pickup-reminder" && x.body.includes("Upma"))).toHaveLength(1);
    const d = await rpc(as(donor), "list_notifications");
    expect(d.some((x: any) => x.type === "food-safety" && x.body.includes("Upma"))).toBe(true);
    expect(d.find((x: any) => x.type === "request-received")?.body).not.toMatch(/\.000/);
  });
});

describe("administration", () => {
  it("only admins verify organizations; status is reported honestly", async () => {
    await rejects(rpc(as(ngo), "admin_overview"), /Administrator/);
    await rejects(rpc(as(ngo), "admin_set_verification", ngo, "verified", ""), /Administrator/);
    const ov = await rpc(as(adminUser), "admin_overview");
    expect(ov.pendingOrganizations.map((o: any) => o.id)).toContain(ngo);
    await rpc(as(adminUser), "admin_set_verification", ngo, "verified", "Documents checked");
    expect(await rpc(as(ngo), "get_my_profile")).toMatchObject({ verificationStatus: "verified" });
    // Changing legal identity resets verification.
    const me = await rpc(as(ngo), "get_my_profile");
    const updated = await rpc(as(ngo), "update_my_profile", { ...me, registrationNo: "KA/TRUST/999" });
    expect(updated.verificationStatus).toBe("pending");
  });

  it("verification can be required by configuration", async () => {
    await admin("update public.app_config set require_verified_recipients = true");
    const l = await rpc(as(donor), "create_listing", humanListing({ title: "Khichdi" }));
    await rejects(rpc(as(ngo2), "create_request", { donationId: l.id, quantity: 1 }), /must be verified/);
    await admin("update public.app_config set require_verified_recipients = false");
  });

  it("verification documents are private to the org and admins", async () => {
    const path = await uploadPhoto(ngo2, "org-documents");
    await rpc(as(ngo2), "add_org_document", path, "registration-certificate", "cert.pdf");
    expect(await q(as(ngo2), "select name from storage.objects where bucket_id = 'org-documents'")).toHaveLength(1);
    expect(await q(as(ngo), "select name from storage.objects where bucket_id = 'org-documents'")).toHaveLength(0);
    expect(await q(as(adminUser), "select name from storage.objects where bucket_id = 'org-documents'")).toHaveLength(1);
    await rejects(rpc(as(ngo), "add_org_document", path, "other", "x"), /Invalid document path/);
  });
});
