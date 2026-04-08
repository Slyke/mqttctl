use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    let version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| String::from("0.0.0"));
    let git_dir = resolve_git_dir(env::current_dir().ok().as_deref());
    register_git_rerun_paths(git_dir.as_deref());

    let commit_hash = git_dir
        .as_deref()
        .and_then(resolve_head_commit)
        .unwrap_or_else(|| String::from("unknown"));
    let label = format!("v{version}-{commit_hash}");

    println!("cargo:rustc-env=MQTTCTL_BUILD_VERSION={version}");
    println!("cargo:rustc-env=MQTTCTL_BUILD_COMMIT_HASH={commit_hash}");
    println!("cargo:rustc-env=MQTTCTL_BUILD_LABEL={label}");
}

fn resolve_git_dir(start_dir: Option<&Path>) -> Option<PathBuf> {
    let mut current_dir = start_dir?.to_path_buf();

    loop {
        let git_path = current_dir.join(".git");
        if git_path.exists() {
            if git_path.is_dir() {
                return Some(git_path);
            }

            if let Ok(contents) = fs::read_to_string(&git_path) {
                if let Some(configured_path) = contents.trim().strip_prefix("gitdir:") {
                    return Some(current_dir.join(configured_path.trim()));
                }
            }
        }

        if !current_dir.pop() {
            return None;
        }
    }
}

fn resolve_head_commit(git_dir: &Path) -> Option<String> {
    let head_path = git_dir.join("HEAD");
    let head_contents = fs::read_to_string(head_path).ok()?;
    let head = head_contents.trim();

    if !head.starts_with("ref:") {
        return Some(head.chars().take(7).collect());
    }

    let reference = head.strip_prefix("ref:")?.trim();
    let reference_path = git_dir.join(reference);
    if reference_path.exists() {
        let commit = fs::read_to_string(reference_path).ok()?;
        return Some(commit.trim().chars().take(7).collect());
    }

    let packed_refs = fs::read_to_string(git_dir.join("packed-refs")).ok()?;
    for line in packed_refs.lines() {
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }

        let mut parts = line.split_whitespace();
        let commit = parts.next()?;
        let packed_reference = parts.next()?;
        if packed_reference == reference {
            return Some(commit.chars().take(7).collect());
        }
    }

    None
}

fn register_git_rerun_paths(git_dir: Option<&Path>) {
    let Some(git_dir) = git_dir else {
        return;
    };

    let head_path = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head_path.display());

    if let Ok(head_contents) = fs::read_to_string(&head_path) {
        if let Some(reference) = head_contents.trim().strip_prefix("ref:") {
            println!(
                "cargo:rerun-if-changed={}",
                git_dir.join(reference.trim()).display()
            );
        }
    }

    let packed_refs_path = git_dir.join("packed-refs");
    println!("cargo:rerun-if-changed={}", packed_refs_path.display());
}
