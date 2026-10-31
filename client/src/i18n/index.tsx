/**
 * EDIBELL internationalisation (English, Kannada, Hindi) — no external library.
 *
 *  - Source text is English and doubles as the translation key:
 *        tr("Share Surplus Food")            tr("Only {n} kg left", { n })
 *    Kannada and Hindi live in ./kn.ts and ./hi.ts (key → translation).
 *    A missing translation falls back to English; `pnpm check:i18n` lists them.
 *  - Inline markup inside a sentence keeps the translated word order:
 *        trx("Read the <b>safety guidance</b> first.", { b: s => <b>{s}</b> })
 *  - Stored values (categories, statuses, anything sent to Supabase) stay in
 *    English; only what is displayed is translated (tr(value) at render time).
 *  - The chosen language is saved in localStorage ("edibell.lang") and applied
 *    to <html lang>. English is used until a visitor picks another language.
 *
 * To add a language: add it to LANGS, create ./<code>.ts and register it in DICTS.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import kn from "./kn";
import hi from "./hi";
import { translateServerText } from "./server";

export const LANGS = [
  { code: "en", label: "English", short: "EN", locale: undefined as string | undefined },
  { code: "kn", label: "ಕನ್ನಡ", short: "ಕನ್ನಡ", locale: "kn-IN" },
  { code: "hi", label: "हिन्दी", short: "हिन्दी", locale: "hi-IN" },
] as const;
export type Lang = (typeof LANGS)[number]["code"];
const DICTS: Record<Lang, Record<string, string>> = { en: {}, kn, hi };
const STORAGE_KEY = "edibell.lang";

function readSaved(): Lang {
  try { const v = localStorage.getItem(STORAGE_KEY); if (v && v in DICTS) return v as Lang; } catch { /* storage unavailable */ }
  return "en";
}

let current: Lang = typeof window === "undefined" ? "en" : readSaved();
const listeners = new Set<(l: Lang) => void>();
const applyHtmlLang = (l: Lang) => { if (typeof document !== "undefined") document.documentElement.lang = l; };
applyHtmlLang(current);

export const getLang = (): Lang => current;
export const localeFor = (l: Lang = current) => LANGS.find(x => x.code === l)?.locale;

export function setLang(l: Lang) {
  if (!(l in DICTS) || l === current) return;
  current = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* private mode: still switches for this visit */ }
  applyHtmlLang(l);
  listeners.forEach(fn => fn(l));
}

type Vars = Record<string, string | number | null | undefined>;
const fill = (s: string, vars?: Vars) => vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m) as string) : s;

/** Translate English source text into the current language. */
export function tr(text: string, vars?: Vars): string {
  const d = DICTS[current];
  return fill(current === "en" ? text : d[text] ?? text, vars);
}

/** Translate a list of known values (species, allergens…) for display, comma-separated. */
export const trList = (values: readonly string[], sep = ", ") => values.map(v => tr(v)).join(sep);

/** Translate a system message that came from the server (errors, notifications). */
export function trServer(text: string): string {
  return current === "en" || !text ? text : translateServerText(text, current, DICTS[current]) ?? text;
}

/** Translate a sentence containing inline markup: <tag>…</tag> pieces are rendered by `tags[tag]`. */
export function trx(text: string, tags: Record<string, (chunk: string) => ReactNode>, vars?: Vars): ReactNode {
  const s = tr(text, vars);
  const out: ReactNode[] = [];
  const re = /<(\w+)\/>|<(\w+)>(.*?)<\/\2>/g;   // <br/>  or  <b>…</b>
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const name = m[1] ?? m[2], chunk = m[3] ?? "", render = tags[name];
    out.push(<Fragment key={i++}>{render ? render(chunk) : chunk}</Fragment>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return <>{out}</>;
}

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang });

/**
 * Holds the current language. It sits at the top of <App/>, so changing the
 * language re-renders the whole interface in place — form contents and the
 * current page are kept.
 */
export function LanguageProvider({ children }: { children: (lang: Lang) => ReactNode }) {
  const [lang, setState] = useState<Lang>(current);
  useEffect(() => { const fn = (l: Lang) => setState(l); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  const change = useCallback((l: Lang) => setLang(l), []);
  return <LangContext.Provider value={{ lang, setLang: change }}>{children(lang)}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);
