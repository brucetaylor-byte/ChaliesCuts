# Charlie's Cuts — Project Spec

*Last updated: 20 August 2026*

## 1. What this is

Charlie's Cuts is a mobile-first booking web app for two independent freelance
hairdressers, Charlie and Angus, who share a chair/salon space at 36 Wyralla
Crescent, Gisborne, 3437. Customers browse each stylist's open half-hour
slots and request a booking; the stylist approves or declines before it's
locked in. There's no online payment — customers pay in person as they
always have.

The app is deliberately simple: a single Node.js server, a SQLite database
(one file), and a plain HTML/CSS/JS frontend with no build step. It's built
to be cheap and easy to run for a two-person freelance business, not to
scale to a chain of salons.

## 2. Who uses it

**Customers** — the general public. No account required to book (name +
email is enough), though they can optionally create a simple login to see
all their bookings in one place. They interact with the app entirely
through a phone browser.

**Stylists** — Charlie and Angus, each with their own login. Each manages
their own availability, bio, social links, and photo gallery, approves or
declines their own booking requests, and can see (read-only) the other's
calendar to coordinate who's working when.

There is no separate "admin" or "owner" role above the two stylists — they
each have equal, independent control over their own side of the app.

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

**Accounts and privacy.** Customers can book anonymously — they get a
private, unguessable link (not tied to a login) to check status or cancel
later. Optionally, they can create a lightweight account (email + password)
to see every booking they've made in one place at `/my-bookings.html`.
Stylist accounts are separate logins, seeded initially and then managed by
each stylist (username, password, display name, bio, social links). The
internal login usernames are `stylist1` (Charlie) and `stylist2` (Angus) -
these usernames are never shown to customers, only the display name is.

**Profiles and social links.** Each stylist has a public bio and links to
Instagram, Facebook, TikTok, Snapchat, and/or a personal website, shown on
their booking page.

**Shared photo gallery.** Stylists can upload photos (e.g. of their work) to
a shared gallery; uploads are scoped to whichever stylist is logged in when
they upload, and photos can be deleted by their owner.

## 4. What's deliberately out of scope (v1)

- **No online payments.** Everything is pay-in-person, as it is today. The
  `bookings` table has room to add a `payment_status` column later if a
  deposit-via-Stripe-Checkout flow is ever wanted.
- **No admin/owner console.** Charlie and Angus each manage their own side
  independently; there's no shared settings screen or third "manager" role.
- **No multi-location support.** The app assumes one shared physical
  address for both stylists.
- **No SMS reminders.** Only email notifications exist today.
- **Sessions are stored in server memory**, which is fine for a single
  small server process. This would need to change (e.g. to a database-backed
  session store) if the app were ever run across multiple server instances
  behind a load balancer.

## 5. Data model (SQLite)

- **hairdressers** — one row per stylist: login credentials, display name,
  bio, and social links.
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

## 8. Account recovery (forgotten passwords)

There is currently **no self-service "forgot password" flow** — the
dashboard's "Change password" option requires knowing the current password,
and there's no reset-via-email link yet (even though email sending is
already wired up for booking notifications, it isn't hooked up to password
resets).

If Charlie or Angus forgets their password today, recovery is a manual
step: run `node reset-password.js <username> <newPassword>` from the
project folder (locally, or via the host's shell/console once deployed),
e.g. `node reset-password.js stylist1 aNewPassword123`. This sets a new
password directly in the database without needing the old one.
`stylist1` is Charlie's login and `stylist2` is Angus's login — those
internal usernames don't change even though their display names do.

A proper self-service "forgot password" email flow (a reset link, valid for
a short time, sent to the stylist's own registered email) would be a
reasonably small follow-up build, reusing the existing email sending setup
— worth doing once real logins are in daily use.

## 9. Known follow-ups / open items

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
