/**
 * Pickup-location maps, powered by Geoapify (free plan, no card required) on
 * OpenStreetMap data, drawn with Leaflet.
 *
 *  - Address search: Geoapify Address Autocomplete API (1 credit per request;
 *    requests are debounced and start at 3 characters).
 *  - Map + draggable pin: Leaflet with Geoapify raster tiles (0.25 credit per tile).
 *  - Pin → address: Geoapify Reverse Geocoding API.
 *  - Directions: a plain Google Maps link (free, no key).
 *
 * The browser key comes from VITE_GEOAPIFY_API_KEY. In the Geoapify dashboard,
 * restrict it to your website's origins (API key → "Allowed origins"). The free
 * plan requires the "Powered by Geoapify" credit, shown in the map corner.
 * Without a key the components say so plainly; they never pretend to work.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin, Navigation } from "lucide-react";

export interface PickupLocation {
  address: string;
  area: string;
  city: string;
  pincode: string;
  latitude: number;
  longitude: number;
  placeId: string;
}

export const MAPS_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY?.trim() ?? "";
export const MAPS_SETUP_MESSAGE = "Address search and the map are not configured. Set VITE_GEOAPIFY_API_KEY (a free key from geoapify.com) to search addresses and pick the location on a map. You can still type the address manually.";

const API = "https://api.geoapify.com/v1/geocode";
const ATTRIBUTION = 'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> | <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> contributors';
const INDIA: L.LatLngTuple = [20.5937, 78.9629];

/** Result shape of Geoapify's geocoding APIs with `format=json`. */
interface GeoResult {
  formatted?: string; address_line1?: string; address_line2?: string; name?: string;
  lat: number; lon: number; place_id?: string;
  suburb?: string; district?: string; neighbourhood?: string; quarter?: string;
  city?: string; town?: string; village?: string; county?: string; state_district?: string; postcode?: string;
}

function toLocation(r: GeoResult): PickupLocation {
  return {
    address: r.formatted ?? [r.address_line1, r.address_line2].filter(Boolean).join(", "),
    area: r.suburb || r.district || r.neighbourhood || r.quarter || "",
    city: r.city || r.town || r.village || r.state_district || r.county || "",
    pincode: r.postcode ?? "",
    latitude: Math.round(r.lat * 1e6) / 1e6,
    longitude: Math.round(r.lon * 1e6) / 1e6,
    placeId: (r.place_id ?? "").slice(0, 300),
  };
}

async function geoapify(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<GeoResult[]> {
  const qs = new URLSearchParams({ ...params, format: "json", lang: "en", apiKey: MAPS_KEY });
  const res = await fetch(`${API}/${path}?${qs.toString()}`, { signal });
  if (res.status === 401 || res.status === 403) throw new Error("The Geoapify key was rejected. Check VITE_GEOAPIFY_API_KEY and the key's allowed origins in the Geoapify dashboard.");
  if (res.status === 429) throw new Error("Today's free address-search limit has been reached. Type the address manually for now; search works again tomorrow.");
  if (!res.ok) throw new Error("Address search is unavailable right now. Type the address manually or try again.");
  const body = await res.json() as { results?: GeoResult[] };
  return (body.results ?? []).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

function tileLayer(): L.TileLayer {
  const file = L.Browser.retina ? "{z}/{x}/{y}@2x.png" : "{z}/{x}/{y}.png";
  return L.tileLayer(`https://maps.geoapify.com/v1/tile/osm-bright/${file}?apiKey={apiKey}`, { apiKey: MAPS_KEY, maxZoom: 20, attribution: ATTRIBUTION } as L.TileLayerOptions);
}

const pinIcon = L.divIcon({
  className: "eb-map-pin",
  html: '<svg width="28" height="38" viewBox="0 0 28 38" aria-hidden="true"><path d="M14 1C7 1 1.5 6.5 1.5 13.4 1.5 23 14 37 14 37s12.5-14 12.5-23.6C26.5 6.5 21 1 14 1z" fill="#075b45" stroke="#fff" stroke-width="2"/><circle cx="14" cy="13.5" r="4.6" fill="#fff"/></svg>',
  iconSize: [28, 38], iconAnchor: [14, 37],
});

function newMap(el: HTMLElement, interactive: boolean): L.Map {
  const map = L.map(el, {
    zoomControl: interactive, dragging: interactive, scrollWheelZoom: false, doubleClickZoom: interactive,
    boxZoom: interactive, keyboard: interactive, touchZoom: interactive, attributionControl: true,
  });
  map.attributionControl.setPrefix(false);
  tileLayer().addTo(map);
  return map;
}

/** Google Maps directions link for a pickup point (no API key needed). */
export function directionsUrl(lat: number | null | undefined, lng: number | null | undefined, address?: string): string {
  const dest = lat != null && lng != null ? `${lat},${lng}` : address ?? "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

export function DirectionsLink({ lat, lng, address, label = "Open directions in Google Maps" }: { lat?: number | null; lng?: number | null; address?: string; label?: string }) {
  if (lat == null && !address) return null;
  return <a className="eb-directions" href={directionsUrl(lat, lng, address)} target="_blank" rel="noreferrer"><Navigation size={12}/> {label}</a>;
}

export function PickupLocationPicker({ onSelect, initial }: { onSelect: (location: PickupLocation) => void; initial?: { latitude: number | null; longitude: number | null } }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<L.Map | null>(null);
  const markerObj = useRef<L.Marker | null>(null);
  const onSelectRef = useRef(onSelect);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(MAPS_KEY ? "" : MAPS_SETUP_MESSAGE);
  onSelectRef.current = onSelect;

  const place = (r: GeoResult, pan = true) => {
    const map = mapObj.current; const marker = markerObj.current;
    if (map && marker) {
      marker.setLatLng([r.lat, r.lon]);
      if (!map.hasLayer(marker)) marker.addTo(map);
      if (pan) map.setView([r.lat, r.lon], 17);
    }
    onSelectRef.current(toLocation(r));
  };

  const reverse = async (lat: number, lon: number) => {
    markerObj.current?.setLatLng([lat, lon]);
    try {
      const [best] = await geoapify("reverse", { lat: String(lat), lon: String(lon) });
      if (best) { setError(""); place({ ...best, lat, lon }, false); }
      else setError("No address was found for that map pin. Try a nearby point or search for the address.");
    } catch (e) { setError(e instanceof Error ? e.message : "The address for that pin could not be looked up."); }
  };
  const reverseRef = useRef(reverse);
  reverseRef.current = reverse;

  useEffect(() => {
    if (!MAPS_KEY || !mapRef.current) return;
    const start: L.LatLngTuple | null = initial?.latitude != null && initial?.longitude != null ? [initial.latitude, initial.longitude] : null;
    const map = newMap(mapRef.current, true).setView(start ?? INDIA, start ? 17 : 5);
    const marker = L.marker(start ?? INDIA, { icon: pinIcon, draggable: true, keyboard: true, title: "Pickup point" });
    if (start) marker.addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => { if (!map.hasLayer(marker)) marker.addTo(map); void reverseRef.current(e.latlng.lat, e.latlng.lng); });
    marker.on("dragend", () => { const p = marker.getLatLng(); void reverseRef.current(p.lat, p.lng); });
    mapObj.current = map; markerObj.current = marker;
    const t = window.setTimeout(() => map.invalidateSize(), 50);
    return () => { window.clearTimeout(t); map.remove(); mapObj.current = null; markerObj.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!MAPS_KEY) return;
    const text = query.trim();
    abortRef.current?.abort();
    if (text.length < 3) { setResults([]); setSearching(false); return; }
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const t = window.setTimeout(async () => {
      setSearching(true);
      try {
        const params: Record<string, string> = { text, filter: "countrycode:in", limit: "6" };
        const c = mapObj.current?.getCenter();
        if (c && mapObj.current!.getZoom() > 8) params.bias = `proximity:${c.lng},${c.lat}`;
        const found = await geoapify("autocomplete", params, ctrl.signal);
        setResults(found); setActive(-1); setOpen(true); setError("");
      } catch (e) {
        if ((e as Error).name !== "AbortError") { setResults([]); setError(e instanceof Error ? e.message : "Address search failed."); }
      } finally { if (!ctrl.signal.aborted) setSearching(false); }
    }, 300);
    return () => { window.clearTimeout(t); ctrl.abort(); };
  }, [query]);

  const choose = (r: GeoResult) => { setQuery(r.formatted ?? ""); setOpen(false); setResults([]); setError(""); place(r); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => (i + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => (i <= 0 ? results.length - 1 : i - 1)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return <div className="eb-map-picker">
    {MAPS_KEY && <label className="form-field eb-place-search"><span>Search pickup address</span>
      <input type="search" role="combobox" aria-expanded={open && results.length > 0} aria-controls="eb-place-results" aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `eb-place-${active}` : undefined} autoComplete="off" placeholder="Start typing the pickup address"
        value={query} onChange={e => { setQuery(e.target.value); setOpen(true); }} onKeyDown={onKey}
        onFocus={() => results.length && setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)}/>
      {open && query.trim().length >= 3 && !searching && results.length === 0 && !error && <small className="eb-hint">No matching address. Try a landmark or area name, or click the map.</small>}
      {open && results.length > 0 && <ul id="eb-place-results" role="listbox" className="eb-place-results">
        {results.map((r, i) => <li key={`${r.place_id ?? i}`} id={`eb-place-${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : ""}
          onMouseDown={e => { e.preventDefault(); choose(r); }}>
          <MapPin size={12}/><span><b>{r.address_line1 ?? r.name ?? r.formatted}</b>{r.address_line2 && <small>{r.address_line2}</small>}</span>
        </li>)}
      </ul>}
    </label>}
    {searching && <small className="eb-hint">Searching…</small>}
    {error && <p className="eb-error" role="alert">{error}</p>}
    {MAPS_KEY && <div ref={mapRef} className="eb-map-canvas" aria-label="Pickup location map. Click or drag the pin to adjust."/>}
    {MAPS_KEY && <small className="eb-hint">Pick a suggestion, then click the map or drag the pin to the exact pickup point.</small>}
  </div>;
}

/** Read-only map preview of a saved location (falls back to coordinates + link without a key). */
export function LocationPreview({ lat, lng, address }: { lat: number | null; lng: number | null; address: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!MAPS_KEY || lat == null || lng == null || !ref.current) return;
    const map = newMap(ref.current, false).setView([lat, lng], 16);
    L.marker([lat, lng], { icon: pinIcon, keyboard: false, interactive: false }).addTo(map);
    const t = window.setTimeout(() => map.invalidateSize(), 50);
    return () => { window.clearTimeout(t); map.remove(); };
  }, [lat, lng]);
  return <div className="eb-location-preview">
    <p><MapPin size={13}/> {address || "No address"}</p>
    {lat != null && lng != null
      ? <>{MAPS_KEY ? <div ref={ref} className="eb-map-canvas small" aria-label="Pickup location preview"/> : <small className="eb-hint">Pin saved at {lat.toFixed(5)}, {lng.toFixed(5)}.</small>}
        <DirectionsLink lat={lat} lng={lng} label="Check this point in Google Maps"/></>
      : <small className="eb-warn-text">No map pin selected. Recipients will get directions from the address text only.</small>}
  </div>;
}
