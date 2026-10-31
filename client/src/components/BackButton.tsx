import { ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";
import { useSession } from "@/auth/session";
import { currentNav } from "@/lib/navHistory";
import { tr } from "@/i18n";

const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];
const PORTAL_PREFIXES = ["/donor", "/ngo", "/animal", "/admin"];
const pathOf = (url: string) => url.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
const isAuthPage = (url: string) => AUTH_PAGES.includes(pathOf(url));
const isPortalPage = (url: string) => PORTAL_PREFIXES.some(p => pathOf(url) === p || pathOf(url).startsWith(p + "/"));

/**
 * Consistent back arrow. Goes back in the browser history when the previous
 * page is an in-app page that still makes sense for the current session;
 * otherwise navigates to `fallback`. Hidden when there is nowhere to go.
 *
 * Never returns a signed-in user to the login/registration forms, and never
 * sends a signed-out visitor into a portal page (which would only bounce
 * them to login).
 */
export function BackButton({ fallback, className = "" }: { fallback: string; className?: string }) {
  const [path, setLocation] = useLocation();   // re-render on every navigation
  const { user } = useSession();
  const { i, prev } = currentNav();

  const prevUsable = i > 0 && !!prev && pathOf(prev) !== pathOf(path)
    && !(user && isAuthPage(prev))
    && !(!user && isPortalPage(prev))
    && !(user && isPortalPage(prev) && !pathOf(prev).startsWith(`/${user.role}`) && !(user.isAdmin && pathOf(prev).startsWith("/admin")));
  if (!prevUsable && pathOf(fallback) === pathOf(path)) return null;

  const goBack = () => { if (prevUsable) window.history.back(); else setLocation(fallback); };
  return <button type="button" className={`eb-back ${className}`} onClick={goBack} aria-label={tr("Go back")} title={tr("Go back")}><ArrowLeft size={18} strokeWidth={2.2}/></button>;
}
