use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    config::RuntimeConfig,
    errors::AppError,
    logging::Logger,
    mosquitto::{BrokerHealth, CommandResult, MosquittoSupervisor},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub status: String,
    pub message: Option<String>,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedKeyFileStatus {
    pub file_id: String,
    pub path: Option<String>,
    pub file_name: Option<String>,
    pub configured: bool,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedKeyFileDownload {
    pub file_id: String,
    pub path: String,
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynsecConnectionTls {
    pub enabled: bool,
    pub ca_file: Option<String>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
    pub insecure: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynsecConnection {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub client_id: String,
    pub tls: DynsecConnectionTls,
}

const ALLOWED_DYNSEC_COMMANDS: &[&str] = &[
    "createClient",
    "setClientPassword",
    "disableClient",
    "enableClient",
    "deleteClient",
    "addClientRole",
    "removeClientRole",
    "createGroup",
    "deleteGroup",
    "addGroupClient",
    "removeGroupClient",
    "addGroupRole",
    "removeGroupRole",
    "createRole",
    "deleteRole",
    "addRoleACL",
    "removeRoleACL",
    "listClients",
];

#[derive(Clone)]
pub struct BrokerAgentService {
    runtime_config: RuntimeConfig,
    logger: Logger,
    supervisor: Arc<MosquittoSupervisor>,
}

impl BrokerAgentService {
    pub fn new(
        runtime_config: RuntimeConfig,
        logger: Logger,
        supervisor: Arc<MosquittoSupervisor>,
    ) -> Self {
        Self {
            runtime_config,
            logger,
            supervisor,
        }
    }

    pub async fn health(&self, correlation_id: Option<&str>) -> Result<BrokerHealth, AppError> {
        self.supervisor.health(correlation_id).await
    }

    pub fn log_startup_key_file_statuses(&self) {
        let key_files = ["caFile", "mosquittoPublicKey", "brokerPublicKey"]
            .into_iter()
            .map(|file_id| {
                let configured_path = self.managed_key_file_path(file_id, None).ok().flatten();
                let configured = configured_path.is_some();
                let exists_result = configured_path.as_deref().map(|file_path| {
                    self.managed_key_file_exists(file_id, file_path, None)
                });
                let file_name = configured_path
                    .as_ref()
                    .and_then(|file_path| Path::new(file_path).file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_string);
                let exists = matches!(exists_result, Some(Ok(true)));
                let check_error = match exists_result {
                    Some(Err(error)) => Some(json!({
                        "reason": error.reason,
                        "errorKey": error.error_key,
                        "errorCode": error.error_code,
                        "details": error.details,
                    })),
                    _ => None,
                };

                json!({
                    "fileId": file_id,
                    "path": configured_path,
                    "fileName": file_name,
                    "configured": configured,
                    "exists": exists,
                    "checkError": check_error,
                })
            })
            .collect::<Vec<_>>();

        self.logger.info_with_context(
            "agent::log_startup_key_file_statuses",
            "Broker-agent managed key file status at startup.",
            None,
            Some(json!({
                "mainConfigPath": self.runtime_config.broker.main_config_path,
                "dynsecStateFilePath": self.runtime_config.broker.dynsec_state_file_path,
                "keyFiles": key_files,
            })),
        );
    }

    pub fn read_current_broker_config(
        &self,
        correlation_id: Option<&str>,
    ) -> Result<String, AppError> {
        self.read_text_file(
            &self.runtime_config.broker.main_config_path,
            "agent::read_current_broker_config",
            "Failed reading broker config file.",
            "BROKER_CONFIG_INVALID",
            correlation_id,
        )
    }

    pub fn list_managed_key_files(
        &self,
        correlation_id: Option<&str>,
    ) -> Result<Vec<ManagedKeyFileStatus>, AppError> {
        let mut files = Vec::new();
        for file_id in ["caFile", "mosquittoPublicKey", "brokerPublicKey"] {
            let configured_path = self.managed_key_file_path(file_id, correlation_id)?;
            let exists = match configured_path.as_deref() {
                Some(file_path) => {
                    self.managed_key_file_exists(file_id, file_path, correlation_id)?
                }
                None => false,
            };

            files.push(ManagedKeyFileStatus {
                file_id: file_id.to_string(),
                path: configured_path.clone(),
                file_name: configured_path
                    .as_ref()
                    .and_then(|file_path| Path::new(file_path).file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_string),
                configured: configured_path.is_some(),
                exists,
            });
        }

        Ok(files)
    }

    pub fn read_managed_key_file(
        &self,
        file_id: &str,
        correlation_id: Option<&str>,
    ) -> Result<ManagedKeyFileDownload, AppError> {
        let file_path = self
            .managed_key_file_path(file_id, correlation_id)?
            .ok_or_else(|| {
                AppError::new(
                    "agent::read_managed_key_file",
                    &format!("Managed broker key file {file_id} is not configured."),
                    "BROKER_MANAGED_PATH_INVALID",
                    404,
                    correlation_id.map(str::to_string),
                    Some(json!({ "fileId": file_id })),
                )
            })?;

        let content = fs::read_to_string(&file_path).map_err(|error| {
            AppError::new(
                "agent::read_managed_key_file",
                &format!("Failed reading managed broker key file {file_id}."),
                "BROKER_CONFIG_INVALID",
                500,
                correlation_id.map(str::to_string),
                Some(json!({
                    "fileId": file_id,
                    "path": file_path,
                    "cause": error.to_string(),
                })),
            )
        })?;

        let file_name = Path::new(&file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(file_id)
            .to_string();

        Ok(ManagedKeyFileDownload {
            file_id: file_id.to_string(),
            path: file_path,
            file_name,
            content,
        })
    }

    pub async fn reload_broker(
        &self,
        correlation_id: Option<&str>,
    ) -> Result<OperationResult, AppError> {
        self.reload(correlation_id).await
    }

    pub async fn restart_broker(
        &self,
        correlation_id: Option<&str>,
    ) -> Result<OperationResult, AppError> {
        self.restart(correlation_id).await
    }

    pub fn write_broker_config(
        &self,
        rendered: &str,
        expected_current: Option<&str>,
        correlation_id: Option<&str>,
    ) -> Result<(), AppError> {
        if let Some(expected_current) = expected_current {
            let current = self.read_current_broker_config(correlation_id)?;
            if current != expected_current {
                return Err(AppError::new(
                    "agent::write_broker_config",
                    "Broker config changed since it was last pulled. Pull the latest broker config before pushing again.",
                    "BROKER_CONFIG_CONFLICT",
                    409,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": self.runtime_config.broker.main_config_path,
                        "expectedBytes": expected_current.len(),
                        "actualBytes": current.len(),
                    })),
                ));
            }
        }

        self.write_text_atomically(
            &self.runtime_config.broker.main_config_path,
            rendered,
            "agent::write_broker_config",
            "Broker config write failed.",
            "BROKER_CONFIG_INVALID",
            correlation_id,
        )
    }

    pub fn read_dynsec_state_file(&self, correlation_id: Option<&str>) -> Result<Value, AppError> {
        let text = fs::read_to_string(&self.runtime_config.broker.dynsec_state_file_path).map_err(
            |error| {
                AppError::new(
                    "agent::read_dynsec_state_file",
                    "Failed reading dynamic security state file.",
                    "DYNSEC_STATE_READ_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": self.runtime_config.broker.dynsec_state_file_path,
                        "cause": error.to_string(),
                    })),
                )
            },
        )?;

        serde_json::from_str(&text).map_err(|error| {
            AppError::new(
                "agent::read_dynsec_state_file",
                "Dynamic security state file is not valid JSON.",
                "DYNSEC_STATE_READ_FAILED",
                500,
                correlation_id.map(str::to_string),
                Some(json!({ "cause": error.to_string() })),
            )
        })
    }

    pub async fn run_dynsec_command(
        &self,
        command: &str,
        args: &[String],
        connection: &DynsecConnection,
        correlation_id: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        self.ensure_allowed_dynsec_command(command, correlation_id)?;
        self.validate_dynsec_connection(connection, correlation_id)?;

        let mut command_line = vec![
            String::from("mosquitto_ctrl"),
            String::from("-h"),
            connection.host.clone(),
            String::from("-p"),
            connection.port.to_string(),
            String::from("-u"),
            connection.username.clone(),
            String::from("-P"),
            connection.password.clone(),
            String::from("-i"),
            connection.client_id.clone(),
        ];
        let mut display_command = vec![
            String::from("mosquitto_ctrl"),
            String::from("-h"),
            connection.host.clone(),
            String::from("-p"),
            connection.port.to_string(),
            String::from("-u"),
            connection.username.clone(),
            String::from("-P"),
            String::from("<redacted>"),
            String::from("-i"),
            connection.client_id.clone(),
        ];

        if connection.tls.enabled {
            if let Some(ca_file) = &connection.tls.ca_file {
                command_line.push(String::from("--cafile"));
                command_line.push(ca_file.clone());
                display_command.push(String::from("--cafile"));
                display_command.push(ca_file.clone());
            }

            if let Some(cert_file) = &connection.tls.cert_file {
                command_line.push(String::from("--cert"));
                command_line.push(cert_file.clone());
                display_command.push(String::from("--cert"));
                display_command.push(cert_file.clone());
            }

            if let Some(key_file) = &connection.tls.key_file {
                command_line.push(String::from("--key"));
                command_line.push(key_file.clone());
                display_command.push(String::from("--key"));
                display_command.push(key_file.clone());
            }

            if connection.tls.insecure {
                command_line.push(String::from("--insecure"));
                display_command.push(String::from("--insecure"));
            }
        }

        command_line.push(String::from("dynsec"));
        command_line.push(command.to_string());
        display_command.push(String::from("dynsec"));
        display_command.push(command.to_string());

        command_line.extend(args.iter().cloned());
        display_command.extend(self.redact_dynsec_command_args(command, args));

        let result = self
            .supervisor
            .run_command_with_display_args(
                &command_line,
                &display_command,
                "agent::run_dynsec_command",
                "DYNSEC_OPERATION_FAILED",
                correlation_id,
            )
            .await?;

        if result.exit_code == Some(0) && meaningful_dynsec_stderr(&result.stderr).is_none() {
            self.logger.info(
                "agent::run_dynsec_command",
                &format!("Executed dynsec {}.", command),
                correlation_id,
            );
            return Ok(result);
        }

        Err(AppError::new(
            "agent::run_dynsec_command",
            &format!("mosquitto_ctrl dynsec {} failed.", command),
            "DYNSEC_OPERATION_FAILED",
            500,
            correlation_id.map(str::to_string),
            Some(json!(result)),
        ))
    }

    fn ensure_allowed_dynsec_command(
        &self,
        command: &str,
        correlation_id: Option<&str>,
    ) -> Result<(), AppError> {
        if ALLOWED_DYNSEC_COMMANDS.contains(&command) {
            return Ok(());
        }

        Err(AppError::new(
            "agent::ensure_allowed_dynsec_command",
            "Requested dynsec command is not allowed.",
            "INPUT_INVALID",
            400,
            correlation_id.map(str::to_string),
            Some(json!({ "command": command })),
        ))
    }

    fn validate_dynsec_connection(
        &self,
        connection: &DynsecConnection,
        correlation_id: Option<&str>,
    ) -> Result<(), AppError> {
        if connection.host.trim().is_empty()
            || connection.username.trim().is_empty()
            || connection.password.trim().is_empty()
            || connection.client_id.trim().is_empty()
            || connection.port == 0
        {
            return Err(AppError::new(
                "agent::validate_dynsec_connection",
                "Dynsec connection details are incomplete.",
                "INPUT_INVALID",
                400,
                correlation_id.map(str::to_string),
                Some(json!({
                    "host": connection.host,
                    "port": connection.port,
                    "username": connection.username,
                    "clientId": connection.client_id,
                })),
            ));
        }

        Ok(())
    }

    fn managed_key_file_path(
        &self,
        file_id: &str,
        correlation_id: Option<&str>,
    ) -> Result<Option<String>, AppError> {
        match file_id {
            "caFile" => Ok(self.runtime_config.broker.key_files.ca_file.clone()),
            "mosquittoPublicKey" => Ok(self
                .runtime_config
                .broker
                .key_files
                .mosquitto_public_key
                .clone()),
            "brokerPublicKey" => Ok(self
                .runtime_config
                .broker
                .key_files
                .broker_public_key
                .clone()),
            _ => Err(AppError::new(
                "agent::managed_key_file_path",
                "Requested managed broker key file is invalid.",
                "INPUT_INVALID",
                400,
                correlation_id.map(str::to_string),
                Some(json!({ "fileId": file_id })),
            )),
        }
    }

    fn managed_key_file_exists(
        &self,
        file_id: &str,
        file_path: &str,
        correlation_id: Option<&str>,
    ) -> Result<bool, AppError> {
        match fs::metadata(file_path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(AppError::new(
                "agent::managed_key_file_exists",
                &format!("Failed checking managed broker key file {file_id}."),
                "BROKER_CONFIG_INVALID",
                500,
                correlation_id.map(str::to_string),
                Some(json!({
                    "fileId": file_id,
                    "path": file_path,
                    "cause": error.to_string(),
                })),
            )),
        }
    }

    fn redact_dynsec_command_args(&self, command: &str, args: &[String]) -> Vec<String> {
        if command == "setClientPassword" && args.len() >= 2 {
            let mut redacted = args.to_vec();
            redacted[1] = String::from("<redacted>");
            return redacted;
        }

        args.to_vec()
    }

    fn read_text_file(
        &self,
        file_path: &str,
        caller: &str,
        reason: &str,
        error_key: &str,
        correlation_id: Option<&str>,
    ) -> Result<String, AppError> {
        match fs::read_to_string(file_path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(AppError::new(
                caller,
                reason,
                error_key,
                500,
                correlation_id.map(str::to_string),
                Some(json!({
                    "path": file_path,
                    "cause": error.to_string(),
                })),
            )),
        }
    }

    fn write_text_atomically(
        &self,
        file_path: &str,
        rendered: &str,
        caller: &str,
        reason: &str,
        error_key: &str,
        correlation_id: Option<&str>,
    ) -> Result<(), AppError> {
        let target_path = Path::new(file_path);
        let temp_path = target_path.with_extension("tmp");
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppError::new(
                    caller,
                    reason,
                    error_key,
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": file_path,
                        "cause": error.to_string(),
                    })),
                )
            })?;
        }

        let atomic_write_result = (|| -> Result<(), std::io::Error> {
            fs::write(&temp_path, rendered)?;
            fs::rename(&temp_path, target_path)?;
            Ok(())
        })();

        if let Err(primary_error) = atomic_write_result {
            let _ = fs::remove_file(&temp_path);
            let file_result = OpenOptions::new()
                .write(true)
                .truncate(false)
                .open(target_path)
                .or_else(|open_error| {
                    if open_error.kind() == std::io::ErrorKind::NotFound {
                        OpenOptions::new()
                            .write(true)
                            .create(true)
                            .truncate(false)
                            .open(target_path)
                    } else {
                        Err(open_error)
                    }
                });
            let mut file = file_result.map_err(|fallback_error| {
                AppError::new(
                    caller,
                    reason,
                    error_key,
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": file_path,
                        "cause": fallback_error.to_string(),
                        "atomicCause": primary_error.to_string(),
                    })),
                )
            })?;

            file.seek(SeekFrom::Start(0)).map_err(|fallback_error| {
                AppError::new(
                    caller,
                    reason,
                    error_key,
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": file_path,
                        "cause": fallback_error.to_string(),
                        "atomicCause": primary_error.to_string(),
                    })),
                )
            })?;

            file.write_all(rendered.as_bytes())
                .map_err(|fallback_error| {
                    AppError::new(
                        caller,
                        reason,
                        error_key,
                        500,
                        correlation_id.map(str::to_string),
                        Some(json!({
                            "path": file_path,
                            "cause": fallback_error.to_string(),
                            "atomicCause": primary_error.to_string(),
                        })),
                    )
                })?;

            file.set_len(rendered.len() as u64)
                .map_err(|fallback_error| {
                    AppError::new(
                        caller,
                        reason,
                        error_key,
                        500,
                        correlation_id.map(str::to_string),
                        Some(json!({
                            "path": file_path,
                            "cause": fallback_error.to_string(),
                            "atomicCause": primary_error.to_string(),
                        })),
                    )
                })?;

            file.flush().map_err(|fallback_error| {
                AppError::new(
                    caller,
                    reason,
                    error_key,
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": file_path,
                        "cause": fallback_error.to_string(),
                        "atomicCause": primary_error.to_string(),
                    })),
                )
            })?;
        }

        Ok(())
    }

    async fn reload(&self, correlation_id: Option<&str>) -> Result<OperationResult, AppError> {
        let result = self.supervisor.reload(correlation_id).await?;
        Ok(operation_result(
            "success",
            "reload completed.",
            Some(result),
        ))
    }

    async fn restart(&self, correlation_id: Option<&str>) -> Result<OperationResult, AppError> {
        let result = self.supervisor.restart(correlation_id).await?;
        Ok(operation_result(
            "success",
            "restart completed.",
            Some(result),
        ))
    }
}

fn operation_result(status: &str, message: &str, result: Option<CommandResult>) -> OperationResult {
    OperationResult {
        status: status.to_string(),
        message: Some(message.to_string()),
        result: result.map(|value| json!(value)),
    }
}

fn meaningful_dynsec_stderr(stderr: &str) -> Option<String> {
    const BENIGN_LINES: &[&str] = &[
        "Warning: You are running mosquitto_ctrl without encryption.",
        "This means all of the configuration changes you are making are visible on the network, including passwords.",
    ];

    let meaningful_lines = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !BENIGN_LINES.contains(line))
        .map(str::to_string)
        .collect::<Vec<_>>();

    if meaningful_lines.is_empty() {
        None
    } else {
        Some(meaningful_lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::meaningful_dynsec_stderr;

    #[test]
    fn ignores_plaintext_warning_only_stderr() {
        let stderr = "Warning: You are running mosquitto_ctrl without encryption.\nThis means all of the configuration changes you are making are visible on the network, including passwords.\n";

        assert_eq!(meaningful_dynsec_stderr(stderr), None);
    }

    #[test]
    fn keeps_real_dynsec_errors_from_stderr() {
        let stderr = "Warning: You are running mosquitto_ctrl without encryption.\nThis means all of the configuration changes you are making are visible on the network, including passwords.\n\nConnection error: Not authorized\n";

        assert_eq!(
            meaningful_dynsec_stderr(stderr),
            Some(String::from("Connection error: Not authorized"))
        );
    }
}
