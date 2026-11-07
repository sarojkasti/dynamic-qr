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
        DynamicQrResponse, FonepaySettings, Invoice, NepalPayQrRequest, NepalPayQrResponse,
        NepalPaySessionRequest, NepalPaySessionResponse, NepalPaySettings, NepalPayStatusRequest,
        NepalPayStatusResponse, PaymentQrStatusRequest, PaymentQrStatusResponse, SettingsScope,
        SettingsScopeKind,
    },
};

use rsa::{
    pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey},
    pkcs1v15::{Pkcs1v15Encrypt, SigningKey},
    pkcs8::{DecodePrivateKey, DecodePublicKey},
    signature::{SignatureEncoding, Signer},
    RsaPrivateKey, RsaPublicKey,
};
use sha2::{Digest, Sha256, Sha512};

#[derive(Default)]
pub struct WatcherState {
    running: Arc<AtomicBool>,
}

#[tauri::command]
pub fn get_invoice(
    db: State<'_, BusyDb>,
    invoice_no: String,
    pos_credit_column: Option<String>,
) -> Result<Option<Invoice>, ApiError> {
    db.get_invoice_by_id(invoice_no, pos_credit_column.as_deref())
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn get_invoice_by_vch_code(
    db: State<'_, BusyDb>,
    vch_code: i32,
    pos_credit_column: Option<String>,
) -> Result<Option<Invoice>, ApiError> {
    db.get_invoice_by_vch_code(vch_code, pos_credit_column.as_deref())
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn get_latest_invoices(
    db: State<'_, BusyDb>,
    limit: i32,
    pos_credit_column: Option<String>,
) -> Result<Vec<Invoice>, ApiError> {
    db.get_latest_invoices(limit, pos_credit_column.as_deref())
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn search_invoice(
    db: State<'_, BusyDb>,
    query: String,
    pos_credit_column: Option<String>,
) -> Result<Vec<Invoice>, ApiError> {
    db.search_invoice(query, pos_credit_column.as_deref())
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn mark_invoice_paid(
    db: State<'_, BusyDb>,
    invoice_no: String,
    transaction_id: Option<String>,
    provider: Option<String>,
) -> Result<Option<Invoice>, ApiError> {
    db.mark_invoice_paid(invoice_no, transaction_id, provider)
        .map_err(ApiError::from)
}

#[tauri::command]
pub fn log_payment_status(message: String) -> Result<(), ApiError> {
    eprintln!("[Payment] {message}");
    Ok(())
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
            pos_credit_column: bank.pos_credit_column.clone(),
            report_url: String::new(),
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
pub fn get_settings_scope() -> SettingsScope {
    crate::db::read_settings_scope()
}

#[tauri::command]
pub fn save_settings_scope(scope: SettingsScope) -> Result<(), ApiError> {
    crate::db::write_settings_scope(&scope).map_err(ApiError::from)
}

#[tauri::command]
pub fn get_fonepay_settings() -> Result<FonepaySettings, ApiError> {
    crate::db::read_fonepay_settings().map_err(ApiError::from)
}

#[tauri::command]
pub fn save_fonepay_settings(
    db: tauri::State<'_, crate::db::BusyDb>,
    settings: FonepaySettings,
    scope: Option<String>,
) -> Result<FonepaySettings, ApiError> {
    let scope_kind = parse_scope(scope.as_deref());
    crate::db::write_fonepay_settings_scoped(&settings, &scope_kind).map_err(ApiError::from)?;
    eprintln!(
        "[Fonepay] save_settings: pos_credit_column={:?} scope={:?}",
        settings.pos_credit_column, scope_kind
    );
    if !settings.pos_credit_column.trim().is_empty() {
        db.set_pos_credit_column(settings.pos_credit_column.trim());
    }
    Ok(settings)
}

#[tauri::command]
pub async fn generate_fonepay_dynamic_qr(
    request: DynamicQrRequest,
) -> Result<DynamicQrResponse, ApiError> {
    load_app_dotenv();

    let mode = fonepay_mode();
    eprintln!(
        "[Fonepay] generate_dynamic_qr: mode={mode} txn={} amount={}",
        request.transaction_id, request.amount
    );

    if mode == "dynamic_api" {
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

    eprintln!("[Fonepay] third-party QR: url={endpoint} merchant={merchant_code} username={username} amount={amount} prn={prn}");

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
        .map_err(|error| {
            eprintln!("[Fonepay] third-party request failed: {error}");
            ApiError::from(format!("Failed to call Fonepay: {error}"))
        })?;
    let status = response.status();
    eprintln!("[Fonepay] third-party response: HTTP {status}");
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

    eprintln!("[Fonepay] POS QR: url={api_url} merchant={merchant_code} amount={amount} txn={transaction_id}");

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
        .map_err(|error| {
            eprintln!("[Fonepay] POS request failed: {error}");
            ApiError::from(format!("Failed to call Fonepay: {error}"))
        })?;
    let status = response.status();
    eprintln!("[Fonepay] POS response: HTTP {status}");
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

    let settings_report_url = settings
        .as_ref()
        .map(|s| s.report_url.trim().to_string())
        .filter(|url| !url.is_empty());
    let verification_url = if let Some(url) = settings_report_url {
        url
    } else {
        env_value(&["FONEPAY_WEB_VERIFICATION_URL"]).or_else(|_| {
            let base = env::var("FONEPAY_WEB_MERCHANT_API_URL")
                .ok()
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "https://merchantapi.fonepay.com/api".to_string());

            Ok::<String, ApiError>(format!(
                "{base}/merchant/merchantDetailsForThirdParty/txnVerification"
            ))
        })?
    };
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

    eprintln!("[Fonepay] report API hit: endpoint={verification_url} prn={prn} merchantCode={merchant_code} amount={amount}");

    let response = reqwest::Client::new()
        .post(&verification_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("Basic {basic}"))
        .header("auth", auth_hash)
        .body(payload_text)
        .send()
        .await
        .map_err(|error| {
            eprintln!("[Fonepay] report API request failed: {error}");
            ApiError::from(format!("Failed to verify Fonepay payment: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!(
            "Failed to read Fonepay verification response: {error}"
        ))
    })?;

    eprintln!(
        "[Fonepay] report API response: HTTP {status} body={}",
        &body[..body.len().min(500)]
    );

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
    let report_url_override = settings
        .as_ref()
        .map(|s| s.report_url.trim().to_string())
        .filter(|url| !url.is_empty());
    let endpoint = report_url_override.unwrap_or_else(|| {
        fonepay_third_party_endpoint(&dynamic_qr_url, "thirdPartyDynamicQrGetStatus")
    });

    let payload = serde_json::json!({
        "prn": prn,
        "merchantCode": merchant_code,
        "dataValidation": data_validation,
        "username": username,
        "password": password,
    });

    eprintln!(
        "[Fonepay] report API hit: endpoint={endpoint} prn={prn} merchantCode={merchant_code}"
    );

    let response = reqwest::Client::new()
        .post(&endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            eprintln!("[Fonepay] report API request failed: {error}");
            ApiError::from(format!("Failed to verify Fonepay QR: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!("Failed to read Fonepay status response: {error}"))
    })?;

    eprintln!(
        "[Fonepay] report API response: HTTP {status} body={}",
        &body[..body.len().min(500)]
    );

    if !status.is_success() {
        return Err(ApiError::from(format!("Fonepay returned {status}: {body}")));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    Ok(PaymentQrStatusResponse { raw })
}

#[tauri::command]
pub fn delete_fonepay_settings() -> Result<(), ApiError> {
    crate::db::clear_fonepay_settings().map_err(ApiError::from)
}

#[tauri::command]
pub fn delete_nepalpay_settings() -> Result<(), ApiError> {
    crate::db::clear_nepalpay_settings().map_err(ApiError::from)
}

#[tauri::command]
pub fn get_nepalpay_settings() -> Result<NepalPaySettings, ApiError> {
    crate::db::read_nepalpay_settings().map_err(ApiError::from)
}

#[tauri::command]
pub fn save_nepalpay_settings(
    db: tauri::State<'_, crate::db::BusyDb>,
    settings: NepalPaySettings,
    scope: Option<String>,
) -> Result<NepalPaySettings, ApiError> {
    let scope_kind = parse_scope(scope.as_deref());
    crate::db::write_nepalpay_settings_scoped(&settings, &scope_kind).map_err(ApiError::from)?;
    eprintln!(
        "[NepalPay] save_settings: pos_credit_column={:?} scope={:?}",
        settings.pos_credit_column, scope_kind
    );
    if !settings.pos_credit_column.trim().is_empty() {
        db.set_pos_credit_column(settings.pos_credit_column.trim());
    }
    Ok(settings)
}

#[tauri::command]
pub async fn generate_nepalpay_dynamic_qr(
    request: NepalPayQrRequest,
) -> Result<NepalPayQrResponse, ApiError> {
    load_app_dotenv();

    if request.bill_number.trim().is_empty() {
        return Err(ApiError::from("Bill number is required"));
    }

    if request.transaction_amount.trim().is_empty() {
        return Err(ApiError::from("Transaction amount is required"));
    }

    validate_amount(request.transaction_amount.trim())?;

    let settings = crate::db::read_nepalpay_settings().map_err(ApiError::from)?;

    if settings.api_url.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay API URL is not configured"));
    }
    if settings.acquirer_id.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay acquirer ID is not configured"));
    }
    if settings.merchant_id.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay merchant ID is not configured"));
    }
    if settings.user_id.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay user ID is not configured"));
    }
    let amount = format_amount(request.transaction_amount.trim())?;
    let bill_number = request.bill_number.trim().to_string();

    if settings.private_key_pem.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay private key is not configured — paste the PKCS#8 PEM private key in settings"));
    }
    // RSA-SHA256 token string: comma-separated, no spaces
    let token_string = format!(
        "{},{},{},{},{},{},{}",
        settings.acquirer_id.trim(),
        settings.merchant_id.trim(),
        settings.merchant_category_code,
        settings.transaction_currency,
        amount,
        bill_number,
        settings.user_id.trim()
    );
    eprintln!("[NepalPay] token_string to sign: {token_string}");
    let token = nepalpay_sign_token(&token_string, settings.private_key_pem.trim())?;
    eprintln!("[NepalPay] generated token: {token}");

    let api_url = settings.api_url.trim().trim_end_matches('/').to_string();

    let payload = serde_json::json!({
        "pointOfInitialization": 12,
        "acquirerId": settings.acquirer_id.trim(),
        "merchantId": settings.merchant_id.trim(),
        "merchantName": settings.merchant_name.trim(),
        "merchantCategoryCode": settings.merchant_category_code,
        "merchantCountry": settings.merchant_country.trim(),
        "merchantCity": settings.merchant_city.trim(),
        "merchantPostalCode": settings.merchant_postal_code.trim(),
        "transactionCurrency": settings.transaction_currency,
        "transactionAmount": amount,
        "billNumber": bill_number,
        "storeLabel": settings.store_label.trim(),
        "terminalLabel": "Terminal1",
        "qrImage": false,
        "token": token
    });

    eprintln!(
        "[NepalPay] request payload: {}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );

    // Basic Auth: base64(api_username:api_password)
    let basic_auth = base64_encode(
        format!(
            "{}:{}",
            settings.api_username.trim(),
            settings.api_password.trim()
        )
        .as_bytes(),
    );

    eprintln!(
        "[NepalPay] using Basic Auth username={}",
        settings.api_username.trim()
    );

    let response = reqwest::Client::new()
        .post(&api_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Basic {basic_auth}"),
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            eprintln!("[NepalPay] request failed: {error}");
            ApiError::from(format!("Failed to call Nepal Pay: {error}"))
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| ApiError::from(format!("Failed to read Nepal Pay response: {error}")))?;

    eprintln!(
        "[NepalPay] response: HTTP {status} body={}",
        &body[..body.len().min(300)]
    );

    if !status.is_success() {
        return Err(ApiError::from(format!(
            "Nepal Pay returned {status}: {body}"
        )));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    let response_code = raw
        .get("responseCode")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let response_status = raw
        .get("responseStatus")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_uppercase())
        .unwrap_or_default();

    if response_code != "000" && response_status != "SUCCESS" {
        let message = raw
            .get("responseMessage")
            .and_then(|v| v.as_str())
            .unwrap_or("Nepal Pay QR generation failed");
        return Err(ApiError::from(message));
    }

    let data = raw.get("data");
    let qr_string = data
        .and_then(|d| d.get("qrString"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let validation_trace_id = data
        .and_then(|d| d.get("validationTraceId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    if qr_string.is_none() {
        return Err(ApiError::from(
            "Nepal Pay response did not include a QR string",
        ));
    }

    if let Some(encoded_amount) = qr_string.as_deref().and_then(emv_transaction_amount) {
        let requested_amount = amount.parse::<f64>().unwrap_or_default();
        let qr_amount = encoded_amount.parse::<f64>().map_err(|_| {
            ApiError::from("Nepal Pay returned a QR with an invalid transaction amount")
        })?;

        if (requested_amount - qr_amount).abs() > 0.005 {
            return Err(ApiError::from(format!(
                "Nepal Pay returned a stale QR amount ({encoded_amount}) instead of the requested amount ({amount})"
            )));
        }
    }

    Ok(NepalPayQrResponse {
        qr_string,
        validation_trace_id,
        raw,
    })
}

fn emv_transaction_amount(qr_text: &str) -> Option<&str> {
    let bytes = qr_text.as_bytes();
    let mut offset = 0;

    while offset + 4 <= bytes.len() {
        let tag = std::str::from_utf8(&bytes[offset..offset + 2]).ok()?;
        let length = std::str::from_utf8(&bytes[offset + 2..offset + 4])
            .ok()?
            .parse::<usize>()
            .ok()?;
        let value_start = offset + 4;
        let value_end = value_start.checked_add(length)?;
        if value_end > bytes.len() {
            return None;
        }

        if tag == "54" {
            return std::str::from_utf8(&bytes[value_start..value_end]).ok();
        }

        offset = value_end;
    }

    None
}

#[tauri::command]
pub async fn check_nepalpay_payment_status(
    request: NepalPayStatusRequest,
) -> Result<NepalPayStatusResponse, ApiError> {
    load_app_dotenv();

    if request.validation_trace_id.trim().is_empty() {
        return Err(ApiError::from("Validation trace ID is required"));
    }

    let settings = crate::db::read_nepalpay_settings().map_err(ApiError::from)?;

    if settings.report_url.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay Report URL is not configured"));
    }
    if settings.merchant_id.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay merchant ID is not configured"));
    }
    if settings.acquirer_id.trim().is_empty() {
        return Err(ApiError::from("Nepal Pay acquirer ID is not configured"));
    }

    let payload = serde_json::json!({
        "validationTraceId": request.validation_trace_id.trim(),
        "merchantId": settings.merchant_id.trim(),
        "acquirerId": settings.acquirer_id.trim(),
    });

    eprintln!(
        "[NepalPay] status request payload: {}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );

    let basic_auth = base64_encode(
        format!(
            "{}:{}",
            settings.api_username.trim(),
            settings.api_password.trim()
        )
        .as_bytes(),
    );

    let response = reqwest::Client::new()
        .post(settings.report_url.trim())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Basic {basic_auth}"),
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            eprintln!("[NepalPay] status request failed: {error}");
            ApiError::from(format!("Failed to call Nepal Pay report API: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!("Failed to read Nepal Pay status response: {error}"))
    })?;

    eprintln!(
        "[NepalPay] status response: HTTP {status} body={}",
        &body[..body.len().min(500)]
    );

    if !status.is_success() {
        return Err(ApiError::from(format!(
            "Nepal Pay report API returned {status}: {body}"
        )));
    }

    let raw = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "response": body }));

    let response_code = raw
        .get("responseCode")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let response_status = raw
        .get("responseStatus")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    // Some non-transaction responses (e.g. E012 "not initiated yet") put their
    // text in responseDescription instead of responseMessage — fall back to it
    // so the UI always has something to show instead of silently displaying nothing.
    let response_message = raw
        .get("responseMessage")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("responseDescription").and_then(|v| v.as_str()))
        .map(str::to_string);
    let transaction = raw
        .get("responseBody")
        .and_then(|body| body.as_array())
        .and_then(|items| items.first())
        .cloned();

    Ok(NepalPayStatusResponse {
        response_code,
        response_status,
        response_message,
        transaction,
        raw,
    })
}

#[tauri::command]
pub async fn record_nepalpay_session_number(
    db: State<'_, BusyDb>,
    request: NepalPaySessionRequest,
) -> Result<NepalPaySessionResponse, ApiError> {
    let settings = crate::db::read_nepalpay_settings().map_err(ApiError::from)?;
    let session_report_url = if !settings.session_report_url.trim().is_empty() {
        settings.session_report_url.trim()
    } else if settings
        .report_url
        .to_ascii_lowercase()
        .contains("merchanttxnreport")
    {
        // Compatibility with installations where the date-wise endpoint was
        // previously entered in the only available Report URL field.
        settings.report_url.trim()
    } else {
        ""
    };
    if session_report_url.is_empty() {
        return Err(ApiError::from(
            "NepalPay date-wise session report URL is not configured",
        ));
    }
    if settings.session_number_column.trim().is_empty() {
        return Err(ApiError::from(
            "NepalPay session number Busy column is not configured",
        ));
    }

    let transaction_date = request.transaction_date.trim();
    let valid_date = transaction_date.len() == 10
        && transaction_date.chars().enumerate().all(|(index, ch)| {
            if index == 4 || index == 7 {
                ch == '-'
            } else {
                ch.is_ascii_digit()
            }
        });
    if !valid_date {
        return Err(ApiError::from(
            "NepalPay transaction date must use YYYY-MM-DD format",
        ));
    }

    let payload = serde_json::json!({
        "fromDate": transaction_date,
        "toDate": transaction_date,
        "merchantId": settings.merchant_id.trim(),
        "acquirerId": settings.acquirer_id.trim(),
    });
    let basic_auth = base64_encode(
        format!(
            "{}:{}",
            settings.api_username.trim(),
            settings.api_password.trim()
        )
        .as_bytes(),
    );
    let response = reqwest::Client::new()
        .post(session_report_url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Basic {basic_auth}"),
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            ApiError::from(format!(
                "Failed to call NepalPay session report API: {error}"
            ))
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        ApiError::from(format!(
            "Failed to read NepalPay session report response: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(ApiError::from(format!(
            "NepalPay session report returned {status}: {body}"
        )));
    }
    let raw: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
        ApiError::from(format!("Invalid NepalPay session report response: {error}"))
    })?;
    let invoice_no = request.invoice_no.trim();
    let transaction_id = request.transaction_id.trim();
    let rows = raw.get("responseBody").and_then(|value| value.as_array());
    let matched = rows.and_then(|items| {
        items.iter().find(|item| {
            ["nQrTxnId", "instructionId", "validationTraceId"]
                .iter()
                .any(|field| value_matches(item.get(*field), transaction_id))
                || ["merchantBillNo", "merchantTxnRef"]
                    .iter()
                    .any(|field| value_matches(item.get(*field), invoice_no))
        })
    });
    let session_number = matched
        .and_then(|item| item.get("sessionSrlNo"))
        .and_then(|value| json_scalar_string(Some(value)))
        .filter(|value| !value.trim().is_empty());

    if let Some(ref session_number) = session_number {
        db.save_invoice_session_number(
            invoice_no,
            session_number,
            settings.session_number_column.trim(),
        )
        .map_err(ApiError::from)?;
    }

    Ok(NepalPaySessionResponse {
        session_number,
        matched_transaction: None,
    })
}

fn value_matches(value: Option<&serde_json::Value>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    json_scalar_string(value)
        .map(|value| value.trim().eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn json_scalar_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn nepalpay_sign_token(token_string: &str, private_key_pem: &str) -> Result<String, ApiError> {
    // Accept both PKCS#8 (-----BEGIN PRIVATE KEY-----) and PKCS#1 (-----BEGIN RSA PRIVATE KEY-----)
    // openssl pkcs12 -in NPI.pfx -nocerts -nodes typically outputs PKCS#1
    let private_key = if private_key_pem.contains("BEGIN PRIVATE KEY") {
        RsaPrivateKey::from_pkcs8_pem(private_key_pem)
            .map_err(|e| ApiError::from(format!("Invalid PKCS#8 private key: {e}")))?
    } else {
        RsaPrivateKey::from_pkcs1_pem(private_key_pem)
            .map_err(|e| ApiError::from(format!("Invalid PKCS#1 (RSA) private key: {e}")))?
    };
    let signing_key = SigningKey::<Sha256>::new(private_key);
    let signature: rsa::pkcs1v15::Signature = signing_key.sign(token_string.as_bytes());
    Ok(base64_encode(signature.to_bytes().as_ref()))
}

/// Encrypts `plaintext` with an RSA public key using RSA/ECB/PKCS1Padding
/// (i.e. raw PKCS#1 v1.5 encryption, single block — "ECB" just means no chaining mode),
/// as required by the NCHL/NPI WebSocket api_token exchange.
fn nepalpay_rsa_encrypt(plaintext: &str, public_key_input: &str) -> Result<String, ApiError> {
    let public_key = parse_rsa_public_key(public_key_input)?;
    let mut rng = rand::thread_rng();
    let encrypted = public_key
        .encrypt(&mut rng, Pkcs1v15Encrypt, plaintext.as_bytes())
        .map_err(|e| ApiError::from(format!("RSA encryption failed: {e}")))?;
    Ok(base64_encode(&encrypted))
}

/// Accepts a PEM-wrapped public key (X.509/SPKI "BEGIN PUBLIC KEY" or PKCS#1 "BEGIN RSA PUBLIC KEY"),
/// or a bare base64 DER blob (as commonly handed out without PEM headers) and parses it as
/// an X.509/SPKI RSA public key.
fn parse_rsa_public_key(input: &str) -> Result<RsaPublicKey, ApiError> {
    let trimmed = input.trim();
    if trimmed.contains("BEGIN PUBLIC KEY") {
        return RsaPublicKey::from_public_key_pem(trimmed)
            .map_err(|e| ApiError::from(format!("Invalid X.509/PKCS#8 public key: {e}")));
    }
    if trimmed.contains("BEGIN RSA PUBLIC KEY") {
        return RsaPublicKey::from_pkcs1_pem(trimmed)
            .map_err(|e| ApiError::from(format!("Invalid PKCS#1 (RSA) public key: {e}")));
    }

    // Bare base64 DER (no PEM headers) — wrap it as X.509/SPKI PEM and parse.
    let condensed: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let wrapped = format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
        condensed
            .as_bytes()
            .chunks(64)
            .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    );
    RsaPublicKey::from_public_key_pem(&wrapped).map_err(|e| {
        ApiError::from(format!(
            "Invalid public key (expected PEM or base64 DER SubjectPublicKeyInfo): {e}"
        ))
    })
}

#[tauri::command]
pub fn nepalpay_encrypt_ws_token(
    api_token: String,
    public_key_pem: String,
) -> Result<String, ApiError> {
    if public_key_pem.trim().is_empty() {
        return Err(ApiError::from(
            "Nepal Pay WebSocket public key is not configured",
        ));
    }
    let plaintext = api_token.trim();
    eprintln!(
        "[NepalPay] encrypting ws api_token: len={} bytes",
        plaintext.len()
    );
    nepalpay_rsa_encrypt(plaintext, public_key_pem.trim())
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
    scope: Option<String>,
) -> Result<BusySettingsState, ApiError> {
    let scope_kind = parse_scope(scope.as_deref());
    db.save_settings_scoped(settings, &scope_kind)
        .map_err(ApiError::from)
}

fn parse_scope(scope: Option<&str>) -> SettingsScopeKind {
    match scope {
        Some("shared") => SettingsScopeKind::Shared,
        _ => SettingsScopeKind::User,
    }
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
    let amount = value
        .parse::<f64>()
        .map_err(|_| ApiError::from("Amount must be a valid number"))?;
    if amount <= 0.0 {
        return Err(ApiError::from("Amount must be greater than zero"));
    }
    Ok(())
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
