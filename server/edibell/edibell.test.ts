import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.EDIBELL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "edibell-test-"));
const D = await import("./domain");
const S = await import("./store");

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const reg = (role: "donor" | "ngo" | "animal", email: string, org: string) =>
  D.registerUser({ role, email, password: "password123", contactName: "Test", orgName: org, city: "Bengaluru", area: "JP Nagar", capacity: 80, species: role === "animal" ? ["Dogs", "Cattle / Cows"] : [] });

const humanDonation = (over: Record<string, unknown> = {}) => ({
  destination: "human", title: "Veg biryani", category: "Cooked meals", quantity: 20, unit: "kg", foodState: "hot",
  foodOrigin: "cooked-not-served", dietType: "vegetarian", humanSafetyConfirmed: true,
  preparedAt: hours(-1), expiryAt: hours(6), readyAt: hours(0.5), pickupStart: hours(1), pickupEnd: hours(3),
  packaging: "Sealed food-grade containers", storage: "Kept hot (above 60°C)",
  address: "12 Main Rd", area: "JP Nagar", city: "Bengaluru", ...over,
});
const animalDonation = (over: Record<string, unknown> = {}) => ({
  ...humanDonation({ destination: "animal", title: "Rice & veg scraps", category: "Cooked rice / grains", foodOrigin: "plate-leftover", dietType: undefined, animalSpecies: ["Dogs"], animalSafetyConfirmed: true }), ...over,
});

let donor: { id: string }, donor2: { id: string }, ngo: { id: string }, ngo2: { id: string }, animal: { id: string };

beforeAll(() => {
  donor = reg("donor", "d@x.com", "Green Valley Hotel");
  donor2 = reg("donor", "d2@x.com", "Other Hotel");
  ngo = reg("ngo", "n@x.com", "Hope Foundation");
  ngo2 = reg("ngo", "n2@x.com", "Care Kitchen");
  animal = reg("animal", "a@x.com", "Happy Paws");
});

describe("accounts", () => {
  it("rejects duplicate email, short password and wrong role on login", () => {
    expect(() => reg("ngo", "n@x.com", "Dup")).toThrow(/already exists/);
    expect(() => D.registerUser({ role: "ngo", email: "z@x.com", password: "short", contactName: "a", orgName: "b", city: "c" })).toThrow(/8 characters/);
    expect(() => D.loginUser({ role: "donor", email: "n@x.com", password: "password123" })).toThrow(/registered as a NGO Partner/);
    expect(() => D.loginUser({ role: "ngo", email: "n@x.com", password: "wrong-password" })).toThrow(/Incorrect/);
    expect(D.loginUser({ role: "ngo", email: "N@x.com", password: "password123" }).id).toBe(ngo.id);
  });
});

describe("donations & marketplaces", () => {
  it("validates human vs animal rules", () => {
    expect(() => D.createDonation(donor.id, humanDonation({ foodOrigin: "plate-leftover" }))).toThrow(/can't go to people/);
    expect(() => D.createDonation(donor.id, animalDonation({ animalSpecies: [] }))).toThrow(/species/);
    expect(() => D.createDonation(donor.id, animalDonation({ animalSafetyConfirmed: false }))).toThrow(/confirm/);
    expect(() => D.createDonation(donor.id, humanDonation({ pickupEnd: hours(0.5) }))).toThrow(/after its start/);
    expect(() => D.createDonation(donor.id, humanDonation({ expiryAt: hours(0.2) }))).toThrow(/at least until/);
  });

  it("keeps human and animal food in separate marketplaces", () => {
    const h = D.createDonation(donor.id, humanDonation({ latitude: 12.9, longitude: 77.6 }));
    const a = D.createDonation(donor.id, animalDonation());
    const ngoIds = D.browseMarket({ id: ngo.id, role: "ngo" }, {}).map(x => x.id);
    const animalIds = D.browseMarket({ id: animal.id, role: "animal" }, {}).map(x => x.id);
    expect(ngoIds).toContain(h.id);
    expect(ngoIds).not.toContain(a.id);
    const publicListing = D.browseMarket({ id: ngo.id, role: "ngo" }, {}).find(x => x.id === h.id)!;
    expect(publicListing.address).toBeUndefined();
    expect(publicListing.latitude).toBeNull();
    expect(publicListing.longitude).toBeNull();
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, h.id).latitude).toBe(12.9);
    expect(animalIds).toContain(a.id);
    expect(animalIds).not.toContain(h.id);
    expect(() => D.browseMarket({ id: donor.id, role: "donor" }, {})).toThrow(/can't browse/);
    // street address is hidden until accepted
    expect(D.browseMarket({ id: ngo.id, role: "ngo" }, {}).find(x => x.id === h.id)!.address).toBeUndefined();
    // filters
    expect(D.browseMarket({ id: ngo.id, role: "ngo" }, { q: "biryani" })).toHaveLength(1);
    expect(D.browseMarket({ id: ngo.id, role: "ngo" }, { q: "nothing-like-this" })).toHaveLength(0);
    expect(D.browseMarket({ id: ngo.id, role: "ngo" }, { category: "Fruits" })).toHaveLength(0);
    expect(D.browseMarket({ id: animal.id, role: "animal" }, { species: "Cats" })).toHaveLength(0);
  });
});

describe("request → accept → QR → scan", () => {
  it("runs the full flow and completes exactly once", () => {
    const don = D.createDonation(donor.id, humanDonation({ title: "Flow test", quantity: 10, latitude: 12.9, longitude: 77.6 }));
    // role boundaries
    expect(() => D.createRequest({ id: donor.id, role: "donor" }, { donationId: don.id, quantity: 1 })).toThrow(/can't request/);
    expect(() => D.createRequest({ id: animal.id, role: "animal" }, { donationId: don.id, quantity: 1, animalSpecies: ["Dogs"] })).toThrow(/not found/i);
    expect(() => D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 11 })).toThrow(/Only 10/);

    const req = D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 6, beneficiaries: 40 });
    expect(req.status).toBe("pending");
    expect(req.qrState).toBeNull();
    expect(() => D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 1 })).toThrow(/already have/);
    // QR does not exist before acceptance
    expect(() => D.getPickupQr({ id: ngo.id, role: "ngo" }, req.id)).toThrow(/after the donor accepts/);
    // another donor cannot decide it
    expect(() => D.decideRequest(donor2.id, req.id, { decision: "accept" })).toThrow(/not found/i);
    // donor sees who is asking
    const seen = D.listRequestsFor({ id: donor.id, role: "donor" }, "pending").find(r => r.id === req.id)!;
    expect(seen.requester.name).toBe("Hope Foundation");
    expect(seen.requester.capacity).toBe(80);
    expect(seen.requester.phone).toBeUndefined();

    const accepted = D.decideRequest(donor.id, req.id, { decision: "accept" });
    expect(accepted.status).toBe("accepted");
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, don.id).remaining).toBe(4);

    // QR: stable, private, role-restricted
    const qr1 = D.getPickupQr({ id: ngo.id, role: "ngo" }, req.id);
    const qr2 = D.getPickupQr({ id: ngo.id, role: "ngo" }, req.id);
    expect(qr1.state).toBe("valid");
    expect(qr1.code).toBe(qr2.code);
    expect(qr1.payload).toBe("EDIBELL:PICKUP:v1:" + qr1.code);
    expect(qr1.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(() => D.getPickupQr({ id: ngo2.id, role: "ngo" }, req.id)).toThrow(/not found/i);
    expect(() => D.getPickupQr({ id: donor.id, role: "donor" }, req.id)).toThrow(/Only NGOs/);
    // address revealed only now
    const authorizedLocation = D.getDonationFor({ id: ngo.id, role: "ngo" }, don.id);
    expect(authorizedLocation.address).toBe("12 Main Rd");
    expect(authorizedLocation.latitude).toBe(12.9);
    expect(authorizedLocation.longitude).toBe(77.6);

    // scanning: wrong donor, garbage, then the right one
    D.resetScanLimiterForTests();
    expect(D.scanPickupCode(donor2.id, qr1.payload).failure).toBe("mismatched");
    expect(D.scanPickupCode(donor.id, "hello").failure).toBe("invalid");
    expect(D.scanPickupCode(donor.id, "AAAAAAAAAAAAAAAAAAAA").failure).toBe("invalid");
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, don.id).collected).toBe(0); // nothing completed yet

    const ok = D.scanPickupCode(donor.id, qr1.payload);
    expect(ok.ok).toBe(true);
    expect(ok.request!.status).toBe("completed");
    // same code again (camera or manual entry) must fail
    const again = D.scanPickupCode(donor.id, qr1.code);
    expect(again.ok).toBe(false);
    expect(again.failure).toBe("used");
    const after = D.getDonationFor({ id: donor.id, role: "donor" }, don.id);
    expect(after.collected).toBe(6);
    expect(after.reserved).toBe(0);
    expect(after.remaining).toBe(4);
    expect(D.getPickupQr({ id: ngo.id, role: "ngo" }, req.id).state).toBe("used");
    expect(D.getPickupQr({ id: ngo.id, role: "ngo" }, req.id).code).toBeNull();
    // manual entry with dashes / lowercase works for the live code format
    const req2 = D.createRequest({ id: ngo2.id, role: "ngo" }, { donationId: don.id, quantity: 4 });
    D.decideRequest(donor.id, req2.id, { decision: "accept" });
    const code2 = D.getPickupQr({ id: ngo2.id, role: "ngo" }, req2.id).code!;
    const typed = (code2.match(/.{5}/g) as string[]).join("-").toLowerCase();
    expect(D.scanPickupCode(donor.id, typed).ok).toBe(true);
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, don.id).status).toBe("completed");
  });

  it("rejects cancelled, expired and declined requests", () => {
    const don = D.createDonation(donor.id, humanDonation({ title: "Cancel test", quantity: 10 }));
    const r1 = D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 3 });
    D.decideRequest(donor.id, r1.id, { decision: "accept" });
    const code1 = D.getPickupQr({ id: ngo.id, role: "ngo" }, r1.id).code!;
    D.cancelRequest(ngo.id, r1.id);
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, don.id).remaining).toBe(10); // reservation released
    expect(D.scanPickupCode(donor.id, code1).failure).toBe("cancelled");

    const r2 = D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 3 });
    D.decideRequest(donor.id, r2.id, { decision: "accept" });
    const code2 = D.getPickupQr({ id: ngo.id, role: "ngo" }, r2.id).code!;
    S.getDb().requests.find(r => r.id === r2.id)!.qrExpiresAt = hours(-1);   // simulate time passing
    expect(D.scanPickupCode(donor.id, code2).failure).toBe("expired");
    expect(D.getPickupQr({ id: ngo.id, role: "ngo" }, r2.id).state).toBe("expired");
    D.sweepExpired();
    expect(D.getDonationFor({ id: donor.id, role: "donor" }, don.id).remaining).toBe(10);

    const r3 = D.createRequest({ id: ngo2.id, role: "ngo" }, { donationId: don.id, quantity: 2 });
    const declined = D.decideRequest(donor.id, r3.id, { decision: "decline", reason: "Already promised" });
    expect(declined.status).toBe("declined");
    expect(() => D.decideRequest(donor.id, r3.id, { decision: "accept" })).toThrow(/already declined/);
  });

  it("locks scanning after repeated failures", () => {
    D.resetScanLimiterForTests();
    for (let i = 0; i < 8; i++) D.scanPickupCode(donor.id, "nonsense");
    expect(D.scanPickupCode(donor.id, "nonsense").failure).toBe("rate-limited");
    D.resetScanLimiterForTests();
  });

  it("serves animal organizations through their own flow", () => {
    D.resetScanLimiterForTests();
    const don = D.createDonation(donor.id, animalDonation({ title: "Dog feed", quantity: 8 }));
    expect(() => D.createRequest({ id: animal.id, role: "animal" }, { donationId: don.id, quantity: 2 })).toThrow(/Select which animals/);
    expect(() => D.createRequest({ id: animal.id, role: "animal" }, { donationId: don.id, quantity: 2, animalSpecies: ["Cats"] })).toThrow(/suitable only for/);
    expect(() => D.createRequest({ id: ngo.id, role: "ngo" }, { donationId: don.id, quantity: 2 })).toThrow(/not found/i);
    const r = D.createRequest({ id: animal.id, role: "animal" }, { donationId: don.id, quantity: 5, animalSpecies: ["Dogs"], animalCount: 30 });
    D.decideRequest(donor.id, r.id, { decision: "accept" });
    const qr = D.getPickupQr({ id: animal.id, role: "animal" }, r.id);
    expect(D.scanPickupCode(donor.id, qr.payload).ok).toBe(true);
    const imp = D.impactFor({ id: animal.id, role: "animal" });
    expect(imp.animalFeedKg).toBe(5);
    expect(imp.mealsSupported).toBe(0);           // meals are only counted for human food
    expect(imp.bySpecies[0].species).toBe("Dogs");
  });
});

describe("impact & notifications", () => {
  it("computes documented estimates only from completed pickups", () => {
    const imp = D.impactFor({ id: donor.id, role: "donor" });
    expect(imp.humanFoodKg).toBe(10);              // 6 + 4 kg completed in the first flow test
    expect(imp.mealsSupported).toBe(25);           // 10 kg / 0.4
    expect(imp.co2eAvoidedKg).toBe(Math.round((10 + 5) * 2.5 * 1000) / 1000);
    expect(imp.assumptions.length).toBeGreaterThan(0);
    expect(D.listNotifications(donor.id).length).toBeGreaterThan(0);
  });
});
