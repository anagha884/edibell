/**
 * Remembers, inside each browser-history entry, how deep into the app it is
 * and which in-app page came before it. This lets the back arrow use the real
 * browser history when there is an in-app page to return to, and a sensible
 * fallback when a page was opened directly (new tab, bookmark, shared link).
 *
 * It only adds an `__eb` field to history.state; navigation itself is still
 * done by wouter and the browser, so the browser's own Back/Forward keep working.
 */
type NavMeta = { i: number; prev: string | null };
const KEY = "__eb";

const here = () => window.location.pathname + window.location.search;
const metaOf = (state: unknown): NavMeta | null => {
  const m = state && typeof state === "object" ? (state as Record<string, unknown>)[KEY] : null;
  return m && typeof m === "object" && typeof (m as NavMeta).i === "number" ? (m as NavMeta) : null;
};
const withMeta = (state: unknown, meta: NavMeta) => ({ ...(state && typeof state === "object" ? state as object : {}), [KEY]: meta });

let installed = false;
export function installNavHistory() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const push = history.pushState.bind(history), replace = history.replaceState.bind(history);
  if (!metaOf(history.state)) replace(withMeta(history.state, { i: 0, prev: null }), "");
  history.pushState = function (state: unknown, title: string, url?: string | URL | null) {
    const cur = metaOf(history.state) ?? { i: 0, prev: null };
    return push(withMeta(state, { i: cur.i + 1, prev: here() }), title, url);
  };
  history.replaceState = function (state: unknown, title: string, url?: string | URL | null) {
    const cur = metaOf(history.state) ?? { i: 0, prev: null };
    return replace(withMeta(state, cur), title, url);
  };
}

/** Depth of the current entry in this tab's in-app history, and the page before it. */
export function currentNav(): NavMeta {
  return metaOf(typeof history !== "undefined" ? history.state : null) ?? { i: 0, prev: null };
}
