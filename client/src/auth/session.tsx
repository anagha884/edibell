import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UserDTO } from "@shared/edibell";
import { ApiError, notifyDataChanged } from "@/lib/api";
import { photoUrl, requireSupabase, SUPABASE_SETUP_MESSAGE, supabase, supabaseConfigured } from "@/lib/supabase";

export interface RegisterResult { user: UserDTO | null; needsEmailConfirmation: boolean }

interface SessionState {
  user: UserDTO | null;
  loading: boolean;
  /** True after the user opened a password-recovery link from their email. */
  recovering: boolean;
  login: (email: string, password: string) => Promise<UserDTO>;
  register: (email: string, password: string, profile: Record<string, unknown>) => Promise<RegisterResult>;
  logout: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  setNewPassword: (password: string) => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  setUser: (u: UserDTO) => void;
  refresh: () => Promise<UserDTO | null>;
}

const Ctx = createContext<SessionState | null>(null);

function authError(e: { message?: string; status?: number } | null | undefined): ApiError {
  const m = e?.message ?? "";
  if (/invalid login credentials/i.test(m)) return new ApiError(401, "Incorrect email or password.");
  if (/email not confirmed/i.test(m)) return new ApiError(401, "Please confirm your email address first. Check your inbox for the EDIBELL confirmation link.");
  if (/already registered|already been registered|user already exists/i.test(m)) return new ApiError(409, "An account with this email already exists. Log in instead, or reset your password.");
  if (/rate limit|too many/i.test(m)) return new ApiError(429, "Too many attempts. Please wait a few minutes and try again.");
  if (/password should be|weak password/i.test(m)) return new ApiError(400, "Choose a stronger password (at least 8 characters, mixing letters and numbers).");
  if (/database error saving new user/i.test(m)) return new ApiError(400, "Your registration details could not be saved. Check the required fields and try again.");
  if (/fetch|network/i.test(m)) return new ApiError(0, "Can't reach EDIBELL right now. Check your connection and try again.");
  return new ApiError(e?.status ?? 400, m || "Something went wrong. Please try again.");
}

async function fetchProfile(): Promise<UserDTO | null> {
  const { data, error } = await requireSupabase().rpc("get_my_profile");
  if (error) throw new ApiError(500, error.code === "PGRST202"
    ? "The EDIBELL database hasn't been set up yet. Apply the Supabase migrations (see README)."
    : "Your organization profile could not be loaded. Please try again.");
  return (data as UserDTO | null) ?? null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState(supabaseConfigured);
  const [recovering, setRecovering] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    if (!data.session) { loadedFor.current = null; setUser(null); return null; }
    const p = await fetchProfile().catch(() => null);
    loadedFor.current = data.session.user.id;
    setUser(p);
    return p;
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void refresh().finally(() => { if (alive) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT" || !session) { loadedFor.current = null; setUser(null); return; }
      // Load the profile when a different user signs in (e.g. after an email
      // confirmation link). Defer: Supabase forbids awaiting inside this callback.
      if (loadedFor.current !== session.user.id) {
        window.setTimeout(() => { void refresh(); }, 0);
      }
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const sb = requireSupabase();
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw authError(error);
    const p = await fetchProfile();
    if (!p) {
      await sb.auth.signOut();
      throw new ApiError(403, "This login has no EDIBELL organization profile. Register as a Food Donor, NGO Partner or Animal Welfare Organization first.");
    }
    loadedFor.current = (await sb.auth.getUser()).data.user?.id ?? null;
    setUser(p);
    notifyDataChanged();
    return p;
  }, []);

  const register = useCallback(async (email: string, password: string, profile: Record<string, unknown>): Promise<RegisterResult> => {
    const sb = requireSupabase();
    const { data, error } = await sb.auth.signUp({
      email: email.trim(), password,
      options: { data: profile, emailRedirectTo: `${window.location.origin}/login?confirmed=1` },
    });
    if (error) throw authError(error);
    // When "Confirm email" is enabled in Supabase, no session is returned until
    // the user clicks the link. An existing confirmed email returns a user with
    // no identities: treat it as "already registered" without revealing more.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new ApiError(409, "An account with this email already exists. Log in instead, or reset your password.");
    }
    if (!data.session) return { user: null, needsEmailConfirmation: true };
    const p = await fetchProfile();
    loadedFor.current = data.session.user.id;
    setUser(p);
    return { user: p, needsEmailConfirmation: false };
  }, []);

  const logout = useCallback(async () => {
    try { await supabase?.auth.signOut(); } finally { loadedFor.current = null; setUser(null); }
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` });
    if (error) throw authError(error);
  }, []);

  const setNewPassword = useCallback(async (password: string) => {
    const { error } = await requireSupabase().auth.updateUser({ password });
    if (error) throw authError(error);
    setRecovering(false);
  }, []);

  const changePassword = useCallback(async (current: string, next: string) => {
    const sb = requireSupabase();
    const email = (await sb.auth.getUser()).data.user?.email;
    if (!email) throw new ApiError(401, "Please log in again.");
    const check = await sb.auth.signInWithPassword({ email, password: current });
    if (check.error) throw new ApiError(401, "Current password is incorrect.");
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) throw authError(error);
  }, []);

  const value = useMemo(() => ({ user, loading, recovering, login, register, logout, sendPasswordReset, setNewPassword, changePassword, setUser, refresh }),
    [user, loading, recovering, login, register, logout, sendPasswordReset, setNewPassword, changePassword, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}

export { SUPABASE_SETUP_MESSAGE, supabaseConfigured, photoUrl };
