use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub vch_code: Option<i32>,
    pub vch_series_code: Option<i32>,
    pub invoice_no: String,
    pub invoice_date: Option<String>,
    pub invoice_date_nepali: Option<String>,
    pub party_name: Option<String>,
    pub net_amount: Option<String>,
    pub amount_source: Option<String>,
    pub payment_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceWatchEvent {
    pub vch_code: i32,
    pub vch_series_code: Option<i32>,
    pub invoice_no: String,
    pub modification_time: String,
    pub invoice: Option<Invoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusySettings {
    pub connection_string: String,
    pub invoice_table: String,
    pub sales_voucher_type: i32,
    pub payment_status_table: String,
    pub payment_status_column: String,
    #[serde(default = "default_payment_transaction_id_column")]
    pub payment_transaction_id_column: String,
    pub settlement_table: Option<String>,
    pub settlement_vch_code_column: Option<String>,
    pub settlement_mode_column: Option<String>,
    pub settlement_amount_column: Option<String>,
    pub settlement_cash_mode_name: Option<String>,
    pub settlement_credit_mode_name: Option<String>,
    #[serde(default)]
    pub pos_credit_column: Option<String>,
}

fn default_payment_transaction_id_column() -> String {
    "OF1".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusySettingsState {
    pub settings: BusySettings,
    pub is_configured: bool,
    pub storage_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankMerchant {
    pub name: String,
    pub bank_type: String,
    pub merchant_code: String,
    pub merchant_username: String,
    pub merchant_password: String,
    pub merchant_secret_key: String,
    #[serde(default)]
    pub fonepay_dynamic_url: String,
    #[serde(default)]
    pub fonepay_pos_api_url: String,
    #[serde(default)]
    pub fonepay_integration_mode: String,
    #[serde(default)]
    pub pos_credit_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FonepaySettings {
    pub dynamic_url: String,
    pub pos_api_url: String,
    pub merchant_code: String,
    pub merchant_secret: String,
    pub username: String,
    pub password: String,
    pub integration_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicQrRequest {
    pub transaction_id: String,
    pub amount: String,
    pub remarks1: String,
    pub remarks2: String,
    pub payment_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicQrResponse {
    pub qr_text: Option<String>,
    pub image_data_url: Option<String>,
    pub remarks1: Option<String>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentQrStatusRequest {
    pub prn: String,
    pub amount: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentQrStatusResponse {
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub message: String,
}

impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

impl From<&str> for ApiError {
    fn from(message: &str) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}
