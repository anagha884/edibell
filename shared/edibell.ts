/**
 * EDIBELL shared contract: constants and data shapes used by the React client.
 * The same lists and rules are enforced in the database (supabase/migrations,
 * schema `app`). Keep both in sync. Keep this file free of imports.
 */

export type Role = "donor" | "ngo" | "animal";
export type Destination = "human" | "animal";

export const ROLE_LABEL: Record<Role, string> = {
  donor: "Food Donor",
  ngo: "NGO Partner",
  animal: "Animal Welfare Organization",
};

export const ROLE_HOME: Record<Role, string> = {
  donor: "/donor",
  ngo: "/ngo",
  animal: "/animal",
};

/** Which recipient role may receive which kind of donation. */
export const ROLE_DESTINATION: Record<Exclude<Role, "donor">, Destination> = {
  ngo: "human",
  animal: "animal",
};

export const DONOR_TYPES = [
  "College / University Mess",
  "Hotel",
  "Restaurant",
  "Function Hall",
  "Caterer",
  "Bakery",
  "Supermarket",
  "Corporate Cafeteria",
  "Household / Individual",
  "Other",
] as const;

export const NGO_TYPES = [
  "Community Kitchen",
  "Shelter",
  "Orphanage",
  "Old-Age Home",
  "Food Bank",
  "Other",
] as const;

export const ANIMAL_ORG_TYPES = [
  "Animal Shelter",
  "Gaushala",
  "Rescue / Rehabilitation Centre",
  "Street-Animal Feeding Group",
  "Sanctuary",
  "Other",
] as const;

export const HUMAN_CATEGORIES = [
  "Cooked meals",
  "Rice & grains",
  "Curries & dals",
  "Breads & bakery",
  "Fruits",
  "Vegetables",
  "Dairy",
  "Snacks & packaged food",
  "Sweets & desserts",
  "Beverages",
  "Other",
] as const;

export const ANIMAL_CATEGORIES = [
  "Cooked rice / grains",
  "Cooked vegetables",
  "Raw vegetable trimmings",
  "Fruit & peels",
  "Bread & bakery leftovers",
  "Dairy",
  "Cooked meat / fish scraps (unseasoned)",
  "Grains & pulses (raw)",
  "Fodder & greens",
  "Other",
] as const;

export const ANIMAL_SPECIES = [
  "Dogs",
  "Cats",
  "Cattle / Cows",
  "Goats & sheep",
  "Horses & donkeys",
  "Birds & poultry",
  "Monkeys",
  "Pigs",
  "Fish",
  "Other",
] as const;

export const UNITS = ["kg", "g", "litres", "ml", "portions", "pieces", "packets", "trays"] as const;
export type Unit = (typeof UNITS)[number];

export const FOOD_STATES = ["hot", "cold", "room-temperature", "frozen", "not-applicable"] as const;
export type FoodState = (typeof FOOD_STATES)[number];
export const FOOD_STATE_LABEL: Record<FoodState, string> = {
  hot: "Hot",
  cold: "Cold / refrigerated",
  "room-temperature": "Room temperature",
  frozen: "Frozen",
  "not-applicable": "Not applicable (raw / dry)",
};

export const FOOD_ORIGINS = ["untouched-surplus", "cooked-not-served", "plate-leftover"] as const;
export type FoodOrigin = (typeof FOOD_ORIGINS)[number];
export const FOOD_ORIGIN_LABEL: Record<FoodOrigin, string> = {
  "untouched-surplus": "Untouched surplus (never served)",
  "cooked-not-served": "Cooked but not served / still in service containers",
  "plate-leftover": "Leftover from plates / returned food",
};

export const PACKAGING = [
  "Sealed food-grade containers",
  "Covered trays / vessels",
  "Original sealed packaging",
  "Bags / loose",
  "Not packed yet",
] as const;

export const STORAGE_OPTIONS = [
  "Kept hot (above 60°C)",
  "Refrigerated (below 5°C)",
  "Room temperature, dry place",
  "Frozen",
] as const;

export const ALLERGENS = [
  "Gluten / wheat",
  "Peanuts",
  "Tree nuts",
  "Milk / dairy",
  "Eggs",
  "Soy",
  "Fish",
  "Shellfish",
  "Sesame",
  "Mustard",
] as const;

export const DIET_TYPES = ["vegetarian", "non-vegetarian", "vegan", "contains-egg"] as const;
export type DietType = (typeof DIET_TYPES)[number];

/** Request lifecycle shown to every party. */
export const REQUEST_STATUSES = ["pending", "accepted", "declined", "cancelled", "completed", "expired"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type DonationStatus = "active" | "completed" | "cancelled" | "expired";
/** Computed for display: what a requester can do with the listing right now. */
export type Availability = "available" | "fully-reserved" | "completed" | "cancelled" | "expired" | "under-review" | "rejected";
export type ReviewStatus = "approved" | "pending_review" | "rejected";
export type VerificationStatus = "pending" | "verified" | "rejected";

export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  pending: "Verification pending",
  verified: "Verified by EDIBELL",
  rejected: "Verification not approved",
};

/** Human-food safety checklist. Every item must be confirmed (enforced in the database). */
export const HUMAN_SAFETY_CHECKS = [
  { key: "hygienic", label: "Prepared and handled hygienically by food-safe staff." },
  { key: "temperatureControlled", label: "Kept hot (above 60°C), chilled (below 5°C) or otherwise at a safe temperature since preparation." },
  { key: "notServed", label: "Never served to, or returned by, customers (no plate leftovers)." },
  { key: "notSpoiled", label: "No signs of spoilage, contamination or pests; safe for people to eat now." },
] as const;

/** Animal-feed screening. Every item must be confirmed (enforced in the database). */
export const ANIMAL_SAFETY_CHECKS = [
  { key: "notSpoiled", label: "Not spoiled, mouldy, fermented or contaminated, and of known condition." },
  { key: "noToxicItems", label: "Contains no chocolate, caffeine, alcohol, xylitol (sugar-free sweets), grapes/raisins or avocado." },
  { key: "noCookedBones", label: "Contains no cooked bones, skewers, packaging or other foreign objects." },
  { key: "lowSaltSpice", label: "Not heavily salted, spiced, sugary or oily." },
] as const;
export const ANIMAL_ONION_CHECK = { key: "noOnionGarlic", label: "Contains no onion or garlic (required when dogs or cats are listed)." } as const;

export const ORG_DOCUMENT_TYPES = [
  { value: "registration-certificate", label: "Registration certificate" },
  { value: "fssai-licence", label: "FSSAI licence" },
  { value: "trust-deed", label: "Trust deed / society registration" },
  { value: "animal-welfare-registration", label: "Animal welfare board registration" },
  { value: "id-proof", label: "Authorized contact ID proof" },
  { value: "other", label: "Other supporting document" },
] as const;

export type QrState = "valid" | "used" | "expired" | "cancelled";

// ---------------------------------------------------------------------------
// Impact assumptions. These are explicit, documented ESTIMATES (shown in the UI).
// The database function my_impact() uses the same factors.
// ---------------------------------------------------------------------------
/** Approx. cooked-food weight of one meal. Used only to estimate meals supported. */
export const KG_PER_MEAL = 0.4;
/** Approx. kg CO2-equivalent avoided per kg of edible food kept out of landfill. */
export const KG_CO2E_PER_KG_FOOD = 2.5;
/** Rough weight of countable units, used only for kg-equivalent totals. */
export const UNIT_TO_KG: Record<Unit, number> = {
  kg: 1,
  g: 0.001,
  litres: 1,
  ml: 0.001,
  portions: KG_PER_MEAL,
  pieces: 0.1,
  packets: 0.25,
  trays: 3,
};
export const IMPACT_ASSUMPTIONS = [
  `Quantities are converted to kg-equivalent (1 portion ≈ ${KG_PER_MEAL} kg, 1 piece ≈ 0.1 kg, 1 packet ≈ 0.25 kg, 1 tray ≈ 3 kg, 1 litre ≈ 1 kg).`,
  `Meals supported = kg-equivalent of completed HUMAN-food pickups ÷ ${KG_PER_MEAL} kg per meal.`,
  `CO₂e avoided ≈ ${KG_CO2E_PER_KG_FOOD} kg CO₂e per kg of food kept out of landfill (rule-of-thumb estimate).`,
];

export function toKg(quantity: number, unit: Unit): number {
  return quantity * (UNIT_TO_KG[unit] ?? 1);
}

// ---------------------------------------------------------------------------
// QR payload
// ---------------------------------------------------------------------------
export const QR_PREFIX = "EDIBELL:PICKUP:v1:";

/** Extract the opaque pickup code from scanned text or manual entry. */
export function parsePickupCode(raw: string): string | null {
  let text = (raw || "").trim().toUpperCase();
  if (text.startsWith(QR_PREFIX.toUpperCase())) text = text.slice(QR_PREFIX.length);
  text = text.replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(text) ? text : null;
}

export function formatPickupCode(code: string): string {
  return code.match(/.{1,5}/g)?.join("-") ?? code;
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------
export interface UserDTO {
  id: string;
  role: Role;
  email: string;
  contactName: string;
  orgName: string;
  orgType: string;
  phone: string;
  address: string;
  area: string;
  city: string;
  pincode: string;
  capacity: number | null;
  species: string[];
  registrationNo: string;
  about: string;
  serviceArea: string;
  careRequirements: string;
  latitude: number | null;
  longitude: number | null;
  verificationStatus: VerificationStatus;
  verificationNote: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  type: string;
  role: Role;
  capacity: number | null;
  species: string[];
  area: string;
  city: string;
  about: string;
  verificationStatus: VerificationStatus;
  careRequirements?: string;
  /** Only present once a request is accepted/completed. */
  phone?: string;
  address?: string;
  contactName?: string;
}

export interface DonationDTO {
  id: string;
  destination: Destination;
  eligibleForHumans: boolean;
  eligibleForAnimals: boolean;
  reviewStatus: ReviewStatus;
  reviewNote: string;
  /** Storage paths of the photos (the `photos` field holds their public URLs). */
  photoPaths: string[];
  restrictions: string;
  safetyChecklist: Record<string, boolean>;
  updatedAt: string;
  cancelReason: string;
  placeId?: string;
  pickupContactName?: string;
  pickupContactPhone?: string;
  acceptedRequests?: number;
  title: string;
  category: string;
  description: string;
  quantity: number;
  unit: Unit;
  remaining: number;
  reserved: number;
  collected: number;
  photos: string[];
  ingredients: string;
  allergens: string[];
  allergenNotes: string;
  dietType: DietType | null;
  foodOrigin: FoodOrigin;
  preparedAt: string;
  foodState: FoodState;
  packaging: string;
  storage: string;
  handlingNotes: string;
  expiryAt: string;
  readyAt: string;
  pickupStart: string;
  pickupEnd: string;
  area: string;
  city: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
  /** Full street address — hidden from requesters until their request is accepted. */
  address?: string;
  animalSpecies: string[];
  animalSafetyConfirmed: boolean;
  status: DonationStatus;
  availability: Availability;
  createdAt: string;
  donor: OrgSummary;
  distanceKm?: number | null;
  /** The signed-in requester's own request on this listing, if any. */
  myRequest?: { id: string; status: RequestStatus } | null;
  pendingRequests?: number;
}

export interface RequestDTO {
  id: string;
  donationId: string;
  status: RequestStatus;
  quantity: number;
  unit: Unit;
  message: string;
  collectionNote: string;
  beneficiaries: number | null;
  animalSpecies: string[];
  animalCount: number | null;
  declineReason: string;
  createdAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  qrState: QrState | null;
  qrExpiresAt: string | null;
  donation: Pick<
    DonationDTO,
    | "id" | "title" | "category" | "destination" | "photos" | "pickupStart" | "pickupEnd" | "area" | "city"
    | "address" | "unit" | "quantity" | "foodState" | "allergens" | "expiryAt" | "animalSpecies" | "status"
    | "latitude" | "longitude" | "pickupContactName" | "pickupContactPhone"
  >;
  requester: OrgSummary;
  donor: OrgSummary;
}

export interface QrDTO {
  requestId: string;
  state: QrState;
  /** Opaque 20-char pickup code. Never contains personal data. */
  code: string | null;
  payload: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  request: RequestDTO;
}

export type ScanFailure = "invalid" | "expired" | "used" | "cancelled" | "mismatched" | "not-accepted" | "rate-limited";

export interface ScanResult {
  ok: boolean;
  failure?: ScanFailure;
  message: string;
  request?: RequestDTO;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export interface ImpactDTO {
  totalDonations: number;
  completedDonations: number;
  totalFoodKg: number;
  completedFoodKg: number;
  humanFoodKg: number;
  animalFeedKg: number;
  mealsSupported: number;
  co2eAvoidedKg: number;
  completedPickups: number;
  pendingRequests: number;
  acceptedRequests: number;
  activeListings: number;
  byCategory: { category: string; kg: number }[];
  byMonth: { month: string; kg: number }[];
  bySpecies: { species: string; kg: number }[];
  byPartner: { name: string; kg: number; pickups: number }[];
  assumptions: string[];
}

export interface AnimalNeedDTO {
  id: string;
  orgId: string;
  org: OrgSummary;
  title: string;
  species: string[];
  animalCount: number;
  categories: string[];
  quantityPerWeek: number;
  unit: Unit;
  notes: string;
  status: "open" | "closed";
  createdAt: string;
}

export interface PublicStats {
  donors: number;
  ngos: number;
  animalOrgs: number;
  completedPickups: number;
  foodRescuedKg: number;
  humanFoodKg: number;
  animalFeedKg: number;
}

export interface OrgDocumentDTO { id: string; docType: string; path: string; fileName: string; createdAt: string }

export interface AdminOverviewDTO {
  pendingOrganizations: (UserDTO & { documents: OrgDocumentDTO[] })[];
  reviewQueue: DonationDTO[];
  totals: { organizations: number; verified: number; activeListings: number; completedPickups: number; humanFoodKg: number; animalFeedKg: number };
}
