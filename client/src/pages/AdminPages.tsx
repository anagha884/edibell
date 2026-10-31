import { useState } from "react";
import { tr, trList } from "@/i18n";
import { toast } from "sonner";
import { Building2, CheckCircle2, FileText, Mail, ShieldCheck, XCircle } from "lucide-react";
import { FOOD_ORIGIN_LABEL, FOOD_STATE_LABEL, ORG_DOCUMENT_TYPES, ROLE_LABEL, type AdminOverviewDTO, type DonationDTO } from "@shared/edibell";
import { api, errMsg, useFetch } from "@/lib/api";
import { ORG_DOCUMENT_BUCKET, supabase } from "@/lib/supabase";
import { Card, PageHeading, StatCard, Status } from "../components/BrandUI";
import { Empty, ErrorNote, FoodThumb, Loading, fmtDateTime, fmtQty, fmtWindow } from "../components/kit";

/**
 * EDIBELL administration: organization verification and animal-feed safety
 * review. Visible only to profiles an operator marked is_admin (see README);
 * every action is re-checked by the database.
 */
export function AdminPage() {
  const { data, error, loading, reload } = useFetch<AdminOverviewDTO>("/admin");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const openDoc = async (path: string) => {
    if (!supabase) return;
    const { data: signed, error: e } = await supabase.storage.from(ORG_DOCUMENT_BUCKET).createSignedUrl(path, 120);
    if (e || !signed) { toast.error(tr("The document could not be opened.")); return; }
    window.open(signed.signedUrl, "_blank", "noopener");
  };
  const verify = async (id: string, status: "verified" | "rejected") => {
    if (status === "rejected" && !notes[id]?.trim()) { toast.error(tr("Add a note explaining what the organization needs to fix.")); return; }
    setBusy(id);
    try { await api.post(`/admin/organizations/${id}`, { status, note: notes[id] ?? "" }); toast.success(status === "verified" ? tr("Organization verified.") : tr("Verification declined.")); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const review = async (d: DonationDTO, decision: "approve" | "reject") => {
    if (decision === "approve" && !window.confirm(tr("Approve \"{title}\" as animal feed for {species}? Only approve food you are satisfied is safe for these animals.", { title: d.title, species: trList(d.animalSpecies) }))) return;
    setBusy(d.id);
    try { await api.post(`/admin/listings/${d.id}`, { decision, note: notes[d.id] ?? "" }); toast.success(decision === "approve" ? tr("Listing approved.") : tr("Listing rejected.")); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  return <>
    <PageHeading eyebrow={tr("ADMINISTRATION")} title={tr("Verification & safety review")} subtitle={tr("Verify organizations and review animal-feed listings that need a safety check.")}/>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : data && <>
      <div className="stat-grid ngo-stat-grid">
        <StatCard label={tr("Organizations")} value={String(data.totals.organizations)} note={tr("{n} verified", { n: data.totals.verified })} icon={Building2}/>
        <StatCard label={tr("Active listings")} value={String(data.totals.activeListings)} note={tr("Across all donors")} icon={FileText}/>
        <StatCard label={tr("Verified pickups")} value={String(data.totals.completedPickups)} note={tr("{a} kg food · {b} kg feed", { a: Math.round(data.totals.humanFoodKg), b: Math.round(data.totals.animalFeedKg) })} icon={CheckCircle2} tone="mint"/>
      </div>

      <Card className="eb-section"><h2><ShieldCheck size={15}/> {tr("Organizations awaiting verification")} <em className="eb-count">{data.pendingOrganizations.length}</em></h2>
        {data.pendingOrganizations.length === 0 ? <Empty title={tr("No organizations waiting")}/> : <div className="eb-stack">{data.pendingOrganizations.map(o => <div key={o.id} className="eb-admin-row">
          <div><b>{o.orgName}</b> <small className="eb-muted">{tr(ROLE_LABEL[o.role])}{o.orgType ? ` · ${tr(o.orgType)}` : ""}</small>
            <dl className="eb-facts two">
              <div><dt>{tr("Contact")}</dt><dd>{o.contactName} · {o.phone} · {o.email}</dd></div>
              <div><dt>{tr("Address")}</dt><dd>{[o.address, o.area, o.city, o.pincode].filter(Boolean).join(", ")}</dd></div>
              <div><dt>{tr("Registration no.")}</dt><dd>{o.registrationNo || tr("Not provided")}</dd></div>
              <div><dt>{tr("Registered")}</dt><dd>{fmtDateTime(o.createdAt)}</dd></div>
              {o.role === "animal" && <div><dt>{tr("Species")}</dt><dd>{trList(o.species)}</dd></div>}
              <div><dt>{tr("Documents")}</dt><dd>{o.documents.length === 0 ? tr("None uploaded") : o.documents.map(d => <button key={d.id} type="button" className="text-button" onClick={() => void openDoc(d.path)}>{tr(ORG_DOCUMENT_TYPES.find(t => t.value === d.docType)?.label ?? d.docType)}</button>)}</dd></div>
            </dl></div>
          <div className="eb-stack">
            <input value={notes[o.id] ?? ""} onChange={e => setNotes(p => ({ ...p, [o.id]: e.target.value }))} placeholder={tr("Note to the organization (required to decline)")} maxLength={400} aria-label={tr("Note for {org}", { org: o.orgName })}/>
            <div className="eb-actions"><button className="button button-small" disabled={busy === o.id} onClick={() => void verify(o.id, "verified")}><CheckCircle2 size={13}/>  {tr("Verify")}</button>
              <button className="button button-outline button-small" disabled={busy === o.id} onClick={() => void verify(o.id, "rejected")}><XCircle size={13}/>  {tr("Decline")}</button></div>
          </div>
        </div>)}</div>}
      </Card>

      <Card className="eb-section"><h2>{tr("Animal-feed listings awaiting safety review")} <em className="eb-count">{data.reviewQueue.length}</em></h2>
        {data.reviewQueue.length === 0 ? <Empty title={tr("Nothing to review")}/> : <div className="eb-stack">{data.reviewQueue.map(d => <div key={d.id} className="eb-admin-row">
          <div className="eb-request-food"><FoodThumb src={d.photos[0]} alt={d.title}/><div><b>{d.title}</b><small>{tr(d.category)} · {fmtQty(d.quantity, d.unit)} · {tr("from {org}", { org: d.donor.name })}</small>
            <small>{tr("For {species} · origin: {origin} · {state}", { species: trList(d.animalSpecies), origin: tr(FOOD_ORIGIN_LABEL[d.foodOrigin]), state: tr(FOOD_STATE_LABEL[d.foodState]) })}</small>
            <small>{tr("Prepared {prepared} · safe until {safe} · pickup {window}", { prepared: fmtDateTime(d.preparedAt), safe: fmtDateTime(d.expiryAt), window: fmtWindow(d.pickupStart, d.pickupEnd) })}</small>
            <small>{tr("Ingredients: {list}", { list: d.ingredients })}{d.restrictions ? ` · ${tr("Restrictions: {text}", { text: d.restrictions })}` : ""}</small></div></div>
          <div className="eb-stack">
            <input value={notes[d.id] ?? ""} onChange={e => setNotes(p => ({ ...p, [d.id]: e.target.value }))} placeholder={tr("Review note (shared with the donor)")} maxLength={400} aria-label={tr("Review note for {title}", { title: d.title })}/>
            <div className="eb-actions"><button className="button button-small" disabled={busy === d.id} onClick={() => void review(d, "approve")}>{tr("Approve as feed")}</button>
              <button className="button button-outline button-small" disabled={busy === d.id} onClick={() => void review(d, "reject")}>{tr("Reject")}</button></div>
          </div>
        </div>)}</div>}
      </Card>
    </>}
    <ContactMessages/>
  </>;
}

type ContactMessage = { id: string; name: string; email: string; subject: string; message: string; status: "new" | "read" | "archived"; createdAt: string; handledAt: string | null; fromAccount: boolean };

/** Messages sent through the public "Get in Touch" form (admins only). */
function ContactMessages() {
  const [filter, setFilter] = useState<"open" | "archived">("open");
  const { data, error, loading, reload } = useFetch<ContactMessage[]>(`/admin/messages?status=${filter}`);
  const [busy, setBusy] = useState<string | null>(null);
  const setStatus = async (id: string, status: ContactMessage["status"]) => {
    setBusy(id);
    try { await api.post(`/admin/messages/${id}`, { status }); reload(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const unread = (data ?? []).filter(m => m.status === "new").length;
  return <Card className="eb-section"><h2><Mail size={15}/> {tr("Contact messages")} {filter === "open" && <em className="eb-count">{tr("{n} new", { n: unread })}</em>}</h2>
    <div className="eb-actions eb-count-line">
      <button type="button" className={`button button-small ${filter === "open" ? "" : "button-outline"}`} aria-pressed={filter === "open"} onClick={() => setFilter("open")}>{tr("Inbox")}</button>
      <button type="button" className={`button button-small ${filter === "archived" ? "" : "button-outline"}`} aria-pressed={filter === "archived"} onClick={() => setFilter("archived")}>{tr("Archived")}</button>
    </div>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : data && (data.length === 0 ? <Empty title={filter === "open" ? tr("No messages yet") : tr("No archived messages")}/> : <div className="eb-stack">{data.map(m => <div key={m.id} className="eb-admin-row">
      <div><b>{m.subject}</b> {m.status === "new" && <Status tone="amber">{tr("New")}</Status>}
        <dl className="eb-facts two">
          <div><dt>{tr("From")}</dt><dd>{m.name} · <a href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${m.subject}`)}`}>{m.email}</a>{m.fromAccount ? ` · ${tr("signed-in user")}` : ""}</dd></div>
          <div><dt>{tr("Received")}</dt><dd>{fmtDateTime(m.createdAt)}</dd></div>
        </dl>
        <p className="eb-message-text">{m.message}</p></div>
      <div className="eb-actions">
        {m.status === "new" && <button className="button button-small" disabled={busy === m.id} onClick={() => void setStatus(m.id, "read")}><CheckCircle2 size={13}/>  {tr("Mark read")}</button>}
        {m.status !== "archived" ? <button className="button button-outline button-small" disabled={busy === m.id} onClick={() => void setStatus(m.id, "archived")}>{tr("Archive")}</button>
          : <button className="button button-outline button-small" disabled={busy === m.id} onClick={() => void setStatus(m.id, "read")}>{tr("Move to inbox")}</button>}
      </div>
    </div>)}</div>)}
  </Card>;
}
