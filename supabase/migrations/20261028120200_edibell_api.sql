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
