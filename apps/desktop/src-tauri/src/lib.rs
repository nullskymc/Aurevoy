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

use base64::Engine;

/// 将粘贴的图片 base64 数据写入临时文件，返回绝对路径供 Agent 读取。
#[tauri::command]
fn save_temp_file(name: String, data: String) -> Result<String, String> {
    // 从 "data:image/png;base64,xxx" 或纯 base64 中提取数据
    let b64 = if let Some(idx) = data.find(";base64,") {
        &data[idx + 8..]
    } else {
        &data
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let mut dir = std::env::temp_dir();
    dir.push("aurevoy-clipboard");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    // 文件名防冲突
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe_name = name.replace(['/', '\\', ':', ' '], "_");
    let file_path = dir.join(format!("{ts}_{safe_name}"));
    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    Ok(file_path.to_string_lossy().to_string())
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
            file_metadata,
            save_temp_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
