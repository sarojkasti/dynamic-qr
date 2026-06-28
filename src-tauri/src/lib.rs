mod commands;
mod db;
mod models;

use db::BusyDb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BusyDb::from_env())
        .manage(commands::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_invoice,
            commands::get_invoice_by_vch_code,
            commands::get_latest_invoices,
            commands::search_invoice,
            commands::mark_invoice_paid,
            commands::save_bank_merchant,
            commands::get_fonepay_settings,
            commands::save_fonepay_settings,
            commands::generate_fonepay_dynamic_qr,
            commands::verify_fonepay_payment_qr,
            commands::get_busy_connection_summary,
            commands::get_busy_settings,
            commands::save_busy_settings,
            commands::get_launch_invoice_no,
            commands::get_launch_watch_latest,
            commands::start_busy_invoice_watcher,
            commands::stop_busy_invoice_watcher
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
