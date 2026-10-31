#!/usr/bin/env node
/**
 * EDIBELL translation coverage check.   Run:  pnpm check:i18n   (add --write to refresh keys.json)
 *
 * Builds the list of every English text the interface can display:
 *   - literals passed to tr()/trx() in client/src,
 *   - option lists and label tables that are translated at display time
 *     (shared/edibell.ts, navigation, status labels, awareness facts…),
 *   - system text written by the database (errors, notifications, scan
 *     results, impact notes) and the client's own error messages,
 * then reports any text missing from the Kannada or Hindi dictionary.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const keys = new Map();               // text -> Set(source)
const add = (text, src) => { if (!text || !/[A-Za-z]{2,}/.test(text) || /^\//.test(text.trim()) || /^[A-Z]+:[A-Z]+:/.test(text)) return;   // skip URL paths and the QR payload prefix
  text = text.trim(); (keys.get(text) ?? keys.set(text, new Set()).get(text)).add(src); };
const ALLOW_ENGLISH = new Set(["EDIBELL"]);   // brand name: same in every language

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["ui", "node_modules", "_core"].includes(e.name)) walkFiles(p, out); }
    else if (/\.(tsx?|mts)$/.test(e.name) && !/i18n[\\/](kn|hi)\.ts$/.test(p)) out.push(p);
  }
  return out;
}
const parse = p => ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true, p.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const strings = node => { const out = []; const v = n => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text); ts.forEachChild(n, v); }; v(node); return out; };

// 1. tr()/trx() literals ------------------------------------------------------
for (const f of walkFiles("client/src")) {
  const sf = parse(f);
  const v = n => {
    if (ts.isCallExpression(n) && ["tr", "trx"].includes(n.expression.getText()) && n.arguments[0]) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) add(a.text, f);
      else if (ts.isConditionalExpression(a)) for (const s of strings(a)) add(s, f);   // tr(cond ? "A" : "B")
    }
    ts.forEachChild(n, v);
  };
  v(sf);
}

// 2. tables translated at display time ---------------------------------------
const TABLES = {
  "client/src/components/Portal.tsx": ["NAV", "WORKSPACE", "ADMIN_ITEM"],
  "client/src/pages/DonorPages.tsx": ["TAG_LABEL"],
  "client/src/pages/RecipientPages.tsx": ["FINDER_NAME", "REQUESTS_NAME", "qrCopy"],
  "client/src/pages/AuthPages.tsx": ["roleOptions"],
  "client/src/data/demo.ts": ["categories"],
};
const LABEL_KEYS = new Set(["label", "title", "summary", "detail", "text"]);
for (const [file, names] of Object.entries(TABLES)) {
  const sf = parse(file);
  const v = n => {
    if (ts.isVariableDeclaration(n) && names.includes(n.name.getText()) && n.initializer) {
      const w = x => {
        if (ts.isPropertyAssignment(x) && (ts.isStringLiteral(x.initializer)) && !LABEL_KEYS.has(x.name.getText()) && !["NAV", "ADMIN_ITEM", "qrCopy", "roleOptions"].includes(n.name.getText())) add(x.initializer.text, file);
        if (ts.isPropertyAssignment(x) && ts.isStringLiteral(x.initializer) && LABEL_KEYS.has(x.name.getText())) add(x.initializer.text, file);
        if (ts.isArrayLiteralExpression(x)) x.elements.forEach(e => ts.isStringLiteral(e) && add(e.text, file));
        ts.forEachChild(x, w);
      };
      w(n.initializer);
    }
    ts.forEachChild(n, v);
  };
  v(sf);
}
// inline value maps passed to tr(): food-state short labels, tab labels, statuses
{ const sf = parse("client/src/pages/RecipientPages.tsx"); const v = n => { if (ts.isObjectLiteralExpression(n) && n.properties.some(p => p.name?.getText() === "\"room-temperature\"")) strings(n).forEach(s => add(s, "FoodCard state")); ts.forEachChild(n, v); }; v(sf); }
for (const s of ["all", "pending", "accepted", "completed", "declined", "cancelled", "expired"]) add(s[0].toUpperCase() + s.slice(1), "status tabs");

// shared/edibell.ts: every exported list / label table that is displayed
{
  const sf = parse("shared/edibell.ts");
  const DISPLAYED = /^(ROLE_LABEL|VERIFICATION_LABEL|FOOD_STATE_LABEL|FOOD_ORIGIN_LABEL|HUMAN_CATEGORIES|ANIMAL_CATEGORIES|UNITS|PACKAGING|STORAGE_OPTIONS|ALLERGENS|ANIMAL_SPECIES|DONOR_TYPES|NGO_TYPES|ANIMAL_ORG_TYPES|ORG_DOCUMENT_TYPES|HUMAN_SAFETY_CHECKS|ANIMAL_SAFETY_CHECKS|ANIMAL_ONION_CHECK|DIET_TYPES)$/;
  const v = n => {
    if (ts.isVariableDeclaration(n) && DISPLAYED.test(n.name.getText()) && n.initializer) {
      const name = n.name.getText();
      const w = x => {
        if (ts.isPropertyAssignment(x) && ts.isStringLiteral(x.initializer)) { if (!["key", "value"].includes(x.name.getText())) add(x.initializer.text, "shared/" + name); }
        else if (ts.isStringLiteral(x) && !(x.parent && ts.isPropertyAssignment(x.parent))) add(name === "DIET_TYPES" ? x.text.replace("-", " ") : x.text, "shared/" + name);
        ts.forEachChild(x, w);
      };
      w(n.initializer);
    }
    ts.forEachChild(n, v);
  };
  v(sf);
}
// awareness facts & guidance (source names and report titles stay in English)
{
  const sf = parse("client/src/data/awareness.ts");
  const v = n => {
    if (ts.isPropertyAssignment(n) && ["value", "unit", "statement", "scope", "definition", "note", "title", "dataYear"].includes(n.name.getText()) && ts.isStringLiteral(n.initializer)) add(n.initializer.text, "awareness");
    if (ts.isPropertyAssignment(n) && n.name.getText() === "points" && ts.isArrayLiteralExpression(n.initializer)) n.initializer.elements.forEach(e => ts.isStringLiteral(e) && add(e.text, "awareness"));
    ts.forEachChild(n, v);
  };
  v(sf);
}
// listing availability / status words used inside messages and pills
for (const s of ["available", "fully reserved", "under review", "rejected", "expired", "active", "cancelled", "completed", "pending", "accepted", "declined"]) add(s, "status words");

// 3. system text from the database + client error constants ----------------------
for (const f of fs.readdirSync(path.join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).map(f => "supabase/migrations/" + f)) {
  const sql = read(f);
  const lit = s => s.replace(/''/g, "'");
  for (const m of sql.matchAll(/app\.fail\('((?:[^']|'')*)'/g)) add(lit(m[1]), "db:fail");
  for (const m of sql.matchAll(/then '((?:[^']|'')*)'/g)) add(lit(m[1]), "db:case");
  for (const m of sql.matchAll(/else '((?:[^']|'')*)'\s*end/g)) add(lit(m[1]), "db:case");
  for (const m of sql.matchAll(/app\.notify\([^,]+,\s*'[a-z-]+',\s*'((?:[^']|'')*)'/g)) add(lit(m[1]), "db:notify-title");
  for (const m of sql.matchAll(/app\.notify\([^,]+,\s*'[a-z-]+',\s*'(?:[^']|'')*',\s*'((?:[^']|'')*)'/g)) add(lit(m[1]), "db:notify-body");
  for (const m of sql.matchAll(/app\.(?:txt|num|ts|one_of|list)\(\w+, '\w+', '((?:[^']|'')*)'/g)) add(lit(m[1]), "db:field");
  for (const m of sql.matchAll(/'assumptions', jsonb_build_array\(([\s\S]*?)\)\s*\)/g)) for (const a of m[1].matchAll(/'((?:[^']|'')*)'/g)) add(lit(a[1]), "db:assumption");
}
{ const src = read("client/src/i18n/server.ts"); for (const m of src.matchAll(/key: "((?:[^"\\]|\\.)*)"/g)) add(JSON.parse(`"${m[1]}"`), "server-template"); }
for (const f of ["client/src/auth/session.tsx", "client/src/lib/api.ts", "client/src/components/Map.tsx", "client/src/components/QrTools.tsx"]) {
  const sf = parse(f);
  const v = n => {
    if ((ts.isNewExpression(n) && /ApiError|Error/.test(n.expression.getText())) || (ts.isCallExpression(n) && /setError|setState/.test(n.expression.getText())))
      for (const s of strings(n)) if (/\s/.test(s) && /[.!?]$/.test(s.trim())) add(s, f);
    if (ts.isVariableDeclaration(n) && /MESSAGE$/.test(n.name.getText()) && n.initializer && ts.isStringLiteral(n.initializer)) add(n.initializer.text, f);
    ts.forEachChild(n, v);
  };
  v(sf);
}
add("Something went wrong.", "errMsg");

// ---------------------------------------------------------------------------
const loadDict = lang => {
  const sf = parse(`client/src/i18n/${lang}.ts`);
  const d = new Map();
  const v = n => { if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isNoSubstitutionTemplateLiteral(n.name)) && ts.isStringLiteral(n.initializer)) d.set(n.name.text, n.initializer.text); ts.forEachChild(n, v); };
  v(sf);
  return d;
};
const all = [...keys.keys()].filter(k => !ALLOW_ENGLISH.has(k)).sort();
let failed = 0;
for (const lang of ["kn", "hi"]) {
  const d = loadDict(lang);
  const missing = all.filter(k => !d.has(k));
  const extra = [...d.keys()].filter(k => !keys.has(k));
  const placeholders = all.filter(k => d.has(k)).filter(k => {
    const want = (k.match(/\{\w+\}|<\/?\w+\/?>/g) ?? []).sort().join();
    const got = (d.get(k).match(/\{\w+\}|<\/?\w+\/?>/g) ?? []).sort().join();
    return want !== got;
  });
  console.log(`${lang}: ${all.length - missing.length}/${all.length} translated, ${missing.length} missing, ${extra.length} unused, ${placeholders.length} placeholder mismatches`);
  if (process.argv.includes("--list")) missing.forEach(k => console.log(`  missing [${[...keys.get(k)][0]}] ${JSON.stringify(k)}`));
  placeholders.forEach(k => console.log(`  placeholder mismatch: ${JSON.stringify(k)}`));
  if (process.argv.includes("--extra")) extra.forEach(k => console.log(`  unused ${JSON.stringify(k)}`));
  failed += missing.length + placeholders.length;
}
if (process.argv.includes("--write")) fs.writeFileSync(path.join(root, "client/src/i18n/keys.json"), JSON.stringify(all, null, 1) + "\n");
process.exit(failed ? 1 : 0);
