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
