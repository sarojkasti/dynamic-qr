use std::{
    env,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use tauri::State;
use tauri::{AppHandle, Emitter};

use crate::{
    db::BusyDb,
    models::{
        ApiError, BankMerchant, BusySettings, BusySettingsState, DynamicQrRequest,
        DynamicQrResponse, FonepaySettings, Invoice, PaymentQrStatusRequest,
        PaymentQrStatusResponse,
    },
};

use sha2::{Digest, Sha512};

#[derive(Default)]
pub struct WatcherState {
    running: Arc<AtomicBool>,
}

#[tauri::command]
pub fn get_invoice(db: State<'_, BusyDb>, invoice_no: String) -> Result<Option<Invoice>, ApiError> {
    db.get_invoice_by_id(invoice_no).map_err(ApiError::from)
}

#[tauri::command]
pub fn get_invoice_by_vch_code(
    db: State<'_, BusyDb>,
    vch_code: i32,
) -> Result<Option<Invoice>, ApiError> {
    db.get_invoice_by_vch_code(vch_code).map_err(ApiError::from)
}

#[tauri::command]
pub fn get_latest_invoices(db: State<'_, BusyDb>, limit: i32) -> Result<Vec<Invoice>, ApiError> {
    db.get_latest_invoices(limit).map_err(ApiError::from)
}

#[tauri::command]
pub fn search_invoice(db: State<'_, BusyDb>, query: String) -> Result<Vec<Invoice>, ApiError> {
    db.search_invoice(query).map_err(ApiError::from)
}

#[tauri::command]
pub fn mark_invoice_paid(
    db: State<'_, BusyDb>,
    invoice_no: String,
    transaction_id: Option<String>,
) -> Result<Option<Invoice>, ApiError> {
    db.mark_invoice_paid(invoice_no, transaction_id)
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn save_bank_merchant(
    db: State<'_, BusyDb>,
    bank: BankMerchant,
) -> Result<BankMerchant, ApiError> {
    if bank.name.trim().is_empty()
        || bank.bank_type.trim().is_empty()
        || bank.merchant_code.trim().is_empty()
        || bank.merchant_username.trim().is_empty()
        || bank.merchant_password.trim().is_empty()
        || bank.merchant_secret_key.trim().is_empty()
    {
        return Err(ApiError::from("All bank merchant fields are required"));
    }

    // Save FONEPAY settings from bank merchant
    if !bank.fonepay_dynamic_url.trim().is_empty()
        || !bank.fonepay_pos_api_url.trim().is_empty()
        || !bank.fonepay_integration_mode.trim().is_empty()
    {
        let fonepay_settings = FonepaySettings {
            dynamic_url: bank.fonepay_dynamic_url.clone(),
            pos_api_url: bank.fonepay_pos_api_url.clone(),
            merchant_code: bank.merchant_code.clone(),
            merchant_secret: bank.merchant_secret_key.clone(),
            username: bank.merchant_username.clone(),
            password: bank.merchant_password.clone(),
            integration_mode: bank.fonepay_integration_mode.clone(),
        };
        let _ = crate::db::write_fonepay_settings(&fonepay_settings);
    }

    // Persist pos_credit_column into BusySettings so invoice queries use it
    if !bank.pos_credit_column.trim().is_empty() {
        if let Ok(mut settings) = db.settings() {
            settings.pos_credit_column = Some(bank.pos_credit_column.trim().to_string());
            let _ = db.save_settings(settings);
        }
    }

    Ok(bank)
}

#[tauri::command]
pub fn get_fonepay_settings() -> Result<FonepaySettings, ApiError> {
    crate::db::read_fonepay_settings().map_err(ApiError::from)
}

#[tauri::command]
pub fn save_fonepay_settings(settings: FonepaySettings) -> Result<FonepaySettings, ApiError> {
    crate::db::write_fonepay_settings(&settings).map_err(ApiError::from)
}

#[tauri::command]
pub async fn generate_fonepay_dynamic_qr(
    request: DynamicQrRequest,
) -> Result<DynamicQrResponse, ApiError> {
    load_app_dotenv();

    if fonepay_mode() == "dynamic_api" {
        return generate_fonepay_third_party_dynamic_qr(request).await;
    }

    generate_fonepay_pos_dynamic_qr(request).await
}

async fn generate_fonepay_third_party_dynamic_qr(
    request: DynamicQrRequest,
) -> Result<DynamicQrResponse, ApiError> {
    if request.transaction_id.trim().is_empty() {
        return Err(ApiError::from("Transaction id is required"));
    }

    if request.amount.trim().is_empty() {
        return Err(ApiError::from("Amount is required"));
    }

    validate_amount(request.amount.trim())?;

    // Load settings first, fallback to env
    let settings = crate::db::read_fonepay_settings().ok();

    let dynamic_qr_url = env::var("FONEPAY_DYNAMIC_DOWNLOAD_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("FONEPAY_DYNAMIC_URL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            settings.as_ref().and_then(|s| {
                let url = s.dynamic_url.trim();
                if !url.is_empty() {
                    Some(url.to_string())
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| ApiError::from("Missing FONEPAY_DYNAMIC_URL"))?;

    let merchant_code = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_code,
            &["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"],
        )?
    } else {
        env_value(&["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"])?
    };

    let merchant_secret = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_secret,
            &[
                "FONEPAY_PG_SECRET_KEY",
                "FONEPAY_PG_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET_KEY",
            ],
        )?
    } else {
        env_value(&[
            "FONEPAY_PG_SECRET_KEY",
            "FONEPAY_PG_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET_KEY",
        ])?
    };

    let username = if let Some(ref s) = settings {
        get_fonepay_setting(&s.username, &["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    } else {
        env_value(&["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    };

    let password = if let Some(ref s) = settings {
        get_fonepay_setting(&s.password, &["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    } else {
        env_value(&["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    };

    let amount = request.amount.trim().to_string();
    let prn = request.transaction_id.trim().to_string();
    let remarks1 = request.remarks1.trim().to_string();
    let remarks2 = request.remarks2.trim().to_string();
    let data_to_hash = format!("{amount},{prn},{merchant_code},{remarks1},{remarks2}");
    let data_validation = hmac_sha512_hex(merchant_secret.as_bytes(), data_to_hash.as_bytes());
    let endpoint = fonepay_third_party_endpoint(&dynamic_qr_url, "thirdPartyDynamicQrDownload");

    let payload = serde_json::json!({
        "amount": amount,
        "prn": prn,
        "remarks1": remarks1,
        "remarks2": remarks2,
        "merchantCode": merchant_code,
        "dataValidation": data_validation,
        "username": username,
        "password": password,
    });

    let response = reqwest::Client::new()
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| ApiError::from(format!("Failed to call Fonepay: {error}")))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.starts_with("image/") {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ApiError::from(format!("Failed to read Fonepay image: {error}")))?;

        if !status.is_success() {
            return Err(ApiError::from(format!(
                "Fonepay returned {status}: {} bytes",
                bytes.len()
            )));
        }

        return Ok(DynamicQrResponse {
            qr_text: None,
            image_data_url: Some(format!(
                "data:{};base64,{}",
                content_type,
                base64_encode(&bytes)
            )),
            remarks1: Some(remarks1.clone()),
            raw: serde_json::json!({ "contentType": content_type, "bytes": bytes.len() }),
        });
    }

    let body = response
        .text()
        .await
        .map_err(|error| ApiError::from(format!("Failed to read Fonepay response: {error}")))?;

    if !status.is_success() {
        return Err(ApiError::from(format!("Fonepay returned {status}")));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    if !fonepay_response_success(&raw) {
        return Err(ApiError::from(fonepay_response_message(&raw)));
    }

    let qr_text = find_qr_text(&raw);

    if qr_text.is_none() {
        return Err(ApiError::from(
            "Fonepay response did not include a QR string",
        ));
    }

    if let Some(qr_text) = qr_text.as_deref() {
        if !looks_like_emv_qr(qr_text) && !looks_like_base64_image(qr_text) {
            return Err(ApiError::from(format!(
                "Fonepay response did not include a valid QR payload: {}",
                fonepay_response_message(&raw)
            )));
        }
    }

    let image_data_url = qr_text
        .as_ref()
        .filter(|value| looks_like_base64_image(value))
        .map(|value| format!("data:image/png;base64,{value}"));

    Ok(DynamicQrResponse {
        qr_text,
        image_data_url,
        remarks1: Some(remarks1),
        raw,
    })
}

async fn generate_fonepay_pos_dynamic_qr(
    request: DynamicQrRequest,
) -> Result<DynamicQrResponse, ApiError> {
    if request.transaction_id.trim().is_empty() {
        return Err(ApiError::from("Transaction id is required"));
    }

    if request.amount.trim().is_empty() {
        return Err(ApiError::from("Amount is required"));
    }

    // Load settings first, fallback to env
    let settings = crate::db::read_fonepay_settings().ok();

    let api_url = if let Some(ref s) = settings {
        let url = s.pos_api_url.trim();
        if !url.is_empty() {
            url.to_string()
        } else {
            env::var("FONEPAY_POS_API_URL")
                .or_else(|_| env::var("FONEPAY_WEB_MERCHANT_REQUEST_URL"))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://clientapi.fonepay.com/api/merchantRequest".to_string())
        }
    } else {
        env::var("FONEPAY_POS_API_URL")
            .or_else(|_| env::var("FONEPAY_WEB_MERCHANT_REQUEST_URL"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://clientapi.fonepay.com/api/merchantRequest".to_string())
    };

    let merchant_code = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_code,
            &["FONEPAY_POS_MERCHANT_ID", "FONEPAY_MERCHANT_CODE"],
        )?
    } else {
        env_value(&["FONEPAY_POS_MERCHANT_ID", "FONEPAY_MERCHANT_CODE"])?
    };

    let merchant_secret = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_secret,
            &[
                "FONEPAY_POS_SECRET_KEY",
                "FONEPAY_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET_KEY",
            ],
        )?
    } else {
        env_value(&[
            "FONEPAY_POS_SECRET_KEY",
            "FONEPAY_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET_KEY",
        ])?
    };

    let return_url = env::var("FONEPAY_RETURN_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://yourdomain.com".to_string());

    let amount = format_amount(request.amount.trim())?;
    let transaction_id = request.transaction_id.trim().to_string();
    let remarks = if request.remarks1.trim().is_empty() {
        format!("POS-Bill-{transaction_id}")
    } else {
        request.remarks1.trim().to_string()
    };

    let data_to_hash = format!("{merchant_code},{amount},{transaction_id},{return_url},{remarks}");
    let data_validation = hmac_sha512_hex(merchant_secret.as_bytes(), data_to_hash.as_bytes());

    let payload = serde_json::json!({
        "pid": merchant_code,
        "amt": amount,
        "prn": transaction_id,
        "ru": return_url,
        "remarks": remarks,
        "dv": data_validation,
    });

    let response = reqwest::Client::new()
        .post(api_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| ApiError::from(format!("Failed to call Fonepay: {error}")))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.starts_with("image/") {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ApiError::from(format!("Failed to read Fonepay image: {error}")))?;

        if !status.is_success() {
            return Err(ApiError::from(format!(
                "Fonepay returned {status}: {} bytes",
                bytes.len()
            )));
        }

        return Ok(DynamicQrResponse {
            qr_text: None,
            image_data_url: Some(format!(
                "data:{};base64,{}",
                content_type,
                base64_encode(&bytes)
            )),
            remarks1: Some(remarks.clone()),
            raw: serde_json::json!({ "contentType": content_type, "bytes": bytes.len() }),
        });
    }

    let body = response
        .text()
        .await
        .map_err(|error| ApiError::from(format!("Failed to read Fonepay response: {error}")))?;

    if !status.is_success() {
        return Err(ApiError::from(format!("Fonepay returned {status}")));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));
    if raw
        .get("success")
        .and_then(|value| value.as_bool())
        .is_some_and(|success| !success)
    {
        let message = raw
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Fonepay request failed");
        return Err(ApiError::from(message));
    }

    let qr_text = find_qr_text(&raw);
    if qr_text.is_none() {
        return Err(ApiError::from(
            "Fonepay response did not include a QR string",
        ));
    }

    let image_data_url = qr_text
        .as_ref()
        .filter(|value| looks_like_base64_image(value))
        .map(|value| format!("data:image/png;base64,{value}"));

    Ok(DynamicQrResponse {
        qr_text,
        image_data_url,
        remarks1: Some(remarks),
        raw,
    })
}

#[tauri::command]
pub async fn verify_fonepay_payment_qr(
    request: PaymentQrStatusRequest,
) -> Result<PaymentQrStatusResponse, ApiError> {
    load_app_dotenv();

    if request.prn.trim().is_empty() {
        return Err(ApiError::from("PRN is required"));
    }

    if fonepay_mode() == "dynamic_api" {
        return verify_fonepay_third_party_qr(request).await;
    }

    verify_fonepay_web_payment(request).await
}

async fn verify_fonepay_web_payment(
    request: PaymentQrStatusRequest,
) -> Result<PaymentQrStatusResponse, ApiError> {
    // Load settings first, fallback to env
    let settings = crate::db::read_fonepay_settings().ok();

    let merchant_code = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_code,
            &["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"],
        )?
    } else {
        env_value(&["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"])?
    };

    let merchant_secret = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_secret,
            &[
                "FONEPAY_PG_SECRET_KEY",
                "FONEPAY_PG_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET_KEY",
            ],
        )?
    } else {
        env_value(&[
            "FONEPAY_PG_SECRET_KEY",
            "FONEPAY_PG_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET_KEY",
        ])?
    };

    let username = if let Some(ref s) = settings {
        get_fonepay_setting(&s.username, &["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    } else {
        env_value(&["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    };

    let password = if let Some(ref s) = settings {
        get_fonepay_setting(&s.password, &["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    } else {
        env_value(&["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    };

    let verification_url = env_value(&["FONEPAY_WEB_VERIFICATION_URL"]).or_else(|_| {
        let base = env::var("FONEPAY_WEB_MERCHANT_API_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://merchantapi.fonepay.com/api".to_string());

        Ok::<String, ApiError>(format!(
            "{base}/merchant/merchantDetailsForThirdParty/txnVerification"
        ))
    })?;
    let resource = env::var("FONEPAY_WEB_VERIFICATION_RESOURCE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/merchant/merchantDetailsForThirdParty/txnVerification".to_string());
    let amount = request
        .amount
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::from("Amount is required to verify Fonepay payment"))?;
    let prn = request.prn.trim();
    let payload = serde_json::json!({
        "prn": prn,
        "merchantCode": merchant_code,
        "amount": amount,
    });
    let payload_text = serde_json::to_string(&payload)
        .map_err(|error| ApiError::from(format!("Failed to serialize Fonepay payload: {error}")))?;
    let auth_message =
        format!("{username},{password},POST,application/json,{resource},{payload_text}");
    let auth_hash = hmac_sha512_hex(merchant_secret.as_bytes(), auth_message.as_bytes());
    let basic = base64_encode(format!("{username}:{password}").as_bytes());

    let response = reqwest::Client::new()
        .post(verification_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Basic {basic}"))
        .header("auth", auth_hash)
        .body(payload_text)
        .send()
        .await
        .map_err(|error| ApiError::from(format!("Failed to verify Fonepay payment: {error}")))?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!(
            "Failed to read Fonepay verification response: {error}"
        ))
    })?;

    if !status.is_success() {
        return Err(ApiError::from(format!("Fonepay returned {status}: {body}")));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    Ok(PaymentQrStatusResponse { raw })
}

async fn verify_fonepay_third_party_qr(
    request: PaymentQrStatusRequest,
) -> Result<PaymentQrStatusResponse, ApiError> {
    load_app_dotenv();

    // Load settings first, fallback to env
    let settings = crate::db::read_fonepay_settings().ok();

    let dynamic_qr_url = if let Some(ref s) = settings {
        let url = s.dynamic_url.trim();
        if !url.is_empty() {
            url.to_string()
        } else {
            env_value(&["FONEPAY_DYNAMIC_URL"])?
        }
    } else {
        env_value(&["FONEPAY_DYNAMIC_URL"])?
    };

    let merchant_code = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_code,
            &["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"],
        )?
    } else {
        env_value(&["FONEPAY_PG_MERCHANT_CODE", "FONEPAY_MERCHANT_CODE"])?
    };

    let merchant_secret = if let Some(ref s) = settings {
        get_fonepay_setting(
            &s.merchant_secret,
            &[
                "FONEPAY_PG_SECRET_KEY",
                "FONEPAY_PG_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET",
                "FONEPAY_MERCHANT_SECRET_KEY",
            ],
        )?
    } else {
        env_value(&[
            "FONEPAY_PG_SECRET_KEY",
            "FONEPAY_PG_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET",
            "FONEPAY_MERCHANT_SECRET_KEY",
        ])?
    };

    let username = if let Some(ref s) = settings {
        get_fonepay_setting(&s.username, &["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    } else {
        env_value(&["FONEPAY_PG_USERNAME", "FONEPAY_USERNAME"])?
    };

    let password = if let Some(ref s) = settings {
        get_fonepay_setting(&s.password, &["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    } else {
        env_value(&["FONEPAY_PG_PASSWORD", "FONEPAY_PASSWORD"])?
    };

    let prn = request.prn.trim();
    let data_to_hash = format!("{},{}", prn, merchant_code);
    let data_validation = hmac_sha512_hex(merchant_secret.as_bytes(), data_to_hash.as_bytes());
    let endpoint = fonepay_third_party_endpoint(&dynamic_qr_url, "thirdPartyDynamicQrGetStatus");

    let payload = serde_json::json!({
        "prn": prn,
        "merchantCode": merchant_code,
        "dataValidation": data_validation,
        "username": username,
        "password": password,
    });

    let response = reqwest::Client::new()
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| ApiError::from(format!("Failed to verify Fonepay QR: {error}")))?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!("Failed to read Fonepay status response: {error}"))
    })?;

    if !status.is_success() {
        return Err(ApiError::from(format!("Fonepay returned {status}: {body}")));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    Ok(PaymentQrStatusResponse { raw })
}

#[tauri::command]
pub fn get_busy_connection_summary(db: State<'_, BusyDb>) -> String {
    db.connection_summary()
}

#[tauri::command]
pub fn get_busy_settings(db: State<'_, BusyDb>) -> Result<BusySettingsState, ApiError> {
    db.settings_state().map_err(ApiError::from)
}

#[tauri::command]
pub fn save_busy_settings(
    db: State<'_, BusyDb>,
    settings: BusySettings,
) -> Result<BusySettingsState, ApiError> {
    db.save_settings(settings).map_err(ApiError::from)
}

#[tauri::command]
pub fn get_launch_invoice_no() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();

    for index in 0..args.len() {
        let arg = args[index].trim();

        if let Some(value) = arg.strip_prefix("--invoice=") {
            return clean_invoice_arg(value);
        }

        if let Some(value) = arg.strip_prefix("invoice=") {
            return clean_invoice_arg(value);
        }

        if (arg == "--invoice" || arg == "-i") && index + 1 < args.len() {
            return clean_invoice_arg(&args[index + 1]);
        }
    }

    std::env::var("BUSY_LAUNCH_INVOICE")
        .ok()
        .and_then(|value| clean_invoice_arg(&value))
}

#[tauri::command]
pub fn get_launch_watch_latest() -> bool {
    let args: Vec<String> = std::env::args().collect();

    let launched_with_watch_arg = args.iter().any(|arg| {
        matches!(
            arg.trim(),
            "--watch-latest" | "--watch-busy" | "--watch-invoices"
        )
    });

    if launched_with_watch_arg {
        return true;
    }

    std::env::var("BUSY_WATCH_LATEST")
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn start_busy_invoice_watcher(
    app: AppHandle,
    db: State<'_, BusyDb>,
    watcher: State<'_, WatcherState>,
) -> Result<(), ApiError> {
    if watcher.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let db = db.inner().clone();
    let running = watcher.running.clone();
    let interval_ms = std::env::var("BUSY_WATCH_INTERVAL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(500)
        .clamp(250, 10_000);

    thread::spawn(move || {
        let mut last_vch_code = match db.latest_invoice_vch_code() {
            Ok(value) => value,
            Err(error) => {
                let _ = app.emit("busy-invoice-watch-error", error);
                running.store(false, Ordering::SeqCst);
                return;
            }
        };

        while running.load(Ordering::SeqCst) {
            match db.get_new_invoice_events_after_code(last_vch_code) {
                Ok(events) => {
                    for event in events {
                        last_vch_code = last_vch_code.max(event.vch_code);

                        let _ = app.emit("busy-invoice-created", event);
                    }
                }
                Err(error) => {
                    let _ = app.emit("busy-invoice-watch-error", error);
                }
            }

            thread::sleep(Duration::from_millis(interval_ms));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_busy_invoice_watcher(watcher: State<'_, WatcherState>) {
    watcher.running.store(false, Ordering::SeqCst);
}

fn clean_invoice_arg(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn get_fonepay_setting(setting_value: &str, env_names: &[&str]) -> Result<String, ApiError> {
    // First check if the setting is provided (non-empty)
    let setting_value = setting_value.trim();
    if !setting_value.is_empty() {
        return Ok(setting_value.to_string());
    }

    // Fall back to environment variables
    env_value(env_names)
}

fn env_value(names: &[&str]) -> Result<String, ApiError> {
    names
        .iter()
        .find_map(|name| {
            env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .ok_or_else(|| {
            ApiError::from(format!(
                "Missing {}. Checked .env near {} and project root.",
                names.join(" or "),
                env!("CARGO_MANIFEST_DIR")
            ))
        })
}

fn fonepay_mode() -> String {
    // Check saved settings first
    if let Ok(settings) = crate::db::read_fonepay_settings() {
        let mode = settings.integration_mode.trim().to_ascii_lowercase();
        if !mode.is_empty() {
            return mode;
        }
    }

    // Fall back to environment variable
    env::var("FONEPAY_INTEGRATION_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "dynamic_api".to_string())
}

fn format_amount(value: &str) -> Result<String, ApiError> {
    value
        .parse::<f64>()
        .map(|amount| format!("{amount:.2}"))
        .map_err(|_| ApiError::from("Amount must be a valid number"))
}

fn validate_amount(value: &str) -> Result<(), ApiError> {
    value
        .parse::<f64>()
        .map(|_| ())
        .map_err(|_| ApiError::from("Amount must be a valid number"))
}

fn fonepay_third_party_endpoint(configured_url: &str, endpoint_name: &str) -> String {
    let trimmed = configured_url.trim().trim_end_matches('/');

    if trimmed.ends_with(endpoint_name) {
        return trimmed.to_string();
    }

    let base = trimmed
        .strip_suffix("/thirdPartyDynamicQrDownload")
        .or_else(|| trimmed.strip_suffix("/thirdPartyDynamicQrGetStatus"))
        .unwrap_or(trimmed);

    format!("{base}/{endpoint_name}")
}

fn load_app_dotenv() {
    dotenvy::from_filename_override(".env").ok();
    dotenvy::from_filename_override("../.env").ok();

    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    dotenvy::from_path_override(manifest_dir.join(".env")).ok();
    dotenvy::from_path_override(manifest_dir.join("../.env")).ok();
}

fn hmac_sha512_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK_SIZE: usize = 128;

    let mut normalized_key = if key.len() > BLOCK_SIZE {
        Sha512::digest(key).to_vec()
    } else {
        key.to_vec()
    };
    normalized_key.resize(BLOCK_SIZE, 0);

    let mut outer_key_pad = vec![0x5c; BLOCK_SIZE];
    let mut inner_key_pad = vec![0x36; BLOCK_SIZE];

    for index in 0..BLOCK_SIZE {
        outer_key_pad[index] ^= normalized_key[index];
        inner_key_pad[index] ^= normalized_key[index];
    }

    let mut inner = Sha512::new();
    inner.update(&inner_key_pad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha512::new();
    outer.update(&outer_key_pad);
    outer.update(inner_hash);

    hex::encode(outer.finalize())
}

fn find_qr_text(value: &serde_json::Value) -> Option<String> {
    const QR_KEYS: &[&str] = &[
        "qrMessage",
        "qrString",
        "qrData",
        "qrCode",
        "qrUrl",
        "qrURL",
        "qr",
    ];

    match value {
        serde_json::Value::Object(map) => {
            for key in QR_KEYS {
                if let Some(text) = map.get(*key).and_then(|item| item.as_str()) {
                    if !text.trim().is_empty() {
                        return Some(text.to_string());
                    }
                }
            }

            map.values().find_map(find_qr_text)
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_qr_text),
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.to_string()),
        _ => None,
    }
}

fn fonepay_response_success(value: &serde_json::Value) -> bool {
    if value
        .get("success")
        .and_then(|item| item.as_bool())
        .is_some_and(|success| !success)
    {
        return false;
    }

    if value
        .get("statusCode")
        .and_then(|item| item.as_i64())
        .is_some_and(|code| code >= 400)
    {
        return false;
    }

    let status = value
        .get("status")
        .and_then(|item| item.as_str())
        .map(|item| item.trim().to_ascii_lowercase());

    if status
        .as_deref()
        .is_some_and(|item| matches!(item, "failed" | "failure" | "error" | "duplicate"))
    {
        return false;
    }

    find_qr_text(value).is_some()
        || value
            .get("success")
            .and_then(|item| item.as_bool())
            .unwrap_or(false)
}

fn fonepay_response_message(value: &serde_json::Value) -> String {
    value
        .get("message")
        .or_else(|| value.get("responseMessage"))
        .or_else(|| value.get("statusDesc"))
        .or_else(|| value.get("status"))
        .and_then(|item| item.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Fonepay request failed: {value}"))
}

fn looks_like_emv_qr(value: &str) -> bool {
    let trimmed = value.trim();

    trimmed.starts_with("000201")
        && trimmed.len() > 20
        && trimmed.chars().all(|item| {
            item.is_ascii_alphanumeric()
                || matches!(
                    item,
                    ' ' | '!'
                        | '"'
                        | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '('
                        | ')'
                        | '*'
                        | '+'
                        | ','
                        | '-'
                        | '.'
                        | '/'
                        | ':'
                        | ';'
                        | '<'
                        | '='
                        | '>'
                        | '?'
                        | '@'
                        | '['
                        | '\\'
                        | ']'
                        | '^'
                        | '_'
                        | '`'
                        | '{'
                        | '|'
                        | '}'
                        | '~'
                )
        })
}

fn looks_like_base64_image(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() > 100
        && trimmed.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity((bytes.len() + 2) / 3 * 4);

    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);

        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }

        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}
