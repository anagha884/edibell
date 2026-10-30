import { useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Mail, Phone, Send } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { CONTACT, formatPhone, mailtoHref, telHref } from "@/config/contact";

/**
 * Public "Get in Touch" section and site footer.
 * Messages are saved by the database function public.submit_contact_message
 * (migration 20261030150000). Success is shown only after the database
 * confirms the message was stored; administrators read them under Administration.
 */
type Fields = { name: string; email: string; subject: string; message: string };
const EMPTY: Fields = { name: "", email: "", subject: "", message: "" };
const MAX = { name: 100, email: 254, subject: 150, message: 4000 } as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

function validate(f: Fields): Partial<Record<keyof Fields, string>> {
  const e: Partial<Record<keyof Fields, string>> = {};
  if (f.name.trim().length < 2) e.name = "Please enter your name.";
  if (!EMAIL_RE.test(f.email.trim())) e.email = "Please enter a valid email address.";
  if (f.subject.trim().length < 3) e.subject = "Please enter a subject (at least 3 characters).";
  if (f.message.trim().length < 10) e.message = "Please write a message of at least 10 characters.";
  else if (f.message.length > MAX.message) e.message = `Please keep your message under ${MAX.message} characters.`;
  return e;
}

export function ContactSection() {
  const [f, setF] = useState<Fields>(EMPTY);
  const [trap, setTrap] = useState("");
  const [touched, setTouched] = useState<Partial<Record<keyof Fields, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; name: string; email: string } | { ok: false; message: string } | null>(null);
  const errors = validate(f);
  const show = (k: keyof Fields) => touched[k] ? errors[k] : undefined;
  const set = (k: keyof Fields) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF(p => ({ ...p, [k]: e.target.value })); if (result && !result.ok) setResult(null); };
  const blur = (k: keyof Fields) => () => setTouched(t => ({ ...t, [k]: true }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, email: true, subject: true, message: true });
    if (Object.keys(errors).length) { setResult(null); document.getElementById(`ct-${Object.keys(errors)[0]}`)?.focus(); return; }
    setBusy(true); setResult(null);
    try {
      const out = await api.post<{ ok?: boolean; id?: string }>("/contact", { name: f.name.trim(), email: f.email.trim(), subject: f.subject.trim(), message: f.message.trim(), website: trap });
      if (!out?.ok || !out.id) throw new Error("We couldn't confirm your message was saved. Please try again.");
      setResult({ ok: true, name: f.name.trim(), email: f.email.trim() });
      setF(EMPTY); setTouched({});
    } catch (err) {
      setResult({ ok: false, message: errMsg(err) });
    } finally { setBusy(false); }
  };

  const field = (k: keyof Fields, label: string, input: ReactElement) =>
    <label className={`ct-field ${show(k) ? "has-error" : ""}`} htmlFor={`ct-${k}`}>
      <span>{label} <i aria-hidden="true">*</i></span>
      {input}
      {show(k) && <small className="ct-error" id={`ct-${k}-error`}>{show(k)}</small>}
    </label>;
  const aria = (k: keyof Fields) => ({ id: `ct-${k}`, "aria-invalid": !!show(k), "aria-describedby": show(k) ? `ct-${k}-error` : undefined, required: true });

  return <section className="ct-section" id="contact" aria-labelledby="ct-title">
    <div className="ct-inner">
      <div className="ct-intro">
        <span className="ct-eyebrow">CONTACT US</span>
        <h2 id="ct-title">Get in Touch</h2>
        <p>Have questions, suggestions, or want to partner with us? We'd love to hear from you.</p>
        <ul className="ct-direct">
          <li><a href={mailtoHref()}><span className="ct-icon"><Mail size={17}/></span><span><small>Email us</small><b>{CONTACT.email}</b></span></a></li>
          <li><a href={telHref()}><span className="ct-icon"><Phone size={17}/></span><span><small>Call us</small><b>{formatPhone(CONTACT.phone)}</b></span></a></li>
        </ul>
      </div>

      <form className="ct-form" onSubmit={submit} noValidate aria-describedby="ct-required-note">
        {result?.ok && <div className="ct-note ct-note-ok" role="status"><CheckCircle2 size={18}/><div><b>Thank you, {result.name}. Your message has been sent.</b><span>We've received it and will reply to {result.email}.</span></div></div>}
        {result && !result.ok && <div className="ct-note ct-note-error" role="alert"><AlertCircle size={18}/><div><b>Your message wasn't sent.</b><span>{result.message}</span></div></div>}
        <div className="ct-row">
          {field("name", "Name", <input {...aria("name")} name="name" autoComplete="name" maxLength={MAX.name} value={f.name} onChange={set("name")} onBlur={blur("name")} placeholder="Your full name"/>)}
          {field("email", "Email", <input {...aria("email")} name="email" type="email" inputMode="email" autoComplete="email" maxLength={MAX.email} value={f.email} onChange={set("email")} onBlur={blur("email")} placeholder="you@example.com"/>)}
        </div>
        {field("subject", "Subject", <input {...aria("subject")} name="subject" maxLength={MAX.subject} value={f.subject} onChange={set("subject")} onBlur={blur("subject")} placeholder="What is this about?"/>)}
        {field("message", "Message", <textarea {...aria("message")} name="message" rows={5} maxLength={MAX.message} value={f.message} onChange={set("message")} onBlur={blur("message")} placeholder="Write your message here…"/>)}
        <div className="ct-trap" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={trap} onChange={e => setTrap(e.target.value)} name="website"/></label></div>
        <div className="ct-actions">
          <small id="ct-required-note" className="ct-hint">All fields are required. <span>{f.message.length}/{MAX.message}</span></small>
          <button className="ct-submit" type="submit" disabled={busy}>{busy ? <><Loader2 size={16} className="ct-spin"/> Sending…</> : <>Send Message <Send size={15}/></>}</button>
        </div>
      </form>
    </div>
  </section>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div className="sf-inner">
      <div className="sf-about">
        <div className="sf-brand"><span className="sf-logo"><img src="/edibell-logo.png" alt="EDIBELL logo" width={517} height={394}/></span><b>EDIBELL</b></div>
        <p className="sf-tagline">Rescue food. Feed people. Nourish animals.</p>
        <p className="sf-mission">EDIBELL reduces food waste by connecting food donors — hotels, restaurants, caterers, bakeries and more — with registered NGOs who feed people and animal welfare organizations who care for animals, so good surplus food reaches someone instead of the bin.</p>
      </div>
      <div className="sf-contact">
        <h3>Contact Information</h3>
        <ul>
          <li><a href={mailtoHref()}><Mail size={17}/><span><small>Email</small>{CONTACT.email}</span></a></li>
          <li><a href={telHref()}><Phone size={17}/><span><small>Phone</small>{formatPhone(CONTACT.phone)}</span></a></li>
        </ul>
        <a className="sf-message" href="/#contact">Send us a message <ArrowRight size={14}/></a>
      </div>
    </div>
    <div className="sf-bottom"><span>© {new Date().getFullYear()} EDIBELL. All rights reserved.</span></div>
  </footer>;
}
