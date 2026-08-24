use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use exif::{In, Tag};
use tauri::Emitter;

const MAX_SEARCH_CACHE_ENTRIES: usize = 200;

// ---- Daemon globals ----
struct DaemonIO {
    stdin: BufWriter<std::process::ChildStdin>,
    stdout: BufReader<std::process::ChildStdout>,
}

struct PythonDaemon {
    io: Mutex<DaemonIO>,
}

/// Set once the daemon sends {"status":"ready"}
static DAEMON: OnceLock<Arc<PythonDaemon>> = OnceLock::new();
/// Set to true if the daemon failed to start (disables future attempts)
static DAEMON_FAILED: AtomicBool = AtomicBool::new(false);

static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static INDEX_QUEUE_PROGRESS: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static INDEX_QUEUE_CANCELLED: OnceLock<AtomicBool> = OnceLock::new();

fn search_cache() -> &'static Mutex<HashMap<String, Value>> {
    SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn index_queue_progress() -> &'static Mutex<HashMap<String, Value>> {
    INDEX_QUEUE_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn index_queue_cancelled() -> &'static AtomicBool {
    INDEX_QUEUE_CANCELLED.get_or_init(|| AtomicBool::new(false))
}

fn search_cache_key(
    folder: &str,
    query: &str,
    filters: Option<&str>,
    sort_by: Option<&str>,
    top_k: Option<u32>,
) -> String {
    // Preserve query casing — Python's CLIP encoder is case-sensitive.
    // Lowercasing here was causing Rust cache keys to mismatch Python cache keys.
    let normalized_query = query.trim().to_string();
    let normalized_filters = filters.unwrap_or("{}").trim();
    let normalized_sort = sort_by.unwrap_or("relevance").trim().to_lowercase();
    let normalized_top_k = top_k.unwrap_or(5);

    format!(
        "{}::{}::{}::{}::{}",
        folder, normalized_query, normalized_filters, normalized_sort, normalized_top_k
    )
}

fn trim_search_cache(cache: &mut HashMap<String, Value>) {
    if cache.len() <= MAX_SEARCH_CACHE_ENTRIES {
        return;
    }

    let keys_to_remove: Vec<String> = cache
        .keys()
        .take(cache.len().saturating_sub(MAX_SEARCH_CACHE_ENTRIES))
        .cloned()
        .collect();

    for k in keys_to_remove {
        cache.remove(&k);
    }
}

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
    // Thumbnails are stored in .thumb_cache/images/<folder_hash>/<image_key>.webp
    Ok(root.join(".thumb_cache").join("images"))
}

/// Start python_daemon.py as a persistent sidecar process.
/// Blocks until the daemon emits {"status":"ready"} (model loaded) or times out.
/// On success, stores the daemon in the DAEMON global.
fn start_daemon(root: &Path) -> Result<(), String> {
    let script = root.join("python_daemon.py");
    if !script.exists() {
        return Err(format!("python_daemon.py not found at {}", script.display()));
    }

    let python_cmd = python_candidates(root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python interpreter not found".to_string())?;

    let mut child = Command::new(&python_cmd)
        .current_dir(root)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // daemon writes tracebacks to stderr; keep stdout clean
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    let child_stdin = child.stdin.take()
        .ok_or_else(|| "Failed to get daemon stdin".to_string())?;
    let child_stdout = child.stdout.take()
        .ok_or_else(|| "Failed to get daemon stdout".to_string())?;

    let mut reader = BufReader::new(child_stdout);
    let writer = BufWriter::new(child_stdin);

    // Wait up to 90 seconds for the model to load and the daemon to send "ready"
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("Daemon startup timeout (90s)".to_string());
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("Daemon process exited during startup".to_string()),
            Ok(_) => {
                if let Ok(val) = serde_json::from_str::<Value>(line.trim()) {
                    if val.get("status").and_then(Value::as_str) == Some("ready") {
                        break;
                    }
                }
            }
            Err(e) => return Err(format!("Failed reading daemon stdout: {}", e)),
        }
    }

    let daemon = Arc::new(PythonDaemon {
        io: Mutex::new(DaemonIO { stdin: writer, stdout: reader }),
    });
    let _ = DAEMON.set(daemon);

    // Transfer child ownership to a detached thread so it is not dropped
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

/// Send one JSON command to the daemon and return the parsed response.
/// The entire request-response cycle is protected by a single Mutex so
/// concurrent Tauri command invocations don't interleave their I/O.
fn call_daemon(command: &str, args: Value) -> Result<Value, String> {
    let daemon = DAEMON.get().ok_or("Daemon not ready")?;
    let mut io = daemon.io.lock().map_err(|_| "Daemon I/O lock poisoned".to_string())?;

    let request = serde_json::to_string(&serde_json::json!({
        "command": command,
        "args": args,
    })).map_err(|e| e.to_string())?;

    io.stdin.write_all(request.as_bytes())
        .and_then(|_| io.stdin.write_all(b"\n"))
        .and_then(|_| io.stdin.flush())
        .map_err(|e| format!("Write to daemon failed: {}", e))?;

    let mut line = String::new();
    io.stdout.read_line(&mut line)
        .map_err(|e| format!("Read from daemon failed: {}", e))?;

    let result: Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("Invalid JSON from daemon ({}): {}", e, line.trim()))?;

    if result.get("status").and_then(Value::as_str) == Some("error") {
        return Err(extract_error_message(&result, "Daemon command failed"));
    }

    Ok(result)
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

#[cfg(test)]
fn build_engine_search_args(
    query: &str,
    top_k: Option<&str>,
    min_score: Option<&str>,
    filters: Option<&str>,
    sort_by: Option<&str>,
) -> Vec<String> {
    let mut args = vec![query.to_string()];

    if let Some(k) = top_k {
        args.push(k.to_string());
    }

    if let Some(score) = min_score {
        args.push(score.to_string());
    }

    if let Some(filter_json) = filters {
        args.push(filter_json.to_string());
    }

    if let Some(sort) = sort_by {
        args.push(sort.to_string());
    }

    args
}

fn run_engine(
    command: &str,
    folder: &str,
    query: Option<&str>,
    top_k: Option<&str>,
    min_score: Option<&str>,
    filters: Option<&str>,
    sort_by: Option<&str>,
) -> Result<Value, String> {
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

        if let Some(k) = top_k {
            cmd.arg(k);
        }

        if let Some(score) = min_score {
            cmd.arg(score);
        }

        if let Some(f) = filters {
            cmd.arg(f);
        }

        if let Some(s) = sort_by {
            cmd.arg(s);
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
    let response = run_engine("index", &folder, None, None, None, None, None)?;

    if let Ok(mut cache) = search_cache().lock() {
        cache.retain(|k, _| !k.starts_with(&format!("{}::", folder)));
    }

    Ok(response)
}

/// Streaming variant of run_engine used for indexing.
/// Reads Python stdout line by line:
///  - Lines starting with "PROGRESS:" are forwarded as Tauri `index-progress` events.
///  - The last non-PROGRESS line is the final JSON result.
fn run_engine_streaming(
    command: &str,
    folder: &str,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
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
            .arg(folder)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                if err.kind() == std::io::ErrorKind::NotFound { continue; }
                last_error = format!("Failed to start Python ({}): {}", python_cmd, err);
                continue;
            }
        };

        let stdout = child.stdout.take().ok_or("No stdout".to_string())?;
        let reader = BufReader::new(stdout);
        let mut last_result_line = String::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };

            if line.starts_with("PROGRESS:") {
                // Parse and emit as a Tauri event
                let json_part = &line["PROGRESS:".len()..];
                if let Ok(payload) = serde_json::from_str::<Value>(json_part) {
                    let _ = app.emit("index-progress", payload);
                }
            } else if !line.trim().is_empty() {
                last_result_line = line;
            }
        }

        let _ = child.wait();

        if last_result_line.is_empty() {
            last_error = "Engine returned empty output".to_string();
            continue;
        }

        let parsed = serde_json::from_str::<Value>(&last_result_line)
            .map_err(|e| format!("Parse error: {} — raw: {}", e, last_result_line))?;

        return Ok(parsed);
    }

    Err(last_error)
}

#[tauri::command]
fn engine_search(
    folder: String,
    query: String,
    filters: Option<String>,
    sort_by: Option<String>,
    top_k: Option<u32>,
) -> Result<Value, String> {
    let key = search_cache_key(
        &folder,
        &query,
        filters.as_deref(),
        sort_by.as_deref(),
        top_k,
    );

    if let Ok(cache) = search_cache().lock() {
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clone());
        }
    }

    let filters_json = filters.as_deref().unwrap_or("{}");
    let sort_value = sort_by.as_deref().unwrap_or("relevance");
    let top_k_str = top_k.unwrap_or(5).to_string();

    // Use daemon for fast search (persistent CLIP model)
    let args = serde_json::json!({
        "folder": folder,
        "query": query,
        "top_k": top_k.unwrap_or(5),
        "min_score": 0.0,
        "filters": filters_json,
        "sort_by": sort_value,
    });
    let response = call_daemon("search", args)
        .or_else(|_| {
            // Subprocess fallback if daemon unavailable
            run_engine(
                "search",
                &folder,
                Some(&query),
                Some(&top_k_str),
                Some("0"),
                Some(filters_json),
                Some(sort_value),
            )
        })?;

    if let Ok(mut cache) = search_cache().lock() {
        cache.insert(key, response.clone());
        trim_search_cache(&mut cache);
    }

    Ok(response)
}

#[tauri::command]
fn engine_is_indexed(folder: String) -> Result<Value, String> {
    let response = run_engine("diagnostics", &folder, None, None, None, None, None)?;
    let indexed = response
        .get("indexed")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Ok(serde_json::json!({
        "status": "ok",
        "folder": folder,
        "indexed": indexed,
    }))
}

#[tauri::command]
fn engine_list(folder: String, filters: Option<String>, sort_by: Option<String>, top_k: Option<u32>) -> Result<Value, String> {
    let filters_json = filters.as_deref().unwrap_or("{}");
    let sort_value = sort_by.as_deref().unwrap_or("filename");
    let top_k_str = top_k.unwrap_or(200).to_string();

    let response = run_engine(
        "list",
        &folder,
        None,
        Some(&top_k_str),
        None,
        Some(filters_json),
        Some(sort_value),
    )?;

    Ok(response)
}

#[tauri::command]
fn index_queue_start(app: tauri::AppHandle, queue_id: String, folders: Vec<String>) -> Result<Value, String> {
    index_queue_cancelled().store(false, Ordering::SeqCst);

    if let Ok(mut map) = index_queue_progress().lock() {
        map.clear();
    }

    let total = folders.len();
    let mut completed = 0usize;
    let mut skipped = 0usize;
    let mut indexed = 0usize;

    for folder in folders {
        if index_queue_cancelled().load(Ordering::SeqCst) {
            return Ok(serde_json::json!({
                "status": "cancelled",
                "queue_id": queue_id,
                "completed": completed,
                "total": total,
                "indexed": indexed,
                "skipped": skipped,
            }));
        }

        if let Ok(mut map) = index_queue_progress().lock() {
            map.insert(
                folder.clone(),
                serde_json::json!({
                    "status": "processing"
                }),
            );
        }

        let is_indexed = run_engine("diagnostics", &folder, None, None, None, None, None)
            .ok()
            .and_then(|v| v.get("indexed").and_then(Value::as_bool))
            .unwrap_or(false);

        if is_indexed {
            skipped += 1;
            completed += 1;
            if let Ok(mut map) = index_queue_progress().lock() {
                map.insert(
                    folder.clone(),
                    serde_json::json!({
                        "status": "skipped",
                        "added": 0,
                        "modified": 0,
                        "removed": 0
                    }),
                );
            }
            continue;
        }

        // Use streaming engine for indexing to get real-time progress events
        match run_engine_streaming("index", &folder, &app) {
            Ok(v) => {
                indexed += 1;
                completed += 1;
                if let Ok(mut map) = index_queue_progress().lock() {
                    map.insert(
                        folder.clone(),
                        serde_json::json!({
                            "status": "indexed",
                            "added": v.get("added").and_then(Value::as_i64).unwrap_or(0),
                            "modified": v.get("modified").and_then(Value::as_i64).unwrap_or(0),
                            "removed": v.get("removed").and_then(Value::as_i64).unwrap_or(0)
                        }),
                    );
                }
            }
            Err(err) => {
                completed += 1;
                if let Ok(mut map) = index_queue_progress().lock() {
                    map.insert(
                        folder.clone(),
                        serde_json::json!({
                            "status": "error",
                            "message": err
                        }),
                    );
                }
            }
        }
    }

    Ok(serde_json::json!({
        "status": "ok",
        "queue_id": queue_id,
        "completed": completed,
        "total": total,
        "indexed": indexed,
        "skipped": skipped,
    }))
}

#[tauri::command]
fn index_queue_progress_state(queue_id: Option<String>) -> Result<Value, String> {
    let _ = queue_id;
    let cancelled = index_queue_cancelled().load(Ordering::SeqCst);
    let folders = if let Ok(map) = index_queue_progress().lock() {
        map.clone()
    } else {
        HashMap::new()
    };

    Ok(serde_json::json!({
        "status": "ok",
        "cancelled": cancelled,
        "folders": folders,
    }))
}

#[tauri::command]
fn index_queue_cancel() -> Result<Value, String> {
    index_queue_cancelled().store(true, Ordering::SeqCst);
    Ok(serde_json::json!({
        "status": "ok",
        "cancelled": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::build_engine_search_args;

    #[test]
    fn search_args_keep_min_score_before_filters() {
        let args = build_engine_search_args(
            "cat",
            Some("5"),
            None,
            Some("{\"file_types\":[\".jpg\"]}"),
            Some("relevance"),
        );

        assert_eq!(
            args,
            vec![
                "cat".to_string(),
                "5".to_string(),
                "{\"file_types\":[\".jpg\"]}".to_string(),
                "relevance".to_string(),
            ]
        );
    }
}

#[tauri::command]
fn engine_search_similar(folder: String, image_path: String, top_k: Option<u32>) -> Result<Value, String> {
    let args = serde_json::json!({
        "folder": folder,
        "image_path": image_path,
        "top_k": top_k.unwrap_or(10),
    });
    if let Ok(v) = call_daemon("similar", args) {
        return Ok(v);
    }
    // Subprocess fallback
    let top_k_str = top_k.map(|k| k.to_string());
    run_engine(
        "similar",
        &folder,
        Some(&image_path),
        top_k_str.as_deref(),
        None,
        None,
        None,
    )
}

#[tauri::command]
fn engine_diagnostics(folder: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder });
    if let Ok(v) = call_daemon("diagnostics", args) {
        return Ok(v);
    }
    run_engine("diagnostics", &folder, None, None, None, None, None)
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

#[tauri::command]
fn startup_self_check() -> Result<Value, String> {
    let root = repo_root()?;

    // Check if engine.py exists
    let engine_script = root.join("engine.py");
    if !engine_script.exists() {
        return Err("Engine script not found".to_string());
    }

    // Check if required directories are writable
    let indexes_dir = root.join("indexes");
    if !indexes_dir.exists() {
        return Err("Indexes directory not found".to_string());
    }

    // Try to create a test file to check writability
    let test_file = indexes_dir.join(".startup_test");
    match std::fs::write(&test_file, "test") {
        Ok(_) => {
            // Remove the test file
            let _ = std::fs::remove_file(&test_file);
        }
        Err(e) => {
            return Err(format!("Indexes directory not writable: {}", e));
        }
    }

    // Check thumbnail cache directory is accessible and writable
    let assets_dir = assets_root()?;
    if !assets_dir.exists() {
        // Create it on first launch; it will be populated after the first index
        fs::create_dir_all(&assets_dir)
            .map_err(|e| format!("Cannot create thumbnail cache directory: {}", e))?;
    }

    std::fs::read_dir(&assets_dir)
        .map_err(|e| format!("Thumbnail cache directory not readable: {}", e))?;

    // Verify write permission with a lightweight probe file.
    // .thumb_cache is outside the Tauri source tree so this is safe.
    let probe = assets_dir.join(".startup_probe");
    fs::write(&probe, "ok")
        .map_err(|e| format!("Thumbnail cache directory not writable: {}", e))?;
    let _ = fs::remove_file(&probe);

    // Verify the CLIP embedding model is already cached locally so offline search
    // never waits on a network download path.
    let model_check = Command::new(&python_candidates(&root)[0])
        .current_dir(&root)
        .arg("-c")
        .arg("from sentence_transformers import SentenceTransformer; SentenceTransformer('clip-ViT-B-32', local_files_only=True); print('MODEL_OK')")
        .output()
        .map_err(|e| format!("Model check failed to start: {}", e))?;

    if !model_check.status.success() {
        return Err("Embedding model is not available locally for offline search".to_string());
    }

    Ok(serde_json::json!({
        "status": "ok",
        "message": "All checks passed"
    }))
}

/// Delete a single image file from disk.
/// Only image extensions are permitted to prevent accidental deletion of
/// non-image files via path traversal or mis-use.
#[tauri::command]
fn delete_file(path: String) -> Result<Value, String> {
    let file_path = PathBuf::from(&path);

    // Security: restrict to known image extensions only
    let allowed = ["jpg", "jpeg", "png", "webp"];
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if !allowed.contains(&ext.as_str()) {
        return Err(format!(
            "Refusing to delete '{}': only image files (jpg/jpeg/png/webp) can be deleted via this command.",
            path
        ));
    }

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete '{}': {}", path, e))?;

    Ok(serde_json::json!({"status": "ok", "deleted": path}))
}

#[tauri::command]
fn cleanup_local_data(folder_id: Option<String>) -> Result<Value, String> {
    let root = repo_root()?;

    // Cleanup indexes
    let indexes_dir = root.join("indexes");
    if indexes_dir.exists() {
        if let Some(ref fid) = folder_id {
            // Clean up specific folder index
            let folder_index_dir = indexes_dir.join(fid);
            if folder_index_dir.exists() {
                std::fs::remove_dir_all(&folder_index_dir)
                    .map_err(|e| format!("Failed to remove folder index: {}", e))?;
            }
        } else {
            // Clean up all indexes
            for entry in std::fs::read_dir(&indexes_dir)
                .map_err(|e| format!("Failed to read indexes directory: {}", e))? {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                if entry.file_type().map_err(|e| format!("Failed to get file type: {}", e))?.is_dir() {
                    std::fs::remove_dir_all(entry.path())
                        .map_err(|e| format!("Failed to remove directory: {}", e))?;
                }
            }
        }
    }

    // Cleanup thumbnail cache
    let assets_root_dir = assets_root()?;
    if assets_root_dir.exists() {
        if let Some(ref fid) = folder_id {
            // Clean up specific folder thumbnails
            let folder_thumb_dir = assets_root_dir.join(fid);
            if folder_thumb_dir.exists() {
                std::fs::remove_dir_all(&folder_thumb_dir)
                    .map_err(|e| format!("Failed to remove folder thumbnails: {}", e))?;
            }
        } else {
            // Clean up all thumbnails
            for entry in std::fs::read_dir(&assets_root_dir)
                .map_err(|e| format!("Failed to read assets directory: {}", e))? {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                if entry.file_type().map_err(|e| format!("Failed to get file type: {}", e))?.is_dir() {
                    std::fs::remove_dir_all(entry.path())
                        .map_err(|e| format!("Failed to remove directory: {}", e))?;
                }
            }
        }
    }

    Ok(serde_json::json!({
        "status": "ok",
        "message": if folder_id.is_some() {
            "Folder data cleaned up successfully"
        } else {
            "All local data cleaned up successfully"
        }
    }))
}

#[tauri::command]
fn engine_stats(folder: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder });
    if let Ok(v) = call_daemon("stats", args) {
        return Ok(v);
    }
    // Subprocess fallback
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("stats").arg(&folder)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_cleanup(folder: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder });
    if let Ok(v) = call_daemon("cleanup", args) {
        return Ok(v);
    }
    // Subprocess fallback
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("cleanup").arg(&folder)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_duplicates(folder: String, threshold: Option<f32>) -> Result<Value, String> {
    let args = serde_json::json!({
        "folder": folder,
        "threshold": threshold.unwrap_or(0.95_f32),
    });
    if let Ok(v) = call_daemon("duplicates", args) {
        return Ok(v);
    }
    // Subprocess fallback
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let mut cmd = Command::new(&python_exe);
    cmd.current_dir(&root).arg("engine.py").arg("duplicates").arg(&folder);
    if let Some(t) = threshold { cmd.arg(t.to_string()); }
    let output = cmd.output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_collections(folder: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder });
    if let Ok(v) = call_daemon("collections", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("collections").arg(&folder)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_create_collection(folder: String, name: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder, "name": name });
    if let Ok(v) = call_daemon("create-collection", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("create-collection").arg(&folder).arg(&name)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_add_to_collection(folder: String, collection_id: String, image_path: String) -> Result<Value, String> {
    let args = serde_json::json!({
        "folder": folder,
        "collection_id": collection_id,
        "image_path": image_path,
    });
    if let Ok(v) = call_daemon("add-to-collection", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("add-to-collection")
        .arg(&folder).arg(&collection_id).arg(&image_path)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_delete_collection(folder: String, collection_id: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder, "collection_id": collection_id });
    if let Ok(v) = call_daemon("delete-collection", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("delete-collection")
        .arg(&folder).arg(&collection_id)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
fn engine_collection_images(folder: String, collection_id: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder, "collection_id": collection_id });
    if let Ok(v) = call_daemon("collection-images", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root).arg("engine.py").arg("collection-images")
        .arg(&folder).arg(&collection_id)
        .output().map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

/// Returns whether the Python daemon is ready.
/// The frontend polls this to show a "Warming up AI engine..." status.
#[tauri::command]
fn daemon_status() -> Value {
    let ready = DAEMON.get().is_some();
    let failed = DAEMON_FAILED.load(Ordering::Relaxed);
    serde_json::json!({
        "ready": ready,
        "failed": failed,
    })
}

/// Fast index update after file deletion.
/// Rebuilds the FAISS index from cached .npy embeddings without re-running CLIP.
/// ~1-2s for any library size vs 30-60s for a full re-encode.
#[tauri::command]
fn engine_remove_from_index(folder: String, paths: Vec<String>) -> Result<Value, String> {
    let args = serde_json::json!({
        "folder": folder,
        "paths": paths,
    });
    if let Ok(v) = call_daemon("remove-from-index", args.clone()) {
        return Ok(v);
    }
    // Subprocess fallback via engine.py
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let paths_json = serde_json::to_string(&paths)
        .map_err(|e| format!("Serialization error: {}", e))?;
    let output = Command::new(&python_exe)
        .current_dir(&root)
        .arg("engine.py")
        .arg("remove-from-index")
        .arg(&folder)
        .arg(&paths_json)
        .output()
        .map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

/// Read EXIF metadata from an image file.
/// Returns file size, modification date, image dimensions, and EXIF fields
/// (camera make/model, date taken, GPS coords) when available.
#[tauri::command]
fn get_image_metadata(path: String) -> Result<Value, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    // --- File system metadata ---
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    let file_size = meta.len();
    let file_size_kb = file_size as f64 / 1024.0;
    let file_size_str = if file_size_kb < 1024.0 {
        format!("{:.0} KB", file_size_kb)
    } else {
        format!("{:.1} MB", file_size_kb / 1024.0)
    };

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // --- EXIF extraction ---
    let mut exif_date = String::new();
    let mut camera_make = String::new();
    let mut camera_model = String::new();
    let mut gps_lat: Option<f64> = None;
    let mut gps_lon: Option<f64> = None;
    let mut exif_width: Option<u32> = None;
    let mut exif_height: Option<u32> = None;

    if let Ok(file) = std::fs::File::open(p) {
        let mut bufreader = BufReader::new(file);
        let exifreader = exif::Reader::new();
        if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
            // Date/Time
            if let Some(f) = exif.get_field(Tag::DateTimeOriginal, In::PRIMARY) {
                exif_date = f.display_value().to_string();
            }
            // Camera
            if let Some(f) = exif.get_field(Tag::Make, In::PRIMARY) {
                camera_make = f.display_value().to_string().trim_matches('"').to_string();
            }
            if let Some(f) = exif.get_field(Tag::Model, In::PRIMARY) {
                camera_model = f.display_value().to_string().trim_matches('"').to_string();
            }
            // Dimensions
            if let Some(f) = exif.get_field(Tag::PixelXDimension, In::PRIMARY) {
                exif_width = f.display_value().to_string().parse().ok();
            }
            if let Some(f) = exif.get_field(Tag::PixelYDimension, In::PRIMARY) {
                exif_height = f.display_value().to_string().parse().ok();
            }
            // GPS — parse rational triples into decimal degrees
            fn dms_to_decimal(exif_field: &exif::Field) -> Option<f64> {
                if let exif::Value::Rational(ref v) = exif_field.value {
                    if v.len() >= 3 {
                        let d = v[0].num as f64 / v[0].denom as f64;
                        let m = v[1].num as f64 / v[1].denom as f64;
                        let s = v[2].num as f64 / v[2].denom as f64;
                        return Some(d + m / 60.0 + s / 3600.0);
                    }
                }
                None
            }
            if let (Some(lat_f), Some(lon_f)) = (
                exif.get_field(Tag::GPSLatitude, In::PRIMARY),
                exif.get_field(Tag::GPSLongitude, In::PRIMARY),
            ) {
                let lat_raw = dms_to_decimal(lat_f);
                let lon_raw = dms_to_decimal(lon_f);
                if let (Some(lat), Some(lon)) = (lat_raw, lon_raw) {
                    // Apply hemisphere sign
                    let lat_ref = exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY)
                        .map(|f| f.display_value().to_string())
                        .unwrap_or_default();
                    let lon_ref = exif.get_field(Tag::GPSLongitudeRef, In::PRIMARY)
                        .map(|f| f.display_value().to_string())
                        .unwrap_or_default();
                    gps_lat = Some(if lat_ref.contains('S') { -lat } else { lat });
                    gps_lon = Some(if lon_ref.contains('W') { -lon } else { lon });
                }
            }
        }
    }

    Ok(serde_json::json!({
        "file_size": file_size_str,
        "file_size_bytes": file_size,
        "modified_unix": modified,
        "exif_date": exif_date,
        "camera_make": camera_make,
        "camera_model": camera_model,
        "exif_width": exif_width,
        "exif_height": exif_height,
        "gps_lat": gps_lat,
        "gps_lon": gps_lon,
    }))
}

/// Batch file modification-time lookup for the Timeline view.
/// Takes a list of image paths, returns a JSON object mapping each path to its
/// Unix mtime (seconds). Missing/inaccessible files are omitted silently.
/// Pure Rust — no Python spawned. ~200 paths resolve in <5 ms.
#[tauri::command]
fn get_files_mtime(paths: Vec<String>) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    for path in paths.iter().take(500) {
        if let Ok(meta) = fs::metadata(path) {
            if let Ok(mtime) = meta.modified() {
                if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                    map.insert(path.clone(), serde_json::json!(dur.as_secs()));
                }
            }
        }
    }
    Ok(Value::Object(map))
}

/// Export EXIF metadata for a list of image paths to a CSV file.
/// Columns: filename, path, file_size_bytes, date_taken, camera_make, camera_model,
///          width, height, gps_lat, gps_lon
/// Called from JS after the user picks an output path via the save dialog.
#[tauri::command]
fn export_metadata_csv(paths: Vec<String>, output_path: String) -> Result<Value, String> {
    use std::io::Write;

    let out_path = Path::new(&output_path);
    let mut file = std::fs::File::create(out_path)
        .map_err(|e| format!("Cannot create file: {}", e))?;

    // CSV header
    writeln!(file, "filename,path,file_size_bytes,date_taken,camera_make,camera_model,width,height,gps_lat,gps_lon")
        .map_err(|e| e.to_string())?;

    let exifreader_factory = || exif::Reader::new();

    for path_str in &paths {
        let p = Path::new(path_str);
        let filename = p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();

        // File size
        let file_size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);

        // EXIF fields
        let mut date_taken = String::new();
        let mut camera_make = String::new();
        let mut camera_model = String::new();
        let mut width: Option<u32> = None;
        let mut height: Option<u32> = None;
        let mut gps_lat: Option<f64> = None;
        let mut gps_lon: Option<f64> = None;

        if let Ok(f) = std::fs::File::open(p) {
            let mut buf = BufReader::new(f);
            let reader = exifreader_factory();
            if let Ok(exif) = reader.read_from_container(&mut buf) {
                if let Some(f) = exif.get_field(Tag::DateTimeOriginal, In::PRIMARY) {
                    date_taken = f.display_value().to_string();
                }
                if let Some(f) = exif.get_field(Tag::Make, In::PRIMARY) {
                    camera_make = f.display_value().to_string().trim_matches('"').to_string();
                }
                if let Some(f) = exif.get_field(Tag::Model, In::PRIMARY) {
                    camera_model = f.display_value().to_string().trim_matches('"').to_string();
                }
                if let Some(f) = exif.get_field(Tag::PixelXDimension, In::PRIMARY) {
                    width = f.display_value().to_string().parse().ok();
                }
                if let Some(f) = exif.get_field(Tag::PixelYDimension, In::PRIMARY) {
                    height = f.display_value().to_string().parse().ok();
                }
                // GPS
                fn dms(field: &exif::Field) -> Option<f64> {
                    if let exif::Value::Rational(ref v) = field.value {
                        if v.len() >= 3 {
                            let d = v[0].num as f64 / v[0].denom as f64;
                            let m = v[1].num as f64 / v[1].denom as f64;
                            let s = v[2].num as f64 / v[2].denom as f64;
                            return Some(d + m / 60.0 + s / 3600.0);
                        }
                    }
                    None
                }
                if let (Some(lat_f), Some(lon_f)) = (
                    exif.get_field(Tag::GPSLatitude, In::PRIMARY),
                    exif.get_field(Tag::GPSLongitude, In::PRIMARY),
                ) {
                    if let (Some(lat), Some(lon)) = (dms(lat_f), dms(lon_f)) {
                        let lat_ref = exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY)
                            .map(|f| f.display_value().to_string()).unwrap_or_default();
                        let lon_ref = exif.get_field(Tag::GPSLongitudeRef, In::PRIMARY)
                            .map(|f| f.display_value().to_string()).unwrap_or_default();
                        gps_lat = Some(if lat_ref.contains('S') { -lat } else { lat });
                        gps_lon = Some(if lon_ref.contains('W') { -lon } else { lon });
                    }
                }
            }
        }

        // CSV-escape a field (wrap in quotes if it contains comma/quote/newline)
        fn csv_field(s: &str) -> String {
            if s.contains(',') || s.contains('"') || s.contains('\n') {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.to_string()
            }
        }

        let row = format!(
            "{},{},{},{},{},{},{},{},{},{}",
            csv_field(&filename),
            csv_field(path_str),
            file_size,
            csv_field(&date_taken),
            csv_field(&camera_make),
            csv_field(&camera_model),
            width.map(|v| v.to_string()).unwrap_or_default(),
            height.map(|v| v.to_string()).unwrap_or_default(),
            gps_lat.map(|v| format!("{:.6}", v)).unwrap_or_default(),
            gps_lon.map(|v| format!("{:.6}", v)).unwrap_or_default(),
        );
        writeln!(file, "{}", row).map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({ "exported": paths.len(), "path": output_path }))
}

/// Compute analytics for an indexed folder purely from the manifest + fs::metadata.
/// Returns: total_images, total_size_bytes, avg_size_bytes, by_extension, by_year,
/// Delegate to engine.py "analytics" command which correctly resolves
/// the hash-based index path via get_index_dir().
/// Returns: total_images, total_size_bytes, avg_size_bytes,
///          by_extension[], by_year[], largest_file, smallest_file.
#[tauri::command]
fn get_folder_analytics(folder: String) -> Result<Value, String> {
    // Try daemon first (fast path — model already loaded)
    let args = serde_json::json!({ "folder": folder });
    if let Ok(result) = call_daemon("analytics", args) {
        return Ok(result);
    }

    // Subprocess fallback
    run_engine("analytics", &folder, None, None, None, None, None)
}

// ─── TAG MANAGEMENT ──────────────────────────────────────────────────────────
// Tags are stored in {folder}/.ai-photo-index/tags.json as:
//   { "/abs/path/image.jpg": ["sunset", "family"], ... }
// All four commands operate on this file with full read-modify-write semantics.

fn tags_path(folder: &str) -> PathBuf {
    Path::new(folder).join(".ai-photo-index").join("tags.json")
}

fn read_tags_map(folder: &str) -> HashMap<String, Vec<String>> {
    let p = tags_path(folder);
    if !p.exists() { return HashMap::new(); }
    let text = fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_tags_map(folder: &str, map: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let p = tags_path(folder);
    // Ensure parent exists
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(map).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| e.to_string())
}

/// Return the tags for a single image path within a folder.
#[tauri::command]
fn get_image_tags(folder: String, path: String) -> Result<Vec<String>, String> {
    let map = read_tags_map(&folder);
    Ok(map.get(&path).cloned().unwrap_or_default())
}

/// Upsert the tags for a single image. Pass an empty Vec to clear all tags.
#[tauri::command]
fn set_image_tags(folder: String, path: String, tags: Vec<String>) -> Result<Value, String> {
    let mut map = read_tags_map(&folder);
    // Deduplicate and normalise tags (lowercase, trim)
    let mut deduped: Vec<String> = tags.iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    deduped.sort();
    deduped.dedup();

    if deduped.is_empty() {
        map.remove(&path);
    } else {
        map.insert(path.clone(), deduped.clone());
    }
    write_tags_map(&folder, &map)?;
    Ok(serde_json::json!({ "path": path, "tags": deduped }))
}

/// Return all unique tags used in a folder, sorted alphabetically.
#[tauri::command]
fn get_all_tags(folder: String) -> Result<Vec<String>, String> {
    let map = read_tags_map(&folder);
    let mut all: Vec<String> = map.values()
        .flat_map(|tags| tags.iter().cloned())
        .collect();
    all.sort();
    all.dedup();
    Ok(all)
}

/// Return all image paths in a folder that have a given tag.
#[tauri::command]
fn get_images_by_tag(folder: String, tag: String) -> Result<Vec<String>, String> {
    let tag_lower = tag.trim().to_lowercase();
    let map = read_tags_map(&folder);
    let mut paths: Vec<String> = map.into_iter()
        .filter(|(_, tags)| tags.contains(&tag_lower))
        .map(|(path, _)| path)
        .collect();
    paths.sort();
    Ok(paths)
}

// ─── IMAGE NOTES ─────────────────────────────────────────────────────────────
// Notes stored in {folder}/.ai-photo-index/notes.json as { "/path/img.jpg": "text" }

fn notes_path(folder: &str) -> PathBuf {
    Path::new(folder).join(".ai-photo-index").join("notes.json")
}

fn read_notes_map(folder: &str) -> HashMap<String, String> {
    let p = notes_path(folder);
    if !p.exists() { return HashMap::new(); }
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_default()).unwrap_or_default()
}

fn write_notes_map(folder: &str, map: &HashMap<String, String>) -> Result<(), String> {
    let p = notes_path(folder);
    if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&p, serde_json::to_string(map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Get the note for a single image.
#[tauri::command]
fn get_image_note(folder: String, path: String) -> Result<String, String> {
    Ok(read_notes_map(&folder).get(&path).cloned().unwrap_or_default())
}

/// Set (or clear) the note for a single image. Empty string removes the entry.
#[tauri::command]
fn set_image_note(folder: String, path: String, note: String) -> Result<Value, String> {
    let mut map = read_notes_map(&folder);
    let trimmed = note.trim();
    let stored: String = trimmed.chars().take(500).collect(); // max 500 chars
    if stored.is_empty() { map.remove(&path); } else { map.insert(path.clone(), stored.clone()); }
    write_notes_map(&folder, &map)?;
    Ok(serde_json::json!({ "path": path, "saved": !stored.is_empty() }))
}

/// Batch rename image files.
/// Input: JSON array of objects `{"from": "/abs/path/old.jpg", "to": "/abs/path/new.jpg"}`.
/// Returns `{"ok": N, "failed": M, "errors": [...]}`.
/// Safeguards: skips if `from` doesn't exist or `to` already exists.
#[tauri::command]
fn batch_rename_files(renames: Vec<Value>) -> Result<Value, String> {
    let mut ok: usize = 0;
    let mut failed: usize = 0;
    let mut errors: Vec<String> = Vec::new();

    for item in &renames {
        let from_str = item.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to_str   = item.get("to").and_then(|v| v.as_str()).unwrap_or("");

        if from_str.is_empty() || to_str.is_empty() {
            failed += 1;
            errors.push("Empty from/to path".to_string());
            continue;
        }

        let from_path = Path::new(from_str);
        let to_path   = Path::new(to_str);

        if !from_path.exists() {
            failed += 1;
            errors.push(format!("Source not found: {}", from_str));
            continue;
        }
        if to_path.exists() {
            failed += 1;
            errors.push(format!("Destination already exists: {}", to_str));
            continue;
        }

        match fs::rename(from_path, to_path) {
            Ok(()) => ok += 1,
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {}", from_str, e));
            }
        }
    }

    Ok(serde_json::json!({ "ok": ok, "failed": failed, "errors": errors }))
}

/// Fast check for new/removed images in a folder without re-indexing.
/// Routes through daemon (no model warm-up needed) then subprocess fallback.
#[tauri::command]
fn engine_check_changes(folder: String) -> Result<Value, String> {
    let args = serde_json::json!({ "folder": folder });
    if let Ok(v) = call_daemon("check-changes", args) {
        return Ok(v);
    }
    let root = repo_root()?;
    let python_exe = python_candidates(&root)
        .into_iter()
        .find(|p| Command::new(p).arg("--version").output().is_ok())
        .ok_or_else(|| "Python not found".to_string())?;
    let output = Command::new(&python_exe)
        .current_dir(&root)
        .arg("engine.py")
        .arg("check-changes")
        .arg(&folder)
        .output()
        .map_err(|e| format!("Engine exec failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Parse error: {}", e))
}

/// Export all images from a collection to a destination folder on disk.
/// Pure Rust: reads the collection manifest then copies files with std::fs::copy.
/// No Python process spawned — instant for small collections, fast for large.
#[tauri::command]
fn export_collection_images(
    folder: String,
    collection_id: String,
    collection_name: String,
    dest_folder: String,
) -> Result<Value, String> {
    // Get collection image list via daemon or subprocess
    let args = serde_json::json!({
        "folder": folder,
        "collection_id": collection_id,
    });
    let data = match call_daemon("collection-images", args) {
        Ok(v) => v,
        Err(_) => {
            let root = repo_root()?;
            let python_exe = python_candidates(&root)
                .into_iter()
                .find(|p| Command::new(p).arg("--version").output().is_ok())
                .ok_or_else(|| "Python not found".to_string())?;
            let output = Command::new(&python_exe)
                .current_dir(&root)
                .arg("engine.py")
                .arg("collection-images")
                .arg(&folder)
                .arg(&collection_id)
                .output()
                .map_err(|e| format!("Engine exec failed: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            serde_json::from_str(&stdout)
                .map_err(|e| format!("Parse error: {}", e))?
        }
    };

    let images = data["images"].as_array()
        .cloned()
        .unwrap_or_default();

    // Sanitise collection name for use as a folder name
    let safe_name: String = collection_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    let safe_name = safe_name.trim().to_string();
    let dest = Path::new(&dest_folder).join(if safe_name.is_empty() { collection_id.clone() } else { safe_name });

    fs::create_dir_all(&dest)
        .map_err(|e| format!("Cannot create destination folder: {}", e))?;

    let mut copied = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for img in &images {
        if let Some(src_path) = img["path"].as_str() {
            let src = Path::new(src_path);
            if let Some(filename) = src.file_name() {
                let dst = dest.join(filename);
                match fs::copy(src, &dst) {
                    Ok(_) => copied += 1,
                    Err(e) => errors.push(format!("{}: {}", src_path, e)),
                }
            }
        }
    }

    Ok(serde_json::json!({
        "status": "ok",
        "copied": copied,
        "total": images.len(),
        "dest": dest.to_string_lossy(),
        "errors": errors,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            engine_index,
            engine_search,
            engine_is_indexed,
            engine_list,
            index_queue_start,
            index_queue_progress_state,
            index_queue_cancel,
            engine_search_similar,
            engine_diagnostics,
            engine_stats,
            engine_cleanup,
            engine_duplicates,
            engine_collections,
            engine_create_collection,
            engine_add_to_collection,
            engine_delete_collection,
            engine_collection_images,
            get_image_uri,
            thumbnail_data_uri,
            startup_self_check,
            cleanup_local_data,
            delete_file,
            daemon_status,
            engine_remove_from_index,
            engine_check_changes,
            export_collection_images,
            get_image_metadata,
            get_files_mtime,
            export_metadata_csv,
            get_folder_analytics,
            batch_rename_files,
            get_image_tags,
            set_image_tags,
            get_all_tags,
            get_images_by_tag,
            get_image_note,
            set_image_note
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Run startup self-check
            match startup_self_check() {
                Ok(result) => {
                    println!("Startup self-check passed: {:?}", result);
                }
                Err(e) => {
                    eprintln!("Startup self-check failed: {}", e);
                    // We don't want to prevent the app from starting, just log the error
                }
            }

            // Launch Python daemon in a background thread.
            // The daemon loads CLIP once and handles all search/query commands
            // going forward, eliminating the 800ms-2s cold-start per action.
            if let Ok(root) = repo_root() {
                std::thread::spawn(move || {
                    match start_daemon(&root) {
                        Ok(()) => println!("Python daemon ready"),
                        Err(e) => {
                            eprintln!("Python daemon failed to start: {}", e);
                            DAEMON_FAILED.store(true, Ordering::Relaxed);
                        }
                    }
                });
            } else {
                eprintln!("Python daemon: could not resolve repo root");
                DAEMON_FAILED.store(true, Ordering::Relaxed);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
