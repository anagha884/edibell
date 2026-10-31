/**
 * Right-hand branding panel of the login / password pages: the provided
 * EDIBELL logo (client/public/edibell-logo.png, used as-is), the brand name,
 * a gold heart divider and the tagline.
 *
 * The mint background, organic shapes and botanical leaves are taken from the
 * approved reference design (client/public/login/*.webp): the background with
 * its flowing shapes, and each leaf group as a transparent layer at its
 * reference position. Layers are sized by height and keep their aspect ratio.
 */
import { tr } from "@/i18n";
const DECOR = [
  { name: "branch-top", w: 234, h: 221 },
  { name: "leaf-left", w: 36, h: 45 },
  { name: "leaf-tr-1", w: 21, h: 27 },
  { name: "leaf-tr-2", w: 24, h: 24 },
  { name: "leaf-gold", w: 29, h: 33 },
  { name: "cluster-br", w: 308, h: 280 },
] as const;

export function LoginBrandPanel({ tagline }: { tagline: string }) {
  return <>
    <div className="lb-decor" aria-hidden="true">
      {DECOR.map(d => <img key={d.name} className={`lb-d lb-${d.name}`} src={`/login/${d.name}.webp`} width={d.w} height={d.h} alt="" decoding="async"/>)}
    </div>
    <div className="lb-brand">
      <img className="lb-logo" src="/edibell-logo.png" alt={tr("EDIBELL logo")} width={517} height={394}/>
      <h2 className="lb-name">EDIBELL</h2>
      <div className="lb-divider" aria-hidden="true"><span/><svg viewBox="0 0 24 22"><path d="M12 21C5 16 1 12 1 7a5.5 5.5 0 0 1 11-1.5A5.5 5.5 0 0 1 23 7c0 5-4 9-11 14Z" fill="#c9a45c"/></svg><span/></div>
      <p className="lb-tagline">{tagline}</p>
    </div>
  </>;
}
