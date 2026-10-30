#!/usr/bin/env node
// Concatenates supabase/migrations/*.sql into supabase/setup_all.sql (one
// transaction) for pasting into the Supabase SQL Editor. Run: pnpm db:bundle
import fs from "node:fs";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "../supabase/migrations");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
const out = [
  "-- EDIBELL: complete database setup for a NEW Supabase project.",
  "-- Generated from supabase/migrations by `pnpm db:bundle`. Do not edit by hand.",
  "-- Paste everything into Supabase → SQL Editor → New query → Run.",
  "-- It runs as one transaction: if anything fails, nothing is applied.",
  "-- Run it once. (With the Supabase CLI, use `npx supabase db push` instead.)",
  "",
  "begin;",
  ...files.map(f => `\n-- ===================== ${f} =====================\n${fs.readFileSync(path.join(dir, f), "utf8")}`),
  "\ncommit;\n",
].join("\n");
fs.writeFileSync(path.resolve(dir, "../setup_all.sql"), out);
console.log(`wrote supabase/setup_all.sql from ${files.length} migrations`);
