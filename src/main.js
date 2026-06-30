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
  closeAppWindow,
  getFonepaySettings,
  saveFonepaySettings,
  listenToInvoicePopupUpdate,
  listenToBusyInvoiceCreated,
  listenToBusyInvoiceWatchError,
  markInvoicePaid,
  openInvoicePopup,
  saveBankMerchant,
  saveBusySettings,
  searchInvoices,
  startBusyInvoiceWatcher,
  stopBusyInvoiceWatcher,
  verifyFonepayPaymentQr
} from "./api";
import "./styles.css";

const BANKS_STORAGE_KEY = "busypay-qr.banks.v1";
const QR_PAYLOADS_STORAGE_KEY = "busypay-qr.qr-payloads.v1";
const QR_GENERATION_LOCK_STORAGE_KEY = "busypay-qr.qr-generation-locks.v1";
const PAYMENT_UPDATE_STORAGE_KEY = "busypay-qr.payment-update.v1";
const NOTIFICATIONS_ENABLED_STORAGE_KEY = "busypay-qr.notifications-enabled.v1";
const qrBaseUrl = "https://qr.yourdomain.com/invoice";
const params = new URLSearchParams(window.location.search);
const isPopupWindow = params.get("popup") === "1";
const qrPaymentSockets = new Map();

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
  banks: loadBanks(),
  editingBankKey: "",
  notificationsEnabled: loadNotificationPreference(),
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
      await loadPopupInvoice(invoiceNo, vchCode);
      await listenToInvoicePopupUpdate(async (payload) => {
        await loadPopupInvoice(payload.invoiceNo, payload.vchCode);
        render();
      });
      render();
      return;
    }

    const [summary, settingsState, launchInvoiceNo, watchLatest] = await Promise.all([
      getConnectionSummary(),
      getBusySettings(),
      getLaunchInvoiceNo(),
      getLaunchWatchLatest()
    ]);

    state.connectionSummary = summary;
    state.busySettings = settingsState.settings;
    state.busySettingsConfigured = settingsState.isConfigured;
    state.busySettingsStoragePath = settingsState.storagePath;
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
  return invoiceNo ? `no:${invoiceNo}` : "";
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

async function handleBankSubmit(form) {
  const bank = {
    name: form.name.value.trim(),
    bankType: form.bankType.value.trim(),
    merchantCode: form.merchantCode.value.trim(),
    merchantUsername: form.merchantUsername.value.trim(),
    merchantPassword: form.merchantPassword.value,
    merchantSecretKey: form.merchantSecretKey.value.trim(),
    fonepayDynamicUrl: form.fonepayDynamicUrl?.value.trim() || "",
    fonepayPosApiUrl: form.fonepayPosApiUrl?.value.trim() || "",
    fonepayIntegrationMode: form.fonepayIntegrationMode?.value.trim() || "",
    posCreditColumn: form.posCreditColumn?.value.trim() || ""
  };

  try {
    const savedBank = await saveBankMerchant(bank);
    const bankSummary = await publicBankSummary(savedBank);
    const existingKey = state.editingBankKey || bankIdentityKey(bankSummary);
    const existingIndex = state.banks.findIndex((item) =>
      bankIdentityKey(item) === existingKey ||
      (bankSummary.merchantCodeHash && item.merchantCodeHash === bankSummary.merchantCodeHash)
    );

    if (existingIndex >= 0) {
      state.banks = state.banks.map((item, index) => (index === existingIndex ? bankSummary : item));
      state.successMessage = "Fonepay settings updated.";
    } else {
      state.banks = [bankSummary, ...state.banks];
      state.successMessage = "Fonepay settings saved.";
    }

    localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(state.banks));
    state.editingBankKey = "";
    form.reset();
    state.error = "";
  } catch (error) {
    state.error = errorMessage(error);
  }

  render();
}

async function handleBusySettingsSubmit(form) {
  const settings = {
    connectionString: form.connectionString.value.trim(),
    invoiceTable: form.invoiceTable.value.trim(),
    salesVoucherType: Number.parseInt(form.salesVoucherType.value, 10),
    paymentStatusTable: form.paymentStatusTable.value.trim(),
    paymentStatusColumn: form.paymentStatusColumn.value.trim(),
    paymentTransactionIdColumn: form.paymentTransactionIdColumn.value.trim()
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

function openBusySettings() {
  state.showBusySettings = true;
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
    ensureFonepayPaymentSocket(invoice, payload);
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

  if (!amount || amount <= 0) {
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    if (!state.popupMode) {
      await openInvoicePopup(invoice);
    }
    render();
    return;
  }

  try {
    const response = await generateFonepayDynamicQr({
      transactionId: invoice.invoiceNo,
      amount: String(invoice.netAmount),
      remarks1: String(invoice.partyName ?? invoice.invoiceNo).slice(0, 100),
      remarks2: String(invoice.invoiceDateNepali ?? invoice.invoiceDate ?? "N/A").slice(0, 50),
      paymentDate: formatFonepayDate(new Date())
    });

    state.qrPayloads[key] = await persistQrSnapshot(response);
    saveQrPayloads(state.qrPayloads);
    state.error = "";
  } catch (error) {
    state.error = isDuplicateQrGenerationError(error)
      ? `QR already generated for invoice ${invoice.invoiceNo}.`
      : errorMessage(error);
  } finally {
    delete state.qrLoadingKeys[key];
    releaseQrGenerationLock(key);
    render();
  }
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
            <div><strong>${state.banks.length}</strong><span>Banks</span></div>
              <div><strong>${state.notificationsEnabled ? "On" : "Off"}</strong><span>Notifications</span></div>
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

  document.querySelector("#app").innerHTML = `
    <section class="popup-shell">
      <header class="popup-header">
        <div>
          <p class="eyebrow">New invoice</p>
          <h1>${invoice ? escapeHtml(invoice.invoiceNo) : "Invoice"}</h1>
        </div>
        <span class="popup-status">${escapeHtml(invoice?.paymentStatus ?? "Pending")}</span>
      </header>

      ${state.error ? `<div class="error-banner popup-error">${escapeHtml(state.error)}</div>` : ""}

      ${invoice ? `
        <main class="popup-main">
          ${parseFloat(invoice.netAmount ?? "0") > 0
            ? `<canvas id="qrCanvas" width="260" height="260"></canvas>`
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

  return `
    <div class="qr-stage">
      <canvas id="qrCanvas" width="280" height="280"></canvas>
      ${isQrLoading ? `<p class="qr-status">Generating Fonepay QR...</p>` : ""}
      ${hasQrPayload && !isQrLoading ? `<p class="qr-status success">QR already generated for invoice ${escapeHtml(invoice.invoiceNo)}</p>` : ""}
      <div class="qr-actions">
        <button id="verifyPayment" class="secondary-button" type="button">Verify Payment</button>
        <button id="downloadQr" type="button" ${hasQrPayload ? "" : "disabled"}>Download PNG</button>
        <button id="copyQrUrl" type="button" ${hasQrPayload ? "" : "disabled"}>Copy QR</button>
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

function renderBankPanel() {
  const editingBank = state.banks.find((bank) => bankIdentityKey(bank) === state.editingBankKey);

  return `
    <div class="panel bank-panel">
      <div class="panel-heading">
        <h3>${state.editingBankKey ? "Edit bank" : "Create new bank"}</h3>
        <span>${state.editingBankKey ? "Editing" : `${state.banks.length} saved`}</span>
      </div>

      <form id="bankForm" class="bank-form">
        <label>
          Name
          <input name="name" placeholder="Bank name" value="${escapeHtml(editingBank?.name ?? "")}" required />
        </label>
        <label>
          Type
          <input name="bankType" placeholder="Bank, wallet, gateway" value="${escapeHtml(editingBank?.bankType ?? "")}" required />
        </label>
        <label>
          Merchant code
          <input name="merchantCode" placeholder="MER-001" required />
        </label>
        <label>
          Merchant username
          <input name="merchantUsername" placeholder="merchant_user" value="${escapeHtml(editingBank?.merchantUsername ?? "")}" required />
        </label>
        <label>
          Merchant password
          <input name="merchantPassword" type="password" placeholder="Password" required />
        </label>
        <label>
          Merchant secret key
          <input name="merchantSecretKey" type="password" placeholder="Secret key" required />
        </label>
        
        <fieldset style="margin-top: 1rem; padding: 1rem; border: 1px solid #ccc; border-radius: 4px;">
          <legend>Fonepay Settings (Optional)</legend>
          <label>
            Dynamic URL
            <input name="fonepayDynamicUrl" type="url" placeholder="https://merchantapi.fonepay.com/..." value="${escapeHtml(editingBank?.fonepayDynamicUrl ?? "")}" />
          </label>
          <label>
            POS API URL
            <input name="fonepayPosApiUrl" type="url" placeholder="https://clientapi.fonepay.com/..." value="${escapeHtml(editingBank?.fonepayPosApiUrl ?? "")}" />
          </label>
          <label>
            Integration Mode
            <select name="fonepayIntegrationMode">
              <option value="">-- Select Mode --</option>
              <option value="dynamic_api" ${editingBank?.fonepayIntegrationMode === "dynamic_api" ? "selected" : ""}>Dynamic API</option>
              <option value="pos_api" ${editingBank?.fonepayIntegrationMode === "pos_api" ? "selected" : ""}>POS API</option>
            </select>
          </label>
          <label>
            POS credit column
            <input name="posCreditColumn" placeholder="CCAmt1" value="${escapeHtml(editingBank?.posCreditColumn ?? "")}" />
          </label>
        </fieldset>
        
        <button type="submit">${state.editingBankKey ? "Update bank" : "Save bank"}</button>
        ${state.editingBankKey ? `<button id="cancelBankEdit" class="secondary-button" type="button">Cancel edit</button>` : ""}
      </form>

      <div class="bank-list" aria-label="Saved banks">
        ${state.banks.length ? state.banks.map((bank) => `
          <article class="bank-item">
            <div>
              <strong>${escapeHtml(bank.name)}</strong>
              <span>${escapeHtml(bank.bankType)}</span>
            </div>
            <dl>
              <div><dt>Code hash</dt><dd>${escapeHtml(bank.merchantCodeHash ?? "Needs update")}</dd></div>
              <div><dt>Username</dt><dd>${escapeHtml(bank.merchantUsername)}</dd></div>
              <div><dt>Password</dt><dd>********</dd></div>
              <div><dt>Secret hash</dt><dd>${escapeHtml(bank.merchantSecretHash ?? "********")}</dd></div>
              ${bank.fonepayDynamicUrl ? `<div><dt>Fonepay Dynamic URL</dt><dd>${escapeHtml(bank.fonepayDynamicUrl)}</dd></div>` : ""}
              ${bank.fonepayPosApiUrl ? `<div><dt>Fonepay POS API URL</dt><dd>${escapeHtml(bank.fonepayPosApiUrl)}</dd></div>` : ""}
              ${bank.fonepayIntegrationMode ? `<div><dt>Fonepay Integration Mode</dt><dd>${escapeHtml(bank.fonepayIntegrationMode)}</dd></div>` : ""}
              ${bank.posCreditColumn ? `<div><dt>POS credit column</dt><dd>${escapeHtml(bank.posCreditColumn)}</dd></div>` : ""}
            </dl>
            <button class="secondary-button" type="button" data-edit-bank="${escapeHtml(bankIdentityKey(bank))}">Edit</button>
          </article>
        `).join("") : `<p class="muted">No banks saved yet.</p>`}
      </div>
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

      ${renderBankPanel()}
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

  document.querySelector("#bankForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleBankSubmit(event.currentTarget);
  });
  document.querySelectorAll("[data-edit-bank]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingBankKey = button.dataset.editBank;
      render();
    });
  });
  document.querySelector("#cancelBankEdit")?.addEventListener("click", () => {
    state.editingBankKey = "";
    render();
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
}

function loadBanks() {
  try {
    const banks = JSON.parse(localStorage.getItem(BANKS_STORAGE_KEY)) ?? [];
    let changed = false;
    const sanitizedBanks = banks.map(({ merchantCode, merchantSecretKey, merchantPassword, ...bank }) => {
      changed = changed || Boolean(merchantCode || merchantSecretKey || merchantPassword);
      return bank;
    });

    if (changed) {
      localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(sanitizedBanks));
    }

    return sanitizedBanks;
  } catch {
    return [];
  }
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

function bankIdentityKey(bank) {
  return `${String(bank?.name ?? "").trim().toLowerCase()}|${String(bank?.bankType ?? "").trim().toLowerCase()}`;
}

async function publicBankSummary(bank) {
  return {
    name: bank.name,
    bankType: bank.bankType,
    merchantCodeHash: await sha256Fingerprint(bank.merchantCode),
    merchantSecretHash: await sha256Fingerprint(bank.merchantSecretKey),
    merchantUsername: bank.merchantUsername,
    fonepayDynamicUrl: bank.fonepayDynamicUrl ?? "",
    fonepayPosApiUrl: bank.fonepayPosApiUrl ?? "",
    fonepayIntegrationMode: bank.fonepayIntegrationMode ?? "",
    posCreditColumn: bank.posCreditColumn ?? ""
  };
}

async function sha256Fingerprint(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";

  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure hashing is not available in this browser.");
  }

  const bytes = new TextEncoder().encode(trimmed);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
