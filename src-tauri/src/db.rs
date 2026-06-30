use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, OnceLock, RwLock},
};

use odbc_api::{
    sys::{AttrConnectionPooling, AttrCpMatch},
    ConnectionOptions, Cursor, Environment, IntoParameter,
};

use crate::models::{BusySettings, BusySettingsState, Invoice, InvoiceWatchEvent};

#[derive(Clone, PartialEq)]
enum DbDialect {
    SqlServer,
    Access,
}

impl DbDialect {
    fn from_settings(settings: &BusySettings) -> Self {
        match settings.db_type.as_deref() {
            Some("access") => DbDialect::Access,
            _ => DbDialect::SqlServer,
        }
    }

    fn cast_str(&self, expr: &str) -> String {
        match self {
            DbDialect::SqlServer => format!("CAST({expr} AS varchar(64))"),
            DbDialect::Access => format!("({expr} & '')"),
        }
    }

    fn format_date(&self, expr: &str) -> String {
        match self {
            DbDialect::SqlServer => format!("CONVERT(varchar(10), {expr}, 120)"),
            DbDialect::Access => format!("Format({expr}, 'yyyy-mm-dd')"),
        }
    }

    fn trim(&self, expr: &str) -> String {
        match self {
            DbDialect::SqlServer => format!("LTRIM(RTRIM({expr}))"),
            DbDialect::Access => format!("Trim({expr})"),
        }
    }

    fn nz(&self, expr: &str, default: &str) -> String {
        match self {
            DbDialect::SqlServer => format!("ISNULL({expr}, {default})"),
            DbDialect::Access => format!("IIf(IsNull({expr}), {default}, {expr})"),
        }
    }

    // Equivalent of COALESCE(NULLIF(a,''), NULLIF(b,''), fallback)
    fn coalesce_nonempty(&self, exprs: &[&str], fallback: &str) -> String {
        match self {
            DbDialect::SqlServer => {
                let parts: Vec<String> = exprs.iter().map(|e| format!("NULLIF({e}, '')")).collect();
                format!("COALESCE({}, {fallback})", parts.join(", "))
            }
            DbDialect::Access => {
                let mut result = fallback.to_string();
                for e in exprs.iter().rev() {
                    result = format!("IIf(Not IsNull({e}) And {e}<>'', {e}, {result})");
                }
                result
            }
        }
    }

    // Equivalent of NULLIF(LTRIM(RTRIM(expr)), '') IS NOT NULL
    fn nonempty_condition(&self, expr: &str) -> String {
        match self {
            DbDialect::SqlServer => format!("NULLIF(LTRIM(RTRIM({expr})), '') IS NOT NULL"),
            DbDialect::Access => format!("(Not IsNull({expr}) And Trim({expr}) <> '')"),
        }
    }

    // Access requires parens around multiple JOINs; SQL Server does not
    fn two_left_joins(&self, table: &str, j1_table: &str, j1_on: &str, j2_table: &str, j2_on: &str) -> String {
        match self {
            DbDialect::SqlServer => format!(
                "{table} \
                 LEFT JOIN {j1_table} ON {j1_on} \
                 LEFT JOIN {j2_table} ON {j2_on}"
            ),
            DbDialect::Access => format!(
                "({table} LEFT JOIN {j1_table} ON {j1_on}) \
                 LEFT JOIN {j2_table} ON {j2_on}"
            ),
        }
    }

    fn query_timeout(&self) -> Option<usize> {
        match self {
            DbDialect::SqlServer => Some(15),
            DbDialect::Access => None,
        }
    }
}

static ODBC_ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct BusyDb {
    settings: Arc<RwLock<BusySettings>>,
}

impl BusyDb {
    pub fn from_env() -> Self {
        load_dotenv();

        Self {
            settings: Arc::new(RwLock::new(load_initial_settings())),
        }
    }

    pub fn settings(&self) -> Result<BusySettings, String> {
        self.settings
            .read()
            .map(|settings| settings.clone())
            .map_err(|_| "Busy settings lock was poisoned.".to_string())
    }

    pub fn settings_state(&self) -> Result<BusySettingsState, String> {
        let path = settings_file_path()?;
        let is_configured = path.exists();
        let settings = if is_configured {
            read_settings_file(&path)?
        } else {
            self.settings()?
        };

        if is_configured {
            self.apply_settings(settings.clone())?;
        }

        Ok(BusySettingsState {
            settings,
            is_configured,
            storage_path: path.display().to_string(),
        })
    }

    pub fn save_settings(&self, settings: BusySettings) -> Result<BusySettingsState, String> {
        validate_settings(&settings)?;
        let path = settings_file_path()?;
        write_settings_file(&settings, &path)?;
        self.apply_settings(settings.clone())?;

        Ok(BusySettingsState {
            settings,
            is_configured: true,
            storage_path: path.display().to_string(),
        })
    }

    fn apply_settings(&self, settings: BusySettings) -> Result<(), String> {
        let mut current = self
            .settings
            .write()
            .map_err(|_| "Busy settings lock was poisoned.".to_string())?;
        *current = settings.clone();

        Ok(())
    }

    pub fn connection_summary(&self) -> String {
        self.settings()
            .map(|settings| mask_connection_string(&settings.connection_string))
            .unwrap_or_else(|error| error)
    }
}

impl BusySettings {
    fn from_env() -> Self {
        Self {
            connection_string: env::var("BUSY_ODBC_CONNECTION_STRING")
                .unwrap_or_else(|_| "".to_string()),
            invoice_table: env::var("BUSY_INVOICE_TABLE").unwrap_or_else(|_| "Tran1".to_string()),
            sales_voucher_type: env::var("BUSY_SALES_VOUCHER_TYPE")
                .ok()
                .and_then(|value| value.trim().parse::<i32>().ok())
                .unwrap_or(2),
            payment_status_table: env::var("BUSY_PAYMENT_STATUS_TABLE")
                .unwrap_or_else(|_| "VchOtherInfo".to_string()),
            payment_status_column: env::var("BUSY_PAYMENT_STATUS_COLUMN")
                .unwrap_or_else(|_| "OF3".to_string()),
            payment_transaction_id_column: env::var("BUSY_PAYMENT_TRANSACTION_ID_COLUMN")
                .unwrap_or_else(|_| "OF1".to_string()),
            settlement_table: None,
            settlement_vch_code_column: None,
            settlement_mode_column: None,
            settlement_amount_column: None,
            settlement_cash_mode_name: None,
            settlement_credit_mode_name: None,
            pos_credit_column: None,
            db_type: None,
        }
    }
}

fn load_initial_settings() -> BusySettings {
    settings_file_path()
        .ok()
        .filter(|path| path.exists())
        .and_then(|path| read_settings_file(&path).ok())
        .unwrap_or_else(BusySettings::from_env)
}

impl BusyDb {
    pub fn get_invoice_by_id(&self, invoice_no: String) -> Result<Option<Invoice>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let status_table = checked_identifier(&settings.payment_status_table)?;
        let status_column = checked_column_identifier(&settings.payment_status_column)?;
        let dialect = DbDialect::from_settings(&settings);
        let amount = invoice_amount_sql(settings.pos_credit_column.as_deref(), &dialect);
        let amount_value = amount.value_expression;
        let amount_source = amount.source_expression;
        let date_expr = dialect.format_date("t.Date");
        let cast_mastercode = dialect.cast_str("t.MasterCode1");
        let cast_vchtype = dialect.cast_str("t.VchType");
        let party_name_expr =
            dialect.coalesce_nonempty(&["m.PrintName", "m.Name"], &cast_mastercode);
        let status_expr =
            dialect.coalesce_nonempty(&[&format!("oi.[{status_column}]")], &cast_vchtype);
        let trim_vchno = dialect.trim("t.VchNo");
        let trim_param = dialect.trim("?");
        let from_clause = dialect.two_left_joins(
            &format!("{table} t"),
            "Master1 m", "m.Code = t.MasterCode1",
            &format!("{status_table} oi"), "oi.VchCode = t.VchCode",
        );
        let sql = format!(
            "SELECT TOP 1 t.VchCode, \
                    t.VchSeriesCode, \
                    VchNo, \
                    {date_expr}, \
                    t.NepaliDate, \
                    {party_name_expr}, \
                    {amount_value}, \
                    {amount_source}, \
                    {status_expr} \
             FROM {from_clause} \
             WHERE {trim_vchno} = {trim_param} AND t.Cancelled = 0 AND t.VchType = ? \
             ORDER BY t.Date DESC, t.VchCode DESC"
        );

        let conn = self.connect()?;
        let invoice_param = invoice_no.as_str().into_parameter();
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let params = (&invoice_param, &voucher_type_param);
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(None),
        };

        match cursor.next_row().map_err(|error| error.to_string())? {
            Some(row) => read_invoice_row(row).map(Some),
            None => Ok(None),
        }
    }

    pub fn get_invoice_by_vch_code(&self, vch_code: i32) -> Result<Option<Invoice>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let status_table = checked_identifier(&settings.payment_status_table)?;
        let status_column = checked_column_identifier(&settings.payment_status_column)?;
        let dialect = DbDialect::from_settings(&settings);
        let amount = invoice_amount_sql(settings.pos_credit_column.as_deref(), &dialect);
        let amount_value = amount.value_expression;
        let amount_source = amount.source_expression;
        let date_expr = dialect.format_date("t.Date");
        let cast_mastercode = dialect.cast_str("t.MasterCode1");
        let cast_vchtype = dialect.cast_str("t.VchType");
        let party_name_expr =
            dialect.coalesce_nonempty(&["m.PrintName", "m.Name"], &cast_mastercode);
        let status_expr =
            dialect.coalesce_nonempty(&[&format!("oi.[{status_column}]")], &cast_vchtype);
        let from_clause = dialect.two_left_joins(
            &format!("{table} t"),
            "Master1 m", "m.Code = t.MasterCode1",
            &format!("{status_table} oi"), "oi.VchCode = t.VchCode",
        );
        let sql = format!(
            "SELECT TOP 1 t.VchCode, \
                    t.VchSeriesCode, \
                    VchNo, \
                    {date_expr}, \
                    t.NepaliDate, \
                    {party_name_expr}, \
                    {amount_value}, \
                    {amount_source}, \
                    {status_expr} \
             FROM {from_clause} \
             WHERE t.VchCode = ? AND t.Cancelled = 0 AND t.VchType = ?"
        );

        let conn = self.connect()?;
        let vch_code_param = vch_code.into_parameter();
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let params = (&vch_code_param, &voucher_type_param);
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(None),
        };

        match cursor.next_row().map_err(|error| error.to_string())? {
            Some(row) => read_invoice_row(row).map(Some),
            None => Ok(None),
        }
    }

    pub fn get_latest_invoices(&self, limit: i32) -> Result<Vec<Invoice>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let status_table = checked_identifier(&settings.payment_status_table)?;
        let status_column = checked_column_identifier(&settings.payment_status_column)?;
        let dialect = DbDialect::from_settings(&settings);
        let amount = invoice_amount_sql(settings.pos_credit_column.as_deref(), &dialect);
        let amount_value = amount.value_expression;
        let amount_source = amount.source_expression;
        let date_expr = dialect.format_date("t.Date");
        let cast_mastercode = dialect.cast_str("t.MasterCode1");
        let cast_vchtype = dialect.cast_str("t.VchType");
        let party_name_expr =
            dialect.coalesce_nonempty(&["m.PrintName", "m.Name"], &cast_mastercode);
        let status_expr =
            dialect.coalesce_nonempty(&[&format!("oi.[{status_column}]")], &cast_vchtype);
        let vchno_nonempty = dialect.nonempty_condition("t.VchNo");
        let from_clause = dialect.two_left_joins(
            &format!("{table} t"),
            "Master1 m", "m.Code = t.MasterCode1",
            &format!("{status_table} oi"), "oi.VchCode = t.VchCode",
        );
        let limit = limit.clamp(1, 200);
        let sql = format!(
            "SELECT TOP {limit} t.VchCode, \
                    t.VchSeriesCode, \
                    VchNo, \
                    {date_expr}, \
                    t.NepaliDate, \
                    {party_name_expr}, \
                    {amount_value}, \
                    {amount_source}, \
                    {status_expr} \
             FROM {from_clause} \
             WHERE t.Cancelled = 0 \
               AND t.VchType = {voucher_type} \
               AND {vchno_nonempty} \
             ORDER BY t.Date DESC, t.VchCode DESC",
            voucher_type = settings.sales_voucher_type
        );

        self.fetch_invoices(&sql, (), dialect.query_timeout())
    }

    pub fn mark_invoice_paid(
        &self,
        invoice_no: String,
        transaction_id: Option<String>,
    ) -> Result<Option<Invoice>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let status_table = checked_identifier(&settings.payment_status_table)?;
        let status_column = checked_column_identifier(&settings.payment_status_column)?;
        let txn_id_column = checked_column_identifier(&settings.payment_transaction_id_column)?;
        let dialect = DbDialect::from_settings(&settings);
        let transaction_id = transaction_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if transaction_id.is_some() && status_column.eq_ignore_ascii_case(&txn_id_column) {
            return Err(format!(
                "{txn_id_column} is used for the Fonepay transaction id. Choose a different payment status column."
            ));
        }

        self.ensure_text_status_column(&status_table, &status_column)?;
        if transaction_id.is_some() {
            self.ensure_text_status_column(&status_table, &txn_id_column)?;
        }

        let vch_code = self
            .find_sales_voucher_code(&table, &invoice_no)?
            .ok_or_else(|| "Sales voucher was not found for this invoice number.".to_string())?;

        let conn = self.connect()?;

        if dialect == DbDialect::Access {
            // Check if row exists — Access doesn't support IF EXISTS ... UPDATE ... ELSE INSERT
            let check_sql = format!("SELECT COUNT(*) FROM {status_table} WHERE VchCode = ?");
            let check_param = vch_code.into_parameter();
            let mut cursor = conn
                .execute(&check_sql, (&check_param,), dialect.query_timeout())
                .map_err(|e| e.to_string())?
                .ok_or("No cursor from count query")?;
            let exists = cursor
                .next_row()
                .map_err(|e| e.to_string())?
                .and_then(|mut row| read_text(&mut row, 1).ok().flatten())
                .and_then(|v| v.parse::<i32>().ok())
                .unwrap_or(0)
                > 0;

            if let Some(ref transaction_id) = transaction_id {
                if exists {
                    let sql = format!(
                        "UPDATE {status_table} SET [{status_column}] = ?, [{txn_id_column}] = ? WHERE VchCode = ?"
                    );
                    let paid_param = "Paid".into_parameter();
                    let txn_param = transaction_id.as_str().into_parameter();
                    let vch_param = vch_code.into_parameter();
                    conn.execute(&sql, (&paid_param, &txn_param, &vch_param), dialect.query_timeout())
                        .map_err(|e| e.to_string())?;
                } else {
                    let sql = format!(
                        "INSERT INTO {status_table} (VchCode, [{status_column}], [{txn_id_column}]) VALUES (?, ?, ?)"
                    );
                    let vch_param = vch_code.into_parameter();
                    let paid_param = "Paid".into_parameter();
                    let txn_param = transaction_id.as_str().into_parameter();
                    conn.execute(&sql, (&vch_param, &paid_param, &txn_param), dialect.query_timeout())
                        .map_err(|e| e.to_string())?;
                }
            } else if exists {
                let sql = format!(
                    "UPDATE {status_table} SET [{status_column}] = ? WHERE VchCode = ?"
                );
                let paid_param = "Paid".into_parameter();
                let vch_param = vch_code.into_parameter();
                conn.execute(&sql, (&paid_param, &vch_param), dialect.query_timeout())
                    .map_err(|e| e.to_string())?;
            } else {
                let sql = format!(
                    "INSERT INTO {status_table} (VchCode, [{status_column}]) VALUES (?, ?)"
                );
                let vch_param = vch_code.into_parameter();
                let paid_param = "Paid".into_parameter();
                conn.execute(&sql, (&vch_param, &paid_param), dialect.query_timeout())
                    .map_err(|e| e.to_string())?;
            }

            return self.get_invoice_by_id(invoice_no);
        }

        if let Some(transaction_id) = transaction_id {
            let sql = format!(
                "IF EXISTS (SELECT 1 FROM {status_table} WHERE VchCode = ?) \
                    UPDATE {status_table} SET [{status_column}] = ?, [{txn_id_column}] = ? WHERE VchCode = ? \
                 ELSE \
                    INSERT INTO {status_table} (VchCode, [{status_column}], [{txn_id_column}]) VALUES (?, ?, ?)"
            );

            let exists_vch_code_param = vch_code.into_parameter();
            let paid_param = "Paid".into_parameter();
            let update_transaction_param = transaction_id.as_str().into_parameter();
            let update_vch_code_param = vch_code.into_parameter();
            let insert_vch_code_param = vch_code.into_parameter();
            let insert_paid_param = "Paid".into_parameter();
            let insert_transaction_param = transaction_id.as_str().into_parameter();
            let params = (
                &exists_vch_code_param,
                &paid_param,
                &update_transaction_param,
                &update_vch_code_param,
                &insert_vch_code_param,
                &insert_paid_param,
                &insert_transaction_param,
            );

            conn.execute(&sql, params, dialect.query_timeout())
                .map_err(|error| error.to_string())?;
        } else {
            let sql = format!(
                "IF EXISTS (SELECT 1 FROM {status_table} WHERE VchCode = ?) \
                    UPDATE {status_table} SET [{status_column}] = ? WHERE VchCode = ? \
                 ELSE \
                    INSERT INTO {status_table} (VchCode, [{status_column}]) VALUES (?, ?)"
            );

            let exists_vch_code_param = vch_code.into_parameter();
            let paid_param = "Paid".into_parameter();
            let update_vch_code_param = vch_code.into_parameter();
            let insert_vch_code_param = vch_code.into_parameter();
            let insert_paid_param = "Paid".into_parameter();
            let params = (
                &exists_vch_code_param,
                &paid_param,
                &update_vch_code_param,
                &insert_vch_code_param,
                &insert_paid_param,
            );

            conn.execute(&sql, params, dialect.query_timeout())
                .map_err(|error| error.to_string())?;
        }

        self.get_invoice_by_id(invoice_no)
    }

    pub fn search_invoice(&self, query: String) -> Result<Vec<Invoice>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let status_table = checked_identifier(&settings.payment_status_table)?;
        let status_column = checked_column_identifier(&settings.payment_status_column)?;
        let dialect = DbDialect::from_settings(&settings);
        let amount = invoice_amount_sql(settings.pos_credit_column.as_deref(), &dialect);
        let amount_value = amount.value_expression;
        let amount_source = amount.source_expression;
        let date_expr = dialect.format_date("t.Date");
        let cast_mastercode = dialect.cast_str("t.MasterCode1");
        let cast_vchtype = dialect.cast_str("t.VchType");
        let party_name_expr =
            dialect.coalesce_nonempty(&["m.PrintName", "m.Name"], &cast_mastercode);
        let status_expr =
            dialect.coalesce_nonempty(&[&format!("oi.[{status_column}]")], &cast_vchtype);
        let trim_vchno = dialect.trim("t.VchNo");
        let from_clause = dialect.two_left_joins(
            &format!("{table} t"),
            "Master1 m", "m.Code = t.MasterCode1",
            &format!("{status_table} oi"), "oi.VchCode = t.VchCode",
        );
        let sql = format!(
            "SELECT TOP 50 t.VchCode, \
                    t.VchSeriesCode, \
                    VchNo, \
                    {date_expr}, \
                    t.NepaliDate, \
                    {party_name_expr}, \
                    {amount_value}, \
                    {amount_source}, \
                    {status_expr} \
             FROM {from_clause} \
             WHERE t.Cancelled = 0 \
               AND t.VchType = ? \
               AND ({trim_vchno} LIKE ? OR {cast_mastercode} LIKE ? OR m.Name LIKE ? OR m.PrintName LIKE ?) \
             ORDER BY t.Date DESC, t.VchCode DESC"
        );

        let conn = self.connect()?;
        let like_query = format!("%{}%", query.trim());
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let invoice_param = like_query.as_str().into_parameter();
        let master_code_param = like_query.as_str().into_parameter();
        let party_name_param = like_query.as_str().into_parameter();
        let print_name_param = like_query.as_str().into_parameter();
        let params = (
            &voucher_type_param,
            &invoice_param,
            &master_code_param,
            &party_name_param,
            &print_name_param,
        );
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(Vec::new()),
        };

        collect_invoices(&mut cursor)
    }

    pub fn latest_invoice_vch_code(&self) -> Result<i32, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let dialect = DbDialect::from_settings(&settings);
        let vchno_nonempty = dialect.nonempty_condition("t.VchNo");
        let sql = format!(
            "SELECT TOP 1 t.VchCode \
             FROM {table} t \
             WHERE t.Cancelled = 0 \
               AND t.VchType = ? \
               AND {vchno_nonempty} \
             ORDER BY t.VchCode DESC"
        );

        let conn = self.connect()?;
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let params = (&voucher_type_param,);
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(0),
        };

        let Some(mut row) = cursor.next_row().map_err(|error| error.to_string())? else {
            return Ok(0);
        };

        Ok(read_text(&mut row, 1)?
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or_default())
    }

    pub fn get_new_invoice_events_after_code(
        &self,
        last_vch_code: i32,
    ) -> Result<Vec<InvoiceWatchEvent>, String> {
        let settings = self.settings()?;
        let table = checked_identifier(&settings.invoice_table)?;
        let dialect = DbDialect::from_settings(&settings);
        let vchno_nonempty = dialect.nonempty_condition("t.VchNo");
        let sql = format!(
            "SELECT TOP 20 \
                    t.VchCode, \
                    t.VchSeriesCode, \
                    t.VchNo \
             FROM {table} t \
             WHERE t.Cancelled = 0 \
               AND t.VchType = ? \
               AND {vchno_nonempty} \
               AND t.VchCode > ? \
             ORDER BY t.VchCode ASC"
        );

        let conn = self.connect()?;
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let last_vch_code_param = last_vch_code.into_parameter();
        let params = (&voucher_type_param, &last_vch_code_param);
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(Vec::new()),
        };

        let mut events = Vec::new();

        while let Some(mut row) = cursor.next_row().map_err(|error| error.to_string())? {
            let vch_code = read_text(&mut row, 1)?
                .and_then(|value| value.parse::<i32>().ok())
                .unwrap_or_default();
            let vch_series_code =
                read_text(&mut row, 2)?.and_then(|value| value.parse::<i32>().ok());
            let invoice_no = read_text(&mut row, 3)?.unwrap_or_default();
            let invoice = self.get_invoice_by_vch_code(vch_code)?;

            events.push(InvoiceWatchEvent {
                vch_code,
                vch_series_code,
                invoice_no,
                modification_time: String::new(),
                invoice,
            });
        }

        Ok(events)
    }

    fn connect(&self) -> Result<odbc_api::Connection<'static>, String> {
        let settings = self.settings()?;

        if settings.connection_string.trim().is_empty() {
            return Err(
                "BUSY_ODBC_CONNECTION_STRING is not set. Create a 64-bit Busy DSN or set a full ODBC connection string."
                    .to_string(),
            );
        }

        let env = odbc_environment()?;
        env.connect_with_connection_string(
            &settings.connection_string,
            ConnectionOptions::default(),
        )
        .map_err(|error| error.to_string())
    }

    fn fetch_invoices<P>(&self, sql: &str, params: P, timeout: Option<usize>) -> Result<Vec<Invoice>, String>
    where
        P: odbc_api::ParameterCollectionRef,
    {
        let conn = self.connect()?;
        let mut cursor = match conn
            .execute(sql, params, timeout)
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(Vec::new()),
        };

        collect_invoices(&mut cursor)
    }

    fn find_sales_voucher_code(
        &self,
        table: &str,
        invoice_no: &str,
    ) -> Result<Option<i32>, String> {
        let settings = self.settings()?;
        let dialect = DbDialect::from_settings(&settings);
        let trim_vchno = dialect.trim("VchNo");
        let trim_param = dialect.trim("?");
        let sql = format!(
            "SELECT VchCode FROM {table} \
             WHERE {trim_vchno} = {trim_param} AND Cancelled = 0 AND VchType = ?"
        );
        let conn = self.connect()?;
        let invoice_param = invoice_no.into_parameter();
        let voucher_type_param = settings.sales_voucher_type.into_parameter();
        let params = (&invoice_param, &voucher_type_param);
        let mut cursor = match conn
            .execute(&sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Ok(None),
        };

        let Some(mut row) = cursor.next_row().map_err(|error| error.to_string())? else {
            return Ok(None);
        };

        Ok(read_text(&mut row, 1)?.and_then(|value| value.parse::<i32>().ok()))
    }

    fn ensure_text_status_column(
        &self,
        status_table: &str,
        status_column: &str,
    ) -> Result<(), String> {
        let settings = self.settings()?;
        let dialect = DbDialect::from_settings(&settings);

        // MS Access doesn't support INFORMATION_SCHEMA; skip type validation
        if dialect == DbDialect::Access {
            return Ok(());
        }

        let sql = "SELECT DATA_TYPE \
                   FROM INFORMATION_SCHEMA.COLUMNS \
                   WHERE TABLE_NAME = ? AND COLUMN_NAME = ?";
        let conn = self.connect()?;
        let table_param = status_table.into_parameter();
        let column_param = status_column.into_parameter();
        let params = (&table_param, &column_param);
        let mut cursor = match conn
            .execute(sql, params, dialect.query_timeout())
            .map_err(|error| error.to_string())?
        {
            Some(cursor) => cursor,
            None => return Err(format!("Column {status_column} was not found.")),
        };

        let Some(mut row) = cursor.next_row().map_err(|error| error.to_string())? else {
            return Err(format!("Column {status_column} was not found."));
        };

        let data_type = read_text(&mut row, 1)?
            .unwrap_or_default()
            .to_ascii_lowercase();

        let is_text = matches!(
            data_type.as_str(),
            "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext"
        );

        if is_text {
            Ok(())
        } else {
            Err(format!(
                "Column {status_column} is {data_type}, not text. Set BUSY_PAYMENT_STATUS_COLUMN to your custom text status field."
            ))
        }
    }
}

fn load_dotenv() {
    dotenvy::dotenv().ok();
    dotenvy::from_filename("../.env").ok();
}

fn odbc_environment() -> Result<&'static Environment, String> {
    let init_result = ODBC_ENV.get_or_init(|| unsafe {
        Environment::set_connection_pooling(AttrConnectionPooling::DriverAware)
            .map_err(|error| error.to_string())
            .and_then(|_| {
                let mut env = Environment::new().map_err(|error| error.to_string())?;
                env.set_connection_pooling_matching(AttrCpMatch::Strict)
                    .map_err(|error| error.to_string())?;
                Ok(env)
            })
    });

    init_result.as_ref().map_err(|error| error.to_string())
}

fn collect_invoices(cursor: &mut impl Cursor) -> Result<Vec<Invoice>, String> {
    let mut invoices = Vec::new();

    while let Some(row) = cursor.next_row().map_err(|error| error.to_string())? {
        invoices.push(read_invoice_row(row)?);
    }

    Ok(invoices)
}

fn read_invoice_row(mut row: odbc_api::CursorRow<'_>) -> Result<Invoice, String> {
    Ok(Invoice {
        vch_code: read_text(&mut row, 1)?.and_then(|value| value.parse::<i32>().ok()),
        vch_series_code: read_text(&mut row, 2)?.and_then(|value| value.parse::<i32>().ok()),
        invoice_no: read_text(&mut row, 3)?.unwrap_or_default(),
        invoice_date: read_text(&mut row, 4)?,
        invoice_date_nepali: read_text(&mut row, 5)?,
        party_name: read_text(&mut row, 6)?,
        net_amount: read_text(&mut row, 7)?,
        amount_source: read_text(&mut row, 8)?,
        payment_status: read_text(&mut row, 9)?,
    })
}

fn read_text(row: &mut odbc_api::CursorRow<'_>, column: u16) -> Result<Option<String>, String> {
    let mut buffer = Vec::new();
    let has_value = row
        .get_text(column, &mut buffer)
        .map_err(|error| error.to_string())?;

    if has_value {
        Ok(Some(String::from_utf8_lossy(&buffer).trim().to_string()))
    } else {
        Ok(None)
    }
}

fn checked_identifier(value: &str) -> Result<String, String> {
    let is_valid = value.split('.').all(|part| {
        !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    });

    if is_valid {
        Ok(value.to_string())
    } else {
        Err("Invalid Busy invoice table name".to_string())
    }
}

fn checked_column_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let is_valid = !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ' ');

    if is_valid {
        Ok(trimmed.to_string())
    } else {
        Err("Invalid Busy column name".to_string())
    }
}

struct InvoiceAmountSql {
    value_expression: String,
    source_expression: String,
}

fn invoice_amount_sql(pos_credit_column: Option<&str>, dialect: &DbDialect) -> InvoiceAmountSql {
    let fallback_amount = dialect.cast_str("t.VchAmtBaseCur");

    let col = pos_credit_column
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .unwrap_or("CCAmt1");

    match dialect {
        DbDialect::SqlServer => {
            let pos_check = dialect.nz("t.POSEnabled", "0");
            let pos_credit_amount_expression = format!(
                "CASE WHEN {pos_check} = 1 \
                THEN (SELECT TOP 1 CAST(pd.[{col}] AS varchar(64)) \
                      FROM POSDet pd \
                      WHERE pd.VchCode = t.VchCode \
                        AND pd.[{col}] IS NOT NULL) \
                END"
            );
            let pos_credit_exists_expression = format!(
                "{pos_check} = 1 \
                AND EXISTS (SELECT 1 FROM POSDet pd \
                            WHERE pd.VchCode = t.VchCode AND pd.[{col}] IS NOT NULL)"
            );
            InvoiceAmountSql {
                value_expression: format!("COALESCE({pos_credit_amount_expression}, {fallback_amount})"),
                source_expression: format!(
                    "CASE WHEN {pos_credit_exists_expression} \
                     THEN 'POSDet {col}' ELSE 'Invoice net amount' END"
                ),
            }
        }
        DbDialect::Access => {
            // Access: use configured column from POSDet if available (no POSEnabled check),
            // fall back to base amount when no matching row exists.
            let sub = format!(
                "SELECT TOP 1 pd.[{col}] & '' FROM POSDet pd \
                 WHERE pd.VchCode = t.VchCode AND pd.[{col}] IS NOT NULL"
            );
            InvoiceAmountSql {
                value_expression: format!(
                    "IIf(Not IsNull(({sub})), ({sub}), {fallback_amount})"
                ),
                source_expression: format!(
                    "IIf(Not IsNull(({sub})), 'POSDet {col}', 'Invoice net amount')"
                ),
            }
        }
    }
}

fn validate_settings(settings: &BusySettings) -> Result<(), String> {
    if settings.connection_string.trim().is_empty() {
        return Err("ODBC connection string is required.".to_string());
    }

    checked_identifier(&settings.invoice_table)?;
    checked_identifier(&settings.payment_status_table)?;
    checked_column_identifier(&settings.payment_status_column)?;
    checked_column_identifier(&settings.payment_transaction_id_column)?;
    if settings.payment_status_column.eq_ignore_ascii_case(&settings.payment_transaction_id_column) {
        return Err("Payment status column and transaction ID column must be different.".to_string());
    }
    invoice_amount_sql(
        settings.pos_credit_column.as_deref(),
        &DbDialect::from_settings(settings),
    );

    if settings.sales_voucher_type <= 0 {
        return Err("Sales voucher type must be greater than zero.".to_string());
    }

    Ok(())
}

fn read_settings_file(path: &PathBuf) -> Result<BusySettings, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read Busy settings from {}: {error}",
            path.display()
        )
    })?;
    let settings: BusySettings = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Could not parse Busy settings from {}: {error}",
            path.display()
        )
    })?;

    validate_settings(&settings)?;
    Ok(settings)
}

fn write_settings_file(settings: &BusySettings, path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create Busy settings folder {}: {error}",
                parent.display()
            )
        })?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize Busy settings: {error}"))?;

    fs::write(path, content).map_err(|error| {
        format!(
            "Could not save Busy settings to {}: {error}",
            path.display()
        )
    })
}

fn settings_file_path() -> Result<PathBuf, String> {
    if let Ok(appdata) = env::var("APPDATA") {
        return Ok(PathBuf::from(appdata)
            .join("BusyPay QR")
            .join("busy-settings.json"));
    }

    Ok(env::current_dir()
        .map_err(|error| error.to_string())?
        .join("busy-settings.json"))
}

fn mask_connection_string(value: &str) -> String {
    value
        .split(';')
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            let mut pieces = part.splitn(2, '=');
            let key = pieces.next().unwrap_or_default();
            let val = pieces.next().unwrap_or_default();

            if key.eq_ignore_ascii_case("PWD") || key.eq_ignore_ascii_case("Password") {
                format!("{key}=********")
            } else {
                format!("{key}={val}")
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

pub fn read_fonepay_settings() -> Result<crate::models::FonepaySettings, String> {
    let path = fonepay_settings_file_path()?;
    if !path.exists() {
        return Ok(crate::models::FonepaySettings {
            dynamic_url: String::new(),
            pos_api_url: String::new(),
            merchant_code: String::new(),
            merchant_secret: String::new(),
            username: String::new(),
            password: String::new(),
            integration_mode: String::new(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Could not read Fonepay settings from {}: {error}",
            path.display()
        )
    })?;
    let mut settings: crate::models::FonepaySettings =
        serde_json::from_str(&content).map_err(|error| {
            format!(
                "Could not parse Fonepay settings from {}: {error}",
                path.display()
            )
        })?;

    decrypt_fonepay_settings(&mut settings)?;
    Ok(settings)
}

pub fn write_fonepay_settings(
    settings: &crate::models::FonepaySettings,
) -> Result<crate::models::FonepaySettings, String> {
    let path = fonepay_settings_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create Fonepay settings folder {}: {error}",
                parent.display()
            )
        })?;
    }

    let mut stored_settings = settings.clone();
    encrypt_fonepay_settings(&mut stored_settings)?;

    let content = serde_json::to_string_pretty(&stored_settings)
        .map_err(|error| format!("Could not serialize Fonepay settings: {error}"))?;

    fs::write(&path, content).map_err(|error| {
        format!(
            "Could not save Fonepay settings to {}: {error}",
            path.display()
        )
    })?;

    Ok(settings.clone())
}

fn fonepay_settings_file_path() -> Result<PathBuf, String> {
    if let Ok(appdata) = env::var("APPDATA") {
        return Ok(PathBuf::from(appdata)
            .join("BusyPay QR")
            .join("fonepay-settings.json"));
    }

    Ok(env::current_dir()
        .map_err(|error| error.to_string())?
        .join("fonepay-settings.json"))
}

const PROTECTED_SECRET_PREFIX: &str = "dpapi:v1:";

fn encrypt_fonepay_settings(settings: &mut crate::models::FonepaySettings) -> Result<(), String> {
    settings.merchant_code = protect_secret(&settings.merchant_code)?;
    settings.merchant_secret = protect_secret(&settings.merchant_secret)?;
    settings.username = protect_secret(&settings.username)?;
    settings.password = protect_secret(&settings.password)?;
    Ok(())
}

fn decrypt_fonepay_settings(settings: &mut crate::models::FonepaySettings) -> Result<(), String> {
    settings.merchant_code = unprotect_secret(&settings.merchant_code)?;
    settings.merchant_secret = unprotect_secret(&settings.merchant_secret)?;
    settings.username = unprotect_secret(&settings.username)?;
    settings.password = unprotect_secret(&settings.password)?;
    Ok(())
}

fn protect_secret(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with(PROTECTED_SECRET_PREFIX) {
        return Ok(value.to_string());
    }

    protect_secret_platform(trimmed.as_bytes())
        .map(|bytes| format!("{PROTECTED_SECRET_PREFIX}{}", hex_encode(&bytes)))
}

fn unprotect_secret(value: &str) -> Result<String, String> {
    let Some(encoded) = value.strip_prefix(PROTECTED_SECRET_PREFIX) else {
        return Ok(value.to_string());
    };

    let protected_bytes = hex_decode(encoded)?;
    let bytes = unprotect_secret_platform(&protected_bytes)?;
    String::from_utf8(bytes)
        .map_err(|error| format!("Could not decode protected Fonepay setting: {error}"))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Protected Fonepay setting is not valid hex.".to_string());
    }

    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|error| format!("Protected Fonepay setting is not valid hex: {error}"))
        })
        .collect()
}

#[cfg(windows)]
fn protect_secret_platform(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            pDataIn: *mut DataBlob,
            szDataDescr: *const u16,
            pOptionalEntropy: *mut DataBlob,
            pvReserved: *mut c_void,
            pPromptStruct: *mut c_void,
            dwFlags: u32,
            pDataOut: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hMem: *mut c_void) -> *mut c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    let mut input = DataBlob {
        cb_data: bytes.len() as u32,
        pb_data: bytes.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err("Could not protect Fonepay setting with Windows user credentials.".to_string());
    }

    let protected =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe {
        LocalFree(output.pb_data as *mut c_void);
    }
    Ok(protected)
}

#[cfg(windows)]
fn unprotect_secret_platform(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::{ffi::c_void, ptr};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            pDataIn: *mut DataBlob,
            ppszDataDescr: *mut *mut u16,
            pOptionalEntropy: *mut DataBlob,
            pvReserved: *mut c_void,
            pPromptStruct: *mut c_void,
            dwFlags: u32,
            pDataOut: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hMem: *mut c_void) -> *mut c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    let mut input = DataBlob {
        cb_data: bytes.len() as u32,
        pb_data: bytes.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };

    if ok == 0 {
        return Err(
            "Could not unlock protected Fonepay setting for this Windows user.".to_string(),
        );
    }

    let unprotected =
        unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe {
        LocalFree(output.pb_data as *mut c_void);
    }
    Ok(unprotected)
}

#[cfg(not(windows))]
fn protect_secret_platform(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

#[cfg(not(windows))]
fn unprotect_secret_platform(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}
