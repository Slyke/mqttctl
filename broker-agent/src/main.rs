mod agent;
mod build_info;
mod config;
mod errors;
mod http_api;
mod logging;
mod mosquitto;

use std::sync::Arc;
use std::{net::SocketAddr, time::Duration};

use axum::Router;
use axum_server::{tls_rustls::RustlsConfig, Handle};
use config::load_runtime_config;
use errors::AppError;
use http_api::{router, ApiState};
use logging::Logger;
use mosquitto::MosquittoSupervisor;
use tokio::task::JoinSet;

use crate::agent::BrokerAgentService;
use crate::build_info::{BUILD_COMMIT_HASH, BUILD_LABEL, BUILD_VERSION};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!(
            "broker-agent startup failed: {} [{}] ({})",
            error.reason, error.error_code, error.caller
        );
        std::process::exit(1);
    }
}

async fn run() -> Result<(), AppError> {
    let runtime_config = load_runtime_config()?;
    let logger = Logger::from_env();
    logger.info_with_context(
        "main::run",
        &format!("Broker agent build {BUILD_LABEL}."),
        None,
        Some(serde_json::json!({
            "build": {
                "label": BUILD_LABEL,
                "version": BUILD_VERSION,
                "commitHash": BUILD_COMMIT_HASH,
            }
        })),
    );
    let supervisor = MosquittoSupervisor::new(runtime_config.broker.clone(), logger.clone());
    supervisor.start(None).await?;

    let service = Arc::new(BrokerAgentService::new(
        runtime_config.clone(),
        logger.clone(),
        supervisor.clone(),
    ));
    service.log_startup_key_file_statuses();

    let app: Router = router(ApiState {
        service,
        logger: logger.clone(),
        api_key: runtime_config.auth.api_key.clone(),
    });

    let handle = Handle::new();
    let shutdown_handle = handle.clone();
    let shutdown_supervisor = supervisor.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_supervisor.shutdown(None).await;
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(10)));
    });

    let mut servers = JoinSet::new();

    if runtime_config.listen.http.enabled {
        let address = socket_addr(
            &runtime_config.listen.http.host,
            runtime_config.listen.http.port,
            "main::http_socket_addr",
        )?;
        logger.info(
            "main::run",
            &format!("Broker agent listening on http://{address}."),
            None,
        );
        let http_app = app.clone();
        let http_handle = handle.clone();
        servers.spawn(async move {
            axum_server::bind(address)
                .handle(http_handle)
                .serve(http_app.into_make_service())
                .await
                .map_err(|error| {
                    AppError::new(
                        "main::serve_http",
                        "Broker-agent HTTP server stopped unexpectedly.",
                        "APP_STARTUP_FAILED",
                        500,
                        None,
                        Some(serde_json::json!({
                            "bindAddress": address.to_string(),
                            "cause": error.to_string(),
                        })),
                    )
                })
        });
    }

    if runtime_config.listen.https.enabled {
        let https_config = runtime_config.listen.https.clone();
        let address = socket_addr(
            &https_config.host,
            https_config.port,
            "main::https_socket_addr",
        )?;
        let cert_file = https_config.cert_file.clone().unwrap_or_default();
        let key_file = https_config.key_file.clone().unwrap_or_default();
        let rustls_config = RustlsConfig::from_pem_file(cert_file.clone(), key_file.clone())
            .await
            .map_err(|error| {
                AppError::new(
                    "main::tls_config",
                    "Failed loading broker-agent HTTPS certificate or key.",
                    "APP_STARTUP_FAILED",
                    500,
                    None,
                    Some(serde_json::json!({
                        "bindAddress": address.to_string(),
                        "certFile": cert_file,
                        "keyFile": key_file,
                        "cause": error.to_string(),
                    })),
                )
            })?;
        logger.info(
            "main::run",
            &format!("Broker agent listening on https://{address}."),
            None,
        );
        let https_app = app.clone();
        let https_handle = handle.clone();
        servers.spawn(async move {
            axum_server::bind_rustls(address, rustls_config)
                .handle(https_handle)
                .serve(https_app.into_make_service())
                .await
                .map_err(|error| {
                    AppError::new(
                        "main::serve_https",
                        "Broker-agent HTTPS server stopped unexpectedly.",
                        "APP_STARTUP_FAILED",
                        500,
                        None,
                        Some(serde_json::json!({
                            "bindAddress": address.to_string(),
                            "cause": error.to_string(),
                        })),
                    )
                })
        });
    }

    while let Some(result) = servers.join_next().await {
        let result = result.map_err(|error| {
            AppError::new(
                "main::join_server",
                "Broker-agent listener task failed.",
                "APP_STARTUP_FAILED",
                500,
                None,
                Some(serde_json::json!({ "cause": error.to_string() })),
            )
        })?;

        if let Err(error) = result {
            logger.error(
                "main::run",
                "Broker-agent listener task failed.",
                error.correlation_id.as_deref(),
                Some(serde_json::json!({
                    "caller": &error.caller,
                    "reason": &error.reason,
                    "errorKey": &error.error_key,
                    "errorCode": &error.error_code,
                    "details": &error.details,
                })),
            );
            handle.graceful_shutdown(Some(Duration::from_secs(10)));
            let _ = supervisor.shutdown(None).await;
            return Err(error);
        }
    }

    let _ = supervisor.shutdown(None).await;

    Ok(())
}

fn socket_addr(host: &str, port: u16, caller: &str) -> Result<SocketAddr, AppError> {
    let bind_address = format!("{host}:{port}");
    bind_address.parse::<SocketAddr>().map_err(|error| {
        AppError::new(
            caller,
            "Broker-agent listener host or port is invalid.",
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(serde_json::json!({
                "bindAddress": bind_address,
                "cause": error.to_string(),
            })),
        )
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
