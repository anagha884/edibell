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
