use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Logger {
    json: bool,
    kubernetes: Option<Value>,
}

impl Logger {
    pub fn from_env() -> Self {
        Self {
            json: matches!(
                std::env::var("MQTTCTL_LOG_CONSOLE_FORMAT").ok().as_deref(),
                Some("json")
            ),
            kubernetes: resolve_kubernetes_metadata_from_env(),
        }
    }

    fn emit(
        &self,
        level: &str,
        caller: &str,
        message: &str,
        correlation_id: Option<&str>,
        context: Option<Value>,
    ) {
        let timestamp = chrono_like_now();
        if self.json {
            let mut entry = json!({
                "timestamp": timestamp,
                "level": level,
                "caller": caller,
                "message": message,
                "correlationId": correlation_id,
                "context": context,
            });

            if let Some(kubernetes) = &self.kubernetes {
                entry["kubernetes"] = kubernetes.clone();
            }

            println!("{}", entry);
            return;
        }

        let correlation = correlation_id
            .map(|value| format!(" [{value}]"))
            .unwrap_or_default();
        let context_text = context
            .map(|value| format!(" | context={value}"))
            .unwrap_or_default();
        let kubernetes_text = self
            .kubernetes
            .as_ref()
            .map(|value| format!(" | kubernetes={value}"))
            .unwrap_or_default();

        println!(
            "[{timestamp}] {level} {caller}{correlation} {message}{context_text}{kubernetes_text}"
        );
    }

    pub fn info(&self, caller: &str, message: &str, correlation_id: Option<&str>) {
        self.emit("INFO", caller, message, correlation_id, None);
    }

    pub fn info_with_context(
        &self,
        caller: &str,
        message: &str,
        correlation_id: Option<&str>,
        context: Option<Value>,
    ) {
        self.emit("INFO", caller, message, correlation_id, context);
    }

    pub fn warn(
        &self,
        caller: &str,
        message: &str,
        correlation_id: Option<&str>,
        context: Option<Value>,
    ) {
        self.emit("WARN", caller, message, correlation_id, context);
    }

    pub fn error(
        &self,
        caller: &str,
        message: &str,
        correlation_id: Option<&str>,
        context: Option<Value>,
    ) {
        self.emit("ERROR", caller, message, correlation_id, context);
    }
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}", duration.as_secs()),
        Err(_) => String::from("0"),
    }
}

fn parse_bool_env(names: &[&str], fallback: bool) -> bool {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            return value == "true";
        }
    }

    fallback
}

fn resolve_kubernetes_metadata_from_env() -> Option<Value> {
    resolve_kubernetes_metadata_from_values(
        parse_bool_env(
            &["MQTTCTL_LOG_K8S_METADATA_ENABLED", "LOG_K8S_METADATA_ENABLED"],
            false,
        ),
        std::env::var("K8S_POD_NAME").ok(),
        std::env::var("K8S_DEPLOYMENT").ok(),
        std::env::var("K8S_NAMESPACE").ok(),
        std::env::var("K8S_POD_IP").ok(),
        std::env::var("K8S_POD_IPS").ok(),
        std::env::var("K8S_NODE_NAME").ok(),
    )
}

fn resolve_kubernetes_metadata_from_values(
    enabled: bool,
    pod_name: Option<String>,
    deployment: Option<String>,
    namespace: Option<String>,
    pod_ip: Option<String>,
    pod_ips: Option<String>,
    node_name: Option<String>,
) -> Option<Value> {
    if !enabled {
        return None;
    }

    let mut metadata = serde_json::Map::new();

    for (key, value) in [
        ("podName", pod_name),
        ("deployment", deployment),
        ("namespace", namespace),
        ("podIp", pod_ip),
        ("podIps", pod_ips),
        ("nodeName", node_name),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            metadata.insert(key.to_string(), Value::String(value));
        }
    }

    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_kubernetes_metadata_from_values;
    use serde_json::json;

    #[test]
    fn skips_metadata_when_disabled() {
        assert_eq!(
            resolve_kubernetes_metadata_from_values(
                false,
                Some(String::from("pod-a")),
                Some(String::from("deploy-a")),
                Some(String::from("default")),
                Some(String::from("10.0.0.1")),
                Some(String::from("10.0.0.1,10.0.0.2")),
                Some(String::from("node-a"))
            ),
            None
        );
    }

    #[test]
    fn keeps_only_non_empty_metadata_values() {
        assert_eq!(
            resolve_kubernetes_metadata_from_values(
                true,
                Some(String::from("pod-a")),
                Some(String::new()),
                Some(String::from("default")),
                None,
                Some(String::from("10.0.0.1,10.0.0.2")),
                Some(String::from("node-a"))
            ),
            Some(json!({
                "podName": "pod-a",
                "namespace": "default",
                "podIps": "10.0.0.1,10.0.0.2",
                "nodeName": "node-a"
            }))
        );
    }
}
