# EDIBELL Food Rescue

EDIBELL connects **food donors** (messes, hotels, restaurants, caterers, bakeries…) with **NGO partners** and **animal welfare organizations**. Donors publish surplus food. Recipients request it. The donor accepts, and the recipient gets a single-use **Pickup Pass QR**. At handover the donor scans it, and the database verifies the pickup and completes it exactly once.

- **Frontend:** React 19 + TypeScript + Vite + Tailwind. This is the existing EDIBELL design, kept as it was.
- **Backend:** Supabase. It provides PostgreSQL with Row Level Security, Auth, Storage and Realtime. All business rules live in SQL migrations under `supabase/migrations/`.
- **Maps:** Google Maps Platform, using the Maps JavaScript API, Places API (New) and the Geocoding API.
- **QR:** `qrcode` generates the code and `jsqr` reads it from the camera or a photo.

There is **no demo or seed data**. A new install starts empty, and every number on screen comes from real records.

---

## 1. Portals

| Role | Navigation |
|---|---|
| Food Donor `/donor` | Dashboard · Share Surplus Food · Incoming Requests · My Food Listings · **Verify Pickup** (QR scanner) · Notifications · Our Impact · Organization Settings |
| NGO Partner `/ngo` | Dashboard · Discover Food · My Food Requests · **Pickup Pass** (QR display) · Collection History · Notifications · Our Impact · Organization Profile |
| Animal Welfare `/animal` | Dashboard · Discover Animal Feed · My Feed Requests · **Pickup Pass** · Collection History · Notifications · Our Impact · Animal Care Profile (species, care requirements, feed needs) |
| Administrator `/admin` | Organization verification and animal-feed safety review. Only for profiles an operator grants `is_admin` (see §6). |

Public pages: `/` (homepage, unchanged, plus a sourced "Why it matters" section), `/why-food-rescue`, `/login`, `/register`, `/forgot-password` and `/reset-password`.

## 2. How the rules are enforced

The route guards in the browser only make the app easier to use. **The database is what enforces security.**

- **RLS on every table.** Browser roles can only `SELECT` their own rows. Every write goes through a `SECURITY DEFINER` function with a fixed `search_path`. Each function checks `auth.uid()` and the caller's role, validates the input, and runs as one transaction with row locks.
- **Sign-up.** A trigger on `auth.users` creates the profile. The account type can only be `donor`, `ngo` or `animal`, so admin can't be chosen at sign-up. Every new organization starts as `verification_status = 'pending'`.
- **Human and animal eligibility are separate.** `listings.eligible_for_humans` and `eligible_for_animals` are explicit columns, and a CHECK constraint ties them to the declared pathway. Food is never moved from one pathway to the other. Plate leftovers can't go to people. Plate leftovers and meat or fish scraps offered as animal feed are held as `pending_review` until an administrator approves them.
- **No over-allocation.** `decide_request` locks the listing row, re-checks the remaining stock and reserves it. The constraint `reserved + collected <= quantity` backs this up.
- **QR passes.** Each code is 100 bits from `gen_random_bytes`. Accepting a request creates exactly one code, stored in `pickup_tokens`, which has no RLS policy, so no client can read it directly. It expires 30 minutes after the pickup window ends; this is configurable in `app_config`. `verify_pickup` is donor-only. It locks the listing, request and token rows and checks that:
  - the code is genuine;
  - it belongs to this donor;
  - the request is accepted;
  - the code is unused, not expired and not cancelled.

  Only then does it complete the pickup. A unique `pickup_completions.request_id` means one handover can never be counted twice. Eight guess-like failures in 10 minutes lock scanning.
- **Impact.** Impact figures are computed only from `pickup_completions`. Unit conversions are documented in `shared/edibell.ts` and `app.to_kg()`, and a unit test checks that the two match. Meals and CO₂e are shown as labelled estimates.

## 3. Setup

### 3.1 Install
```bash
pnpm install          # Node 22+ (required by supabase-js) and pnpm 10 (corepack enable)
cp .env.example .env.local
```

### 3.2 Create the Supabase project (needs your account)
1. Create a project at https://supabase.com/dashboard. Choose a region near your users, for example Mumbai (`ap-south-1`).
2. Open `proj/.env.local` (it must sit in the `proj` folder, next to `package.json`; Vite reads it only at startup). In the dashboard, use **Connect** at the top of the project page (or **Project Settings → API / API Keys**):
   - copy the **Project URL** (`https://<project-ref>.supabase.co`) into `VITE_SUPABASE_URL`;
   - copy the **publishable** key (`sb_publishable_…`), or the legacy **anon public** key, into `VITE_SUPABASE_ANON_KEY`.

   Never use the **secret** (`sb_secret_…`) or **service_role** key. The app refuses to start with one, and `pnpm check:supabase` flags it.
3. **Apply the migrations.** Choose one of these:
   - **Supabase CLI:**
     ```bash
     npx supabase login
     npx supabase init                       # only if supabase/config.toml doesn't exist; keep existing migrations
     npx supabase link --project-ref YOUR-PROJECT-REF
     npx supabase db push                    # applies supabase/migrations/*.sql in order
     ```
   - **SQL Editor (no CLI needed):** open **SQL Editor → New query**, paste the whole of `supabase/setup_all.sql` and click **Run**. It contains all four migrations in order and runs as one transaction, so if anything fails nothing is applied. Run it only once, on a new project. Regenerate it with `pnpm db:bundle` if you change the migrations.
   - Then run `pnpm check:supabase`. It checks the URL and key, the migrations, the storage buckets, anonymous access and the Auth settings, using only the public key. It never prints your keys.
4. **Storage.** The last migration creates the buckets `food-photos` (public read, 5 MB, JPEG/PNG/WebP, donors upload to their own folder) and `org-documents` (private, 10 MB, PDF or images). It also creates their policies. Check them under **Storage**.
5. **Realtime.** The migration adds `public.notifications` to the `supabase_realtime` publication, so the bell updates instantly. If you see no live updates, check **Database → Publications**. The app polls every 60 s as a fallback.
6. **Auth** (Authentication → Providers / URL Configuration):
   - Keep **Email** enabled. Leaving **Confirm email** ON is recommended. The register page then shows "Confirm your email".
   - **Site URL:** your production URL, for example `https://edibell.example.org`.
   - **Redirect URLs:** add `http://localhost:3000/**` and `https://YOUR-DOMAIN/**`. Password reset lands on `/reset-password` and email confirmation on `/login?confirmed=1`.
   - **SMTP:** Supabase's built-in email service is rate-limited and meant for testing. Before launch, configure a real SMTP provider under **Authentication → SMTP Settings**. Until then, confirmation and reset emails may be limited.
   - Set the minimum password length to 8 and consider enabling leaked-password protection.
7. **Optional housekeeping schedule.** Expiry, pickup reminders and food-safety alerts already run at the start of the main API calls. To run them even when nobody is using the app, enable the `pg_cron` extension and schedule:
   ```sql
   select cron.schedule('edibell-housekeeping', '*/10 * * * *', $$select public.run_housekeeping()$$);
   ```

### 3.3 Address search and map (Geoapify, free plan, no card)
1. Sign up at https://myprojects.geoapify.com (email only), create a project and copy its **API key**.
2. In the key's settings, restrict **Allowed origins** to `http://localhost:3000` and later `https://YOUR-DOMAIN`.
3. Put the key in `VITE_GEOAPIFY_API_KEY` in `proj/.env.local` and restart `pnpm dev`.

The free plan gives 3,000 credits per day: 1 per address-search request (debounced, starts at 3 characters), 0.25 per map tile, and 1 per pin-to-address lookup. The free plan requires the "Powered by Geoapify" credit, which is shown in the map corner with the OpenStreetMap/OpenMapTiles credits. If the daily limit is reached, the app says so and donors type the address instead.

Without a key, the pickup picker shows a clear "not configured" message and donors type the address instead. Recipients always get Google Maps **directions links**, which are free and need no key.

Address search is used only to find addresses. A business that appears in the map data is never shown as an EDIBELL donor; only registered donors' listings appear.

### 3.4 Run
```bash
pnpm dev          # http://localhost:3000
pnpm check        # TypeScript
pnpm test         # unit + client↔database contract tests
pnpm build        # → dist/public (static site)
pnpm start        # preview the production build
```
Camera scanning needs HTTPS or `localhost`. On phones, use the deployed HTTPS site. Verify Pickup also accepts a photo of the QR or the typed 20-character code. Both go through the same server verification.

## 4. Deploy

The frontend is a static single-page app; Supabase is the backend.
- **Vercel:** import the repo with root `proj/`. `vercel.json` is included. Set the three `VITE_*` variables for Production and Preview.
- **Netlify:** `netlify.toml` is included. Set the same variables.
- **Docker / any static host:** see the `Dockerfile`. It's an nginx image with an SPA fallback, and `VITE_*` values are passed as build args.

After deploying:
1. Add the domain to the Supabase Auth Site URL and Redirect URLs.
2. Add it to the Google key's referrer list.
3. Make sure the site is served over HTTPS (Vercel and Netlify do this automatically).

## 5. Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit / contract | `pnpm test` | Every RPC the browser calls exists in the migrations with matching argument names; pickup-code parsing; kg factors match SQL. |
| Database | `pnpm test:db` | Runs the real migrations on a local PostgreSQL 15/16, behind a small Supabase shim (`tests/db/supabase-shim.sql`: `auth.uid()`, roles, storage tables). It calls the functions exactly as PostgREST does: `SET LOCAL ROLE` plus JWT claims. 34 tests cover registration rules, RLS isolation, direct-write denial, listing validation, eligibility and review, request/accept/decline/cancel, the full QR flow, invalid/expired/used/foreign/cancelled QR codes, simultaneous acceptances and scans, rate limiting, impact counted once, reminders, and admin verification. Needs `PGHOST`/`PGPORT`/`PGUSER` pointing at a local PostgreSQL. |
| Browser end to end | `tests/e2e/run.sh` | Drives the real UI with Playwright (`pnpm add -D playwright && npx playwright install chromium`). It runs against the migrations through `tests/e2e/local-supabase.mjs`, a **test-only** stand-in for the Supabase HTTP gateway. 29 checks cover: registering all three roles, role isolation, session persistence, publishing with a photo, review, request, notification, acceptance, the Pickup Pass QR, rejecting an invalid code, scanning the real QR image, rejecting a re-scan, history, impact and public stats, and the animal-feed pathway. `tests/e2e/map.e2e.mjs` (10 checks) drives the address search, map pin and pin-to-address lookup with Geoapify's responses stubbed. Run `pnpm dev` with `.env.local` pointing `VITE_SUPABASE_URL=http://localhost:54321` first. |

| Translations | `pnpm check:i18n` | Every interface text (including database messages and notification templates) has a Kannada and Hindi entry with the same `{placeholders}`. `tests/e2e/i18n.e2e.mjs` (part of `run.sh`) checks the language selector, persistence and layout, and scans every page in both languages for English left behind. |

**Languages.** The interface is in English (default), Kannada and Hindi. Texts are written in English in the code and wrapped in `tr("…")`. Translations are in `client/src/i18n/kn.ts` and `hi.ts`, keyed by that English text. Database messages are stored in English and translated when shown (`client/src/i18n/server.ts`). Names, food descriptions, addresses and messages are always shown as typed. To add a language, add it to `LANGS` in `client/src/i18n/index.tsx` and add a dictionary file. `pnpm check:i18n` lists anything missing.

These tests exercise the real SQL and the real frontend. They do **not** prove that a hosted Supabase project, its email delivery, Realtime socket or Geoapify key work. Check those after you configure your accounts (§3.2–3.3).

## 6. Operations

**Contact details and Contact Us messages.** EDIBELL's official email and phone number are defined in one place, `client/src/config/contact.ts`; the footer and the "Get in Touch" section read them from there. Messages sent through the form are stored in `public.contact_messages` by `public.submit_contact_message` (migration `20261030150000_edibell_contact_messages.sql`), which validates every field, ignores bots that fill a hidden field, and limits repeat sends (3 per email and 5 per network address per hour; only a SHA-256 hash of the address is stored). Nobody can read the table directly: administrators read, archive and reply to messages under **Administration → Contact messages**. Email notifications are not sent yet; adding them later needs an email provider (e.g. Resend) and a Supabase Edge Function or database webhook.


**Make someone an administrator.** Have them register normally, then run this in the SQL editor:
```sql
update public.profiles set is_admin = true where email = 'ops@your-org.org';
```
Administrators see **Administration** in their sidebar. There they can:
- verify or decline organizations, after viewing uploaded documents through short-lived signed URLs;
- approve or reject animal-feed listings that need a safety review.

**Require verification before use** (off by default):
```sql
update public.app_config set require_verified_recipients = true, require_verified_donors = true;
```

**Change the QR validity after the pickup window:**
```sql
update public.app_config set qr_grace_minutes = 30;
```

## 7. Data model (supabase/migrations)

| Object | Purpose |
|---|---|
| `profiles` | Organization per auth user: role, contact details, address/service area, species and care requirements, verification status, `is_admin` |
| `org_documents` | Verification documents; the files are in the private `org-documents` bucket |
| `listings`, `listing_photos` | Food listings: safety checklist, explicit human/animal eligibility, review status, pickup address and coordinates, contact, stock (`quantity`/`reserved`/`collected`) |
| `requests` | Recipient requests; a partial unique index allows one live request per organization per listing |
| `pickup_tokens` | Single-use QR credentials (no client access) |
| `pickup_completions` | One row per server-verified handover; the only source for impact |
| `scan_attempts` | Audit and rate limiting of scans |
| `notifications` | Persistent per-user notifications, also sent over Realtime |
| `animal_needs` | Feed needs posted by animal welfare organizations |
| `app_config` | Operator settings |
| `public.*` functions | The API called with `supabase.rpc()`: `create_listing`, `update_listing`, `cancel_listing`, `browse_listings`, `create_request`, `decide_request`, `cancel_request`, `get_pickup_pass`, `verify_pickup`, `my_impact`, `list_notifications`, `mark_notifications_read`, `admin_*`, … |
| `app.*` | Private helpers: validation, DTO builders, sweep and reminders, code generation |

## 8. Known limitations and remaining manual steps

- **Hero photograph.** The homepage hero uses `client/public/hero-food.jpg`, the supplied photograph cropped to remove its white rounded border (1405×751 px, no other edits). `client/public/hero-food.svg` and `client/public/hero-food-photo.png` are no longer used and can be deleted. Food cards show the donor's own uploaded photo, or a neutral placeholder, never stock imagery.
- The supplied EDIBELL logo is `client/public/edibell-logo.png` (pixel-identical to the supplied image). It's used in the header, sidebar, auth pages and footer, and as the favicon.
- **Not automated:** email notifications (in-app notifications are complete), push notifications, and Google Places business discovery. There is no automated document check; verification is a manual admin review.
- The Discover distance filter uses the browser's location and the donor's map pin. Listings without a pin are never excluded by distance.
- The homepage awareness figures were last reviewed in October 2026. The India household figure (≈55 kg per person per year) is marked as coming from a secondary source, because the UNEP report annex couldn't be opened to confirm it. See `client/src/data/awareness.ts`.
- **Legacy files to delete.** The earlier JSON-file backend and the Manus template scaffolding are no longer used: `server/`, `data/`, `drizzle/`, `drizzle.config.ts`, `dist/`, `template.json`, `app.config.ts`, `.manus-starter-init.json`, `.manus-logs/`, `vite.config.ts.bak`, `brand-logo.svg`, `client/public/__manus__/`, `client/public/manus-routes.json`, `client/src/const.ts`, `client/src/platform.d.ts`, `client/src/lib/trpc.ts`, `client/src/_core/`, `client/src/components/{AIChatBox,ManusDialog,DashboardLayout,DashboardLayoutSkeleton}.tsx`, `client/src/pages/{ComponentShowcase,Home}.tsx`, `shared/const.ts`, `shared/types.ts` and `shared/_core/`. Delete them so they can't be deployed by mistake. `plan.md` and `TODO.md` describe the earlier prototype.
