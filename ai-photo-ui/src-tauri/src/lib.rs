// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::process::Command;
use std::path::PathBuf;

fn engine_py_path() -> PathBuf {
    let mut path = std::env::current_dir().unwrap();
    path.pop(); // remove src-tauri
    path.pop();
    path.push("engine.py"); // ai-photo-ui/engine.py
    path
}
fn python_bin() -> &'static str {
    r"C:\Users\saxen\OneDrive\Desktop\ai-photo-search\venv\Scripts\python.exe"
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
#[tauri::command]
fn engine_index(folder: String) -> Result<String, String> {
    let script = engine_py_path();

    let output = Command::new(python_bin())
        .arg(script)
        .arg("index")
        .arg(folder)
        .output()
        .map_err(|e| format!(r#"{{"status":"error","message":"{}"}}"#, e))?;

   
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            r#"{{"status":"error","message":"{}"}}"#,
            err.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}


#[tauri::command]
fn engine_search(folder: String, query: String) -> Result<String, String> {
    let script = engine_py_path();

    let output = Command::new(python_bin())
        .arg(script)
        .arg("search")
        .arg(folder)
        .arg(query)
        .output()
        .map_err(|e| format!(r#"{{"status":"error","message":"{}"}}"#, e))?;

   if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            r#"{{"status":"error","message":"{}"}}"#,
            err.trim()
        ));
    }


    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
       .invoke_handler(tauri::generate_handler![
    greet,
    engine_index,
    engine_search
])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}