mod commands;
mod db;
mod models;

use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use db::BusyDb;

fn candidate_license_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("license.txt"));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("license.txt"));
            if let Some(parent_dir) = exe_dir.parent() {
                candidates.push(parent_dir.join("license.txt"));
            }
        }
    }

    candidates
}

fn resolve_license_file_path() -> Option<PathBuf> {
    candidate_license_paths()
        .into_iter()
        .find(|path| path.is_file())
}

fn today_ymd() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days_since_epoch = seconds / 86_400;

    let mut year = 1970u64;
    let mut remaining_days = days_since_epoch;
    while remaining_days >= days_in_year(year) {
        remaining_days -= days_in_year(year);
        year += 1;
    }

    let mut month = 1u64;
    while remaining_days >= days_in_month(year, month) {
        remaining_days -= days_in_month(year, month);
        month += 1;
    }

    let day = remaining_days + 1;
    format!("{year:04}-{month:02}-{day:02}")
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn days_in_year(year: u64) -> u64 {
    if is_leap_year(year) { 366 } else { 365 }
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn validate_license_file() -> Result<(), String> {
    let path = resolve_license_file_path()
        .ok_or_else(|| "License file not found in the app folder or current working directory".to_string())?;
    let content = fs::read_to_string(&path).map_err(|_| format!("License file not found: {}", path.display()))?;
    let license = content.trim();
    if license.is_empty() {
        return Err("License file is empty".to_string());
    }

    let (key, expiry) = if let Some((key, expiry)) = license.split_once('|') {
        (key.trim(), Some(expiry.trim()))
    } else {
        (license, None)
    };

    let expected = "BUSYPAY-LICENSE-2026";
    if key != expected {
        return Err("Invalid license key".to_string());
    }

    if let Some(expiry) = expiry {
        if expiry.len() != 10 {
            return Err("Invalid license expiry format".to_string());
        }

        let today = today_ymd();
        if expiry < today.as_str() {
            return Err(format!("License expired on {expiry}"));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::SystemTime};

    #[test]
    fn finds_license_in_current_working_directory() {
        let unique_name = format!("busypay_qr_license_test_{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let temp_dir = std::env::temp_dir().join(unique_name);
        fs::create_dir_all(&temp_dir).unwrap();

        let original_dir = std::env::current_dir().unwrap();
        std::env::set_current_dir(&temp_dir).unwrap();

        let license_path = temp_dir.join("license.txt");
        fs::write(&license_path, "BUSYPAY-LICENSE-2026|2030-12-31").unwrap();

        let resolved = resolve_license_file_path();
        assert_eq!(resolved.as_deref(), Some(license_path.as_path()));

        std::env::set_current_dir(original_dir).unwrap();
        let _ = fs::remove_file(license_path);
        let _ = fs::remove_dir(temp_dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !cfg!(debug_assertions) {
        if let Err(error) = validate_license_file() {
            eprintln!("[License] {error}");
            std::process::exit(1);
        }
    }

    tauri::Builder::default()
        .manage(BusyDb::from_env())
        .manage(commands::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_invoice,
            commands::get_invoice_by_vch_code,
            commands::get_latest_invoices,
            commands::search_invoice,
            commands::mark_invoice_paid,
            commands::log_payment_status,
            commands::save_bank_merchant,
            commands::get_fonepay_settings,
            commands::save_fonepay_settings,
            commands::delete_fonepay_settings,
            commands::generate_fonepay_dynamic_qr,
            commands::verify_fonepay_payment_qr,
            commands::get_nepalpay_settings,
            commands::save_nepalpay_settings,
            commands::delete_nepalpay_settings,
            commands::generate_nepalpay_dynamic_qr,
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
