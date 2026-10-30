import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Beef, Bell, CheckCircle2, Clock, Crosshair, FilePlus2, HeartHandshake, KeyRound, MapPin,
  Package, PawPrint, Pencil, Phone, ScanLine, Scale, ShieldAlert, Users, Utensils, XCircle,
} from "lucide-react";
import {
  ALLERGENS, ANIMAL_CATEGORIES, ANIMAL_ONION_CHECK, ANIMAL_SAFETY_CHECKS, ANIMAL_SPECIES, DIET_TYPES, FOOD_ORIGINS, FOOD_ORIGIN_LABEL,
  FOOD_STATES, FOOD_STATE_LABEL, HUMAN_CATEGORIES, HUMAN_SAFETY_CHECKS, PACKAGING, STORAGE_OPTIONS, UNITS,
  type AnimalNeedDTO, type Destination, type DonationDTO, type ImpactDTO, type NotificationDTO, type RequestDTO, type ScanResult,
} from "@shared/edibell";
import { useSession } from "@/auth/session";
import { api, errMsg, useFetch } from "@/lib/api";
import { photoUrl } from "@/lib/supabase";
import { Card, PageHeading, PrimaryLink, StatCard, Status } from "../components/BrandUI";
import { QrScanner } from "../components/QrTools";
import { LocationPreview, PickupLocationPicker } from "../components/Map";
import {
  ChipSelect, Empty, ErrorNote, Field, FoodThumb, Loading, Modal, PhotoPicker, RequestStatusPill, fmtDateTime, fmtQty, fmtWindow,
  fromLocalInput, plusHours, toLocalInput,
} from "../components/kit";

// ---------------------------------------------------------------------------
// shared request card (donor side)
// ---------------------------------------------------------------------------
function RequesterBlock({ r }: { r: RequestDTO }) {
  const o = r.requester;
  const isAnimal = o.role === "animal";
  return <div className="eb-requester">
    <div className="eb-requester-head"><span className="avatar">{o.name.slice(0, 1).toUpperCase()}</span>
      <div><b>{o.name}</b><small>{isAnimal ? "Animal Welfare Organization" : "NGO Partner"}{o.type ? ` · ${o.type}` : ""} · {o.verificationStatus === "verified" ? "Verified by EDIBELL" : "Not yet verified"}</small></div></div>
    <dl className="eb-facts">
      <div><dt>Capacity</dt><dd>{o.capacity != null ? `${o.capacity} ${isAnimal ? "animals in care" : "people / day"}` : "Not provided"}</dd></div>
      <div><dt>Location</dt><dd>{[o.area, o.city].filter(Boolean).join(", ") || "—"}</dd></div>
      {r.beneficiaries != null && <div><dt>Will serve</dt><dd>{r.beneficiaries} people</dd></div>}
      {isAnimal && r.animalSpecies.length > 0 && <div><dt>Feeding</dt><dd>{r.animalSpecies.join(", ")}{r.animalCount != null ? ` (${r.animalCount} animals)` : ""}</dd></div>}
      {r.collectionNote && <div><dt>Collection</dt><dd>{r.collectionNote}</dd></div>}
      {o.phone && <div><dt>Contact</dt><dd><Phone size={11}/> {o.contactName} · {o.phone}</dd></div>}
    </dl>
    {o.about && <p className="eb-muted eb-clamp">{o.about}</p>}
    {r.message && <blockquote className="eb-quote">“{r.message}”</blockquote>}
  </div>;
}

function RequestRow({ r, onDone }: { r: RequestDTO; onDone: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "accept" | "decline") => {
    if (decision === "accept" && !window.confirm(`Accept ${fmtQty(r.quantity, r.unit)} of "${r.donation.title}" for ${r.requester.name}? This reserves the food and gives them a Pickup Pass.`)) return;
    setBusy(true);
    try {
      await api.post(`/donor/requests/${r.id}/decision`, { decision, reason });
      toast.success(decision === "accept" ? "Request accepted. The organization now has a Pickup Pass." : "Request declined.");
      onDone();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };
  return <Card className="eb-request">
    <div className="eb-request-food">
      <FoodThumb src={r.donation.photos[0]} alt={r.donation.title}/>
      <div><b>{r.donation.title}</b><small>{r.donation.category} · {r.donation.destination === "animal" ? "Animal feed" : "Human food"}</small>
        <div className="eb-request-qty"><span>Requested</span><strong>{fmtQty(r.quantity, r.unit)}</strong><span>of {fmtQty(r.donation.quantity, r.unit)}</span></div>
        <small><Clock size={11}/> Pickup {fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small>
        <small className="eb-muted">Requested {fmtDateTime(r.createdAt)}</small></div>
      <RequestStatusPill status={r.status}/>
    </div>
    <RequesterBlock r={r}/>
    {r.status === "pending" && !declining && <div className="eb-actions">
      <button className="button" disabled={busy} onClick={() => void decide("accept")}><CheckCircle2 size={15}/> Accept request</button>
      <button className="button button-outline" disabled={busy} onClick={() => setDeclining(true)}><XCircle size={15}/> Decline</button>
    </div>}
    {r.status === "pending" && declining && <div className="eb-decline">
      <Field label="Reason (shared with the organization)"><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Already promised to another partner" maxLength={300}/></Field>
      <div className="eb-actions"><button className="button" disabled={busy} onClick={() => void decide("decline")}>Confirm decline</button><button className="button button-outline" onClick={() => setDeclining(false)}>Back</button></div>
    </div>}
    {r.status === "accepted" && <div className="eb-note-ok"><ScanLine size={14}/> Accepted. When they arrive, open <Link href="/donor/scanner">Verify Pickup</Link> and scan the QR on their Pickup Pass to complete the handover.</div>}
    {r.status === "completed" && <div className="eb-note-ok"><CheckCircle2 size={14}/> Handed over and verified on {fmtDateTime(r.completedAt)}.</div>}
    {r.status === "declined" && r.declineReason && <p className="eb-muted">Reason given: {r.declineReason}</p>}
  </Card>;
}

// ---------------------------------------------------------------------------
// Incoming requests
// ---------------------------------------------------------------------------
export function DonorRequestsPage() {
  const { data, error, loading, reload } = useFetch<RequestDTO[]>("/donor/requests?status=all", { pollMs: 60000 });
  const [tab, setTab] = useState<"pending" | "accepted" | "history">("pending");
  const groups = useMemo(() => ({
    pending: data?.filter(r => r.status === "pending") ?? [],
    accepted: data?.filter(r => r.status === "accepted") ?? [],
    history: data?.filter(r => !["pending", "accepted"].includes(r.status)) ?? [],
  }), [data]);
  const list = groups[tab];
  const label = { pending: "Pending", accepted: "Awaiting pickup", history: "History" };
  return <>
    <PageHeading eyebrow="REQUESTS" title="Incoming Requests" subtitle="NGOs and animal welfare organizations asking to collect your food. Nothing is accepted automatically."/>
    <div className="eb-tabs" role="tablist">{(["pending", "accepted", "history"] as const).map(t =>
      <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label[t]} <em>{groups[t].length}</em></button>)}</div>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : list.length === 0
      ? <Empty title={tab === "pending" ? "No pending requests" : tab === "accepted" ? "Nothing waiting for pickup" : "No past requests yet"} icon={<Users size={26}/>}>
        {tab === "pending" ? "When an organization requests one of your listings, it appears here and you'll get a notification." : "Requests will show up here as they progress."}</Empty>
      : <div className="eb-stack">{list.map(r => <RequestRow key={r.id} r={r} onDone={reload}/>)}</div>}
  </>;
}

// ---------------------------------------------------------------------------
// My food listings
// ---------------------------------------------------------------------------
type ListingTag = "available" | "partial" | "requested" | "awaiting" | "review" | "completed" | "expired" | "cancelled" | "rejected" | "full";
const TAG_LABEL: Record<ListingTag, string> = {
  available: "Available", partial: "Partially reserved", requested: "Requested", awaiting: "Accepted · awaiting pickup",
  review: "Awaiting safety review", completed: "Completed", expired: "Expired", cancelled: "Cancelled", rejected: "Not approved", full: "Fully reserved",
};
const TAG_TONE: Record<ListingTag, "green" | "amber" | "red" | "blue" | "gray"> = {
  available: "green", partial: "blue", requested: "amber", awaiting: "blue", review: "amber", completed: "green", expired: "gray", cancelled: "gray", rejected: "red", full: "blue",
};
function tagsOf(d: DonationDTO): ListingTag[] {
  if (d.status === "cancelled") return ["cancelled"];
  if (d.status === "completed") return ["completed"];
  if (d.status === "expired" || d.availability === "expired") return ["expired"];
  if (d.availability === "under-review") return ["review"];
  if (d.availability === "rejected") return ["rejected"];
  const t: ListingTag[] = [];
  if (d.availability === "available") t.push("available");
  if (d.availability === "fully-reserved") t.push("full");
  if (d.reserved > 0 && d.remaining > 0) t.push("partial");
  if (d.pendingRequests) t.push("requested");
  if (d.acceptedRequests) t.push("awaiting");
  return t;
}
const FILTERS: (ListingTag | "all")[] = ["all", "available", "partial", "requested", "awaiting", "review", "completed", "expired", "cancelled"];

export function DonorDonationsPage() {
  const { data, error, loading, reload } = useFetch<DonationDTO[]>("/donations/mine", { pollMs: 60000 });
  const [filter, setFilter] = useState<ListingTag | "all">("all");
  const [cancelling, setCancelling] = useState<DonationDTO | null>(null);
  const rows = (data ?? []).filter(d => filter === "all" || tagsOf(d).includes(filter));
  const count = (t: ListingTag | "all") => t === "all" ? data?.length ?? 0 : (data ?? []).filter(d => tagsOf(d).includes(t)).length;
  return <>
    <PageHeading eyebrow="MY FOOD LISTINGS" title="My Food Listings" subtitle="Everything you've shared, with live status and quantities."
      action={<PrimaryLink href="/donor/create"><FilePlus2 size={15}/> Share surplus food</PrimaryLink>}/>
    <div className="eb-tabs scroll">{FILTERS.map(t =>
      <button key={t} className={filter === t ? "on" : ""} onClick={() => setFilter(t)}>{t === "all" ? "All" : TAG_LABEL[t]} <em>{count(t)}</em></button>)}</div>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : rows.length === 0
      ? <Empty title={data?.length ? "No listings with this status" : "No listings yet"} icon={<Utensils size={26}/>}>{data?.length ? "Choose another filter." : <>Use <Link href="/donor/create">Share Surplus Food</Link> to publish your first listing.</>}</Empty>
      : <div className="eb-stack">{rows.map(d => {
        const pct = Math.min(100, Math.round((d.collected / d.quantity) * 100));
        const resPct = Math.min(100 - pct, Math.round((d.reserved / d.quantity) * 100));
        const editable = d.status === "active" && d.reserved === 0 && d.collected === 0 && !d.acceptedRequests && d.availability !== "expired";
        return <Card key={d.id} className="eb-donation-row">
          <FoodThumb src={d.photos[0]} alt={d.title}/>
          <div className="eb-donation-main">
            <div className="eb-row-top"><b>{d.title}</b>
              {tagsOf(d).map(t => <Status key={t} tone={TAG_TONE[t]}>{TAG_LABEL[t]}</Status>)}
              <span className={`eb-dest ${d.destination}`}>{d.destination === "animal" ? <><PawPrint size={11}/> Animal feed</> : <><Utensils size={11}/> Human food</>}</span></div>
            <small>{d.category} · {d.area}, {d.city} · listed {fmtDateTime(d.createdAt)}</small>
            <small><Clock size={11}/> Pickup {fmtWindow(d.pickupStart, d.pickupEnd)} · safe until {fmtDateTime(d.expiryAt)}</small>
            {d.destination === "animal" && <small><PawPrint size={11}/> Suitable for {d.animalSpecies.join(", ")}</small>}
            <div className="eb-progress" aria-label="Collected and reserved"><i style={{ width: `${pct}%` }}/><i className="res" style={{ width: `${resPct}%` }}/></div>
            <small><b>{fmtQty(d.quantity, d.unit)}</b> listed · {fmtQty(d.reserved, d.unit)} reserved · {fmtQty(d.collected, d.unit)} collected · <b>{fmtQty(d.remaining, d.unit)}</b> remaining{d.pendingRequests ? ` · ${d.pendingRequests} pending request${d.pendingRequests > 1 ? "s" : ""}` : ""}</small>
            {d.reviewNote && <small className="eb-muted">Review note: {d.reviewNote}</small>}
            {d.status === "cancelled" && d.cancelReason && <small className="eb-muted">Cancelled: {d.cancelReason}</small>}
          </div>
          <div className="eb-actions col">
            {!!d.pendingRequests && <Link href="/donor/requests" className="button button-small">Review requests</Link>}
            {!!d.acceptedRequests && <Link href="/donor/scanner" className="button button-small"><ScanLine size={13}/> Verify pickup</Link>}
            {editable && <Link href={`/donor/listings/${d.id}/edit`} className="button button-outline button-small"><Pencil size={13}/> Edit</Link>}
            {d.status === "active" && <button className="button button-outline button-small" onClick={() => setCancelling(d)}>Cancel listing</button>}
          </div>
        </Card>;
      })}</div>}
    {cancelling && <CancelListingModal d={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); reload(); }}/>}
  </>;
}

function CancelListingModal({ d, onClose, onDone }: { d: DonationDTO; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api.post(`/donations/${d.id}/cancel`, { reason }); toast.success("Listing cancelled. Affected organizations were notified."); onDone(); }
    catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  return <Modal title={`Cancel "${d.title}"?`} onClose={onClose}>
    <form className="eb-stack" onSubmit={e => void submit(e)}>
      {(d.acceptedRequests ?? 0) > 0 && <div className="eb-warn"><AlertTriangle size={15}/><span>{d.acceptedRequests} accepted pickup{d.acceptedRequests! > 1 ? "s are" : " is"} waiting. Cancelling releases the food, invalidates their Pickup Pass QR codes and notifies them immediately.</span></div>}
      {(d.pendingRequests ?? 0) > 0 && <p className="eb-muted">{d.pendingRequests} pending request{d.pendingRequests! > 1 ? "s" : ""} will be cancelled too.</p>}
      <ErrorNote message={err}/>
      <Field label="Reason (shared with affected organizations)"><textarea rows={2} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Food was consumed on site"/></Field>
      <div className="eb-actions"><button className="button" type="submit" disabled={busy}>{busy ? "Cancelling…" : "Cancel listing"}</button><button type="button" className="button button-outline" onClick={onClose}>Keep listing</button></div>
    </form>
  </Modal>;
}

// ---------------------------------------------------------------------------
// Share surplus food (create / edit, with a review step before publishing)
// ---------------------------------------------------------------------------
type FormState = {
  title: string; category: string; description: string; quantity: string; unit: string; ingredients: string; allergenNotes: string;
  dietType: string; foodOrigin: string; foodState: string; packaging: string; storage: string; handlingNotes: string; restrictions: string;
  preparedAt: string; expiryAt: string; readyAt: string; pickupStart: string; pickupEnd: string;
  address: string; area: string; city: string; pincode: string; pickupContactName: string; pickupContactPhone: string;
};

function initialForm(user: ReturnType<typeof useSession>["user"], d?: DonationDTO): FormState {
  if (d) return {
    title: d.title, category: d.category, description: d.description, quantity: String(d.quantity), unit: d.unit, ingredients: d.ingredients,
    allergenNotes: d.allergenNotes, dietType: d.dietType ?? "vegetarian", foodOrigin: d.foodOrigin, foodState: d.foodState, packaging: d.packaging,
    storage: d.storage, handlingNotes: d.handlingNotes, restrictions: d.restrictions, preparedAt: toLocalInput(d.preparedAt), expiryAt: toLocalInput(d.expiryAt),
    readyAt: toLocalInput(d.readyAt), pickupStart: toLocalInput(d.pickupStart), pickupEnd: toLocalInput(d.pickupEnd), address: d.address ?? "", area: d.area,
    city: d.city, pincode: d.pincode, pickupContactName: d.pickupContactName ?? "", pickupContactPhone: d.pickupContactPhone ?? "",
  };
  return {
    title: "", category: "", description: "", quantity: "", unit: "kg", ingredients: "", allergenNotes: "",
    dietType: "vegetarian", foodOrigin: "cooked-not-served", foodState: "hot", packaging: "", storage: "", handlingNotes: "", restrictions: "",
    preparedAt: toLocalInput(plusHours(-0.5)), expiryAt: toLocalInput(plusHours(6)), readyAt: toLocalInput(plusHours(0.5)),
    pickupStart: toLocalInput(plusHours(1)), pickupEnd: toLocalInput(plusHours(3)),
    address: [user?.address].filter(Boolean).join(""), area: user?.area ?? "", city: user?.city ?? "", pincode: user?.pincode ?? "",
    pickupContactName: user?.contactName ?? "", pickupContactPhone: user?.phone ?? "",
  };
}

/** Client-side checks mirror the database rules so donors get instant feedback; the database re-validates everything. */
function clientProblems(f: FormState, dest: Destination, species: string[], checks: Record<string, boolean>): string[] {
  const p: string[] = [];
  const t = (s: string) => (s ? new Date(s).getTime() : NaN);
  const now = Date.now();
  if (!f.title.trim()) p.push("Add the food name.");
  if (!f.category) p.push("Choose a food category.");
  if (!(Number(f.quantity) > 0)) p.push("Quantity must be more than zero.");
  if (!f.ingredients.trim()) p.push("List the ingredients.");
  if (!f.packaging) p.push("Choose the packaging.");
  if (!f.storage) p.push("Choose how the food is stored.");
  if (t(f.pickupEnd) <= t(f.pickupStart)) p.push("Pickup window end must be after its start.");
  if (t(f.pickupEnd) <= now) p.push("Pickup window must end in the future.");
  if (t(f.expiryAt) <= now) p.push("The safe-use deadline has already passed.");
  if (t(f.expiryAt) < t(f.pickupStart)) p.push("Food must stay safe at least until the pickup window starts.");
  if (t(f.preparedAt) > now + 5 * 60_000) p.push("Preparation time can't be in the future.");
  if (t(f.readyAt) > t(f.pickupEnd)) p.push("Ready time must be before the pickup window ends.");
  if (!f.address.trim() || !f.area.trim() || !f.city.trim()) p.push("Complete the pickup address, area and city.");
  if (!f.pickupContactName.trim() || !f.pickupContactPhone.trim()) p.push("Add the pickup contact name and phone.");
  if (dest === "human") {
    if (HUMAN_SAFETY_CHECKS.some(c => !checks[c.key])) p.push("Confirm every human-food safety item. If you can't, don't list this food for people.");
  } else {
    if (species.length === 0) p.push("Select the animal species this food is suitable for.");
    if (ANIMAL_SAFETY_CHECKS.some(c => !checks[c.key])) p.push("Complete the animal-feed screening. Unsafe or unknown-condition food must not be offered as feed.");
    if ((species.includes("Dogs") || species.includes("Cats")) && !checks[ANIMAL_ONION_CHECK.key]) p.push("Confirm the food has no onion or garlic, or remove dogs/cats.");
  }
  return p;
}

export function CreateDonationPage() { return <ListingFormPage/>; }

export function EditListingPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useFetch<DonationDTO>(`/donations/${id}`);
  if (loading && !data) return <Loading/>;
  if (error || !data) return <ErrorNote message={error || "Listing not found."}/>;
  return <ListingFormPage existing={data} key={data.id}/>;
}

function ListingFormPage({ existing }: { existing?: DonationDTO }) {
  const { user } = useSession();
  const [, setLocation] = useLocation();
  const [dest, setDest] = useState<Destination>(existing?.destination ?? "human");
  const [f, setF] = useState<FormState>(() => initialForm(user, existing));
  const [allergens, setAllergens] = useState<string[]>(existing?.allergens ?? []);
  const [species, setSpecies] = useState<string[]>(existing?.animalSpecies ?? []);
  const [photos, setPhotos] = useState<string[]>(existing?.photoPaths ?? []);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(existing?.latitude != null && existing.longitude != null ? { lat: existing.latitude, lng: existing.longitude } : null);
  const [placeId, setPlaceId] = useState(existing?.placeId ?? "");
  const [checks, setChecks] = useState<Record<string, boolean>>(existing?.safetyChecklist ?? {});
  const [stage, setStage] = useState<"form" | "review">("form");
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value }));
  const categories = dest === "human" ? HUMAN_CATEGORIES : ANIMAL_CATEGORIES;
  const isEdit = !!existing;
  if (!user) return null;

  const switchDest = (d: Destination) => {
    if (isEdit) return;
    setDest(d); setError(""); setChecks({});
    setF(p => ({ ...p, category: "", foodOrigin: d === "animal" ? "untouched-surplus" : "cooked-not-served", foodState: d === "animal" ? "not-applicable" : "hot" }));
  };
  const locate = () => {
    if (!navigator.geolocation) { toast.error("This browser can't share your location."); return; }
    navigator.geolocation.getCurrentPosition(
      p => { setCoords({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }); setPlaceId(""); toast.success("Device location saved as the pickup pin."); },
      () => toast.error("Couldn't get your location. Search the address on the map instead."),
      { enableHighAccuracy: true, timeout: 10000 });
  };
  const payload = () => ({
    destination: dest, title: f.title, category: f.category, description: f.description,
    quantity: f.quantity, unit: f.unit, photos, ingredients: f.ingredients,
    allergens: dest === "human" ? allergens : [], allergenNotes: f.allergenNotes,
    dietType: dest === "human" ? f.dietType : undefined, foodOrigin: f.foodOrigin, foodState: f.foodState,
    packaging: f.packaging, storage: f.storage, handlingNotes: f.handlingNotes, restrictions: dest === "animal" ? f.restrictions : "",
    preparedAt: fromLocalInput(f.preparedAt), expiryAt: fromLocalInput(f.expiryAt), readyAt: fromLocalInput(f.readyAt),
    pickupStart: fromLocalInput(f.pickupStart), pickupEnd: fromLocalInput(f.pickupEnd),
    address: f.address, area: f.area, city: f.city, pincode: f.pincode, placeId,
    latitude: coords?.lat, longitude: coords?.lng, pickupContactName: f.pickupContactName, pickupContactPhone: f.pickupContactPhone,
    animalSpecies: dest === "animal" ? species : [], safetyChecklist: checks,
  });
  const toReview = (e: FormEvent) => {
    e.preventDefault();
    const p = clientProblems(f, dest, species, checks);
    setProblems(p); setError("");
    if (p.length === 0) setStage("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const publish = async () => {
    setError(""); setBusy(true);
    try {
      if (isEdit) await api.put(`/donations/${existing!.id}`, payload());
      else await api.post("/donations", payload());
      toast.success(isEdit ? "Listing updated." : "Listing published.");
      setLocation("/donor/donations");
    } catch (err) { setError(errMsg(err)); setStage("form"); window.scrollTo({ top: 0, behavior: "smooth" }); }
    finally { setBusy(false); }
  };
  const checklist = dest === "human" ? HUMAN_SAFETY_CHECKS : [...ANIMAL_SAFETY_CHECKS, ...((species.includes("Dogs") || species.includes("Cats")) ? [ANIMAL_ONION_CHECK] : [])];

  if (stage === "review") return <ListingReview f={f} dest={dest} allergens={allergens} species={species} photos={photos} coords={coords} isEdit={isEdit}
    busy={busy} error={error} onBack={() => setStage("form")} onPublish={() => void publish()}/>;

  return <form onSubmit={toReview} className="eb-create" noValidate>
    <PageHeading eyebrow={isEdit ? "EDIT LISTING" : "SHARE SURPLUS FOOD"} title={isEdit ? `Edit “${existing!.title}”` : "Share Surplus Food"} subtitle="Add the food, safety and pickup details. You'll review everything before it's published."/>
    <ErrorNote message={error}/>
    {problems.length > 0 && <div className="eb-error" role="alert"><AlertTriangle size={15}/><span>Please fix: {problems.join(" ")}</span></div>}

    <Card className="eb-section"><h2>1 · Who can safely eat this food?</h2>
      <div className="eb-dest-choice">
        <button type="button" className={dest === "human" ? "on" : ""} onClick={() => switchDest("human")} aria-pressed={dest === "human"} disabled={isEdit && dest !== "human"}><Utensils size={22}/><b>People (human food)</b><small>Safe, fresh, never-served food for NGOs, shelters and community kitchens.</small></button>
        <button type="button" className={dest === "animal" ? "on" : ""} onClick={() => switchDest("animal")} aria-pressed={dest === "animal"} disabled={isEdit && dest !== "animal"}><PawPrint size={22}/><b>Animals (animal feed)</b><small>Food screened as suitable for specific animals. Food unsafe for people is not automatically safe for animals.</small></button>
      </div>
      {isEdit && <p className="eb-hint">A listing can't move between pathways. Cancel it and create a new one instead.</p>}
    </Card>

    <Card className="eb-section"><h2>2 · Food details</h2>
      <div className="eb-form-grid">
        <Field label="Food name" required><input value={f.title} onChange={set("title")} maxLength={120} placeholder={dest === "human" ? "e.g. Vegetable biryani" : "e.g. Fresh vegetable trimmings"} required/></Field>
        <Field label="Food category" required><select value={f.category} onChange={set("category")} required><option value="">Select category</option>{categories.map(c => <option key={c}>{c}</option>)}</select></Field>
        <div className="eb-pair"><Field label="Quantity" required><input type="number" step="any" min="0.01" value={f.quantity} onChange={set("quantity")} required/></Field>
          <Field label="Unit" required><select value={f.unit} onChange={set("unit")}>{UNITS.map(u => <option key={u}>{u}</option>)}</select></Field></div>
        <Field label="Hot, chilled or room temperature?" required><select value={f.foodState} onChange={set("foodState")}>{FOOD_STATES.map(s => <option key={s} value={s}>{FOOD_STATE_LABEL[s]}</option>)}</select></Field>
        <div className="eb-span-2"><Field label="Description"><textarea value={f.description} onChange={set("description")} rows={3} maxLength={1500} placeholder="What it is, how it was prepared, anything the collector should know."/></Field></div>
        <div className="form-field eb-span-2"><span>Food photographs</span><PhotoPicker value={photos} onChange={setPhotos} ownerId={user.id}/></div>
      </div>
    </Card>

    <Card className="eb-section"><h2>3 · Food safety &amp; handling</h2>
      <div className="eb-form-grid">
        {dest === "human" && <>
          <Field label="Diet type" required><select value={f.dietType} onChange={set("dietType")}>{DIET_TYPES.map(d => <option key={d} value={d}>{d.replace("-", " ")}</option>)}</select></Field>
          <Field label="Food origin" required><select value={f.foodOrigin} onChange={set("foodOrigin")}>{FOOD_ORIGINS.filter(o => o !== "plate-leftover").map(o => <option key={o} value={o}>{FOOD_ORIGIN_LABEL[o]}</option>)}</select></Field>
        </>}
        {dest === "animal" && <>
          <div className="form-field eb-span-2"><span>Suitable for which animals? *</span><ChipSelect options={ANIMAL_SPECIES} value={species} onChange={setSpecies}/></div>
          <Field label="Food origin" required hint="Plate leftovers and meat/fish scraps are reviewed by EDIBELL before they are shown."><select value={f.foodOrigin} onChange={set("foodOrigin")}>{FOOD_ORIGINS.map(o => <option key={o} value={o}>{FOOD_ORIGIN_LABEL[o]}</option>)}</select></Field>
        </>}
        <Field label="Preparation date & time" required><input type="datetime-local" value={f.preparedAt} onChange={set("preparedAt")} required/></Field>
        <Field label="Safe-use deadline" required hint="Food must be collected and used before this time."><input type="datetime-local" value={f.expiryAt} onChange={set("expiryAt")} required/></Field>
        <Field label="Packaging details" required><select value={f.packaging} onChange={set("packaging")} required><option value="">Select packaging</option>{PACKAGING.map(p => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Storage & handling requirements" required><select value={f.storage} onChange={set("storage")} required><option value="">Select how it's stored</option>{STORAGE_OPTIONS.map(p => <option key={p}>{p}</option>)}</select></Field>
        <div className="eb-span-2"><Field label="Ingredients" required><textarea value={f.ingredients} onChange={set("ingredients")} rows={2} maxLength={1000} placeholder="List the main ingredients" required/></Field></div>
        {dest === "human" && <div className="form-field eb-span-2"><span>Known allergens</span><ChipSelect options={ALLERGENS} value={allergens} onChange={setAllergens}/><input className="eb-gap" value={f.allergenNotes} onChange={set("allergenNotes")} maxLength={400} placeholder="Other allergens or 'may contain' notes"/></div>}
        {dest === "animal" && <div className="eb-span-2"><Field label="Restrictions & known hazards" hint="e.g. Not for puppies; feed within 2 hours; contains citrus peel"><textarea rows={2} value={f.restrictions} onChange={set("restrictions")} maxLength={600}/></Field></div>}
      </div>
      <fieldset className="eb-checklist"><legend>{dest === "human" ? "Human-food safety checklist *" : "Animal-feed screening *"}</legend>
        {checklist.map(c => <label key={c.key} className="check-label"><input type="checkbox" checked={!!checks[c.key]} onChange={e => setChecks(p => ({ ...p, [c.key]: e.target.checked }))}/> {c.label}</label>)}
      </fieldset>
      {dest === "animal" && <div className="eb-warn"><ShieldAlert size={15}/><span>Never offer spoiled, mouldy or contaminated food, or food of unknown condition, as animal feed. Onion and garlic are toxic to dogs and cats; chocolate, xylitol, grapes and alcohol are dangerous to many animals.</span></div>}
    </Card>

    <Card className="eb-section"><h2>4 · Pickup details</h2>
      <div className="eb-form-grid">
        <Field label="Ready for collection from" required><input type="datetime-local" value={f.readyAt} onChange={set("readyAt")} required/></Field>
        <div/>
        <Field label="Pickup window starts" required><input type="datetime-local" value={f.pickupStart} onChange={set("pickupStart")} required/></Field>
        <Field label="Pickup window ends" required><input type="datetime-local" value={f.pickupEnd} onChange={set("pickupEnd")} required/></Field>
        <div className="eb-span-2"><PickupLocationPicker initial={{ latitude: coords?.lat ?? null, longitude: coords?.lng ?? null }} onSelect={location => {
          setF(p => ({ ...p, address: location.address, area: location.area || p.area, city: location.city || p.city, pincode: location.pincode || p.pincode }));
          setCoords({ lat: location.latitude, lng: location.longitude }); setPlaceId(location.placeId);
        }}/></div>
        <div className="eb-span-2"><Field label="Full pickup address" required><input value={f.address} onChange={set("address")} maxLength={300} autoComplete="street-address" required/></Field></div>
        <Field label="Area / locality" required><input value={f.area} onChange={set("area")} maxLength={100} required/></Field>
        <Field label="City" required><input value={f.city} onChange={set("city")} maxLength={100} required/></Field>
        <Field label="PIN code"><input value={f.pincode} onChange={set("pincode")} inputMode="numeric" maxLength={12}/></Field>
        <div className="form-field"><span>Map pin</span>
          <button type="button" className="button button-outline" onClick={locate}><Crosshair size={14}/> {coords ? `Pin saved (${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)})` : "Use my current location"}</button>
          {coords && <button type="button" className="text-button" onClick={() => { setCoords(null); setPlaceId(""); }}>Remove pin</button>}</div>
        <Field label="Pickup contact name" required><input value={f.pickupContactName} onChange={set("pickupContactName")} maxLength={120} required/></Field>
        <Field label="Pickup contact phone" required><input type="tel" value={f.pickupContactPhone} onChange={set("pickupContactPhone")} maxLength={40} required/></Field>
        <div className="eb-span-2"><Field label="Additional instructions"><input value={f.handlingNotes} onChange={set("handlingNotes")} maxLength={600} placeholder="e.g. Use the service entrance; bring insulated containers"/></Field></div>
      </div>
      <p className="eb-hint">The exact address, pin and contact are shown to a recipient only after you accept their request.</p>
    </Card>

    <div className="eb-submitbar"><span className="eb-muted">{dest === "human" ? "Visible to NGO partners" : "Visible to animal welfare organizations caring for the selected species"} once published.</span>
      <button className="button" type="submit">Review listing <ArrowRight size={15}/></button></div>
  </form>;
}

function ListingReview({ f, dest, allergens, species, photos, coords, isEdit, busy, error, onBack, onPublish }: {
  f: FormState; dest: Destination; allergens: string[]; species: string[]; photos: string[]; coords: { lat: number; lng: number } | null;
  isEdit: boolean; busy: boolean; error: string; onBack: () => void; onPublish: () => void;
}) {
  const needsReview = dest === "animal" && (f.foodOrigin === "plate-leftover" || f.category === "Cooked meat / fish scraps (unseasoned)");
  return <div className="eb-create">
    <PageHeading eyebrow="REVIEW BEFORE PUBLISHING" title={f.title || "Your listing"} subtitle="Check every detail. Recipients rely on this information to keep people and animals safe."/>
    <ErrorNote message={error}/>
    {needsReview && <div className="eb-warn"><ShieldAlert size={15}/><span>This animal-feed listing will be held for an EDIBELL safety review before animal welfare organizations can see it.</span></div>}
    <div className="eb-two-col">
      <Card className="eb-section"><h2>Food</h2>
        {photos.length > 0 && <div className="eb-photos">{photos.map((p, i) => <div key={p} className="eb-photo"><img src={photoUrl(p)} alt={`Food photo ${i + 1}`}/></div>)}</div>}
        <dl className="eb-facts two">
          <div><dt>Pathway</dt><dd>{dest === "human" ? "Human food (NGO partners)" : `Animal feed for ${species.join(", ")}`}</dd></div>
          <div><dt>Category</dt><dd>{f.category}</dd></div>
          <div><dt>Quantity</dt><dd>{f.quantity} {f.unit}</dd></div>
          <div><dt>Hot / cold</dt><dd>{FOOD_STATE_LABEL[f.foodState as keyof typeof FOOD_STATE_LABEL]}</dd></div>
          <div><dt>Origin</dt><dd>{FOOD_ORIGIN_LABEL[f.foodOrigin as keyof typeof FOOD_ORIGIN_LABEL]}</dd></div>
          {dest === "human" && <div><dt>Diet</dt><dd>{f.dietType.replace("-", " ")}</dd></div>}
          <div><dt>Prepared</dt><dd>{fmtDateTime(fromLocalInput(f.preparedAt))}</dd></div>
          <div><dt>Safe until</dt><dd><b className="eb-warn-text">{fmtDateTime(fromLocalInput(f.expiryAt))}</b></dd></div>
          <div><dt>Packaging</dt><dd>{f.packaging}</dd></div>
          <div><dt>Storage</dt><dd>{f.storage}</dd></div>
          <div><dt>Ingredients</dt><dd>{f.ingredients}</dd></div>
          {dest === "human" && <div><dt>Allergens</dt><dd>{allergens.length ? allergens.join(", ") : "None declared"}{f.allergenNotes ? ` · ${f.allergenNotes}` : ""}</dd></div>}
          {dest === "animal" && f.restrictions && <div><dt>Restrictions</dt><dd>{f.restrictions}</dd></div>}
          {f.description && <div><dt>Description</dt><dd>{f.description}</dd></div>}
          <div><dt>Photos</dt><dd>{photos.length ? `${photos.length} photo${photos.length > 1 ? "s" : ""} attached` : "No photo (a neutral placeholder will be shown)"}</dd></div>
        </dl>
      </Card>
      <Card className="eb-section"><h2>Pickup</h2>
        <dl className="eb-facts">
          <div><dt>Ready from</dt><dd>{fmtDateTime(fromLocalInput(f.readyAt))}</dd></div>
          <div><dt>Pickup window</dt><dd>{fmtWindow(fromLocalInput(f.pickupStart), fromLocalInput(f.pickupEnd))}</dd></div>
          <div><dt>Contact</dt><dd>{f.pickupContactName} · {f.pickupContactPhone}</dd></div>
          {f.handlingNotes && <div><dt>Instructions</dt><dd>{f.handlingNotes}</dd></div>}
        </dl>
        <LocationPreview lat={coords?.lat ?? null} lng={coords?.lng ?? null} address={[f.address, f.area, f.city, f.pincode].filter(Boolean).join(", ")}/>
      </Card>
    </div>
    <div className="eb-submitbar"><button type="button" className="button button-outline" onClick={onBack}><ArrowLeft size={15}/> Back to edit</button>
      <button type="button" className="button" disabled={busy} onClick={onPublish}>{busy ? "Saving…" : isEdit ? "Save changes" : "Publish listing"} <CheckCircle2 size={15}/></button></div>
  </div>;
}

// ---------------------------------------------------------------------------
// Verify pickup (donor scans the recipient's QR)
// ---------------------------------------------------------------------------
export function DonorScannerPage() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const { data: reqs, reload } = useFetch<RequestDTO[]>("/donor/requests?status=all", { pollMs: 60000 });
  const waiting = reqs?.filter(r => r.status === "accepted") ?? [];
  const done = reqs?.filter(r => r.status === "completed").slice(0, 5) ?? [];

  const verify = async (code: string) => {
    if (busy || result) return;
    setBusy(true);
    try {
      const r = await api.post<ScanResult>("/donor/scan", { code });
      setResult(r);
      if (r.ok) toast.success("Pickup verified."); else toast.error(r.message);
      reload();
    } catch (e) { setResult({ ok: false, message: errMsg(e) }); }
    finally { setBusy(false); }
  };
  const next = () => { setResult(null); setManual(""); };

  return <>
    <PageHeading eyebrow="HANDOVER" title="Verify Pickup" subtitle="Scan the Pickup Pass QR on the collector's phone. A pickup is marked complete only after EDIBELL's server verifies the code."/>
    <div className="eb-two-col">
      <Card className="eb-section">
        <h2>Scan Pickup Pass</h2>
        <QrScanner busy={busy || !!result} onCode={t => void verify(t)}/>
        <div className="eb-or"><span>or type the pickup code</span></div>
        <form className="eb-manual" onSubmit={e => { e.preventDefault(); if (manual.trim()) void verify(manual); }}>
          <KeyRound size={15}/><input value={manual} onChange={e => setManual(e.target.value)} placeholder="ABCDE-FGHJK-MNPQR-STVWX" autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={!!result} aria-label="Pickup code"/>
          <button className="button" type="submit" disabled={busy || !!result || !manual.trim()}>{busy ? "Checking…" : "Verify"}</button>
        </form>
        <p className="eb-hint">The 20-character code under the QR goes through exactly the same server verification as a scan.</p>
      </Card>

      <div className="eb-stack">
        {busy && <Card className="eb-section"><Loading label="Verifying with the server…"/></Card>}
        {result && <Card className={`eb-result ${result.ok ? "ok" : "fail"}`} >
          {result.ok ? <CheckCircle2 size={34}/> : <XCircle size={34}/>}
          <h2>{result.ok ? "Pickup verified" : "Can't complete this pickup"}</h2>
          <p>{result.message}</p>
          {result.ok && result.request && <dl className="eb-facts">
            <div><dt>Food</dt><dd>{result.request.donation.title}</dd></div>
            <div><dt>Quantity</dt><dd>{fmtQty(result.request.quantity, result.request.unit)}</dd></div>
            <div><dt>Collected by</dt><dd>{result.request.requester.name}</dd></div>
            <div><dt>Verified</dt><dd>{fmtDateTime(result.request.completedAt)}</dd></div></dl>}
          {!result.ok && <p className="eb-hint">Nothing was marked complete. Ask the collector to refresh their Pickup Pass, or check the request in Incoming Requests.</p>}
          <button className="button" onClick={next}>{result.ok ? "Scan next" : "Try again"}</button>
        </Card>}
        <Card className="eb-section"><h2>Expected pickups <em className="eb-count">{waiting.length}</em></h2>
          {waiting.length === 0 ? <p className="eb-muted">No accepted requests are waiting for collection.</p>
            : <ul className="eb-mini-list">{waiting.map(r => <li key={r.id}><b>{r.requester.name}</b><span>{r.donation.title} · {fmtQty(r.quantity, r.unit)}</span><small><Clock size={10}/> {fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small></li>)}</ul>}
        </Card>
        {done.length > 0 && <Card className="eb-section"><h2>Recently completed</h2>
          <ul className="eb-mini-list">{done.map(r => <li key={r.id}><b>{r.requester.name}</b><span>{r.donation.title} · {fmtQty(r.quantity, r.unit)}</span><small>{fmtDateTime(r.completedAt)}</small></li>)}</ul></Card>}
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export function DonorDashboard() {
  const { user } = useSession();
  const { data: impact } = useFetch<ImpactDTO>("/impact");
  const { data: listings } = useFetch<DonationDTO[]>("/donations/mine");
  const { data: reqs, reload: reloadReqs } = useFetch<RequestDTO[]>("/donor/requests?status=all", { pollMs: 60000 });
  const { data: notes } = useFetch<NotificationDTO[]>("/notifications");
  const { data: needs } = useFetch<AnimalNeedDTO[]>("/needs/open");
  const pending = reqs?.filter(r => r.status === "pending") ?? [];
  const upcoming = (reqs?.filter(r => r.status === "accepted") ?? []).sort((a, b) => a.donation.pickupStart.localeCompare(b.donation.pickupStart));
  const soon = Date.now() + 2 * 3600_000;
  const alerts = [
    ...(listings ?? []).filter(d => d.status === "active" && d.remaining > 0 && new Date(d.expiryAt).getTime() < soon && d.availability !== "expired")
      .map(d => ({ id: d.id, text: `“${d.title}” must be used by ${fmtDateTime(d.expiryAt)}.`, tone: "amber" as const })),
    ...(listings ?? []).filter(d => d.availability === "under-review").map(d => ({ id: `r${d.id}`, text: `“${d.title}” is awaiting an EDIBELL safety review.`, tone: "blue" as const })),
  ];
  return <>
    <PageHeading eyebrow="WELCOME BACK" title={`Hello, ${user?.contactName.split(" ")[0] ?? "there"}`} subtitle="Here's what's happening with your surplus food."
      action={<PrimaryLink href="/donor/create"><FilePlus2 size={15}/> Share surplus food</PrimaryLink>}/>
    <div className="stat-grid ngo-stat-grid five">
      <StatCard label="Total food listings" value={String(impact?.totalDonations ?? 0)} note={`${impact?.activeListings ?? 0} currently available`} icon={Package}/>
      <StatCard label="Incoming requests" value={String(impact?.pendingRequests ?? 0)} note="Waiting for your decision" icon={Users} tone="amber"/>
      <StatCard label="Awaiting pickup" value={String(impact?.acceptedRequests ?? 0)} note="Accepted, not yet collected" icon={Clock}/>
      <StatCard label="Completed pickups" value={String(impact?.completedPickups ?? 0)} note="Verified by QR scan" icon={CheckCircle2}/>
      <StatCard label="Food donated" value={`${Math.round((impact?.completedFoodKg ?? 0) * 10) / 10} kg`} note="Successfully handed over (kg-equivalent)" icon={Scale} tone="mint"/>
    </div>
    {alerts.length > 0 && <Card className="eb-section"><h2><Bell size={14}/> Alerts</h2><ul className="eb-mini-list">{alerts.map(a => <li key={a.id}><Status tone={a.tone}>{a.tone === "amber" ? "Food safety" : "Review"}</Status><span>{a.text}</span></li>)}</ul></Card>}
    <div className="eb-two-col">
      <div className="eb-stack">
        <Card className="eb-section"><div className="card-heading"><h2>Requests to review</h2><Link href="/donor/requests" className="text-button">View all</Link></div>
          {pending.length === 0 ? <p className="eb-muted">No pending requests right now.</p>
            : <div className="eb-stack">{pending.slice(0, 3).map(r => <RequestRow key={r.id} r={r} onDone={reloadReqs}/>)}</div>}
        </Card>
        <Card className="eb-section"><div className="card-heading"><h2>Recent activity</h2><Link href="/donor/notifications" className="text-button">All notifications</Link></div>
          {!notes || notes.length === 0 ? <p className="eb-muted">Your activity will appear here.</p>
            : <ul className="eb-mini-list">{notes.slice(0, 6).map(n => <li key={n.id}><b>{n.title}</b><span>{n.body}</span><small>{fmtDateTime(n.createdAt)}</small></li>)}</ul>}
        </Card>
      </div>
      <div className="eb-stack">
        <Card className="eb-section"><h2>Upcoming pickups</h2>
          {upcoming.length === 0 ? <p className="eb-muted">Accepted requests waiting for collection will show here.</p>
            : <ul className="eb-mini-list">{upcoming.map(r => <li key={r.id}><b>{r.requester.name}</b><span>{r.donation.title} · {fmtQty(r.quantity, r.unit)}</span><small><Clock size={10}/> {fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small></li>)}</ul>}
          {upcoming.length > 0 && <Link href="/donor/scanner" className="button button-outline button-small"><ScanLine size={14}/> Verify pickup</Link>}
        </Card>
        <Card className="eb-section"><h2><PawPrint size={14}/> Animal feed needs</h2>
          {!needs || needs.length === 0 ? <p className="eb-muted">No open feed requests from animal welfare organizations.</p>
            : <ul className="eb-mini-list">{needs.slice(0, 4).map(n => <li key={n.id}><b>{n.org.name}</b><span>{n.species.join(", ")} · {n.animalCount} animals</span><small><MapPin size={10}/> {[n.org.area, n.org.city].filter(Boolean).join(", ")} · ~{n.quantityPerWeek} {n.unit}/week</small></li>)}</ul>}
          <Link href="/donor/create" className="text-button">Share animal-suitable food <Beef size={12}/></Link>
        </Card>
        <Card className="eb-section"><h2><HeartHandshake size={14}/> Your impact so far</h2>
          <p className="eb-muted">{impact && impact.completedPickups > 0 ? `${Math.round(impact.completedFoodKg)} kg handed over in ${impact.completedPickups} verified pickup${impact.completedPickups > 1 ? "s" : ""}.` : "Impact appears after your first QR-verified pickup."}</p>
          <Link href="/donor/impact" className="text-button">Our Impact <ArrowRight size={12}/></Link>
        </Card>
      </div>
    </div>
  </>;
}

