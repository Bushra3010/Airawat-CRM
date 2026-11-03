# Airawat Showroom — product finder, piece tracking, labels & videos

A mobile-first staff app for Airawat Handicraft's showroom, warehouse and branches:

- **Find a Product**: search by name, SKU, barcode, category, material, finish or size (`120x60`), or scan with the phone camera / a USB or Bluetooth scanner.
- **Product and piece screens**: photos, specs, price, available, reserved and physical stock, availability by location with the exact rack or zone, videos, expected dates, and available alternatives.
- **Statuses**: Available Now, Reserved, Out of Stock, Made to Order, Display Only and Damaged. Display pieces never count as saleable unless they're released for sale.
- **Piece tracking**: SKU-level stock for identical items, plus individual pieces (each with its own ID, barcode/QR, photos, condition, cost, price and movement history).
- **Code 128 / QR labels**: A4 sheet PDFs, thermal PDFs and ZPL for Zebra printers, with a print-size check. Cost and margin are never printed.
- **Scan actions**: look up, shortlist, quote, reserve, receive, transfer, dispatch and count. Scanning never moves stock. Every stock change needs a confirmation and is written to the stock ledger.
- **YouTube video library**: videos per product, variant or piece, inherited from the parent unless overridden, with click-to-load embeds and an "Open on YouTube" fallback.
- **Customer QR page** (`/p/<token>`) and **shareable shortlist catalogue** (`/c/<token>`): public, whitelisted fields only.
- **Customer shortlists**: compare items, create a quotation from a shortlist, confirm it as an order (this re-checks availability and reserves all-or-nothing), and share manually on WhatsApp.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000 — without DATABASE_URL it runs a private local Postgres in data/pg
npm test             # verification suite (starts its own throwaway Postgres)
```

## Deploy: Netlify + Supabase

The app is stateless: stock, ledger, sessions and settings live in Supabase Postgres, product photos in a
public Supabase Storage bucket, the staff app is served by Netlify's CDN and the API runs as one Netlify Function.

1. **Supabase**: create a project. Collect three values (keep them private):
   - `DATABASE_URL`: Project Settings → Database → Connection string → **Transaction pooler** (port 6543)
   - `SUPABASE_URL`: Project Settings → API → Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API → `service_role` key (server only)
2. **Set up the database** from this folder: put those values in `.env` (see `.env.example`), then run
   `npm run db:setup`. It creates the tables, turns on row-level security so Supabase's public REST API
   can't read them, creates the `product-photos` bucket, and loads demo data only if the database is empty.
   `npm run db:reset` wipes everything and reloads demo data.
3. **Netlify**: `netlify login`, then `netlify init` (or link an existing site), and add the same three
   variables under Site configuration → Environment variables (Functions scope).
4. `netlify deploy --build --prod`.
5. In the app, set **Settings → Public base URL** to the Netlify address (or your custom domain) before printing QR labels.

Netlify's HTTPS certificate works on every phone, so the local certificate below is only needed for running on the shop LAN.
Limits on Netlify: one label batch is capped at 600 labels (function time limit), and photo uploads at 3.5 MB (the app resizes photos first).

The demo staff logins (admin, manager, sales, storekeeper, plus a second sales login) are listed at the top of `src/seed.js`. **Change or remove them before real use.**

### Phones on the showroom Wi-Fi

- Phone browsers only allow the camera on **HTTPS** (or on `localhost`). Run `npm run cert` once. It creates a private shop certificate authority and an HTTPS certificate for this computer's name and Wi-Fi address, in `certs/` (never commit or share `certs/ca.key`). After that, `npm start` serves HTTP on port 3000 and HTTPS on port 3443, and prints the phone address.
- On each staff phone, install the shop certificate once by opening `http://<computer-ip>:3000/ca.crt`:
  - **iPhone:** Settings → General → VPN & Device Management → install the profile. Then Settings → General → About → Certificate Trust Settings → turn on "Airawat Showroom Local CA".
  - **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate.

  Without this step the phone shows a security warning. You can tap through it, but installing is cleaner.
- If the computer's Wi-Fi address changes, run `npm run cert` again (the CA stays the same, so phones don't need reinstalling). A fixed address/DHCP reservation for this computer on the router avoids that. You can also use your own certificate with `HTTPS_KEY=… HTTPS_CERT=… npm start`, or a reverse proxy.
- Set **Settings → Public base URL** (or the `PUBLIC_BASE_URL` environment variable) to the address customers' phones can reach **before printing QR labels**. The QR codes encode that URL plus a stable token.
- USB and Bluetooth scanners in keyboard mode work on every screen. A scanned code followed by Enter opens the item.

## Roles

| Role | Can |
|---|---|
| sales | find, view, shortlist, quote, reserve, enquiries, labels |
| storekeeper | find, view, receive, transfer, dispatch, count, condition changes, inspected returns, labels |
| manager | everything above, plus seeing cost and margin, editing products, photos and videos, and settings |
| admin | everything |

## Design notes

- **Stable identifiers.** Product codes (`AHP-000001`), piece codes (`AHU-000001`) and customer QR tokens are issued once and can't be edited. Renaming, repricing or moving an item never invalidates a printed label. Internal codes contain letters, so they can't be mistaken for GS1/EAN retail barcodes.
- **Manufacturer barcodes** are optional. They're checked for duplicates across all products and pieces, and EAN/UPC check digits are validated.
- **Stopping double reservations.** Each stock change locks the piece or product row (`SELECT … FOR UPDATE`) inside a Postgres transaction, and a partial unique index allows only one active reservation per piece. Tests fire simultaneous reservations from two separate connection pools (like two Netlify instances): exactly one wins, and SKU stock is never oversold.
- **Saleable quantity** = sellable + display-released-for-sale − active reservations. Damaged and display-only stock is never saleable.
- **Public pages** are built only from explicit field whitelists (`src/public.js`) and use their own routes and CSP. They never call the internal API. They can be turned off globally, per product, or per piece. Customers see your configured availability wording, never quantities or locations.
- **QR reliability.** Every QR code is test-decoded with ZXing (the decoder the phone scanner falls back to) at several module sizes. If one fails, a different QR mask pattern is used. A small share of valid codes otherwise fail in ZXing.

## Layout

```
src/db.js          Postgres schema + pool     src/inventory.js  availability, reservations, movements, ledger
src/storage.js     photos → Supabase Storage  netlify/functions/api.js  serverless entry; netlify.toml routes
src/catalog.js     search, scan, detail, videos, alternatives
src/labels.js      Code 128/QR layout, PDF, ZPL, print-size checks
src/public.js      customer QR page + shared catalogue (whitelisted)
src/server.js      HTTP API, auth, permissions  public/  staff app (no build step)
test/verify.test.js  verification for section 8 of the spec
```

## Not included

- Automated WhatsApp messaging. Sharing is a manual button. Automated sending needs a WhatsApp Business API integration, configured separately.
- User management screens. Users are created by the seed script or directly in the database.
- A real printer check. Labels are verified by rasterising them at the printer's dpi and decoding with two independent decoders. Do one physical test print per label size and printer, at 100% / "Actual size".
