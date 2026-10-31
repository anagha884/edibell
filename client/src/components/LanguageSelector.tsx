import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { LANGS, tr, useLang, type Lang } from "@/i18n";

/** Compact globe + current language; opens a list of English / ಕನ್ನಡ / हिन्दी. */
export function LanguageSelector({ className = "", align = "right" }: { className?: string; align?: "left" | "right" }) {
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const current = LANGS.find(l => l.code === lang) ?? LANGS[0];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("touchstart", away);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); };
  }, [open]);
  useEffect(() => { if (open) items.current[focus]?.focus(); }, [open, focus]);

  const choose = (code: Lang) => { setLang(code); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".eb-lang-btn")?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".eb-lang-btn")?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (!open) { setOpen(true); setFocus(LANGS.findIndex(l => l.code === lang)); } else setFocus(i => (i + 1) % LANGS.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocus(i => (i - 1 + LANGS.length) % LANGS.length); }
  };

  return <div className={`eb-lang ${className}`} ref={root} onKeyDown={onKey}>
    <button type="button" className="eb-lang-btn" aria-haspopup="listbox" aria-expanded={open}
      aria-label={`${tr("Language")}: ${current.label}`} title={tr("Change language")}
      onClick={() => { setOpen(o => !o); setFocus(LANGS.findIndex(l => l.code === lang)); }}>
      <Globe size={15} aria-hidden="true"/><span className="eb-lang-current" lang={lang}>{current.short}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open && <ul className={`eb-lang-menu ${align}`} role="listbox" aria-label={tr("Choose language")}>
      {LANGS.map((l, i) => <li key={l.code} role="presentation">
        <button type="button" role="option" aria-selected={l.code === lang} lang={l.code} ref={el => { items.current[i] = el; }}
          className={l.code === lang ? "on" : ""} onClick={() => choose(l.code)}>
          <span>{l.label}</span>{l.code === lang && <Check size={14} aria-hidden="true"/>}
        </button>
      </li>)}
    </ul>}
  </div>;
}
