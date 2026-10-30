#!/usr/bin/env node
/**
 * Back-navigation tests: the in-app back arrow (history + fallbacks), the
 * browser's own Back button, role/session preservation, and layout of the
 * arrow on laptop and phone sizes.
 *
 *   node tests/e2e/navigation.e2e.mjs http://localhost:3000 <screenshot dir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const B = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
let failures = 0;
const ok = m => console.log("PASS", m);
const fail = m => { failures++; console.log("FAIL", m); };
const check = (c, m, d = "") => (c ? ok(m) : fail(`${m} ${d}`));
const at = p => new URL(p.url()).pathname;
const back = p => p.getByRole("button", { name: "Go back" });
const settle = p => p.waitForTimeout(700);

const browser = await chromium.launch();
const newPage = async (vp = { width: 1366, height: 768 }) => { const c = await browser.newContext({ viewport: vp }); const p = await c.newPage(); p.on("pageerror", e => fail("pageerror " + e.message)); return p; };

async function registerDonor(p, email) {
  await p.getByRole("button", { name: /^Food Donor/ }).first().click();
  await p.getByRole("button", { name: "Continue as Food Donor" }).click();
  for (const [l, v] of [["Authorized contact person", "Asha Rao"], ["Business / venue name", "Nav Test Hotel"], ["Phone number", "+91 90000 00001"], ["Street address", "1 MG Road"], ["City *", "Bengaluru"], ["Email address", email], ["Create password", "nav-pass-123"], ["Confirm password", "nav-pass-123"]]) await p.getByLabel(l).fill(v);
  await p.getByLabel("Business type").selectOption({ index: 1 });
  await p.getByLabel(/I am authorized/).check();
  await p.getByRole("button", { name: /Create .* Account/ }).click();
  await p.waitForURL(B + "/donor");
}

try {
  // ---------- public + auth pages ----------
  let p = await newPage();
  await p.goto(B + "/"); await settle(p);
  check(await back(p).count() === 0, "Home page has no back arrow (it is the start page)");
  await p.getByRole("link", { name: "Login" }).first().click(); await p.waitForURL(B + "/login");
  check(await back(p).isVisible(), "Login page shows a back arrow");
  await back(p).click(); await p.waitForURL(B + "/");
  ok("Login ← arrow returns to Home");
  await p.goForward(); await p.waitForURL(B + "/login");
  ok("browser Forward still works after using the arrow (arrow used real history)");
  await p.getByRole("link", { name: "Forgot password?" }).click(); await p.waitForURL(B + "/forgot-password");
  await back(p).click(); await p.waitForURL(B + "/login");
  ok("Forgot password ← arrow returns to Login");
  await p.getByRole("link", { name: "Get Started" }).click(); await p.waitForURL(B + "/register");
  await back(p).click(); await p.waitForURL(B + "/login");
  ok("Create account ← arrow returns to the previous page (Login)");
  await p.goto(B + "/"); await p.locator('a[href="/why-food-rescue"]').first().click(); await p.waitForURL(B + "/why-food-rescue");
  await back(p).click(); await p.waitForURL(B + "/");
  ok("Why food rescue ← arrow returns to Home");

  // ---------- direct access fallbacks ----------
  for (const route of ["/login", "/register", "/forgot-password", "/why-food-rescue"]) {
    const d = await newPage(); await d.goto(B + route); await settle(d);
    await back(d).click(); await d.waitForURL(B + "/");
    ok(`opened ${route} directly: arrow falls back to Home`);
    await d.context().close();
  }

  // ---------- signed-in donor ----------
  p = await newPage();
  await p.goto(B + "/"); await p.getByRole("link", { name: "Get Started" }).first().click(); await p.waitForURL(B + "/register");
  await registerDonor(p, `nav.${run}@example.org`); await settle(p);
  check(await back(p).count() === 0, "donor dashboard right after sign-up: no arrow back into the registration form");
  await p.getByRole("link", { name: "Incoming Requests" }).first().click(); await p.waitForURL(B + "/donor/requests");
  await p.getByRole("link", { name: "Our Impact" }).first().click(); await p.waitForURL(B + "/donor/impact");
  await back(p).click(); await p.waitForURL(B + "/donor/requests");
  ok("dashboard ← arrow goes to the previous dashboard page");
  await back(p).click(); await p.waitForURL(B + "/donor");
  ok("dashboard ← arrow again returns to the Donor dashboard");
  await p.goBack(); await settle(p);
  check(at(p) === "/register", "browser Back still moves through real history", at(p));
  await p.goForward(); await p.waitForURL(B + "/donor");
  await p.goto(B + "/donor/scanner"); await settle(p);   // direct open, same session
  check(await back(p).isVisible(), "dashboard sub-page opened directly shows an arrow");
  await back(p).click(); await p.waitForURL(B + "/donor");
  check(await p.getByText("Nav Test Hotel").first().isVisible(), "direct-open fallback goes to the donor's own dashboard, still signed in as the same donor");
  await p.goto(B + "/ngo"); await p.waitForURL(B + "/donor");
  ok("role guard unchanged: donor opening /ngo is sent to the donor portal");
  await p.goto(B + "/login"); await settle(p);   // typed URL = fresh page load, no in-app history
  await back(p).click(); await p.waitForURL(B + "/");
  ok("signed-in user who opens Login directly: arrow falls back to Home");

  // ---------- logout + browser Back (previously trapped on /login) ----------
  await p.goto(B + "/donor"); await p.getByRole("link", { name: "Incoming Requests" }).first().click(); await p.waitForURL(B + "/donor/requests");
  await p.getByRole("button", { name: "Logout" }).first().click(); await p.waitForURL(B + "/login");
  check(await back(p).isVisible(), "after logout the Login page offers a back arrow");
  await back(p).click(); await settle(p);
  check(!/^\/(donor|ngo|animal|admin)/.test(at(p)) && at(p) !== "/login", "after logout the arrow never re-enters the portal", at(p));
  const p2 = await newPage();
  await p2.goto(B + "/"); await p2.getByRole("link", { name: "Login" }).first().click(); await p2.waitForURL(B + "/login");
  await p2.getByLabel("Email address").fill(`nav.${run}@example.org`); await p2.getByLabel("Password", { exact: true }).fill("nav-pass-123");
  await p2.getByRole("button", { name: "Login", exact: true }).click(); await p2.waitForURL(B + "/donor");
  await p2.getByRole("link", { name: "Incoming Requests" }).first().click(); await p2.waitForURL(B + "/donor/requests");
  await p2.getByRole("button", { name: "Logout" }).first().click(); await p2.waitForURL(B + "/login");
  const seen = [];
  for (let k = 0; k < 4; k++) { await p2.goBack(); await settle(p2); seen.push(at(p2)); }
  check(seen.includes("/") && !seen.some(x => /^\/(donor|ngo|animal)/.test(x)), "browser Back after logout escapes /login without showing portal pages", seen.join(" → "));
  await p2.context().close();

  // ---------- layout ----------
  const signed = await newPage();
  await signed.goto(B + "/login");
  await signed.getByLabel("Email address").fill(`nav.${run}@example.org`); await signed.getByLabel("Password", { exact: true }).fill("nav-pass-123");
  await signed.getByRole("button", { name: "Login", exact: true }).click(); await signed.waitForURL(B + "/donor");
  const cookies = await signed.context().storageState();
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720], [820, 1180], [414, 896], [390, 844], [360, 740], [320, 640]]) {
    for (const [route, auth] of [["/login", false], ["/register", false], ["/why-food-rescue", false], ["/donor/requests", true]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: auth ? cookies : undefined });
      const q = await ctx.newPage(); q.on("pageerror", e => fail("pageerror " + e.message));
      await q.goto(B + route); await q.locator(".eb-back").waitFor({ timeout: 10000 });
      const r = await q.evaluate(() => {
        const btn = document.querySelector(".eb-back").getBoundingClientRect();
        const hit = (a, b) => a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5;
        const others = [".brand", ".crumb", ".public-header nav", ".public-actions", ".top-actions", ".auth-shell", ".role-register-header > div:last-child", "h1"]
          .flatMap(s => [...document.querySelectorAll(s)].map(e => [s, e.getBoundingClientRect()])).filter(([, b]) => b.width > 0);
        const sw = document.documentElement.scrollWidth; document.querySelector(".eb-back").style.display = "none";
        const swWithout = document.documentElement.scrollWidth; document.querySelector(".eb-back").style.display = "";
        // the arrow must not create sideways scrolling (pages may have their own, unrelated overflow)
        return { hScroll: sw > innerWidth && sw > swWithout, preExistingOverflow: swWithout > innerWidth ? swWithout : 0, size: [Math.round(btn.width), Math.round(btn.height)], left: Math.round(btn.left), top: Math.round(btn.top),
          inView: btn.left >= 0 && btn.right <= innerWidth, overlaps: others.filter(([, b]) => hit(btn, b)).map(([s]) => s) };
      });
      const label = `${w}px ${route}`;
      check(!r.hScroll && r.inView && r.overlaps.length === 0 && r.size[0] >= 36, `${label}: arrow ${r.size.join("×")} at top-left (${r.left},${r.top}), no overlap, adds no sideways scroll${r.preExistingOverflow ? ` (page already ${r.preExistingOverflow}px wide without the arrow)` : ""}`, JSON.stringify(r));
      if ([1366, 390, 320].includes(w)) await q.screenshot({ path: path.join(SHOTS, `nav-${w}-${route.replace(/\//g, "_")}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(h, 220) } });
      await ctx.close();
    }
  }
} catch (e) { fail(e.message); }
await browser.close();
console.log(failures ? `\n${failures} failure(s)` : "\nAll navigation checks passed");
process.exit(failures ? 1 : 0);
