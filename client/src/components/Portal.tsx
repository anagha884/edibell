import { BackButton } from "./BackButton";
import { tr, trServer } from "@/i18n";
import { LanguageSelector } from "./LanguageSelector";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  Activity, Bell, ChevronDown, ClipboardCheck, FilePlus2, History, Inbox, LayoutDashboard, LogOut, PackageCheck,
  PawPrint, QrCode, ScanLine, Search, Settings, ShieldCheck, ShoppingBasket, type LucideIcon,
} from "lucide-react";
import { ROLE_HOME, ROLE_LABEL, VERIFICATION_LABEL, type NotificationDTO, type Role } from "@shared/edibell";
import { useSession } from "@/auth/session";
import { notifyDataChanged, useFetch } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { Brand } from "./BrandUI";
import { Loading } from "./kit";

interface NavItem { label: string; href: string; icon: LucideIcon }

/** Each role gets its OWN navigation, in the order the product specifies. */
export const NAV: Record<Role, NavItem[]> = {
  donor: [
    { label: "Dashboard", href: "/donor", icon: LayoutDashboard },
    { label: "Share Surplus Food", href: "/donor/create", icon: FilePlus2 },
    { label: "Incoming Requests", href: "/donor/requests", icon: Inbox },
    { label: "My Food Listings", href: "/donor/donations", icon: PackageCheck },
    { label: "Verify Pickup", href: "/donor/scanner", icon: ScanLine },
    { label: "Notifications", href: "/donor/notifications", icon: Bell },
    { label: "Our Impact", href: "/donor/impact", icon: Activity },
    { label: "Organization Settings", href: "/donor/profile", icon: Settings },
  ],
  ngo: [
    { label: "Dashboard", href: "/ngo", icon: LayoutDashboard },
    { label: "Discover Food", href: "/ngo/finder", icon: Search },
    { label: "My Food Requests", href: "/ngo/requests", icon: ClipboardCheck },
    { label: "Pickup Pass", href: "/ngo/pickup", icon: QrCode },
    { label: "Collection History", href: "/ngo/history", icon: History },
    { label: "Notifications", href: "/ngo/notifications", icon: Bell },
    { label: "Our Impact", href: "/ngo/impact", icon: Activity },
    { label: "Organization Profile", href: "/ngo/profile", icon: Settings },
  ],
  animal: [
    { label: "Dashboard", href: "/animal", icon: LayoutDashboard },
    { label: "Discover Animal Feed", href: "/animal/finder", icon: ShoppingBasket },
    { label: "My Feed Requests", href: "/animal/requests", icon: ClipboardCheck },
    { label: "Pickup Pass", href: "/animal/pickup", icon: QrCode },
    { label: "Collection History", href: "/animal/history", icon: History },
    { label: "Notifications", href: "/animal/notifications", icon: Bell },
    { label: "Our Impact", href: "/animal/impact", icon: Activity },
    { label: "Animal Care Profile", href: "/animal/profile", icon: PawPrint },
  ],
};

const WORKSPACE: Record<Role, string> = { donor: "DONOR WORKSPACE", ngo: "COMMUNITY WORKSPACE", animal: "ANIMAL CARE WORKSPACE" };
const ADMIN_ITEM: NavItem = { label: "Administration", href: "/admin", icon: ShieldCheck };

/** Pushes new notifications to the open portal over Supabase Realtime. */
function useRealtimeNotifications(userId: string | undefined) {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!supabase || !userId) return;
    const channel = supabase.channel(`notifications:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, payload => {
        const n = payload.new as { id: string; title: string; body: string };
        if (seen.current.has(n.id)) return;
        seen.current.add(n.id);
        toast(trServer(n.title), { description: trServer(n.body) });
        notifyDataChanged();
      })
      .subscribe();
    return () => { void supabase?.removeChannel(channel); };
  }, [userId]);
}

export function PortalShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const [path, setLocation] = useLocation();
  // Realtime is the primary signal; the slow poll is a fallback if the socket drops.
  const { data: notes } = useFetch<NotificationDTO[]>(user ? "/notifications" : null, { pollMs: 60000 });
  useRealtimeNotifications(user?.id);
  if (!user) return null;
  const items = user.isAdmin ? [...NAV[user.role], ADMIN_ITEM] : NAV[user.role];
  const unread = notes?.filter(n => !n.read).length ?? 0;
  const current = items.find(i => i.href === path) ?? items.find(i => i.href !== ROLE_HOME[user.role] && path.startsWith(i.href));
  const notificationsHref = items.find(i => i.label === "Notifications")!.href;
  const profileHref = NAV[user.role][NAV[user.role].length - 1].href;
  const doLogout = async () => { await logout(); setLocation("/login"); };

  return <div className="dashboard-shell eb-shell" data-role={user.role}>
    <aside className="sidebar"><Brand light/><div className="side-label">{tr(WORKSPACE[user.role])}</div>
      <nav>{items.map(item => {
        const Icon = item.icon;
        const active = current?.href === item.href;
        return <Link key={item.href} href={item.href} className={`side-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
          <Icon size={16}/><span>{tr(item.label)}</span>
          {item.label === "Notifications" && unread > 0 && <em className="eb-badge">{unread > 9 ? "9+" : unread}</em>}
        </Link>;
      })}</nav>
      <div className="side-bottom"><button type="button" className="side-link logout-button" onClick={() => void doLogout()}><LogOut size={16}/><span>{tr("Logout")}</span></button></div>
    </aside>
    <section className="workspace">
      <header className="topbar">
        <div className="eb-top-left"><BackButton fallback={ROLE_HOME[user.role]}/><div className="crumb"><span>{tr(ROLE_LABEL[user.role])}</span><span className="crumb-dot">/</span><strong>{current ? tr(current.label) : tr("Dashboard")}</strong></div></div>
        <div className="top-actions">
          <LanguageSelector className="eb-lang-portal"/>
          <Link href={profileHref} className={`eb-verify-chip ${user.verificationStatus}`} title={tr(VERIFICATION_LABEL[user.verificationStatus])}>
            <ShieldCheck size={13}/><span>{user.verificationStatus === "verified" ? tr("Verified") : user.verificationStatus === "rejected" ? tr("Not verified") : tr("Verification pending")}</span>
          </Link>
          <Link href={notificationsHref} className="icon-button" aria-label={unread ? tr("Notifications, {n} unread", { n: unread }) : tr("Notifications")}><Bell size={16}/>{unread > 0 && <i/>}</Link>
          <Link href={profileHref} className="user-mini"><span className="avatar">{user.orgName.slice(0, 1).toUpperCase()}</span><span><b>{user.orgName}</b><small>{tr(ROLE_LABEL[user.role])}</small></span><ChevronDown size={13}/></Link>
          <button type="button" className="icon-button eb-mobile-logout" aria-label={tr("Log out")} onClick={() => void doLogout()}><LogOut size={16}/></button>
        </div>
      </header>
      <main className="page-content">{children}</main>
    </section>
  </div>;
}

/** Route guard: only the matching role gets in; others are sent to their own portal. */
export function Protected({ role, adminOnly = false, children }: { role?: Role; adminOnly?: boolean; children: ReactNode }) {
  const { user, loading } = useSession();
  const [, setLocation] = useLocation();
  const dest = loading ? null : !user ? "/login"
    : adminOnly ? (user.isAdmin ? null : ROLE_HOME[user.role])
    : role && user.role !== role ? ROLE_HOME[user.role] : null;
  useEffect(() => { if (dest) setLocation(dest, { replace: true }); }, [dest, setLocation]);  // replace: keeps browser Back from bouncing
  if (loading || dest) return <main className="route-guard" role="status"><Loading label={tr("Opening your EDIBELL workspace…")}/></main>;
  return <PortalShell>{children}</PortalShell>;
}
