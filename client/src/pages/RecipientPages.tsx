import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, Crosshair, Flame, HeartHandshake, History as HistoryIcon, Maximize2, MapPin,
  PawPrint, QrCode, Search, Snowflake, Utensils, X, XCircle,
} from "lucide-react";
import {
  ALLERGENS, ANIMAL_CATEGORIES, ANIMAL_SPECIES, FOOD_ORIGIN_LABEL, FOOD_STATE_LABEL, HUMAN_CATEGORIES, UNITS, formatPickupCode,
  type AnimalNeedDTO, type DonationDTO, type ImpactDTO, type NotificationDTO, type QrDTO, type RequestDTO, type Role,
} from "@shared/edibell";
import { useSession } from "@/auth/session";
import { api, errMsg, qs, useFetch } from "@/lib/api";
import { Card, PageHeading, StatCard, Status } from "../components/BrandUI";
import { QrImage } from "../components/QrTools";
import { DirectionsLink } from "../components/Map";
import {
  ChipSelect, Empty, ErrorNote, Field, FoodThumb, Loading, Modal, RequestStatusPill, fmtDate, fmtDateTime, fmtQty, fmtWindow,
} from "../components/kit";

type RecipientRole = Exclude<Role, "donor">;
const BASE: Record<RecipientRole, string> = { ngo: "/ngo", animal: "/animal" };
const FINDER_NAME: Record<RecipientRole, string> = { ngo: "Discover Food", animal: "Discover Animal Feed" };
const REQUESTS_NAME: Record<RecipientRole, string> = { ngo: "My Food Requests", animal: "My Feed Requests" };

// ---------------------------------------------------------------------------
// Finder (the searchable, filterable marketplace)
// ---------------------------------------------------------------------------
type TimePreset = "any" | "3h" | "today" | "tomorrow";
function presetRange(p: TimePreset): { pickupFrom?: string; pickupTo?: string } {
  const now = new Date();
  if (p === "3h") return { pickupFrom: now.toISOString(), pickupTo: new Date(now.getTime() + 3 * 3600_000).toISOString() };
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (p === "today") return { pickupFrom: now.toISOString(), pickupTo: new Date(startOfDay(now).getTime() + 86400_000 - 1).toISOString() };
  if (p === "tomorrow") { const s = new Date(startOfDay(now).getTime() + 86400_000); return { pickupFrom: s.toISOString(), pickupTo: new Date(s.getTime() + 86400_000 - 1).toISOString() }; }
  return {};
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

export function FinderPage({ role }: { role: RecipientRole }) {
  const isAnimal = role === "animal";
  const [filters, setFilters] = useState({
    q: "", category: "", species: "", diet: "", foodState: "", location: "", minQty: "", maxDistanceKm: "",
    time: "any" as TimePreset, availability: "available", sort: "soonest",
  });
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [open, setOpen] = useState<DonationDTO | null>(null);
  const set = <K extends keyof typeof filters>(k: K, v: (typeof filters)[K]) => setFilters(p => ({ ...p, [k]: v }));
  const debounced = useDebounced(filters);
  const query = qs({
    q: debounced.q, category: debounced.category, species: debounced.species, diet: debounced.diet, foodState: debounced.foodState,
    location: debounced.location, minQty: debounced.minQty, maxDistanceKm: coords ? debounced.maxDistanceKm : "",
    availability: debounced.availability, sort: debounced.sort === "nearest" && !coords ? "soonest" : debounced.sort,
    lat: coords?.lat, lng: coords?.lng, ...presetRange(debounced.time),
  });
  const { data, error, loading, reload } = useFetch<DonationDTO[]>(`/market${query}`, { pollMs: 30000 });
  const categories = isAnimal ? ANIMAL_CATEGORIES : HUMAN_CATEGORIES;
  const active = Object.entries(filters).some(([k, v]) => !["sort", "availability"].includes(k) && v !== "" && v !== "any");

  const locate = () => {
    if (!navigator.geolocation) { toast.error("This browser can't share your location."); return; }
    navigator.geolocation.getCurrentPosition(
      p => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }); toast.success("Using your location for distance."); },
      () => toast.error("Couldn't get your location. Check browser permission."), { timeout: 10000 });
  };

  return <>
    <PageHeading eyebrow={isAnimal ? "ANIMAL-SUITABLE FOOD" : "AVAILABLE FOOD"} title={FINDER_NAME[role]}
      subtitle={isAnimal ? "Only listings donors screened as animal feed, and that passed any required EDIBELL review, appear here. Check species suitability and hazards before requesting." : "Surplus food published by registered donors and screened for human consumption. Open a listing to see everything before you decide."}/>
    <Card className="eb-filters">
      <div className="search-field"><Search size={14}/><input value={filters.q} onChange={e => set("q", e.target.value)} placeholder="Search food, ingredient, donor or place…" aria-label="Search"/>{filters.q && <button type="button" aria-label="Clear search" onClick={() => set("q", "")}><X size={13}/></button>}</div>
      <div className="eb-filter-grid">
        <select value={filters.category} onChange={e => set("category", e.target.value)} aria-label="Food category"><option value="">All categories</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
        {isAnimal
          ? <select value={filters.species} onChange={e => set("species", e.target.value)} aria-label="Animal species"><option value="">All species</option>{ANIMAL_SPECIES.map(s => <option key={s}>{s}</option>)}</select>
          : <select value={filters.diet} onChange={e => set("diet", e.target.value)} aria-label="Diet type"><option value="">Any diet</option><option value="vegetarian">Vegetarian</option><option value="vegan">Vegan</option><option value="non-vegetarian">Non-vegetarian</option><option value="contains-egg">Contains egg</option></select>}
        <select value={filters.foodState} onChange={e => set("foodState", e.target.value)} aria-label="Hot or cold"><option value="">Hot / cold: any</option>{Object.entries(FOOD_STATE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input value={filters.location} onChange={e => set("location", e.target.value)} placeholder="Area, city or PIN" aria-label="Location"/>
        <input type="number" min="0" step="any" value={filters.minQty} onChange={e => set("minQty", e.target.value)} placeholder="Min quantity" aria-label="Minimum quantity"/>
        <select value={filters.time} onChange={e => set("time", e.target.value as TimePreset)} aria-label="Pickup time window"><option value="any">Any pickup time</option><option value="3h">Next 3 hours</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option></select>
        <div className="eb-distance">
          <button type="button" className={`button button-outline ${coords ? "on" : ""}`} onClick={locate}><Crosshair size={13}/> {coords ? "Location on" : "Use my location"}</button>
          <input type="number" min="1" value={filters.maxDistanceKm} onChange={e => set("maxDistanceKm", e.target.value)} placeholder="Within km" disabled={!coords} aria-label="Maximum distance in kilometres" title={coords ? "" : "Turn on your location to filter by distance"}/>
        </div>
        <select value={filters.availability} onChange={e => set("availability", e.target.value)} aria-label="Availability"><option value="available">Available now</option><option value="all">Include fully reserved</option></select>
        <select value={filters.sort} onChange={e => set("sort", e.target.value)} aria-label="Sort by"><option value="soonest">Soonest pickup</option><option value="nearest">Nearest</option><option value="expiry">Expiring soonest</option><option value="quantity">Largest quantity</option><option value="newest">Newest listed</option></select>
        {active && <button type="button" className="text-button" onClick={() => setFilters(p => ({ ...p, q: "", category: "", species: "", diet: "", foodState: "", location: "", minQty: "", maxDistanceKm: "", time: "any" }))}>Clear filters</button>}
      </div>
    </Card>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : !data || data.length === 0
      ? <Empty title={active ? "No listings match these filters" : "No food is available right now"} icon={<Search size={26}/>}>{active ? "Try removing a filter or widening the pickup time." : "Listings appear here as soon as donors publish them, and you'll get a notification. Check again later."}</Empty>
      : <>
        <p className="eb-muted eb-count-line">{data.length} listing{data.length === 1 ? "" : "s"}</p>
        <div className="eb-grid">{data.map(d => <FoodCard key={d.id} d={d} onOpen={() => setOpen(d)}/>)}</div></>}
    {open && <DonationModal role={role} d={open} onClose={() => setOpen(null)} onRequested={() => { setOpen(null); reload(); }}/>}
  </>;
}

function FoodCard({ d, onOpen }: { d: DonationDTO; onOpen: () => void }) {
  const hot = d.foodState === "hot";
  return <button type="button" className="eb-food-card" onClick={onOpen}>
    <div className="eb-food-photo"><FoodThumb src={d.photos[0]} alt={d.title}/>
      <span className="eb-pill-top">{d.availability === "fully-reserved" ? "Fully reserved" : `${fmtQty(d.remaining, d.unit)} left`}</span></div>
    <div className="eb-food-body">
      <b>{d.title}</b>
      <small>{d.category}{d.dietType ? ` · ${d.dietType.replace("-", " ")}` : ""}</small>
      <small className="eb-line"><Utensils size={11}/> {d.donor.name}</small>
      <small className="eb-line"><MapPin size={11}/> {[d.area, d.city].filter(Boolean).join(", ")}{d.distanceKm != null ? ` · ${d.distanceKm} km` : ""}</small>
      <small className="eb-line"><Clock size={11}/> {fmtWindow(d.pickupStart, d.pickupEnd)}</small>
      <div className="eb-badges">
        <span>{hot ? <Flame size={10}/> : d.foodState === "cold" || d.foodState === "frozen" ? <Snowflake size={10}/> : null}{({ hot: "Hot", cold: "Chilled", "room-temperature": "Room temp", frozen: "Frozen", "not-applicable": "Raw / dry" } as Record<string, string>)[d.foodState]}</span>
        {d.animalSpecies.slice(0, 2).map(s => <span key={s} className="paw"><PawPrint size={10}/>{s}</span>)}
        {d.myRequest && ["pending", "accepted"].includes(d.myRequest.status) && <span className="mine">Requested</span>}
      </div>
    </div>
  </button>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function DonationModal({ role, d, onClose, onRequested }: { role: RecipientRole; d: DonationDTO; onClose: () => void; onRequested: () => void }) {
  const isAnimal = role === "animal";
  const [qty, setQty] = useState(String(Math.min(d.remaining, d.remaining)));
  const [people, setPeople] = useState("");
  const [animalCount, setAnimalCount] = useState("");
  const [species, setSpecies] = useState<string[]>(isAnimal && d.animalSpecies.length === 1 ? d.animalSpecies : []);
  const [message, setMessage] = useState("");
  const [collectionNote, setCollectionNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const activeReq = d.myRequest && ["pending", "accepted"].includes(d.myRequest.status);
  const canRequest = d.availability === "available" && !activeReq;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const n = Number(qty);
      if (!(n > 0)) throw new Error("Enter a quantity greater than zero.");
      if (n > d.remaining) throw new Error(`Only ${fmtQty(d.remaining, d.unit)} is available.`);
      await api.post("/requests", { donationId: d.id, quantity: qty, message, collectionNote, beneficiaries: isAnimal ? undefined : people, animalSpecies: isAnimal ? species : undefined, animalCount: isAnimal ? animalCount : undefined });
      toast.success("Request sent. You'll be notified when the donor responds.");
      onRequested();
    } catch (e2) { setErr(errMsg(e2)); }
    finally { setBusy(false); }
  };

  return <Modal title={d.title} onClose={onClose} wide>
    <div className="eb-detail">
      <div>
        {d.photos.length > 0 ? <div className="eb-gallery">{d.photos.map((p, i) => <img key={i} src={p} alt={`${d.title} photo ${i + 1}`}/>)}</div> : <div className="eb-gallery empty">🍲</div>}
        <dl className="eb-facts two">
          <Fact label="Category">{d.category}</Fact>
          <Fact label="Available">{fmtQty(d.remaining, d.unit)} of {fmtQty(d.quantity, d.unit)}</Fact>
          {d.dietType && <Fact label="Diet">{d.dietType.replace("-", " ")}</Fact>}
          <Fact label="Hot / cold">{FOOD_STATE_LABEL[d.foodState]}</Fact>
          <Fact label="Food origin">{FOOD_ORIGIN_LABEL[d.foodOrigin]}</Fact>
          <Fact label="Prepared">{fmtDateTime(d.preparedAt)}</Fact>
          <Fact label="Safe to use until"><b className="eb-warn-text">{fmtDateTime(d.expiryAt)}</b></Fact>
          <Fact label="Packaging">{d.packaging}</Fact>
          <Fact label="Storage">{d.storage}</Fact>
          {d.animalSpecies.length > 0 && <Fact label="Suitable for">{d.animalSpecies.join(", ")}</Fact>}
          {d.restrictions && <Fact label="Restrictions & hazards">{d.restrictions}</Fact>}
          <Fact label={isAnimal ? "Animal-feed screening" : "Safety checklist"}>{isAnimal ? "Donor confirmed: not spoiled, no toxic items, no cooked bones, low salt/spice" : "Donor confirmed: hygienic, temperature-controlled, never served, not spoiled"}</Fact>
          <Fact label="Ingredients">{d.ingredients || "Not listed"}</Fact>
          <Fact label="Allergens">{d.allergens.length ? d.allergens.join(", ") : "None declared"}{d.allergenNotes ? ` · ${d.allergenNotes}` : ""}</Fact>
          {d.handlingNotes && <Fact label="Handling notes">{d.handlingNotes}</Fact>}
          {d.description && <Fact label="Description">{d.description}</Fact>}
        </dl>
        {d.dietType !== null && d.allergens.length === 0 && <p className="eb-hint"><AlertTriangle size={11}/> Allergens not declared are not guaranteed absent. Ask the donor if unsure. Known allergen list: {ALLERGENS.join(", ")}.</p>}
      </div>
      <div className="eb-stack">
        <Card className="eb-section"><h3>Donor</h3>
          <b>{d.donor.name}</b><small className="eb-muted">{d.donor.type || "Food donor"} · {d.donor.verificationStatus === "verified" ? "Verified by EDIBELL" : "Not yet verified by EDIBELL"}</small>
          {d.donor.about && <p className="eb-muted eb-clamp">{d.donor.about}</p>}
          <dl className="eb-facts">
            <Fact label="Location">{[d.area, d.city, d.pincode].filter(Boolean).join(", ")}{d.distanceKm != null ? ` · ${d.distanceKm} km away` : ""}</Fact>
            <Fact label="Ready from">{fmtDateTime(d.readyAt)}</Fact>
            <Fact label="Pickup window">{fmtWindow(d.pickupStart, d.pickupEnd)}</Fact>
            {d.address ? <Fact label="Exact address"><>{d.address}<br/><DirectionsLink lat={d.latitude} lng={d.longitude} address={d.address}/></></Fact> : <Fact label="Exact address"><span className="eb-muted">Shared once the donor accepts your request</span></Fact>}
            {d.pickupContactPhone ? <Fact label="Pickup contact">{d.pickupContactName} · {d.pickupContactPhone}</Fact> : d.donor.phone ? <Fact label="Contact">{d.donor.contactName} · {d.donor.phone}</Fact> : null}
          </dl>
        </Card>
        {activeReq ? <Card className="eb-section"><h3>Your request</h3><RequestStatusPill status={d.myRequest!.status}/>
          {d.myRequest!.status === "accepted" && <p><Link href={`${BASE[role]}/pickup`} className="button button-small"><QrCode size={14}/> Open Pickup Pass</Link></p>}</Card>
          : canRequest ? <Card className="eb-section"><h3>Request this food</h3>
            <form onSubmit={e => void submit(e)} className="eb-stack">
              <ErrorNote message={err}/>
              <Field label={`Quantity needed (max ${fmtQty(d.remaining, d.unit)})`} required><input type="number" step="any" min="0.01" max={d.remaining} value={qty} onChange={e => setQty(e.target.value)} required/></Field>
              {!isAnimal && <Field label="People you'll serve"><input type="number" min="0" value={people} onChange={e => setPeople(e.target.value)} placeholder="Approx. number of beneficiaries"/></Field>}
              {isAnimal && <>
                <div className="form-field"><span>Which animals will eat this? *</span><ChipSelect options={d.animalSpecies} value={species} onChange={setSpecies}/></div>
                <Field label="Number of animals"><input type="number" min="0" value={animalCount} onChange={e => setAnimalCount(e.target.value)}/></Field></>}
              <Field label="Collection details"><input value={collectionNote} onChange={e => setCollectionNote(e.target.value)} maxLength={300} placeholder="Who will collect, expected arrival time, vehicle"/></Field>
              <Field label="Message to donor (optional)"><textarea rows={2} value={message} onChange={e => setMessage(e.target.value)} maxLength={600} placeholder="Anything the donor should know"/></Field>
              <button className="button" type="submit" disabled={busy}>{busy ? "Sending…" : "Send request"} <ArrowRight size={14}/></button>
              <small className="eb-hint">Your Pickup Pass QR is created only after the donor accepts.</small>
            </form></Card>
            : <Card className="eb-section"><p className="eb-muted">This listing can't be requested right now ({d.availability.replace("-", " ")}).</p></Card>}
      </div>
    </div>
  </Modal>;
}

// ---------------------------------------------------------------------------
// My requests
// ---------------------------------------------------------------------------
const TABS = ["all", "pending", "accepted", "completed", "declined", "cancelled", "expired"] as const;

export function MyRequestsPage({ role }: { role: RecipientRole }) {
  const { data, error, loading, reload } = useFetch<RequestDTO[]>("/requests/mine?status=all", { pollMs: 60000 });
  const [tab, setTab] = useState<(typeof TABS)[number]>("all");
  const rows = (data ?? []).filter(r => tab === "all" || r.status === tab);
  const cancel = async (r: RequestDTO) => {
    if (!window.confirm(`Cancel your request for "${r.donation.title}"?${r.status === "accepted" ? " The donor will be notified, the reserved food is released and your Pickup Pass QR stops working." : ""}`)) return;
    try { await api.post(`/requests/${r.id}/cancel`); toast.success("Request cancelled."); reload(); } catch (e) { toast.error(errMsg(e)); }
  };
  return <>
    <PageHeading eyebrow="REQUESTS" title={REQUESTS_NAME[role]} subtitle="Track every request from pending to completed."/>
    <div className="eb-tabs scroll">{TABS.map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}{t !== "all" && <em>{data?.filter(r => r.status === t).length ?? 0}</em>}</button>)}</div>
    <ErrorNote message={error} onRetry={reload}/>
    {loading && !data ? <Loading/> : rows.length === 0
      ? <Empty title="No requests here" icon={<HeartHandshake size={26}/>}>Find food in <Link href={`${BASE[role]}/finder`}>{FINDER_NAME[role]}</Link> and send your first request.</Empty>
      : <div className="eb-stack">{rows.map(r => <Card key={r.id} className="eb-request">
        <div className="eb-request-food"><FoodThumb src={r.donation.photos[0]} alt={r.donation.title}/>
          <div><b>{r.donation.title}</b><small>{r.donor.name} · {[r.donation.area, r.donation.city].filter(Boolean).join(", ")}</small>
            <div className="eb-request-qty"><span>Requested</span><strong>{fmtQty(r.quantity, r.unit)}</strong></div>
            <small><Clock size={11}/> {fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small>
            <small className="eb-muted">Sent {fmtDateTime(r.createdAt)}</small></div>
          <RequestStatusPill status={r.status}/></div>
        {r.status === "accepted" && <div className="eb-note-ok"><CheckCircle2 size={14}/> Accepted. Collect from <b>{r.donation.address ?? r.donor.address ?? "the donor"}</b>{r.donation.pickupContactPhone ? ` · call ${r.donation.pickupContactName} on ${r.donation.pickupContactPhone}` : r.donor.phone ? ` · call ${r.donor.phone}` : ""}. <DirectionsLink lat={r.donation.latitude} lng={r.donation.longitude} address={r.donation.address} label="Directions"/> Show your Pickup Pass to the donor at handover.</div>}
        {r.status === "declined" && <p className="eb-muted"><XCircle size={12}/> Declined{r.declineReason ? `: ${r.declineReason}` : "."}</p>}
        {r.status === "completed" && <p className="eb-muted"><CheckCircle2 size={12}/> Collected {fmtDateTime(r.completedAt)}.</p>}
        <div className="eb-actions">
          {r.status === "accepted" && <Link className="button" href={`${BASE[role]}/pickup`}><QrCode size={15}/> Open Pickup Pass</Link>}
          {(r.status === "pending" || r.status === "accepted") && <button className="button button-outline" onClick={() => void cancel(r)}>Cancel request</button>}
        </div>
      </Card>)}</div>}
  </>;
}

// ---------------------------------------------------------------------------
// Pickup QR (view only: the recipient can never complete a pickup)
// ---------------------------------------------------------------------------
const qrCopy = {
  valid: { tone: "green" as const, label: "Valid", text: "Show this code to the donor when you collect. They scan it to complete the pickup." },
  used: { tone: "gray" as const, label: "Already used", text: "The donor scanned this code and the pickup is complete." },
  expired: { tone: "red" as const, label: "Expired", text: "The pickup window has passed. Contact the donor if you still need to collect." },
  cancelled: { tone: "gray" as const, label: "Cancelled", text: "This request was cancelled, so the code no longer works." },
};

function QrPanel({ requestId }: { requestId: string }) {
  const { data, error } = useFetch<QrDTO>(`/requests/${requestId}/qr`, { pollMs: 8000 });
  const [big, setBig] = useState(false);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (data && prev.current === "valid" && data.state === "used") toast.success("Pickup confirmed by the donor.");
    if (data) prev.current = data.state;
  }, [data]);
  if (error) return <ErrorNote message={error}/>;
  if (!data) return <Loading/>;
  const c = qrCopy[data.state];
  const r = data.request;
  return <Card className="eb-qr-panel">
    <div className="eb-qr-head"><div><small>PICKUP PASS</small><h2>{r.donation.title}</h2></div><Status tone={c.tone}>{c.label}</Status></div>
    <div className="eb-qr-body">
      <div className="eb-qr-art">
        {data.payload
          ? <><QrImage value={data.payload} size={250} label={`Pickup QR code for ${r.donation.title}`}/>
            <p className="eb-code" aria-label="Pickup code">{formatPickupCode(data.code!)}</p>
            <button className="button button-outline button-small" onClick={() => setBig(true)}><Maximize2 size={13}/> Full screen</button></>
          : <div className={`eb-qr-void ${data.state}`}>{data.state === "used" ? <CheckCircle2 size={44}/> : <XCircle size={44}/>}<b>{c.label}</b></div>}
      </div>
      <div>
        <p className={`eb-qr-note ${data.state}`}>{c.text}</p>
        <dl className="eb-facts">
          <Fact label="Food">{fmtQty(r.quantity, r.unit)} · {r.donation.title}</Fact>
          <Fact label="Donor">{r.donor.name}</Fact>
          <Fact label="Pickup address">{r.donation.address ? <>{r.donation.address}<br/><DirectionsLink lat={r.donation.latitude} lng={r.donation.longitude} address={r.donation.address}/></> : "Shared by the donor"}</Fact>
          <Fact label="Pickup window">{fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</Fact>
          {r.donation.pickupContactPhone ? <Fact label="Pickup contact">{r.donation.pickupContactName} · {r.donation.pickupContactPhone}</Fact> : r.donor.phone ? <Fact label="Donor contact">{r.donor.contactName} · {r.donor.phone}</Fact> : null}
          {data.state === "valid" && data.expiresAt && <Fact label="Code valid until">{fmtDateTime(data.expiresAt)}</Fact>}
          {data.usedAt && <Fact label="Completed">{fmtDateTime(data.usedAt)}</Fact>}
        </dl>
        <p className="eb-hint">This pass only displays your single-use code. Only the donor can complete the pickup by scanning it; opening this page again never creates a new code. Don't share screenshots of it with anyone else.</p>
      </div>
    </div>
    {big && data.payload && <div className="eb-fullqr" onClick={() => setBig(false)} role="dialog" aria-modal="true" aria-label="Pickup QR full screen">
      <QrImage value={data.payload} size={Math.min(360, window.innerWidth - 48)} label="Pickup QR code"/>
      <p className="eb-code">{formatPickupCode(data.code!)}</p><small>Tap anywhere to close</small></div>}
  </Card>;
}

export function PickupQrPage({ role }: { role: RecipientRole }) {
  const { data, error, loading } = useFetch<RequestDTO[]>("/requests/mine?status=all", { pollMs: 30000 });
  const withQr = useMemo(() => (data ?? []).filter(r => r.qrState !== null)
    .sort((a, b) => Number(b.qrState === "valid") - Number(a.qrState === "valid") || b.createdAt.localeCompare(a.createdAt)), [data]);
  const [sel, setSel] = useState<string | null>(null);
  const current = sel && withQr.some(r => r.id === sel) ? sel : withQr[0]?.id ?? null;
  return <>
    <PageHeading eyebrow="COLLECTION" title="Pickup Pass" subtitle="Your QR passes for accepted requests. Show one to the donor at their pickup location; the donor scans it to complete the handover."/>
    <ErrorNote message={error}/>
    {loading && !data ? <Loading/> : withQr.length === 0
      ? <Empty title="No Pickup Passes yet" icon={<QrCode size={26}/>}>A pass is created after a donor accepts your request. <Link href={`${BASE[role]}/requests`}>Check your requests</Link>.</Empty>
      : <div className="eb-two-col narrow-left">
        <div className="eb-stack">{withQr.map(r => <button key={r.id} type="button" className={`eb-pick ${current === r.id ? "on" : ""}`} onClick={() => setSel(r.id)}>
          <FoodThumb src={r.donation.photos[0]} alt={r.donation.title}/>
          <span><b>{r.donation.title}</b><small>{r.donor.name}</small><small>{fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small></span>
          <Status tone={qrCopy[r.qrState!].tone}>{qrCopy[r.qrState!].label}</Status></button>)}</div>
        {current && <QrPanel key={current} requestId={current}/>}
      </div>}
  </>;
}

// ---------------------------------------------------------------------------
// Collection history
// ---------------------------------------------------------------------------
export function HistoryPage({ role }: { role: RecipientRole }) {
  const { data, error, loading } = useFetch<RequestDTO[]>("/requests/mine?status=completed");
  const total = (data ?? []).length;
  return <>
    <PageHeading eyebrow="HISTORY" title="Collection History" subtitle="Every pickup the donor verified by scanning your Pickup Pass."/>
    <ErrorNote message={error}/>
    {loading && !data ? <Loading/> : total === 0
      ? <Empty title="Nothing collected yet" icon={<HistoryIcon size={26}/>}>Completed pickups appear here after the donor scans your QR. <Link href={`${BASE[role]}/finder`}>Find food</Link>.</Empty>
      : <Card className="table-wrap"><p className="eb-muted eb-count-line">{total} verified collection{total === 1 ? "" : "s"}</p><table className="eb-table"><thead><tr><th>Collected</th><th>Food</th><th>Quantity</th><th>Donor</th><th>{role === "animal" ? "Animals fed" : "Category"}</th></tr></thead>
        <tbody>{data!.map(r => <tr key={r.id}><td>{fmtDate(r.completedAt)}<small>{fmtDateTime(r.completedAt)}</small></td><td><b>{r.donation.title}</b></td><td>{fmtQty(r.quantity, r.unit)}</td><td>{r.donor.name}<small>{[r.donation.area, r.donation.city].filter(Boolean).join(", ")}</small></td><td>{role === "animal" ? (r.animalSpecies.join(", ") || "—") : r.donation.category}</td></tr>)}</tbody></table></Card>}
  </>;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export function RecipientDashboard({ role }: { role: RecipientRole }) {
  const { user } = useSession();
  const isAnimal = role === "animal";
  const { data: impact } = useFetch<ImpactDTO>("/impact");
  const { data: reqs } = useFetch<RequestDTO[]>("/requests/mine?status=all", { pollMs: 60000 });
  const { data: market } = useFetch<DonationDTO[]>(`/market${qs({ sort: "soonest", mySpecies: isAnimal ? "true" : "" })}`, { pollMs: 120000 });
  const { data: notes } = useFetch<NotificationDTO[]>("/notifications");
  const upcoming = (reqs ?? []).filter(r => r.status === "accepted").sort((a, b) => a.donation.pickupStart.localeCompare(b.donation.pickupStart));
  const pending = (reqs ?? []).filter(r => r.status === "pending");
  const soon = Date.now() + 2 * 3600_000;
  const alerts = upcoming.filter(r => new Date(r.donation.pickupEnd).getTime() < soon || new Date(r.donation.expiryAt).getTime() < soon);
  return <>
    <PageHeading eyebrow="WELCOME BACK" title={user?.orgName ?? "Dashboard"} subtitle={isAnimal ? "Healthy animals. A kinder tomorrow." : "Receive food. Support communities. Create change."}
      action={<Link className="button" href={`${BASE[role]}/finder`}><Search size={15}/> {FINDER_NAME[role]}</Link>}/>
    <div className="stat-grid ngo-stat-grid five">
      <StatCard label={isAnimal ? "Suitable feed available" : "Eligible food available"} value={String(market?.length ?? 0)} note={isAnimal ? "For your species" : "Listings you can request"} icon={isAnimal ? PawPrint : Utensils}/>
      <StatCard label="Pending requests" value={String(pending.length)} note="Awaiting donor" icon={Clock} tone="amber"/>
      <StatCard label="Awaiting pickup" value={String(upcoming.length)} note="Pickup Pass ready" icon={QrCode}/>
      <StatCard label="Completed collections" value={String(impact?.completedPickups ?? 0)} note="Verified by donors" icon={CheckCircle2}/>
      {isAnimal
        ? <StatCard label="Feed received" value={`${Math.round((impact?.animalFeedKg ?? 0) * 10) / 10} kg`} note="Kg-equivalent, verified" icon={PawPrint} tone="mint"/>
        : <StatCard label="Food collected" value={`${Math.round((impact?.humanFoodKg ?? 0) * 10) / 10} kg`} note={`≈ ${impact?.mealsSupported ?? 0} meals (estimate)`} icon={HeartHandshake} tone="mint"/>}
    </div>
    {alerts.length > 0 && <Card className="eb-section"><h2><AlertTriangle size={14}/> Pickup &amp; food-safety alerts</h2>
      <ul className="eb-mini-list">{alerts.map(r => <li key={r.id}><b>{r.donation.title}</b><span>Pickup window ends {fmtDateTime(r.donation.pickupEnd)} · safe until {fmtDateTime(r.donation.expiryAt)}</span><small>Collect on time; don't use food after its safe-use deadline.</small></li>)}</ul></Card>}
    <div className="eb-two-col">
      <div className="eb-stack">
        <Card className="eb-section"><div className="card-heading"><h2>{isAnimal ? "Suitable feed near you" : "Available food"}</h2><Link href={`${BASE[role]}/finder`} className="text-button">See all</Link></div>
          {!market ? <Loading/> : market.length === 0 ? <p className="eb-muted">{isAnimal ? "No screened feed for your species right now." : "No food is available right now."} You'll be notified when donors publish.</p>
            : <ul className="eb-mini-list">{market.slice(0, 4).map(d => <li key={d.id}><b>{d.title}</b><span>{fmtQty(d.remaining, d.unit)} · {d.donor.name}{isAnimal ? ` · ${d.animalSpecies.join(", ")}` : ""}</span><small><Clock size={10}/> {fmtWindow(d.pickupStart, d.pickupEnd)} · {d.area}, {d.city}</small></li>)}</ul>}
        </Card>
        <Card className="eb-section"><div className="card-heading"><h2>Recent activity</h2><Link href={`${BASE[role]}/notifications`} className="text-button">All notifications</Link></div>
          {!notes || notes.length === 0 ? <p className="eb-muted">Your activity will appear here.</p>
            : <ul className="eb-mini-list">{notes.slice(0, 6).map(n => <li key={n.id}><b>{n.title}</b><span>{n.body}</span><small>{fmtDateTime(n.createdAt)}</small></li>)}</ul>}
        </Card>
      </div>
      <div className="eb-stack">
        <Card className="eb-section"><h2>Upcoming pickups</h2>
          {upcoming.length === 0 ? <p className="eb-muted">Accepted requests will appear here with their Pickup Pass.</p>
            : <ul className="eb-mini-list">{upcoming.map(r => <li key={r.id}><b>{r.donation.title}</b><span>{r.donor.name} · {fmtQty(r.quantity, r.unit)}</span><small><Clock size={10}/> {fmtWindow(r.donation.pickupStart, r.donation.pickupEnd)}</small></li>)}</ul>}
          {upcoming.length > 0 && <Link href={`${BASE[role]}/pickup`} className="button button-small"><QrCode size={14}/> Open Pickup Pass</Link>}
        </Card>
        {isAnimal && <Card className="eb-section"><h2><PawPrint size={14}/> Your animals</h2>
          <p className="eb-muted">{user?.species.length ? user.species.join(", ") : "Add species in your Animal Care Profile."}{user?.capacity != null ? ` · ${user.capacity} animals in care` : ""}</p>
          {user?.careRequirements && <p className="eb-muted eb-clamp">{user.careRequirements}</p>}
          <Link href="/animal/profile" className="text-button">Animal Care Profile &amp; feed needs <ArrowRight size={12}/></Link></Card>}
      </div>
    </div>
  </>;
}

// ---------------------------------------------------------------------------
// Feed needs posted by an animal welfare organization (shown in its Animal Care Profile)
// ---------------------------------------------------------------------------
export function AnimalNeedsSection() {
  const { data, error, loading, reload } = useFetch<AnimalNeedDTO[]>("/needs/mine");
  const [f, setF] = useState({ title: "", animalCount: "", quantityPerWeek: "", unit: "kg", notes: "" });
  const [species, setSpecies] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (species.length === 0) throw new Error("Select at least one species.");
      await api.post("/needs", { ...f, species, categories: cats });
      toast.success("Feed need posted. Donors in your city can now see it.");
      setF({ title: "", animalCount: "", quantityPerWeek: "", unit: "kg", notes: "" }); setSpecies([]); setCats([]); reload();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  const close = async (id: string) => { try { await api.post(`/needs/${id}/close`); reload(); } catch (e) { toast.error(errMsg(e)); } };
  return <div className="eb-two-col">
    <Card className="eb-section"><h2>Post a feed need</h2>
      <p className="eb-muted">Tell donors what your animals need. Open needs appear on donors' dashboards.</p>
      <form className="eb-form-grid" onSubmit={e => void submit(e)}>
        <div className="eb-span-2"><ErrorNote message={err}/></div>
        <div className="eb-span-2"><Field label="Title" required><input value={f.title} onChange={e => setF(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Daily feed for 40 street dogs" maxLength={120} required/></Field></div>
        <div className="form-field eb-span-2"><span>Species *</span><ChipSelect options={ANIMAL_SPECIES} value={species} onChange={setSpecies}/></div>
        <Field label="Number of animals" required><input type="number" min="1" value={f.animalCount} onChange={e => setF(p => ({ ...p, animalCount: e.target.value }))} required/></Field>
        <div className="eb-pair"><Field label="Needed per week" required><input type="number" min="0.1" step="any" value={f.quantityPerWeek} onChange={e => setF(p => ({ ...p, quantityPerWeek: e.target.value }))} required/></Field>
          <Field label="Unit"><select value={f.unit} onChange={e => setF(p => ({ ...p, unit: e.target.value }))}>{UNITS.map(u => <option key={u}>{u}</option>)}</select></Field></div>
        <div className="form-field eb-span-2"><span>Preferred food types</span><ChipSelect options={ANIMAL_CATEGORIES} value={cats} onChange={setCats}/></div>
        <div className="eb-span-2"><Field label="Notes"><textarea rows={2} value={f.notes} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} maxLength={600} placeholder="Diet restrictions, collection hours, containers available…"/></Field></div>
        <button className="button eb-span-2" type="submit" disabled={busy}>{busy ? "Posting…" : "Post feed need"}</button>
      </form>
    </Card>
    <div className="eb-stack">
      <ErrorNote message={error} onRetry={reload}/>
      {loading && !data ? <Loading/> : !data || data.length === 0 ? <Empty title="No feed needs posted" icon={<PawPrint size={26}/>}>Post one so donors know what your animals need.</Empty>
        : data.map(n => <Card key={n.id} className="eb-section"><div className="eb-row-top"><b>{n.title}</b><Status tone={n.status === "open" ? "green" : "gray"}>{n.status === "open" ? "Open" : "Closed"}</Status></div>
          <small>{n.species.join(", ")} · {n.animalCount} animals · ~{n.quantityPerWeek} {n.unit}/week</small>
          {n.categories.length > 0 && <small className="eb-muted">Prefers: {n.categories.join(", ")}</small>}
          {n.notes && <p className="eb-muted">{n.notes}</p>}
          {n.status === "open" && <button className="button button-outline button-small" onClick={() => void close(n.id)}>Mark fulfilled / close</button>}</Card>)}
    </div>
  </div>;
}
