import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const fallbackInvoices = [
  {
    vchCode: 1001,
    vchSeriesCode: 1,
    invoiceNo: "SI-1001",
    invoiceDate: "2026-05-13",
    invoiceDateNepali: "2083-01-30",
    partyName: "Walk-in Customer",
    netAmount: "2500.00",
    amountSource: "Invoice net amount",
    paymentStatus: "Pending"
  },
  {
    vchCode: 1000,
    vchSeriesCode: 1,
    invoiceNo: "SI-1000",
    invoiceDate: "2026-05-12",
    invoiceDateNepali: "2083-01-29",
    partyName: "Demo Trading",
    netAmount: "9750.00",
    amountSource: "Invoice net amount",
    paymentStatus: "Paid"
  }
];

function canUseTauri() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function getConnectionSummary() {
  if (!canUseTauri()) return "Browser preview: set BUSY_ODBC_CONNECTION_STRING for desktop";
  return invoke("get_busy_connection_summary");
}

export async function getBusySettings() {
  if (!canUseTauri()) {
    return {
      settings: {
        connectionString: "DSN=BusyDSN;Database=BusyComp0001_db12082;",
        invoiceTable: "Tran1",
        salesVoucherType: 9,
        paymentStatusTable: "VchOtherInfo",
        paymentStatusColumn: "OF2",
        paymentTransactionIdColumn: "OF1"
      },
      isConfigured: false,
      storagePath: "browser preview"
    };
  }

  return invoke("get_busy_settings");
}

export async function saveBusySettings(settings) {
  if (!canUseTauri()) return settings;
  return invoke("save_busy_settings", { settings });
}

export async function getLaunchInvoiceNo() {
  const params = new URLSearchParams(window.location.search);
  const queryInvoice = params.get("invoice") || params.get("invoiceNo") || params.get("vchNo");

  if (queryInvoice?.trim()) return queryInvoice.trim();
  if (!canUseTauri()) return "";

  return (await invoke("get_launch_invoice_no")) ?? "";
}

export async function getLaunchWatchLatest() {
  const params = new URLSearchParams(window.location.search);
  const watchParam = params.get("watch") || params.get("watchLatest");

  if (watchParam) return ["1", "true", "yes", "latest", "busy"].includes(watchParam.toLowerCase());
  if (!canUseTauri()) return false;

  return invoke("get_launch_watch_latest");
}

export async function focusAppWindow() {
  if (!canUseTauri()) return;

  const appWindow = getCurrentWindow();
  await appWindow.show();
  await appWindow.unminimize();
  await appWindow.setFocus();
}

export async function closeAppWindow() {
  if (!canUseTauri()) return;

  await getCurrentWindow().close();
}

export async function openInvoicePopup(invoice) {
  if (!canUseTauri() || !invoice?.invoiceNo) return;

  const popupParams = new URLSearchParams({ popup: "1", invoice: invoice.invoiceNo });
  if (invoice.vchCode) popupParams.set("vchCode", String(invoice.vchCode));
  const popupUrl = `index.html?${popupParams.toString()}`;
  const existingPopup = await WebviewWindow.getByLabel("invoice-qr-popup");

  if (existingPopup) {
    await existingPopup.setFocus();
    await existingPopup.emit("invoice-popup-update", {
      invoiceNo: invoice.invoiceNo,
      vchCode: invoice.vchCode ?? null
    });
    return;
  }

  const popup = new WebviewWindow("invoice-qr-popup", {
    url: popupUrl,
    title: `Invoice ${invoice.invoiceNo}`,
    width: 430,
    height: 620,
    minWidth: 390,
    minHeight: 560,
    resizable: true,
    maximizable: false,
    decorations: true,
    center: true,
    focus: true
  });

  popup.once("tauri://created", async () => {
    await popup.setFocus();
  });
}

export async function listenToInvoicePopupUpdate(callback) {
  if (!canUseTauri()) return () => {};
  return WebviewWindow.getCurrent().listen("invoice-popup-update", (event) => callback(event.payload));
}

export async function getLatestInvoices(limit = 20) {
  if (!canUseTauri()) return fallbackInvoices.slice(0, limit);
  return invoke("get_latest_invoices", { limit });
}

export async function searchInvoices(query) {
  if (!query.trim()) return getLatestInvoices();

  if (!canUseTauri()) {
    const needle = query.toLowerCase();
    return fallbackInvoices.filter((invoice) =>
      `${invoice.invoiceNo} ${invoice.partyName}`.toLowerCase().includes(needle)
    );
  }

  return invoke("search_invoice", { query });
}

export async function getInvoice(invoiceNo) {
  if (!canUseTauri()) {
    return fallbackInvoices.find((invoice) => invoice.invoiceNo === invoiceNo) ?? null;
  }

  return invoke("get_invoice", { invoiceNo });
}

export async function getInvoiceByVchCode(vchCode) {
  if (!canUseTauri()) {
    return fallbackInvoices.find((invoice) => invoice.vchCode === Number(vchCode)) ?? null;
  }

  return invoke("get_invoice_by_vch_code", { vchCode: Number(vchCode) });
}

export async function markInvoicePaid(invoiceNo, transactionId = "") {
  if (!canUseTauri()) {
    const invoice = fallbackInvoices.find((item) => item.invoiceNo === invoiceNo);
    if (invoice) invoice.paymentStatus = "Paid";
    return invoice ?? null;
  }

  return invoke("mark_invoice_paid", { invoiceNo, transactionId });
}

export async function saveBankMerchant(bank) {
  if (!canUseTauri()) return bank;
  return invoke("save_bank_merchant", { bank });
}

export async function getFonepaySettings() {
  if (!canUseTauri()) return {
    dynamicUrl: "",
    posApiUrl: "",
    merchantCode: "",
    merchantSecret: "",
    username: "",
    password: "",
    integrationMode: ""
  };
  return invoke("get_fonepay_settings");
}

export async function saveFonepaySettings(settings) {
  if (!canUseTauri()) return settings;
  return invoke("save_fonepay_settings", { settings });
}

export async function generateFonepayDynamicQr(request) {
  if (!canUseTauri()) {
    return { qrText: request.transactionId, imageDataUrl: null, raw: { preview: true, mode: "browser" } };
  }

  return invoke("generate_fonepay_dynamic_qr", { request });
}

export async function verifyFonepayPaymentQr(prn, amount = "") {
  if (!canUseTauri()) return { raw: { preview: true, prn, amount } };
  return invoke("verify_fonepay_payment_qr", { request: { prn, amount } });
}

export async function startBusyInvoiceWatcher() {
  if (!canUseTauri()) return;
  return invoke("start_busy_invoice_watcher");
}

export async function stopBusyInvoiceWatcher() {
  if (!canUseTauri()) return;
  return invoke("stop_busy_invoice_watcher");
}

export async function listenToBusyInvoiceCreated(callback) {
  if (!canUseTauri()) return () => {};
  return listen("busy-invoice-created", (event) => callback(event.payload));
}

export async function listenToBusyInvoiceWatchError(callback) {
  if (!canUseTauri()) return () => {};
  return listen("busy-invoice-watch-error", (event) => callback(event.payload));
}
