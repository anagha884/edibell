#!/usr/bin/env node
/**
 * Browser test of the public footer and "Get in Touch" form against the real
 * migrations (via tests/e2e/local-supabase.mjs). Submissions are checked in
 * the database itself, and an administrator reads them in the Admin page.
 *
 *   node tests/e2e/contact.e2e.mjs http://localhost:3000 <screenshot dir>
 */
import { chromium } from "playwright";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.EDIBELL_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/edibell_e2e" });
const run = Date.now().toString(36);
let failures = 0;
const ok = m => console.log("PASS", m);
const fail = m => { failures++; console.log("FAIL", m); };
const check = (cond, m, detail = "") => cond ? ok(m) : fail(`${m} ${detail}`);

const browser = await chromium.launch();
try {
  // ---------- layout at laptop, tablet and phone sizes ----------
  const sizes = [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [820, 1180], [414, 896], [390, 844], [360, 740], [320, 640]];
  for (const [w, h] of sizes) {
    for (const route of ["/", "/why-food-rescue"]) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = []; p.on("pageerror", e => errors.push(e.message));
      await p.goto(BASE + route); await p.locator(".site-footer").waitFor();
      const r = await p.evaluate(() => {
        const sel = [".site-footer .sf-brand", ".site-footer .sf-tagline", ".site-footer .sf-mission", ".site-footer .sf-contact h3", ".sf-contact li:nth-child(1) a", ".sf-contact li:nth-child(2) a", ".sf-message",
          ".ct-intro h2", ".ct-intro>p", ".ct-direct li:nth-child(1) a", ".ct-direct li:nth-child(2) a", "#ct-name", "#ct-email", "#ct-subject", "#ct-message", ".ct-submit", ".ct-hint"];
        const boxes = sel.map(s => [s, document.querySelector(s)?.getBoundingClientRect()]).filter(([, b]) => b && b.width > 0);
        const overlaps = [];
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const [a, A] = boxes[i], [b, B] = boxes[j];
          if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) overlaps.push(`${a} × ${b}`);
        }
        const clipped = [...document.querySelectorAll(".site-footer *, .ct-section *")].filter(e => {
          if (e.closest(".ct-trap")) return false;
          const b = e.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > window.innerWidth + 1);
        }).map(e => e.className || e.tagName).slice(0, 3);
        const nav = !!document.querySelector('.public-header a[href="/#contact"]');
        return { hScroll: document.documentElement.scrollWidth > window.innerWidth + 1, overlaps, clipped, nav, hasContact: !!document.querySelector("#contact") };
      });
      const label = `${w}x${h} ${route}`;
      check(!r.hScroll && r.overlaps.length === 0 && r.clipped.length === 0 && errors.length === 0, `${label}: no horizontal scroll, overlaps, clipping or errors`, JSON.stringify({ ...r, errors }));
      if (route === "/") check(r.hasContact, `${label}: Get in Touch section present`);
      if ([1366, 390, 320].includes(w)) {
        await p.locator(route === "/" ? "#contact" : ".site-footer").scrollIntoViewIfNeeded();
        await p.screenshot({ path: path.join(SHOTS, `contact-${w}${route === "/" ? "-home" : "-why"}.png`), fullPage: true });
      }
      await p.close();
    }
  }

  // ---------- links ----------
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on("pageerror", e => fail("pageerror: " + e.message));
  await page.goto(BASE + "/");
  const hrefs = await page.$$eval(".site-footer a, .ct-direct a", as => as.map(a => a.getAttribute("href")));
  check(hrefs.includes("mailto:edibell.connect@gmail.com") && hrefs.includes("tel:+917019489702"), "email uses mailto: and phone uses tel: with the official details", JSON.stringify(hrefs));
  const footerText = await page.locator(".site-footer").innerText();
  check(footerText.includes("edibell.connect@gmail.com") && footerText.includes("+91 70194 89702") && footerText.includes("Rescue food. Feed people. Nourish animals."), "footer shows email, formatted phone and tagline");
  check(!/instagram|facebook|linkedin|twitter|quick links/i.test(footerText) && (await page.locator(".site-footer svg").count()) >= 2, "no social links or quick links in the footer");
  check(await page.locator(".sf-logo img").evaluate(i => i.complete && i.naturalWidth > 0 && i.getAttribute("src") === "/edibell-logo.png"), "footer shows the EDIBELL logo image");
  await page.locator('.public-header a[href="/#contact"]').click();
  await page.waitForFunction(() => { const r = document.querySelector("#contact").getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
  ok("header 'Contact Us' link scrolls to the Get in Touch section");

  // ---------- validation ----------
  const count = async () => Number((await db.query("select count(*) from public.contact_messages")).rows[0].count);
  const before = await count();
  let rpcCalls = 0; page.on("request", r => { if (r.url().includes("submit_contact_message")) rpcCalls++; });
  await page.getByRole("button", { name: "Send Message" }).click();
  const errs = await page.locator(".ct-error").allInnerTexts();
  check(errs.length === 4 && rpcCalls === 0, "empty form shows 4 field errors and sends nothing", JSON.stringify(errs));
  check(await page.evaluate(() => document.activeElement?.id === "ct-name"), "focus moves to the first invalid field");
  await page.locator("#ct-name").fill("Asha Rao");
  await page.locator("#ct-email").fill("asha@invalid");
  await page.locator("#ct-subject").fill("Hi");
  await page.locator("#ct-message").fill("short");
  await page.getByRole("button", { name: "Send Message" }).click();
  const errs2 = await page.locator(".ct-error").allInnerTexts();
  check(errs2.length === 3 && errs2.some(e => /valid email/.test(e)) && rpcCalls === 0, "invalid email, short subject and short message are caught", JSON.stringify(errs2));
  check(await count() === before, "nothing was stored for invalid input");

  // ---------- backend failure: no false success ----------
  await page.locator("#ct-email").fill(`asha.${run}@example.org`);
  await page.locator("#ct-subject").fill("Partnering with EDIBELL");
  await page.locator("#ct-message").fill("We run a college mess in Bengaluru and would like to donate surplus food every evening.");
  await page.route("**/rest/v1/rpc/submit_contact_message", r => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Service unavailable" }) }));
  await page.getByRole("button", { name: "Send Message" }).click();
  await page.locator(".ct-note-error").waitFor({ timeout: 8000 });
  check((await page.locator(".ct-note-ok").count()) === 0 && (await page.locator("#ct-message").inputValue()).length > 20, "server error shows 'not sent', keeps the text, never shows success");
  await page.screenshot({ path: path.join(SHOTS, "contact-error.png") });
  await page.unroute("**/rest/v1/rpc/submit_contact_message");

  // ---------- real submission ----------
  await page.getByRole("button", { name: "Send Message" }).click();
  await page.locator(".ct-note-ok").waitFor({ timeout: 8000 });
  const stored = (await db.query("select name, email, subject, status from public.contact_messages where email = $1", [`asha.${run}@example.org`])).rows;
  check(stored.length === 1 && stored[0].status === "new" && stored[0].subject === "Partnering with EDIBELL", "success is shown only after the message is stored in the database", JSON.stringify(stored));
  check((await page.locator("#ct-name").inputValue()) === "", "form clears after a confirmed send");
  await page.locator("#contact").screenshot({ path: path.join(SHOTS, "contact-success.png") });

  // ---------- server-side limit surfaces as an error ----------
  for (let i = 0; i < 3; i++) {
    await page.locator("#ct-name").fill("Repeat Sender"); await page.locator("#ct-email").fill(`repeat.${run}@example.org`);
    await page.locator("#ct-subject").fill(`Question ${i}`); await page.locator("#ct-message").fill("Is there a minimum quantity for donations?");
    await page.getByRole("button", { name: "Send Message" }).click();
    await page.waitForFunction(() => document.querySelector("#ct-name").value === "" && !document.querySelector(".ct-submit").disabled, null, { timeout: 8000 });
  }
  await page.locator("#ct-name").fill("Repeat Sender"); await page.locator("#ct-email").fill(`repeat.${run}@example.org`);
  await page.locator("#ct-subject").fill("Question 4"); await page.locator("#ct-message").fill("Is there a minimum quantity for donations?");
  await page.getByRole("button", { name: "Send Message" }).click();
  await page.locator(".ct-note-error").waitFor();
  check(/several messages recently/.test(await page.locator(".ct-note-error").innerText()), "the database's rate limit is shown as a clear error");

  // ---------- admin inbox ----------
  const adminEmail = `ops.${run}@example.org`;
  const reg = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await reg.goto(`${BASE}/register`);
  await reg.getByRole("button", { name: /^Food Donor/ }).first().click();
  await reg.getByRole("button", { name: "Continue as Food Donor" }).click();
  await reg.getByLabel("Authorized contact person").fill("Ops Admin");
  await reg.getByLabel("Business / venue name").fill("EDIBELL Operations");
  await reg.getByLabel("Business type").selectOption({ index: 1 });
  await reg.getByLabel("Phone number").fill("+91 90000 00009");
  await reg.getByLabel("Street address").fill("1 Test Road");
  await reg.getByLabel("City *").fill("Bengaluru");
  await reg.getByLabel("Email address").fill(adminEmail);
  await reg.getByLabel("Create password").fill("admin-pass-123");
  await reg.getByLabel("Confirm password").fill("admin-pass-123");
  await reg.getByLabel(/I am authorized/).check();
  await reg.getByRole("button", { name: /Create .* Account/ }).click();
  await reg.waitForURL(`${BASE}/donor`);
  await db.query("update public.profiles set is_admin = true where email = $1", [adminEmail]); // operator action (README → Operations)
  await reg.goto(`${BASE}/admin`);
  await reg.getByText("Partnering with EDIBELL").first().waitFor({ timeout: 10000 });
  ok("administrator sees the submitted message in the Admin page");
  const row = reg.locator(".eb-admin-row", { hasText: "Partnering with EDIBELL" });
  check(await row.locator(`a[href^="mailto:asha.${run}@example.org"]`).count() === 1, "admin can reply via a mailto link");
  await row.getByRole("button", { name: "Archive" }).click();
  await reg.waitForFunction(() => ![...document.querySelectorAll(".eb-admin-row")].some(r => r.textContent.includes("Partnering with EDIBELL")));
  const st = (await db.query("select status, handled_at is not null h from public.contact_messages where email = $1", [`asha.${run}@example.org`])).rows[0];
  check(st.status === "archived" && st.h, "archiving updates the database");
  await reg.getByRole("button", { name: "Archived" }).click();
  await reg.getByText("Partnering with EDIBELL").first().waitFor();
  ok("archived messages are listed under Archived");
  await reg.screenshot({ path: path.join(SHOTS, "contact-admin.png"), fullPage: true });
} catch (e) { fail(e.message); }
await browser.close(); await db.end();
console.log(failures ? `\n${failures} failure(s)` : "\nAll contact checks passed");
process.exit(failures ? 1 : 0);
