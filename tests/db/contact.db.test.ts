/**
 * Contact Us messages (migration 20261030150000): validation, abuse limits,
 * privacy (nobody but admins can read messages) and admin status changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, anon, as, donorMeta, pool, q, rejects, rpc, signUp } from "./harness";

let member: string, adminUser: string;
const msg = (over: Record<string, unknown> = {}) => ({ name: "Asha Rao", email: `asha.${Math.random().toString(36).slice(2)}@example.org`, subject: "Partnering with EDIBELL", message: "We run a college mess and would like to donate surplus food.", ...over });

/** Call submit_contact_message as an anonymous visitor from a given network address. */
async function submitFrom(ip: string, body: Record<string, unknown>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role anon");
    await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [JSON.stringify({ role: "anon" }), JSON.stringify({ "x-forwarded-for": `${ip}, 10.0.0.1` })]);
    const r = await c.query("select public.submit_contact_message($1::jsonb) as v", [JSON.stringify(body)]);
    await c.query("commit");
    return r.rows[0].v;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  member = await signUp(donorMeta({ orgName: "Contact Test Hotel" }), `contact.member.${Date.now()}@example.org`);
  adminUser = await signUp(donorMeta({ orgName: "Contact Test Ops" }), `contact.admin.${Date.now()}@example.org`);
  await admin("update public.profiles set is_admin = true where id = $1", [adminUser]);
});
afterAll(async () => {
  // Leave the database as we found it (the main suite expects a fresh install).
  await admin("delete from public.contact_messages");
  await admin("delete from auth.users where id = any($1::uuid[])", [[member, adminUser]]);
  await pool.end();
});

describe("submitting a message", () => {
  it("an anonymous visitor's valid message is stored and confirmed with its id", async () => {
    const out = await rpc(anon, "submit_contact_message", msg({ email: "  Visitor@Example.ORG " }));
    expect(out).toMatchObject({ ok: true });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await admin<{ email: string; status: string; user_id: string | null }>("select email, status, user_id from public.contact_messages where id = $1", [out.id]);
    expect(rows[0]).toMatchObject({ email: "visitor@example.org", status: "new", user_id: null });
  });

  it("a signed-in user's message is linked to their account", async () => {
    const out = await rpc(as(member), "submit_contact_message", msg());
    const rows = await admin<{ user_id: string }>("select user_id from public.contact_messages where id = $1", [out.id]);
    expect(rows[0].user_id).toBe(member);
  });

  it("rejects missing or invalid fields with clear messages and stores nothing", async () => {
    const before = (await admin<{ n: string }>("select count(*) n from public.contact_messages"))[0].n;
    await rejects(rpc(anon, "submit_contact_message", msg({ name: "" })), /Name is required/);
    await rejects(rpc(anon, "submit_contact_message", msg({ name: "A" })), /enter your name/);
    await rejects(rpc(anon, "submit_contact_message", msg({ email: "not-an-email" })), /valid email/);
    await rejects(rpc(anon, "submit_contact_message", msg({ subject: "hi" })), /subject/);
    await rejects(rpc(anon, "submit_contact_message", msg({ message: "too short" })), /at least 10/);
    await rejects(rpc(anon, "submit_contact_message", msg({ message: "x".repeat(4001) })), /too long/);
    await rejects(rpc(anon, "submit_contact_message", msg({ website: "http://spam.example" })), /could not be sent/);
    const after = (await admin<{ n: string }>("select count(*) n from public.contact_messages"))[0].n;
    expect(after).toBe(before);
  });

  it("limits repeated messages from one email address", async () => {
    const email = "repeat.sender@example.org";
    for (let i = 0; i < 3; i++) await rpc(anon, "submit_contact_message", msg({ email }));
    await rejects(rpc(anon, "submit_contact_message", msg({ email })), /sent several messages recently/);
  });

  it("limits repeated messages from one network address, storing only a hash of it", async () => {
    for (let i = 0; i < 5; i++) await submitFrom("203.0.113.7", msg());
    await rejects(submitFrom("203.0.113.7", msg()), /sent several messages recently/);
    expect(await submitFrom("198.51.100.9", msg())).toMatchObject({ ok: true });
    const stored = await admin<{ sender_hash: string }>("select distinct sender_hash from public.contact_messages where sender_hash <> ''");
    expect(stored.length).toBe(2);
    for (const r of stored) { expect(r.sender_hash).toMatch(/^[0-9a-f]{64}$/); expect(r.sender_hash).not.toContain("203.0.113.7"); }
  });
});

describe("privacy and administration", () => {
  it("visitors and ordinary users cannot read messages", async () => {
    await rejects(q(anon, "select * from public.contact_messages"), /permission denied/);
    await rejects(q(as(member), "select * from public.contact_messages"), /permission denied/);
    await rejects(q(anon, "select public.admin_list_contact_messages('all')"), /permission denied/);
    await rejects(rpc(as(member), "admin_list_contact_messages", "all"), /Administrator access/);
    await rejects(q(as(member), "insert into public.contact_messages (name, email, subject, message) values ('x y','a@b.co','abc','0123456789')"), /permission denied/);
  });

  it("admins list messages and mark them read or archived", async () => {
    const list = await rpc(as(adminUser), "admin_list_contact_messages", "open");
    expect(list.length).toBeGreaterThan(5);
    expect(list[0]).toHaveProperty("subject");
    expect(new Date(list[0].createdAt) >= new Date(list[list.length - 1].createdAt)).toBe(true);
    const id = list[0].id;
    await rejects(rpc(as(member), "admin_set_contact_message_status", id, "read"), /Administrator access/);
    expect(await rpc(as(adminUser), "admin_set_contact_message_status", id, "archived")).toMatchObject({ status: "archived" });
    const open = await rpc(as(adminUser), "admin_list_contact_messages", "open");
    expect(open.some((m: { id: string }) => m.id === id)).toBe(false);
    const archived = await rpc(as(adminUser), "admin_list_contact_messages", "archived");
    expect(archived.map((m: { id: string }) => m.id)).toContain(id);
    await rejects(rpc(as(adminUser), "admin_set_contact_message_status", id, "deleted"), /Unknown message status/);
  });
});
