/**
 * Static contract checks between the browser client and the database:
 * every RPC the client calls must exist in the migrations with exactly the
 * argument names the client sends, and shared helpers must match SQL rules.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatPickupCode, parsePickupCode, toKg, UNITS } from "../../shared/edibell";

const root = path.resolve(import.meta.dirname, "../..");
const sql = fs.readdirSync(path.join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort()
  .map(f => fs.readFileSync(path.join(root, "supabase/migrations", f), "utf8")).join("\n");

function sqlFunctions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)) {
    const args = m[2].split(",").map(a => a.trim()).filter(Boolean).map(a => a.split(/\s+/)[0]);
    out.set(m[1], args);
  }
  return out;
}

function clientCalls(): { fn: string; args: string[] }[] {
  const files = ["client/src/lib/api.ts", "client/src/auth/session.tsx"].map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  const calls: { fn: string; args: string[] }[] = [];
  for (const m of files.matchAll(/call\("(\w+)"(?:,\s*\{([^}]*)\})?\)/g)) {
    const args = (m[2] ?? "").split(",").map(s => s.trim().split(":")[0].trim()).filter(Boolean);
    calls.push({ fn: m[1], args });
  }
  for (const m of files.matchAll(/\.rpc\("(\w+)"\)/g)) calls.push({ fn: m[1], args: [] });
  return calls;
}

describe("client ↔ database contract", () => {
  const fns = sqlFunctions();
  const calls = clientCalls();
  it("finds the client calls", () => { expect(calls.length).toBeGreaterThan(20); });
  for (const c of calls) {
    it(`${c.fn}(${c.args.join(", ")}) exists with matching argument names`, () => {
      expect(fns.has(c.fn), `missing SQL function public.${c.fn}`).toBe(true);
      const declared = fns.get(c.fn)!;
      for (const a of c.args) expect(declared).toContain(a);
    });
  }
  it("every callable function is granted explicitly", () => {
    for (const c of calls) expect(sql).toMatch(new RegExp(`public\\.${c.fn}\\(`));
  });
});

describe("pickup codes", () => {
  it("parses QR payloads and typed codes, tolerating separators and look-alikes", () => {
    const code = "0123456789ABCDEFGHJK";
    expect(parsePickupCode(`EDIBELL:PICKUP:v1:${code}`)).toBe(code);
    expect(parsePickupCode(formatPickupCode(code).toLowerCase())).toBe(code);
    expect(parsePickupCode("O123456789ABCDEFGHJK")).toBe(code);
    expect(parsePickupCode("not a code")).toBeNull();
    expect(parsePickupCode("7f1c2b4e-9a77-4c1e-9a0f-1f2e3d4c5b6a")).toBeNull();
  });
});

describe("kg-equivalent conversion matches the database", () => {
  it("uses the same factors as app.to_kg()", () => {
    const m = /app\.to_kg[\s\S]*?case p_unit([\s\S]*?)else 1 end/.exec(sql)!;
    const pairs = Object.fromEntries([...m[1].matchAll(/when '(\w+)' then ([\d.]+)/g)].map(x => [x[1], Number(x[2])]));
    for (const u of UNITS) expect(toKg(1, u)).toBeCloseTo(pairs[u], 6);
  });
});
