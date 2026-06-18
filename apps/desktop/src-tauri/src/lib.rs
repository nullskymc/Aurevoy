mod agent_process;

use agent_process::{agent_process_status, ensure_agent_process, AgentProcessState};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
struct FileMetadata {
    name: String,
    size: u64,
    is_dir: bool,
    mime_type: String,
}

#[tauri::command]
fn file_metadata(path: String) -> Result<FileMetadata, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let name = std::path::Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(FileMetadata {
        name,
        size: meta.len(),
        is_dir: meta.is_dir(),
        mime_type: mime,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentProcessState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_agent_process,
            agent_process_status,
            file_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
