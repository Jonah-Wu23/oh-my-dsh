use std::fs::File;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zip::ZipArchive;

const WEB_STARTUP_TIMEOUT_SECS: u64 = 120;

struct WebProcess(Mutex<Option<Child>>);

impl Drop for WebProcess {
    fn drop(&mut self) {
        if let Ok(mut process) = self.0.lock() {
            if let Some(child) = process.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct BundleStatus {
    resource_dir: String,
    node: bool,
    harness: bool,
    oh_my_dsh: bool,
    msys2_bash: bool,
}

#[derive(Debug, Serialize)]
struct WebLaunch {
    url: String,
    pid: u32,
}

fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|error| format!("cannot resolve bundled resource directory: {error}"))
}

fn canonical_path(path: PathBuf, label: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(&path)
        .map_err(|error| format!("cannot resolve {label} path {}: {error}", path.display()))
}

fn node_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    let value = value.strip_prefix("\\\\?\\").unwrap_or(&value);
    value.replace('\\', "/")
}

fn bundled_paths(
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let root = canonical_path(resource_dir(app)?, "bundled resource root")?;
    Ok((
        root.join("node.exe"),
        root.join("deepseek-harness")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
        root.join("oh-my-dsh"),
        root.join("msys64.zip"),
        root.join("deepseek-harness").join("web-profile-patch.yml"),
    ))
}

fn materialize_msys2(app: &AppHandle, archive_path: &Path) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve application data directory: {error}"))?;
    let destination = app_data.join("msys64");
    let bash_path = destination.join("usr").join("bin").join("bash.exe");
    if bash_path.is_file() {
        return Ok(bash_path);
    }

    if !archive_path.is_file() {
        return Err("the bundled MSYS2 archive is missing".to_string());
    }
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("cannot create application data directory: {error}"))?;
    let staging = app_data.join("msys64.staging");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|error| format!("cannot remove incomplete MSYS2 staging: {error}"))?;
    }
    {
        let archive = File::open(archive_path)
            .map_err(|error| format!("cannot open bundled MSYS2 archive: {error}"))?;
        let mut archive = ZipArchive::new(archive)
            .map_err(|error| format!("cannot read bundled MSYS2 archive: {error}"))?;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("cannot inspect bundled MSYS2 archive: {error}"))?;
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| "bundled MSYS2 archive contains an invalid path".to_string())?
                .to_owned();
            let target = staging.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|error| format!("cannot create MSYS2 directory: {error}"))?;
            } else {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| format!("cannot create MSYS2 parent directory: {error}"))?;
                }
                let mut output = File::create(&target)
                    .map_err(|error| format!("cannot create MSYS2 file: {error}"))?;
                std::io::copy(&mut entry, &mut output)
                    .map_err(|error| format!("cannot extract MSYS2 file: {error}"))?;
            }
        }
    }
    let staged_bash = staging.join("usr").join("bin").join("bash.exe");
    if !staged_bash.is_file() {
        return Err("the bundled MSYS2 archive does not contain Bash".to_string());
    }
    if destination.exists() {
        std::fs::remove_dir_all(&destination)
            .map_err(|error| format!("cannot replace incomplete MSYS2 runtime: {error}"))?;
    }
    std::fs::rename(&staging, &destination)
        .map_err(|error| format!("cannot install MSYS2 runtime: {error}"))?;
    Ok(bash_path)
}

fn ensure_web_bundle(
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let (node, harness, oh_my_dsh, msys2_root, web_patch) = bundled_paths(app)?;
    let msys2_bash = materialize_msys2(app, &msys2_root)?;
    let patch = oh_my_dsh.join("preset").join("agent.cordis.yml");
    if !node.is_file()
        || !harness.is_file()
        || !patch.is_file()
        || !msys2_bash.is_file()
        || !web_patch.is_file()
    {
        return Err(
            "the bundled Node, Harness, oh-my-dsh preset, or MSYS2 Bash is missing".to_string(),
        );
    }
    Ok((node, harness, oh_my_dsh, msys2_bash, web_patch))
}

fn copy_directory_contents(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("cannot create bundled preset directory: {error}"))?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("cannot read bundled preset directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("cannot inspect bundled preset entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect bundled preset entry type: {error}"))?;
        if file_type.is_dir() {
            copy_directory_contents(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("cannot copy bundled preset file: {error}"))?;
        }
    }
    Ok(())
}

fn choose_web_port(preferred: u16) -> u16 {
    for offset in 0..=20u16 {
        let Some(candidate) = preferred.checked_add(offset) else {
            break;
        };
        if TcpListener::bind(("127.0.0.1", candidate)).is_ok() {
            return candidate;
        }
    }
    preferred
}

#[tauri::command]
fn bundle_status(app: AppHandle) -> Result<BundleStatus, String> {
    let root = resource_dir(&app)?;
    let (node, harness, oh_my_dsh, msys2_root, _) = bundled_paths(&app)?;
    Ok(BundleStatus {
        resource_dir: root.display().to_string(),
        node: node.is_file(),
        harness: harness.is_file(),
        oh_my_dsh: oh_my_dsh.join("preset").is_dir(),
        msys2_bash: msys2_root.is_file(),
    })
}

#[tauri::command]
fn start_web(
    app: AppHandle,
    process: State<'_, WebProcess>,
    workspace: String,
    port: Option<u16>,
) -> Result<WebLaunch, String> {
    let workspace_path = canonical_path(Path::new(&workspace).to_path_buf(), "workspace")?;
    let preferred_port = port.unwrap_or(3080);
    if preferred_port == 0 {
        return Err("port must be between 1 and 65535".to_string());
    }
    let port = choose_web_port(preferred_port);

    let mut process = process
        .0
        .lock()
        .map_err(|_| "the bundled WebUI process lock is poisoned".to_string())?;
    if let Some(child) = process.as_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("cannot inspect the bundled WebUI process: {error}"))?
            .is_none()
        {
            return Ok(WebLaunch {
                url: format!("http://127.0.0.1:{port}"),
                pid: child.id(),
            });
        }
    }
    *process = None;

    let (node, harness, oh_my_dsh, msys2_bash, web_patch) = ensure_web_bundle(&app)?;

    let dsh_home = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve application data directory: {error}"))?
        .join("dsh-home");
    std::fs::create_dir_all(&dsh_home)
        .map_err(|error| format!("cannot create DSH_HOME: {error}"))?;
    copy_directory_contents(
        &oh_my_dsh.join("preset"),
        &dsh_home.join(".agent-presets").join("oh-my-dsh"),
    )?;

    let mut child = Command::new(&node)
        .current_dir(&workspace_path)
        .arg(node_path(&harness))
        .arg("web")
        .arg("--patch")
        .arg(node_path(&web_patch))
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .env("DSH_HOME", &dsh_home)
        .env("DSH_CWD", node_path(&workspace_path))
        .env("DSH_MSYS2_BASH", node_path(&msys2_bash))
        .env("DSH_ROUTER_PROVIDER", "deepseek-official")
        .env("DSH_ROUTER_MODEL", "deepseek-v4-flash")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start bundled DeepSeek Harness: {error}"))?;

    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while stdout.read(&mut buffer).unwrap_or(0) > 0 {}
        });
    }
    let stderr_output = Arc::new(Mutex::new(String::new()));
    let stderr_capture = Arc::clone(&stderr_output);
    let mut stderr_drain = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let read = stderr.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    break;
                }
                if let Ok(mut output) = stderr_capture.lock() {
                    let remaining = (16 * 1024usize).saturating_sub(output.len());
                    if remaining > 0 {
                        let count = read.min(remaining);
                        output.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    }
                }
            }
        })
    });

    let deadline = Instant::now() + Duration::from_secs(WEB_STARTUP_TIMEOUT_SECS);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("cannot inspect the bundled WebUI process: {error}"))?
        {
            if let Some(drain) = stderr_drain.take() {
                let _ = drain.join();
            }
            let detail = stderr_output
                .lock()
                .map(|output| output.trim().to_string())
                .unwrap_or_default();
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            return Err(format!(
                "DeepSeek Harness WebUI exited before listening on port {port} ({status}){suffix}"
            ));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(drain) = stderr_drain.take() {
                let _ = drain.join();
            }
            let detail = stderr_output
                .lock()
                .map(|output| output.trim().to_string())
                .unwrap_or_default();
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            };
            return Err(format!(
                "DeepSeek Harness WebUI did not listen on port {port} within {WEB_STARTUP_TIMEOUT_SECS} seconds{suffix}"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let url = format!("http://127.0.0.1:{port}");

    let pid = child.id();
    *process = Some(child);

    Ok(WebLaunch { url, pid })
}

pub fn run() {
    tauri::Builder::default()
        .manage(WebProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![bundle_status, start_web])
        .run(tauri::generate_context!())
        .expect("error while running oh-my-dsh desktop");
}
