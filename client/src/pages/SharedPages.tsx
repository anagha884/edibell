import { useRef, useState, type FormEvent } from "react";
import { tr, trServer, trx } from "@/i18n";
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
const kg = (n: number) => tr("{n} kg", { n: Math.round(n * 10) / 10 });

export function ImpactPage() {
  const { user } = useSession();
  const { data, error, loading, reload } = useFetch<ImpactDTO>("/impact");
  if (!user) return null;
  const role = user.role;
  return <>
    <PageHeading eyebrow={tr("OUR IMPACT")} title={role === "donor" ? tr("Our Impact") : role === "ngo" ? tr("Our community impact") : tr("Our animal-care impact")}
      subtitle={tr("Only handovers verified by a Pickup Pass scan are counted. Listed, requested or accepted food is not.")}/>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : data && <>
      <div className="stat-grid ngo-stat-grid">
        <StatCard label={role === "donor" ? tr("Food successfully donated") : tr("Food collected")} value={kg(data.completedFoodKg)} note={data.completedPickups === 1 ? tr("1 completed pickup") : tr("{n} completed pickups", { n: data.completedPickups })} icon={Leaf}/>
        {role === "donor" && <StatCard label={tr("Completed listings")} value={String(data.completedDonations)} note={tr("of {n} listed ({qty} offered)", { n: data.totalDonations, qty: kg(data.totalFoodKg) })} icon={CheckCheck}/>}
        {role === "donor" && <StatCard label={tr("To people / to animals")} value={tr("{a} / {b} kg", { a: Math.round(data.humanFoodKg), b: Math.round(data.animalFeedKg) })} note={tr("Human food vs animal feed, kept separate")} icon={Scale} tone="mint"/>}
        {role !== "animal" && <StatCard label={tr("Meals supported")} value={String(data.mealsSupported)} note={tr("Estimate · human food only")} icon={Soup} tone="mint"/>}
        {role === "animal" && <StatCard label={tr("Animal feed received")} value={kg(data.animalFeedKg)} note={tr("Kg-equivalent, verified")} icon={Soup} tone="mint"/>}
        <StatCard label={tr("CO₂e avoided")} value={tr("{n} kg", { n: Math.round(data.co2eAvoidedKg) })} note={tr("Rough estimate, see method")} icon={Wind} tone="sage"/>
      </div>
      {data.completedPickups === 0 && <Empty title={tr("No verified pickups yet")} icon={<Leaf size={26}/>}>{tr("Your impact starts counting after the first handover is verified by a QR scan.")}</Empty>}
      <div className="eb-two-col">
        <Card className="eb-section"><h2>{tr("Over time (by month)")}</h2>{data.byMonth.length > 1 ? <BarList rows={data.byMonth.map(m => ({ label: m.month, value: m.kg }))}/> : <p className="eb-muted">{data.byMonth.length === 1 ? tr("{qty} in {month}. Trends appear once there are at least two months of verified pickups.", { qty: kg(data.byMonth[0].kg), month: data.byMonth[0].month }) : tr("Trends appear once verified pickups exist.")}</p>}</Card>
        <Card className="eb-section"><h2>{tr("By food category")}</h2><BarList rows={data.byCategory.map(m => ({ label: tr(m.category), value: m.kg }))}/></Card>
        <Card className="eb-section"><h2>{role === "donor" ? tr("By recipient organization") : tr("By donor")}</h2><BarList rows={data.byPartner.map(m => ({ label: `${m.name} (${m.pickups})`, value: m.kg }))}/></Card>
        {(role === "animal" || data.bySpecies.length > 0) && <Card className="eb-section"><h2>{tr("Animal feed by species")}</h2><BarList rows={data.bySpecies.map(m => ({ label: tr(m.species), value: m.kg }))}/></Card>}
        <Card className="eb-section"><h2>{tr("How we calculate")}</h2>
          <ul className="eb-assumptions">{data.assumptions.map(a => <li key={a}>{trServer(a)}</li>)}</ul>
          <p className="eb-hint">{trx("Wider context on food waste: <link>why food rescue matters</link>.", { link: c => <Link href="/why-food-rescue">{c}</Link> })}</p></Card>
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
    <PageHeading eyebrow={tr("NOTIFICATIONS")} title={tr("Notifications")} subtitle={unread ? tr("{n} unread", { n: unread }) : tr("You're all caught up.")}
      action={unread > 0 ? <button className="button button-outline" onClick={() => void markAll()}><CheckCheck size={14}/>  {tr("Mark all read")}</button> : undefined}/>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : !data || data.length === 0
      ? <Empty title={tr("No notifications yet")} icon={<Bell size={26}/>}>{tr("Request updates, new food, pickup reminders and confirmations will show up here.")}</Empty>
      : <Card className="eb-notes">{data.map(n => <div key={n.id} className={`eb-note ${n.read ? "" : "unread"}`}>
        <span className="eb-note-dot" aria-hidden="true"/>
        <div><b>{trServer(n.title)}</b>{!n.read && <span className="eb-sr">  {tr("(unread)")}</span>}<p>{trServer(n.body)}</p><small>{fmtDateTime(n.createdAt)}</small></div>
        <div className="eb-note-actions">{n.link && <Link href={n.link} className="text-button" onClick={() => { if (!n.read) void markOne(n.id); }}>{tr("Open")}</Link>}
          {!n.read && <button className="text-button" onClick={() => void markOne(n.id)}>{tr("Mark read")}</button>}</div></div>)}</Card>}
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
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error(tr("Upload a PDF, JPEG, PNG or WebP file.")); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error(tr("Documents must be 10 MB or smaller.")); return; }
    setBusy(true);
    try {
      const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1].replace("jpeg", "jpg");
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(ORG_DOCUMENT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw new Error(tr("Upload failed: {reason}", { reason: error.message }));
      await api.post("/documents", { path, docType, fileName: file.name.slice(0, 200) });
      toast.success(tr("Document uploaded for verification."));
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const tone = user.verificationStatus === "verified" ? "green" : user.verificationStatus === "rejected" ? "red" : "amber";
  return <Card className="eb-section"><h2><ShieldCheck size={15}/>  {tr("Verification")}</h2>
    <p><Status tone={tone}>{tr(VERIFICATION_LABEL[user.verificationStatus])}</Status></p>
    {user.verificationNote && <p className="eb-muted">{tr("Note from EDIBELL: {note}", { note: user.verificationNote })}</p>}
    <p className="eb-muted">{user.verificationStatus === "verified" ? tr("Partners see that EDIBELL has verified your organization. Changing your organization name or registration number requires verification again.")
      : tr("EDIBELL reviews your registration details and documents before marking your organization verified. Until then, partners see “Not yet verified”.")}</p>
    <div className="eb-doc-upload">
      <select value={docType} onChange={e => setDocType(e.target.value)} aria-label={tr("Document type")}>{ORG_DOCUMENT_TYPES.map(d => <option key={d.value} value={d.value}>{tr(d.label)}</option>)}</select>
      <label className={`button button-outline button-small ${busy ? "disabled" : ""}`}><FileUp size={13}/> {busy ? tr("Uploading…") : tr("Upload document")}
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={e => void upload(e.target.files?.[0])}/></label>
    </div>
    <small className="eb-hint">{tr("PDF or image, up to 10 MB. Documents are private: only your organization and EDIBELL administrators can open them.")}</small>
    {docs && docs.length > 0 && <ul className="eb-mini-list">{docs.map(d => <li key={d.id}><b>{tr(ORG_DOCUMENT_TYPES.find(t => t.value === d.docType)?.label ?? d.docType)}</b><span>{d.fileName || tr("Document")}</span><small>{tr("Uploaded {when}", { when: fmtDate(d.createdAt) })}</small></li>)}</ul>}
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
      if (isAnimal && species.length === 0) throw new Error(tr("Select at least one species your organization cares for."));
      const r = await api.put<{ user: typeof user }>("/profile", { ...f, capacity: f.capacity === "" ? null : Number(f.capacity), species: isAnimal ? species : [], latitude: user.latitude, longitude: user.longitude });
      setUser(r.user); toast.success(tr("Profile saved."));
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.newPassword.length < 8) { toast.error(tr("New password must be at least 8 characters.")); return; }
    setPwBusy(true);
    try { await changePassword(pw.currentPassword, pw.newPassword); setPw({ currentPassword: "", newPassword: "" }); toast.success(tr("Password updated.")); }
    catch (e2) { toast.error(errMsg(e2)); } finally { setPwBusy(false); }
  };
  const title = tr(user.role === "donor" ? "Organization Settings" : user.role === "ngo" ? "Organization Profile" : "Animal Care Profile");

  return <>
    <PageHeading eyebrow={tr(ROLE_LABEL[user.role]).toUpperCase()} title={title} subtitle={tr("Signed in as {email}", { email: user.email })}/>
    <div className="eb-two-col">
      <Card className="eb-section"><h2>{user.role === "donor" ? tr("Business details") : tr("Organization details")}</h2>
        <form className="eb-form-grid" onSubmit={e => void save(e)}>
          <div className="eb-span-2"><ErrorNote message={err}/></div>
          <Field label={tr("Authorized contact person")} required><input value={f.contactName} onChange={set("contactName")} maxLength={120} required/></Field>
          <Field label={tr("Organization name")} required><input value={f.orgName} onChange={set("orgName")} maxLength={160} required/></Field>
          <Field label={tr("Type")}><select value={f.orgType} onChange={set("orgType")}><option value="">{tr("Select type")}</option>{types.map(t => <option key={t} value={t}>{tr(t)}</option>)}</select></Field>
          <Field label={tr("Phone")} required><input type="tel" value={f.phone} onChange={set("phone")} maxLength={40} required/></Field>
          <div className="eb-span-2"><Field label={tr("Street address")} required><input value={f.address} onChange={set("address")} maxLength={300} required/></Field></div>
          <Field label={tr("Area")}><input value={f.area} onChange={set("area")} maxLength={100}/></Field>
          <Field label={tr("City")} required><input value={f.city} onChange={set("city")} maxLength={100} required/></Field>
          <Field label={tr("PIN code")}><input value={f.pincode} onChange={set("pincode")} maxLength={12}/></Field>
          <Field label={user.role === "donor" ? tr("Usual pickup location / branches") : tr("Service area")}><input value={f.serviceArea} onChange={set("serviceArea")} maxLength={300}/></Field>
          {user.role !== "donor" && <Field label={user.role === "ngo" ? tr("People you can serve per day") : tr("Animals in your care")}><input type="number" min="0" value={f.capacity} onChange={set("capacity")}/></Field>}
          <Field label={user.role === "donor" ? tr("FSSAI / trade licence number") : tr("Registration number")} hint={tr("Changing this after verification requires re-verification.")}><input value={f.registrationNo} onChange={set("registrationNo")} maxLength={80}/></Field>
          {isAnimal && <div className="form-field eb-span-2"><span>{tr("Species you care for *")}</span><ChipSelect options={ANIMAL_SPECIES} value={species} onChange={setSpecies}/></div>}
          {isAnimal && <div className="eb-span-2"><Field label={tr("Care requirements")} hint={tr("Used to match suitable feed. e.g. special diets, foods your animals must not have.")}><textarea rows={3} value={f.careRequirements} onChange={set("careRequirements")} maxLength={1500}/></Field></div>}
          <div className="eb-span-2"><Field label={tr("About")} hint={tr("Shown to partners when you request or offer food.")}><textarea rows={3} value={f.about} onChange={set("about")} maxLength={600}/></Field></div>
          <button className="button eb-span-2" type="submit" disabled={busy}>{busy ? tr("Saving…") : tr("Save changes")}</button>
        </form>
      </Card>
      <div className="eb-stack">
        <VerificationCard/>
        <Card className="eb-section"><h2>{tr("Change password")}</h2>
          <form className="eb-stack" onSubmit={e => void changePw(e)}>
            <Field label={tr("Current password")}><PasswordInput autoComplete="current-password" value={pw.currentPassword} onChange={e => setPw(p => ({ ...p, currentPassword: e.target.value }))} required/></Field>
            <Field label={tr("New password")} hint={tr("At least 8 characters.")}><PasswordInput autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} required/></Field>
            <button className="button button-outline" type="submit" disabled={pwBusy}>{pwBusy ? tr("Updating…") : tr("Update password")}</button>
          </form>
        </Card>
      </div>
    </div>
    {isAnimal && <><PageHeading eyebrow={tr("FEED NEEDS")} title={tr("Feed needs")} subtitle={tr("Requests for the kinds of food your animals need, visible to donors.")}/><AnimalNeedsSection/></>}
  </>;
}
