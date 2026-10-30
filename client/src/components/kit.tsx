import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, Camera, Check, Eye, EyeOff, ImagePlus, Loader2, Utensils, X } from "lucide-react";
import type { RequestStatus } from "@shared/edibell";
import { Status } from "./BrandUI";
import { FOOD_PHOTO_BUCKET, photoUrl, supabase } from "@/lib/supabase";

// ---------- formatting ---------------------------------------------------
export const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export function fmtWindow(start: string, end: string) {
  const s = new Date(start), e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  return sameDay
    ? `${s.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${timeOnly(start)} – ${timeOnly(end)}`
    : `${fmtDateTime(start)} – ${fmtDateTime(end)}`;
}
export const fmtQty = (n: number, unit: string) => `${Math.round(n * 100) / 100} ${unit}`;
/** value for <input type="datetime-local"> in the browser's local time */
export function toLocalInput(d: Date | string) {
  const x = typeof d === "string" ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : "");
export const plusHours = (h: number) => new Date(Date.now() + h * 3600_000);

// ---------- status pills -------------------------------------------------
const tone: Record<RequestStatus, "green" | "amber" | "red" | "blue" | "gray"> = {
  pending: "amber", accepted: "blue", declined: "red", cancelled: "gray", completed: "green", expired: "gray",
};
export function RequestStatusPill({ status }: { status: RequestStatus }) {
  return <Status tone={tone[status]}>{status[0].toUpperCase() + status.slice(1)}</Status>;
}

// ---------- states -------------------------------------------------------
export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="eb-loading" role="status"><Loader2 size={16} className="eb-spin"/> {label}</div>;
}
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  return <div className="eb-error" role="alert"><AlertTriangle size={15}/><span>{message}</span>{onRetry && <button type="button" className="text-button" onClick={onRetry}>Retry</button>}</div>;
}
export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="eb-empty">{icon}<b>{title}</b>{children && <p>{children}</p>}</div>;
}

// ---------- inputs ---------------------------------------------------------
export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return <label className="form-field"><span>{label}{required && " *"}</span>{children}{hint && <small className="eb-hint">{hint}</small>}</label>;
}

/** Password field with a show/hide (eye) toggle. Use inside a <label className="form-field">. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return <span className="eb-password">
    <input {...props} type={shown ? "text" : "password"} autoCapitalize="none" spellCheck={false}/>
    <button type="button" className="eb-password-toggle" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown}
      title={shown ? "Hide password" : "Show password"} onClick={() => setShown(v => !v)}>{shown ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
  </span>;
}

export function ChipSelect({ options, value, onChange, max }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter(x => x !== o) : max && value.length >= max ? value : [...value, o]);
  return <div className="eb-chips" role="group">{options.map(o =>
    <button type="button" key={o} className={`eb-chip ${value.includes(o) ? "on" : ""}`} aria-pressed={value.includes(o)} onClick={() => toggle(o)}>{value.includes(o) && <Check size={11}/>}{o}</button>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return <div className="eb-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`eb-modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16}/></button></header>
      <div className="eb-modal-body">{children}</div>
    </div>
  </div>;
}

// ---------- photos ---------------------------------------------------------
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

/** Re-encode a photo as a ≤1600px JPEG (strips EXIF/location metadata). */
async function shrinkImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't read that image. Use a JPEG, PNG or WebP photo.")); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.85;
    let blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/jpeg", q));
    while (blob && blob.size > 1.5 * 1024 * 1024 && q > 0.45) { q -= 0.1; blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/jpeg", q)); }
    if (!blob) throw new Error("Couldn't process that image.");
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Uploads food photos to Supabase Storage (bucket "food-photos", folder = the
 * donor's user id) as soon as they are chosen. `value` holds storage paths.
 */
export function PhotoPicker({ value, onChange, ownerId, max = 5 }: { value: string[]; onChange: (v: string[]) => void; ownerId: string; max?: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(0);
  const add = async (files: FileList | null) => {
    if (!files) return;
    setErr("");
    const sb = supabase;
    if (!sb) { setErr("Photo upload needs the Supabase backend to be configured."); return; }
    let next = [...value];
    for (const f of Array.from(files)) {
      if (next.length >= max) { setErr(`You can add up to ${max} photos.`); break; }
      if (!ACCEPTED.includes(f.type)) { setErr("Only JPEG, PNG or WebP photos can be added."); continue; }
      if (f.size > MAX_SOURCE_BYTES) { setErr("That photo is too large (max 15 MB before resizing)."); continue; }
      setUploading(n => n + 1);
      try {
        const blob = await shrinkImage(f);
        const path = `${ownerId}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from(FOOD_PHOTO_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw new Error(/row-level security|unauthorized/i.test(error.message) ? "Only food donors can upload food photos." : `Upload failed: ${error.message}`);
        next = [...next, path];
        onChange(next);
      } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't add that photo."); }
      finally { setUploading(n => n - 1); }
    }
    if (input.current) input.current.value = "";
  };
  const remove = (path: string) => {
    onChange(value.filter(p => p !== path));
    // Delete the file if it isn't attached to a published listing yet (storage policy enforces this).
    void supabase?.storage.from(FOOD_PHOTO_BUCKET).remove([path]);
  };
  return <div>
    <div className="eb-photos">
      {value.map((path, i) => <div className="eb-photo" key={path}><img src={photoUrl(path)} alt={`Food photo ${i + 1}`}/><button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => remove(path)}><X size={12}/></button></div>)}
      {uploading > 0 && <div className="eb-photo add" aria-live="polite"><Loader2 size={20} className="eb-spin"/><span>Uploading…</span></div>}
      {value.length + uploading < max && <button type="button" className="eb-photo add" onClick={() => input.current?.click()}><ImagePlus size={20}/><span>Add photo</span></button>}
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => void add(e.target.files)}/>
    {err && <p className="eb-field-error" role="alert">{err}</p>}
    <small className="eb-hint"><Camera size={11}/> Up to {max} real photos of this food (JPEG, PNG or WebP). They're resized and location data is removed.</small>
  </div>;
}

/** The donor's own photo of this food, or a neutral placeholder. Never a stock photo. */
export function FoodThumb({ src, alt, className = "" }: { src?: string; alt: string; className?: string }) {
  return src ? <img className={`eb-thumb ${className}`} src={src} alt={alt} loading="lazy"/> : <div className={`eb-thumb eb-thumb-empty ${className}`} role="img" aria-label="No photo provided"><Utensils size={20}/></div>;
}

export function BarList({ rows, unit = "kg" }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  if (!rows.length) return <p className="eb-muted">No completed pickups yet.</p>;
  return <ul className="eb-bars">{rows.map(r => <li key={r.label}><span>{r.label}</span><div><i style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }}/></div><b>{Math.round(r.value * 10) / 10} {unit}</b></li>)}</ul>;
}
