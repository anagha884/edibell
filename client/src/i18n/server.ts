/**
 * Translates system text produced by the database (error messages, pickup-scan
 * results and notification titles/bodies) when it is displayed. The database
 * keeps writing English; nothing stored is changed.
 *
 * Fixed messages are looked up directly in the language dictionary. Messages
 * that contain names, titles or quantities are matched by the patterns below:
 * the template (English, with {1}, {2}…) is translated through the dictionary,
 * and each captured part is either kept exactly as written (user content such
 * as food titles, organisation names, addresses, reasons) or translated as a
 * known value (statuses, units, species, field names).
 */
type Part = "raw" | "value" | "list" | "status";
type Pattern = { re: RegExp; key: string; parts?: Part[] };

const Q = String.raw`([\d.]+)`;          // quantity
const U = String.raw`(\S+(?: \/ \S+)?)`;  // unit (kg, litres, portions …)

const PATTERNS: Pattern[] = [
  // ---- field validation (field name is translated) ----
  { re: /^(.+) is too long\.$/, key: "{1} is too long.", parts: ["value"] },
  { re: /^(.+) is required\.$/, key: "{1} is required.", parts: ["value"] },
  { re: /^(.+) must be a number\.$/, key: "{1} must be a number.", parts: ["value"] },
  { re: /^(.+) must be at least ([\d.]+)\.$/, key: "{1} must be at least {2}.", parts: ["value", "raw"] },
  { re: /^(.+) must be at most ([\d.]+)\.$/, key: "{1} must be at most {2}.", parts: ["value", "raw"] },
  { re: /^(.+) is not a valid date\/time\.$/, key: "{1} is not a valid date/time.", parts: ["value"] },
  { re: /^(.+) is not valid\.$/, key: "{1} is not valid.", parts: ["value"] },
  { re: /^(.+) must be a list\.$/, key: "{1} must be a list.", parts: ["value"] },
  { re: /^(.+) contains an unknown option: (.+)$/, key: "{1} contains an unknown option: {2}", parts: ["value", "raw"] },
  { re: /^(.+) has too many entries\.$/, key: "{1} has too many entries.", parts: ["value"] },
  // ---- listings & requests ----
  { re: /^This listing is already (.+) and can't be edited\.$/, key: "This listing is already {1} and can't be edited.", parts: ["status"] },
  { re: /^This listing is already (.+)\.$/, key: "This listing is already {1}.", parts: ["status"] },
  { re: /^This listing is (.+), so the request can't be accepted\.$/, key: "This listing is {1}, so the request can't be accepted.", parts: ["status"] },
  { re: /^This listing is (.+)\.$/, key: "This listing is {1}.", parts: ["status"] },
  { re: new RegExp(`^Only ${Q} ${U} is still available\\.$`), key: "Only {1} {2} is still available.", parts: ["raw", "value"] },
  { re: new RegExp(`^Only ${Q} ${U} is left — decline this request or ask the organization to request less\\.$`), key: "Only {1} {2} is left — decline this request or ask the organization to request less.", parts: ["raw", "value"] },
  { re: /^The donor marked this food as suitable only for: (.+)\.$/, key: "The donor marked this food as suitable only for: {1}.", parts: ["list"] },
  { re: /^This request is already (.+)\.$/, key: "This request is already {1}.", parts: ["status"] },
  { re: /^A (.+) request can't be cancelled\.$/, key: "A {1} request can't be cancelled.", parts: ["status"] },
  { re: new RegExp(`^Pickup verified\\. ${Q} ${U} of (.+) handed to (.+)\\.$`), key: "Pickup verified. {1} {2} of {3} handed to {4}.", parts: ["raw", "value", "raw", "raw"] },
  // ---- notification bodies ----
  { re: /^Your request for "(.+)" expired before the pickup was completed\.$/, key: "Your request for \"{1}\" expired before the pickup was completed." },
  { re: /^An accepted pickup for "(.+)" was not collected in time\.$/, key: "An accepted pickup for \"{1}\" was not collected in time." },
  { re: /^"(.+)" reached its pickup or safe-use deadline and is no longer offered\.$/, key: "\"{1}\" reached its pickup or safe-use deadline and is no longer offered." },
  { re: /^"(.+)" must be used within the hour\. Do not hand it over after its safe-use deadline\.$/, key: "\"{1}\" must be used within the hour. Do not hand it over after its safe-use deadline." },
  { re: /^Collect "(.+)" during the pickup window\. Bring your Pickup Pass QR\.$/, key: "Collect \"{1}\" during the pickup window. Bring your Pickup Pass QR." },
  { re: /^An organization is due to collect "(.+)"\. Use Verify Pickup to scan their QR\.$/, key: "An organization is due to collect \"{1}\". Use Verify Pickup to scan their QR." },
  { re: /^"(.+)" will be shown to animal welfare organizations after an EDIBELL safety review\.$/, key: "\"{1}\" will be shown to animal welfare organizations after an EDIBELL safety review." },
  { re: /^"(.+)" is now visible to NGO partners\.$/, key: "\"{1}\" is now visible to NGO partners." },
  { re: /^"(.+)" is now visible to animal welfare organizations\.$/, key: "\"{1}\" is now visible to animal welfare organizations." },
  { re: /^The donor updated "(.+)"\. Check the details before pickup\.$/, key: "The donor updated \"{1}\". Check the details before pickup." },
  { re: /^"(.+)" is no longer available: (.+)\. Your pickup pass for it no longer works\.$/s, key: "\"{1}\" is no longer available: {2}. Your pickup pass for it no longer works." },
  { re: /^"(.+)" is no longer available\. Your pickup pass for it no longer works\.$/, key: "\"{1}\" is no longer available. Your pickup pass for it no longer works." },
  { re: new RegExp(`^(.+) requested ${Q} ${U} of "(.+)"\\.$`), key: "{1} requested {2} {3} of \"{4}\".", parts: ["raw", "raw", "value", "raw"] },
  { re: new RegExp(`^Your request for ${Q} ${U} of "(.+)" is waiting for the donor\\.$`), key: "Your request for {1} {2} of \"{3}\" is waiting for the donor.", parts: ["raw", "value", "raw"] },
  { re: /^"(.+)" — the donor couldn't fulfil this request\.$/, key: "\"{1}\" — the donor couldn't fulfil this request." },
  { re: new RegExp(`^Collect ${Q} ${U} of "(.+)" at (.+) during the pickup window and show your Pickup Pass QR\\.$`), key: "Collect {1} {2} of \"{3}\" at {4} during the pickup window and show your Pickup Pass QR.", parts: ["raw", "value", "raw", "raw"] },
  { re: /^(.+) cancelled their request for "(.+)"\. The reserved quantity is available again\.$/, key: "{1} cancelled their request for \"{2}\". The reserved quantity is available again." },
  { re: /^(.+) cancelled their request for "(.+)"\.$/, key: "{1} cancelled their request for \"{2}\"." },
  { re: new RegExp(`^${Q} ${U} of "(.+)" was handed over and verified by (.+)\\.$`), key: "{1} {2} of \"{3}\" was handed over and verified by {4}.", parts: ["raw", "value", "raw", "raw"] },
  { re: new RegExp(`^(.+) collected ${Q} ${U} of "(.+)"\\.$`), key: "{1} collected {2} {3} of \"{4}\".", parts: ["raw", "raw", "value", "raw"] },
  { re: /^(.+) needs feed for (.+)\.$/, key: "{1} needs feed for {2}.", parts: ["raw", "list"] },
  { re: /^"(.+)": it is now visible to animal welfare organizations\.$/, key: "\"{1}\": it is now visible to animal welfare organizations." },
  { re: /^"(.+)": it will not be offered as feed\.$/, key: "\"{1}\": it will not be offered as feed." },
  { re: new RegExp(`^(.+) · ${Q} ${U} in (.+)$`), key: "{1} · {2} {3} in {4}", parts: ["raw", "raw", "value", "raw"] },
  { re: /^"(.+)" from (.+)\.$/, key: "\"{1}\" from {2}." },
];

export function translateServerText(text: string, _lang: string, dict: Record<string, string>): string | null {
  const exact = dict[text];
  if (exact) return exact;
  const value = (v: string) => dict[v] ?? dict[v.replace(/-/g, " ")] ?? v;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const template = dict[p.key];
    if (!template) return null;
    return template.replace(/\{(\d)\}/g, (_, i) => {
      const raw = m[Number(i)] ?? "";
      const kind = p.parts?.[Number(i) - 1] ?? "raw";
      if (kind === "value" || kind === "status") return value(raw);
      if (kind === "list") return raw.split(", ").map(value).join(", ");
      return raw;
    });
  }
  return null;
}

/** Every English template above, so the dictionary check can require a translation for each. */
export const SERVER_TEMPLATES = PATTERNS.map(p => p.key);
