import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Bell, CheckCheck, FileUp, Leaf, Scale, ShieldCheck, Soup, Wind } from "lucide-react";
import { Link } from "wouter";
import {
  ANIMAL_ORG_TYPES, ANIMAL_SPECIES, DONOR_TYPES, NGO_TYPES, ORG_DOCUMENT_TYPES, ROLE_LABEL, VERIFICATION_LABEL,
  type ImpactDTO, type NotificationDTO, type OrgDocumentDTO,
} from "@shared/edibell";
import { useSession } from "@/auth/session";
import { api, errMsg, useFetch } from "@/lib/api";
import { ORG_DOCUMENT_BUCKET, supabase } from "@/lib/supabase";
import { Card, PageHeading, StatCard, Status } from "../components/BrandUI";
import { BarList, ChipSelect, Empty, ErrorNote, Field, Loading, fmtDate, fmtDateTime, PasswordInput } from "../components/kit";
import { AnimalNeedsSection } from "./RecipientPages";

// ---------------------------------------------------------------------------
// Our Impact (every role sees the numbers that apply to them)
// ---------------------------------------------------------------------------
const kg = (n: number) => `${Math.round(n * 10) / 10} kg`;

export function ImpactPage() {
  const { user } = useSession();
  const { data, error, loading, reload } = useFetch<ImpactDTO>("/impact");
  if (!user) return null;
  const role = user.role;
  return <>
    <PageHeading eyebrow="OUR IMPACT" title={role === "donor" ? "Our Impact" : role === "ngo" ? "Our community impact" : "Our animal-care impact"}
      subtitle="Only handovers verified by a Pickup Pass scan are counted. Listed, requested or accepted food is not."/>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : data && <>
      <div className="stat-grid ngo-stat-grid">
        <StatCard label={role === "donor" ? "Food successfully donated" : "Food collected"} value={kg(data.completedFoodKg)} note={`${data.completedPickups} completed pickup${data.completedPickups === 1 ? "" : "s"}`} icon={Leaf}/>
        {role === "donor" && <StatCard label="Completed listings" value={String(data.completedDonations)} note={`of ${data.totalDonations} listed (${kg(data.totalFoodKg)} offered)`} icon={CheckCheck}/>}
        {role === "donor" && <StatCard label="To people / to animals" value={`${Math.round(data.humanFoodKg)} / ${Math.round(data.animalFeedKg)} kg`} note="Human food vs animal feed, kept separate" icon={Scale} tone="mint"/>}
        {role !== "animal" && <StatCard label="Meals supported" value={String(data.mealsSupported)} note="Estimate · human food only" icon={Soup} tone="mint"/>}
        {role === "animal" && <StatCard label="Animal feed received" value={kg(data.animalFeedKg)} note="Kg-equivalent, verified" icon={Soup} tone="mint"/>}
        <StatCard label="CO₂e avoided" value={`${Math.round(data.co2eAvoidedKg)} kg`} note="Rough estimate, see method" icon={Wind} tone="sage"/>
      </div>
      {data.completedPickups === 0 && <Empty title="No verified pickups yet" icon={<Leaf size={26}/>}>Your impact starts counting after the first handover is verified by a QR scan.</Empty>}
      <div className="eb-two-col">
        <Card className="eb-section"><h2>Over time (by month)</h2>{data.byMonth.length > 1 ? <BarList rows={data.byMonth.map(m => ({ label: m.month, value: m.kg }))}/> : <p className="eb-muted">{data.byMonth.length === 1 ? `${kg(data.byMonth[0].kg)} in ${data.byMonth[0].month}. Trends appear once there are at least two months of verified pickups.` : "Trends appear once verified pickups exist."}</p>}</Card>
        <Card className="eb-section"><h2>By food category</h2><BarList rows={data.byCategory.map(m => ({ label: m.category, value: m.kg }))}/></Card>
        <Card className="eb-section"><h2>{role === "donor" ? "By recipient organization" : "By donor"}</h2><BarList rows={data.byPartner.map(m => ({ label: `${m.name} (${m.pickups})`, value: m.kg }))}/></Card>
        {(role === "animal" || data.bySpecies.length > 0) && <Card className="eb-section"><h2>Animal feed by species</h2><BarList rows={data.bySpecies.map(m => ({ label: m.species, value: m.kg }))}/></Card>}
        <Card className="eb-section"><h2>How we calculate</h2>
          <ul className="eb-assumptions">{data.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
          <p className="eb-hint">Wider context on food waste: <Link href="/why-food-rescue">why food rescue matters</Link>.</p></Card>
      </div>
    </>}
  </>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export function NotificationsPage() {
  const { data, error, loading, reload } = useFetch<NotificationDTO[]>("/notifications", { pollMs: 60000 });
  const unread = data?.filter(n => !n.read).length ?? 0;
  const markAll = async () => { try { await api.post("/notifications/read", {}); reload(); } catch (e) { toast.error(errMsg(e)); } };
  const markOne = async (id: string) => { try { await api.post("/notifications/read", { ids: [id] }); reload(); } catch (e) { toast.error(errMsg(e)); } };
  return <>
    <PageHeading eyebrow="NOTIFICATIONS" title="Notifications" subtitle={unread ? `${unread} unread` : "You're all caught up."}
      action={unread > 0 ? <button className="button button-outline" onClick={() => void markAll()}><CheckCheck size={14}/> Mark all read</button> : undefined}/>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : !data || data.length === 0
      ? <Empty title="No notifications yet" icon={<Bell size={26}/>}>Request updates, new food, pickup reminders and confirmations will show up here.</Empty>
      : <Card className="eb-notes">{data.map(n => <div key={n.id} className={`eb-note ${n.read ? "" : "unread"}`}>
        <span className="eb-note-dot" aria-hidden="true"/>
        <div><b>{n.title}</b>{!n.read && <span className="eb-sr"> (unread)</span>}<p>{n.body}</p><small>{fmtDateTime(n.createdAt)}</small></div>
        <div className="eb-note-actions">{n.link && <Link href={n.link} className="text-button" onClick={() => { if (!n.read) void markOne(n.id); }}>Open</Link>}
          {!n.read && <button className="text-button" onClick={() => void markOne(n.id)}>Mark read</button>}</div></div>)}</Card>}
  </>;
}

// ---------------------------------------------------------------------------
// Organization settings / profile / Animal Care Profile
// ---------------------------------------------------------------------------
function VerificationCard() {
  const { user } = useSession();
  const { data: docs, reload } = useFetch<OrgDocumentDTO[]>("/documents");
  const [docType, setDocType] = useState<string>(ORG_DOCUMENT_TYPES[0].value);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!user) return null;
  const upload = async (file: File | undefined) => {
    if (!file || !supabase) return;
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Upload a PDF, JPEG, PNG or WebP file."); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error("Documents must be 10 MB or smaller."); return; }
    setBusy(true);
    try {
      const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1].replace("jpeg", "jpg");
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(ORG_DOCUMENT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      await api.post("/documents", { path, docType, fileName: file.name.slice(0, 200) });
      toast.success("Document uploaded for verification.");
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const tone = user.verificationStatus === "verified" ? "green" : user.verificationStatus === "rejected" ? "red" : "amber";
  return <Card className="eb-section"><h2><ShieldCheck size={15}/> Verification</h2>
    <p><Status tone={tone}>{VERIFICATION_LABEL[user.verificationStatus]}</Status></p>
    {user.verificationNote && <p className="eb-muted">Note from EDIBELL: {user.verificationNote}</p>}
    <p className="eb-muted">{user.verificationStatus === "verified" ? "Partners see that EDIBELL has verified your organization. Changing your organization name or registration number requires verification again."
      : "EDIBELL reviews your registration details and documents before marking your organization verified. Until then, partners see “Not yet verified”."}</p>
    <div className="eb-doc-upload">
      <select value={docType} onChange={e => setDocType(e.target.value)} aria-label="Document type">{ORG_DOCUMENT_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}</select>
      <label className={`button button-outline button-small ${busy ? "disabled" : ""}`}><FileUp size={13}/> {busy ? "Uploading…" : "Upload document"}
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={e => void upload(e.target.files?.[0])}/></label>
    </div>
    <small className="eb-hint">PDF or image, up to 10 MB. Documents are private: only your organization and EDIBELL administrators can open them.</small>
    {docs && docs.length > 0 && <ul className="eb-mini-list">{docs.map(d => <li key={d.id}><b>{ORG_DOCUMENT_TYPES.find(t => t.value === d.docType)?.label ?? d.docType}</b><span>{d.fileName || "Document"}</span><small>Uploaded {fmtDate(d.createdAt)}</small></li>)}</ul>}
  </Card>;
}

export function ProfilePage() {
  const { user, setUser, changePassword } = useSession();
  const [f, setF] = useState(() => ({
    contactName: user?.contactName ?? "", orgName: user?.orgName ?? "", orgType: user?.orgType ?? "", phone: user?.phone ?? "",
    address: user?.address ?? "", area: user?.area ?? "", city: user?.city ?? "", pincode: user?.pincode ?? "", serviceArea: user?.serviceArea ?? "",
    capacity: user?.capacity != null ? String(user.capacity) : "", registrationNo: user?.registrationNo ?? "", about: user?.about ?? "",
    careRequirements: user?.careRequirements ?? "",
  }));
  const [species, setSpecies] = useState<string[]>(user?.species ?? []);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [pwBusy, setPwBusy] = useState(false);
  if (!user) return null;
  const types = user.role === "donor" ? DONOR_TYPES : user.role === "ngo" ? NGO_TYPES : ANIMAL_ORG_TYPES;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value }));
  const isAnimal = user.role === "animal";

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (isAnimal && species.length === 0) throw new Error("Select at least one species your organization cares for.");
      const r = await api.put<{ user: typeof user }>("/profile", { ...f, capacity: f.capacity === "" ? null : Number(f.capacity), species: isAnimal ? species : [], latitude: user.latitude, longitude: user.longitude });
      setUser(r.user); toast.success("Profile saved.");
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.newPassword.length < 8) { toast.error("New password must be at least 8 characters."); return; }
    setPwBusy(true);
    try { await changePassword(pw.currentPassword, pw.newPassword); setPw({ currentPassword: "", newPassword: "" }); toast.success("Password updated."); }
    catch (e2) { toast.error(errMsg(e2)); } finally { setPwBusy(false); }
  };
  const title = user.role === "donor" ? "Organization Settings" : user.role === "ngo" ? "Organization Profile" : "Animal Care Profile";

  return <>
    <PageHeading eyebrow={ROLE_LABEL[user.role].toUpperCase()} title={title} subtitle={`Signed in as ${user.email}`}/>
    <div className="eb-two-col">
      <Card className="eb-section"><h2>{user.role === "donor" ? "Business details" : "Organization details"}</h2>
        <form className="eb-form-grid" onSubmit={e => void save(e)}>
          <div className="eb-span-2"><ErrorNote message={err}/></div>
          <Field label="Authorized contact person" required><input value={f.contactName} onChange={set("contactName")} maxLength={120} required/></Field>
          <Field label="Organization name" required><input value={f.orgName} onChange={set("orgName")} maxLength={160} required/></Field>
          <Field label="Type"><select value={f.orgType} onChange={set("orgType")}><option value="">Select type</option>{types.map(t => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Phone" required><input type="tel" value={f.phone} onChange={set("phone")} maxLength={40} required/></Field>
          <div className="eb-span-2"><Field label="Street address" required><input value={f.address} onChange={set("address")} maxLength={300} required/></Field></div>
          <Field label="Area"><input value={f.area} onChange={set("area")} maxLength={100}/></Field>
          <Field label="City" required><input value={f.city} onChange={set("city")} maxLength={100} required/></Field>
          <Field label="PIN code"><input value={f.pincode} onChange={set("pincode")} maxLength={12}/></Field>
          <Field label={user.role === "donor" ? "Usual pickup location / branches" : "Service area"}><input value={f.serviceArea} onChange={set("serviceArea")} maxLength={300}/></Field>
          {user.role !== "donor" && <Field label={user.role === "ngo" ? "People you can serve per day" : "Animals in your care"}><input type="number" min="0" value={f.capacity} onChange={set("capacity")}/></Field>}
          <Field label={user.role === "donor" ? "FSSAI / trade licence number" : "Registration number"} hint="Changing this after verification requires re-verification."><input value={f.registrationNo} onChange={set("registrationNo")} maxLength={80}/></Field>
          {isAnimal && <div className="form-field eb-span-2"><span>Species you care for *</span><ChipSelect options={ANIMAL_SPECIES} value={species} onChange={setSpecies}/></div>}
          {isAnimal && <div className="eb-span-2"><Field label="Care requirements" hint="Used to match suitable feed. e.g. special diets, foods your animals must not have."><textarea rows={3} value={f.careRequirements} onChange={set("careRequirements")} maxLength={1500}/></Field></div>}
          <div className="eb-span-2"><Field label="About" hint="Shown to partners when you request or offer food."><textarea rows={3} value={f.about} onChange={set("about")} maxLength={600}/></Field></div>
          <button className="button eb-span-2" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </form>
      </Card>
      <div className="eb-stack">
        <VerificationCard/>
        <Card className="eb-section"><h2>Change password</h2>
          <form className="eb-stack" onSubmit={e => void changePw(e)}>
            <Field label="Current password"><PasswordInput autoComplete="current-password" value={pw.currentPassword} onChange={e => setPw(p => ({ ...p, currentPassword: e.target.value }))} required/></Field>
            <Field label="New password" hint="At least 8 characters."><PasswordInput autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} required/></Field>
            <button className="button button-outline" type="submit" disabled={pwBusy}>{pwBusy ? "Updating…" : "Update password"}</button>
          </form>
        </Card>
      </div>
    </div>
    {isAnimal && <><PageHeading eyebrow="FEED NEEDS" title="Feed needs" subtitle="Requests for the kinds of food your animals need, visible to donors."/><AnimalNeedsSection/></>}
  </>;
}
