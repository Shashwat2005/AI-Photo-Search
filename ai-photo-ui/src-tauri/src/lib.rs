use base64::Engine;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve repository root".to_string())
}

fn assets_root() -> Result<PathBuf, String> {
    let root = repo_root()?;
    Ok(root.join("ai-photo-ui").join("src-tauri").join("assets").join("images"))
}

fn python_candidates(root: &Path) -> Vec<String> {
    let mut candidates = Vec::new();

    let venv_python = root.join("venv").join("Scripts").join("python.exe");
    if venv_python.exists() {
        candidates.push(venv_python.to_string_lossy().to_string());
    }

    candidates.push("python".to_string());
    candidates.push("py".to_string());

    candidates
}

fn extract_error_message(parsed: &Value, fallback: &str) -> String {
    parsed
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn run_engine(command: &str, folder: &str, query: Option<&str>) -> Result<Value, String> {
    let root = repo_root()?;
    let engine_script = root.join("engine.py");

    if !engine_script.exists() {
        return Err(format!("engine.py not found at {}", engine_script.display()));
    }

    let mut last_error = "Unable to run Python interpreter".to_string();

    for python_cmd in python_candidates(&root) {
        let mut cmd = Command::new(&python_cmd);
        cmd.current_dir(&root)
            .arg(&engine_script)
            .arg(command)
            .arg(folder);

        if let Some(q) = query {
            cmd.arg(q);
        }

        let output = match cmd.output() {
            Ok(out) => out,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
                last_error = format!("Failed to start Python ({}): {}", python_cmd, err);
                continue;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let payload = if stdout.is_empty() {
            stderr.as_str()
        } else {
            stdout.as_str()
        };

        let parsed = serde_json::from_str::<Value>(payload).unwrap_or_else(|_| {
            serde_json::json!({
                "status": "error",
                "message": if payload.is_empty() {
                    "Engine returned empty output"
                } else {
                    payload
                }
            })
        });

        if output.status.success() {
            return Ok(parsed);
        }

        let fallback = if stderr.is_empty() {
            "Engine command failed"
        } else {
            stderr.as_str()
        };
        return Err(extract_error_message(&parsed, fallback));
    }

    Err(last_error)
}

#[tauri::command]
fn engine_index(folder: String) -> Result<Value, String> {
    run_engine("index", &folder, None)
}

#[tauri::command]
fn engine_search(folder: String, query: String) -> Result<Value, String> {
    run_engine("search", &folder, Some(&query))
}

#[tauri::command]
fn get_image_uri(relative_path: String) -> Result<String, String> {
    let assets = assets_root()?;
    let full_path = assets.join(&relative_path);
    
    // Normalize path and convert to file:// URI
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("Path not found: {}", e))?;
    
    let uri = format!("file:///{}", canonical.to_string_lossy().replace("\\", "/"));
    Ok(uri)
}

#[tauri::command]
fn thumbnail_data_uri(path: String) -> Result<String, String> {
    let full_path = PathBuf::from(path);
    if !full_path.exists() {
        return Err("Thumbnail not found on disk".to_string());
    }

    let bytes = fs::read(&full_path)
        .map_err(|e| format!("Failed to read thumbnail: {}", e))?;

    let mime = match full_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            engine_index,
            engine_search,
            get_image_uri,
            thumbnail_data_uri
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
