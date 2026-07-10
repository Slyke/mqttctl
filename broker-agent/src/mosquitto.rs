use std::{fs, path::Path, process::Stdio, sync::Arc, time::Duration};

use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};
use serde::Serialize;
use serde_json::json;
use tokio::{
    process::{Child, Command},
    sync::Mutex,
    time::timeout,
};

use crate::{config::BrokerConfig, errors::AppError, logging::Logger};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub executable: String,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerHealth {
    pub broker_running: bool,
    pub broker_pid: Option<u32>,
}

pub struct MosquittoSupervisor {
    config: BrokerConfig,
    logger: Logger,
    child: Mutex<Option<Child>>,
}

impl MosquittoSupervisor {
    pub fn new(config: BrokerConfig, logger: Logger) -> Arc<Self> {
        Arc::new(Self {
            config,
            logger,
            child: Mutex::new(None),
        })
    }

    pub async fn start(&self, correlation_id: Option<&str>) -> Result<(), AppError> {
        let mut child_guard = self.child.lock().await;
        if self
            .ensure_child_state(&mut child_guard, correlation_id)
            .await?
            .is_some()
        {
            return Ok(());
        }

        self.ensure_dynsec_state(correlation_id).await?;
        let spawned = self.spawn_child(correlation_id)?;
        let pid = spawned.id();
        *child_guard = Some(spawned);
        self.logger.info(
            "mosquitto::start",
            &format!("Started Mosquitto broker with pid {:?}.", pid),
            correlation_id,
        );
        Ok(())
    }

    async fn ensure_dynsec_state(&self, correlation_id: Option<&str>) -> Result<(), AppError> {
        let state_path = Path::new(&self.config.dynsec_state_file_path);

        match fs::metadata(state_path) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => return Ok(()),
            Ok(metadata) if metadata.is_dir() => {
                return Err(AppError::new(
                    "mosquitto::ensure_dynsec_state",
                    "Dynamic security state path points to a directory.",
                    "CONFIG_VALIDATION_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({ "path": self.config.dynsec_state_file_path })),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AppError::new(
                    "mosquitto::ensure_dynsec_state",
                    "Failed reading dynamic security state file metadata.",
                    "DYNSEC_STATE_READ_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": self.config.dynsec_state_file_path,
                        "cause": error.to_string(),
                    })),
                ));
            }
        }

        let bootstrap = self.config.dynsec_bootstrap.as_ref().ok_or_else(|| {
            AppError::new(
                "mosquitto::ensure_dynsec_state",
                "Dynamic security state file is missing and broker.dynsecBootstrap is not configured.",
                "CONFIG_VALIDATION_FAILED",
                500,
                correlation_id.map(str::to_string),
                Some(json!({
                    "path": self.config.dynsec_state_file_path,
                })),
            )
        })?;

        if let Some(parent) = state_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppError::new(
                    "mosquitto::ensure_dynsec_state",
                    "Failed creating the dynamic security state directory.",
                    "BROKER_PROCESS_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "path": parent,
                        "cause": error.to_string(),
                    })),
                )
            })?;
        }

        let args = vec![
            String::from("dynsec"),
            String::from("init"),
            self.config.dynsec_state_file_path.clone(),
            bootstrap.username.clone(),
            bootstrap.password.clone(),
        ];
        let redacted_args = vec![
            String::from("dynsec"),
            String::from("init"),
            self.config.dynsec_state_file_path.clone(),
            bootstrap.username.clone(),
            String::from("<redacted>"),
        ];
        let output = Command::new("mosquitto_ctrl")
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| {
                AppError::new(
                    "mosquitto::ensure_dynsec_state",
                    "Failed starting mosquitto_ctrl to initialize the dynamic security state file.",
                    "BROKER_PROCESS_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "args": redacted_args,
                        "cause": error.to_string(),
                    })),
                )
            })?;

        let result = CommandResult {
            executable: String::from("mosquitto_ctrl"),
            args: redacted_args,
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        };

        if result.exit_code != Some(0) {
            return Err(AppError::new(
                "mosquitto::ensure_dynsec_state",
                "Failed initializing the dynamic security state file.",
                "BROKER_PROCESS_FAILED",
                500,
                correlation_id.map(str::to_string),
                Some(json!(result)),
            ));
        }

        self.logger.info(
            "mosquitto::ensure_dynsec_state",
            "Initialized dynamic security state file.",
            correlation_id,
        );

        Ok(())
    }

    pub async fn health(&self, correlation_id: Option<&str>) -> Result<BrokerHealth, AppError> {
        let mut child_guard = self.child.lock().await;
        let child = self
            .ensure_child_state(&mut child_guard, correlation_id)
            .await?;
        Ok(BrokerHealth {
            broker_running: child.is_some(),
            broker_pid: child.and_then(|process| process.id()),
        })
    }

    pub async fn mqtt_server_version(
        &self,
        correlation_id: Option<&str>,
    ) -> Result<Option<String>, AppError> {
        let executable = self.config.command.first().ok_or_else(|| {
            AppError::new(
                "mosquitto::mqtt_server_version",
                "Broker command is empty.",
                "CONFIG_VALIDATION_FAILED",
                500,
                correlation_id.map(str::to_string),
                None,
            )
        })?;
        let output = Command::new(executable)
            .arg("-h")
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| {
                AppError::new(
                    "mosquitto::mqtt_server_version",
                    "Failed starting Mosquitto to inspect its version.",
                    "BROKER_PROCESS_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "executable": executable,
                        "args": ["-h"],
                        "cause": error.to_string(),
                    })),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}\n{stderr}");

        Ok(parse_mosquitto_version(&combined))
    }

    pub async fn reload(&self, correlation_id: Option<&str>) -> Result<CommandResult, AppError> {
        let pid = {
            let mut child_guard = self.child.lock().await;
            let child = self
                .ensure_child_state(&mut child_guard, correlation_id)
                .await?;
            child.and_then(|process| process.id()).ok_or_else(|| {
                AppError::new(
                    "mosquitto::reload",
                    "Mosquitto is not running.",
                    "BROKER_RELOAD_FAILED",
                    503,
                    correlation_id.map(str::to_string),
                    None,
                )
            })?
        };

        self.send_signal(
            pid,
            Signal::SIGHUP,
            "mosquitto::reload",
            "BROKER_RELOAD_FAILED",
            correlation_id,
        )
        .await
    }

    pub async fn restart(&self, correlation_id: Option<&str>) -> Result<CommandResult, AppError> {
        let mut child_guard = self.child.lock().await;
        let maybe_child = child_guard.take();
        let mut last_result = None;

        if let Some(mut child) = maybe_child {
            if let Some(pid) = child.id() {
                last_result = Some(
                    self.send_signal(
                        pid,
                        Signal::SIGTERM,
                        "mosquitto::restart",
                        "BROKER_RESTART_FAILED",
                        correlation_id,
                    )
                    .await?,
                );
            }

            match timeout(Duration::from_secs(10), child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    return Err(AppError::new(
                        "mosquitto::restart",
                        "Failed waiting for Mosquitto during restart.",
                        "BROKER_RESTART_FAILED",
                        500,
                        correlation_id.map(str::to_string),
                        Some(json!({ "cause": error.to_string() })),
                    ));
                }
                Err(_) => {
                    child.kill().await.map_err(|error| {
                        AppError::new(
                            "mosquitto::restart",
                            "Failed forcing Mosquitto to stop during restart.",
                            "BROKER_RESTART_FAILED",
                            500,
                            correlation_id.map(str::to_string),
                            Some(json!({ "cause": error.to_string() })),
                        )
                    })?;
                    let _ = child.wait().await;
                }
            }
        }

        let spawned = self.spawn_child(correlation_id)?;
        *child_guard = Some(spawned);

        Ok(last_result.unwrap_or(CommandResult {
            executable: String::from("mosquitto"),
            args: Vec::new(),
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        }))
    }

    pub async fn shutdown(&self, correlation_id: Option<&str>) -> Result<(), AppError> {
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            if let Some(pid) = child.id() {
                let _ = self
                    .send_signal(
                        pid,
                        Signal::SIGTERM,
                        "mosquitto::shutdown",
                        "BROKER_RESTART_FAILED",
                        correlation_id,
                    )
                    .await;
            }
            let _ = timeout(Duration::from_secs(10), child.wait()).await;
        }
        Ok(())
    }

    pub async fn run_command(
        &self,
        command: &[String],
        caller: &str,
        error_key: &str,
        correlation_id: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        self.run_command_with_display_args(command, command, caller, error_key, correlation_id)
            .await
    }

    pub async fn run_command_with_display_args(
        &self,
        command: &[String],
        display_command: &[String],
        caller: &str,
        error_key: &str,
        correlation_id: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        let (executable, args) = split_command(command, caller, error_key, correlation_id)?;
        let (display_executable, display_args) =
            split_command(display_command, caller, error_key, correlation_id)?;
        let output = Command::new(&executable)
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|error| {
                AppError::new(
                    caller,
                    &format!("Failed spawning {}.", executable),
                    error_key,
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "args": display_args,
                        "cause": error.to_string(),
                    })),
                )
            })?;

        Ok(CommandResult {
            executable: display_executable,
            args: display_args,
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }

    async fn ensure_child_state<'a>(
        &self,
        child_guard: &'a mut Option<Child>,
        correlation_id: Option<&str>,
    ) -> Result<Option<&'a mut Child>, AppError> {
        if let Some(child) = child_guard.as_mut() {
            match child.try_wait().map_err(|error| {
                AppError::new(
                    "mosquitto::ensure_child_state",
                    "Failed checking Mosquitto process state.",
                    "BROKER_PROCESS_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({ "cause": error.to_string() })),
                )
            })? {
                Some(status) => {
                    self.logger.warn(
                        "mosquitto::ensure_child_state",
                        "Mosquitto process is no longer running.",
                        correlation_id,
                        Some(json!({ "status": status.code() })),
                    );
                    *child_guard = None;
                    Ok(None)
                }
                None => Ok(child_guard.as_mut()),
            }
        } else {
            Ok(None)
        }
    }

    fn spawn_child(&self, correlation_id: Option<&str>) -> Result<Child, AppError> {
        let (executable, args) = split_command(
            &self.config.command,
            "mosquitto::spawn_child",
            "BROKER_PROCESS_FAILED",
            correlation_id,
        )?;

        Command::new(&executable)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(false)
            .spawn()
            .map_err(|error| {
                AppError::new(
                    "mosquitto::spawn_child",
                    "Failed starting Mosquitto broker.",
                    "BROKER_PROCESS_FAILED",
                    500,
                    correlation_id.map(str::to_string),
                    Some(json!({
                        "executable": executable,
                        "args": args,
                        "cause": error.to_string(),
                    })),
                )
            })
    }

    async fn send_signal(
        &self,
        pid: u32,
        signal: Signal,
        caller: &str,
        error_key: &str,
        correlation_id: Option<&str>,
    ) -> Result<CommandResult, AppError> {
        kill(Pid::from_raw(pid as i32), signal).map_err(|error| {
            AppError::new(
                caller,
                "Failed signaling Mosquitto.",
                error_key,
                500,
                correlation_id.map(str::to_string),
                Some(json!({
                    "pid": pid,
                    "signal": format!("{signal:?}"),
                    "cause": error.to_string(),
                })),
            )
        })?;

        Ok(CommandResult {
            executable: String::from("signal"),
            args: vec![format!("{signal:?}"), pid.to_string()],
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        })
    }
}

fn parse_mosquitto_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let version = trimmed.strip_prefix("mosquitto version ")?;
        version.split_whitespace().next().map(str::to_string)
    })
}

fn split_command(
    command: &[String],
    caller: &str,
    error_key: &str,
    correlation_id: Option<&str>,
) -> Result<(String, Vec<String>), AppError> {
    let executable = command.first().cloned().ok_or_else(|| {
        AppError::new(
            caller,
            "Command array is empty.",
            error_key,
            500,
            correlation_id.map(str::to_string),
            None,
        )
    })?;

    Ok((executable, command.iter().skip(1).cloned().collect()))
}
