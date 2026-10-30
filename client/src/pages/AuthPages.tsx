import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, Check, Handshake, Heart, Leaf, MailCheck, PawPrint, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { ANIMAL_ORG_TYPES, ANIMAL_SPECIES, DONOR_TYPES, NGO_TYPES, ROLE_HOME, type Role } from "@shared/edibell";
import { SUPABASE_SETUP_MESSAGE, supabaseConfigured, useSession } from "@/auth/session";
import { errMsg } from "@/lib/api";
import { Brand } from "../components/BrandUI";
import { ChipSelect, PasswordInput } from "../components/kit";
import { LoginBrandPanel } from "../components/LoginBrandPanel";
import { BackButton } from "../components/BackButton";

interface RoleOption { role: Role; title: string; summary: string; detail: string }
const roleOptions: RoleOption[] = [
  { role: "donor", title: "Food Donor", summary: "Messes, Hotels, Restaurants, Function Halls, Caterers, Bakeries, Supermarkets, Corporate Cafeterias", detail: "Donate surplus food. Reduce waste. Make an impact." },
  { role: "ngo", title: "NGO Partner", summary: "Community Kitchens, Shelters, Orphanages, Old-Age Homes", detail: "Receive food. Support communities. Create change." },
  { role: "animal", title: "Animal Welfare Organization", summary: "Animal Shelters, Gaushalas, Registered Animal-Care Organizations", detail: "Healthy animals. A kinder tomorrow." },
];
const roleIcons = { donor: Building2, ngo: Handshake, animal: PawPrint };
const optionOf = (role: Role) => roleOptions.find(o => o.role === role)!;

function SetupNotice() {
  return supabaseConfigured ? null : <p className="auth-message" role="alert">{SUPABASE_SETUP_MESSAGE}</p>;
}

function AuthFrame({ title, subtitle, children, artText = "Rescue food. Feed people. Nourish animals." }: { title: string; subtitle: string; children: React.ReactNode; artText?: string }) {
  return <div className="auth-page"><div className="auth-logo"><BackButton fallback="/"/><Brand/></div><div className="auth-shell"><div className="auth-form">
    <div className="auth-welcome"><h1>{title}</h1><p>{subtitle}</p></div>
    {children}
  </div><aside className="auth-art lb-panel"><LoginBrandPanel tagline={artText}/></aside></div></div>;
}

export function LoginPage() {
  const [, setLocation] = useLocation();
  const { login } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmed = new URLSearchParams(window.location.search).has("confirmed");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMessage("");
    try { const u = await login(email, password); setLocation(ROLE_HOME[u.role]); }
    catch (err) { setMessage(errMsg(err)); }
    finally { setBusy(false); }
  };

  return <AuthFrame title="Welcome Back" subtitle="Sign in to your EDIBELL portal">
    <form className="eb-stack" onSubmit={e => void submit(e)}>
      <SetupNotice/>
      {confirmed && <p className="eb-note-ok" role="status"><MailCheck size={14}/> Email confirmed. You can log in now.</p>}
      <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required/></label>
      <label className="form-field"><span>Password</span><PasswordInput autoComplete="current-password" placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} required/></label>
      <div className="auth-row"><span/><Link href="/forgot-password" className="text-button">Forgot password?</Link></div>
      {message && <p className="auth-message" role="alert">{message}</p>}
      <button className="button button-full" type="submit" disabled={busy || !supabaseConfigured}>{busy ? "Signing in…" : "Login"}</button>
      <p className="eb-hint">You'll be taken to the portal for the account type you registered with.</p>
      <p className="auth-foot">Don’t have an account? <Link href="/register">Get Started</Link></p>
    </form>
  </AuthFrame>;
}

export function ForgotPasswordPage() {
  const { sendPasswordReset } = useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMessage("");
    try { await sendPasswordReset(email); setSent(true); } catch (err) { setMessage(errMsg(err)); } finally { setBusy(false); }
  };
  return <AuthFrame title="Reset password" subtitle="We'll email you a secure link to choose a new password.">
    {sent ? <div className="eb-stack"><p className="eb-note-ok" role="status"><MailCheck size={14}/> If an EDIBELL account exists for {email}, a password-reset link is on its way. The link opens this website so you can set a new password.</p>
      <Link href="/login" className="button button-full">Back to login</Link></div>
      : <form className="eb-stack" onSubmit={e => void submit(e)}>
        <SetupNotice/>
        <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required/></label>
        {message && <p className="auth-message" role="alert">{message}</p>}
        <button className="button button-full" type="submit" disabled={busy || !supabaseConfigured}>{busy ? "Sending…" : "Send reset link"}</button>
        <p className="auth-foot"><Link href="/login">Back to login</Link></p>
      </form>}
  </AuthFrame>;
}

export function ResetPasswordPage() {
  const { user, recovering, setNewPassword, loading } = useSession();
  const [, setLocation] = useLocation();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMessage("");
    if (pw.length < 8) { setMessage("Password must be at least 8 characters."); return; }
    if (pw !== pw2) { setMessage("The two passwords don't match."); return; }
    setBusy(true);
    try { await setNewPassword(pw); setLocation(user ? ROLE_HOME[user.role] : "/login"); } catch (err) { setMessage(errMsg(err)); } finally { setBusy(false); }
  };
  const ready = recovering || !!user;
  return <AuthFrame title="Choose a new password" subtitle="Use at least 8 characters.">
    {loading ? <p className="eb-muted">Checking your reset link…</p> : !ready
      ? <div className="eb-stack"><p className="auth-message" role="alert">This page needs a valid password-reset link. Links expire after a short time; request a new one.</p><Link href="/forgot-password" className="button button-full">Request a new link</Link></div>
      : <form className="eb-stack" onSubmit={e => void submit(e)}>
        <label className="form-field"><span>New password</span><PasswordInput autoComplete="new-password" minLength={8} value={pw} onChange={e => setPw(e.target.value)} required/></label>
        <label className="form-field"><span>Confirm new password</span><PasswordInput autoComplete="new-password" minLength={8} value={pw2} onChange={e => setPw2(e.target.value)} required/></label>
        {message && <p className="auth-message" role="alert">{message}</p>}
        <button className="button button-full" type="submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
      </form>}
  </AuthFrame>;
}

export function RegisterPage() {
  const [, setLocation] = useLocation();
  const { register } = useSession();
  const initialRole = (["donor", "ngo", "animal"] as const).find(r => new URLSearchParams(window.location.search).get("as") === r) ?? "donor";
  const [chosen, setChosen] = useState<Role>(initialRole);
  const [stage, setStage] = useState<"choose" | "details" | "confirm">("choose");
  const [f, setF] = useState({ contactName: "", orgName: "", orgType: "", email: "", phone: "", city: "", area: "", address: "", pincode: "", serviceArea: "", capacity: "", registrationNo: "", careRequirements: "", about: "", password: "", password2: "" });
  const [species, setSpecies] = useState<string[]>([]);
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const option = optionOf(chosen);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value }));
  const types = chosen === "donor" ? DONOR_TYPES : chosen === "ngo" ? NGO_TYPES : ANIMAL_ORG_TYPES;
  const Icon = roleIcons[chosen];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage("");
    if (chosen === "animal" && species.length === 0) { setMessage("Select at least one species your organization cares for."); return; }
    if (f.password.length < 8) { setMessage("Password must be at least 8 characters."); return; }
    if (f.password !== f.password2) { setMessage("The two passwords don't match."); return; }
    if (!agree) { setMessage("Please confirm that you are authorized to register this organization."); return; }
    setBusy(true);
    try {
      const { password: _p, password2: _p2, email, ...profile } = f;
      const out = await register(email, f.password, {
        role: chosen, ...profile, capacity: chosen === "donor" || f.capacity === "" ? null : Number(f.capacity),
        species: chosen === "animal" ? species : [], careRequirements: chosen === "animal" ? f.careRequirements : "",
      });
      if (out.needsEmailConfirmation) setStage("confirm");
      else if (out.user) setLocation(ROLE_HOME[out.user.role]);
      else setMessage("Your account was created but your profile could not be loaded. Please log in.");
    } catch (err) { setMessage(errMsg(err)); }
    finally { setBusy(false); }
  };

  return <div className="role-register-page">
    <header className="role-register-header"><div className="eb-back-brand"><BackButton fallback="/"/><Brand/></div><div><span>Already have an account?</span> <Link href="/login">Log in</Link></div></header>
    <main className="role-register-main">
      {stage === "choose" ? <>
        <div className="role-register-intro"><div className="eyebrow"><Leaf size={13}/> JOIN THE EDIBELL NETWORK</div><h1>Choose your account type</h1><p>Each partner has a dedicated workspace and tools for their role.</p></div>
        <div className="role-cards">{roleOptions.map(o => { const I = roleIcons[o.role]; return <button type="button" key={o.role} className={`role-card role-${o.role} ${chosen === o.role ? "selected" : ""}`} aria-pressed={chosen === o.role} onClick={() => { setChosen(o.role); setMessage(""); }}><div className="role-card-top"><span className="role-icon"><I size={32}/></span>{chosen === o.role && <Check size={18} className="role-check"/>}</div><h2>{o.title}</h2><p className="role-summary">{o.summary}</p><p className="role-detail">{o.detail}</p><span className="role-card-cta">{chosen === o.role ? "Selected" : "Select this account"}</span></button>; })}</div>
        <div className="role-continue"><span>Selected: <b>{option.title}</b></span><button className="button" onClick={() => setStage("details")}>Continue as {option.title}<ArrowRight size={15}/></button></div>
      </> : stage === "confirm" ? <section className="role-form-panel eb-register-panel">
        <div className={`role-form-mark role-${chosen}`}><span className="role-icon"><MailCheck size={27}/></span><div><small>ALMOST THERE</small><h1>Confirm your email</h1></div></div>
        <p className="role-form-intro">We sent a confirmation link to <b>{f.email}</b>. Open it to activate your {option.title} account, then log in.</p>
        <p className="eb-hint">Your organization will show as “Verification pending” until EDIBELL reviews your details.</p>
        <Link href="/login" className="button button-full">Go to login</Link>
      </section> : <section className="role-form-panel eb-register-panel"><button className="back-link" type="button" onClick={() => { setStage("choose"); setMessage(""); }}>← Back to account types</button>
        <div className={`role-form-mark role-${chosen}`}><span className="role-icon"><Icon size={27}/></span><div><small>CREATE ACCOUNT AS</small><h1>{option.title}</h1></div></div>
        <p className="role-form-intro">{option.detail}</p>
        <SetupNotice/>
        <form onSubmit={e => void submit(e)} className="eb-form-grid">
          <label className="form-field"><span>Authorized contact person *</span><input value={f.contactName} onChange={set("contactName")} autoComplete="name" maxLength={120} required/></label>
          <label className="form-field"><span>{chosen === "donor" ? "Business / venue name *" : "Organization name *"}</span><input value={f.orgName} onChange={set("orgName")} maxLength={160} placeholder={chosen === "donor" ? "e.g. Green Valley Hotel" : chosen === "ngo" ? "e.g. Hope Foundation" : "e.g. Happy Paws Shelter"} required/></label>
          <label className="form-field"><span>{chosen === "donor" ? "Business type *" : "Organization type *"}</span><select value={f.orgType} onChange={set("orgType")} required><option value="">Select type</option>{types.map(t => <option key={t}>{t}</option>)}</select></label>
          <label className="form-field"><span>Phone number *</span><input type="tel" value={f.phone} onChange={set("phone")} autoComplete="tel" placeholder="+91 …" maxLength={40} required/></label>
          <label className="form-field eb-span-2"><span>Street address *</span><input value={f.address} onChange={set("address")} autoComplete="street-address" maxLength={300} required/></label>
          <label className="form-field"><span>Area / locality</span><input value={f.area} onChange={set("area")} maxLength={100}/></label>
          <label className="form-field"><span>City *</span><input value={f.city} onChange={set("city")} autoComplete="address-level2" maxLength={100} required/></label>
          <label className="form-field"><span>PIN code</span><input value={f.pincode} onChange={set("pincode")} inputMode="numeric" maxLength={12}/></label>
          <label className="form-field"><span>{chosen === "donor" ? "Usual pickup location / branches" : "Service area"}</span><input value={f.serviceArea} onChange={set("serviceArea")} maxLength={300} placeholder={chosen === "donor" ? "e.g. Main kitchen, rear gate" : "e.g. Shivajinagar and nearby wards"}/></label>
          {chosen !== "donor" && <label className="form-field"><span>{chosen === "ngo" ? "People you can serve per day" : "Animals in your care"}</span><input type="number" min="0" value={f.capacity} onChange={set("capacity")}/></label>}
          <label className="form-field"><span>{chosen === "donor" ? "FSSAI / trade licence number" : "Registration number"}</span><input value={f.registrationNo} onChange={set("registrationNo")} maxLength={80} placeholder={chosen === "donor" ? "Optional, helps verification" : "Trust / society / licence no."}/></label>
          {chosen === "animal" && <div className="form-field eb-span-2"><span>Species you care for *</span><ChipSelect options={ANIMAL_SPECIES} value={species} onChange={setSpecies}/></div>}
          {chosen === "animal" && <label className="form-field eb-span-2"><span>Care requirements</span><textarea rows={2} value={f.careRequirements} onChange={set("careRequirements")} maxLength={1500} placeholder="e.g. Dogs on vet-prescribed diets; no onion/garlic; cattle need fresh greens daily"/></label>}
          <label className="form-field eb-span-2"><span>Email address *</span><input type="email" value={f.email} onChange={set("email")} autoComplete="email" required/></label>
          <label className="form-field"><span>Create password *</span><PasswordInput value={f.password} onChange={set("password")} autoComplete="new-password" minLength={8} placeholder="At least 8 characters" required/></label>
          <label className="form-field"><span>Confirm password *</span><PasswordInput value={f.password2} onChange={set("password2")} autoComplete="new-password" minLength={8} required/></label>
          <label className="check-label eb-span-2"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}/> I am authorized to register this organization, and the details above are accurate. I understand EDIBELL marks it “Verification pending” until it is reviewed.</label>
          {message && <p className="auth-message eb-span-2" role="alert">{message}</p>}
          <button className="button button-full eb-span-2" type="submit" disabled={busy || !supabaseConfigured}>{busy ? "Creating account…" : `Create ${option.title} Account`} <ArrowRight size={15}/></button>
        </form></section>}
    </main>
    <footer className="role-register-footer"><span><Users size={16}/> Food Donors</span><span><Heart size={16}/> Community NGOs</span><span><PawPrint size={16}/> Animal Welfare</span></footer>
  </div>;
}
