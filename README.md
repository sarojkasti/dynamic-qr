# Dynamic QR System

A Tauri desktop app for Busy Accounting invoice lookup, merchant bank setup, and dynamic QR generation.

## Architecture

```text
Busy Accounting database
        |
        v
ODBC / SQL driver
        |
        v
Tauri Rust backend commands
        |
        v
Vanilla JavaScript desktop UI
        |
        v
Invoice QR code + API calls
```

## Features

- Connect to Busy using ODBC from Rust.
- Fetch latest invoices, search invoices, and fetch one invoice by number.
- Expose backend functionality through Tauri commands.
- Generate signed Fonepay Web Integration 2.0 payment QR codes per invoice.
- Verify Fonepay payment status and mark the Busy invoice as paid.
- Create merchant bank records with name, type, merchant code, username, password, and secret key.

## Requirements

- Node.js 20 or newer
- Rust and Cargo
- Tauri system prerequisites for Windows
- A configured Busy ODBC DSN or full ODBC connection string

Install Rust from <https://rustup.rs/> before running the desktop shell.

## Busy ODBC Configuration

Set these values from the app's Busy setup panel. On first install, the app opens this setup immediately and saves the values in the current Windows user's app data folder.

```bash
BUSY_ODBC_CONNECTION_STRING="DSN=Busy;UID=busy_user;PWD=busy_password;"
BUSY_INVOICE_TABLE="Tran1"
BUSY_SALES_VOUCHER_TYPE=9
```

For local development, you can still create a project-root `.env` file with the same values as a fallback:

```text
BUSY_ODBC_CONNECTION_STRING=DSN=Your64BitBusyDsn;UID=busy_user;PWD=busy_password;
BUSY_INVOICE_TABLE=Tran1
BUSY_SALES_VOUCHER_TYPE=9
```

The desktop app is 64-bit, so it can only use 64-bit ODBC DSNs and 64-bit ODBC drivers.

`BUSY_INVOICE_TABLE` defaults to Busy voucher headers and must expose these columns, or you should adjust `src-tauri/src/db.rs` for your Busy schema:

```text
Tran1: VchNo, Date, NepaliDate, MasterCode1, VchAmtBaseCur, VchType, Cancelled, VchCode
Master1: Code, Name, PrintName
```

## Fonepay POS QR Configuration

The default integration mode uses Fonepay's third-party Dynamic QR API. The Rust backend sends a signed request to the Fonepay `thirdPartyDynamicQrDownload` endpoint and receives a QR image or QR payload in response.

The Verify Payment button then calls Fonepay's third-party Dynamic QR status endpoint and marks the Busy invoice as paid when Fonepay reports a successful payment.

Add these values to `.env`:

```text
FONEPAY_INTEGRATION_MODE=dynamic_api
FONEPAY_DYNAMIC_URL=https://merchantapi.fonepay.com/api/merchant/merchantDetailsForThirdParty
FONEPAY_MERCHANT_CODE=your-merchant-code
FONEPAY_MERCHANT_SECRET=your-secret-key
FONEPAY_USERNAME=your-merchant-panel-username
FONEPAY_PASSWORD=your-merchant-panel-password
```

`FONEPAY_DYNAMIC_URL` may be either the base `merchantDetailsForThirdParty` URL or the full `thirdPartyDynamicQrDownload` endpoint.

If you later switch to Fonepay Web Integration 2.0, you can change `FONEPAY_INTEGRATION_MODE` and configure the Web Integration URLs instead.

## Run

```bash
npm install
npm run tauri:dev
```

For browser-only frontend development:

```bash
npm install
npm run dev
```

## Open From Busy

If Busy can run an external executable after saving or printing an invoice, configure it to launch the packaged app with the invoice number:

```text
"Dynamic QR System.exe" --invoice 494
```

During development, the equivalent command is:

```bash
npm run tauri:dev -- -- --invoice 494
```

If Busy cannot pass the invoice number, run the app in watcher mode. It polls Busy for the newest invoice and switches to the QR screen when a new one appears:

```bash
npm run tauri:dev -- -- --watch-busy
```

The packaged app can be launched the same way:

```text
"Dynamic QR System.exe" --watch-busy
```

You can also set:

```text
BUSY_WATCH_LATEST=1
```

The watcher runs in the Tauri backend and emits `busy-invoice-created` events to the UI. It uses Busy SQL Server's `ModificationTime` field with a lightweight query similar to:

```sql
SELECT TOP 20 VchCode, VchNo, ModificationTime
FROM dbo.Tran1
WHERE ModificationTime > @lastCheck
ORDER BY ModificationTime ASC, VchCode ASC;
```

You can tune the polling interval with:

```text
BUSY_WATCH_INTERVAL_MS=500
```

## Notes

The invoice QR code encodes a dynamic URL in the form:

```text
https://qr.yourdomain.com/invoice/{invoiceNo}
```

For production, point that URL at a hosted API that resolves invoice/payment tokens and records scan analytics.
