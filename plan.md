# EDIBELL Food Rescue — Implementation Plan

## Scope and approach

Recreate the supplied EDIBELL reference as a multi-route, responsive React website, rather than a static screenshot. Include the 12 shown frontend states as pages or meaningful route states: Home; Login; Register/account type selection; Donor Dashboard; Create Food Donation (Food Details); Pickup Details & Food Safety Information; Food Safety & Destination Screening; NGO Available Food Marketplace; NGO Requests & QR Code; Donation Details & OTP/QR Confirmation; Admin Dashboard; and Impact Analytics. Use sample content matching the labels and example values visible in the reference. Navigation, form fields, selectors, tabs, request actions, and step progression should work as local frontend demo interactions. No real authentication, server-side mutation, or persisted donation data is requested; the project remains static with no database or server service.

Use the initialized React 19, TypeScript, Vite, Wouter, Tailwind 4 and lucide-react stack. Build reusable page-shell, public-header, dashboard-sidebar, card, statistic, status, table, stepper, form-field and food-tile components. Implement route-specific compositions in focused page/component files; keep shared data in a small frontend fixture module. Use lightweight SVG/CSS leaf marks and QR-like visual treatment; generate custom food imagery for the landing hero and distinct food listing imagery. Keep the route declarations in `public/manus-routes.json` synchronized with the router.

## Role separation extension

Expose exactly three account tracks in onboarding: Food Donor, NGO Partner, and Animal Welfare Organization. Account creation collects the chosen role and account name/email, saves a demo role profile locally without persisting passwords, and opens that role's own portal. Login requires the user to select the account type and routes a matching demo profile to the same role-specific landing dashboard. Keep donor, NGO partner, and animal-welfare navigation/content separated instead of combining all three feature sets in one dashboard. Add a dedicated NGO home at `/ngo` and an animal-welfare portal at `/animal`, with separate animal requirements, available feed, requests, received feed, and notifications routes; preserve existing donor, NGO request/marketplace, admin, and impact pages. Retain the established cream-and-forest EDIBELL visual system and responsive shell.

## Design

- **Design movement:** restrained eco-tech dashboard inspired directly by the supplied EDIBELL interface, with a light editorial food-rescue landing page and compact enterprise-style internal tools.
- **Core principles:** recognizable visual fidelity to the screenshot; high information density with clear grouping; green-coded safety/status; responsive behavior without losing desktop dashboard structure.
- **Color philosophy:** warm ivory/cream canvas and white-green-tinted cards keep the system calm and food-centered; deep forest green signals action, trust and verified donation; fresh leaf green and pale sage serve as soft secondary accents; muted amber/red are reserved for pending or safety states.
- **Layout paradigm:** a simple public header and asymmetric hero lead into impact/category bands; authenticated views use the screenshot's persistent dark-green vertical sidebar, slim topbar, and compact card/table workspace. Multi-step donation screens use a horizontal numbered stepper and two-column forms.
- **Signature elements:** a paired-leaf EDIBELL emblem and thin green rules; square, thin-bordered white cards with soft green-tinted surfaces; green pill status chips and compact numbered workflow markers.
- **Interaction philosophy:** direct, quiet feedback; prominent green primary actions; visible selected/current steps; inline completion states and restrained hover/focus affordances.
- **Animation:** near-static, matching the reference; subtle 150–200 ms color/elevation transitions, no looping movement or parallax.
- **Typography system:** Inter or a metrically similar sans-serif throughout; medium-weight compact labels, bold forest-green headlines and dashboard numerals, small readable muted metadata.
- **Brand essence:** a clear, reliable bridge moving surplus food from donors to local NGOs; **practical, caring, trustworthy**.
- **Brand voice:** concise and constructive. Examples: “Good food deserves a second chance.” “A better pickup starts with clear food-safety details.”
- **Wordmark & logo:** an original paired-leaf symbol beside the EDIBELL wordmark, implemented as a crisp inline vector/CSS mark rather than relying on generated text.
- **Signature brand color:** deep forest green `#006b50` (paired with warm ivory `#fbfaf1` and soft sage `#e8f2e7`).

## Project structure

- `client/src/App.tsx`: route table and shared app providers.
- `client/src/components/`: reusable brand mark, public navigation, dashboard shell, cards, workflow steps, forms, status pills and QR presentation.
- `client/src/pages/`: dedicated page modules for public, donor, NGO, safety and admin/impact views.
- `client/src/data/`: sample donors, food donations, pickup and analytics fixture data.
- `client/src/index.css`: global reference palette, typography, responsive layout and component styling.
- `client/public/`: generated hero/food assets and the static route manifest.

## Build workflow

After plan approval, record the request's outcomes in `TODO.md`, generate only planned food visuals, implement the routes and shared components, register or confirm TypeScript diagnostics, start the configured static Vite preview, and run type/build checks. Inspect the generated source and route manifest against the requested screen set, correct issues, then save the completed project checkpoint. Publishing is separate and will not be enabled without the user's direction.
