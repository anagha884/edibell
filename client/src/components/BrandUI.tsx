import type { ReactNode } from "react";
import { Link } from "wouter";
import { HeartHandshake, Leaf, Utensils, type LucideIcon } from "lucide-react";
import { BackButton } from "./BackButton";

export function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={`brand ${light ? "brand-light" : ""}`}>
    <img className="brand-mark" src="/edibell-logo.png" alt=""/>
    <span>EDIBELL</span>
  </Link>;
}

export function PublicHeader({ back }: { back?: string } = {}) {
  return <header className="public-header">{back ? <div className="eb-back-brand"><BackButton fallback={back}/><Brand/></div> : <Brand/>}<nav><Link href="/">Home</Link><a href="/#how-it-works">How It Works</a><a href="/#food-safety">Food Safety</a><a href="/#about">About</a><a href="/#impact">Impact</a><a href="/#contact">Contact Us</a></nav><div className="public-actions"><Link href="/login">Login</Link><Link className="button button-small" href="/register">Get Started</Link></div></header>;
}

export function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function StatCard({ label, value, note, icon: Icon, tone = "green" }: { label: string; value: string; note: string; icon: LucideIcon; tone?: string }) {
  return <Card className="stat-card"><span className={`stat-icon ${tone}`}><Icon size={19}/></span><div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div></Card>;
}

export function PrimaryLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return <Link href={href} className={`button ${className}`}>{children}</Link>;
}

export function Status({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "blue" | "gray" }) {
  return <span className={`status status-${tone}`}><i/>{children}</span>;
}

export function TinyBars({ values = [38, 55, 47, 72, 61, 89, 65] }: { values?: number[] }) {
  return <div className="tiny-bars" aria-hidden="true">{values.map((value, index) => <span key={index} style={{ height: `${value}%` }}/>)}</div>;
}

export function LeafFooter() {
  return <footer className="leaf-footer"><div className="footer-brand"><Brand/><span>Rescue Food · Feed People · Nourish Animals</span></div><div className="footer-path"><HeartHandshake size={22}/><div><b>Human Food Pathway</b><small>Registered NGOs · Handover via QR</small></div></div><div className="footer-path"><Utensils size={22}/><div><b>Animal Feed Pathway</b><small>Suitable food · Registered animal partners</small></div></div><div className="footer-note">Good food<br/><b>reaches the right place.</b></div></footer>;
}
