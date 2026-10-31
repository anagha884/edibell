#!/usr/bin/env node
/**
 * Multilingual (English / Kannada / Hindi) tests: default language, the
 * language selector on laptop and phone sizes, persistence across refresh,
 * navigation, portals and login/logout, leftover-English scan of every page,
 * layout (no clipping / horizontal scrolling) and that user content stays as
 * entered. Run after workflow.e2e.mjs and contact.e2e.mjs: it signs in as the
 * accounts those tests created, so the portal pages contain real data.
 *
 *   node tests/e2e/i18n.e2e.mjs http://localhost:3000 <screenshot dir>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const B = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const db = new pg.Pool({ connectionString: process.env.EDIBELL_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/edibell_e2e" });
let failures = 0;
const ok = m => console.log("PASS", m);
const fail = m => { failures++; console.log("FAIL", m); };
const check = (c, m, d = "") => (c ? ok(m) : fail(`${m} ${d}`));
const settle = p => p.waitForTimeout(600);

const browser = await chromium.launch();
const newPage = async (vp = { width: 1366, height: 800 }) => { const c = await browser.newContext({ viewport: vp }); const p = await c.newPage(); p.on("pageerror", e => fail("pageerror " + e.message)); return p; };
const htmlLang = p => p.evaluate(() => document.documentElement.lang);
const setLangStorage = (p, l) => p.evaluate(l => localStorage.setItem("edibell.lang", l), l);

// Text that is legitimately not translated: brand, standards, file types, units, source names, sample data.
const ALLOW = /EDIBELL|FSSAI|SDG|alt\+T|UNEP|FAO|SOFI|WRAP|FSANZ|FDA|ASPCA|PDF|JPEG|PNG|WebP|MB|CO₂e?|QR|NGO|README|Supabase|Geoapify|VITE_\w+|Google|OpenStreetMap|Leaflet|Food Waste Index|State of Food Security|you@example\.com|Green Valley Hotel|Happy Paws Shelter|Hope Foundation|Indiranagar|Bengaluru|MG Road|Shivajinagar|ABCDE-FGHJK-MNPQR-STVWX|[A-Z0-9]{5}(-[A-Z0-9]{5}){3}|\S+@\S+\.\w+|https?:\/\/\S+|\+91[\d ]+|\bkm\b/g;

async function userStrings() {
  const out = new Set();
  const add = v => { if (typeof v === "string" && v.trim().length > 1) out.add(v.trim()); else if (Array.isArray(v)) v.forEach(add); };
  for (const q of [
    "select org_name, contact_name, email, address, area, city, pincode, service_area, care_requirements, registration_no, about, verification_note from public.profiles",
    "select title, description, ingredients, allergen_notes, address, area, city, pickup_contact_name, handling_notes, restrictions, review_note, cancel_reason from public.listings",
    "select message, decline_reason, collection_note from public.requests",
    "select name, email, subject, message from public.contact_messages",
  ]) { try { for (const r of (await db.query(q)).rows) Object.values(r).forEach(add); } catch { /* column set differs: skip that table */ } }
  for (const r of (await db.query("select title, notes from public.animal_needs")).rows) Object.values(r).forEach(add);
  for (const r of (await db.query("select contact_name from public.profiles")).rows) add(r.contact_name?.split(/\s+/)[0]);   // first name in the greeting
  return [...out].sort((a, b) => b.length - a.length);
}

/** Visible text, placeholders, labels and alt text still in English after user content is removed. */
async function leftovers(p, user) {
  const found = await p.evaluate(() => {
    const out = [];
    const vis = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0); };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement; if (!el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) || el.closest(".leaflet-control-attribution, .eb-lang-menu, [lang=en]")) continue;
      if (n.textContent.trim() && vis(el)) out.push(n.textContent.trim());
    }
    for (const el of document.querySelectorAll("[placeholder],[aria-label],[title],img[alt]")) {
      if (el.closest(".leaflet-control-attribution, .eb-lang, .leaflet-container")) continue;
      for (const a of ["placeholder", "aria-label", "title", "alt"]) { const v = el.getAttribute(a); if (v && v.trim()) out.push(v.trim()); }
    }
    for (const o of document.querySelectorAll("select option")) if (o.textContent.trim()) out.push(o.textContent.trim());
    return out;
  });
  const bad = new Set();
  for (let t of found) {
    for (const u of user) if (t.includes(u)) t = t.split(u).join(" ");
    t = t.replace(ALLOW, " ");
    if (/[A-Za-z]{3,}/.test(t)) bad.add(t.replace(/\s+/g, " ").trim());
  }
  return [...bad];
}
async function layout(p) {
  return p.evaluate(() => {
    const over = document.scrollingElement.scrollWidth - window.innerWidth;
    const clipped = [...document.querySelectorAll("h1,h2,h3,button,a.button,label,.eb-lang-btn,.nav a,.side-nav a,.eb-pill,th")].filter(e => {
      const r = e.getBoundingClientRect(); if (!r.width) return false;
      const s = getComputedStyle(e); if (s.visibility === "hidden" || e.closest(".leaflet-container,.eb-lang-menu,[aria-hidden=true]")) return false;
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth) return false;   // inside a deliberately swipeable strip / table
      return r.left < -1 || r.right > window.innerWidth + 1 || (e.scrollWidth > e.clientWidth + 2 && s.overflow !== "visible" && s.textOverflow !== "ellipsis" && e.clientWidth > 0);
    }).map(e => `${e.tagName}.${e.className}: ${e.textContent.trim().slice(0, 40)}`);
    return { over, clipped: clipped.slice(0, 5) };
  });
}
async function overlaps(p, sel, others) {
  return p.evaluate(([sel, others]) => {
    const a = document.querySelector(sel)?.getBoundingClientRect(); if (!a || !a.width) return ["selector not visible"];
    return others.flatMap(o => [...document.querySelectorAll(o)]).filter(e => !e.closest(".eb-lang") && !e.contains(document.querySelector(sel))).filter(e => {
      const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden" && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    }).map(e => `${e.tagName}.${e.className}`);
  }, [sel, others]);
}
async function login(p, email, password, role) {
  await p.goto(B + "/login");
  await p.locator('input[type=email]').fill(email);
  await p.locator('input[type=password]').first().fill(password);
  await p.locator('form button[type=submit]').click();
  await p.waitForURL(new RegExp(`${B}/${role}`), { timeout: 15000 });
}

const latest = async prefix => (await db.query("select email from public.profiles where email like $1 order by created_at desc limit 1", [prefix + "%"])).rows[0]?.email;

try {
  const user = await userStrings();

  // ---------- default language + selector ----------
  let p = await newPage();
  await p.goto(B + "/"); await settle(p);
  check(await htmlLang(p) === "en", "first visit defaults to English (<html lang=en>)");
  check((await p.locator(".eb-lang-btn").first().innerText()).includes("EN"), "header selector shows EN by default");
  check(await p.getByRole("heading", { name: /second chance/ }).count() === 1, "English homepage text unchanged");
  for (const vp of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const q = await newPage(vp); await q.goto(B + "/"); await settle(q);
    const ov = await overlaps(q, ".public-header .eb-lang-btn, header .eb-lang-btn", ["header a", "header button", "header nav", "header img"]);
    const r = await q.locator(".eb-lang-btn").first().boundingBox();
    check(ov.length === 0 && r && r.x >= 0 && r.x + r.width <= vp.width, `selector fits in the header at ${vp.width}px without overlap`, JSON.stringify(ov));
    await q.locator(".eb-lang-btn").first().click();
    const m = await q.locator(".eb-lang-menu").boundingBox();
    const opts = await q.getByRole("option").allInnerTexts();
    check(m && m.x >= 0 && m.x + m.width <= vp.width && m.y + m.height <= vp.height && opts.join("|") === "English|ಕನ್ನಡ|हिन्दी", `dropdown opens fully on screen at ${vp.width}px with English, ಕನ್ನಡ, हिन्दी`, JSON.stringify({ m, opts }));
    await q.screenshot({ path: path.join(SHOTS, `i18n-selector-${vp.width}.png`) });
    await q.keyboard.press("Escape");
    check(await q.locator(".eb-lang-menu").count() === 0, `Escape closes the dropdown at ${vp.width}px`);
    await q.context().close();
  }

  // ---------- switch, persistence, navigation ----------
  await p.locator(".eb-lang-btn").first().click(); await p.getByRole("option", { name: "ಕನ್ನಡ" }).click(); await settle(p);
  check(await htmlLang(p) === "kn" && (await p.locator("h1").first().innerText()).includes("ಒಳ್ಳೆಯ"), "choosing ಕನ್ನಡ translates the page in place");
  check((await p.locator(".eb-lang-btn").first().innerText()).includes("ಕನ್ನಡ"), "selector shows the chosen language");
  await p.reload(); await settle(p);
  check(await htmlLang(p) === "kn", "Kannada survives a page refresh");
  await p.locator('a[href="/login"]').first().click(); await p.waitForURL(B + "/login"); await settle(p);
  check(await htmlLang(p) === "kn" && await p.locator(".auth-lang .eb-lang-btn").isVisible(), "Kannada carries over to Login, which has its own selector");
  check((await overlaps(p, ".auth-lang .eb-lang-btn", ["form", "input", "button", "a", "h1", "img"])).length === 0, "Login selector does not overlap the form, back arrow or brand panel");
  await p.locator(".auth-lang .eb-lang-btn").click(); await p.getByRole("option", { name: "हिन्दी" }).click(); await settle(p);
  check(await htmlLang(p) === "hi" && (await p.locator("body").innerText()).includes("लॉग इन"), "switching to हिन्दी on Login works");
  await p.goto(B + "/register"); await settle(p);
  check(await htmlLang(p) === "hi" && await p.locator(".eb-reg-right .eb-lang-btn").isVisible(), "Hindi carries over to Registration");
  await p.getByRole("button", { name: /भोजन दाता/ }).first().click(); await settle(p);
  check((await p.locator("body").innerText()).includes("भोजन दाता के रूप में आगे बढ़ें"), "registration role step is in Hindi");
  await p.context().close();

  // ---------- every page, both languages ----------
  const accounts = {
    donor: [await latest("donor."), "donor-pass-123"], ngo: [await latest("ngo."), "ngo-pass-123"], animal: [await latest("animal."), "animal-pass-123"], admin: [await latest("ops."), "admin-pass-123"],
  };
  const pages = {
    public: ["/", "/why-food-rescue", "/login", "/register", "/forgot-password", "/reset-password", "/no-such-page"],
    donor: ["/donor", "/donor/create", "/donor/requests", "/donor/donations", "/donor/scanner", "/donor/notifications", "/donor/impact", "/donor/profile"],
    ngo: ["/ngo", "/ngo/finder", "/ngo/requests", "/ngo/pickup", "/ngo/history", "/ngo/notifications", "/ngo/impact", "/ngo/profile"],
    animal: ["/animal", "/animal/finder", "/animal/requests", "/animal/pickup", "/animal/history", "/animal/notifications", "/animal/impact", "/animal/profile"],
    admin: ["/admin"],
  };
  for (const lang of ["kn", "hi"]) {
    for (const [group, routes] of Object.entries(pages)) {
      for (const vp of [{ width: 1366, height: 800 }, { width: 375, height: 812 }]) {
        p = await newPage(vp);
        if (group !== "public") {
          const [email, pw] = accounts[group];
          if (!email) { fail(`${group}: no test account found (run workflow/contact e2e first)`); await p.context().close(); continue; }
          await login(p, email, pw, group === "admin" ? "(donor|ngo|animal|admin)" : group);
        } else await p.goto(B + "/");
        await setLangStorage(p, lang);
        for (const r of routes) {
          await p.goto(B + r); await p.waitForLoadState("networkidle").catch(() => {}); await p.waitForTimeout(900);
          check(await htmlLang(p) === lang, `${lang} ${vp.width}px ${r}: page is in ${lang}`);
          if (vp.width === 1366) {
            const left = await leftovers(p, user);
            check(left.length === 0, `${lang} ${r}: no untranslated interface text`, JSON.stringify(left.slice(0, 12)));
          }
          const l = await layout(p);
          check(l.over <= 1 && l.clipped.length === 0, `${lang} ${vp.width}px ${r}: no horizontal scroll or clipped text`, JSON.stringify(l));
          if (group !== "public" && vp.width === 375) {
            const ov = await overlaps(p, ".eb-lang-portal .eb-lang-btn", [".topbar button", ".topbar a", ".top-actions > *", ".crumb", ".topbar h1"]);
            check(ov.length === 0, `${lang} 375px ${r}: portal selector does not overlap the top bar`, JSON.stringify(ov));
          }
          await p.screenshot({ path: path.join(SHOTS, `i18n-${lang}-${vp.width}-${r.replace(/\//g, "_") || "home"}.png`), fullPage: vp.width === 375 });
        }
        await p.context().close();
      }
    }
  }

  // ---------- login / logout persistence, user content untouched ----------
  p = await newPage();
  await p.goto(B + "/"); await setLangStorage(p, "kn");
  await login(p, accounts.donor[0], accounts.donor[1], "donor"); await settle(p);
  check(await htmlLang(p) === "kn", "Kannada is kept through login into the donor portal");
  const orgName = (await db.query("select org_name from public.profiles where email = $1", [accounts.donor[0]])).rows[0].org_name;
  await p.goto(B + "/donor/profile"); await settle(p);
  check(await p.locator(`input[value="${orgName}"]`).count() === 1, "organization name (user content) is shown exactly as entered");
  const title = (await db.query("select d.title from public.listings d join public.profiles pr on pr.id = d.donor_id where pr.email = $1 limit 1", [accounts.donor[0]])).rows[0]?.title;
  if (title) { await p.goto(B + "/donor/donations"); await settle(p); check((await p.locator("body").innerText()).includes(title), "food title (user content) is not translated"); }
  await p.locator('button:has-text("ಲಾಗ್ ಔಟ್"), a:has-text("ಲಾಗ್ ಔಟ್")').first().click(); await settle(p);
  check(await htmlLang(p) === "kn", "Kannada is kept after logout");
  await p.goto(B + "/ngo"); await p.waitForURL(B + "/login"); check(await htmlLang(p) === "kn", "logged-out redirect to Login is still Kannada");
  await login(p, accounts.ngo[0], accounts.ngo[1], "ngo"); await settle(p);
  check(await htmlLang(p) === "kn" && (await p.locator("body").innerText()).includes("ಆಹಾರ"), "moving to another portal (NGO) keeps Kannada");
  await p.locator(".eb-lang-portal .eb-lang-btn").click(); await p.getByRole("option", { name: "English" }).click(); await settle(p);
  check(await htmlLang(p) === "en" && (await p.locator("body").innerText()).includes("Dashboard"), "switching back to English inside the portal works without reload");
  await p.reload(); await settle(p);
  check(await htmlLang(p) === "en", "English choice is remembered too");

  // ---------- validation messages in the chosen language ----------
  await setLangStorage(p, "hi");
  await login(p, accounts.donor[0], accounts.donor[1], "donor");
  await p.goto(B + "/donor/create"); await settle(p);
  const bodyHi = await p.locator("body").innerText();
  check(bodyHi.includes("बचा हुआ भोजन साझा करें") || bodyHi.includes("भोजन"), "donor listing form is in Hindi");
  await p.context().close();
} catch (e) { fail("unexpected error: " + (e?.stack ?? e)); }
await browser.close(); await db.end();
console.log(failures ? `\n${failures} i18n check(s) failed` : "\nAll i18n checks passed");
process.exit(failures ? 1 : 0);
