use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::{
    agent::{BrokerAgentService, DynsecConnection},
    build_info::{BUILD_COMMIT_HASH, BUILD_VERSION},
    errors::{ok, AppError},
    logging::Logger,
};

#[derive(Clone)]
pub struct ApiState {
    pub service: Arc<BrokerAgentService>,
    pub logger: Logger,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteRequest {
    rendered: String,
    #[serde(default)]
    expected_current: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynsecCommandRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    connection: DynsecConnection,
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/health", get(get_health))
        .route("/healthz", get(get_healthz))
        .route("/broker-config/current", get(get_broker_config_current))
        .route("/broker-config/write", post(post_broker_config_write))
        .route("/broker-key-files", get(get_managed_key_files))
        .route("/broker-key-files/:file_id", get(get_managed_key_file))
        .route("/broker/reload", post(post_broker_reload))
        .route("/broker/restart", post(post_broker_restart))
        .route("/runtime", get(get_runtime))
        .route("/dynsec/state", get(get_dynsec_state))
        .route("/dynsec/command", post(post_dynsec_command))
        .with_state(state)
}

async fn get_health(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    let health = state.service.health(correlation_id.as_deref()).await?;
    Ok(ok(serde_json::json!({ "health": health })))
}

async fn get_healthz(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    let health = state.service.health(correlation_id.as_deref()).await?;
    Ok(ok(serde_json::json!({ "health": health })))
}

async fn get_broker_config_current(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let current = state
        .service
        .read_current_broker_config(correlation_id.as_deref())?;
    Ok(ok(serde_json::json!({ "current": current })))
}

async fn post_broker_config_write(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: Result<Json<WriteRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let Json(payload) = payload.map_err(|error| {
        AppError::new(
            "http::post_broker_config_write",
            "Request body failed validation.",
            "INPUT_INVALID",
            400,
            correlation_id.clone(),
            Some(serde_json::json!({ "cause": error.body_text() })),
        )
    })?;
    state.service.write_broker_config(
        &payload.rendered,
        payload.expected_current.as_deref(),
        correlation_id.as_deref(),
    )?;
    Ok(ok(serde_json::json!({ "written": true })))
}

async fn get_managed_key_files(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let files = state
        .service
        .list_managed_key_files(correlation_id.as_deref())?;
    Ok(ok(serde_json::json!({ "files": files })))
}

async fn get_managed_key_file(
    State(state): State<ApiState>,
    Path(file_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let file = state
        .service
        .read_managed_key_file(&file_id, correlation_id.as_deref())?;
    Ok(ok(serde_json::json!({ "file": file })))
}

async fn post_broker_reload(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let operation = state
        .service
        .reload_broker(correlation_id.as_deref())
        .await?;
    Ok(ok(serde_json::json!({ "operation": operation })))
}

async fn post_broker_restart(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let operation = state
        .service
        .restart_broker(correlation_id.as_deref())
        .await?;
    Ok(ok(serde_json::json!({ "operation": operation })))
}

async fn get_runtime(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let mqtt_server_version = state
        .service
        .mqtt_server_version(correlation_id.as_deref())
        .await;
    Ok(ok(serde_json::json!({
        "brokerAgentVersion": BUILD_VERSION,
        "brokerAgentBuildHash": BUILD_COMMIT_HASH,
        "mqttServerVersion": mqtt_server_version,
    })))
}

async fn get_dynsec_state(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let raw = state
        .service
        .read_dynsec_state_file(correlation_id.as_deref())?;
    Ok(ok(serde_json::json!({ "raw": raw })))
}

async fn post_dynsec_command(
    State(state): State<ApiState>,
    headers: HeaderMap,
    payload: Result<Json<DynsecCommandRequest>, JsonRejection>,
) -> Result<Json<serde_json::Value>, AppError> {
    let correlation_id = correlation_id(&headers);
    require_api_key(&state, &headers, correlation_id.as_deref())?;
    let Json(payload) = payload.map_err(|error| {
        AppError::new(
            "http::post_dynsec_command",
            "Request body failed validation.",
            "INPUT_INVALID",
            400,
            correlation_id.clone(),
            Some(serde_json::json!({ "cause": error.body_text() })),
        )
    })?;
    let result = state
        .service
        .run_dynsec_command(
            &payload.command,
            &payload.args,
            &payload.connection,
            correlation_id.as_deref(),
        )
        .await?;
    Ok(ok(serde_json::json!({ "result": result })))
}

fn require_api_key(
    state: &ApiState,
    headers: &HeaderMap,
    correlation_id: Option<&str>,
) -> Result<(), AppError> {
    let provided = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match provided {
        Some(value) if value == state.api_key => Ok(()),
        Some(_) => {
            state.logger.warn(
                "http::require_api_key",
                "Rejected broker-agent request with invalid API key.",
                correlation_id,
                None,
            );
            Err(AppError::new(
                "http::require_api_key",
                "Broker-agent API key is invalid.",
                "AUTH_INVALID",
                401,
                correlation_id.map(str::to_string),
                None,
            ))
        }
        None => {
            state.logger.warn(
                "http::require_api_key",
                "Rejected broker-agent request without API key.",
                correlation_id,
                None,
            );
            Err(AppError::new(
                "http::require_api_key",
                "Broker-agent API key is required.",
                "AUTH_REQUIRED",
                401,
                correlation_id.map(str::to_string),
                None,
            ))
        }
    }
}

fn correlation_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}
