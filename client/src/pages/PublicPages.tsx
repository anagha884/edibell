import { ArrowRight, Building2, ExternalLink, Leaf, ShieldCheck, ShoppingBasket, Utensils, Users } from "lucide-react";
import { Link } from "wouter";
import type { PublicStats } from "@shared/edibell";
import { useFetch } from "@/lib/api";
import { Card, PublicHeader } from "../components/BrandUI";
import { ContactSection, SiteFooter } from "../components/SiteFooter";
import { categories } from "../data/demo";
import { FACTS, GUIDANCE, HOME_FACT_IDS, type SourcedFact } from "../data/awareness";

export function HomePage() {
  const { data: stats, error: statsError } = useFetch<PublicStats>("/stats");
  const stat = (v: number | undefined, suffix = "") => statsError && !stats ? "—" : `${Math.round(v ?? 0)}${suffix}`;
  return <div className="public-site"><PublicHeader/><main>
    <section className="hero"><div className="hero-copy"><div className="eyebrow"><Leaf size={13}/> FOOD RESCUE, REIMAGINED</div><h1>Good food<br/>deserves a<br/><em>second chance</em></h1><p>EDIBELL connects food donors with NGOs and animal welfare organizations to reduce food waste and create a healthier, more sustainable world.</p><div className="hero-actions"><Link className="button" href="/register">Donate Food <ArrowRight size={15}/></Link><a className="button button-outline" href="#how-it-works">Learn More</a></div><div className="hero-trust"><ShieldCheck size={16}/><span>Safe food. Registered partners. Better impact.</span></div></div><div className="hero-art"><div className="hero-art-frame"><img className="hero-photo" src="/hero-food.jpg" alt="Hands holding a bowl of fresh vegetables, chickpeas and grains"/></div><div className="hero-stamp"><span><Leaf size={16}/></span><b>Good food<br/>goes further</b></div><div className="hero-leaf leaf-one"/><div className="hero-leaf leaf-two"/></div></section>
    <section id="how-it-works" className="category-section"><div className="section-title"><span>WHO CAN DONATE?</span><h2>Make a little food go a long way.</h2></div><div className="category-row">{categories.map((name, index) => { const icons=[Building2,Building2,Utensils,Users,Utensils,ShoppingBasket,ShoppingBasket,Building2]; const Icon=icons[index]; return <div className="category-tile" key={name}><span><Icon size={19}/></span><b>{name}</b></div>; })}</div></section>
    <section className="impact-strip" id="impact"><div className="impact-lead"><span className="impact-seal"><Leaf size={20}/></span><div><b>Less Food Waste</b><small>More Impact</small></div></div><div><strong>{stat(stats?.donors)}</strong><span>Donors</span></div><div><strong>{stat(stats?.ngos)}</strong><span>NGOs</span></div><div><strong>{stat(stats?.animalOrgs)}</strong><span>Animal Organizations</span></div><div><strong>{stat(stats?.foodRescuedKg, " kg")}</strong><span>Food Rescued</span></div></section>
    <section className="how-section" id="food-safety"><div id="about"><div className="eyebrow">A SIMPLE, SAFE JOURNEY</div><h2>From surplus to supper.</h2><p>Donors share safety details, recipients review before requesting, and the donor verifies pickup at handover.</p></div><div className="how-cards"><Card><span className="step-bubble">01</span><b>Share surplus</b><small>Add food and pickup details.</small></Card><Card><span className="step-bubble">02</span><b>Safety screening</b><small>We guide food to the right pathway.</small></Card><Card><span className="step-bubble">03</span><b>Make an impact</b><small>Registered partners collect and confirm.</small></Card></div></section>
    <section className="eb-why" aria-labelledby="why-title"><div className="section-title"><span>WHY IT MATTERS</span><h2 id="why-title">The scale of food waste</h2></div>
      <div className="eb-fact-grid">{FACTS.filter(f => HOME_FACT_IDS.includes(f.id)).map(f => <FactCard key={f.id} f={f} compact/>)}</div>
      <p className="eb-why-foot"><span>EDIBELL's own numbers above count only pickups verified at handover.</span> <Link href="/why-food-rescue" className="text-button">Sources, definitions &amp; food-safety guidance <ArrowRight size={13}/></Link></p>
    </section>
    <ContactSection/>
  </main><SiteFooter/></div>;
}

function FactCard({ f, compact = false }: { f: SourcedFact; compact?: boolean }) {
  return <Card className={`eb-fact ${f.check}`}>
    <strong>{f.value}</strong><span>{f.unit}</span>
    {!compact && <p>{f.statement}</p>}
    <small className="eb-fact-source"><a href={f.url} target="_blank" rel="noreferrer">{f.sourceOrg} · {f.report} ({f.year}) <ExternalLink size={10}/></a></small>
    {!compact && <dl className="eb-facts"><div><dt>Data year</dt><dd>{f.dataYear}</dd></div><div><dt>Scope</dt><dd>{f.scope}</dd></div><div><dt>Definition</dt><dd>{f.definition}</dd></div></dl>}
    {!compact && f.note && <small className={f.check === "secondary" ? "eb-warn-text" : "eb-hint"}>{f.note}</small>}
  </Card>;
}

export function WhyFoodRescuePage() {
  const { data: stats } = useFetch<PublicStats>("/stats");
  return <div className="public-site"><PublicHeader back="/"/><main className="eb-why-page">
    <section className="eb-why"><div className="eyebrow"><Leaf size={13}/> WHY FOOD RESCUE MATTERS</div><h1>Good food deserves a second chance</h1>
      <p className="eb-muted">Three different kinds of numbers appear on EDIBELL, and we keep them apart: <b>verified external facts</b> from authoritative sources, <b>EDIBELL's actual impact</b> from QR-verified handovers, and clearly labelled <b>estimates</b>.</p></section>
    <section className="eb-why"><h2>1 · Verified external facts</h2>
      <p className="eb-muted">Food <b>loss</b> happens between harvest and retail; food <b>waste</b> happens in retail, food service and homes. The sources measure them separately.</p>
      <div className="eb-fact-grid wide">{FACTS.map(f => <FactCard key={f.id} f={f}/>)}</div></section>
    <section className="eb-why"><h2>2 · EDIBELL's actual impact</h2>
      <p className="eb-muted">Calculated live from completed, QR-verified pickups only. Listed, requested or accepted food is never counted.</p>
      <div className="impact-strip"><div className="impact-lead"><span className="impact-seal"><Leaf size={20}/></span><div><b>Verified handovers</b><small>Live from EDIBELL</small></div></div>
        <div><strong>{stats?.completedPickups ?? 0}</strong><span>Completed pickups</span></div><div><strong>{Math.round(stats?.humanFoodKg ?? 0)} kg</strong><span>Food to people</span></div><div><strong>{Math.round(stats?.animalFeedKg ?? 0)} kg</strong><span>Feed to animals</span></div></div></section>
    <section className="eb-why"><h2>3 · Estimates</h2>
      <p className="eb-muted">Portal impact pages show <b>estimated</b> meals (human food kg ÷ 0.4 kg per meal) and CO₂e avoided (≈2.5 kg CO₂e per kg of food). These are rough, documented rules of thumb for illustration, not measured or certified reductions; real portion sizes and emission factors vary by food type.</p></section>
    <section className="eb-why"><h2>Food-safety and redistribution guidance</h2>
      <div className="eb-guide-grid">{GUIDANCE.map(g => <Card key={g.title} className="eb-section"><h3>{g.title}</h3><ul>{g.points.map(p => <li key={p}>{p}</li>)}</ul>
        {g.source && <small className="eb-fact-source"><a href={g.source.url} target="_blank" rel="noreferrer">{g.source.label} <ExternalLink size={10}/></a></small>}</Card>)}</div>
      <p className="eb-hint">Guidance here is general information, not legal or veterinary advice. Follow FSSAI rules and local regulations, and ask a veterinarian about specific animals' diets.</p></section>
    <section className="eb-why eb-why-cta"><Link className="button" href="/register">Get Started <ArrowRight size={15}/></Link><Link className="button button-outline" href="/login">Log In</Link></section>
  </main><SiteFooter/></div>;
}
