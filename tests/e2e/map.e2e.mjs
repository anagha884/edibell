#!/usr/bin/env node
/**
 * Browser test of the Geoapify pickup-location picker. Geoapify itself is not
 * reachable from CI, so its HTTP responses are stubbed here in the documented
 * `format=json` shape; everything else (Leaflet, the React form, Supabase via
 * the local test gateway) is real. A real-key check is still needed manually.
 *
 *   node tests/e2e/map.e2e.mjs http://localhost:3000 <screenshot dir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const email = `mapdonor.${Date.now().toString(36)}@example.org`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==", "base64");
const calls = { autocomplete: [], reverse: [], tiles: 0 };
const fail = m => { console.log("FAIL", m); process.exitCode = 1; };
const ok = m => console.log("PASS", m);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
page.on("pageerror", e => fail("pageerror: " + e.message));
await page.route("https://maps.geoapify.com/**", r => { calls.tiles++; return r.fulfill({ status: 200, contentType: "image/png", body: PNG }); });
await page.route("https://api.geoapify.com/v1/geocode/autocomplete**", r => {
  const u = new URL(r.request().url()); calls.autocomplete.push(Object.fromEntries(u.searchParams));
  return r.fulfill({ json: { results: [
    { formatted: "12, MG Road, Shanthala Nagar, Bengaluru - 560001, Karnataka, India", address_line1: "12, MG Road", address_line2: "Shanthala Nagar, Bengaluru - 560001, Karnataka, India", lat: 12.9753, lon: 77.6069, suburb: "Shanthala Nagar", city: "Bengaluru", postcode: "560001", place_id: "51abc", result_type: "building" },
    { formatted: "MG Road Metro Station, Bengaluru, India", address_line1: "MG Road Metro Station", address_line2: "Bengaluru, Karnataka, India", lat: 12.9757, lon: 77.6063, city: "Bengaluru", place_id: "51def" },
  ] } });
});
await page.route("https://api.geoapify.com/v1/geocode/reverse**", r => {
  const u = new URL(r.request().url()); calls.reverse.push(Object.fromEntries(u.searchParams));
  return r.fulfill({ json: { results: [{ formatted: "Brigade Road, Ashok Nagar, Bengaluru - 560025, Karnataka, India", address_line1: "Brigade Road", lat: 12.97, lon: 77.6, suburb: "Ashok Nagar", city: "Bengaluru", postcode: "560025", place_id: "51rev" }] } });
});

try {
  await page.goto(`${BASE}/register`);
  await page.getByRole("button", { name: /^Food Donor/ }).first().click();
  await page.getByRole("button", { name: "Continue as Food Donor" }).click();
  await page.getByLabel("Authorized contact person").fill("Asha Rao");
  await page.getByLabel("Business / venue name").fill("Green Valley Hotel");
  await page.getByLabel("Business type").selectOption({ index: 1 });
  await page.getByLabel("Phone number").fill("+91 90000 00001");
  await page.getByLabel("Street address").fill("12 MG Road");
  await page.getByLabel("Area / locality").fill("Indiranagar");
  await page.getByLabel("City *").fill("Bengaluru");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Create password").fill("donor-pass-123");
  await page.getByLabel("Confirm password").fill("donor-pass-123");
  await page.getByLabel(/I am authorized/).check();
  await page.getByRole("button", { name: /Create .* Account/ }).click();
  await page.waitForURL(`${BASE}/donor`, { timeout: 15000 });

  await page.goto(`${BASE}/donor/create`);
  const search = page.getByRole("combobox", { name: "Search pickup address" });
  await search.waitFor();
  await page.locator(".eb-map-canvas .leaflet-tile-loaded").first().waitFor({ timeout: 10000 });
  ok(`map renders with Geoapify tiles (${calls.tiles} tile requests)`);
  const attribution = await page.locator(".eb-map-canvas .leaflet-control-attribution").innerText();
  /Powered by Geoapify/.test(attribution) && /OpenStreetMap/.test(attribution) ? ok("required attribution shown: " + attribution) : fail("attribution missing: " + attribution);

  await search.scrollIntoViewIfNeeded();
  await search.pressSequentially("12 m", { delay: 40 });
  await page.locator("#eb-place-results [role=option]").first().waitFor({ timeout: 5000 });
  calls.autocomplete.length === 1 ? ok("typing is debounced into a single autocomplete request") : fail(`autocomplete requests: ${calls.autocomplete.length}`);
  const q = calls.autocomplete.at(-1);
  q.filter === "countrycode:in" && q.format === "json" && q.text === "12 m" && q.apiKey ? ok("request restricted to India, json format, key sent") : fail("bad request params " + JSON.stringify(q));
  await shot("suggestions");
  await search.press("ArrowDown"); await search.press("Enter");
  await page.waitForFunction(() => document.querySelector('input[autocomplete="street-address"]')?.value.includes("MG Road"));
  const v = async label => page.getByLabel(label, { exact: false }).first().inputValue();
  const addr = await page.locator('input[autocomplete="street-address"]').inputValue();
  const area = await page.getByLabel("Area / locality").first().inputValue();
  const city = await page.getByLabel(/^City/).first().inputValue();
  const pin = await page.getByLabel("PIN code").inputValue();
  addr.startsWith("12, MG Road") && area === "Shanthala Nagar" && city === "Bengaluru" && pin === "560001" ? ok("choosing a suggestion fills address, area, city and PIN") : fail(JSON.stringify({ addr, area, city, pin }));
  await page.getByText("Pin saved (12.97530, 77.60690)").waitFor({ timeout: 3000 });
  ok("map pin saved at the chosen coordinates");
  (await page.locator(".eb-map-canvas .eb-map-pin").count()) === 1 ? ok("pin marker shown on map") : fail("no marker");

  const box = await page.locator(".eb-map-canvas").boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.waitForFunction(() => document.querySelector('input[autocomplete="street-address"]')?.value.includes("Brigade Road"), null, { timeout: 5000 });
  calls.reverse.length === 1 ? ok("clicking the map looks up that point's address (reverse geocoding)") : fail("reverse calls " + calls.reverse.length);
  (await page.getByLabel("PIN code").inputValue()) === "560025" ? ok("pin-to-address updates PIN code") : fail("PIN not updated");
  await shot("picked");

  await page.unroute("https://api.geoapify.com/v1/geocode/autocomplete**");
  await page.route("https://api.geoapify.com/v1/geocode/autocomplete**", r => r.fulfill({ status: 429, json: { message: "limit" } }));
  await search.fill(""); await search.pressSequentially("Koramangala", { delay: 20 });
  await page.getByText("Today's free address-search limit has been reached").waitFor({ timeout: 5000 });
  ok("daily-limit response shows an honest message (manual address entry still works)");
} catch (e) { fail(e.message); await shot("error"); }
await browser.close();
async function shot(n) { await page.screenshot({ path: path.join(SHOTS, `map-${n}.png`), fullPage: false }); }
