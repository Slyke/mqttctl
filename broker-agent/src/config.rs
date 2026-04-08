use std::{env, fs, net::IpAddr};

use serde::Deserialize;
use serde_json::json;

use crate::errors::AppError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpListenConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpsListenConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenConfig {
    pub http: HttpListenConfig,
    pub https: HttpsListenConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerConfig {
    pub command: Vec<String>,
    pub main_config_path: String,
    pub dynsec_state_file_path: String,
    #[serde(default)]
    pub key_files: BrokerKeyFilesConfig,
    pub dynsec_bootstrap: Option<DynsecBootstrapConfig>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerKeyFilesConfig {
    pub ca_file: Option<String>,
    pub mosquitto_public_key: Option<String>,
    pub broker_public_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynsecBootstrapConfig {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub listen: ListenConfig,
    pub auth: AuthConfig,
    pub broker: BrokerConfig,
}

impl RuntimeConfig {
    fn validate(&self) -> Result<(), AppError> {
        if !self.listen.http.enabled && !self.listen.https.enabled {
            return Err(AppError::new(
                "config::validate",
                "At least one broker-agent listener must be enabled.",
                "CONFIG_VALIDATION_FAILED",
                500,
                None,
                Some(json!({ "path": "listen" })),
            ));
        }

        validate_enabled_listener(
            self.listen.http.enabled,
            &self.listen.http.host,
            self.listen.http.port,
            "listen.http",
        )?;

        validate_enabled_listener(
            self.listen.https.enabled,
            &self.listen.https.host,
            self.listen.https.port,
            "listen.https",
        )?;

        if self.listen.https.enabled {
            validate_required_path(
                self.listen.https.cert_file.as_deref(),
                "listen.https.certFile",
            )?;
            validate_required_path(
                self.listen.https.key_file.as_deref(),
                "listen.https.keyFile",
            )?;
        }

        if self.listen.http.enabled
            && self.listen.https.enabled
            && self.listen.http.host == self.listen.https.host
            && self.listen.http.port == self.listen.https.port
        {
            return Err(AppError::new(
                "config::validate",
                "HTTP and HTTPS listeners cannot bind the same host and port.",
                "CONFIG_VALIDATION_FAILED",
                500,
                None,
                Some(json!({
                    "http": {
                        "host": self.listen.http.host,
                        "port": self.listen.http.port,
                    },
                    "https": {
                        "host": self.listen.https.host,
                        "port": self.listen.https.port,
                    }
                })),
            ));
        }

        if self.auth.api_key.trim().is_empty() {
            return Err(AppError::new(
                "config::validate",
                "auth.apiKey is required.",
                "CONFIG_VALIDATION_FAILED",
                500,
                None,
                Some(json!({ "path": "auth.apiKey" })),
            ));
        }

        if self.broker.command.is_empty() {
            return Err(AppError::new(
                "config::validate",
                "broker.command must contain at least one entry.",
                "CONFIG_VALIDATION_FAILED",
                500,
                None,
                Some(json!({ "path": "broker.command" })),
            ));
        }

        if self.broker.main_config_path.trim().is_empty()
            || self.broker.dynsec_state_file_path.trim().is_empty()
        {
            return Err(AppError::new(
                "config::validate",
                "broker.mainConfigPath and broker.dynsecStateFilePath are required.",
                "CONFIG_VALIDATION_FAILED",
                500,
                None,
                Some(json!({
                    "mainConfigPath": self.broker.main_config_path,
                    "dynsecStateFilePath": self.broker.dynsec_state_file_path,
                })),
            ));
        }

        if let Some(dynsec_bootstrap) = &self.broker.dynsec_bootstrap {
            if dynsec_bootstrap.username.trim().is_empty()
                || dynsec_bootstrap.password.trim().is_empty()
            {
                return Err(AppError::new(
                    "config::validate",
                    "broker.dynsecBootstrap.username and broker.dynsecBootstrap.password are required when dynsec bootstrap is configured.",
                    "CONFIG_VALIDATION_FAILED",
                    500,
                    None,
                    Some(json!({
                        "path": "broker.dynsecBootstrap",
                    })),
                ));
            }
        }

        validate_optional_path(
            self.broker.key_files.ca_file.as_deref(),
            "broker.keyFiles.caFile",
        )?;
        validate_optional_path(
            self.broker.key_files.mosquitto_public_key.as_deref(),
            "broker.keyFiles.mosquittoPublicKey",
        )?;
        validate_optional_path(
            self.broker.key_files.broker_public_key.as_deref(),
            "broker.keyFiles.brokerPublicKey",
        )?;

        Ok(())
    }
}

pub fn load_runtime_config() -> Result<RuntimeConfig, AppError> {
    let config_path = env::var("MQTTCTL_BROKER_AGENT_CONFIG_PATH").map_err(|_| {
        AppError::new(
            "config::load",
            "MQTTCTL_BROKER_AGENT_CONFIG_PATH is required.",
            "CONFIG_LOAD_FAILED",
            500,
            None,
            None,
        )
    })?;

    let text = fs::read_to_string(&config_path).map_err(|error| {
        AppError::new(
            "config::load",
            &format!("Failed reading broker-agent config from {config_path}."),
            "CONFIG_LOAD_FAILED",
            500,
            None,
            Some(json!({
                "configPath": config_path,
                "cause": error.to_string(),
            })),
        )
    })?;

    let config: RuntimeConfig = serde_json::from_str(&text).map_err(|error| {
        AppError::new(
            "config::load",
            "Broker-agent config JSON failed validation.",
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({
                "configPath": config_path,
                "cause": error.to_string(),
            })),
        )
    })?;

    config.validate()?;
    Ok(config)
}

fn validate_enabled_listener(
    enabled: bool,
    host: &str,
    port: u16,
    path: &str,
) -> Result<(), AppError> {
    if !enabled {
        return Ok(());
    }

    if host.trim().is_empty() {
        return Err(AppError::new(
            "config::validate",
            &format!("{path}.host is required when the listener is enabled."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": format!("{path}.host") })),
        ));
    }

    if host.parse::<IpAddr>().is_err() {
        return Err(AppError::new(
            "config::validate",
            &format!("{path}.host must be an IP address."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": format!("{path}.host"), "value": host })),
        ));
    }

    if port == 0 {
        return Err(AppError::new(
            "config::validate",
            &format!("{path}.port must be greater than 0."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": format!("{path}.port"), "value": port })),
        ));
    }

    Ok(())
}

fn validate_required_path(value: Option<&str>, path: &str) -> Result<(), AppError> {
    let Some(value) = value else {
        return Err(AppError::new(
            "config::validate",
            &format!("{path} is required when HTTPS is enabled."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": path })),
        ));
    };

    if value.trim().is_empty() {
        return Err(AppError::new(
            "config::validate",
            &format!("{path} must not be empty."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": path })),
        ));
    }

    Ok(())
}

fn validate_optional_path(value: Option<&str>, path: &str) -> Result<(), AppError> {
    let Some(value) = value else {
        return Ok(());
    };

    if value.trim().is_empty() {
        return Err(AppError::new(
            "config::validate",
            &format!("{path} must not be empty."),
            "CONFIG_VALIDATION_FAILED",
            500,
            None,
            Some(json!({ "path": path })),
        ));
    }

    Ok(())
}
