#!/usr/bin/env node
/**
 * Browser end-to-end test of the complete EDIBELL workflow, driving the real
 * frontend (supabase-js) against the real migrations via the local test
 * gateway (tests/e2e/local-supabase.mjs). See README → Testing.
 *
 *   node tests/e2e/workflow.e2e.mjs http://localhost:3000 <screenshot dir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "e2e-shots";
const PHOTO = path.resolve(import.meta.dirname, "fixtures/test-food-photo.jpg");
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const users = {
  donor: { email: `donor.${run}@example.org`, password: "donor-pass-123" },
  ngo: { email: `ngo.${run}@example.org`, password: "ngo-pass-123" },
  animal: { email: `animal.${run}@example.org`, password: "animal-pass-123" },
};
let step = 0;
const results = [];
function ok(name) { results.push(["PASS", name]); console.log("PASS", name); }
async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true }); }
async function expectText(page, text, timeout = 10000) { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); }

const browser = await chromium.launch();
const ctx = async (vp = { width: 1366, height: 900 }) => { const c = await browser.newContext({ viewport: vp }); const p = await c.newPage(); p.on("pageerror", e => console.log("pageerror:", e.message)); p.on("dialog", d => void d.accept()); return p; };

async function register(page, role, extra = async () => {}) {
  await page.goto(`${BASE}/register`);
  const card = { donor: "Food Donor", ngo: "NGO Partner", animal: "Animal Welfare Organization" }[role];
  await page.getByRole("button", { name: new RegExp(`^${card}`) }).first().click();
  await page.getByRole("button", { name: `Continue as ${card}` }).click();
  await page.getByLabel("Authorized contact person").fill(role === "donor" ? "Asha Rao" : role === "ngo" ? "Ravi Kumar" : "Meera Iyer");
  await page.getByLabel(role === "donor" ? "Business / venue name" : "Organization name").fill(role === "donor" ? "Green Valley Hotel" : role === "ngo" ? "Hope Community Kitchen" : "Happy Paws Shelter");
  await page.getByLabel(role === "donor" ? "Business type" : "Organization type").selectOption({ index: 1 });
  await page.getByLabel("Phone number").fill("+91 90000 0000" + (role === "donor" ? 1 : role === "ngo" ? 2 : 3));
  await page.getByLabel("Street address").fill("12 MG Road");
  await page.getByLabel("Area / locality").fill("Indiranagar");
  await page.getByLabel("City *").fill("Bengaluru");
  await extra();
  await page.getByLabel("Email address").fill(users[role].email);
  await page.getByLabel("Create password").fill(users[role].password);
  await page.getByLabel("Confirm password").fill(users[role].password);
  await page.getByLabel(/I am authorized/).check();
  await page.getByRole("button", { name: /Create .* Account/ }).click();
  await page.waitForURL(`${BASE}/${role}`, { timeout: 15000 });
}
async function login(page, role) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email address").fill(users[role].email);
  await page.getByLabel("Password", { exact: true }).fill(users[role].password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.waitForURL(`${BASE}/${role}`, { timeout: 15000 });
}

try {
  // ---- public pages -------------------------------------------------------
  const pub = await ctx();
  await pub.goto(BASE); await expectText(pub, "second chance"); await expectText(pub, "The scale of food waste");
  await shot(pub, "home"); ok("homepage renders with live (zero) stats and sourced facts");
  await pub.goto(`${BASE}/why-food-rescue`); await expectText(pub, "Verified external facts"); await shot(pub, "why-food-rescue"); ok("awareness page renders");
  await pub.goto(`${BASE}/donor`); await pub.waitForURL(`${BASE}/login`); ok("logged-out visitor is sent to login");

  // ---- registration ------------------------------------------------------
  const donor = await ctx();
  await register(donor, "donor"); await expectText(donor, "Verification pending"); await shot(donor, "donor-dashboard-empty"); ok("donor registers and lands on Donor Dashboard (pending verification, zero metrics)");
  const ngo = await ctx();
  await register(ngo, "ngo"); await shot(ngo, "ngo-dashboard-empty"); ok("NGO registers and lands on NGO Dashboard");
  const animal = await ctx({ width: 390, height: 844 });
  await register(animal, "animal", async () => {
    await animal.getByRole("button", { name: "Dogs" }).click();
    await animal.getByRole("button", { name: "Cattle / Cows" }).click();
  }); await shot(animal, "animal-dashboard-mobile"); ok("animal welfare org registers (mobile) and lands on its dashboard");

  // ---- role isolation ----------------------------------------------------
  await ngo.goto(`${BASE}/donor/scanner`); await ngo.waitForURL(`${BASE}/ngo`); ok("NGO cannot open donor routes (redirected to own portal)");
  await donor.goto(`${BASE}/ngo/finder`); await donor.waitForURL(`${BASE}/donor`); ok("donor cannot open NGO routes");

  // ---- session persistence + logout/login -------------------------------------
  await donor.reload(); await donor.waitForURL(`${BASE}/donor`); await expectText(donor, "Hello, Asha"); ok("session persists across reload");
  await donor.getByRole("button", { name: "Logout" }).click(); await donor.waitForURL(`${BASE}/login`);
  await login(donor, "donor"); ok("logout and login route to the registered role's dashboard");

  // ---- donor publishes a listing -------------------------------------------
  await donor.goto(`${BASE}/donor/create`);
  await donor.getByLabel("Food name").fill("Vegetable biryani");
  await donor.getByLabel("Food category").selectOption("Cooked meals");
  await donor.getByLabel("Quantity").fill("10");
  await donor.locator('input[type=file]').first().setInputFiles(PHOTO);
  await donor.locator(".eb-photo img").first().waitFor({ timeout: 10000 });
  await donor.getByLabel("Ingredients").fill("Rice, carrots, beans, spices");
  await donor.getByLabel("Packaging details").selectOption({ index: 2 });
  await donor.getByLabel("Storage & handling requirements").selectOption({ index: 1 });
  await donor.getByLabel("Pickup contact phone").fill("+91 90000 00001");
  for (const cb of await donor.locator(".eb-checklist input[type=checkbox]").all()) await cb.check();
  await shot(donor, "share-surplus-form");
  await donor.getByRole("button", { name: "Review listing" }).click();
  await expectText(donor, "REVIEW BEFORE PUBLISHING"); await shot(donor, "listing-review");
  await donor.getByRole("button", { name: "Publish listing" }).click();
  await donor.waitForURL(`${BASE}/donor/donations`); await expectText(donor, "Vegetable biryani"); await expectText(donor, "10 kg");
  await shot(donor, "my-food-listings"); ok("donor publishes a listing with an uploaded photo after review");

  // ---- animal org does not see human food; NGO does --------------------------
  await animal.goto(`${BASE}/animal/finder`); await expectText(animal, "No food is available right now"); ok("animal welfare org does not see human-food listing");
  await ngo.goto(`${BASE}/ngo/finder`); await expectText(ngo, "Vegetable biryani"); await shot(ngo, "discover-food");
  await ngo.getByRole("button", { name: /Vegetable biryani/ }).click();
  await expectText(ngo, "Shared once the donor accepts your request");
  await ngo.getByLabel(/Quantity needed/).fill("12");
  if (await ngo.getByLabel(/Quantity needed/).evaluate(el => el.checkValidity())) throw new Error("over-request accepted by the form");
  ok("over-request blocked in the form (and by the database, see db tests)");
  await ngo.getByLabel(/Quantity needed/).fill("4");
  await ngo.getByLabel("Collection details").fill("Ravi, white van, 6pm");
  await ngo.getByRole("button", { name: "Send request" }).click();
  await expectText(ngo, "Request sent"); ok("NGO requests a valid quantity");

  // ---- donor notified, accepts ------------------------------------------
  await donor.goto(`${BASE}/donor/notifications`); await expectText(donor, "New food request"); ok("donor receives a persistent notification");
  await donor.goto(`${BASE}/donor/requests`); await expectText(donor, "Hope Community Kitchen"); await shot(donor, "incoming-requests");
  await donor.getByRole("button", { name: "Accept request" }).click();
  await expectText(donor, "Request accepted"); ok("donor accepts the request");
  await donor.goto(`${BASE}/donor/donations`); await expectText(donor, "4 kg reserved"); await expectText(donor, "6 kg"); ok("listing shows reserved/remaining quantities");

  // ---- NGO Pickup Pass ------------------------------------------------------
  await ngo.goto(`${BASE}/ngo/requests`); await expectText(ngo, "Accepted"); await expectText(ngo, "12 MG Road");
  await ngo.goto(`${BASE}/ngo/pickup`); const qr = ngo.locator(".eb-qr img").first(); await qr.waitFor({ timeout: 10000 });
  await shot(ngo, "pickup-pass");
  const dataUrl = await qr.getAttribute("src");
  const qrFile = path.join(SHOTS, "pickup-qr.png"); fs.writeFileSync(qrFile, Buffer.from(dataUrl.split(",")[1], "base64"));
  const code = (await ngo.locator(".eb-code").first().innerText()).trim();
  ok(`NGO sees its Pickup Pass QR (${code.slice(0, 5)}…)`);

  // ---- invalid codes never complete ----------------------------------------
  await donor.goto(`${BASE}/donor/scanner`);
  await donor.getByLabel("Pickup code").fill("AAAAA-BBBBB-CCCCC-DDDDD");
  await donor.getByRole("button", { name: "Verify", exact: true }).click(); await expectText(donor, "Invalid QR code");
  await shot(donor, "verify-invalid"); ok("invalid code is rejected with a clear reason");
  await donor.getByRole("button", { name: "Try again" }).click();

  // ---- donor scans the QR (photo of the pass) ---------------------------------
  await donor.locator('.eb-scanner input[type=file]').setInputFiles(qrFile);
  await expectText(donor, "Pickup verified", 15000); await shot(donor, "verify-success"); ok("donor's scan of the real QR is verified by the server");
  await donor.getByRole("button", { name: "Scan next" }).click();
  await donor.locator('.eb-scanner input[type=file]').setInputFiles(qrFile);
  await expectText(donor, "already used"); ok("re-scanning the same QR is rejected (single use)");

  // ---- both parties see completion; history; impact -----------------------------
  await ngo.goto(`${BASE}/ngo/history`); await expectText(ngo, "Vegetable biryani"); await shot(ngo, "collection-history"); ok("NGO collection history shows the verified pickup");
  await ngo.goto(`${BASE}/ngo/notifications`); await expectText(ngo, "Pickup verified"); ok("NGO notified of completion");
  await ngo.goto(`${BASE}/ngo/impact`); await expectText(ngo, "4 kg"); await shot(ngo, "ngo-impact"); ok("NGO impact updated from verified completion");
  await donor.goto(`${BASE}/donor/impact`); await expectText(donor, "4 kg"); await shot(donor, "donor-impact"); ok("donor impact updated");
  await donor.goto(`${BASE}/donor`); await shot(donor, "donor-dashboard");
  await pub.goto(BASE); await expectText(pub, "4 kg"); ok("public stats count only the verified handover");

  // ---- animal feed pathway ---------------------------------------------------
  await donor.goto(`${BASE}/donor/create`);
  await donor.getByRole("button", { name: /Animals \(animal feed\)/ }).click();
  await donor.getByLabel("Food name").fill("Fresh vegetable trimmings");
  await donor.getByLabel("Food category").selectOption("Raw vegetable trimmings");
  await donor.getByLabel("Quantity").fill("15");
  await donor.getByRole("button", { name: "Cattle / Cows" }).click();
  await donor.getByLabel("Ingredients").fill("Cabbage leaves, carrot peels");
  await donor.getByLabel("Packaging details").selectOption({ index: 4 });
  await donor.getByLabel("Storage & handling requirements").selectOption({ index: 3 });
  await donor.getByLabel("Pickup contact phone").fill("+91 90000 00001");
  for (const cb of await donor.locator(".eb-checklist input[type=checkbox]").all()) await cb.check();
  await donor.getByRole("button", { name: "Review listing" }).click();
  await donor.getByRole("button", { name: "Publish listing" }).click(); await donor.waitForURL(`${BASE}/donor/donations`);
  await ngo.goto(`${BASE}/ngo/finder`); await ngo.getByText("Vegetable biryani").first().waitFor();
  if (await ngo.getByText("Fresh vegetable trimmings").count()) throw new Error("NGO can see animal feed");
  ok("NGO does not see animal-feed listing");
  await animal.goto(`${BASE}/animal/finder`); await expectText(animal, "Fresh vegetable trimmings"); await shot(animal, "discover-animal-feed-mobile");
  await animal.getByRole("button", { name: /Fresh vegetable trimmings/ }).click();
  await animal.getByLabel(/Quantity needed/).fill("5");
  const chip = animal.locator(".eb-modal .eb-chip", { hasText: "Cattle / Cows" });
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
  await animal.getByRole("button", { name: "Send request" }).click(); await expectText(animal, "Request sent");
  await donor.goto(`${BASE}/donor/requests`); await donor.getByRole("button", { name: "Accept request" }).click(); await expectText(donor, "Request accepted");
  await animal.goto(`${BASE}/animal/pickup`); const qr2 = animal.locator(".eb-qr img").first(); await qr2.waitFor();
  const qr2File = path.join(SHOTS, "pickup-qr-animal.png"); fs.writeFileSync(qr2File, Buffer.from((await qr2.getAttribute("src")).split(",")[1], "base64"));
  await donor.goto(`${BASE}/donor/scanner`); await donor.locator('.eb-scanner input[type=file]').setInputFiles(qr2File);
  await expectText(donor, "Pickup verified", 15000);
  await animal.goto(`${BASE}/animal/impact`); await expectText(animal, "5 kg"); await shot(animal, "animal-impact-mobile");
  ok("animal welfare org completes the same secure QR pickup; feed counted separately");

  await animal.goto(`${BASE}/animal/profile`); await animal.getByRole("heading", { name: "Animal Care Profile" }).waitFor(); await shot(animal, "animal-care-profile-mobile"); ok("Animal Care Profile renders");
  console.log(`\n${results.length} checks passed`);
} catch (e) {
  console.error("FAIL", e.message);
  const pages = browser.contexts().flatMap(c => c.pages());
  for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `fail-${i}.png`), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
