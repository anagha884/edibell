-- EDIBELL: complete database setup for a NEW Supabase project.
-- Generated from supabase/migrations by `pnpm db:bundle`. Do not edit by hand.
-- Paste everything into Supabase → SQL Editor → New query → Run.
-- It runs as one transaction: if anything fails, nothing is applied.
-- Run it once. (With the Supabase CLI, use `npx supabase db push` instead.)

begin;

-- ===================== 20261028120000_edibell_schema.sql =====================
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


-- ===================== 20261028120100_edibell_helpers.sql =====================
-- =============================================================================
-- EDIBELL — internal helpers (schema `app`, not exposed through the Data API)
-- =============================================================================

-- ---------- reference lists (mirror shared/edibell.ts) -----------------------
create or replace function app.human_categories() returns text[] language sql immutable as $$
  select array['Cooked meals','Rice & grains','Curries & dals','Breads & bakery','Fruits','Vegetables','Dairy',
               'Snacks & packaged food','Sweets & desserts','Beverages','Other']
$$;
create or replace function app.animal_categories() returns text[] language sql immutable as $$
  select array['Cooked rice / grains','Cooked vegetables','Raw vegetable trimmings','Fruit & peels',
               'Bread & bakery leftovers','Dairy','Cooked meat / fish scraps (unseasoned)','Grains & pulses (raw)',
               'Fodder & greens','Other']
$$;
create or replace function app.animal_species() returns text[] language sql immutable as $$
  select array['Dogs','Cats','Cattle / Cows','Goats & sheep','Horses & donkeys','Birds & poultry','Monkeys','Pigs','Fish','Other']
$$;
create or replace function app.allergens() returns text[] language sql immutable as $$
  select array['Gluten / wheat','Peanuts','Tree nuts','Milk / dairy','Eggs','Soy','Fish','Shellfish','Sesame','Mustard']
$$;
create or replace function app.units() returns text[] language sql immutable as $$
  select array['kg','g','litres','ml','portions','pieces','packets','trays']
$$;
create or replace function app.org_types(p_role text) returns text[] language sql immutable as $$
  select case p_role
    when 'donor' then array['College / University Mess','Hotel','Restaurant','Function Hall','Caterer','Bakery','Supermarket',
                            'Corporate Cafeteria','Household / Individual','Other']
    when 'ngo' then array['Community Kitchen','Shelter','Orphanage','Old-Age Home','Food Bank','Other']
    when 'animal' then array['Animal Shelter','Gaushala','Rescue / Rehabilitation Centre','Street-Animal Feeding Group','Sanctuary','Other']
  end
$$;

-- Documented kg-equivalent conversion (see shared/edibell.ts UNIT_TO_KG).
create or replace function app.to_kg(p_qty numeric, p_unit text) returns numeric language sql immutable as $$
  select round(p_qty * case p_unit
    when 'kg' then 1 when 'g' then 0.001 when 'litres' then 1 when 'ml' then 0.001
    when 'portions' then 0.4 when 'pieces' then 0.1 when 'packets' then 0.25 when 'trays' then 3 else 1 end, 3)
$$;

-- Quantity as display text without trailing zeros (4.000 -> 4).
create or replace function app.q(p numeric) returns text language sql immutable as $$ select trim_scale(p)::text $$;

-- ---------- errors ------------------------------------------------------------
-- Raise a user-facing error. The message is shown in the UI as-is.
create or replace function app.fail(p_message text, p_code text default 'P0001') returns void
language plpgsql as $$
begin
  raise exception using message = p_message, errcode = p_code;
end $$;

-- ---------- input helpers -------------------------------------------------------
create or replace function app.txt(p jsonb, k text, p_label text, p_required boolean default false, p_max int default 2000)
returns text language plpgsql immutable as $$
declare v text := btrim(coalesce(p ->> k, ''));
begin
  if p_required and v = '' then perform app.fail(p_label || ' is required.', '22023'); end if;
  if char_length(v) > p_max then perform app.fail(p_label || ' is too long.', '22023'); end if;
  return v;
end $$;

create or replace function app.num(p jsonb, k text, p_label text, p_required boolean default false,
                                   p_min numeric default null, p_max numeric default null)
returns numeric language plpgsql immutable as $$
declare raw text := btrim(coalesce(p ->> k, '')); v numeric;
begin
  if raw = '' then
    if p_required then perform app.fail(p_label || ' is required.', '22023'); end if;
    return null;
  end if;
  begin v := raw::numeric; exception when others then perform app.fail(p_label || ' must be a number.', '22023'); end;
  if v = 'NaN'::numeric then perform app.fail(p_label || ' must be a number.', '22023'); end if;
  if p_min is not null and v < p_min then perform app.fail(p_label || ' must be at least ' || p_min || '.', '22023'); end if;
  if p_max is not null and v > p_max then perform app.fail(p_label || ' must be at most ' || p_max || '.', '22023'); end if;
  return v;
end $$;

create or replace function app.ts(p jsonb, k text, p_label text, p_required boolean default true)
returns timestamptz language plpgsql stable as $$
declare raw text := btrim(coalesce(p ->> k, '')); v timestamptz;
begin
  if raw = '' then
    if p_required then perform app.fail(p_label || ' is required.', '22023'); end if;
    return null;
  end if;
  begin v := raw::timestamptz; exception when others then perform app.fail(p_label || ' is not a valid date/time.', '22023'); end;
  return v;
end $$;

create or replace function app.one_of(p jsonb, k text, p_allowed text[], p_label text) returns text
language plpgsql immutable as $$
declare v text := app.txt(p, k, p_label, true, 200);
begin
  if not (v = any (p_allowed)) then perform app.fail(p_label || ' is not valid.', '22023'); end if;
  return v;
end $$;

-- Distinct, trimmed string list, every entry from p_allowed (if given).
create or replace function app.list(p jsonb, k text, p_label text, p_allowed text[] default null, p_max int default 20)
returns text[] language plpgsql immutable as $$
declare v jsonb := p -> k; out text[] := '{}'; item text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return out; end if;
  if jsonb_typeof(v) <> 'array' then perform app.fail(p_label || ' must be a list.', '22023'); end if;
  for item in select distinct btrim(x) from jsonb_array_elements_text(v) x where btrim(x) <> '' loop
    if p_allowed is not null and not (item = any (p_allowed)) then
      perform app.fail(p_label || ' contains an unknown option: ' || item, '22023');
    end if;
    out := out || item;
  end loop;
  if cardinality(out) > p_max then perform app.fail(p_label || ' has too many entries.', '22023'); end if;
  return out;
end $$;

-- ---------- identity ----------------------------------------------------------------
create or replace function app.me() returns public.profiles language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  if auth.uid() is null then perform app.fail('Please log in.', '28000'); end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then perform app.fail('Your organization profile was not found. Please register again or contact support.', '28000'); end if;
  return p;
end $$;

create or replace function app.require_role(p_roles text[]) returns public.profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.profiles := app.me();
begin
  if not (p.role = any (p_roles)) then
    perform app.fail('Your account type can''t use this feature.', '42501');
  end if;
  return p;
end $$;

create or replace function app.is_admin() returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function app.require_admin() returns public.profiles language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare p public.profiles := app.me();
begin
  if not p.is_admin then perform app.fail('Administrator access is required.', '42501'); end if;
  return p;
end $$;

-- ---------- notifications ---------------------------------------------------------
create or replace function app.notify(p_user uuid, p_type text, p_title text, p_body text, p_link text default '')
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.notifications (user_id, type, title, body, link) values (p_user, p_type, p_title, p_body, coalesce(p_link, ''));
$$;

create or replace function app.recipient_link(p_role text, p_sub text) returns text language sql immutable as $$
  select case p_role when 'ngo' then '/ngo/' else '/animal/' end || p_sub
$$;

-- ---------- pickup codes -------------------------------------------------------------
-- 20 Crockford base-32 characters = 100 bits from a CSPRNG.
create or replace function app.new_pickup_code() returns text language plpgsql volatile
set search_path = public, extensions, pg_temp as $$
declare alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; b bytea := extensions.gen_random_bytes(20); out text := '';
begin
  for i in 0..19 loop out := out || substr(alphabet, (get_byte(b, i) & 31) + 1, 1); end loop;
  return out;
end $$;

-- Mirrors parsePickupCode() in shared/edibell.ts.
create or replace function app.parse_pickup_code(p_raw text) returns text language plpgsql immutable as $$
declare t text := upper(btrim(coalesce(p_raw, '')));
begin
  if left(t, 18) = 'EDIBELL:PICKUP:V1:' then t := substr(t, 19); end if;
  t := translate(regexp_replace(t, '[\s-]', '', 'g'), 'OIL', '011');
  if t ~ '^[0-9A-HJKMNP-TV-Z]{20}$' then return t; end if;
  return null;
end $$;

-- ---------- computed state -------------------------------------------------------------
create or replace function app.remaining(l public.listings) returns numeric language sql immutable as $$
  select greatest(0, l.quantity - l.reserved - l.collected)
$$;

create or replace function app.availability(l public.listings) returns text language sql stable as $$
  select case
    when l.status = 'cancelled' then 'cancelled'
    when l.status = 'completed' then 'completed'
    when l.status = 'expired' or l.expiry_at < now()
      or l.pickup_end + make_interval(mins => (select qr_grace_minutes from public.app_config)) < now() then 'expired'
    when l.review_status = 'pending_review' then 'under-review'
    when l.review_status = 'rejected' then 'rejected'
    when app.remaining(l) <= 0 then 'fully-reserved'
    else 'available' end
$$;

create or replace function app.haversine_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ---------- DTO builders (shapes match shared/edibell.ts) ---------------------------
create or replace function app.org_summary(p public.profiles, p_reveal boolean) returns jsonb language sql stable as $$
  select case when p.id is null then
    jsonb_build_object('id', '', 'name', 'Unknown organization', 'type', '', 'role', 'donor', 'capacity', null,
      'species', '[]'::jsonb, 'area', '', 'city', '', 'about', '', 'verificationStatus', 'pending')
  else
    jsonb_build_object('id', p.id, 'name', p.org_name, 'type', p.org_type, 'role', p.role, 'capacity', p.capacity,
      'species', to_jsonb(p.species), 'area', p.area, 'city', p.city, 'about', p.about,
      'verificationStatus', p.verification_status, 'careRequirements', p.care_requirements)
    || case when p_reveal then jsonb_build_object('phone', p.phone, 'contactName', p.contact_name,
         'address', concat_ws(', ', nullif(p.address, ''), nullif(p.area, ''), nullif(p.city, ''), nullif(p.pincode, '')))
       else '{}'::jsonb end
  end
$$;

create or replace function app.user_dto(p public.profiles) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', p.id, 'role', p.role, 'email', p.email, 'contactName', p.contact_name, 'orgName', p.org_name,
    'orgType', p.org_type, 'phone', p.phone, 'address', p.address, 'area', p.area, 'city', p.city,
    'pincode', p.pincode, 'serviceArea', p.service_area, 'latitude', p.latitude, 'longitude', p.longitude,
    'capacity', p.capacity, 'species', to_jsonb(p.species), 'careRequirements', p.care_requirements,
    'registrationNo', p.registration_no, 'about', p.about, 'verificationStatus', p.verification_status,
    'verificationNote', p.verification_note, 'isAdmin', p.is_admin, 'createdAt', p.created_at)
$$;

create or replace function app.listing_photos(p_listing uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(storage_path order by position, created_at), '[]'::jsonb)
  from public.listing_photos where listing_id = p_listing
$$;

create or replace function app.listing_dto(l public.listings, p_viewer uuid, p_force_reveal boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  donor public.profiles;
  latest public.requests;
  is_owner boolean := p_viewer = l.donor_id;
  reveal boolean;
  dto jsonb;
begin
  select * into donor from public.profiles where id = l.donor_id;
  select * into latest from public.requests r where r.listing_id = l.id and r.requester_id = p_viewer
    order by r.created_at desc limit 1;
  reveal := is_owner or p_force_reveal or exists (
    select 1 from public.requests r where r.listing_id = l.id and r.requester_id = p_viewer and r.status in ('accepted', 'completed'));
  dto := jsonb_build_object(
    'id', l.id, 'destination', l.destination,
    'eligibleForHumans', l.eligible_for_humans, 'eligibleForAnimals', l.eligible_for_animals,
    'reviewStatus', l.review_status, 'reviewNote', l.review_note,
    'title', l.title, 'category', l.category, 'description', l.description,
    'quantity', l.quantity, 'unit', l.unit, 'remaining', app.remaining(l), 'reserved', l.reserved, 'collected', l.collected,
    'photos', app.listing_photos(l.id), 'ingredients', l.ingredients, 'allergens', to_jsonb(l.allergens),
    'allergenNotes', l.allergen_notes, 'dietType', l.diet_type, 'foodOrigin', l.food_origin,
    'preparedAt', l.prepared_at, 'foodState', l.food_state, 'packaging', l.packaging, 'storage', l.storage,
    'handlingNotes', l.handling_notes, 'restrictions', l.restrictions, 'safetyChecklist', l.safety_checklist,
    'expiryAt', l.expiry_at, 'readyAt', l.ready_at,
    'pickupStart', l.pickup_start, 'pickupEnd', l.pickup_end, 'area', l.area, 'city', l.city, 'pincode', l.pincode,
    'latitude', case when reveal then l.latitude end, 'longitude', case when reveal then l.longitude end,
    'animalSpecies', to_jsonb(l.animal_species), 'animalSafetyConfirmed', l.animal_safety_confirmed,
    'status', l.status, 'availability', app.availability(l), 'createdAt', l.created_at, 'updatedAt', l.updated_at,
    'cancelReason', l.cancel_reason,
    'donor', app.org_summary(donor, reveal),
    'myRequest', case when latest.id is null then null else jsonb_build_object('id', latest.id, 'status', latest.status) end);
  if reveal then
    dto := dto || jsonb_build_object('address', l.address, 'placeId', l.place_id,
      'pickupContactName', l.pickup_contact_name, 'pickupContactPhone', l.pickup_contact_phone);
  end if;
  if is_owner then
    dto := dto || jsonb_build_object(
      'pendingRequests', (select count(*) from public.requests r where r.listing_id = l.id and r.status = 'pending'),
      'acceptedRequests', (select count(*) from public.requests r where r.listing_id = l.id and r.status = 'accepted'));
  end if;
  return dto;
end $$;

create or replace function app.qr_state(r public.requests) returns text language sql stable security definer
set search_path = public, pg_temp as $$
  select case
    when t.request_id is null then case when r.status = 'cancelled' then 'cancelled' end
    when r.status = 'completed' or t.used_at is not null then 'used'
    when r.status in ('cancelled', 'declined') then 'cancelled'
    when r.status = 'expired' or t.expires_at < now() then 'expired'
    else 'valid' end
  from (select r.id) x left join public.pickup_tokens t on t.request_id = r.id
$$;

create or replace function app.request_dto(r public.requests, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  l public.listings; donor public.profiles; requester public.profiles; t public.pickup_tokens;
  viewer_is_donor boolean := p_viewer = r.donor_id;
  viewer_is_requester boolean := p_viewer = r.requester_id;
  live boolean := r.status in ('accepted', 'completed');
begin
  select * into l from public.listings where id = r.listing_id;
  select * into donor from public.profiles where id = r.donor_id;
  select * into requester from public.profiles where id = r.requester_id;
  select * into t from public.pickup_tokens where request_id = r.id;
  return jsonb_build_object(
    'id', r.id, 'donationId', r.listing_id, 'status', r.status, 'quantity', r.quantity, 'unit', l.unit,
    'message', r.message, 'collectionNote', r.collection_note, 'beneficiaries', r.beneficiaries,
    'animalSpecies', to_jsonb(r.animal_species), 'animalCount', r.animal_count, 'declineReason', r.decline_reason,
    'createdAt', r.created_at, 'decidedAt', r.decided_at, 'completedAt', r.completed_at,
    'qrState', app.qr_state(r), 'qrExpiresAt', t.expires_at,
    'donation', jsonb_build_object(
      'id', l.id, 'title', l.title, 'category', l.category, 'destination', l.destination,
      'photos', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select jsonb_array_elements(app.listing_photos(l.id)) x limit 1) s),
      'pickupStart', l.pickup_start, 'pickupEnd', l.pickup_end, 'area', l.area, 'city', l.city,
      'unit', l.unit, 'quantity', l.quantity, 'foodState', l.food_state, 'allergens', to_jsonb(l.allergens),
      'expiryAt', l.expiry_at, 'animalSpecies', to_jsonb(l.animal_species), 'status', l.status)
      || case when viewer_is_donor or (viewer_is_requester and live) then jsonb_build_object(
           'address', l.address, 'latitude', l.latitude, 'longitude', l.longitude,
           'pickupContactName', l.pickup_contact_name, 'pickupContactPhone', l.pickup_contact_phone)
         else '{}'::jsonb end,
    -- Donors always see who is asking; contact details once accepted.
    'requester', app.org_summary(requester, viewer_is_donor and live),
    'donor', app.org_summary(donor, viewer_is_requester and live));
end $$;

create or replace function app.need_dto(n public.animal_needs) returns jsonb language sql stable security definer
set search_path = public, pg_temp as $$
  select jsonb_build_object('id', n.id, 'orgId', n.org_id, 'title', n.title, 'species', to_jsonb(n.species),
    'animalCount', n.animal_count, 'categories', to_jsonb(n.categories), 'quantityPerWeek', n.quantity_per_week,
    'unit', n.unit, 'notes', n.notes, 'status', n.status, 'createdAt', n.created_at,
    'org', app.org_summary(p, false))
  from public.profiles p where p.id = n.org_id
$$;

-- ---------- housekeeping: expiry, reminders, food-safety alerts ---------------------------
-- Called at the start of the public functions (cheap thanks to indexes) and
-- optionally on a schedule with pg_cron (see README).
create or replace function app.sweep() returns void language plpgsql volatile security definer
set search_path = public, pg_temp as $$
declare r record; grace interval := make_interval(mins => (select qr_grace_minutes from public.app_config));
begin
  -- 1. Requests whose listing expired / was cancelled, or whose QR expired.
  for r in
    select q.id, q.status, q.quantity, q.requester_id, q.requester_role, q.donor_id, l.id as listing_id, l.title
    from public.requests q
    join public.listings l on l.id = q.listing_id
    left join public.pickup_tokens t on t.request_id = q.id
    where q.status in ('pending', 'accepted')
      and (l.expiry_at < now() or l.pickup_end + grace < now() or l.status in ('expired', 'cancelled')
           or (t.expires_at is not null and t.expires_at < now()))
    for update of q skip locked
  loop
    if r.status = 'accepted' then
      update public.listings set reserved = greatest(0, reserved - r.quantity), updated_at = now() where id = r.listing_id;
    end if;
    update public.requests set status = 'expired', updated_at = now() where id = r.id;
    perform app.notify(r.requester_id, 'request-expired', 'Pickup request expired',
      format('Your request for "%s" expired before the pickup was completed.', r.title), app.recipient_link(r.requester_role, 'requests'));
    if r.status = 'accepted' then
      perform app.notify(r.donor_id, 'request-expired', 'Accepted pickup expired',
        format('An accepted pickup for "%s" was not collected in time.', r.title), '/donor/requests');
    end if;
  end loop;

  -- 2. Listings past their safe-use deadline or pickup window.
  for r in
    select id, donor_id, title, collected from public.listings
    where status = 'active' and (expiry_at < now() or pickup_end + grace < now())
    for update skip locked
  loop
    update public.listings set status = case when r.collected > 0 then 'completed' else 'expired' end, updated_at = now()
      where id = r.id;
    perform app.notify(r.donor_id, 'listing-expired', 'Listing closed',
      format('"%s" reached its pickup or safe-use deadline and is no longer offered.', r.title), '/donor/donations');
  end loop;

  -- 3. Food-safety alert: listing with unreserved food within 1 hour of its safe-use deadline.
  for r in
    select id, donor_id, title from public.listings l
    where status = 'active' and expiry_alert_sent_at is null and expiry_at < now() + interval '1 hour'
      and app.remaining(l) > 0
    for update skip locked
  loop
    update public.listings set expiry_alert_sent_at = now() where id = r.id;
    perform app.notify(r.donor_id, 'food-safety', 'Safe-use deadline approaching',
      format('"%s" must be used within the hour. Do not hand it over after its safe-use deadline.', r.title), '/donor/donations');
  end loop;

  -- 4. Pickup reminders (accepted requests whose window starts within 2 hours).
  for r in
    select q.id, q.requester_id, q.requester_role, q.donor_id, l.title, l.pickup_start
    from public.requests q join public.listings l on l.id = q.listing_id
    where q.status = 'accepted' and q.reminder_sent_at is null and l.pickup_start < now() + interval '2 hours'
    for update of q skip locked
  loop
    update public.requests set reminder_sent_at = now() where id = r.id;
    perform app.notify(r.requester_id, 'pickup-reminder', 'Pickup reminder',
      format('Collect "%s" during the pickup window. Bring your Pickup Pass QR.', r.title), app.recipient_link(r.requester_role, 'pickup'));
    perform app.notify(r.donor_id, 'pickup-reminder', 'Pickup coming up',
      format('An organization is due to collect "%s". Use Verify Pickup to scan their QR.', r.title), '/donor/scanner');
  end loop;
end $$;

revoke all on all functions in schema app from public;


-- ===================== 20261028120200_edibell_api.sql =====================
-- =============================================================================
-- EDIBELL — public API (called from the browser with supabase.rpc()).
-- Every function: SECURITY DEFINER, fixed search_path, checks auth.uid() and
-- the caller's role, validates input, and performs its writes atomically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sign-up: create the organization profile from the auth user's metadata.
-- Public sign-up can only create donor / ngo / animal profiles, never admins.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_user() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role text := m ->> 'role';
  v_species text[];
  v_capacity numeric;
begin
  -- Users created by other flows (e.g. an operator inviting an admin) without
  -- EDIBELL metadata simply get no profile.
  if v_role is null then return new; end if;
  if v_role not in ('donor', 'ngo', 'animal') then
    perform app.fail('Account type must be Food Donor, NGO Partner or Animal Welfare Organization.', '22023');
  end if;
  v_species := case when v_role = 'animal' then app.list(m, 'species', 'Species', app.animal_species()) else '{}' end;
  if v_role = 'animal' and cardinality(v_species) = 0 then
    perform app.fail('Select at least one species your organization cares for.', '22023');
  end if;
  if app.txt(m, 'orgType', 'Organization type', false, 80) <> ''
     and not (app.txt(m, 'orgType', 'Organization type', false, 80) = any (app.org_types(v_role))) then
    perform app.fail('Organization type is not valid.', '22023');
  end if;
  v_capacity := case when v_role = 'donor' then null else app.num(m, 'capacity', 'Capacity', false, 0, 1000000) end;

  insert into public.profiles (id, role, email, contact_name, org_name, org_type, phone, address, area, city, pincode,
                               service_area, capacity, species, care_requirements, registration_no, about)
  values (new.id, v_role, lower(coalesce(new.email, '')),
    app.txt(m, 'contactName', 'Contact person', true, 120),
    app.txt(m, 'orgName', 'Organization name', true, 160),
    app.txt(m, 'orgType', 'Organization type', false, 80),
    app.txt(m, 'phone', 'Phone', true, 40),
    app.txt(m, 'address', 'Address', true, 300),
    app.txt(m, 'area', 'Area', false, 100),
    app.txt(m, 'city', 'City', true, 100),
    app.txt(m, 'pincode', 'PIN code', false, 12),
    app.txt(m, 'serviceArea', 'Service area', false, 300),
    v_capacity::integer, v_species,
    case when v_role = 'animal' then app.txt(m, 'careRequirements', 'Care requirements', false, 1500) else '' end,
    app.txt(m, 'registrationNo', 'Registration number', false, 80),
    app.txt(m, 'about', 'About', false, 600));

  perform app.notify(new.id, 'welcome', 'Welcome to EDIBELL',
    case v_role
      when 'donor' then 'Share your first surplus food listing to start rescuing food.'
      when 'ngo' then 'Discover available food and send your first pickup request.'
      else 'Discover animal-suitable feed and complete your Animal Care Profile.' end,
    case v_role when 'donor' then '/donor' when 'ngo' then '/ngo' else '/animal' end);
  perform app.notify(new.id, 'verification', 'Verification pending',
    'Your organization is registered but not yet verified by EDIBELL. Add your registration details and documents in your profile.',
    case v_role when 'donor' then '/donor/profile' when 'ngo' then '/ngo/profile' else '/animal/profile' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- Keep profile email in sync when a user changes their login email.
create or replace function app.handle_user_email_change() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(coalesce(new.email, '')), updated_at = now() where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function app.handle_user_email_change();

-- -----------------------------------------------------------------------------
-- Account
-- -----------------------------------------------------------------------------
create or replace function public.get_my_profile() returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  return app.user_dto(p);
end $$;

create or replace function public.update_my_profile(p jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  me public.profiles := app.me();
  v_species text[] := case when me.role = 'animal' then app.list(p, 'species', 'Species', app.animal_species()) else '{}' end;
  v_type text := app.txt(p, 'orgType', 'Organization type', false, 80);
  v_org text := app.txt(p, 'orgName', 'Organization name', true, 160);
  v_reg text := app.txt(p, 'registrationNo', 'Registration number', false, 80);
  v_lat numeric := app.num(p, 'latitude', 'Latitude', false, -90, 90);
  v_lng numeric := app.num(p, 'longitude', 'Longitude', false, -180, 180);
  reset_verification boolean;
begin
  if v_type <> '' and not (v_type = any (app.org_types(me.role))) then perform app.fail('Organization type is not valid.', '22023'); end if;
  if me.role = 'animal' and cardinality(v_species) = 0 then perform app.fail('Select at least one species your organization cares for.', '22023'); end if;
  if (v_lat is null) <> (v_lng is null) then perform app.fail('Provide both latitude and longitude, or neither.', '22023'); end if;
  -- Changing the legal identity of a verified organization requires re-verification.
  reset_verification := me.verification_status = 'verified' and (v_org <> me.org_name or v_reg <> me.registration_no);
  update public.profiles set
    contact_name = app.txt(p, 'contactName', 'Contact person', true, 120),
    org_name = v_org, org_type = v_type,
    phone = app.txt(p, 'phone', 'Phone', true, 40),
    address = app.txt(p, 'address', 'Address', true, 300),
    area = app.txt(p, 'area', 'Area', false, 100),
    city = app.txt(p, 'city', 'City', true, 100),
    pincode = app.txt(p, 'pincode', 'PIN code', false, 12),
    service_area = app.txt(p, 'serviceArea', 'Service area', false, 300),
    latitude = v_lat, longitude = v_lng,
    capacity = case when me.role = 'donor' then null else app.num(p, 'capacity', 'Capacity', false, 0, 1000000)::integer end,
    species = v_species,
    care_requirements = case when me.role = 'animal' then app.txt(p, 'careRequirements', 'Care requirements', false, 1500) else '' end,
    registration_no = v_reg,
    about = app.txt(p, 'about', 'About', false, 600),
    verification_status = case when reset_verification then 'pending' else verification_status end,
    verified_at = case when reset_verification then null else verified_at end,
    updated_at = now()
  where id = me.id
  returning * into me;
  if reset_verification then
    perform app.notify(me.id, 'verification', 'Re-verification needed',
      'You changed your organization name or registration number, so your verification is pending again.', '');
  end if;
  return app.user_dto(me);
end $$;

-- Record an uploaded verification document (the file itself is uploaded to
-- storage bucket `org-documents` under "<user id>/...").
create or replace function public.add_org_document(p_path text, p_doc_type text, p_file_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := app.me(); d public.org_documents;
begin
  if p_path is null or split_part(p_path, '/', 1) <> me.id::text then perform app.fail('Invalid document path.', '22023'); end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'org-documents' and o.name = p_path) then
    perform app.fail('The document upload was not found. Please upload it again.', '22023');
  end if;
  insert into public.org_documents (org_id, doc_type, storage_path, file_name)
  values (me.id, p_doc_type, p_path, left(coalesce(p_file_name, ''), 200)) returning * into d;
  return jsonb_build_object('id', d.id, 'docType', d.doc_type, 'path', d.storage_path, 'fileName', d.file_name, 'createdAt', d.created_at);
end $$;

create or replace function public.list_my_documents() returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'docType', doc_type, 'path', storage_path,
    'fileName', file_name, 'createdAt', created_at) order by created_at desc) from public.org_documents where org_id = me.id), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Public, aggregate-only statistics (callable without logging in)
-- -----------------------------------------------------------------------------
create or replace function public.public_stats() returns jsonb language sql stable security definer
set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'donors', (select count(*) from public.profiles where role = 'donor' and not is_admin),
    'ngos', (select count(*) from public.profiles where role = 'ngo' and not is_admin),
    'animalOrgs', (select count(*) from public.profiles where role = 'animal' and not is_admin),
    'completedPickups', (select count(*) from public.pickup_completions),
    'foodRescuedKg', (select coalesce(sum(kg_equivalent), 0) from public.pickup_completions),
    'humanFoodKg', (select coalesce(sum(kg_equivalent), 0) from public.pickup_completions where destination = 'human'),
    'animalFeedKg', (select coalesce(sum(kg_equivalent), 0) from public.pickup_completions where destination = 'animal'))
$$;

-- -----------------------------------------------------------------------------
-- Listings (donor)
-- -----------------------------------------------------------------------------
-- Validates a listing payload. Returns the normalized values as a record.
create or replace function app.validate_listing(me public.profiles, p jsonb, p_existing public.listings default null)
returns public.listings language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  l public.listings;
  chk jsonb := coalesce(p -> 'safetyChecklist', '{}'::jsonb);
  needs_review boolean := false;
begin
  l.id := coalesce(p_existing.id, gen_random_uuid());
  l.donor_id := me.id;
  l.destination := app.one_of(p, 'destination', array['human', 'animal'], 'Food is for');
  l.title := app.txt(p, 'title', 'Food name', true, 120);
  l.category := app.one_of(p, 'category', case when l.destination = 'human' then app.human_categories() else app.animal_categories() end, 'Food category');
  l.description := app.txt(p, 'description', 'Description', false, 1500);
  l.quantity := app.num(p, 'quantity', 'Quantity', true, 0.01, 100000);
  l.unit := app.one_of(p, 'unit', app.units(), 'Unit');
  l.food_state := app.one_of(p, 'foodState', array['hot', 'cold', 'room-temperature', 'frozen', 'not-applicable'], 'Food state');
  l.food_origin := app.one_of(p, 'foodOrigin', array['untouched-surplus', 'cooked-not-served', 'plate-leftover'], 'Food origin');
  l.prepared_at := app.ts(p, 'preparedAt', 'Preparation date & time');
  l.expiry_at := app.ts(p, 'expiryAt', 'Safe-use deadline');
  l.ready_at := app.ts(p, 'readyAt', 'Ready for collection');
  l.pickup_start := app.ts(p, 'pickupStart', 'Pickup window start');
  l.pickup_end := app.ts(p, 'pickupEnd', 'Pickup window end');
  l.address := app.txt(p, 'address', 'Pickup address', true, 300);
  l.area := app.txt(p, 'area', 'Area', true, 100);
  l.city := app.txt(p, 'city', 'City', true, 100);
  l.pincode := app.txt(p, 'pincode', 'PIN code', false, 12);
  l.place_id := app.txt(p, 'placeId', 'Place ID', false, 300);
  l.latitude := app.num(p, 'latitude', 'Latitude', false, -90, 90);
  l.longitude := app.num(p, 'longitude', 'Longitude', false, -180, 180);
  l.pickup_contact_name := app.txt(p, 'pickupContactName', 'Pickup contact name', true, 120);
  l.pickup_contact_phone := app.txt(p, 'pickupContactPhone', 'Pickup contact phone', true, 40);
  l.packaging := app.txt(p, 'packaging', 'Packaging details', true, 120);
  l.storage := app.txt(p, 'storage', 'Storage / handling', true, 160);
  l.handling_notes := app.txt(p, 'handlingNotes', 'Additional instructions', false, 600);
  l.restrictions := app.txt(p, 'restrictions', 'Restrictions', false, 600);
  l.ingredients := app.txt(p, 'ingredients', 'Ingredients', true, 1000);
  l.allergen_notes := app.txt(p, 'allergenNotes', 'Allergen notes', false, 400);

  if (l.latitude is null) <> (l.longitude is null) then perform app.fail('Provide both map coordinates, or neither.', '22023'); end if;
  if l.pickup_end <= l.pickup_start then perform app.fail('Pickup window end must be after its start.', '22023'); end if;
  if l.pickup_end <= now() then perform app.fail('Pickup window must end in the future.', '22023'); end if;
  if l.ready_at > l.pickup_end then perform app.fail('Ready-for-collection time must be before the pickup window ends.', '22023'); end if;
  if l.prepared_at > now() + interval '5 minutes' then perform app.fail('Preparation time cannot be in the future.', '22023'); end if;
  if l.prepared_at < now() - interval '7 days' and l.food_state not in ('frozen', 'not-applicable') then
    perform app.fail('Cooked or perishable food prepared more than 7 days ago can''t be listed.', '22023');
  end if;
  if l.expiry_at <= now() then perform app.fail('The safe-use deadline has already passed.', '22023'); end if;
  if l.expiry_at < l.pickup_start then perform app.fail('Food must stay safe at least until the pickup window starts.', '22023'); end if;
  if l.food_state = 'hot' and l.expiry_at > l.prepared_at + interval '12 hours' then
    perform app.fail('Hot cooked food can''t have a safe-use deadline more than 12 hours after preparation. Refrigerate it and choose "Cold" if it has been chilled.', '22023');
  end if;
  if l.food_state = 'room-temperature' and l.category in ('Cooked meals', 'Rice & grains', 'Curries & dals', 'Dairy', 'Cooked rice / grains', 'Cooked vegetables', 'Cooked meat / fish scraps (unseasoned)')
     and l.expiry_at > l.prepared_at + interval '4 hours' then
    perform app.fail('Cooked or dairy food kept at room temperature must be used within 4 hours of preparation.', '22023');
  end if;

  if l.destination = 'human' then
    l.diet_type := app.one_of(p, 'dietType', array['vegetarian', 'non-vegetarian', 'vegan', 'contains-egg'], 'Diet type');
    l.allergens := app.list(p, 'allergens', 'Allergens', app.allergens());
    l.animal_species := '{}';
    if l.food_origin = 'plate-leftover' then
      perform app.fail('Food left on plates or returned by customers can''t go to people. It is not automatically suitable for animals either — list it as animal feed only if it passes the animal-feed screening.', '22023');
    end if;
    if not coalesce((chk ->> 'hygienic')::boolean, false) or not coalesce((chk ->> 'temperatureControlled')::boolean, false)
       or not coalesce((chk ->> 'notServed')::boolean, false) or not coalesce((chk ->> 'notSpoiled')::boolean, false) then
      perform app.fail('Complete every item in the human-food safety checklist. If any item can''t be confirmed, the food must not be listed for people.', '22023');
    end if;
    l.human_safety_confirmed := true; l.animal_safety_confirmed := false;
    l.eligible_for_humans := true; l.eligible_for_animals := false;
  else
    l.diet_type := null;
    l.allergens := '{}';
    l.animal_species := app.list(p, 'animalSpecies', 'Animal species', app.animal_species());
    if cardinality(l.animal_species) = 0 then perform app.fail('Select at least one animal species this food is suitable for.', '22023'); end if;
    if not coalesce((chk ->> 'notSpoiled')::boolean, false) or not coalesce((chk ->> 'noToxicItems')::boolean, false)
       or not coalesce((chk ->> 'noCookedBones')::boolean, false) or not coalesce((chk ->> 'lowSaltSpice')::boolean, false) then
      perform app.fail('Complete every item in the animal-feed screening. Spoiled, contaminated or unknown-condition food must not be offered as feed.', '22023');
    end if;
    if (('Dogs' = any (l.animal_species)) or ('Cats' = any (l.animal_species)))
       and not coalesce((chk ->> 'noOnionGarlic')::boolean, false) then
      perform app.fail('Food for dogs or cats must be free of onion and garlic. Confirm this or remove dogs/cats from the suitable species.', '22023');
    end if;
    l.human_safety_confirmed := false; l.animal_safety_confirmed := true;
    l.eligible_for_humans := false; l.eligible_for_animals := true;
    -- Plate leftovers and meat/fish scraps need an EDIBELL safety review before
    -- they become visible to animal welfare organizations.
    needs_review := l.food_origin = 'plate-leftover' or l.category = 'Cooked meat / fish scraps (unseasoned)';
  end if;
  l.safety_checklist := chk;
  l.review_status := case when needs_review then 'pending_review' else 'approved' end;
  return l;
end $$;

create or replace function app.attach_photos(me public.profiles, p_listing uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare paths text[] := app.list(p, 'photos', 'Photos', null, 5); i int := 0; path text;
begin
  delete from public.listing_photos where listing_id = p_listing and not (storage_path = any (paths));
  foreach path in array paths loop
    if split_part(path, '/', 1) <> me.id::text then perform app.fail('Photos must be uploaded from your own account.', '22023'); end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'food-photos' and o.name = path) then
      perform app.fail('A photo upload was not found. Please add the photo again.', '22023');
    end if;
    insert into public.listing_photos (listing_id, storage_path, position) values (p_listing, path, i)
    on conflict (storage_path) do update set position = excluded.position
      where public.listing_photos.listing_id = p_listing;
    i := i + 1;
  end loop;
end $$;

create or replace function public.create_listing(p jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  me public.profiles := app.require_role(array['donor']);
  l public.listings;
  r record;
  recipient_role text;
begin
  if (select require_verified_donors from public.app_config) and me.verification_status <> 'verified' then
    perform app.fail('Your organization must be verified by EDIBELL before publishing food.', '42501');
  end if;
  l := app.validate_listing(me, p);
  l.reserved := 0; l.collected := 0; l.status := 'active'; l.cancel_reason := ''; l.review_note := '';
  l.created_at := now(); l.updated_at := now();
  insert into public.listings select l.*;
  perform app.attach_photos(me, l.id, p);
  select * into l from public.listings where id = l.id;

  if l.review_status = 'pending_review' then
    perform app.notify(me.id, 'listing-review', 'Listing awaiting safety review',
      format('"%s" will be shown to animal welfare organizations after an EDIBELL safety review.', l.title), '/donor/donations');
    for r in select id from public.profiles where is_admin loop
      perform app.notify(r.id, 'review-needed', 'Animal-feed listing needs review', format('"%s" from %s.', l.title, me.org_name), '/admin');
    end loop;
  else
    perform app.notify(me.id, 'donation-created', 'Listing published',
      format('"%s" is now visible to %s.', l.title, case when l.destination = 'human' then 'NGO partners' else 'animal welfare organizations' end), '/donor/donations');
    recipient_role := case when l.destination = 'human' then 'ngo' else 'animal' end;
    for r in select id, role from public.profiles p
      where p.role = recipient_role and lower(p.city) = lower(l.city)
        and (recipient_role = 'ngo' or p.species && l.animal_species)
    loop
      perform app.notify(r.id, 'new-donation', case when recipient_role = 'ngo' then 'New food available' else 'Animal feed available nearby' end,
        format('%s · %s %s in %s, %s', l.title, app.q(l.quantity), l.unit, l.area, l.city), app.recipient_link(r.role, 'finder'));
    end loop;
  end if;
  return app.listing_dto(l, me.id);
end $$;

-- Donors may edit a listing while nothing has been reserved or collected.
-- Once a request is accepted, the donor must cancel (which cancels the
-- accepted pickups and notifies the recipients) instead of editing.
create or replace function public.update_listing(p_id uuid, p jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['donor']); old public.listings; l public.listings; r record;
begin
  perform app.sweep();
  select * into old from public.listings where id = p_id and donor_id = me.id for update;
  if not found then perform app.fail('Listing not found.', 'P0002'); end if;
  if old.status <> 'active' then perform app.fail(format('This listing is already %s and can''t be edited.', old.status), '55000'); end if;
  if old.reserved > 0 or old.collected > 0 or exists (select 1 from public.requests where listing_id = p_id and status = 'accepted') then
    perform app.fail('This listing has an accepted pickup, so it can''t be edited. Cancel the listing instead if the food is no longer available.', '55000');
  end if;
  l := app.validate_listing(me, p, old);
  if l.destination <> old.destination then perform app.fail('A listing can''t be moved between the human-food and animal-feed pathways. Cancel it and create a new listing.', '22023'); end if;
  update public.listings set
    title = l.title, category = l.category, description = l.description, quantity = l.quantity, unit = l.unit,
    ingredients = l.ingredients, allergens = l.allergens, allergen_notes = l.allergen_notes, diet_type = l.diet_type,
    food_origin = l.food_origin, prepared_at = l.prepared_at, food_state = l.food_state, packaging = l.packaging,
    storage = l.storage, handling_notes = l.handling_notes, restrictions = l.restrictions, safety_checklist = l.safety_checklist,
    expiry_at = l.expiry_at, ready_at = l.ready_at, pickup_start = l.pickup_start, pickup_end = l.pickup_end,
    address = l.address, area = l.area, city = l.city, pincode = l.pincode, latitude = l.latitude, longitude = l.longitude,
    place_id = l.place_id, pickup_contact_name = l.pickup_contact_name, pickup_contact_phone = l.pickup_contact_phone,
    animal_species = l.animal_species,
    review_status = case when l.review_status = 'pending_review' then 'pending_review' else old.review_status end,
    expiry_alert_sent_at = null, updated_at = now()
  where id = p_id returning * into l;
  perform app.attach_photos(me, l.id, p);
  for r in select distinct requester_id, requester_role from public.requests where listing_id = p_id and status = 'pending' loop
    perform app.notify(r.requester_id, 'listing-updated', 'A requested listing was updated',
      format('The donor updated "%s". Check the details before pickup.', l.title), app.recipient_link(r.requester_role, 'requests'));
  end loop;
  return app.listing_dto(l, me.id);
end $$;

create or replace function public.cancel_listing(p_id uuid, p_reason text default '') returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['donor']); l public.listings; r record;
begin
  select * into l from public.listings where id = p_id and donor_id = me.id for update;
  if not found then perform app.fail('Listing not found.', 'P0002'); end if;
  if l.status <> 'active' then perform app.fail(format('This listing is already %s.', l.status), '55000'); end if;
  for r in select * from public.requests where listing_id = p_id and status in ('pending', 'accepted') for update loop
    update public.requests set status = 'cancelled', cancelled_by = me.id, updated_at = now() where id = r.id;
    perform app.notify(r.requester_id, 'donation-cancelled',
      case when r.status = 'accepted' then 'Accepted pickup cancelled by donor' else 'Listing cancelled by donor' end,
      format('"%s" is no longer available%s. Your pickup pass for it no longer works.', l.title,
             case when coalesce(p_reason, '') <> '' then ': ' || left(p_reason, 300) else '' end),
      app.recipient_link(r.requester_role, 'requests'));
  end loop;
  update public.listings set status = case when collected > 0 then 'completed' else 'cancelled' end,
    reserved = 0, cancel_reason = left(coalesce(p_reason, ''), 300), updated_at = now()
  where id = p_id returning * into l;
  return app.listing_dto(l, me.id);
end $$;

create or replace function public.list_my_listings() returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['donor']);
begin
  perform app.sweep();
  return coalesce((select jsonb_agg(app.listing_dto(l, me.id) order by l.created_at desc)
                   from public.listings l where l.donor_id = me.id), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- Marketplace (NGO: human food; animal org: animal feed). Eligibility is
-- enforced here, server-side, for every query.
-- -----------------------------------------------------------------------------
create or replace function public.browse_listings(f jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  me public.profiles := app.require_role(array['ngo', 'animal']);
  dest text := case when me.role = 'ngo' then 'human' else 'animal' end;
  q text := lower(btrim(coalesce(f ->> 'q', '')));
  loc text := lower(btrim(coalesce(f ->> 'location', '')));
  v_category text := nullif(f ->> 'category', '');
  v_species text := nullif(f ->> 'species', '');
  v_diet text := nullif(f ->> 'diet', '');
  v_state text := nullif(f ->> 'foodState', '');
  min_qty numeric := coalesce(app.num(f, 'minQty', 'Minimum quantity', false, 0), 0);
  lat double precision := app.num(f, 'lat', 'Latitude', false, -90, 90);
  lng double precision := app.num(f, 'lng', 'Longitude', false, -180, 180);
  max_km double precision := app.num(f, 'maxDistanceKm', 'Distance', false, 0, 20000);
  p_from timestamptz := app.ts(f, 'pickupFrom', 'Pickup from', false);
  p_to timestamptz := app.ts(f, 'pickupTo', 'Pickup to', false);
  want_all boolean := coalesce(f ->> 'availability', '') = 'all';
  my_species boolean := coalesce((f ->> 'mySpecies')::boolean, false);
  v_sort text := coalesce(nullif(f ->> 'sort', ''), 'soonest');
  v_limit int := least(coalesce(app.num(f, 'limit', 'Limit', false, 1, 200)::int, 60), 200);
  v_offset int := coalesce(app.num(f, 'offset', 'Offset', false, 0, 100000)::int, 0);
begin
  perform app.sweep();
  return coalesce((
    select jsonb_agg(y.dto || jsonb_build_object('distanceKm', y.km) order by y.rn)
    from (
      select x.*, row_number() over (order by
          case when v_sort = 'nearest' then coalesce(x.km, 1e9) end asc,
          case when v_sort = 'newest' then extract(epoch from x.created_at) end desc,
          case when v_sort = 'quantity' then x.rem end desc,
          case when v_sort = 'expiry' then x.expiry_at end asc,
          x.pickup_start asc, x.id) as rn
      from (
        select l.id, app.listing_dto(l, me.id) as dto, l.created_at, l.expiry_at, l.pickup_start, app.remaining(l) as rem,
               case when lat is not null and lng is not null and l.latitude is not null
                    then round(app.haversine_km(lat, lng, l.latitude, l.longitude)::numeric, 2) end as km
        from public.listings l
        join public.profiles d on d.id = l.donor_id
        where l.destination = dest
          and l.status = 'active' and l.review_status = 'approved'
          and (case when dest = 'human' then l.eligible_for_humans else l.eligible_for_animals end)
          and app.availability(l) in ('available', case when want_all then 'fully-reserved' else 'available' end)
          and (q = '' or lower(concat_ws(' ', l.title, l.description, l.ingredients, l.category, l.area, l.city, d.org_name)) like '%' || q || '%')
          and (v_category is null or l.category = v_category)
          and (v_species is null or v_species = any (l.animal_species))
          and (not my_species or me.role <> 'animal' or l.animal_species && me.species)
          and (v_diet is null or l.diet_type = v_diet)
          and (v_state is null or l.food_state = v_state)
          and (loc = '' or lower(concat_ws(' ', l.area, l.city, l.pincode)) like '%' || loc || '%')
          and app.remaining(l) >= min_qty
          and (p_from is null or l.pickup_end >= p_from)
          and (p_to is null or l.pickup_start <= p_to)
      ) x
      where max_km is null or x.km is null or x.km <= max_km
      order by rn limit v_limit offset v_offset
    ) y
  ), '[]'::jsonb);
end $$;

create or replace function public.get_listing(p_id uuid) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me(); l public.listings;
begin
  select * into l from public.listings where id = p_id;
  if not found then perform app.fail('Listing not found.', 'P0002'); end if;
  if me.role = 'donor' then
    if l.donor_id <> me.id then perform app.fail('Listing not found.', 'P0002'); end if;
  elsif not ((me.role = 'ngo' and l.destination = 'human' and l.eligible_for_humans)
          or (me.role = 'animal' and l.destination = 'animal' and l.eligible_for_animals)) then
    perform app.fail('Listing not found.', 'P0002');
  elsif l.review_status <> 'approved' and not exists (select 1 from public.requests where listing_id = p_id and requester_id = me.id) then
    perform app.fail('Listing not found.', 'P0002');
  end if;
  return app.listing_dto(l, me.id);
end $$;

-- -----------------------------------------------------------------------------
-- Requests
-- -----------------------------------------------------------------------------
create or replace function public.create_request(p jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  me public.profiles := app.require_role(array['ngo', 'animal']);
  v_listing uuid;
  l public.listings;
  r public.requests;
  v_qty numeric := app.num(p, 'quantity', 'Quantity', true, 0.001);
  v_species text[] := '{}';
  avail text;
begin
  if (select require_verified_recipients from public.app_config) and me.verification_status <> 'verified' then
    perform app.fail('Your organization must be verified by EDIBELL before requesting food.', '42501');
  end if;
  begin v_listing := (p ->> 'donationId')::uuid; exception when others then perform app.fail('Listing not found.', 'P0002'); end;
  perform app.sweep();
  select * into l from public.listings where id = v_listing for update;
  if not found or l.destination <> (case when me.role = 'ngo' then 'human' else 'animal' end)
     or not (case when me.role = 'ngo' then l.eligible_for_humans else l.eligible_for_animals end) then
    perform app.fail('Listing not found.', 'P0002');
  end if;
  avail := app.availability(l);
  if avail <> 'available' then
    perform app.fail(case avail when 'fully-reserved' then 'All of this food has already been reserved.'
                                when 'under-review' then 'This listing is still awaiting a safety review.'
                                else format('This listing is %s.', avail) end, '55000');
  end if;
  if v_qty > app.remaining(l) then
    perform app.fail(format('Only %s %s is still available.', app.q(app.remaining(l)), l.unit), '22023');
  end if;
  if me.role = 'animal' then
    v_species := app.list(p, 'animalSpecies', 'Animal species', app.animal_species());
    if cardinality(v_species) = 0 then perform app.fail('Select which animals this food is for.', '22023'); end if;
    if not (v_species <@ l.animal_species) then
      perform app.fail('The donor marked this food as suitable only for: ' || array_to_string(l.animal_species, ', ') || '.', '22023');
    end if;
  end if;
  begin
    insert into public.requests (listing_id, donor_id, requester_id, requester_role, quantity, message, collection_note,
                                 beneficiaries, animal_species, animal_count)
    values (l.id, l.donor_id, me.id, me.role, v_qty,
      app.txt(p, 'message', 'Message', false, 600), app.txt(p, 'collectionNote', 'Collection details', false, 300),
      case when me.role = 'ngo' then app.num(p, 'beneficiaries', 'People served', false, 0, 1000000)::int end,
      v_species,
      case when me.role = 'animal' then app.num(p, 'animalCount', 'Number of animals', false, 0, 1000000)::int end)
    returning * into r;
  exception when unique_violation then
    perform app.fail('You already have an active request for this listing.', '23505');
  end;
  perform app.notify(l.donor_id, 'request-received', 'New food request',
    format('%s requested %s %s of "%s".', me.org_name, app.q(r.quantity), l.unit, l.title), '/donor/requests');
  perform app.notify(me.id, 'request-sent', 'Request sent',
    format('Your request for %s %s of "%s" is waiting for the donor.', app.q(r.quantity), l.unit, l.title), app.recipient_link(me.role, 'requests'));
  return app.request_dto(r, me.id);
end $$;

create or replace function public.list_my_requests(p_status text default 'all') returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me();
begin
  perform app.sweep();
  return coalesce((select jsonb_agg(app.request_dto(r, me.id) order by r.created_at desc)
    from public.requests r
    where (case when me.role = 'donor' then r.donor_id else r.requester_id end) = me.id
      and (coalesce(p_status, 'all') = 'all' or r.status = p_status)), '[]'::jsonb);
end $$;

-- Donor accepts / declines. Acceptance locks the listing row, re-checks the
-- remaining stock and reserves it in the same transaction, so concurrent
-- acceptances can never allocate more food than exists.
create or replace function public.decide_request(p_id uuid, p_decision text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.profiles := app.require_role(array['donor']);
  r public.requests; l public.listings; avail text; code text; grace interval;
begin
  if p_decision not in ('accept', 'decline') then perform app.fail('Decision is not valid.', '22023'); end if;
  perform app.sweep();
  select * into r from public.requests where id = p_id and donor_id = me.id;
  if not found then perform app.fail('Request not found.', 'P0002'); end if;
  -- Lock order: listing, then request (same order as verify_pickup / cancel).
  select * into l from public.listings where id = r.listing_id for update;
  select * into r from public.requests where id = p_id for update;
  if r.status <> 'pending' then perform app.fail(format('This request is already %s.', r.status), '55000'); end if;

  if p_decision = 'decline' then
    update public.requests set status = 'declined', decline_reason = left(coalesce(p_reason, ''), 300),
      decided_at = now(), updated_at = now() where id = p_id returning * into r;
    perform app.notify(r.requester_id, 'request-declined', 'Request declined',
      format('"%s" — %s', l.title, coalesce(nullif(left(p_reason, 300), ''), 'the donor couldn''t fulfil this request.')),
      app.recipient_link(r.requester_role, 'requests'));
    return app.request_dto(r, me.id);
  end if;

  avail := app.availability(l);
  if avail in ('expired', 'cancelled', 'completed', 'under-review', 'rejected') then
    perform app.fail(format('This listing is %s, so the request can''t be accepted.', replace(avail, '-', ' ')), '55000');
  end if;
  if r.quantity > app.remaining(l) then
    perform app.fail(format('Only %s %s is left — decline this request or ask the organization to request less.', app.q(app.remaining(l)), l.unit), '55000');
  end if;

  update public.listings set reserved = reserved + r.quantity, updated_at = now() where id = l.id returning * into l;
  update public.requests set status = 'accepted', decided_at = now(), updated_at = now() where id = p_id returning * into r;
  grace := make_interval(mins => (select qr_grace_minutes from public.app_config));
  loop
    code := app.new_pickup_code();
    begin
      insert into public.pickup_tokens (request_id, token, expires_at) values (r.id, code, l.pickup_end + grace);
      exit;
    exception when unique_violation then
      if exists (select 1 from public.pickup_tokens where request_id = r.id) then raise; end if;
    end;
  end loop;
  perform app.notify(r.requester_id, 'request-accepted', 'Request accepted — your Pickup Pass is ready',
    format('Collect %s %s of "%s" at %s, %s during the pickup window and show your Pickup Pass QR.', app.q(r.quantity), l.unit, l.title, l.area, l.city),
    app.recipient_link(r.requester_role, 'pickup'));
  return app.request_dto(r, me.id);
end $$;

create or replace function public.cancel_request(p_id uuid) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['ngo', 'animal']); r public.requests; l public.listings;
begin
  select * into r from public.requests where id = p_id and requester_id = me.id;
  if not found then perform app.fail('Request not found.', 'P0002'); end if;
  select * into l from public.listings where id = r.listing_id for update;
  select * into r from public.requests where id = p_id for update;
  if r.status not in ('pending', 'accepted') then perform app.fail(format('A %s request can''t be cancelled.', r.status), '55000'); end if;
  if r.status = 'accepted' then
    update public.listings set reserved = greatest(0, reserved - r.quantity), updated_at = now() where id = l.id;
  end if;
  update public.requests set status = 'cancelled', cancelled_by = me.id, updated_at = now() where id = p_id returning * into r;
  perform app.notify(r.donor_id, 'request-cancelled', 'Request cancelled',
    format('%s cancelled their request for "%s".%s', me.org_name, l.title,
      case when r.decided_at is not null then ' The reserved quantity is available again.' else '' end), '/donor/requests');
  return app.request_dto(r, me.id);
end $$;

-- -----------------------------------------------------------------------------
-- Pickup pass (recipient displays) and verification (donor scans)
-- -----------------------------------------------------------------------------
create or replace function public.get_pickup_pass(p_request uuid) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['ngo', 'animal']); r public.requests; t public.pickup_tokens; st text;
begin
  perform app.sweep();
  select * into r from public.requests where id = p_request and requester_id = me.id;
  if not found then perform app.fail('Request not found.', 'P0002'); end if;  -- never reveal other orgs' passes
  select * into t from public.pickup_tokens where request_id = r.id;
  if not found then perform app.fail('A Pickup Pass is created only after the donor accepts your request.', '55000'); end if;
  st := app.qr_state(r);
  return jsonb_build_object('requestId', r.id, 'state', st,
    'code', case when st = 'valid' then t.token end,
    'payload', case when st = 'valid' then 'EDIBELL:PICKUP:v1:' || t.token end,
    'expiresAt', t.expires_at, 'usedAt', t.used_at, 'request', app.request_dto(r, me.id));
end $$;

create or replace function app.scan_failure(p_donor uuid, p_failure text, p_request uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_failure <> 'rate-limited' then
    insert into public.scan_attempts (donor_id, ok, failure, request_id) values (p_donor, false, p_failure, p_request);
  end if;
  return jsonb_build_object('ok', false, 'failure', p_failure, 'message', case p_failure
    when 'invalid' then 'Invalid QR code. It wasn''t issued by EDIBELL or can''t be recognised.'
    when 'expired' then 'This QR code has expired. Ask the organization to contact you and re-arrange pickup.'
    when 'used' then 'This QR code was already used. The pickup has already been completed.'
    when 'cancelled' then 'This pickup was cancelled, so the QR code is no longer valid.'
    when 'mismatched' then 'This QR code belongs to a different donor''s listing. Do not hand over this food.'
    when 'not-accepted' then 'This request has not been accepted, so it can''t be completed.'
    when 'rate-limited' then 'Too many failed scans. Please wait a few minutes and try again.'
    else 'This pickup could not be verified.' end);
end $$;

-- The ONLY way a pickup becomes completed. Guess-like failures (invalid or
-- another donor's code) are rate limited: 8 in 10 minutes locks scanning.
-- Locks token, request and listing,
-- re-validates everything, and completes exactly once.
create or replace function public.verify_pickup(p_code text) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  me public.profiles := app.require_role(array['donor']);
  v_code text; t public.pickup_tokens; r public.requests; l public.listings; org public.profiles;
  kg numeric;
begin
  if (select count(*) from public.scan_attempts
      where donor_id = me.id and not ok and failure in ('invalid', 'mismatched')
        and created_at > now() - interval '10 minutes') >= 8 then
    return app.scan_failure(me.id, 'rate-limited');
  end if;
  v_code := app.parse_pickup_code(p_code);
  if v_code is null then return app.scan_failure(me.id, 'invalid'); end if;

  select * into t from public.pickup_tokens where token = v_code;
  if not found then return app.scan_failure(me.id, 'invalid'); end if;
  select * into r from public.requests where id = t.request_id;
  if r.donor_id <> me.id then return app.scan_failure(me.id, 'mismatched'); end if;

  -- Lock in the same order as decide_request / cancel_request: listing, request, token.
  select * into l from public.listings where id = r.listing_id for update;
  select * into r from public.requests where id = t.request_id for update;
  select * into t from public.pickup_tokens where request_id = r.id for update;

  if l.donor_id <> me.id then return app.scan_failure(me.id, 'mismatched', r.id); end if;
  if r.status = 'completed' or t.used_at is not null then return app.scan_failure(me.id, 'used', r.id); end if;
  if r.status in ('cancelled', 'declined') or l.status = 'cancelled' then return app.scan_failure(me.id, 'cancelled', r.id); end if;
  if r.status = 'expired' or t.expires_at < now() then return app.scan_failure(me.id, 'expired', r.id); end if;
  if r.status <> 'accepted' then return app.scan_failure(me.id, 'not-accepted', r.id); end if;

  -- All checks passed: complete exactly once.
  update public.pickup_tokens set used_at = now(), used_by = me.id where request_id = r.id;
  update public.requests set status = 'completed', completed_at = now(), updated_at = now() where id = r.id returning * into r;
  update public.listings set reserved = greatest(0, reserved - r.quantity), collected = collected + r.quantity,
    status = case when collected + r.quantity >= quantity then 'completed' else status end, updated_at = now()
  where id = l.id returning * into l;
  kg := app.to_kg(r.quantity, l.unit);
  insert into public.pickup_completions (request_id, listing_id, donor_id, recipient_id, recipient_role, destination,
    quantity, unit, kg_equivalent, category, animal_species, verified_by)
  values (r.id, l.id, l.donor_id, r.requester_id, r.requester_role, l.destination, r.quantity, l.unit, kg, l.category,
    case when cardinality(r.animal_species) > 0 then r.animal_species else l.animal_species end, me.id);
  insert into public.scan_attempts (donor_id, ok, request_id) values (me.id, true, r.id);

  select * into org from public.profiles where id = r.requester_id;
  perform app.notify(r.requester_id, 'pickup-completed', 'Pickup verified',
    format('%s %s of "%s" was handed over and verified by %s.', app.q(r.quantity), l.unit, l.title, me.org_name),
    app.recipient_link(r.requester_role, 'history'));
  perform app.notify(me.id, 'pickup-completed', 'Handover verified',
    format('%s collected %s %s of "%s".', org.org_name, app.q(r.quantity), l.unit, l.title), '/donor/donations');
  return jsonb_build_object('ok', true,
    'message', format('Pickup verified. %s %s of %s handed to %s.', app.q(r.quantity), l.unit, l.title, org.org_name),
    'request', app.request_dto(r, me.id));
end $$;

-- -----------------------------------------------------------------------------
-- Impact (from verified completions only)
-- -----------------------------------------------------------------------------
create or replace function public.my_impact() returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me(); out jsonb;
begin
  perform app.sweep();
  with c as (
    select * from public.pickup_completions pc
    where (case when me.role = 'donor' then pc.donor_id else pc.recipient_id end) = me.id
  ), k as (
    select coalesce(sum(kg_equivalent) filter (where destination = 'human'), 0) as human_kg,
           coalesce(sum(kg_equivalent) filter (where destination = 'animal'), 0) as animal_kg,
           count(*) as n from c
  )
  select jsonb_build_object(
    'totalDonations', (select count(*) from public.listings where donor_id = me.id),
    'completedDonations', (select count(*) from public.listings where donor_id = me.id and status = 'completed'),
    'totalFoodKg', (select coalesce(sum(app.to_kg(quantity, unit)), 0) from public.listings where donor_id = me.id),
    'completedFoodKg', k.human_kg + k.animal_kg,
    'humanFoodKg', k.human_kg, 'animalFeedKg', k.animal_kg,
    'mealsSupported', round(k.human_kg / 0.4),
    'co2eAvoidedKg', round((k.human_kg + k.animal_kg) * 2.5, 1),
    'completedPickups', k.n,
    'pendingRequests', (select count(*) from public.requests
       where status = 'pending' and (case when me.role = 'donor' then donor_id else requester_id end) = me.id),
    'acceptedRequests', (select count(*) from public.requests
       where status = 'accepted' and (case when me.role = 'donor' then donor_id else requester_id end) = me.id),
    'activeListings', (select count(*) from public.listings l where donor_id = me.id and app.availability(l) = 'available'),
    'byCategory', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'kg', kg) order by kg desc)
       from (select category, sum(kg_equivalent) kg from c group by category) s), '[]'::jsonb),
    'byMonth', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'kg', kg) order by m)
       from (select to_char(completed_at at time zone 'Asia/Kolkata', 'YYYY-MM') m, sum(kg_equivalent) kg from c group by 1) s), '[]'::jsonb),
    'bySpecies', coalesce((select jsonb_agg(jsonb_build_object('species', sp, 'kg', round(kg, 3)) order by kg desc)
       from (select sp, sum(kg_equivalent / greatest(1, cardinality(animal_species))) kg
             from c, unnest(animal_species) sp where destination = 'animal' group by sp) s), '[]'::jsonb),
    'byPartner', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kg', kg, 'pickups', n) order by kg desc)
       from (select p.org_name name, sum(c.kg_equivalent) kg, count(*) n from c
             join public.profiles p on p.id = case when me.role = 'donor' then c.recipient_id else c.donor_id end
             group by p.org_name) s), '[]'::jsonb),
    'assumptions', jsonb_build_array(
      'Only pickups completed by a server-verified QR scan are counted. Listed, requested or accepted food is not.',
      'Quantities are converted to kg-equivalent: 1 kg = 1 kg, 1 g = 0.001 kg, 1 litre ≈ 1 kg, 1 ml ≈ 0.001 kg, 1 portion ≈ 0.4 kg, 1 piece ≈ 0.1 kg, 1 packet ≈ 0.25 kg, 1 tray ≈ 3 kg.',
      'Meals supported (estimate) = kg-equivalent of completed HUMAN-food pickups ÷ 0.4 kg per meal. Actual portion sizes vary.',
      'CO₂e avoided (estimate) ≈ 2.5 kg CO₂e per kg of food — a rule-of-thumb figure for illustration, not a measured or certified reduction.'))
  into out from k;
  return out;
end $$;

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------
create or replace function public.list_notifications(p_limit int default 100) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me();
begin
  perform app.sweep();
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'title', n.title, 'body', n.body,
      'link', n.link, 'read', n.read_at is not null, 'createdAt', n.created_at) order by n.created_at desc)
    from (select * from public.notifications where user_id = me.id order by created_at desc limit least(greatest(p_limit, 1), 200)) n),
    '[]'::jsonb);
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me();
begin
  update public.notifications set read_at = now()
  where user_id = me.id and read_at is null and (p_ids is null or id = any (p_ids));
end $$;

-- -----------------------------------------------------------------------------
-- Animal feed needs
-- -----------------------------------------------------------------------------
create or replace function public.create_animal_need(p jsonb) returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['animal']); n public.animal_needs; r record;
begin
  insert into public.animal_needs (org_id, title, species, animal_count, categories, quantity_per_week, unit, notes)
  values (me.id, app.txt(p, 'title', 'Title', true, 120),
    app.list(p, 'species', 'Species', app.animal_species()),
    app.num(p, 'animalCount', 'Number of animals', true, 1, 1000000)::int,
    app.list(p, 'categories', 'Preferred food types', app.animal_categories()),
    app.num(p, 'quantityPerWeek', 'Quantity per week', true, 0.1, 1000000),
    app.one_of(p, 'unit', app.units(), 'Unit'), app.txt(p, 'notes', 'Notes', false, 600))
  returning * into n;
  for r in select id from public.profiles where role = 'donor' and lower(city) = lower(me.city) loop
    perform app.notify(r.id, 'animal-need', 'Animal feed needed nearby',
      format('%s needs feed for %s.', me.org_name, array_to_string(n.species, ', ')), '/donor');
  end loop;
  return app.need_dto(n);
exception when check_violation then
  perform app.fail('Select at least one species.', '22023');
end $$;

create or replace function public.list_animal_needs(p_scope text default 'open') returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.me();
begin
  if p_scope = 'mine' then
    if me.role <> 'animal' then perform app.fail('Your account type can''t use this feature.', '42501'); end if;
    return coalesce((select jsonb_agg(app.need_dto(n) order by n.created_at desc) from public.animal_needs n where n.org_id = me.id), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(app.need_dto(n) order by n.created_at desc)
    from (select * from public.animal_needs where status = 'open' order by created_at desc limit 50) n), '[]'::jsonb);
end $$;

create or replace function public.close_animal_need(p_id uuid) returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_role(array['animal']);
begin
  update public.animal_needs set status = 'closed' where id = p_id and org_id = me.id;
  if not found then perform app.fail('Feed request not found.', 'P0002'); end if;
end $$;

-- -----------------------------------------------------------------------------
-- Administration (only profiles with is_admin = true, granted by an operator)
-- -----------------------------------------------------------------------------
create or replace function public.admin_overview() returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare me public.profiles := app.require_admin();
begin
  perform app.sweep();
  return jsonb_build_object(
    'pendingOrganizations', coalesce((select jsonb_agg(app.user_dto(p) || jsonb_build_object('documents',
        coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'docType', d.doc_type, 'path', d.storage_path, 'fileName', d.file_name, 'createdAt', d.created_at))
                  from public.org_documents d where d.org_id = p.id), '[]'::jsonb)) order by p.created_at)
      from public.profiles p where p.verification_status = 'pending' and not p.is_admin), '[]'::jsonb),
    'reviewQueue', coalesce((select jsonb_agg(app.listing_dto(l, me.id, true) order by l.created_at)
      from public.listings l where l.review_status = 'pending_review' and l.status = 'active'), '[]'::jsonb),
    'totals', jsonb_build_object(
      'organizations', (select count(*) from public.profiles where not is_admin),
      'verified', (select count(*) from public.profiles where verification_status = 'verified' and not is_admin),
      'activeListings', (select count(*) from public.listings where status = 'active'),
      'completedPickups', (select count(*) from public.pickup_completions),
      'humanFoodKg', (select coalesce(sum(kg_equivalent), 0) from public.pickup_completions where destination = 'human'),
      'animalFeedKg', (select coalesce(sum(kg_equivalent), 0) from public.pickup_completions where destination = 'animal')));
end $$;

create or replace function public.admin_set_verification(p_org uuid, p_status text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := app.require_admin(); p public.profiles;
begin
  if p_status not in ('verified', 'rejected', 'pending') then perform app.fail('Status is not valid.', '22023'); end if;
  update public.profiles set verification_status = p_status, verification_note = left(coalesce(p_note, ''), 400),
    verified_at = case when p_status = 'verified' then now() end, verified_by = case when p_status = 'verified' then me.id end,
    updated_at = now()
  where id = p_org and not is_admin returning * into p;
  if not found then perform app.fail('Organization not found.', 'P0002'); end if;
  perform app.notify(p.id, 'verification',
    case p_status when 'verified' then 'Organization verified' when 'rejected' then 'Verification not approved' else 'Verification pending' end,
    case p_status when 'verified' then 'EDIBELL has verified your organization.'
      else coalesce(nullif(left(p_note, 400), ''), 'Please review your registration details and documents.') end, '');
  return app.user_dto(p);
end $$;

create or replace function public.admin_review_listing(p_id uuid, p_decision text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.profiles := app.require_admin(); l public.listings; r record;
begin
  if p_decision not in ('approve', 'reject') then perform app.fail('Decision is not valid.', '22023'); end if;
  update public.listings set review_status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    review_note = left(coalesce(p_note, ''), 400), reviewed_at = now(), reviewed_by = me.id, updated_at = now()
  where id = p_id and review_status = 'pending_review' returning * into l;
  if not found then perform app.fail('Listing not found or already reviewed.', 'P0002'); end if;
  perform app.notify(l.donor_id, 'listing-review',
    case when p_decision = 'approve' then 'Listing approved for animal feed' else 'Listing not approved for animal feed' end,
    format('"%s": %s', l.title, coalesce(nullif(left(p_note, 400), ''),
      case when p_decision = 'approve' then 'it is now visible to animal welfare organizations.' else 'it will not be offered as feed.' end)),
    '/donor/donations');
  if p_decision = 'approve' then
    for r in select id from public.profiles p where p.role = 'animal' and lower(p.city) = lower(l.city) and p.species && l.animal_species loop
      perform app.notify(r.id, 'new-donation', 'Animal feed available nearby',
        format('%s · %s %s in %s, %s', l.title, app.q(l.quantity), l.unit, l.area, l.city), '/animal/finder');
    end loop;
  end if;
  return app.listing_dto(l, me.id, true);
end $$;

-- Optional scheduled housekeeping (see README: pg_cron). Safe to call anytime.
create or replace function public.run_housekeeping() returns void language plpgsql security definer
set search_path = public, pg_temp as $$
begin perform app.sweep(); end $$;

-- -----------------------------------------------------------------------------
-- Grants: browser clients may call only these functions.
-- -----------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
grant execute on function public.public_stats() to anon, authenticated;
grant execute on function
  public.get_my_profile(), public.update_my_profile(jsonb), public.add_org_document(text, text, text), public.list_my_documents(),
  public.create_listing(jsonb), public.update_listing(uuid, jsonb), public.cancel_listing(uuid, text), public.list_my_listings(),
  public.browse_listings(jsonb), public.get_listing(uuid),
  public.create_request(jsonb), public.list_my_requests(text), public.decide_request(uuid, text, text), public.cancel_request(uuid),
  public.get_pickup_pass(uuid), public.verify_pickup(text), public.my_impact(),
  public.list_notifications(int), public.mark_notifications_read(uuid[]),
  public.create_animal_need(jsonb), public.list_animal_needs(text), public.close_animal_need(uuid),
  public.admin_overview(), public.admin_set_verification(uuid, text, text), public.admin_review_listing(uuid, text, text)
to authenticated;
grant execute on function public.run_housekeeping() to service_role;


-- ===================== 20261028120300_edibell_storage_realtime.sql =====================
-- =============================================================================
-- EDIBELL — Storage buckets, storage policies and Realtime
-- =============================================================================

-- Food photos: publicly readable by URL (paths contain random UUIDs and food
-- photos contain no personal data), max 5 MB, images only. Only donors can
-- upload, and only into their own "<user id>/" folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('food-photos', 'food-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Verification documents: private, max 10 MB, PDF or images. Owner and
-- EDIBELL administrators only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-documents', 'org-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.current_role() returns text language sql stable security definer
set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid()
$$;
revoke all on function app.current_role() from public;
grant usage on schema app to authenticated;
grant execute on function app.current_role(), app.is_admin() to authenticated;

drop policy if exists "food-photos: donors upload to own folder" on storage.objects;
create policy "food-photos: donors upload to own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'food-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select app.current_role()) = 'donor'
  );

drop policy if exists "food-photos: owners read" on storage.objects;
create policy "food-photos: owners read" on storage.objects
  for select to authenticated
  using (bucket_id = 'food-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "food-photos: owners delete unused" on storage.objects;
create policy "food-photos: owners delete unused" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'food-photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not exists (select 1 from public.listing_photos lp where lp.storage_path = name)
  );

drop policy if exists "org-documents: owner upload" on storage.objects;
create policy "org-documents: owner upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'org-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "org-documents: owner or admin read" on storage.objects;
create policy "org-documents: owner or admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'org-documents'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or (select app.is_admin())));

-- Realtime: notifications are pushed to the signed-in user (RLS applies).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'notifications') then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end $$;


-- ===================== 20261029060000_edibell_fixed_search_path.sql =====================
-- Security hardening suggested by the Supabase advisor (lint 0011):
-- pin search_path on every helper function in schema `app` that doesn't set one.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;


-- ===================== 20261030150000_edibell_contact_messages.sql =====================
-- Contact Us messages from the public website.
-- Visitors (signed in or not) submit through public.submit_contact_message();
-- nobody can read the table directly. Only EDIBELL administrators can list
-- messages and change their status, through the admin_* functions below.

create table if not exists public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 100),
  email       text not null check (char_length(email) between 6 and 254),
  subject     text not null check (char_length(subject) between 3 and 150),
  message     text not null check (char_length(message) between 10 and 4000),
  status      text not null default 'new' check (status in ('new', 'read', 'archived')),
  user_id     uuid references auth.users (id) on delete set null,
  sender_hash text not null default '',          -- sha-256 of the sender's network address (never the address itself)
  created_at  timestamptz not null default now(),
  handled_by  uuid references auth.users (id) on delete set null,
  handled_at  timestamptz
);
create index if not exists contact_messages_created_idx on public.contact_messages (created_at desc);
create index if not exists contact_messages_email_idx on public.contact_messages (lower(email), created_at desc);
create index if not exists contact_messages_sender_idx on public.contact_messages (sender_hash, created_at desc);

alter table public.contact_messages enable row level security;
revoke all on public.contact_messages from public, anon, authenticated;

-- ---------------------------------------------------------------------------
create or replace function public.submit_contact_message(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_name    text := app.txt(p, 'name', 'Name', true, 100);
  v_email   text := lower(app.txt(p, 'email', 'Email', true, 254));
  v_subject text := app.txt(p, 'subject', 'Subject', true, 150);
  v_message text := app.txt(p, 'message', 'Message', true, 4000);
  v_trap    text := btrim(coalesce(p ->> 'website', ''));   -- hidden field: only bots fill it in
  v_ip      text;
  v_hash    text := '';
  v_row     public.contact_messages;
begin
  if char_length(v_name) < 2 then perform app.fail('Please enter your name.', '22023'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then perform app.fail('Please enter a valid email address.', '22023'); end if;
  if char_length(v_subject) < 3 then perform app.fail('Please enter a subject (at least 3 characters).', '22023'); end if;
  if char_length(v_message) < 10 then perform app.fail('Please write a message of at least 10 characters.', '22023'); end if;
  if v_trap <> '' then perform app.fail('Your message could not be sent.', '22023'); end if;

  begin
    v_ip := btrim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1));
  exception when others then v_ip := '';
  end;
  if v_ip <> '' then v_hash := encode(extensions.digest(v_ip, 'sha256'), 'hex'); end if;

  -- Abuse limits: per email, per network address, and overall.
  if (select count(*) from public.contact_messages where lower(email) = v_email and created_at > now() - interval '1 hour') >= 3
     or (v_hash <> '' and (select count(*) from public.contact_messages where sender_hash = v_hash and created_at > now() - interval '1 hour') >= 5) then
    perform app.fail('You''ve sent several messages recently. Please wait a while before sending another.', '22023');
  end if;
  if (select count(*) from public.contact_messages where created_at > now() - interval '1 hour') >= 300 then
    perform app.fail('We''re receiving a lot of messages right now. Please try again later or email us directly.', '22023');
  end if;

  insert into public.contact_messages (name, email, subject, message, user_id, sender_hash)
  values (v_name, v_email, v_subject, v_message, auth.uid(), v_hash)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'receivedAt', v_row.created_at);
end $$;

-- ---------------------------------------------------------------------------
create or replace function public.admin_list_contact_messages(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_admin();
  if p_status not in ('open', 'new', 'read', 'archived', 'all') then perform app.fail('Unknown message filter.', '22023'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'email', m.email, 'subject', m.subject, 'message', m.message,
      'status', m.status, 'createdAt', m.created_at, 'handledAt', m.handled_at,
      'fromAccount', m.user_id is not null) order by m.created_at desc)
    from (select * from public.contact_messages
          where p_status = 'all' or (p_status = 'open' and status <> 'archived') or status = p_status
          order by created_at desc limit 200) m), '[]'::jsonb);
end $$;

create or replace function public.admin_set_contact_message_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.profiles := app.require_admin(); v_row public.contact_messages;
begin
  if p_status not in ('new', 'read', 'archived') then perform app.fail('Unknown message status.', '22023'); end if;
  update public.contact_messages
     set status = p_status,
         handled_by = case when p_status = 'new' then null else a.id end,
         handled_at = case when p_status = 'new' then null else now() end
   where id = p_id returning * into v_row;
  if not found then perform app.fail('Message not found.', 'P0002'); end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end $$;

revoke all on function public.submit_contact_message(jsonb) from public, anon, authenticated;
revoke all on function public.admin_list_contact_messages(text) from public, anon, authenticated;
revoke all on function public.admin_set_contact_message_status(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_contact_message(jsonb) to anon, authenticated;
grant execute on function public.admin_list_contact_messages(text) to authenticated;
grant execute on function public.admin_set_contact_message_status(uuid, text) to authenticated;


commit;
