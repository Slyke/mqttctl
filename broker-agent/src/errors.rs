use std::{collections::HashMap, sync::OnceLock};

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};

static ERROR_CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();

fn error_catalog() -> &'static HashMap<String, String> {
    ERROR_CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../errors.json")).unwrap_or_else(|_| {
            HashMap::from([(
                String::from("ERR_UNKNOWN"),
                String::from("0000000000000000"),
            )])
        })
    })
}

fn resolve_error_code(error_key: &str) -> String {
    error_catalog()
        .get(error_key)
        .cloned()
        .or_else(|| error_catalog().get("ERR_UNKNOWN").cloned())
        .unwrap_or_else(|| String::from("0000000000000000"))
}

#[derive(Debug, Clone)]
pub struct AppError {
    pub caller: String,
    pub reason: String,
    pub error_key: String,
    pub error_code: String,
    pub status: StatusCode,
    pub correlation_id: Option<String>,
    pub details: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    ok: bool,
    error_key: String,
    error_code: String,
    reason: String,
    correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl AppError {
    pub fn new(
        caller: &str,
        reason: &str,
        error_key: &str,
        status: u16,
        correlation_id: Option<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            caller: caller.to_string(),
            reason: reason.to_string(),
            error_key: error_key.to_string(),
            error_code: resolve_error_code(error_key),
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            correlation_id,
            details,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            ok: false,
            error_key: self.error_key,
            error_code: self.error_code,
            reason: self.reason,
            correlation_id: self.correlation_id,
            details: self.details,
        };

        (self.status, Json(body)).into_response()
    }
}

pub fn ok<T>(data: T) -> Json<Value>
where
    T: Serialize,
{
    Json(json!({
        "ok": true,
        "data": data,
    }))
}
