# Haircut Booking App

A lightweight booking app for two freelance hairdressers who work in half-hour
blocks. Customers pick a stylist, request an open slot, and the stylist
approves or declines the request before it's locked in.

## What's included

- Two separate hairdresser logins, each with their own calendar. Each stylist
  can also see the other's calendar (read-only) so they know who's free.
- Half-hour slot generation: a stylist picks a date range, days of the week,
  and a start/end time, and the app creates the individual 30-minute slots.
- Booking is request-then-approve: a customer requesting a slot marks it
  "pending" so nobody else can grab it, and it only becomes "booked" once the
  stylist approves. Declining reopens the slot.
- Customers can book anonymously (name + email, with a private link to check
  status or cancel) or create a simple account to see all their bookings in
  one place.
- A shared photo gallery, with uploads scoped to whichever stylist is logged
  in.
- Each stylist has a bio + social links (Instagram/Facebook/TikTok/website)
  shown on their public booking page.
- Mobile-friendly, single-column responsive layout, no build step required.

## What's deliberately left out (v1 scope)

- **No online payment.** Customers pay in person as before. The
  `bookings` table already has room to add a `payment_status` /
  `stripe_session_id` style column later if you want to add a deposit via
  Stripe Checkout - ask and I can wire that in as a follow-up once you have a
  Stripe account.
- **No email notifications.** Status is checked via the private link sent at
  booking time, or by logging into a customer account. Real email (e.g. via
  Resend, Postmark, or SendGrid) can be added later without changing the data
  model.
- **Sessions are stored in server memory.** Fine for one small server/single
  process. If you ever run more than one server instance behind a load
  balancer, swap in a session store like `connect-sqlite3` or Redis.

## Running it locally

Requires Node.js 18+ (this was built and tested on Node 22).

```bash
npm install
npm run seed     # creates the two stylist logins (only runs once, safe to re-run)
npm start
```

Then open http://localhost:3000 in a browser.

### Default logins (change these immediately)

| Username  | Password    |
|-----------|-------------|
| stylist1  | changeme1   |
| stylist2  | changeme2   |

Log in at `/login.html`, then use the "Change password" section on the
dashboard to set a real password. You can also rename the display name, bio
and social links from the dashboard - the `stylist1` / `stylist2` usernames
themselves are just internal login IDs and never shown to customers.

## Everyday use

**As a stylist:**
1. Log in at `/login.html`.
2. Under "Add availability", pick a date range, the days of the week you
   work, and a start/end time window - this generates the individual
   half-hour open slots for that period.
3. Approve or decline booking requests as they come in under "Pending
   requests".
4. Upload photos to the gallery, edit your bio/social links, and check the
   other stylist's calendar, all from the same dashboard.

**As a customer:**
1. Go to the homepage, pick a stylist, and click an open (green) half-hour
   slot.
2. Enter your name and email (or log in/sign up first if you want your
   bookings saved to an account) and submit the request.
3. You'll get a private link to check the status or cancel - bookmark it, or
   log into `/my-bookings.html` if you created an account.
4. The stylist approves or declines from their dashboard; cancelling later
   reopens the slot for someone else.

## Hosting cheaply

This app is intentionally boring on purpose so it's cheap to run:

- It's a single Node.js process with a SQLite file (`data/booking.db`) - no
  separate database service to pay for.
- Any host that gives you a small persistent disk works: a $4-6/month VPS
  (e.g. a basic Hetzner or DigitalOcean droplet), or a small always-on
  instance on Fly.io or Railway (both have low-cost tiers well suited to an
  app this size).
- Avoid purely "serverless"/edge hosts (e.g. Vercel's default functions) for
  this particular app - SQLite needs a real persistent disk, which serverless
  functions don't reliably give you between requests.
- Put a domain in front of it and switch `cookie.secure` on in
  `server.js` once you're serving over HTTPS (the norm on any of the hosts
  above), and set a real `SESSION_SECRET` environment variable instead of the
  built-in dev default.
- Back up `data/booking.db` and the `uploads/` folder periodically - that's
  the entire state of the app.

## Project structure

```
server.js              Express app entry point
db.js                   SQLite schema + connection
seed.js                 Creates the two stylist logins
routes/
  auth.js               Stylist + customer login/signup/logout
  hairdressers.js        Public profiles + profile editing
  availability.js        Slot generation, listing, deletion
  bookings.js             Request / approve / decline / cancel
  gallery.js              Photo upload/listing/deletion
public/                 Static frontend (plain HTML/CSS/JS, no build step)
uploads/                Uploaded gallery photos
data/                   SQLite database file (created on first run)
```
