-- =============================================================================
-- EDIBELL food rescue — core schema
--
-- Design notes
--  * Every table has Row Level Security enabled. Browser clients (anon /
--    authenticated roles) may only SELECT rows they own; every state change
--    goes through the SECURITY DEFINER functions in the next migration, which
--    validate input, enforce role rules and run atomically with row locks.
--  * Internal helpers live in the private schema `app`, which is not exposed
--    through the Supabase Data API.
--  * Human-food eligibility and animal-feed eligibility are separate,
--    explicit columns. Food is never re-routed from one pathway to the other.
--  * Impact is computed only from `pickup_completions`, a row of which can be
--    created exclusively by a successful, server-verified QR scan.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
-- (anon/authenticated never get USAGE on schema app)

-- -----------------------------------------------------------------------------
-- Configuration (one row). Operators change it with SQL; clients cannot.
-- -----------------------------------------------------------------------------
create table public.app_config (
  id boolean primary key default true check (id),
  -- When true, NGOs / animal welfare organizations must be verified by an
  -- EDIBELL administrator before they can request food.
  require_verified_recipients boolean not null default false,
  -- When true, donors must be verified before they can publish listings.
  require_verified_donors boolean not null default false,
  -- How long a pickup QR stays valid after the listing's pickup window ends.
  qr_grace_minutes integer not null default 30 check (qr_grace_minutes between 0 and 1440),
  updated_at timestamptz not null default now()
);
insert into public.app_config (id) values (true);

-- -----------------------------------------------------------------------------
-- Organization profiles (one per auth user)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('donor', 'ngo', 'animal')),
  email text not null,
  contact_name text not null check (char_length(contact_name) between 1 and 120),
  org_name text not null check (char_length(org_name) between 1 and 160),
  org_type text not null default '' check (char_length(org_type) <= 80),
  phone text not null default '' check (char_length(phone) <= 40),
  address text not null default '' check (char_length(address) <= 300),
  area text not null default '' check (char_length(area) <= 100),
  city text not null check (char_length(city) between 1 and 100),
  pincode text not null default '' check (char_length(pincode) <= 12),
  service_area text not null default '' check (char_length(service_area) <= 300),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  capacity integer check (capacity between 0 and 1000000),
  species text[] not null default '{}',
  care_requirements text not null default '' check (char_length(care_requirements) <= 1500),
  registration_no text not null default '' check (char_length(registration_no) <= 80),
  about text not null default '' check (char_length(about) <= 600),
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected')),
  verification_note text not null default '' check (char_length(verification_note) <= 400),
  verified_at timestamptz,
  verified_by uuid references auth.users (id),
  -- Granted only by an operator with SQL (see README). Never via sign-up.
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint species_only_for_animal_orgs check (role = 'animal' or cardinality(species) = 0)
);
create index profiles_role_idx on public.profiles (role);
create index profiles_city_idx on public.profiles (lower(city));

-- Verification documents uploaded by an organization (files live in the
-- private `org-documents` storage bucket).
create table public.org_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.profiles (id) on delete cascade,
  doc_type text not null check (doc_type in ('registration-certificate', 'fssai-licence', 'trust-deed', 'animal-welfare-registration', 'id-proof', 'other')),
  storage_path text not null unique,
  file_name text not null default '' check (char_length(file_name) <= 200),
  created_at timestamptz not null default now()
);
create index org_documents_org_idx on public.org_documents (org_id);

-- -----------------------------------------------------------------------------
-- Food listings
-- -----------------------------------------------------------------------------
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  donor_id uuid not null references public.profiles (id) on delete cascade,
  destination text not null check (destination in ('human', 'animal')),
  -- Explicit, independent eligibility flags (see constraint below).
  eligible_for_humans boolean not null,
  eligible_for_animals boolean not null,
  review_status text not null default 'approved'
    check (review_status in ('approved', 'pending_review', 'rejected')),
  review_note text not null default '' check (char_length(review_note) <= 400),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id),

  title text not null check (char_length(title) between 1 and 120),
  category text not null,
  description text not null default '' check (char_length(description) <= 1500),
  quantity numeric(12, 3) not null check (quantity > 0 and quantity <= 100000),
  unit text not null check (unit in ('kg', 'g', 'litres', 'ml', 'portions', 'pieces', 'packets', 'trays')),
  reserved numeric(12, 3) not null default 0 check (reserved >= 0),
  collected numeric(12, 3) not null default 0 check (collected >= 0),

  ingredients text not null default '' check (char_length(ingredients) <= 1000),
  allergens text[] not null default '{}',
  allergen_notes text not null default '' check (char_length(allergen_notes) <= 400),
  diet_type text check (diet_type in ('vegetarian', 'non-vegetarian', 'vegan', 'contains-egg')),
  food_origin text not null check (food_origin in ('untouched-surplus', 'cooked-not-served', 'plate-leftover')),
  prepared_at timestamptz not null,
  food_state text not null check (food_state in ('hot', 'cold', 'room-temperature', 'frozen', 'not-applicable')),
  packaging text not null check (char_length(packaging) between 1 and 120),
  storage text not null check (char_length(storage) between 1 and 160),
  handling_notes text not null default '' check (char_length(handling_notes) <= 600),
  restrictions text not null default '' check (char_length(restrictions) <= 600),
  safety_checklist jsonb not null default '{}'::jsonb,

  expiry_at timestamptz not null,
  ready_at timestamptz not null,
  pickup_start timestamptz not null,
  pickup_end timestamptz not null,

  address text not null check (char_length(address) between 1 and 300),
  area text not null check (char_length(area) between 1 and 100),
  city text not null check (char_length(city) between 1 and 100),
  pincode text not null default '' check (char_length(pincode) <= 12),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  place_id text not null default '' check (char_length(place_id) <= 300),
  pickup_contact_name text not null default '' check (char_length(pickup_contact_name) <= 120),
  pickup_contact_phone text not null default '' check (char_length(pickup_contact_phone) <= 40),

  animal_species text[] not null default '{}',
  animal_safety_confirmed boolean not null default false,
  human_safety_confirmed boolean not null default false,

  status text not null default 'active' check (status in ('active', 'completed', 'cancelled', 'expired')),
  cancel_reason text not null default '' check (char_length(cancel_reason) <= 300),
  expiry_alert_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stock_not_overallocated check (reserved + collected <= quantity),
  constraint pickup_window_valid check (pickup_end > pickup_start),
  constraint coordinates_together check ((latitude is null) = (longitude is null)),
  -- Human food and animal feed are separate pathways. A listing is eligible for
  -- exactly the pathway the donor declared and screened it for.
  constraint eligibility_matches_destination check (
    (destination = 'human' and eligible_for_humans and not eligible_for_animals
       and human_safety_confirmed and diet_type is not null and food_origin <> 'plate-leftover')
    or
    (destination = 'animal' and eligible_for_animals and not eligible_for_humans
       and animal_safety_confirmed and cardinality(animal_species) > 0)
  )
);
create index listings_donor_idx on public.listings (donor_id, created_at desc);
create index listings_market_idx on public.listings (destination, status, review_status, pickup_start);
create index listings_city_idx on public.listings (lower(city));

create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  storage_path text not null unique,
  position smallint not null default 0 check (position between 0 and 9),
  created_at timestamptz not null default now()
);
create index listing_photos_listing_idx on public.listing_photos (listing_id, position);

-- -----------------------------------------------------------------------------
-- Requests, pickup credentials and completions
-- -----------------------------------------------------------------------------
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  donor_id uuid not null references public.profiles (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  requester_role text not null check (requester_role in ('ngo', 'animal')),
  quantity numeric(12, 3) not null check (quantity > 0),
  message text not null default '' check (char_length(message) <= 600),
  collection_note text not null default '' check (char_length(collection_note) <= 300),
  beneficiaries integer check (beneficiaries between 0 and 1000000),
  animal_species text[] not null default '{}',
  animal_count integer check (animal_count between 0 and 1000000),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'completed', 'expired')),
  decline_reason text not null default '' check (char_length(decline_reason) <= 300),
  cancelled_by uuid references public.profiles (id),
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  completed_at timestamptz,
  constraint requester_is_not_donor check (requester_id <> donor_id)
);
-- One live request per organization per listing.
create unique index requests_one_active_per_org on public.requests (listing_id, requester_id)
  where status in ('pending', 'accepted');
create index requests_donor_idx on public.requests (donor_id, created_at desc);
create index requests_requester_idx on public.requests (requester_id, created_at desc);
create index requests_listing_idx on public.requests (listing_id, status);

-- Single-use pickup credential. No RLS policy exists for this table, so it can
-- only be read or written by the SECURITY DEFINER functions.
create table public.pickup_tokens (
  request_id uuid primary key references public.requests (id) on delete cascade,
  token text not null unique check (token ~ '^[0-9A-HJKMNP-TV-Z]{20}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.profiles (id)
);

-- Exactly one completion per request (unique), written only by verify_pickup().
create table public.pickup_completions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.requests (id) on delete cascade,
  listing_id uuid not null references public.listings (id) on delete cascade,
  donor_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  recipient_role text not null check (recipient_role in ('ngo', 'animal')),
  destination text not null check (destination in ('human', 'animal')),
  quantity numeric(12, 3) not null check (quantity > 0),
  unit text not null,
  kg_equivalent numeric(14, 3) not null check (kg_equivalent >= 0),
  category text not null,
  animal_species text[] not null default '{}',
  verified_by uuid not null references public.profiles (id),
  completed_at timestamptz not null default now()
);
create index completions_donor_idx on public.pickup_completions (donor_id, completed_at);
create index completions_recipient_idx on public.pickup_completions (recipient_id, completed_at);

-- Every scan attempt (for rate limiting and audit). No client access.
create table public.scan_attempts (
  id bigint generated always as identity primary key,
  donor_id uuid not null references public.profiles (id) on delete cascade,
  ok boolean not null,
  failure text,
  request_id uuid references public.requests (id) on delete set null,
  created_at timestamptz not null default now()
);
create index scan_attempts_donor_idx on public.scan_attempts (donor_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Notifications (persistent, per user; also published over Realtime)
-- -----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Animal feed needs posted by animal welfare organizations
-- -----------------------------------------------------------------------------
create table public.animal_needs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  species text[] not null check (cardinality(species) > 0),
  animal_count integer not null check (animal_count between 1 and 1000000),
  categories text[] not null default '{}',
  quantity_per_week numeric(12, 3) not null check (quantity_per_week > 0),
  unit text not null check (unit in ('kg', 'g', 'litres', 'ml', 'portions', 'pieces', 'packets', 'trays')),
  notes text not null default '' check (char_length(notes) <= 600),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);
create index animal_needs_org_idx on public.animal_needs (org_id, created_at desc);
create index animal_needs_open_idx on public.animal_needs (status, created_at desc);

-- -----------------------------------------------------------------------------
-- Row Level Security: read-own only; all writes go through functions.
-- -----------------------------------------------------------------------------
alter table public.app_config enable row level security;
alter table public.profiles enable row level security;
alter table public.org_documents enable row level security;
alter table public.listings enable row level security;
alter table public.listing_photos enable row level security;
alter table public.requests enable row level security;
alter table public.pickup_tokens enable row level security;
alter table public.pickup_completions enable row level security;
alter table public.scan_attempts enable row level security;
alter table public.notifications enable row level security;
alter table public.animal_needs enable row level security;

-- Defence in depth: browser roles never write tables directly.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on public.pickup_tokens, public.scan_attempts, public.app_config from anon, authenticated;
revoke all on all tables in schema public from anon;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "org_documents: read own" on public.org_documents
  for select to authenticated using (org_id = (select auth.uid()));

create policy "listings: donor reads own" on public.listings
  for select to authenticated using (donor_id = (select auth.uid()));

create policy "listing_photos: donor reads own" on public.listing_photos
  for select to authenticated using (
    exists (select 1 from public.listings l where l.id = listing_id and l.donor_id = (select auth.uid()))
  );

create policy "requests: parties read" on public.requests
  for select to authenticated using (
    donor_id = (select auth.uid()) or requester_id = (select auth.uid())
  );

create policy "completions: parties read" on public.pickup_completions
  for select to authenticated using (
    donor_id = (select auth.uid()) or recipient_id = (select auth.uid())
  );

create policy "notifications: read own" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));

create policy "animal_needs: owner reads" on public.animal_needs
  for select to authenticated using (org_id = (select auth.uid()));
-- (pickup_tokens, scan_attempts, app_config: no policies => no direct access)
