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
  logPaymentStatus,
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
  verifyFonepayPaymentQr,
  checkNepalPayPaymentStatus,
  recordNepalPaySessionNumber,
  encryptNepalPayWsToken,
  getSettingsScope,
  saveSettingsScope
} from "./api";
import "./styles.css";

const QR_PAYLOADS_STORAGE_KEY = "busypay-qr.qr-payloads.v1";
const NP_TRACE_IDS_STORAGE_KEY = "busypay-qr.nepalpay-trace-ids.v1";
const QR_GENERATION_LOCK_STORAGE_KEY = "busypay-qr.qr-generation-locks.v1";
const PAYMENT_UPDATE_STORAGE_KEY = "busypay-qr.payment-update.v1";
const NOTIFICATIONS_ENABLED_STORAGE_KEY = "busypay-qr.notifications-enabled.v1";
const QR_PROVIDER_STORAGE_KEY = "busypay-qr.qr-provider.v1";
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
  qrProviderAvailability: {},
  fonepaySettings: null,
  nepalPaySettings: null,
  settingsScope: { fonepay: "user", nepalpay: "user", busy: "user" },
  notificationsEnabled: loadNotificationPreference(),
  qrProvider: loadQrProvider(),
  error: "",
  confirmPaidInvoiceNo: "",
  successMessage: "",
  nepalPayStatusChecks: loadNepalPayTraceIds(),
  fonepayStatusChecks: {}
};

boot();

async function boot() {
  try {
    // Popups must also hear about QR payload/lock/notification updates written
    // by the main window (or another popup) — e.g. if the main window wins the
    // QR-generation lock race, the popup that lost it only ever learns the QR
    // is ready via this storage event, otherwise its canvas stays empty forever.
    // Safe for popups too: this handler never reacts to QR_PROVIDER_STORAGE_KEY,
    // so it can't clobber a popup's URL-pinned provider.
    window.addEventListener("storage", handleStorageChange);

    if (state.popupMode) {
      const invoiceNo = params.get("invoice") || params.get("invoiceNo") || params.get("vchNo");
      const vchCode = params.get("vchCode");
      // Each popup is pinned to one provider via URL param — never touch localStorage
      const urlProvider = params.get("provider");
      if (urlProvider === "fonepay" || urlProvider === "nepalpay") {
        state.qrProvider = urlProvider;
        // Do NOT call saveQrProvider here: localStorage is shared between windows,
        // so saving would clobber the other popup's provider via the storage event.
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
        // Refresh this provider's settings — they may have changed since the popup opened
        if (state.qrProvider === "nepalpay") {
          const fresh = await getNepalPaySettings().catch(() => null);
          if (fresh) state.nepalPaySettings = fresh;
        } else {
          const fresh = await getFonepaySettings().catch(() => null);
          if (fresh) state.fonepaySettings = fresh;
        }
        await loadPopupInvoice(payload.invoiceNo, payload.vchCode);
        render();
      });
      render();
      return;
    }

    const [summary, settingsState, launchInvoiceNo, watchLatest, fonepaySettings, nepalPaySettings, settingsScope] = await Promise.all([
      getConnectionSummary(),
      getBusySettings(),
      getLaunchInvoiceNo(),
      getLaunchWatchLatest(),
      getFonepaySettings().catch(() => null),
      getNepalPaySettings().catch(() => null),
      getSettingsScope().catch(() => null)
    ]);

    state.fonepaySettings = fonepaySettings;
    state.nepalPaySettings = nepalPaySettings;
    if (settingsScope) state.settingsScope = settingsScope;
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
      const invoice = await getInvoice(launchInvoiceNo, activePosCreditColumn());

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
      const latest = await getLatestInvoices(20, activePosCreditColumn());
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
  if (!state.invoices?.length) {
    if (state.selectedInvoiceKey) {
      state.selectedInvoiceKey = "";
    }
    return null;
  }

  const selected = state.invoices.find((invoice) => invoiceKey(invoice) === state.selectedInvoiceKey);
  if (selected) {
    return selected;
  }

  state.selectedInvoiceKey = invoiceKey(state.invoices[0]);
  return state.invoices[0];
}

function invoiceKey(invoice) {
  if (!invoice) return "";
  return invoice.vchCode ? `vch:${invoice.vchCode}` : `no:${invoice.invoiceNo}`;
}

function qrPayloadKey(invoice) {
  return qrPayloadKeyForProvider(invoice, state?.qrProvider ?? "fonepay");
}

function qrPayloadKeyForProvider(invoice, provider = state?.qrProvider ?? "fonepay") {
  const invoiceNo = String(invoice?.invoiceNo ?? "").trim();
  const invoiceKeyValue = invoice?.vchCode ? `vch:${invoice.vchCode}` : `no:${invoiceNo}`;
  return invoiceNo ? `${invoiceKeyValue}:${provider}` : "";
}

function getCachedQrPayloadForInvoice(invoice) {
  const key = qrPayloadKey(invoice);
  if (!key) return null;

  if (state.qrPayloads[key]) {
    if (qrPayloadMatchesInvoiceAmount(state.qrPayloads[key], invoice)) {
      return state.qrPayloads[key];
    }

    removeQrPayloadForInvoice(invoice);
    return null;
  }

  try {
    const persistedPayloads = loadQrPayloads();
    const persistedPayload = persistedPayloads[key];
    if (persistedPayload) {
      if (!qrPayloadMatchesInvoiceAmount(persistedPayload, invoice)) {
        delete persistedPayloads[key];
        saveQrPayloads(persistedPayloads);
        return null;
      }

      state.qrPayloads[key] = persistedPayload;
      return persistedPayload;
    }
  } catch {
    // Ignore storage read failures and fall back to the in-memory cache.
  }

  return null;
}

function normalizedQrAmount(value) {
  const amount = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

function qrPayloadMatchesInvoiceAmount(payload, invoice) {
  const currentAmount = normalizedQrAmount(invoice?.netAmount);
  const payloadAmount = normalizedQrAmount(payload?.transactionAmount);

  // Payloads saved by older app versions did not record their source amount.
  // They cannot safely be reused because the invoice may have been edited.
  return Boolean(currentAmount && payloadAmount && currentAmount === payloadAmount);
}

function invoiceSubtitle(invoice) {
  const party = invoice.partyName ?? "Unknown party";
  const series = invoice.vchSeriesCode ? `Series ${invoice.vchSeriesCode}` : "No series";
  return `${party} | ${series}`;
}

async function handleSearch(form) {
  state.query = form.query.value.trim();
  state.error = "";

  try {
    const results = await searchInvoices(state.query, activePosCreditColumn());
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
    const latest = await getLatestInvoices(20, activePosCreditColumn());
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

function providerPosCreditColumn(provider) {
  return (provider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim() || state.busySettings?.posCreditColumn?.trim() || null;
}

function invoiceHasUsableQrAmount(invoice, provider = state?.qrProvider ?? "fonepay") {
  if (!providerPosCreditColumn(provider)) return false;
  if (invoice?.amountSource === "Invoice net amount") return false;

  const amount = parseFloat(invoice?.netAmount ?? "0");
  return Number.isFinite(amount) && amount > 0;
}

async function fetchInvoiceForColumn(event, posColumn) {
  if (event.vchCode) {
    return getInvoiceByVchCode(event.vchCode, posColumn);
  }
  return getInvoice(event.invoiceNo, posColumn);
}

async function switchQrProvider(newProvider) {
  // Close any active Nepal Pay socket before switching
  const currentInvoice = selectedInvoice();
  if (currentInvoice) {
    const oldKey = qrPayloadKey(currentInvoice); // key with old provider
    closeNepalPayStompSocket(oldKey);
    delete state.qrLoadingKeys[oldKey];
    releaseQrGenerationLock(oldKey);
  }
  state.qrProvider = newProvider;
  saveQrProvider(newProvider);
  state.error = "";
  state.qrAutoGenerateKey = "";
  // Auto-generate a fresh QR for whichever provider was switched to, if none
  // is cached yet — otherwise the dashboard shows that provider's logo/label
  // with a blank canvas, since no request was ever made for it.
  if (currentInvoice) {
    const newKey = qrPayloadKey(currentInvoice);
    releaseQrGenerationLock(newKey);
    delete state.qrLoadingKeys[newKey];

    if (!getCachedQrPayload(newKey)) {
      state.qrAutoGenerateKey = newKey;
    }
  }

  await refreshSelectedInvoiceForCurrentProvider();
  render();
}

async function ensureProviderAvailabilityChecked(invoice) {
  const key = invoiceKey(invoice);
  if (!key || state.qrProviderAvailability[key]) return;

  state.qrProviderAvailability[key] = { fonepay: null, nepalpay: null }; // mark in-progress

  const [fonepayInvoice, nepalpayInvoice] = await Promise.all([
    fetchInvoiceForColumn(invoice, providerPosCreditColumn("fonepay")),
    fetchInvoiceForColumn(invoice, providerPosCreditColumn("nepalpay")),
  ]);

  const availability = {
    fonepay: invoiceHasUsableQrAmount(fonepayInvoice, "fonepay"),
    nepalpay: invoiceHasUsableQrAmount(nepalpayInvoice, "nepalpay"),
  };
  state.qrProviderAvailability[key] = availability;

  // If the active provider has no usable amount for this invoice but the
  // other one does, switch automatically instead of leaving the user
  // stuck looking at an empty QR stage with no way to switch.
  const altProvider = state.qrProvider === "nepalpay" ? "fonepay" : "nepalpay";
  const stillSelected = key === invoiceKey(selectedInvoice());
  if (stillSelected && !availability[state.qrProvider] && availability[altProvider]) {
    await switchQrProvider(altProvider);
    return;
  }

  render();
}

async function handleInvoiceWatchEvent(event) {
  if (!state.watchLatest) return;

  try {
    // Fonepay and NepalPay can use different POS credit columns, so each
    // provider's amount must be fetched with its own column — a single
    // shared fetch would silently apply the wrong provider's amount.
    const [fonepayInvoice, nepalpayInvoice] = await Promise.all([
      fetchInvoiceForColumn(event, providerPosCreditColumn("fonepay")),
      fetchInvoiceForColumn(event, providerPosCreditColumn("nepalpay")),
    ]);

    const invoice =
      (state.qrProvider === "nepalpay" ? nepalpayInvoice : fonepayInvoice) ||
      fonepayInvoice ||
      nepalpayInvoice ||
      event.invoice;

    if (!invoice?.invoiceNo || invoiceKey(invoice) === state.knownLatestInvoiceNo) {
      return;
    }

    state.knownLatestInvoiceNo = invoiceKey(invoice);
    state.launchInvoiceNo = invoice.invoiceNo;
    state.query = invoice.invoiceNo;
    state.invoices = [invoice];
    state.selectedInvoiceKey = invoiceKey(invoice);
    state.error = "";
    const usableProviders = [];
    if (invoiceHasUsableQrAmount(fonepayInvoice, "fonepay")) usableProviders.push("fonepay");
    if (invoiceHasUsableQrAmount(nepalpayInvoice, "nepalpay")) usableProviders.push("nepalpay");

    if (usableProviders.length > 0) {
      await openInvoicePopup(invoice, usableProviders);
    } else {
      state.error = `No payable QR amount for invoice ${invoice.invoiceNo}.`;
    }
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
    const invoice = vchCode ? await getInvoiceByVchCode(vchCode, activePosCreditColumn()) : await getInvoice(invoiceNo, activePosCreditColumn());

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
    const settingsState = await saveBusySettings(settings, state.settingsScope?.busy ?? "user");
    state.busySettings = settingsState.settings;
    state.busySettingsConfigured = settingsState.isConfigured;
    state.busySettingsStoragePath = settingsState.storagePath;
    state.showBusySettings = false;
    state.connectionSummary = await getConnectionSummary();
    state.error = "";
    state.successMessage = "Busy settings saved.";

    const latest = await getLatestInvoices(20, activePosCreditColumn());
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
  const [fp, np, scope] = await Promise.all([
    getFonepaySettings().catch(() => null),
    getNepalPaySettings().catch(() => null),
    getSettingsScope().catch(() => null)
  ]);
  if (fp) state.fonepaySettings = fp;
  if (np) state.nepalPaySettings = np;
  if (scope) state.settingsScope = scope;
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
    const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, "", "manual");

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

  const checkKey = invoiceKey(invoice);
  state.fonepayStatusChecks[checkKey] = { ...state.fonepayStatusChecks[checkKey], loading: true, error: "" };
  render();

  console.log(`[Payment] [Fonepay] report-api-hit invoice=${invoice.invoiceNo}`);
  logPaymentStatus(`[Fonepay] report-api-hit invoice=${invoice.invoiceNo}`).catch(() => {});

  try {
    const response = await verifyFonepayPaymentQr(invoice.invoiceNo, String(invoice.netAmount ?? "0"));
    const statusSummary = summarizeFonepayStatus(response.raw);

    console.log(`[Payment] [Fonepay] report-api-response invoice=${invoice.invoiceNo} summary=${statusSummary}`);
    logPaymentStatus(`[Fonepay] report-api-response invoice=${invoice.invoiceNo} summary=${statusSummary}`).catch(() => {});

    if (!isFonepayPaymentSuccess(response.raw)) {
      state.fonepayStatusChecks[checkKey] = {
        loading: false,
        error: "",
        summary: statusSummary,
        failed: isFonepayPaymentFailure(response.raw)
      };
      render();
      return;
    }

    const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, fonepayTransactionId(response.raw), "fonepay");

    state.fonepayStatusChecks[checkKey] = { loading: false, error: "", summary: statusSummary, failed: false };

    if (updatedInvoice) {
      state.invoices = state.invoices.map((item) =>
        invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
      );
      state.successMessage = `Payment verified. Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
    } else {
      state.error = `Payment verified, but invoice ${invoice.invoiceNo} was not found for update.`;
    }
  } catch (error) {
    console.error(`[Payment] [Fonepay] report-api-error invoice=${invoice.invoiceNo}`, error);
    logPaymentStatus(`[Fonepay] report-api-error invoice=${invoice.invoiceNo} error=${errorMessage(error)}`).catch(() => {});
    state.fonepayStatusChecks[checkKey] = { loading: false, error: errorMessage(error) };
  }

  render();
}

function renderFonepayCheckStatusButton(invoice) {
  if (!invoice?.invoiceNo) return "";
  // PRN for the status-check endpoint is the invoice number itself (same
  // value used to generate the QR), so this button works regardless of
  // whether a QR payload is still cached — including after payment.
  const checkKey = invoiceKey(invoice);
  const check = state.fonepayStatusChecks[checkKey];

  return `
    <div class="np-check-status">
      <button id="checkFonepayStatus" class="success-button" type="button" ${check?.loading ? "disabled" : ""}>
        ${check?.loading ? "Checking…" : "Check Payment Status"}
      </button>
      ${renderFonepayCheckStatusResult(check)}
    </div>
  `;
}

function renderFonepayCheckStatusResult(check) {
  if (!check) return "";

  if (check.error) {
    return `<p class="qr-status np-status-fail">${escapeHtml(check.error)}</p>`;
  }

  if (!check.summary) return "";

  return `<p class="qr-status ${check.failed ? "np-status-fail" : ""}">${escapeHtml(check.summary)}</p>`;
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
    console.log("[QR] Render payload", {
      invoiceNo: invoice.invoiceNo,
      provider: payload.provider,
      key,
      hasQrText: Boolean(payload.qrText),
      hasImage: Boolean(payload.imageDataUrl),
    });
    if (payload.provider === "fonepay") {
      ensureFonepayPaymentSocket(invoice, payload);
    }
  }

  if (payload?.imageDataUrl) {
    const target = canvas.isConnected ? canvas : document.querySelector("#qrCanvas");
    if (target) await drawImageOnCanvas(target, payload.imageDataUrl);
    return;
  }

  if (payload?.qrText) {
    const target = canvas.isConnected ? canvas : document.querySelector("#qrCanvas");
    if (target) {
      await QRCode.toCanvas(target, payload.qrText, {
        width: 280,
        margin: 2,
        color: {
          dark: "#111827",
          light: "#ffffff"
        }
      });
    }
    return;
  }

  clearCanvas(canvas);
}

function getCachedQrPayload(key) {
  if (state.qrPayloads[key]) {
    return state.qrPayloads[key];
  }

  try {
    const persistedPayloads = loadQrPayloads();
    const persistedPayload = persistedPayloads[key];
    if (persistedPayload) {
      state.qrPayloads[key] = persistedPayload;
      return persistedPayload;
    }
  } catch {
    // Ignore storage read failures and fall back to the in-memory cache.
  }

  return null;
}

function removeQrPayloadForInvoice(invoice, provider = state?.qrProvider ?? "fonepay") {
  const key = qrPayloadKeyForProvider(invoice, provider);
  if (!key) return;

  if (state.qrPayloads[key] !== undefined) {
    delete state.qrPayloads[key];
  }

  try {
    const persistedPayloads = loadQrPayloads();
    if (persistedPayloads[key] !== undefined) {
      delete persistedPayloads[key];
      saveQrPayloads(persistedPayloads);
    }
  } catch {
    // Ignore persistence failures.
  }
}

async function getInvoiceQrPayload(invoice, shouldGenerate = false) {
  const key = qrPayloadKey(invoice);
  if (!key) return null;

  const cachedPayload = getCachedQrPayloadForInvoice(invoice);
  if (cachedPayload) {
    return cachedPayload;
  }

  if (shouldGenerate && !state.qrLoadingKeys[key] && acquireQrGenerationLock(key)) {
    state.qrLoadingKeys[key] = true;
    generateInvoiceQr(invoice, key);
  }

  return null;
}

async function generateInvoiceQr(invoice, key) {
  const provider = state.qrProvider;
  const targetKey = key;
  const amount = parseFloat(invoice.netAmount ?? "0");

  if (!invoiceHasUsableQrAmount(invoice, provider)) {
    console.warn(`[QR] BLOCKED — no usable POS amount for invoice ${invoice.invoiceNo} provider=${provider}`);
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
    render();
    return;
  }

  if (getCachedQrPayloadForInvoice(invoice)) {
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
    render();
    return;
  }
  const posColumn = (provider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim() || state.busySettings?.posCreditColumn?.trim();

  state.error = ""; // Clear any stale error from a previous provider

  console.log("[QR] generateInvoiceQr", {
    invoiceNo: invoice.invoiceNo,
    provider,
    netAmount: invoice.netAmount,
    parsedAmount: amount,
    amountSource: invoice.amountSource,
    posColumn: posColumn || "(not set)",
    busySettingsLoaded: Boolean(state.busySettings),
  });

  // POS column is mandatory — never fall back to net amount
  if (!posColumn) {
    console.warn("[QR] BLOCKED — POS Amount Column not configured in settings");
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
    render();
    return;
  }
  if (invoice.amountSource === "Invoice net amount") {
    console.warn(`[QR] BLOCKED — amountSource is 'Invoice net amount' (POS column '${posColumn}' returned no data for this invoice)`);
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
    render();
    return;
  }
  if (!amount || amount <= 0) {
    console.warn(`[QR] BLOCKED — parsed amount is ${amount} (netAmount = ${invoice.netAmount})`);
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
    render();
    return;
  }

  try {
    let payload;

    if (provider === "nepalpay") {
      console.log("[QR] Calling Nepal Pay QR API", { billNumber: invoice.invoiceNo, transactionAmount: String(invoice.netAmount) });
      payload = await generateNepalPayInvoiceQr(invoice);
      console.log("[QR] Nepal Pay QR API response", { qrText: payload?.qrText ? "(present)" : "(missing)", validationTraceId: payload?.validationTraceId });
    } else {
      console.log("[QR] Calling Fonepay QR API", { transactionId: invoice.invoiceNo, amount: String(invoice.netAmount) });
      payload = await generateFonepayInvoiceQr(invoice);
      console.log("[QR] Fonepay QR API response", { qrText: payload?.qrText ? "(present)" : "(missing)", imageDataUrl: payload?.imageDataUrl ? "(present)" : "(missing)" });
    }

    if (state.qrProvider !== provider) {
      console.log("[QR] Ignoring stale QR result after provider switch", {
        invoiceNo: invoice.invoiceNo,
        startedWith: provider,
        currentProvider: state.qrProvider,
      });
      return;
    }

    const persistedPayload = await persistQrSnapshot(payload);
    state.qrPayloads[targetKey] = persistedPayload;
    saveQrPayloads(state.qrPayloads);
    state.error = "";

    if (provider === "nepalpay" && persistedPayload?.qrText && persistedPayload?.validationTraceId) {
      rememberNepalPayValidationTraceId(invoice, persistedPayload.validationTraceId);
      ensureNepalPayStompSocket(invoice, persistedPayload);
    }
  } catch (error) {
    console.error("[QR] QR generation failed", { provider, invoiceNo: invoice.invoiceNo, error: String(error) });
    state.error = isDuplicateQrGenerationError(error)
      ? `QR already generated for invoice ${invoice.invoiceNo}.`
      : errorMessage(error);
  } finally {
    delete state.qrLoadingKeys[targetKey];
    releaseQrGenerationLock(targetKey);
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
    transactionAmount: normalizedQrAmount(invoice.netAmount),
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
    transactionAmount: normalizedQrAmount(invoice.netAmount),
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
          <img class="brand-mark" src="/logo.png" alt="BusyPay QR" />
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
            <div><strong>${state.nepalPaySettings?.merchantId ? "✓" : "—"}</strong><span>NEPALPAY</span></div>
            <div><strong>${state.notificationsEnabled ? "On" : "Off"}</strong><span>Alerts</span></div>
            ${state.busySettings?.showSetting !== false
              ? `<button id="openBusySettings" class="secondary-button" type="button">Settings</button>`
              : ""}
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
  const hasAmount = parseFloat(invoice?.netAmount ?? "0") > 0;
  const providerLabel = state.qrProvider === "nepalpay" ? "NEPALPAY" : "Fonepay";
  const popupLogo = state.qrProvider === "nepalpay" ? "/nepalpay_logo.jpeg" : "/fonepay.webp";

  document.querySelector("#app").innerHTML = `
    <section class="popup-shell">
      <header class="popup-header">
        <img class="popup-logo" src="${popupLogo}" alt="${escapeHtml(providerLabel)}" />
      </header>

      ${state.error ? `<div class="error-banner popup-error">${escapeHtml(state.error)}</div>` : ""}

      ${invoice ? `
        <main class="popup-main">
          <div class="qr-amount-lines">
            <p class="qr-amount-label">Amount to Pay</p>
            <p class="qr-amount-value">Rs. ${escapeHtml(invoice.netAmount ?? "-")}</p>
          </div>
          ${isInvoicePaid(invoice)
            ? `<p class="qr-status payment-success-text">Payment Success</p>`
            : isNepalPayFailedState(qrKey)
              ? `<p class="qr-status payment-failed-text">Payment Failed</p>`
              : `
                ${hasAmount
                  ? `<canvas id="qrCanvas" width="260" height="260"></canvas>`
                  : `<p class="qr-status">No QR — amount is zero</p>`}
                ${state.qrProvider === "nepalpay"
                  ? renderNepalPayLiveStatus(qrKey)
                  : renderFonepayLiveStatus(qrKey)}
              `}
          ${renderNepalPayCheckStatusButton(invoice)}
          ${state.qrProvider === "fonepay" ? renderFonepayCheckStatusButton(invoice) : ""}
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

function isNepalPayFailedState(qrKey) {
  if (state.qrProvider !== "nepalpay") return false;
  const status = nepalPayStompSockets.get(qrKey)?.status;
  return status === "failed" || status === "timeout";
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

function isNepalPayDebitCreditSuccess(debitStatus, creditStatus) {
  const debitSuccess = String(debitStatus ?? "") === "000";
  const creditSuccess = ["000", "999", "defer"].includes(String(creditStatus ?? "").toLowerCase());
  return debitSuccess && creditSuccess;
}

function rememberNepalPayValidationTraceId(invoice, validationTraceId) {
  if (!validationTraceId) return;
  const qrKey = qrPayloadKeyForProvider(invoice, "nepalpay");
  state.nepalPayStatusChecks[qrKey] = {
    ...state.nepalPayStatusChecks[qrKey],
    validationTraceId
  };
  saveNepalPayTraceId(qrKey, validationTraceId);
}

function getNepalPayValidationTraceId(invoice) {
  const qrKey = qrPayloadKeyForProvider(invoice, "nepalpay");
  const remembered = state.nepalPayStatusChecks[qrKey]?.validationTraceId;
  if (remembered) return remembered;

  const cached = getCachedQrPayloadForInvoice(invoice)?.validationTraceId;
  if (cached) return cached;

  // Fall back to the txn ID persisted in Busy itself (OF1, "NP:<txnId>") — for
  // NepalPay the stored txn_id is the same value as the validationTraceId, so
  // this recovers status-check ability even after localStorage/cache is gone
  // (new session, different machine, or a payment marked paid before this
  // trace-id memory existed).
  if (invoice?.paymentProvider === "nepalpay" && invoice?.paymentTxnId) {
    return invoice.paymentTxnId;
  }

  return null;
}

function renderNepalPayCheckStatusButton(invoice) {
  if (!invoice) return "";
  // Once an invoice is paid, the currently-active provider toggle may have
  // moved on to something else — but if this invoice has a remembered NepalPay
  // trace ID, still show the button so its status can be checked afterward.
  if (state.qrProvider !== "nepalpay" && !isInvoicePaid(invoice)) return "";
  if (!getNepalPayValidationTraceId(invoice)) return "";

  const qrKey = qrPayloadKeyForProvider(invoice, "nepalpay");
  const check = state.nepalPayStatusChecks[qrKey];

  return `
    <div class="np-check-status">
      <button id="checkNepalPayStatus" class="success-button" type="button" ${check?.loading ? "disabled" : ""}>
        ${check?.loading ? "Checking…" : "Check Payment Status"}
      </button>
      ${renderNepalPayCheckStatusResult(check)}
    </div>
  `;
}

function renderNepalPayCheckStatusResult(check) {
  if (!check) return "";

  if (check.error) {
    return `<p class="qr-status np-status-fail">${escapeHtml(check.error)}</p>`;
  }

  const txn = check.transaction;
  if (!txn) {
    // No transaction record yet (e.g. NPI responseCode E012 "not initiated") —
    // still show a clear Unpaid status instead of leaving the check result blank.
    return `<p class="qr-status np-status-fail">Unpaid${check.responseMessage ? ` — ${escapeHtml(check.responseMessage)}` : ""}</p>`;
  }

  return `
    <dl class="popup-details np-status-result">
      <div><dt>Status</dt><dd>${escapeHtml(txn.creditStatus ?? check.responseStatus ?? "-")}</dd></div>
      <div><dt>Amount</dt><dd>${escapeHtml(txn.amount ?? "-")}</dd></div>
      <div><dt>Payer</dt><dd>${escapeHtml(txn.payerName ?? "-")}</dd></div>
      <div><dt>Txn ID</dt><dd>${escapeHtml(txn.nQrTxnId ?? "-")}</dd></div>
      <div><dt>Date</dt><dd>${escapeHtml(txn.recDate ?? "-")}</dd></div>
    </dl>
  `;
}

async function handleCheckNepalPayStatus(invoice) {
  if (!invoice) return;
  const validationTraceId = getNepalPayValidationTraceId(invoice);
  if (!validationTraceId) return;

  const qrKey = qrPayloadKeyForProvider(invoice, "nepalpay");
  state.nepalPayStatusChecks[qrKey] = { ...state.nepalPayStatusChecks[qrKey], validationTraceId, loading: true, error: "" };
  render();

  try {
    const result = await checkNepalPayPaymentStatus(validationTraceId);
    const txn = result?.transaction;
    state.nepalPayStatusChecks[qrKey] = {
      validationTraceId,
      loading: false,
      error: "",
      responseStatus: result?.responseStatus,
      responseMessage: result?.responseMessage,
      transaction: txn ?? null
    };

    // Fallback path: the websocket may have already given up (failed/timeout/
    // closed) without the transaction actually completing. If the report API
    // — the authoritative source when the socket didn't work — shows the
    // transaction actually succeeded, reconcile by marking the invoice paid
    // and swapping the QR for "Payment Success", instead of leaving the QR
    // showing on a stale/incorrect failure state.
    if (!isInvoicePaid(invoice) && txn && isNepalPayDebitCreditSuccess(txn.debitStatus, txn.creditStatus)) {
      const txnId = String(txn.nQrTxnId ?? validationTraceId ?? "").trim();
      const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, txnId || undefined, "nepalpay");
      if (updatedInvoice) {
        const sessionNumber = await saveNepalPaySessionWithRetry(invoice.invoiceNo, txnId);
        state.invoices = state.invoices.map((item) =>
          invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
        );
        state.successMessage = `NEPALPAY payment confirmed via status check. Invoice ${updatedInvoice.invoiceNo} marked as Paid.${sessionNumber ? ` Session ${sessionNumber} saved.` : " Session number is not available in the date-wise report yet."}`;
        removeQrPayloadForInvoice(invoice, "nepalpay");
        localStorage.setItem(
          PAYMENT_UPDATE_STORAGE_KEY,
          JSON.stringify({ invoiceNo: updatedInvoice.invoiceNo, status: "Paid", txnId, at: Date.now() })
        );
      }
    }
  } catch (error) {
    state.nepalPayStatusChecks[qrKey] = { validationTraceId, loading: false, error: errorMessage(error), transaction: null };
  }

  render();
}

function paidViaLabel(invoice) {
  const provider = invoice?.paymentProvider;
  if (provider === "nepalpay") return "NEPALPAY";
  if (provider === "fonepay") return "Fonepay";
  if (provider === "manual") return "Marked paid manually";
  return null;
}

function renderQrStage(invoice) {
  if (isInvoicePaid(invoice)) {
    const paidVia = paidViaLabel(invoice);
    return `
      <div class="qr-stage paid-stage">
        <img class="paid-badge" src="/paid.png" alt="Paid" />
        <p class="qr-status">Invoice ${escapeHtml(invoice.invoiceNo)} has been paid.</p>
        ${paidVia ? `<p class="paid-via-label">Paid via ${escapeHtml(paidVia)}</p>` : ""}
        ${renderNepalPayCheckStatusButton(invoice)}
        ${invoice.paymentProvider === "fonepay" ? renderFonepayCheckStatusButton(invoice) : ""}
      </div>
    `;
  }

  // Check both providers' amounts up front — and before any early return —
  // so that if the active provider has no usable amount but the other one
  // does, we auto-switch instead of getting stuck on a dead-end message.
  ensureProviderAvailabilityChecked(invoice);
  const availability = state.qrProviderAvailability[invoiceKey(invoice)];
  const bothProvidersUsable = Boolean(availability?.fonepay && availability?.nepalpay);

  // The provider toggle is a global UI preference, independent of which
  // provider a QR actually exists for on this invoice (e.g. generated from a
  // popup window, or before switching providers elsewhere). If the toggle's
  // provider has nothing cached but the other one already has a real QR,
  // prefer showing that one instead of an empty stage — the QR that was
  // actually generated should always be visible somewhere.
  const activeKey = qrPayloadKey(invoice);
  const altProviderForFallback = state.qrProvider === "nepalpay" ? "fonepay" : "nepalpay";
  const altKeyForFallback = qrPayloadKeyForProvider(invoice, altProviderForFallback);
  if (!getCachedQrPayload(activeKey) && getCachedQrPayload(altKeyForFallback)) {
    state.qrProvider = altProviderForFallback;
    saveQrProvider(altProviderForFallback);
    // This function is a synchronous render — it can't await the invoice
    // refetch (the invoice's netAmount is fetched using a provider-specific
    // POS column, so it's stale for the newly-active provider until this
    // resolves). Fire-and-forget it, same pattern as ensureProviderAvailabilityChecked
    // above, and re-render once the correct amount is loaded.
    refreshSelectedInvoiceForCurrentProvider().then(() => render());
  }

  const qrKey = qrPayloadKey(invoice);
  const isQrLoading = Boolean(state.qrLoadingKeys[qrKey]);
  const hasQrPayload = Boolean(getCachedQrPayloadForInvoice(invoice));
  const posColumn = (state.qrProvider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim() || state.busySettings?.posCreditColumn?.trim();

  if (!posColumn) {
    return `
      <div class="qr-stage">
        <p class="qr-status">POS Amount Column is required. Set it in Settings → Fonepay or NEPALPAY.</p>
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

  const providerLabel = state.qrProvider === "nepalpay" ? "NEPALPAY" : "Fonepay";
  const altProvider = state.qrProvider === "nepalpay" ? "fonepay" : "nepalpay";
  const altLabel = altProvider === "nepalpay" ? "NEPALPAY" : "Fonepay";
  const providerLogo = state.qrProvider === "nepalpay" ? "/nepalpay_logo.jpeg" : "/fonepay.webp";

  return `
    <div class="qr-stage">
      <div class="qr-provider-bar">
        <span class="qr-provider-active">${escapeHtml(providerLabel)}</span>
        ${bothProvidersUsable
          ? `<button id="switchQrProvider" class="secondary-button" type="button" data-provider="${escapeHtml(altProvider)}">
          Switch to ${escapeHtml(altLabel)}
        </button>`
          : ""}
      </div>
      <div class="qr-amount-lines">
        <p class="qr-amount-label">Amount to Pay</p>
        <p class="qr-amount-value">Rs. ${escapeHtml(invoice.netAmount ?? "-")}</p>
      </div>
      <img class="qr-provider-logo" src="${providerLogo}" alt="${escapeHtml(providerLabel)}" />
      <canvas id="qrCanvas" width="280" height="280"></canvas>
      ${isQrLoading ? `<p class="qr-status">Generating ${escapeHtml(providerLabel)} QR…</p>` : ""}
      ${hasQrPayload && !isQrLoading
        ? (state.qrProvider === "nepalpay"
            ? renderNepalPayLiveStatus(qrKey)
            : `<p class="qr-status">QR ready for invoice ${escapeHtml(invoice.invoiceNo)}</p>`)
        : ""}
      ${renderNepalPayCheckStatusButton(invoice)}
      ${state.qrProvider === "fonepay" ? renderFonepayCheckStatusButton(invoice) : ""}
      <div class="qr-actions">
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
    </div>
  `;
}

function renderScopeToggle(settingsKey, currentScope) {
  const isUser = currentScope !== "shared";
  return `
    <div class="scope-toggle" data-settings-key="${settingsKey}">
      <span class="scope-toggle-label">Settings scope:</span>
      <label class="scope-toggle-option ${isUser ? "active" : ""}">
        <input type="radio" name="scope-${settingsKey}" value="user" ${isUser ? "checked" : ""} />
        <span>This user only</span>
      </label>
      <label class="scope-toggle-option ${!isUser ? "active" : ""}">
        <input type="radio" name="scope-${settingsKey}" value="shared" ${!isUser ? "checked" : ""} />
        <span>All users (shared)</span>
      </label>
      <small class="scope-toggle-hint">${isUser
        ? "Settings saved to your user profile — other Windows users keep their own settings."
        : "Settings saved to the shared folder — all Windows users on this machine share them."
      }</small>
    </div>
  `;
}

function renderFonepaySettingsPanel() {
  const s = state.fonepaySettings;
  const isConfigured = Boolean(s?.merchantCode);
  const currentScope = state.settingsScope?.fonepay ?? "user";

  return `
    <div class="panel bank-panel">
      <div class="panel-heading">
        <h3>Fonepay Settings</h3>
        <span class="${isConfigured ? "badge-ok" : "badge-empty"}">${isConfigured ? "Configured" : "Not set"}</span>
      </div>
      ${renderScopeToggle("fonepay", currentScope)}
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
          Report/Verification URL
          <input name="reportUrl" type="url" placeholder="https://merchantapi.fonepay.com/.../thirdPartyDynamicQrGetStatus" value="${escapeHtml(s?.reportUrl ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Used by "Check Payment Status" to verify a QR/transaction. Leave blank to auto-derive from the Dynamic QR URL.</small>
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
  const currentScope = state.settingsScope?.nepalpay ?? "user";

  return `
    <div class="panel bank-panel">
      <div class="panel-heading">
        <h3>NEPALPAY (NPI) Settings</h3>
        <span class="${isConfigured ? "badge-ok" : "badge-empty"}">${isConfigured ? "Configured" : "Not set"}</span>
      </div>
      ${renderScopeToggle("nepalpay", currentScope)}
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
          Private Key (PKCS#8 PEM — optional, paste content if Nepal Pay requires token signing)
          <textarea name="privateKeyPem" rows="5" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----" style="font-family:monospace;font-size:0.8rem;width:100%">${escapeHtml(s?.privateKeyPem ?? "")}</textarea>
        </label>
        <label>
          POS Amount Column
          <input name="posCreditColumn" placeholder="CCAmt1" value="${escapeHtml(s?.posCreditColumn ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Column in POSDet table used as the invoice amount (e.g. CCAmt1)</small>
        </label>
        <fieldset style="margin-top:1rem;padding:1rem;border:1px solid #ccc;border-radius:4px;">
          <legend>API Basic Authentication</legend>
          <label>
            Username
            <input name="apiUsername" placeholder="plazmat" value="${escapeHtml(s?.apiUsername ?? "")}" />
          </label>
          <label>
            Password
            <input name="apiPassword" type="password" placeholder="Abcd@123" value="${escapeHtml(s?.apiPassword ?? "")}" />
          </label>
        </fieldset>
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
          <label>
            WS Public Key (PEM, from NCHL — used to RSA-encrypt the API token)
            <textarea name="wsPublicKeyPem" rows="4" placeholder="-----BEGIN PUBLIC KEY-----...">${escapeHtml(s?.wsPublicKeyPem ?? "")}</textarea>
          </label>
        </fieldset>
        <label>
          Report URL (transaction status API)
          <input name="reportUrl" type="url" placeholder="https://qr.npi.com.np/api/report/status" value="${escapeHtml(s?.reportUrl ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Used by the "Check Payment Status" button to look up a transaction by validationTraceId</small>
        </label>
        <label>
          Date-wise Session Report URL
          <input name="sessionReportUrl" type="url" placeholder="https://opennpi.connectips.com/nQR/v1/merchanttxnreport" value="${escapeHtml(s?.sessionReportUrl || (String(s?.reportUrl ?? "").toLowerCase().includes("merchanttxnreport") ? s.reportUrl : ""))}" />
          <small style="color:#64748b;font-size:0.8rem;">Used after payment to obtain sessionSrlNo for that transaction</small>
        </label>
        <label>
          Session Number Column
          <input name="sessionNumberColumn" placeholder="OF3" value="${escapeHtml(s?.sessionNumberColumn ?? "")}" />
          <small style="color:#64748b;font-size:0.8rem;">Column in the Busy payment-status table where the NepalPay session number will be saved</small>
        </label>
        <button type="submit">Save NEPALPAY Settings</button>
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
        <div class="panel-heading-titles">
          <h3 id="busySettingsTitle">Busy setup</h3>
          <span>${state.busySettingsConfigured ? "Settings" : "First run"}</span>
        </div>
        ${state.busySettingsConfigured ? `<button id="closeBusySettingsX" class="modal-close-button" type="button" aria-label="Close">&times;</button>` : ""}
      </div>

      ${state.error ? `<div class="error-banner popup-error">${escapeHtml(state.error)}</div>` : ""}

      ${renderScopeToggle("busy", state.settingsScope?.busy ?? "user")}
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
  document.querySelector("#checkFonepayStatus")?.addEventListener("click", () => handleVerifyPayment(invoice));
  document.querySelector("#checkNepalPayStatus")?.addEventListener("click", () => handleCheckNepalPayStatus(invoice));
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
  document.querySelector("#closeBusySettingsX")?.addEventListener("click", closeBusySettings);

  document.querySelector("#cancelPaid")?.addEventListener("click", closePaidConfirmation);
  document.querySelector("#confirmPaid")?.addEventListener("click", () => {
    const invoiceToPay =
      state.invoices.find((item) => item.invoiceNo === state.confirmPaidInvoiceNo) ?? selectedInvoice();
    handleMarkPaid(invoiceToPay);
  });
  document.querySelector("#closeSuccess")?.addEventListener("click", closeSuccessPopup);

  document.querySelector("#switchQrProvider")?.addEventListener("click", (event) => {
    switchQrProvider(event.currentTarget.dataset.provider);
  });

  document.querySelector("#regenerateQr")?.addEventListener("click", () => {
    const currentInvoice = selectedInvoice();
    if (!currentInvoice) return;
    const key = qrPayloadKey(currentInvoice);
    if (state.qrPayloads[key] !== undefined) {
      delete state.qrPayloads[key];
    }
    saveQrPayloads(state.qrPayloads);
    releaseQrGenerationLock(key);
    state.qrAutoGenerateKey = key;
    render();
  });

  document.querySelector("#nepalPaySettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleNepalPaySettingsSubmit(event.currentTarget);
  });

  // Scope toggle listeners
  for (const key of ["fonepay", "nepalpay", "busy"]) {
    document.querySelectorAll(`input[name="scope-${key}"]`).forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        const newScope = event.target.value;
        state.settingsScope = { ...state.settingsScope, [key]: newScope };
        try {
          await saveSettingsScope(state.settingsScope);
          // Changing scope also changes which file is active. Reload it now so
          // the form never keeps showing values from the previously selected
          // user/shared file and accidentally saves them into the new scope.
          if (key === "fonepay") {
            state.fonepaySettings = await getFonepaySettings();
          } else if (key === "nepalpay") {
            state.nepalPaySettings = await getNepalPaySettings();
          } else {
            const settingsState = await getBusySettings();
            state.busySettings = settingsState.settings;
            state.busySettingsConfigured = settingsState.isConfigured;
            state.busySettingsStoragePath = settingsState.storagePath;
            state.connectionSummary = await getConnectionSummary();
          }
        } catch (e) {
          state.error = `Could not change settings scope: ${errorMessage(e)}`;
        }
        render();
      });
    });
  }
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
    reportUrl: form.reportUrl.value.trim(),
    posCreditColumn
  };

  try {
    const saved = await saveFonepaySettings(settings, state.settingsScope?.fonepay ?? "user");
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
    privateKeyPem: form.privateKeyPem.value.trim(),
    posCreditColumn,
    apiUsername: form.apiUsername.value.trim(),
    apiPassword: form.apiPassword.value,
    wsUrl: form.wsUrl.value.trim(),
    wsUsername: form.wsUsername.value.trim(),
    wsApiToken: form.wsApiToken.value,
    wsPublicKeyPem: form.wsPublicKeyPem.value.trim(),
    reportUrl: form.reportUrl.value.trim(),
    sessionReportUrl: form.sessionReportUrl.value.trim(),
    sessionNumberColumn: form.sessionNumberColumn.value.trim()
  };

  try {
    const saved = await saveNepalPaySettings(settings, state.settingsScope?.nepalpay ?? "user");
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
  const col = activePosCreditColumn();
  try {
    if (state.launchInvoiceNo) {
      const invoice = await getInvoice(state.launchInvoiceNo, col);
      if (invoice) {
        state.invoices = state.invoices.map((item) =>
          item.invoiceNo === invoice.invoiceNo ? invoice : item
        );
      }
    } else if (state.query) {
      const results = await searchInvoices(state.query, col);
      state.invoices = results;
    } else {
      const latest = await getLatestInvoices(20, col);
      state.invoices = latest;
    }
    // Clear cached QR payloads so they regenerate with fresh amounts
    state.qrPayloads = {};
    saveQrPayloads({});
    state.qrProviderAvailability = {};
  } catch {
    // Non-critical — amounts will update on next invoice load
  }
}

function activePosCreditColumn() {
  // Try active provider first, fall back to the other provider so the watcher
  // and main window list always get a real column (not null) when possible
  const primary = (state.qrProvider === "nepalpay"
    ? state.nepalPaySettings?.posCreditColumn
    : state.fonepaySettings?.posCreditColumn
  )?.trim();
  if (primary) return primary;

  const secondary = (state.qrProvider === "nepalpay"
    ? state.fonepaySettings?.posCreditColumn
    : state.nepalPaySettings?.posCreditColumn
  )?.trim();
  return secondary || null;
}

async function refreshSelectedInvoiceForCurrentProvider() {
  const currentInvoice = selectedInvoice();
  if (!currentInvoice?.invoiceNo) return currentInvoice;

  try {
    const col = activePosCreditColumn();
    const refreshedInvoice = currentInvoice.vchCode
      ? await getInvoiceByVchCode(currentInvoice.vchCode, col)
      : await getInvoice(currentInvoice.invoiceNo, col);

    if (!refreshedInvoice) return currentInvoice;

    state.invoices = state.invoices.map((item) =>
      invoiceKey(item) === invoiceKey(refreshedInvoice) ? refreshedInvoice : item
    );
    state.selectedInvoiceKey = invoiceKey(refreshedInvoice);
    return refreshedInvoice;
  } catch {
    return currentInvoice;
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

  console.log("[NP-WS] ensure socket", {
    invoiceNo: invoice?.invoiceNo,
    key,
    wsUrl,
    validationTraceId: payload?.validationTraceId ?? null,
    provider: payload?.provider ?? "nepalpay",
  });
  console.log(`[Payment] [NepalPay] websocket-ensure invoice=${invoice?.invoiceNo ?? "-"} url=${wsUrl || "-"} trace=${payload?.validationTraceId ?? "-"}`);
  logPaymentStatus(`[NepalPay] websocket-ensure invoice=${invoice?.invoiceNo ?? "-"} url=${wsUrl || "-"} trace=${payload?.validationTraceId ?? "-"}`).catch(() => {});

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

function normalizeNepalPayPayload(message) {
  if (!message || typeof message !== "object") return null;

  const signalFields = [
    "status",
    "txn_status",
    "txnStatus",
    "transaction_status",
    "transactionStatus",
    "payment_status",
    "paymentStatus",
    "response_status",
    "responseStatus",
    "state",
    "txStatus",
    "event",
    "result_status",
    "resultStatus",
    "message",
    "activityMessage",
    "detail",
    "description",
    "debit_status",
    "credit_status",
    "txn_id",
    "request_id",
    "merchant_id",
    "ws_id",
    "responseMessage"
  ];

  const candidates = [
    message,
    message.data,
    message.payload,
    message.response,
    message.result,
    message.transaction,
    message.details,
    message.body,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));

  const hasSignal = (candidate) => signalFields.some((field) => candidate[field] !== undefined && candidate[field] !== null && candidate[field] !== "");

  const bestCandidate = candidates.find(hasSignal) ?? candidates[0] ?? null;
  return bestCandidate;
}

function classifyNepalPayStatus(message) {
  const payload = normalizeNepalPayPayload(message);
  if (!payload) return { kind: "unknown", status: "" };

  const rawStatus = [
    payload.status,
    payload.txn_status,
    payload.txnStatus,
    payload.transaction_status,
    payload.transactionStatus,
    payload.payment_status,
    payload.paymentStatus,
    payload.response_status,
    payload.responseStatus,
    payload.state,
    payload.txStatus,
    payload.event,
    payload.result_status,
    payload.resultStatus,
    payload.code,
    payload.response_code,
    payload.responseCode,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).trim())[0];

  const normalized = rawStatus ? rawStatus.toUpperCase() : "";
  const lowered = normalized.toLowerCase();
  const messageText = String(payload.message ?? payload.activityMessage ?? payload.detail ?? payload.description ?? "").trim().toLowerCase();

  if (["ENTR", "PARSED"].includes(normalized)) {
    return { kind: "progress", status: normalized };
  }

  if (["COMPLETED", "SUCCESS", "SUCCESSFUL", "PAID", "PAYMENT_SUCCESS", "PAYMENT_COMPLETED", "TRANSACTION_COMPLETED", "DONE", "OK", "APPROVED"].includes(normalized) || lowered.includes("complete") || lowered.includes("success") || lowered.includes("paid") || lowered.includes("approved") || messageText.includes("completed") || messageText.includes("success") || messageText.includes("paid")) {
    return { kind: "success", status: normalized || "SUCCESS" };
  }

  if (["FAILED", "FAILURE", "DECLINED", "REJECTED", "ERROR", "CANCELLED", "CANCELED", "TIMEOUT", "EXPIRED"].includes(normalized) || lowered.includes("fail") || lowered.includes("error") || lowered.includes("cancel") || messageText.includes("fail") || messageText.includes("error") || messageText.includes("cancel")) {
    return { kind: "failure", status: normalized || "FAILED" };
  }

  return { kind: "unknown", status: normalized };
}

function _connectNepalPayStompSocket(invoice, payload, key, wsUrl, entry) {
  console.log("[NP-WS] Connecting", { wsUrl, invoiceNo: invoice.invoiceNo, retryCount: entry.retryCount });
  const socket = new WebSocket(wsUrl);
  entry.socket = socket;

  socket.onopen = () => {
    console.log("[NP-WS] Connected — sending STOMP CONNECT", { invoiceNo: invoice.invoiceNo, wsUrl });
    console.log(`[Payment] [NepalPay] websocket-open invoice=${invoice.invoiceNo} url=${wsUrl}`);
    logPaymentStatus(`[NepalPay] websocket-open invoice=${invoice.invoiceNo} url=${wsUrl}`).catch(() => {});
    stompSend(socket, "CONNECT", { "accept-version": "1.2", "heart-beat": "0,0" }, "");
  };

  socket.onmessage = async (event) => {
    const frame = stompParse(event.data);
    if (!frame) { console.warn("[NP-WS] Could not parse frame:", event.data); return; }

    console.log("[NP-WS] Frame received", { command: frame.command, bodyPreview: frame.body?.slice(0, 120), invoiceNo: invoice.invoiceNo });
    console.log(`[Payment] [NepalPay] websocket-frame invoice=${invoice.invoiceNo} command=${frame.command}`);
    logPaymentStatus(`[NepalPay] websocket-frame invoice=${invoice.invoiceNo} command=${frame.command}`).catch(() => {});

    if (frame.command === "CONNECTED") {
      console.log("[NP-WS] STOMP CONNECTED — subscribing and sending transaction request");
      stompSend(socket, "SUBSCRIBE", {
        id: "sub-0",
        destination: "/user/nqrws/check-txn-status"
      }, "");

      let encryptedApiToken = "";
      try {
        encryptedApiToken = await encryptNepalPayWsToken(
          state.nepalPaySettings?.wsApiToken ?? "",
          state.nepalPaySettings?.wsPublicKeyPem ?? ""
        );
      } catch (error) {
        console.error("[NP-WS] Failed to RSA-encrypt api_token", error);
        logPaymentStatus(`[NepalPay] websocket-token-encrypt-error invoice=${invoice.invoiceNo} error=${errorMessage(error)}`).catch(() => {});
      }

      const body = JSON.stringify({
        merchant_id: "Terminal1",
        request_id: payload.validationTraceId,
        username: state.nepalPaySettings?.wsUsername ?? "",
        api_token: encryptedApiToken
      });
      console.log("[NP-WS] SEND payload", {
        merchant_id: "Terminal1",
        request_id: payload.validationTraceId,
        username: state.nepalPaySettings?.wsUsername ? "(set)" : "(missing)",
        api_token: encryptedApiToken ? "(encrypted)" : "(missing)",
      });
      console.log("[NP-WS] SEND payload (raw body)", { invoiceNo: invoice.invoiceNo, body });
      logPaymentStatus(`[NepalPay] outbound-payload invoice=${invoice.invoiceNo} body=${body}`).catch(() => {});
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
    const rawMessagePreview = typeof frame.body === "string" ? frame.body.slice(0, 800) : frame.body;
    console.log(`[Payment] [NepalPay] websocket-message invoice=${invoice.invoiceNo} body=${rawMessagePreview}`);
    logPaymentStatus(`[NepalPay] websocket-message invoice=${invoice.invoiceNo} body=${rawMessagePreview}`).catch(() => {});
    console.log("[NP-WS] Incoming payload", {
      invoiceNo: invoice.invoiceNo,
      rawBody: frame.body,
      parsedPayload: message,
    });

    if (!message || typeof message !== "object") {
      console.warn("[NP-WS] MESSAGE body is not valid JSON:", frame.body);
      return;
    }

    const statusInfo = classifyNepalPayStatus(message);
    const status = statusInfo.status;
    console.log("[NP-WS] Payment event received", { status, fullMessage: message });

    if (statusInfo.kind === "progress") {
      // Phase: QR Parsing — customer established WS connection
      console.log("[NP-WS] ENTR — connection established", {
        merchant_id: message.merchant_id,
        request_id: message.request_id,
        ws_id: message.ws_id,
        activityMessage: message.message,
      });
      current.status = status === "PARSED" ? "parsed" : "entr";
      render();
      return;
    }

    if (statusInfo.kind === "progress" && status === "PARSED") {
      // Phase: QR Parsing — customer scanned the QR code
      console.log("[NP-WS] PARSED — QR scanned by customer", {
        merchant_id: message.merchant_id,
        request_id: message.request_id,
        ws_id: message.ws_id,
        activityMessage: message.message,
      });
      current.status = "parsed";
      render();
      return;
    }

    if (statusInfo.kind === "success") {
      // Phase: QR Transaction — debit_status 000 = success, rest = failed
      // credit_status 000/999/DEFER = success, rest = failed
      const debitStatus = String(message.debit_status ?? "");
      const creditStatus = String(message.credit_status ?? "");
      // txn_id is the unique channel id (= validationTraceId from QR generation)
      const txnId = String(message.txn_id ?? message.request_id ?? payload.validationTraceId ?? "").trim();
      // message.message is the Nepal Pay activity description (e.g. "Transaction Completed")
      const activityMessage = String(message.message ?? "").trim();
      console.log("[NP-WS] COMPLETED event", {
        debitStatus,
        creditStatus,
        txnId,
        activityMessage,
        merchant_id: message.merchant_id,
        ws_id: message.ws_id,
        fullMessage: message,
      });

      current.handled = true;
      _clearNepalPayTimers(current);

      const debitSuccess = debitStatus === "000";

      if (!debitSuccess) {
        console.warn("[NP-WS] COMPLETED — debit failed", { debitStatus, creditStatus, activityMessage });
        current.status = "failed";
        const failureLog = `[NepalPay] invoice=${invoice.invoiceNo} status=failed reason=${encodeURIComponent(activityMessage || `debit_status:${debitStatus}`)} debit=${debitStatus} credit=${creditStatus}`;
        await logPaymentStatus(failureLog).catch(() => {});
        notifyFonepayPaymentOutcome("failure", invoice.invoiceNo, activityMessage || `debit_status: ${debitStatus}`);
        closeNepalPayStompSocket(key);
        render();
        return;
      }

      current.status = "completed";
      console.log("[NP-WS] Payment success — marking invoice paid", { txnId, creditStatus, activityMessage, invoiceNo: invoice.invoiceNo });
      console.log(`[Payment] [NepalPay] payment-success invoice=${invoice.invoiceNo} txn=${txnId || "-"} status=${debitStatus}/${creditStatus}`);
      logPaymentStatus(`[NepalPay] payment-success invoice=${invoice.invoiceNo} txn=${txnId || "-"} status=${debitStatus}/${creditStatus}`).catch(() => {});

      try {
        const successLog = `[NepalPay] invoice=${invoice.invoiceNo} status=success txnId=${txnId || "-"} activity=${activityMessage || "-"} debit=${debitStatus} credit=${creditStatus}`;
        await logPaymentStatus(successLog).catch(() => {});
        const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, txnId || undefined, "nepalpay");
        if (updatedInvoice) {
          const sessionNumber = await saveNepalPaySessionWithRetry(invoice.invoiceNo, txnId);
          state.invoices = state.invoices.map((item) =>
            invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
          );
          state.successMessage = `NEPALPAY payment received. Invoice ${updatedInvoice.invoiceNo} marked as Paid.${sessionNumber ? ` Session ${sessionNumber} saved.` : " Session number is not available in the date-wise report yet."}`;
          state.error = "";
          rememberNepalPayValidationTraceId(invoice, payload?.validationTraceId);
          removeQrPayloadForInvoice(invoice, "nepalpay");
          localStorage.setItem(
            PAYMENT_UPDATE_STORAGE_KEY,
            JSON.stringify({
              invoiceNo: updatedInvoice.invoiceNo,
              status: "Paid",
              txnId,
              activityMessage,
              debitStatus,
              creditStatus,
              at: Date.now(),
            })
          );
          const notifyDetail = [txnId ? `TXN ${txnId}` : "", activityMessage].filter(Boolean).join(" | ");
          notifyFonepayPaymentOutcome("success", invoice.invoiceNo, notifyDetail);
          console.log("[NP-WS] Invoice marked Paid", { invoiceNo: updatedInvoice.invoiceNo, txnId, activityMessage });
        }
      } catch (error) {
        console.error("[NP-WS] markInvoicePaid failed", { invoiceNo: invoice.invoiceNo, error: String(error) });
        state.error = errorMessage(error);
      } finally {
        closeNepalPayStompSocket(key);
        render();
      }
      return;
    }

    if (statusInfo.kind === "failure") {
      // Phase: QR Transaction — payment failed
      const activityMessage = String(message.message ?? "Payment failed").trim();
      const debitStatus = String(message.debit_status ?? "");
      const creditStatus = String(message.credit_status ?? "");
      console.log("[NP-WS] FAILED — payment failed", {
        debitStatus,
        creditStatus,
        activityMessage,
        merchant_id: message.merchant_id,
        ws_id: message.ws_id,
        fullMessage: message,
      });
      current.handled = true;
      current.status = "failed";
      _clearNepalPayTimers(current);
      const failureLog = `[NepalPay] invoice=${invoice.invoiceNo} status=failed reason=${encodeURIComponent(activityMessage)} debit=${debitStatus} credit=${creditStatus}`;
      await logPaymentStatus(failureLog).catch(() => {});
      notifyFonepayPaymentOutcome("failure", invoice.invoiceNo, activityMessage);
      closeNepalPayStompSocket(key);
      render();
      return;
    }

    console.log("[NP-WS] Unhandled status event", { status, fullMessage: message });
  };

  socket.onerror = (event) => {
    console.error("[NP-WS] WebSocket error", { invoiceNo: invoice.invoiceNo, wsUrl });
    console.log(`[Payment] [NepalPay] websocket-error invoice=${invoice.invoiceNo} url=${wsUrl}`);
    logPaymentStatus(`[NepalPay] websocket-error invoice=${invoice.invoiceNo} url=${wsUrl}`).catch(() => {});
    const current = nepalPayStompSockets.get(key);
    if (!current || current.handled) return;
    current.status = "error";
    // Don't render here — onclose fires next and handles reconnect
  };

  socket.onclose = (event) => {
    console.log("[NP-WS] WebSocket closed", { code: event.code, reason: event.reason, invoiceNo: invoice.invoiceNo });
    console.log(`[Payment] [NepalPay] websocket-closed invoice=${invoice.invoiceNo} code=${event.code} reason=${event.reason || "(none)"}`);
    logPaymentStatus(`[NepalPay] websocket-closed invoice=${invoice.invoiceNo} code=${event.code} reason=${event.reason || "(none)"}`).catch(() => {});
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
      state.error = `NEPALPAY: WebSocket connection failed after ${NP_MAX_RETRIES} retries for invoice ${invoice.invoiceNo}.`;
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

// Only the validationTraceId is persisted — check results (transaction, error)
// are re-fetched live and not worth persisting.
function loadNepalPayTraceIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(NP_TRACE_IDS_STORAGE_KEY)) ?? {};
    return Object.fromEntries(
      Object.entries(stored).map(([key, validationTraceId]) => [key, { validationTraceId }])
    );
  } catch {
    return {};
  }
}

function saveNepalPayTraceId(qrKey, validationTraceId) {
  if (!qrKey || !validationTraceId) return;
  try {
    const stored = JSON.parse(localStorage.getItem(NP_TRACE_IDS_STORAGE_KEY)) ?? {};
    stored[qrKey] = validationTraceId;
    localStorage.setItem(NP_TRACE_IDS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore storage errors — trace ID will only be available for this session.
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
  const updatedInvoice = await getInvoice(invoiceNo, activePosCreditColumn());

  if (!updatedInvoice) return;

  state.invoices = state.invoices.map((item) =>
    item.invoiceNo === updatedInvoice.invoiceNo ? updatedInvoice : item
  );

  if (state.selectedInvoiceKey === invoiceKey(updatedInvoice)) {
    state.selectedInvoiceKey = invoiceKey(updatedInvoice);
  }

  render();
}

function logFonepayTerminal(message) {
  logPaymentStatus(message).catch(() => {
    // Ignore terminal logging failures — console logging already covers this.
  });
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function saveNepalPaySessionWithRetry(invoiceNo, transactionId) {
  const configuredSessionUrl = state.nepalPaySettings?.sessionReportUrl
    || (String(state.nepalPaySettings?.reportUrl ?? "").toLowerCase().includes("merchanttxnreport")
      ? state.nepalPaySettings.reportUrl
      : "");
  if (!configuredSessionUrl || !state.nepalPaySettings?.sessionNumberColumn) {
    return null;
  }

  // The date-wise report can trail the WebSocket completion notification by
  // a few seconds. Retry briefly before leaving the transaction paid without
  // its session serial number.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    try {
      const result = await recordNepalPaySessionNumber(
        invoiceNo,
        transactionId ?? "",
        localIsoDate()
      );
      if (result?.sessionNumber) return result.sessionNumber;
    } catch (error) {
      console.warn(`[NepalPay] Session lookup attempt ${attempt + 1} failed`, error);
    }
  }
  return null;
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

  console.log("[Fonepay-WS] Connecting", { url, invoiceNo: invoice.invoiceNo });
  logFonepayTerminal(`[Fonepay-WS] Connecting invoice=${invoice.invoiceNo} url=${url}`);

  const socket = new WebSocket(url);
  qrPaymentSockets.set(key, { url, socket, handled: false, status: "connecting" });

  socket.onopen = () => {
    console.log("[Fonepay-WS] Connected", { invoiceNo: invoice.invoiceNo, url });
    logFonepayTerminal(`[Fonepay-WS] Connected invoice=${invoice.invoiceNo}`);
    const current = qrPaymentSockets.get(key);
    if (current?.socket === socket) {
      current.status = "open";
      render();
    }
  };

  socket.onmessage = async (event) => {
    console.log("[Fonepay-WS] Message received", { invoiceNo: invoice.invoiceNo, data: event.data });
    logFonepayTerminal(`[Fonepay-WS] Message invoice=${invoice.invoiceNo} data=${event.data}`);

    const current = qrPaymentSockets.get(key);

    if (!current || current.handled) {
      return;
    }

    const message = parseFonepayWebSocketMessage(event.data);

    if (!message) {
      console.log("[Fonepay-WS] Message could not be parsed", { invoiceNo: invoice.invoiceNo });
      logFonepayTerminal(`[Fonepay-WS] Message could not be parsed invoice=${invoice.invoiceNo}`);
      return;
    }

    if (isFonepayPaymentSuccess(message)) {
      console.log("[Fonepay-WS] Payment success", { invoiceNo: invoice.invoiceNo, message });
      logFonepayTerminal(`[Fonepay-WS] Payment success invoice=${invoice.invoiceNo}`);
      current.handled = true;

      try {
        const updatedInvoice = await markInvoicePaid(invoice.invoiceNo, fonepayTransactionId(message), "fonepay");

        if (updatedInvoice) {
          state.invoices = state.invoices.map((item) =>
            invoiceKey(item) === invoiceKey(updatedInvoice) ? updatedInvoice : item
          );
          state.error = "";
          state.successMessage = `Payment received. Invoice ${updatedInvoice.invoiceNo} marked as Paid.`;
          removeQrPayloadForInvoice(invoice, "fonepay");
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
        render();
      }

      return;
    }

    if (isFonepayPaymentFailure(message)) {
      console.log("[Fonepay-WS] Payment failure", { invoiceNo: invoice.invoiceNo, message });
      logFonepayTerminal(`[Fonepay-WS] Payment failure invoice=${invoice.invoiceNo}`);
      current.handled = true;
      notifyFonepayPaymentOutcome("failure", invoice.invoiceNo, summarizeFonepayStatus(message));

      closeFonepayPaymentSocket(key);
      render();
      return;
    }

    if (current.status !== "scanned") {
      console.log("[Fonepay-WS] QR scanned — awaiting final status", { invoiceNo: invoice.invoiceNo });
      logFonepayTerminal(`[Fonepay-WS] QR scanned invoice=${invoice.invoiceNo}`);
      current.status = "scanned";
      render();
    }
  };

  socket.onerror = (event) => {
    console.log("[Fonepay-WS] Error", { invoiceNo: invoice.invoiceNo, url, event });
    logFonepayTerminal(`[Fonepay-WS] Error invoice=${invoice.invoiceNo} url=${url}`);
    state.error = `Unable to connect to Fonepay payment socket for invoice ${invoice.invoiceNo}.`;
    const current = qrPaymentSockets.get(key);
    if (current?.socket === socket) {
      current.status = "error";
    }
    render();
  };

  socket.onclose = (event) => {
    console.log("[Fonepay-WS] Closed", {
      invoiceNo: invoice.invoiceNo,
      code: event?.code,
      reason: event?.reason,
    });
    logFonepayTerminal(`[Fonepay-WS] Closed invoice=${invoice.invoiceNo} code=${event?.code} reason=${event?.reason}`);
    const current = qrPaymentSockets.get(key);
    if (current?.socket === socket) {
      qrPaymentSockets.delete(key);
    }
  };
}

function renderFonepayLiveStatus(qrKey) {
  const entry = qrPaymentSockets.get(qrKey);
  const status = entry?.status ?? "connecting";
  const waitingLine = `<p class="qr-status qr-waiting-line">Waiting for payment</p>`;

  const labels = {
    connecting: `<p class="qr-status">WebSocket: Connecting…</p>`,
    open: `<p class="qr-status ws-status-connected">WebSocket: Connected</p>`,
    scanned: `<p class="qr-status ws-status-connected">WebSocket: Connected — QR scanned, processing payment…</p>`,
    error: `<p class="qr-status np-status-fail">WebSocket: Connection failed.</p>`,
  };
  return waitingLine + (labels[status] ?? labels.connecting);
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

  if (isTruthyFlag(statusSource.paymentSuccess) || isTruthyFlag(raw.paymentSuccess)) {
    return true;
  }

  // thirdPartyDynamicQRGetStatus (the Dynamic QR status-check fallback used when
  // the websocket doesn't notify) returns paymentStatus: "success" | "failed" |
  // "pending" — a string, not the paymentSuccess boolean flag above.
  const paymentStatus = String(statusSource.paymentStatus ?? raw.paymentStatus ?? "").trim().toLowerCase();
  return paymentStatus === "success";
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

  const paymentStatus = String(statusSource.paymentStatus ?? raw.paymentStatus ?? "").trim().toLowerCase();
  if (paymentStatus === "failed") {
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
