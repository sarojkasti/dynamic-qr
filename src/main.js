import QRCode from "qrcode";

import {
  getConnectionSummary,
  getBusySettings,
  getInvoice,
  getInvoiceByVchCode,
  getLaunchInvoiceNo,
  getLaunchWatchLatest,
  getLatestInvoices,
  generateFonepayDynamicQr,
  generateNepalPayDynamicQr,
  closeAppWindow,
  getFonepaySettings,
  saveFonepaySettings,
  getNepalPaySettings,
  saveNepalPaySettings,
  listenToInvoicePopupUpdate,
  listenToBusyInvoiceCreated,
  listenToBusyInvoiceWatchError,
  markInvoicePaid,
  openInvoicePopup,
  saveBusySettings,
  searchInvoices,
  startBusyInvoiceWatcher,
  stopBusyInvoiceWatcher,
  verifyFonepayPaymentQr
} from "./api";
import "./styles.css";

const QR_PAYLOADS_STORAGE_KEY = "busypay-qr.qr-payloads.v1";
const QR_GENERATION_LOCK_STORAGE_KEY = "busypay-qr.qr-generation-locks.v1";
const PAYMENT_UPDATE_STORAGE_KEY = "busypay-qr.payment-update.v1";
const NOTIFICATIONS_ENABLED_STORAGE_KEY = "busypay-qr.notifications-enabled.v1";
const QR_PROVIDER_STORAGE_KEY = "busypay-qr.qr-provider.v1";
const qrBaseUrl = "https://qr.yourdomain.com/invoice";
const params = new URLSearchParams(window.location.search);
const isPopupWindow = params.get("popup") === "1";
const qrPaymentSockets = new Map();
const nepalPayStompSockets = new Map();

const state = {
  popupMode: isPopupWindow,
  connectionSummary: "Loading connection",
  busySettings: {
    connectionString: "DSN=BusyDSN;Database=BusyComp0001_db12082;",
    invoiceTable: "Tran1",
    salesVoucherType: 9,
    paymentStatusTable: "VchOtherInfo",
    paymentStatusColumn: "OF2",
    paymentTransactionIdColumn: "OF1"
  },
  busySettingsConfigured: false,
  busySettingsStoragePath: "",
  showBusySettings: false,
  invoices: [],
  selectedInvoiceKey: "",
  query: "",
  launchInvoiceNo: "",
  watchLatest: false,
  knownLatestInvoiceNo: "",
  watcherUnlisten: null,
  watcherErrorUnlisten: null,
  qrPayloads: loadQrPayloads(),
  qrLoadingKeys: {},
  qrAutoGenerateKey: "",
  fonepaySettings: null,
  nepalPaySettings: null,
  notificationsEnabled: loadNotificationPreference(),
  qrProvider: loadQrProvider(),
  error: "",
  confirmPaidInvoiceNo: "",
  successMessage: ""
};

boot();

async function boot() {
  try {
    window.addEventListener("storage", handleStorageChange);

    if (state.popupMode) {
      const invoiceNo = params.get("invoice") || params.get("invoiceNo") || params.get("vchNo");
      const vchCode = params.get("vchCode");
      // Each popup window is pinned to one provider via URL param
      const urlProvider = params.get("provider");
      if (urlProvider === "fonepay" || urlProvider === "nepalpay") {
        state.qrProvider = urlProvider;
        saveQrProvider(urlProvider);
      }
      // Load settings so popup knows credentials and POS column
      const [settingsState, fonepaySettings, nepalPaySettings] = await Promise.all([
        getBusySettings().catch(() => null),
        getFonepaySettings().catch(() => null),
        getNepalPaySettings().catch(() => null),
      ]);
      if (settingsState) {
        state.busySettings = settingsState.settings;
        state.busySettingsConfigured = settingsState.isConfigured;
      }
      state.fonepaySettings = fonepaySettings;
      state.nepalPaySettings = nepalPaySettings;
      await loadPopupInvoice(invoiceNo, vchCode);
      await listenToInvoicePopupUpdate(async (payload) => {
        await loadPopupInvoice(payload.invoiceNo, payload.vchCode);
        render();
      });
      render();
      return;
    }

    const [summary, settingsState, launchInvoiceNo, watchLatest, fonepaySettings, nepalPaySettings] = await Promise.all([
      getConnectionSummary(),
      getBusySettings(),
      getLaunchInvoiceNo(),
      getLaunchWatchLatest(),
      getFonepaySettings().catch(() => null),
      getNepalPaySettings().catch(() => null)
    ]);

    state.fonepaySettings = fonepaySettings;
    state.nepalPaySettings = nepalPaySettings;
    state.connectionSummary = summary;
    state.busySettings = settingsState.settings;
    state.busySettingsConfigured = settingsState.isConfigured;
    state.busySettingsStoragePath = settingsState.storagePath;

    console.log("[Boot] Settings loaded", {
      busyConfigured: settingsState.isConfigured,
      posCreditColumn: settingsState.settings?.posCreditColumn || "(not set)",
      fonepayMerchantCode: fonepaySettings?.merchantCode ? "(set)" : "(missing)",
      nepalPayMerchantId: nepalPaySettings?.merchantId ? "(set)" : "(missing)",
      qrProvider: state.qrProvider,
    });
    state.showBusySettings = !settingsState.isConfigured;
    state.launchInvoiceNo = launchInvoiceNo;
    state.watchLatest = settingsState.isConfigured || watchLatest;

    if (!settingsState.isConfigured) {
      render();
      return;
    }

    if (launchInvoiceNo) {
      const invoice = await getInvoice(launchInvoiceNo);

      if (invoice) {
        state.invoices = [invoice];
        state.selectedInvoiceKey = invoiceKey(invoice);
        state.query = launchInvoiceNo;
        state.qrAutoGenerateKey = qrPayloadKey(invoice);
      } else {
        state.invoices = [];
        state.selectedInvoiceKey = "";
        state.query = launchInvoiceNo;
        state.error = `Invoice ${launchInvoiceNo} was not found in Busy.`;
      }
    } else {
      const latest = await getLatestInvoices(20);
      state.invoices = latest;
      state.selectedInvoiceKey = invoiceKey(latest[0]);
      state.knownLatestInvoiceNo = invoiceKey(latest[0]);
    }

    if (state.watchLatest) {
      await startInvoiceWatcher();
    }
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

function selectedInvoice() {
  return (
    state.invoices.find((invoice) => invoiceKey(invoice) === state.selectedInvoiceKey) ??
    state.invoices[0] ??
    null
  );
}

function invoiceKey(invoice) {
  if (!invoice) return "";
  return invoice.vchCode ? `vch:${invoice.vchCode}` : `no:${invoice.invoiceNo}`;
}

function qrPayloadKey(invoice) {
  const invoiceNo = String(invoice?.invoiceNo ?? "").trim();
  const provider = state?.qrProvider ?? "fonepay";
  return invoiceNo ? `no:${invoiceNo}:${provider}` : "";
}

function invoiceSubtitle(invoice) {
  const party = invoice.partyName ?? "Unknown party";
  const series = invoice.vchSeriesCode ? `Series ${invoice.vchSeriesCode}` : "No series";
  return `${party} | ${series}`;
}

function dynamicInvoiceUrl(invoice) {
  const url = new URL(`${qrBaseUrl}/${encodeURIComponent(invoice.invoiceNo)}`);

  if (invoice.netAmount) {
    url.searchParams.set("amount", invoice.netAmount);
  }

  if (invoice.vchCode) {
    url.searchParams.set("vchCode", invoice.vchCode);
  }

  if (invoice.vchSeriesCode) {
    url.searchParams.set("series", invoice.vchSeriesCode);
  }

  return url.toString();
}

async function handleSearch(form) {
  state.query = form.query.value.trim();
  state.error = "";

  try {
    const results = await searchInvoices(state.query);
    state.invoices = results;
    state.selectedInvoiceKey = invoiceKey(results[0]);
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function handleLoadLatest() {
  state.error = "";
  state.launchInvoiceNo = "";
  state.query = "";

  try {
    const latest = await getLatestInvoices(20);
    state.invoices = latest;
    state.selectedInvoiceKey = invoiceKey(latest[0]);
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function toggleInvoiceWatcher() {
  state.watchLatest = !state.watchLatest;

  if (state.watchLatest) {
    state.knownLatestInvoiceNo = invoiceKey(selectedInvoice());
    await startInvoiceWatcher();
  } else {
    await stopInvoiceWatcher();
  }

  render();
}

async function startInvoiceWatcher() {
  await stopInvoiceWatcher();

  state.watcherUnlisten = await listenToBusyInvoiceCreated(handleInvoiceWatchEvent);
  state.watcherErrorUnlisten = await listenToBusyInvoiceWatchError((message) => {
    state.error = errorMessage(message);
    render();
  });

  try {
    await startBusyInvoiceWatcher();
  } catch (error) {
    state.error = errorMessage(error);
    render();
  }
}

async function stopInvoiceWatcher() {
  if (state.watcherUnlisten) {
    state.watcherUnlisten();
    state.watcherUnlisten = null;
  }

  if (state.watcherErrorUnlisten) {
    state.watcherErrorUnlisten();
    state.watcherErrorUnlisten = null;
  }

  await stopBusyInvoiceWatcher();
}

async function handleInvoiceWatchEvent(event) {
  if (!state.watchLatest) return;

  try {
    let invoice = event.invoice;

    if (!invoice && event.vchCode) {
      invoice = await getInvoiceByVchCode(event.vchCode);
    }

    if (!invoice) {
      invoice = await getInvoice(event.invoiceNo);
    }

    if (!invoice?.invoiceNo || invoiceKey(invoice) === state.knownLatestInvoiceNo) {
      return;
    }

    state.knownLatestInvoiceNo = invoiceKey(invoice);
    state.launchInvoiceNo = invoice.invoiceNo;
    state.query = invoice.invoiceNo;
    state.invoices = [invoice];
    state.selectedInvoiceKey = invoiceKey(invoice);
    state.error = "";
    await openInvoicePopup(invoice);
    render();
  } catch (error) {
    state.error = errorMessage(error);
    render();
  }
}

async function loadPopupInvoice(invoiceNo, vchCode) {
  state.error = "";
  state.launchInvoiceNo = invoiceNo ?? "";

  if (!invoiceNo) {
    state.invoices = [];
    state.selectedInvoiceKey = "";
    state.error = "No invoice number was provided.";
    return;
  }

  try {
    const invoice = vchCode ? await getInvoiceByVchCode(vchCode) : await getInvoice(invoiceNo);

    if (invoice) {
      state.invoices = [invoice];
      state.selectedInvoiceKey = invoiceKey(invoice);
      state.query = invoice.invoiceNo;
      if (state.popupMode) {
        state.qrAutoGenerateKey = qrPayloadKey(invoice);
      }
    } else {
      state.invoices = [];
      state.selectedInvoiceKey = "";
      state.error = `Invoice ${invoiceNo} was not found in Busy.`;
    }
  } catch (error) {
    state.error = errorMessage(error);
  }
}

async function handleBusySettingsSubmit(form) {
  const settings = {
    connectionString: form.connectionString.value.trim(),
    invoiceTable: form.invoiceTable.value.trim(),
    salesVoucherType: Number.parseInt(form.salesVoucherType.value, 10),
    paymentStatusTable: form.paymentStatusTable.value.trim(),
    paymentStatusColumn: form.paymentStatusColumn.value.trim(),
    paymentTransactionIdColumn: form.paymentTransactionIdColumn.value.trim(),
    dbType: form.dbType.value || null
  };

  state.notificationsEnabled = Boolean(form.notificationsEnabled?.checked);
  saveNotificationPreference(state.notificationsEnabled);

  try {
    const settingsState = await saveBusySettings(settings);
    state.busySettings = settingsState.settings;
    state.busySettingsConfigured = settingsState.isConfigured;
    state.busySettingsStoragePath = settingsState.storagePath;
    state.showBusySettings = false;
    state.connectionSummary = await getConnectionSummary();
    state.error = "";
    state.successMessage = "Busy settings saved.";

    const latest = await getLatestInvoices(20);
    state.invoices = latest;
    state.selectedInvoiceKey = invoiceKey(latest[0]);
    state.knownLatestInvoiceNo = invoiceKey(latest[0]);
    state.watchLatest = true;
    await startInvoiceWatcher();
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function openBusySettings() {
  state.showBusySettings = true;
  const [fp, np] = await Promise.all([
    getFonepaySettings().catch(() => null),
    getNepalPaySettings().catch(() => null)
  ]);
  if (fp) state.fonepaySettings = fp;
  if (np) state.nepalPaySettings = np;
  render();
}

function closeBusySettings() {
  if (!state.busySettingsConfigured) return;
  state.showBusySettings = false;
  render();
}

async function handleMarkPaid(invoice) {
  if (!invoice) return;

  state.confirmPaidInvoiceNo = "";
  state.successMessage = "";

  try {
    const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, fonepayTransactionId(response.raw));

    if (updatedInvoice) {
      state.invoices = state.invoices.map((item) =>
        invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
      );
      state.error = "";
      state.successMessage = `Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
    } else {
      state.error = `Invoice ${invoice.invoiceNo} was not found for the configured voucher type.`;
    }
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function handleVerifyPayment(invoice) {
  if (!invoice) return;

  state.successMessage = "";
  state.error = "";

  try {
    const response = await verifyFonepayPaymentQr(invoice.invoiceNo, String(invoice.netAmount ?? "0"));
    const statusSummary = summarizeFonepayStatus(response.raw);

    if (!isFonepayPaymentSuccess(response.raw)) {
      state.successMessage = `Fonepay status: ${statusSummary}`;
      render();
      return;
    }

    const updatedInvoice = await markInvoicePaid(invoice.invoiceNo);

    if (updatedInvoice) {
      state.invoices = state.invoices.map((item) =>
        invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
      );
      state.successMessage = `Payment verified. Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
    } else {
      state.error = `Payment verified, but invoice ${invoice.invoiceNo} was not found for update.`;
    }
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

function openPaidConfirmation(invoice) {
  if (!invoice) return;
  state.confirmPaidInvoiceNo = invoice.invoiceNo;
  state.successMessage = "";
  render();
}

function closePaidConfirmation() {
  state.confirmPaidInvoiceNo = "";
  render();
}

function closeSuccessPopup() {
  state.successMessage = "";
  render();
}

async function drawQr(invoice) {
  const canvas = document.querySelector("#qrCanvas");
  if (!canvas || !invoice) return;

  const key = qrPayloadKey(invoice);
  const shouldGenerate = state.qrAutoGenerateKey === key;

  if (shouldGenerate) {
    state.qrAutoGenerateKey = "";
  }

  const payload = await getInvoiceQrPayload(invoice, shouldGenerate);

  if (payload) {
    if (payload.provider === "nepalpay") {
      ensureNepalPayStompSocket(invoice, payload);
    } else {
      ensureFonepayPaymentSocket(invoice, payload);
    }
  }

  if (payload?.imageDataUrl) {
    await drawImageOnCanvas(canvas, payload.imageDataUrl);
    return;
  }

  if (payload?.qrText) {
    await QRCode.toCanvas(canvas, payload.qrText, {
      width: 280,
      margin: 2,
      color: {
        dark: "#111827",
        light: "#ffffff"
      }
    });
    return;
  }

  clearCanvas(canvas);
}

async function getInvoiceQrPayload(invoice, shouldGenerate = false) {
  const key = qrPayloadKey(invoice);
  if (!key) return null;

  if (state.qrPayloads[key]) {
    return state.qrPayloads[key];
  }

  if (shouldGenerate && !state.qrLoadingKeys[key] && acquireQrGenerationLock(key)) {
    state.qrLoadingKeys[key] = true;
    generateInvoiceQr(invoice, key);
  }

  return null;
}

async function generateInvoiceQr(invoice, key) {
  const amount = parseFloat(invoice.netAmount ?? "0");
  const posColumn = (state.qrProvider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim() || state.busySettings?.posCreditColumn?.trim();

  state.error = ""; // Clear any stale error from a previous provider

  console.log("[QR] generateInvoiceQr", {
    invoiceNo: invoice.invoiceNo,
    provider: state.qrProvider,
    netAmount: invoice.netAmount,
    parsedAmount: amount,
    amountSource: invoice.amountSource,
    posColumn: posColumn || "(not set)",
    busySettingsLoaded: Boolean(state.busySettings),
  });

  // POS column is mandatory — never fall back to net amount
  if (!posColumn) {
    console.warn("[QR] BLOCKED — POS Amount Column not configured in settings");
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    render();
    return;
  }
  if (invoice.amountSource === "Invoice net amount") {
    console.warn(`[QR] BLOCKED — amountSource is 'Invoice net amount' (POS column '${posColumn}' returned no data for this invoice)`);
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    render();
    return;
  }
  if (!amount || amount <= 0) {
    console.warn(`[QR] BLOCKED — parsed amount is ${amount} (netAmount = ${invoice.netAmount})`);
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    render();
    return;
  }

  try {
    let payload;

    if (state.qrProvider === "nepalpay") {
      console.log("[QR] Calling Nepal Pay QR API", { billNumber: invoice.invoiceNo, transactionAmount: String(invoice.netAmount) });
      payload = await generateNepalPayInvoiceQr(invoice);
      console.log("[QR] Nepal Pay QR API response", { qrText: payload?.qrText ? "(present)" : "(missing)", validationTraceId: payload?.validationTraceId });
    } else {
      console.log("[QR] Calling Fonepay QR API", { transactionId: invoice.invoiceNo, amount: String(invoice.netAmount) });
      payload = await generateFonepayInvoiceQr(invoice);
      console.log("[QR] Fonepay QR API response", { qrText: payload?.qrText ? "(present)" : "(missing)", imageDataUrl: payload?.imageDataUrl ? "(present)" : "(missing)" });
    }

    state.qrPayloads[key] = await persistQrSnapshot(payload);
    saveQrPayloads(state.qrPayloads);
    state.error = "";
  } catch (error) {
    console.error("[QR] QR generation failed", { provider: state.qrProvider, invoiceNo: invoice.invoiceNo, error: String(error) });
    state.error = isDuplicateQrGenerationError(error)
      ? `QR already generated for invoice ${invoice.invoiceNo}.`
      : errorMessage(error);
  } finally {
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    render();
  }
}

async function generateFonepayInvoiceQr(invoice) {
  const response = await generateFonepayDynamicQr({
    transactionId: invoice.invoiceNo,
    amount: String(invoice.netAmount),
    remarks1: `Newmew-${invoice.invoiceNo}`.slice(0, 100),
    remarks2: `Newmew-${invoice.invoiceNo}`.slice(0, 50),
    paymentDate: formatFonepayDate(new Date())
  });

  return {
    qrText: response.qrText,
    imageDataUrl: response.imageDataUrl,
    remarks1: response.remarks1,
    raw: response.raw,
    thirdpartyQrWebSocketUrl: response.raw?.thirdpartyQrWebSocketUrl ?? response.raw?.thirdPartyQrWebSocketUrl ?? null,
    provider: "fonepay"
  };
}

async function generateNepalPayInvoiceQr(invoice) {
  const response = await generateNepalPayDynamicQr({
    billNumber: invoice.invoiceNo,
    transactionAmount: String(invoice.netAmount)
  });

  return {
    qrText: response.qrString ?? null,
    imageDataUrl: null,
    remarks1: invoice.invoiceNo,
    raw: response.raw,
    validationTraceId: response.validationTraceId ?? null,
    provider: "nepalpay"
  };
}

function drawImageOnCanvas(canvas, imageDataUrl) {
  return new Promise((resolve, reject) => {
    const context = canvas.getContext("2d");
    const image = new Image();

    image.onload = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      const size = Math.min(canvas.width, canvas.height);
      const x = (canvas.width - size) / 2;
      const y = (canvas.height - size) / 2;
      context.drawImage(image, x, y, size, size);
      resolve();
    };

    image.onerror = reject;
    image.src = imageDataUrl;
  });
}

function clearCanvas(canvas) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function downloadQr(invoice) {
  const canvas = document.querySelector("#qrCanvas");
  if (!canvas || !invoice) return;

  const link = document.createElement("a");
  link.download = `${invoice.invoiceNo}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function render() {
  const invoice = selectedInvoice();

  if (state.popupMode) {
    renderInvoicePopup(invoice);
    return;
  }

  document.querySelector("#app").innerHTML = `
    <section class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">QR</span>
          <div>
            <h1>BusyPay QR</h1>
            <p>Busy ODBC desktop</p>
          </div>
        </div>

        <form id="searchForm" class="panel compact-form">
          <label>
            Search invoice
            <input name="query" value="${escapeHtml(state.query)}" placeholder="Invoice no or party" />
          </label>
          <button type="submit">Search Busy</button>
          <button id="latestInvoices" class="secondary-button" type="button">Latest invoices</button>
          <button id="watchInvoices" class="secondary-button" type="button">
            ${state.watchLatest ? "Stop watching" : "Watch new invoice"}
          </button>
        </form>

        <div class="list" aria-label="Busy invoices">
          ${state.invoices.map((item) => `
            <button
              class="list-item ${invoiceKey(item) === invoiceKey(invoice) ? "active" : ""}"
              data-select="${escapeHtml(invoiceKey(item))}"
              type="button"
            >
              <span>${escapeHtml(item.invoiceNo)}</span>
              <small>${escapeHtml(invoiceSubtitle(item))}</small>
            </button>
          `).join("")}
        </div>
      </aside>

      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">Busy connection</p>
            <h2>${invoice ? escapeHtml(invoice.invoiceNo) : "No invoice selected"}</h2>
            ${state.launchInvoiceNo ? `<p class="launch-line">Opened from invoice ${escapeHtml(state.launchInvoiceNo)}</p>` : ""}
            ${state.watchLatest ? `<p class="launch-line">Watching Busy for newly generated invoices</p>` : ""}
            <p class="connection-line">${escapeHtml(state.connectionSummary)}</p>
          </div>
          <div class="metrics">
            <div><strong>${state.invoices.length}</strong><span>Invoices</span></div>
            <div><strong>${state.fonepaySettings?.merchantCode ? "✓" : "—"}</strong><span>Fonepay</span></div>
            <div><strong>${state.nepalPaySettings?.merchantId ? "✓" : "—"}</strong><span>NepalPay</span></div>
            <div><strong>${state.notificationsEnabled ? "On" : "Off"}</strong><span>Alerts</span></div>
            <button id="openBusySettings" class="secondary-button" type="button">Settings</button>
          </div>
        </header>

        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ""}

        <section class="content-grid">
          ${invoice ? renderQrStage(invoice) : renderEmptyState()}
          ${renderInvoiceDetails(invoice)}
        </section>
      </section>
      ${renderBusySettingsModal()}
      ${renderPaidConfirmation()}
      ${renderSuccessPopup()}
    </section>
  `;

  bindEvents();
  drawQr(invoice);
}

function renderInvoicePopup(invoice) {
  const qrKey = qrPayloadKey(invoice);
  const hasQrPayload = Boolean(state.qrPayloads[qrKey]);
  const hasAmount = parseFloat(invoice?.netAmount ?? "0") > 0;
  const providerLabel = state.qrProvider === "nepalpay" ? "Nepal Pay" : "Fonepay";
  const providerColor = state.qrProvider === "nepalpay" ? "#c0392b" : "#1b6b68";

  document.querySelector("#app").innerHTML = `
    <section class="popup-shell">
      <header class="popup-header">
        <div>
          <p class="eyebrow" style="color:${providerColor};font-weight:700;">${escapeHtml(providerLabel)}</p>
          <h1>${invoice ? escapeHtml(invoice.invoiceNo) : "Invoice"}</h1>
        </div>
        <span class="popup-status">${escapeHtml(invoice?.paymentStatus ?? "Pending")}</span>
      </header>

      ${state.error ? `<div class="error-banner popup-error">${escapeHtml(state.error)}</div>` : ""}

      ${invoice ? `
        <main class="popup-main">
          ${hasAmount
            ? `<canvas id="qrCanvas" width="260" height="260"></canvas>
               <p class="qr-status">${hasQrPayload ? escapeHtml(providerLabel) + " QR ready" : "Generating…"}</p>`
            : `<p class="qr-status">No QR — amount is zero</p>`}
          <dl class="popup-details">
            <div><dt>Party</dt><dd>${escapeHtml(invoice.partyName ?? "-")}</dd></div>
            <div><dt>Date</dt><dd>${escapeHtml(invoice.invoiceDateNepali ?? invoice.invoiceDate ?? "-")}</dd></div>
            <div><dt>Amount</dt><dd>${escapeHtml(invoice.netAmount ?? "-")}</dd></div>
          </dl>
          <button id="copyQrUrl" type="button" ${hasQrPayload ? "" : "disabled"}>Copy QR</button>
        </main>
      ` : `
        <main class="popup-main">
          <p class="muted">Waiting for invoice details.</p>
        </main>
      `}
    </section>
  `;

  bindEvents();
  drawQr(invoice);
}

function renderNepalPayLiveStatus(qrKey) {
  const entry = nepalPayStompSockets.get(qrKey);
  const status = entry?.status ?? "waiting";
  const retryCount = entry?.retryCount ?? 0;

  const labels = {
    waiting: `<p class="qr-status">Waiting for customer to scan…</p>`,
    entr: `<p class="qr-status np-status-entr">Connection established — waiting for customer…</p>`,
    parsed: `<p class="qr-status np-status-parsed">QR scanned — processing payment…</p>`,
    completed: `<p class="qr-status np-status-ok">Payment processing complete.</p>`,
    failed: `<p class="qr-status np-status-fail">Payment failed. Generate a new QR to retry.</p>`,
    timeout: `<p class="qr-status np-status-fail">Payment timed out. Generate a new QR.</p>`,
    error: retryCount > 0
      ? `<p class="qr-status np-status-warn">Connection lost — reconnecting (attempt ${retryCount}/${NP_MAX_RETRIES})…</p>`
      : `<p class="qr-status np-status-fail">WebSocket connection failed.</p>`,
  };
  return labels[status] ?? labels.waiting;
}

function renderQrStage(invoice) {
  if (isInvoicePaid(invoice)) {
    return `
      <div class="qr-stage paid-stage">
        <div class="paid-badge">Paid</div>
        <p class="qr-status">Invoice ${escapeHtml(invoice.invoiceNo)} has been paid.</p>
      </div>
    `;
  }

  const qrKey = qrPayloadKey(invoice);
  const isQrLoading = Boolean(state.qrLoadingKeys[qrKey]);
  const hasQrPayload = Boolean(state.qrPayloads[qrKey]);
  const posColumn = (state.qrProvider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim() || state.busySettings?.posCreditColumn?.trim();

  if (!posColumn) {
    return `
      <div class="qr-stage">
        <p class="qr-status">POS Amount Column is required. Set it in Settings → Fonepay or Nepal Pay.</p>
      </div>
    `;
  }

  if (invoice.amountSource === "Invoice net amount") {
    return `
      <div class="qr-stage">
        <p class="qr-status">No POS amount — column <strong>${escapeHtml(posColumn)}</strong> is empty for this invoice. QR not generated.</p>
      </div>
    `;
  }

  const providerLabel = state.qrProvider === "nepalpay" ? "Nepal Pay" : "Fonepay";
  const altProvider = state.qrProvider === "nepalpay" ? "fonepay" : "nepalpay";
  const altLabel = altProvider === "nepalpay" ? "Nepal Pay" : "Fonepay";

  return `
    <div class="qr-stage">
      <div class="qr-provider-bar">
        <span class="qr-provider-active">${escapeHtml(providerLabel)}</span>
        <button id="switchQrProvider" class="secondary-button" type="button" data-provider="${escapeHtml(altProvider)}">
          Switch to ${escapeHtml(altLabel)}
        </button>
      </div>
      <canvas id="qrCanvas" width="280" height="280"></canvas>
      ${isQrLoading ? `<p class="qr-status">Generating ${escapeHtml(providerLabel)} QR…</p>` : ""}
      ${hasQrPayload && !isQrLoading
        ? (state.qrProvider === "nepalpay"
            ? renderNepalPayLiveStatus(qrKey)
            : `<p class="qr-status">QR ready for invoice ${escapeHtml(invoice.invoiceNo)}</p>`)
        : ""}
      <div class="qr-actions">
        ${state.qrProvider === "fonepay" ? `<button id="verifyPayment" class="secondary-button" type="button">Verify Payment</button>` : ""}
        <button id="downloadQr" type="button" ${hasQrPayload ? "" : "disabled"}>Download PNG</button>
        <button id="copyQrUrl" type="button" ${hasQrPayload ? "" : "disabled"}>Copy QR</button>
        <button id="regenerateQr" class="secondary-button" type="button">New QR</button>
      </div>
    </div>
  `;
}

function renderPaidConfirmation() {
  if (!state.confirmPaidInvoiceNo) return "";

  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="paidConfirmTitle">
        <h3 id="paidConfirmTitle">Confirm payment</h3>
        <p>Mark invoice ${escapeHtml(state.confirmPaidInvoiceNo)} as Paid?</p>
        <div class="modal-actions">
          <button id="cancelPaid" class="secondary-button" type="button">Cancel</button>
          <button id="confirmPaid" type="button">Paid</button>
        </div>
      </section>
    </div>
  `;
}

function renderSuccessPopup() {
  if (!state.successMessage) return "";

  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal success-modal" role="dialog" aria-modal="true" aria-labelledby="successTitle">
        <h3 id="successTitle">Success</h3>
        <p>${escapeHtml(state.successMessage)}</p>
        <div class="modal-actions">
          <button id="closeSuccess" type="button">OK</button>
        </div>
      </section>
    </div>
  `;
}

function renderInvoiceDetails(invoice) {
  if (!invoice) {
    return `
      <div class="panel editor">
        <p class="muted">Search or select an invoice from Busy.</p>
      </div>
    `;
  }

  return `
    <div class="panel editor">
      <div class="url-box">
        <span>Invoice no</span>
        <code>${escapeHtml(invoice.invoiceNo)}</code>
      </div>
      <div class="url-box">
        <span>Voucher code</span>
        <code>${escapeHtml(invoice.vchCode ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>Series code</span>
        <code>${escapeHtml(invoice.vchSeriesCode ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>Party name</span>
        <code>${escapeHtml(invoice.partyName ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>VCH/BILL DATE</span>
        <code>${escapeHtml(invoice.invoiceDate ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>VCH/BILL DATE(nepali)</span>
        <code>${escapeHtml(invoice.invoiceDateNepali ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>QR amount</span>
        <code>${escapeHtml(invoice.netAmount ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>Amount source</span>
        <code>${escapeHtml(invoice.amountSource ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>Payment status</span>
        <code>${escapeHtml(invoice.paymentStatus ?? "-")}</code>
      </div>
      <div class="url-box">
        <span>Dynamic invoice URL</span>
        <code>${escapeHtml(dynamicInvoiceUrl(invoice))}</code>
      </div>
    </div>
  `;
}

function renderFonepaySettingsPanel() {
  const s = state.fonepaySettings;
  const isConfigured = Boolean(s?.merchantCode);

  return `
    <div class="panel bank-panel">
      <div class="panel-heading">
        <h3>Fonepay Settings</h3>
        <span class="${isConfigured ? "badge-ok" : "badge-empty"}">${isConfigured ? "Configured" : "Not set"}</span>
      </div>
      <form id="fonepaySettingsForm" class="bank-form">
        <label>
          Merchant Code
          <input name="merchantCode" placeholder="MER-001" value="${escapeHtml(s?.merchantCode ?? "")}" required />
        </label>
        <label>
          Merchant Secret
          <input name="merchantSecret" type="password" placeholder="Secret key" value="${escapeHtml(s?.merchantSecret ?? "")}" required />
        </label>
        <label>
          Username
          <input name="username" placeholder="merchant_user" value="${escapeHtml(s?.username ?? "")}" required />
        </label>
        <label>
          Password
          <input name="password" type="password" placeholder="Password" value="${escapeHtml(s?.password ?? "")}" required />
        </label>
        <label>
          Integration Mode
          <select name="integrationMode">
            <option value="dynamic_api" ${(s?.integrationMode ?? "dynamic_api") === "dynamic_api" ? "selected" : ""}>Dynamic API</option>
            <option value="pos_api" ${s?.integrationMode === "pos_api" ? "selected" : ""}>POS API</option>
          </select>
        </label>
        <label>
          Dynamic QR URL
          <input name="dynamicUrl" type="url" placeholder="https://merchantapi.fonepay.com/..." value="${escapeHtml(s?.dynamicUrl ?? "")}" />
        </label>
        <label>
          POS API URL
          <input name="posApiUrl" type="url" placeholder="https://clientapi.fonepay.com/..." value="${escapeHtml(s?.posApiUrl ?? "")}" />
        </label>
        <label>
          POS Amount Column
          <input name="posCreditColumn" placeholder="CCAmt1" value="${escapeHtml(s?.posCreditColumn ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Column in POSDet table used as the invoice amount (e.g. CCAmt1)</small>
        </label>
        <button type="submit">Save Fonepay Settings</button>
      </form>
    </div>
  `;
}

function renderNepalPaySettingsPanel() {
  const s = state.nepalPaySettings;
  const isConfigured = Boolean(s?.merchantId);

  return `
    <div class="panel bank-panel">
      <div class="panel-heading">
        <h3>Nepal Pay (NPI) Settings</h3>
        <span class="${isConfigured ? "badge-ok" : "badge-empty"}">${isConfigured ? "Configured" : "Not set"}</span>
      </div>
      <form id="nepalPaySettingsForm" class="bank-form">
        <label>
          API URL
          <input name="apiUrl" type="url" placeholder="https://qr.npi.com.np/api/..." value="${escapeHtml(s?.apiUrl ?? "")}" required />
        </label>
        <label>
          Acquirer ID
          <input name="acquirerId" placeholder="00001701" value="${escapeHtml(s?.acquirerId ?? "")}" required />
        </label>
        <label>
          Merchant ID
          <input name="merchantId" placeholder="17012UVSTIR" value="${escapeHtml(s?.merchantId ?? "")}" required />
        </label>
        <label>
          Merchant Name
          <input name="merchantName" placeholder="BBSM" value="${escapeHtml(s?.merchantName ?? "")}" required />
        </label>
        <label>
          Merchant Category Code (MCC)
          <input name="merchantCategoryCode" type="number" placeholder="5021" value="${escapeHtml(s?.merchantCategoryCode ?? "0")}" required />
        </label>
        <label>
          Merchant Country
          <input name="merchantCountry" placeholder="NP" value="${escapeHtml(s?.merchantCountry ?? "NP")}" required />
        </label>
        <label>
          Merchant City
          <input name="merchantCity" placeholder="Kathmandu" value="${escapeHtml(s?.merchantCity ?? "")}" required />
        </label>
        <label>
          Merchant Postal Code
          <input name="merchantPostalCode" placeholder="44600" value="${escapeHtml(s?.merchantPostalCode ?? "")}" required />
        </label>
        <label>
          Transaction Currency (numeric ISO 4217)
          <input name="transactionCurrency" type="number" placeholder="524" value="${escapeHtml(s?.transactionCurrency ?? "524")}" required />
        </label>
        <label>
          Store Label
          <input name="storeLabel" placeholder="1524525335" value="${escapeHtml(s?.storeLabel ?? "")}" required />
        </label>
        <label>
          NPI User ID
          <input name="userId" placeholder="npi_user" value="${escapeHtml(s?.userId ?? "")}" required />
        </label>
        <label>
          Private Key Path (PKCS#8 PEM — required for API token signing)
          <input name="privateKeyPath" placeholder="C:\\keys\\NPI_private.pem" value="${escapeHtml(s?.privateKeyPath ?? "")}" required />
        </label>
        <label>
          POS Amount Column
          <input name="posCreditColumn" placeholder="CCAmt1" value="${escapeHtml(s?.posCreditColumn ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Column in POSDet table used as the invoice amount (e.g. CCAmt1)</small>
        </label>
        <fieldset style="margin-top:1rem;padding:1rem;border:1px solid #ccc;border-radius:4px;">
          <legend>WebSocket Status (STOMP)</legend>
          <label>
            WebSocket URL
            <input name="wsUrl" type="url" placeholder="wss://qr.npi.com.np/nqrws" value="${escapeHtml(s?.wsUrl ?? "")}" />
          </label>
          <label>
            WS Username
            <input name="wsUsername" placeholder="username" value="${escapeHtml(s?.wsUsername ?? "")}" />
          </label>
          <label>
            WS API Token (plain — encrypted on save)
            <input name="wsApiToken" type="password" placeholder="API token from NPI" value="${escapeHtml(s?.wsApiToken ?? "")}" />
          </label>
        </fieldset>
        <button type="submit">Save Nepal Pay Settings</button>
      </form>
    </div>
  `;
}

function renderBusySettingsModal() {
  if (!state.showBusySettings) return "";

  const settings = state.busySettings;
  const notificationPermission = getNotificationPermissionState();

  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal wide-modal" role="dialog" aria-modal="true" aria-labelledby="busySettingsTitle">
      <div class="panel-heading">
        <h3 id="busySettingsTitle">Busy setup</h3>
        <span>${state.busySettingsConfigured ? "Settings" : "First run"}</span>
      </div>

      <form id="busySettingsForm" class="bank-form">
        <label>
          ODBC connection
          <input
            name="connectionString"
            value="${escapeHtml(settings.connectionString)}"
            placeholder="DSN=BusyDSN;Database=BusyComp0001_db12082;"
            required
          />
        </label>
        <label>
          Invoice table
          <input name="invoiceTable" value="${escapeHtml(settings.invoiceTable)}" required />
        </label>
        <label>
          Sales voucher type
          <input name="salesVoucherType" type="number" min="1" value="${escapeHtml(settings.salesVoucherType)}" required />
        </label>
        <label>
          Payment status table
          <input name="paymentStatusTable" value="${escapeHtml(settings.paymentStatusTable)}" required />
        </label>
        <label>
          Payment status column
          <input name="paymentStatusColumn" value="${escapeHtml(settings.paymentStatusColumn)}" required />
        </label>
        <label>
          Transaction ID column
          <input name="paymentTransactionIdColumn" value="${escapeHtml(settings.paymentTransactionIdColumn)}" required />
        </label>
        <label>
          Database type
          <select name="dbType">
            <option value="sql_server" ${(settings.dbType ?? "sql_server") === "sql_server" ? "selected" : ""}>SQL Server (Busy)</option>
            <option value="access" ${settings.dbType === "access" ? "selected" : ""}>MS Access</option>
          </select>
        </label>
        <label>
          <input name="notificationsEnabled" type="checkbox" ${state.notificationsEnabled ? "checked" : ""} />
          Enable payment notifications
        </label>
        <div class="url-box">
          <span>Notification permission</span>
          <code>${escapeHtml(notificationPermission)}</code>
        </div>
        <button id="requestNotifications" class="secondary-button" type="button">Enable notifications</button>
        <button type="submit">Save Busy setup</button>
        ${state.busySettingsConfigured ? `<button id="closeBusySettings" class="secondary-button" type="button">Cancel</button>` : ""}
      </form>
      ${state.busySettingsStoragePath ? `<p class="settings-path">Saved at ${escapeHtml(state.busySettingsStoragePath)}</p>` : ""}

      <hr />

      ${renderFonepaySettingsPanel()}

      <hr />

      ${renderNepalPaySettingsPanel()}
      </section>
    </div>
  `;
}

function renderEmptyState() {
  return `
    <section class="empty-state">
      <h2>No invoices found</h2>
    </section>
  `;
}

function bindEvents() {
  document.querySelector("#searchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSearch(event.currentTarget);
  });
  document.querySelector("#latestInvoices")?.addEventListener("click", handleLoadLatest);
  document.querySelector("#watchInvoices")?.addEventListener("click", toggleInvoiceWatcher);
  document.querySelector("#openBusySettings")?.addEventListener("click", openBusySettings);

  document.querySelectorAll("[data-select]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedInvoiceKey = button.dataset.select;
      render();
    });
  });

  const invoice = selectedInvoice();
  document.querySelector("#verifyPayment")?.addEventListener("click", () => handleVerifyPayment(invoice));
  document.querySelector("#downloadQr")?.addEventListener("click", () => downloadQr(invoice));
  document.querySelector("#copyQrUrl")?.addEventListener("click", () => {
    if (invoice) copyQrPayload(invoice);
  });

  document.querySelector("#fonepaySettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleFonepaySettingsSubmit(event.currentTarget);
  });

  document.querySelector("#busySettingsForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleBusySettingsSubmit(event.currentTarget);
  });
  document.querySelector("#requestNotifications")?.addEventListener("click", requestNotificationAccess);
  document.querySelector("#closeBusySettings")?.addEventListener("click", closeBusySettings);

  document.querySelector("#cancelPaid")?.addEventListener("click", closePaidConfirmation);
  document.querySelector("#confirmPaid")?.addEventListener("click", () => {
    const invoiceToPay =
      state.invoices.find((item) => item.invoiceNo === state.confirmPaidInvoiceNo) ?? selectedInvoice();
    handleMarkPaid(invoiceToPay);
  });
  document.querySelector("#closeSuccess")?.addEventListener("click", closeSuccessPopup);

  document.querySelector("#switchQrProvider")?.addEventListener("click", (event) => {
    const newProvider = event.currentTarget.dataset.provider;
    // Close any active Nepal Pay socket before switching
    const currentInvoice = selectedInvoice();
    if (currentInvoice) {
      const oldKey = qrPayloadKey(currentInvoice); // key with old provider
      closeNepalPayStompSocket(oldKey);
    }
    state.qrProvider = newProvider;
    saveQrProvider(newProvider);
    state.error = "";
    // qrPayloadKey now includes provider, so cached QR for the new provider
    // is preserved — only trigger generation if not already cached
    if (currentInvoice) {
      const newKey = qrPayloadKey(currentInvoice);
      if (!state.qrPayloads[newKey]) {
        releaseQrGenerationLock(newKey);
        state.qrAutoGenerateKey = newKey;
      }
    }
    render();
  });

  document.querySelector("#regenerateQr")?.addEventListener("click", () => {
    const currentInvoice = selectedInvoice();
    if (!currentInvoice) return;
    const key = qrPayloadKey(currentInvoice);
    delete state.qrPayloads[key];
    saveQrPayloads(state.qrPayloads);
    releaseQrGenerationLock(key);
    state.qrAutoGenerateKey = key;
    render();
  });

  document.querySelector("#nepalPaySettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNepalPaySettingsSubmit(event.currentTarget);
  });
}

async function handleFonepaySettingsSubmit(form) {
  const posCreditColumn = form.posCreditColumn.value.trim();
  const columnChanged = posCreditColumn !== (state.fonepaySettings?.posCreditColumn ?? "");

  const settings = {
    merchantCode: form.merchantCode.value.trim(),
    merchantSecret: form.merchantSecret.value,
    username: form.username.value.trim(),
    password: form.password.value,
    integrationMode: form.integrationMode.value,
    dynamicUrl: form.dynamicUrl.value.trim(),
    posApiUrl: form.posApiUrl.value.trim(),
    posCreditColumn
  };

  try {
    const saved = await saveFonepaySettings(settings);
    state.fonepaySettings = saved;

    if (state.busySettingsConfigured && columnChanged && state.qrProvider === "fonepay") {
      await refreshInvoiceAmounts();
    }

    state.successMessage = "Fonepay settings saved.";
    state.error = "";
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function handleNepalPaySettingsSubmit(form) {
  const posCreditColumn = form.posCreditColumn.value.trim();
  const columnChanged = posCreditColumn !== (state.nepalPaySettings?.posCreditColumn ?? "");

  const settings = {
    apiUrl: form.apiUrl.value.trim(),
    acquirerId: form.acquirerId.value.trim(),
    merchantId: form.merchantId.value.trim(),
    merchantName: form.merchantName.value.trim(),
    merchantCategoryCode: Number.parseInt(form.merchantCategoryCode.value, 10),
    merchantCountry: form.merchantCountry.value.trim(),
    merchantCity: form.merchantCity.value.trim(),
    merchantPostalCode: form.merchantPostalCode.value.trim(),
    transactionCurrency: Number.parseInt(form.transactionCurrency.value, 10),
    storeLabel: form.storeLabel.value.trim(),
    userId: form.userId.value.trim(),
    privateKeyPath: form.privateKeyPath.value.trim(),
    posCreditColumn,
    wsUrl: form.wsUrl.value.trim(),
    wsUsername: form.wsUsername.value.trim(),
    wsApiToken: form.wsApiToken.value
  };

  try {
    const saved = await saveNepalPaySettings(settings);
    state.nepalPaySettings = saved;

    if (state.busySettingsConfigured && columnChanged && state.qrProvider === "nepalpay") {
      await refreshInvoiceAmounts();
    }

    state.successMessage = "Nepal Pay settings saved.";
    state.error = "";
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function refreshInvoiceAmounts() {
  try {
    if (state.launchInvoiceNo) {
      const invoice = await getInvoice(state.launchInvoiceNo);
      if (invoice) {
        state.invoices = state.invoices.map((item) =>
          item.invoiceNo === invoice.invoiceNo ? invoice : item
        );
      }
    } else if (state.query) {
      const results = await searchInvoices(state.query);
      state.invoices = results;
    } else {
      const latest = await getLatestInvoices(20);
      state.invoices = latest;
    }
    // Clear cached QR payloads so they regenerate with fresh amounts
    state.qrPayloads = {};
    saveQrPayloads({});
  } catch {
    // Non-critical — amounts will update on next invoice load
  }
}

function loadQrProvider() {
  try {
    return localStorage.getItem(QR_PROVIDER_STORAGE_KEY) || "fonepay";
  } catch {
    return "fonepay";
  }
}

function saveQrProvider(provider) {
  try {
    localStorage.setItem(QR_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // Ignore storage errors.
  }
}

// ---------------------------------------------------------------------------
// Nepal Pay STOMP-over-WebSocket status tracking
// ---------------------------------------------------------------------------
// Entry shape: { socket, handled, status, retryCount, retryTimer, timeoutTimer }
// status: "waiting" | "entr" | "parsed" | "completed" | "failed" | "timeout" | "error"

const NP_MAX_RETRIES = 5;
const NP_PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const NP_RETRY_BASE_MS = 2000;

function ensureNepalPayStompSocket(invoice, payload) {
  const key = qrPayloadKey(invoice);
  const wsUrl = state.nepalPaySettings?.wsUrl ?? "";

  if (!key || !wsUrl || isInvoicePaid(invoice)) return;
  if (!payload.validationTraceId) return;

  const existing = nepalPayStompSockets.get(key);
  // Already connected or connecting — don't open another
  if (existing?.socket && existing.socket.readyState <= WebSocket.OPEN) return;

  // Clean up any stale socket before opening new one
  if (existing?.socket) {
    try { existing.socket.close(); } catch { /* ignore */ }
  }

  const entry = existing ?? { handled: false, status: "waiting", retryCount: 0, retryTimer: null, timeoutTimer: null };
  entry.socket = null;
  nepalPayStompSockets.set(key, entry);

  // Start payment timeout on first connect attempt only
  if (!entry.timeoutTimer) {
    entry.timeoutTimer = setTimeout(() => {
      const current = nepalPayStompSockets.get(key);
      if (!current || current.handled) return;
      current.handled = true;
      current.status = "timeout";
      closeNepalPayStompSocket(key);
      render();
    }, NP_PAYMENT_TIMEOUT_MS);
  }

  _connectNepalPayStompSocket(invoice, payload, key, wsUrl, entry);
}

function _connectNepalPayStompSocket(invoice, payload, key, wsUrl, entry) {
  console.log("[NP-WS] Connecting", { wsUrl, invoiceNo: invoice.invoiceNo, retryCount: entry.retryCount });
  const socket = new WebSocket(wsUrl);
  entry.socket = socket;

  socket.onopen = () => {
    console.log("[NP-WS] Connected — sending STOMP CONNECT");
    stompSend(socket, "CONNECT", { "accept-version": "1.2", "heart-beat": "0,0" }, "");
  };

  socket.onmessage = async (event) => {
    const frame = stompParse(event.data);
    if (!frame) { console.warn("[NP-WS] Could not parse frame:", event.data); return; }

    console.log("[NP-WS] Frame received", { command: frame.command, bodyPreview: frame.body?.slice(0, 120) });

    if (frame.command === "CONNECTED") {
      console.log("[NP-WS] STOMP CONNECTED — subscribing and sending transaction request");
      stompSend(socket, "SUBSCRIBE", {
        id: "sub-0",
        destination: "/user/nqrws/check-txn-status"
      }, "");

      const body = JSON.stringify({
        merchant_id: state.nepalPaySettings?.merchantId ?? "",
        request_id: payload.validationTraceId,
        username: state.nepalPaySettings?.wsUsername ?? "",
        api_token: state.nepalPaySettings?.wsApiToken ?? ""
      });
      console.log("[NP-WS] SEND payload", {
        merchant_id: state.nepalPaySettings?.merchantId ?? "(missing)",
        request_id: payload.validationTraceId,
        username: state.nepalPaySettings?.wsUsername ? "(set)" : "(missing)",
        api_token: state.nepalPaySettings?.wsApiToken ? "(set)" : "(missing)",
      });
      stompSend(socket, "SEND", { destination: "/nqrws/check-txn-status", "content-type": "application/json" }, body);
      return;
    }

    if (frame.command === "ERROR") {
      console.error("[NP-WS] STOMP ERROR frame", frame.body);
      return;
    }

    if (frame.command !== "MESSAGE") return;

    const current = nepalPayStompSockets.get(key);
    if (!current || current.handled) return;

    const message = parseJsonMaybe(frame.body);
    if (!message) { console.warn("[NP-WS] MESSAGE body is not valid JSON:", frame.body); return; }

    const status = String(message.status ?? "").toUpperCase();
    console.log("[NP-WS] Payment event", { status, message });

    if (status === "ENTR") {
      current.status = "entr";
      render();
      return;
    }

    if (status === "PARSED") {
      current.status = "parsed";
      render();
      return;
    }

    const debitStatus = String(message.debit_status ?? "");
    if (status === "COMPLETED" && debitStatus === "000") {
      current.handled = true;
      current.status = "completed";
      _clearNepalPayTimers(current);
      const txnId = message.txn_id ?? payload.validationTraceId ?? "";

      try {
        const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, txnId);
        if (updatedInvoice) {
          state.invoices = state.invoices.map((item) =>
            invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
          );
          state.successMessage = `Nepal Pay payment received. Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
          state.error = "";
          localStorage.setItem(
            PAYMENT_UPDATE_STORAGE_KEY,
            JSON.stringify({ invoiceNo: updatedInvoice.invoiceNo, status: "Paid", at: Date.now() })
          );
          notifyFonepayPaymentOutcome("success", invoice.invoiceNo, `TXN ${txnId}`);
        }
      } catch (error) {
        state.error = errorMessage(error);
      } finally {
        closeNepalPayStompSocket(key);
        if (state.popupMode) { await closeAppWindow(); return; }
        render();
      }
      return;
    }

    if (status === "FAILED") {
      current.handled = true;
      current.status = "failed";
      _clearNepalPayTimers(current);
      notifyFonepayPaymentOutcome("failure", invoice.invoiceNo, message.message ?? "Failed");
      closeNepalPayStompSocket(key);
      render();
    }
  };

  socket.onerror = (event) => {
    console.error("[NP-WS] WebSocket error", { invoiceNo: invoice.invoiceNo, wsUrl });
    const current = nepalPayStompSockets.get(key);
    if (!current || current.handled) return;
    current.status = "error";
    // Don't render here — onclose fires next and handles reconnect
  };

  socket.onclose = (event) => {
    console.log("[NP-WS] WebSocket closed", { code: event.code, reason: event.reason, invoiceNo: invoice.invoiceNo });
    const current = nepalPayStompSockets.get(key);
    if (!current || current.handled) {
      if (current?.socket === socket) nepalPayStompSockets.delete(key);
      return;
    }
    if (current.socket !== socket) return;

    // Reconnect with exponential backoff
    if (current.retryCount < NP_MAX_RETRIES) {
      const delay = Math.min(NP_RETRY_BASE_MS * Math.pow(2, current.retryCount), 30000);
      current.retryCount += 1;
      current.status = "error";
      console.log(`[NP-WS] Reconnecting in ${delay}ms (attempt ${current.retryCount}/${NP_MAX_RETRIES})`);
      render();
      current.retryTimer = setTimeout(() => {
        const still = nepalPayStompSockets.get(key);
        if (!still || still.handled) return;
        _connectNepalPayStompSocket(invoice, payload, key, wsUrl, still);
      }, delay);
    } else {
      current.handled = true;
      current.status = "error";
      _clearNepalPayTimers(current);
      nepalPayStompSockets.delete(key);
      console.error(`[NP-WS] Max retries (${NP_MAX_RETRIES}) reached for invoice ${invoice.invoiceNo}`);
      state.error = `Nepal Pay: WebSocket connection failed after ${NP_MAX_RETRIES} retries for invoice ${invoice.invoiceNo}.`;
      render();
    }
  };
}

function _clearNepalPayTimers(entry) {
  if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
  if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null; }
}

function closeNepalPayStompSocket(key) {
  const entry = nepalPayStompSockets.get(key);
  if (!entry) return;
  _clearNepalPayTimers(entry);
  if (entry.socket) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
  nepalPayStompSockets.delete(key);
}

function stompSend(socket, command, headers, body) {
  let frame = `${command}\n`;
  for (const [k, v] of Object.entries(headers)) {
    frame += `${k}:${v}\n`;
  }
  frame += `\n${body}\0`;
  socket.send(frame);
}

function stompParse(raw) {
  if (typeof raw !== "string") return null;
  const nullIndex = raw.indexOf("\0");
  const content = nullIndex >= 0 ? raw.slice(0, nullIndex) : raw;
  const lines = content.split("\n");
  const command = lines[0]?.trim();
  if (!command) return null;

  const headers = {};
  let bodyStart = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { bodyStart = i + 1; break; }
    const colon = lines[i].indexOf(":");
    if (colon > 0) headers[lines[i].slice(0, colon)] = lines[i].slice(colon + 1);
  }
  const body = bodyStart >= 0 ? lines.slice(bodyStart).join("\n").trim() : "";
  return { command, headers, body };
}

function loadQrPayloads() {
  try {
    return JSON.parse(localStorage.getItem(QR_PAYLOADS_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function loadQrGenerationLocks() {
  try {
    return JSON.parse(localStorage.getItem(QR_GENERATION_LOCK_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveQrGenerationLocks(locks) {
  try {
    localStorage.setItem(QR_GENERATION_LOCK_STORAGE_KEY, JSON.stringify(locks));
  } catch {
    // Ignore storage quota or unavailable storage errors.
  }
}

function acquireQrGenerationLock(key) {
  const locks = loadQrGenerationLocks();
  const existing = locks[key];
  const now = Date.now();

  if (existing && now - Number(existing.createdAt ?? 0) < 45_000) {
    return false;
  }

  locks[key] = {
    createdAt: now
  };
  saveQrGenerationLocks(locks);
  return true;
}

function releaseQrGenerationLock(key) {
  const locks = loadQrGenerationLocks();

  if (!locks[key]) {
    return;
  }

  delete locks[key];
  saveQrGenerationLocks(locks);
}

function loadNotificationPreference() {
  try {
    return JSON.parse(localStorage.getItem(NOTIFICATIONS_ENABLED_STORAGE_KEY)) ?? false;
  } catch {
    return false;
  }
}

function saveNotificationPreference(enabled) {
  try {
    localStorage.setItem(NOTIFICATIONS_ENABLED_STORAGE_KEY, JSON.stringify(Boolean(enabled)));
  } catch {
    // Ignore storage quota or unavailable storage errors.
  }
}

function getNotificationPermissionState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

async function requestNotificationAccess() {
  if (typeof Notification === "undefined") {
    state.error = "This browser or desktop shell does not support notifications.";
    render();
    return;
  }

  const permission = await Notification.requestPermission();
  state.notificationsEnabled = permission === "granted";
  saveNotificationPreference(state.notificationsEnabled);

  if (permission === "granted") {
    state.successMessage = "Payment notifications are enabled.";
    state.error = "";
  } else if (permission === "denied") {
    state.error = "Notification permission was denied.";
  }

  render();
}

async function persistQrSnapshot(payload) {
  if (!payload?.qrText || payload.imageDataUrl) {
    return payload;
  }

  const imageDataUrl = await QRCode.toDataURL(payload.qrText, {
    width: 280,
    margin: 2,
    color: {
      dark: "#111827",
      light: "#ffffff"
    }
  });

  return {
    ...payload,
    imageDataUrl
  };
}

function saveQrPayloads(payloads) {
  try {
    localStorage.setItem(QR_PAYLOADS_STORAGE_KEY, JSON.stringify(payloads));
  } catch {
    // Ignore storage quota or unavailable storage errors.
  }
}

function handleStorageChange(event) {
  if (event.key === QR_PAYLOADS_STORAGE_KEY) {
    state.qrPayloads = loadQrPayloads();
    render();
    return;
  }

  if (event.key === QR_GENERATION_LOCK_STORAGE_KEY) {
    render();
    return;
  }

  if (event.key === NOTIFICATIONS_ENABLED_STORAGE_KEY) {
    state.notificationsEnabled = loadNotificationPreference();
    render();
    return;
  }

  if (event.key !== PAYMENT_UPDATE_STORAGE_KEY || !event.newValue) return;

  const payload = parseJsonMaybe(event.newValue);

  if (!payload?.invoiceNo) return;

  refreshInvoiceAfterPayment(payload.invoiceNo);
}

async function refreshInvoiceAfterPayment(invoiceNo) {
  const updatedInvoice = await getInvoice(invoiceNo);

  if (!updatedInvoice) return;

  state.invoices = state.invoices.map((item) =>
    item.invoiceNo === updatedInvoice.invoiceNo ? updatedInvoice : item
  );

  if (state.selectedInvoiceKey === invoiceKey(updatedInvoice)) {
    state.selectedInvoiceKey = invoiceKey(updatedInvoice);
  }

  render();
}

function ensureFonepayPaymentSocket(invoice, payload) {
  const key = qrPayloadKey(invoice);
  const url = getFonepayWebSocketUrl(payload);

  if (!key || !url || isInvoicePaid(invoice)) return;

  const existing = qrPaymentSockets.get(key);
  if (existing?.url === url && existing?.socket && existing.socket.readyState <= WebSocket.OPEN) {
    return;
  }

  if (existing?.socket) {
    try {
      existing.socket.close();
    } catch {
      // Ignore close failures and replace the socket.
    }
  }

  const socket = new WebSocket(url);
  qrPaymentSockets.set(key, { url, socket, handled: false });

  socket.onmessage = async (event) => {
    const current = qrPaymentSockets.get(key);

    if (!current || current.handled) {
      return;
    }

    const message = parseFonepayWebSocketMessage(event.data);

    if (!message) {
      return;
    }

    if (isFonepayPaymentSuccess(message)) {
      current.handled = true;

      try {
        const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, fonepayTransactionId(message));

        if (updatedInvoice) {
          state.invoices = state.invoices.map((item) =>
            invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
          );
          state.error = "";
          state.successMessage = `Payment received. Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
          localStorage.setItem(
            PAYMENT_UPDATE_STORAGE_KEY,
            JSON.stringify({ invoiceNo: updatedInvoice.invoiceNo, status: "Paid", at: Date.now() })
          );
          notifyFonepayPaymentOutcome("success", invoice.invoiceNo, summarizeFonepayStatus(message));
        }
      } catch (error) {
        state.error = errorMessage(error);
      } finally {
        closeFonepayPaymentSocket(key);
        if (state.popupMode) {
          await closeAppWindow();
          return;
        }
        render();
      }

      return;
    }

    if (isFonepayPaymentFailure(message)) {
      current.handled = true;
      notifyFonepayPaymentOutcome("failure", invoice.invoiceNo, summarizeFonepayStatus(message));

      closeFonepayPaymentSocket(key);
      render();
      return;
    }
  };

  socket.onerror = () => {
    state.error = `Unable to connect to Fonepay payment socket for invoice ${invoice.invoiceNo}.`;
    render();
  };

  socket.onclose = () => {
    const current = qrPaymentSockets.get(key);
    if (current?.socket === socket) {
      qrPaymentSockets.delete(key);
    }
  };
}

function closeFonepayPaymentSocket(key) {
  const entry = qrPaymentSockets.get(key);
  if (!entry?.socket) return;

  try {
    entry.socket.close();
  } catch {
    // Ignore socket shutdown errors.
  }

  qrPaymentSockets.delete(key);
}

function getFonepayWebSocketUrl(payload) {
  return (
    payload?.thirdpartyQrWebSocketUrl ??
    payload?.thirdPartyQrWebSocketUrl ??
    payload?.raw?.thirdpartyQrWebSocketUrl ??
    payload?.raw?.thirdPartyQrWebSocketUrl ??
    ""
  );
}

function parseFonepayWebSocketMessage(data) {
  const parsed = parseJsonMaybe(data);

  if (parsed && typeof parsed === "object") {
    const transactionStatus = parseJsonMaybe(parsed.transactionStatus);

    if (transactionStatus && typeof transactionStatus === "object") {
      return {
        ...parsed,
        transactionStatus
      };
    }

    return parsed;
  }

  return null;
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function notifyFonepayPaymentOutcome(outcome, invoiceNo, detail = "") {
  if (!state.notificationsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }

  const title = outcome === "success" ? "Payment received" : "Payment failed";
  const bodyParts = [`Invoice ${invoiceNo}`];

  if (detail) {
    bodyParts.push(detail);
  }

  try {
    new Notification(title, {
      body: bodyParts.join(" | "),
      silent: false
    });
  } catch {
    // Ignore notification failures in environments that partially support the API.
  }
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error?.message) return error.message;
  return "Something went wrong";
}

function isDuplicateQrGenerationError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("already") ||
    message.includes("duplicate") ||
    message.includes("exists") ||
    message.includes("prn")
  );
}

async function copyQrPayload(invoice) {
  const payload = await getInvoiceQrPayload(invoice);
  if (!payload) return;

  navigator.clipboard?.writeText(payload.qrText || payload.imageDataUrl || "");
}

function summarizeFonepayStatus(raw) {
  if (!raw || typeof raw !== "object") return String(raw ?? "No response");

  const transactionStatus = parseJsonMaybe(raw.transactionStatus);
  const statusSource = transactionStatus && typeof transactionStatus === "object" ? transactionStatus : raw;

  const status =
    statusSource.paymentStatus ??
    statusSource.transactionStatus ??
    statusSource.status ??
    statusSource.statusDesc ??
    statusSource.message ??
    statusSource.responseMessage ??
    statusSource.success;
  const transactionId = statusSource.prn ?? statusSource.transactionId ?? statusSource.referenceId ?? statusSource.traceId;

  return [status, transactionId ? `PRN ${transactionId}` : ""].filter(Boolean).join(" | ") || JSON.stringify(raw);
}

function fonepayTransactionId(raw) {
  if (!raw || typeof raw !== "object") return "";

  const transactionStatus = parseJsonMaybe(raw.transactionStatus);
  const statusSource = transactionStatus && typeof transactionStatus === "object" ? transactionStatus : raw;
  return String(
    statusSource.prn ??
      statusSource.transactionId ??
      statusSource.referenceId ??
      statusSource.traceId ??
      statusSource.txnId ??
      statusSource.transaction_id ??
      ""
  ).trim();
}

function isFonepayPaymentSuccess(raw) {
  if (!raw || typeof raw !== "object") return false;

  const transactionStatus = parseJsonMaybe(raw.transactionStatus);
  const statusSource = transactionStatus && typeof transactionStatus === "object" ? transactionStatus : raw;

  return isTruthyFlag(statusSource.paymentSuccess) || isTruthyFlag(raw.paymentSuccess);
}

function isFonepayPaymentFailure(raw) {
  if (!raw || typeof raw !== "object") return false;

  const transactionStatus = parseJsonMaybe(raw.transactionStatus);
  const statusSource = transactionStatus && typeof transactionStatus === "object" ? transactionStatus : raw;

  if (hasExplicitFalseFlag(statusSource.paymentSuccess) || hasExplicitFalseFlag(raw.paymentSuccess)) {
    return true;
  }

  if (hasExplicitFalseFlag(statusSource.success) || hasExplicitFalseFlag(raw.success)) {
    return true;
  }

  const message = String(statusSource.message ?? raw.message ?? statusSource.status ?? raw.status ?? "")
    .trim()
    .toLowerCase();

  return ["failed", "failure", "declined", "rejected", "error", "cancelled", "canceled"].some((token) =>
    message.includes(token)
  );
}

function isTruthyFlag(value) {
  return [true, "true", 1, "1", "yes", "y"].includes(String(value).trim().toLowerCase()) || value === true;
}

function hasExplicitFalseFlag(value) {
  return value === false || ["false", "0", 0, "no", "n"].includes(String(value).trim().toLowerCase());
}

function isInvoicePaid(invoice) {
  return String(invoice?.paymentStatus ?? "").trim().toLowerCase() === "paid";
}

function formatFonepayDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();

  return `${month}/${day}/${year}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
