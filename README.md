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

## Run it

```bash
npm install
npm start            # http://localhost:3000 — creates data/airawat.db with demo data on first run
npm run seed         # wipe and reload demo data
npm test             # verification suite
```

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
- **Stopping double reservations.** A piece is reserved with a conditional update inside an IMMEDIATE transaction. A unique index also allows only one active reservation per piece, so two staff, or two server processes, can't both reserve it.
- **Saleable quantity** = sellable + display-released-for-sale − active reservations. Damaged and display-only stock is never saleable.
- **Public pages** are built only from explicit field whitelists (`src/public.js`) and use their own routes and CSP. They never call the internal API. They can be turned off globally, per product, or per piece. Customers see your configured availability wording, never quantities or locations.
- **QR reliability.** Every QR code is test-decoded with ZXing (the decoder the phone scanner falls back to) at several module sizes. If one fails, a different QR mask pattern is used. A small share of valid codes otherwise fail in ZXing.

## Layout

```
src/db.js          schema (SQLite)            src/inventory.js  availability, reservations, movements, ledger
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
