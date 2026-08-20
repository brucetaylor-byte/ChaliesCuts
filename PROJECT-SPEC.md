# Charlie's Cuts — Project Spec

*Last updated: 20 August 2026*

## 1. What this is

Charlie's Cuts is a mobile-first booking web app for a small team of
independent freelance hairdressers - currently Charlie and Angus - who share
a chair/salon space at 36 Wyralla Crescent, Gisborne, 3437. Customers browse
each stylist's open half-hour slots and request a booking; the stylist
approves or declines before it's locked in. There's no online payment —
customers pay in person as they always have.

The app is deliberately simple: a single Node.js server, a SQLite database
(one file), and a plain HTML/CSS/JS frontend with no build step. It's built
to be cheap and easy to run for a small freelance team, not to scale to a
chain of salons. The team isn't fixed at two — Charlie can add further
stylists from his own dashboard (see section 3).

## 2. Who uses it

**Customers** — the general public. No account required to book (name +
email is enough), though they can optionally create a simple login to see
all their bookings in one place. They interact with the app entirely
through a phone browser.

**Stylists** — Charlie, Angus, and any further stylists Charlie adds, each
with their own login. Each manages their own availability, bio, social
links, and photo gallery, approves or declines their own booking requests,
and can see (read-only) every other stylist's calendar to coordinate who's
working when.

**Admin** — Charlie's account specifically is the one admin. This isn't a
separate login, just a flag on his existing account: he gets an extra
"Admin" tab on his dashboard (see section 3) that nobody else sees, used to
add further stylist logins. Angus and any stylist Charlie adds are regular
(non-admin) accounts with identical day-to-day features to each other.

## 3. Core features

**Availability management.** A stylist defines "blocks" of availability — a
date range, which days of the week they work, and a start/end time window —
and the app expands that into individual bookable 30-minute slots. Blocks
and their generated slots are grouped and displayed by week (this week
always expanded, next week collapsed, further weeks collapsed and listed
separately) so the list stays manageable even months out. A stylist can add
or remove blocks from within any given week without leaving that view.

**Booking flow (request → approve).** A customer picks an open slot, enters
their details, and submits a request. The slot immediately flips to
"pending" so it can't be double-booked while the stylist decides. The
stylist approves (slot becomes "booked") or declines (slot reopens) from
their dashboard's "Pending requests" list. Either party can cancel an
approved booking later, which reopens the slot.

**Customer-facing slot view.** The public booking page for each stylist only
shows currently open (bookable) slots — pending/booked slots are hidden
since they're not actionable to a visitor. Past dates are hidden. Slots are
grouped the same way as the stylist's own view: this week expanded, next
week collapsed, and any further weeks the stylist has opened up listed
individually underneath, collapsed by default.

**Calendar view (stylist dashboard).** A "My calendar" / "Other stylist"
toggle lets a stylist see either their own full calendar (including
pending/booked slots, for a complete picture of their day) or the other
stylist's calendar read-only. Both use the same this-week/next-week/later
week grouping as the availability and customer views, so the whole app is
consistent about how it breaks up time.

**Booking confirmation emails.** When a stylist approves a booking, the
customer automatically receives an email confirming the date/time, the
salon address (36 Wyralla Crescent, Gisborne, 3437), and a contact number
for each stylist — so they know exactly where to go without having to ask.
Declined and cancelled bookings also trigger a short notification email.
Emails are sent via a Gmail account (free, no separate email service
required) and are entirely optional — if no Gmail credentials are
configured, the app runs exactly the same way but skips sending email;
customers still get a private link to check their booking status at any
time.

**New booking request notifications (per stylist).** Each stylist has their
own booking notification email — set by Charlie when he registers them (see
"Managing stylists" below), and editable by the stylist themselves afterward
from their own Profile tab. Whenever a customer requests a slot, that
stylist's own notification email gets a message with the customer's details
and the requested time, so they know to check the dashboard's "Pending
requests" list — bookings for each stylist land in that stylist's own inbox,
not one shared one. This uses the same Gmail sending setup as the
confirmation emails above and is skipped the same way if it isn't
configured, or if a given stylist hasn't set a notification email yet.

**Accounts and privacy.** Customers can book anonymously — they get a
private, unguessable link (not tied to a login) to check status or cancel
later. Optionally, they can create a lightweight account (email + password)
to see every booking they've made in one place at `/my-bookings.html`.
Stylist accounts are separate logins, seeded initially and then managed by
each stylist (username, password, display name, bio, social links). The
login usernames are `charlie` and `angus` — these aren't shown to
customers anywhere, only the display name is.

**Profiles and social links.** Each stylist has a public bio and links to
Instagram, Facebook, TikTok, Snapchat, and/or a personal website, shown on
their booking page.

**Shared photo gallery.** Stylists can upload photos (e.g. of their work) to
a shared gallery; uploads are scoped to whichever stylist is logged in when
they upload, and photos can be deleted by their owner.

**Managing stylists (admin only).** Charlie's dashboard has an extra "Admin"
tab, hidden from everyone else, with three panels:

- *Active stylists* — every current stylist (Charlie included), with a
  "Reset password" button that sets a new password directly (no need to
  know the old one — useful if someone's locked out), and a "Remove" button
  on everyone except Charlie's own admin row, which can never be removed.
- *Add a stylist* — a form (display name, username, temporary password, and
  a booking notification email) that creates a brand-new stylist login with
  its own calendar, availability, bookings, gallery and profile — identical
  day-to-day features to Charlie and Angus, just without admin access. The
  notification email is required at creation (it's where that stylist's new
  booking requests get sent — see "New booking request notifications"
  above) and the stylist can update it themselves later from their own
  Profile tab. New stylists show up in the Active stylists list and the
  dashboard's calendar toggle immediately, no page reload needed.
- *Customer accounts* — everyone who's created a customer login (not
  people who've only booked anonymously), with "Reset password" and
  "Delete" per account.

Removing a stylist is a soft removal, not a hard delete: their account
just stops being able to log in (any existing session is invalidated
immediately too, not just future logins) and disappears from the public
booking page and every "other stylist" calendar view, but their past
bookings, availability history and gallery photos are all kept. If a
removed stylist has upcoming pending/approved bookings, Charlie is asked
to confirm first — confirming cancels those bookings and emails the
affected customers the same cancellation notice used elsewhere in the app.
Deleting a customer account is a genuine delete, but their past bookings
stay intact (a booking already stores the customer's name/email directly,
independent of whether their account still exists).

The dashboard's calendar view ("My calendar" / other stylists) and the
public homepage's stylist list both already scale to any number of active
stylists, not just two — adding a third or fourth doesn't need any further
changes. New stylists should change their temporary password from their
own Profile tab after logging in for the first time.

## 4. What's deliberately out of scope (v1)

- **No online payments.** Everything is pay-in-person, as it is today. The
  `bookings` table has room to add a `payment_status` column later if a
  deposit-via-Stripe-Checkout flow is ever wanted.
- **No way to transfer or revoke admin status** from the dashboard — Charlie
  is permanently the one admin account (removing/reactivating regular
  stylists is supported; see section 3).
- **No way to reactivate a removed stylist** from the dashboard once
  removed — their row still exists (nothing is hard-deleted), so it's
  possible directly in the database, just not from the UI yet.
- **No multi-location support.** The app assumes one shared physical
  address for all stylists.
- **No SMS reminders.** Only email notifications exist today.
- **Sessions are stored in server memory**, which is fine for a single
  small server process. This would need to change (e.g. to a database-backed
  session store) if the app were ever run across multiple server instances
  behind a load balancer.

## 5. Data model (SQLite)

- **hairdressers** — one row per stylist: login credentials, display name,
  bio, social links, a `contact_email` used as the destination for that
  stylist's own new-booking-request notifications, an `is_admin` flag (only
  ever set for Charlie), and an `is_active` flag used to soft-remove a
  stylist without deleting their row or any of their linked data.
- **customers** — optional accounts for people who choose to sign up rather
  than book anonymously.
- **availability_blocks** — the date range / days-of-week / time-window
  rules a stylist defines; each block expands into many individual slots.
- **availability_slots** — one row per bookable 30-minute slot, with a
  status of `open`, `pending`, or `booked`, linked back to the block that
  generated it.
- **bookings** — one row per booking request, with a status of `pending`,
  `approved`, `declined`, or `cancelled`, the customer's details, a private
  `access_token` for the no-login status link, and timestamps for when it
  was decided/cancelled.
- **gallery_photos** — uploaded photo filenames/captions, scoped to the
  uploading stylist.

## 6. Technical stack

- **Backend:** Node.js + Express, session-based auth (`express-session`),
  passwords hashed with `bcryptjs`.
- **Database:** SQLite via `better-sqlite3` — a single file
  (`data/booking.db`), no separate database server to run or pay for.
- **Email:** `nodemailer` over Gmail SMTP, optional and off by default.
- **File uploads:** `multer`, storing gallery photos under `uploads/`.
- **Frontend:** plain HTML/CSS/JS served as static files — no framework, no
  build step, no bundler. Mobile-first, single-column responsive layout.
  Visual theme: a pure white (`#ffffff`) app background matching the logo
  artwork's own background, with content in a slightly off-white "surface"
  tone for tiles/cards so they still stand out subtly rather than blending
  completely into the page.
- **IDs/tokens:** `nanoid` for the unguessable per-booking access tokens
  used in status links.

## 7. Hosting and deployment

The app is intentionally "boring" so it stays cheap to run: it's a single
process plus one SQLite file, so it needs a host with a small persistent
disk rather than a serverless/edge platform (which typically don't give
reliable persistent storage between requests). Options evaluated during
development: Render.com's free tier (fine for early testing, but wipes the
database and uploads on every idle restart since the free tier has no
persistent disk), Railway (~$5/month, includes a persistent volume), and a
small always-on VPS (Hetzner/DigitalOcean, roughly $4-6/month).

**Decision: Railway** was chosen as the live hosting platform, since it
gives a persistent volume for the database/photos at a low, predictable
cost — the right call now that real customer bookings are involved rather
than just testing. A step-by-step Railway deployment walkthrough is in
`README.md`.

**Domain name.** `charliescuts.com` was found to already be registered by
an unrelated party (as is `charliescuts.shop`), and there's at least one
other unrelated hairdressing business already trading as "Charlie's Cuts"
in Gladstone, QLD — worth being aware of, though not necessarily a
blocker. The hyphenated `charlies-cuts.com` (and most other suffixes of it)
were confirmed available.

**Decision: `charlies-cuts.com`, bought through Cloudflare Registrar.**
Cloudflare sells domains at its wholesale cost (~US$10/yr) with no markup
and no renewal price jump, unlike promotional pricing at registrars like
GoDaddy or Namecheap that increases sharply after the first year. The
trade-off is USD-only billing and DNS locked to Cloudflare's own
nameservers (not a real limitation in practice). `.com.au` was considered
for the "local trust" signal but requires an Australian ABN/ACN to
register, so `.com` was the simpler choice to get live today.

**Status: `charlies-cuts.com` is registered** (1-year registration via
Cloudflare, 20 August 2026). Still to do: deploy to Railway, then point the
domain's DNS at the live Railway service (a couple of DNS records pasted
into Cloudflare's DNS panel once Railway provides them) — set a calendar
reminder for renewal ahead of August 2027.

## 8. Account recovery (forgotten passwords)

There is currently **no self-service "forgot password" flow** — the
dashboard's "Change password" option requires knowing the current password,
and there's no reset-via-email link yet (even though email sending is
already wired up for booking notifications, it isn't hooked up to password
resets).

If Charlie or Angus forgets their password today, recovery is a manual
step: run `node reset-password.js <username> <newPassword>` from the
project folder (locally, or via the host's shell/console once deployed),
e.g. `node reset-password.js charlie aNewPassword123`. This sets a new
password directly in the database without needing the old one. Login
usernames are `charlie` and `angus`.

A proper self-service "forgot password" email flow (a reset link, valid for
a short time, sent to the stylist's own registered email) would be a
reasonably small follow-up build, reusing the existing email sending setup
— worth doing once real logins are in daily use.

## 9. Known follow-ups / open items

- **Email sending isn't turned on for the live site yet.** `GMAIL_USER` /
  `GMAIL_APP_PASSWORD` haven't been added to Railway's environment variables
  (only `DATA_DIR`, `SESSION_SECRET` and `NODE_ENV` are set there), so
  neither the booking confirmation emails nor the new per-stylist booking
  request notifications are actually sending on the live site yet - see
  README "Booking confirmation emails" for how to add them.
- Charlie and Angus predate the per-stylist notification email feature, so
  their `contact_email` is blank until they each set one from their own
  Profile tab - until then they won't get emailed about new booking
  requests for their own calendar (they'll still see them by checking the
  dashboard's "Pending requests" list).
- Angus's mobile number still needs to be added to the booking-confirmation
  email (currently a placeholder in `routes/bookings.js`).
- Bruce has flagged that the customer booking flow ("Available slots" →
  request form) feels more complicated than it needs to be and wants to
  simplify it after spending more time using it — no specific changes
  requested yet.
- Consider building a proper self-service "forgot password" flow (see
  section 8) now that the app is live with real logins.
- Default stylist passwords (`changeme1` / `changeme2`) should be changed
  from the dashboard immediately after first login on the live site.
