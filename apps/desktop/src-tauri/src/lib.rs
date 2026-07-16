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

/// 读取用户选中的图片，编码为 data URL 交给前端上传到本地 Agent 引擎。
#[tauri::command]
fn read_image_data_url(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| format!("读取图片信息失败: {e}"))?;
    if metadata.is_dir() {
        return Err("不能上传目录作为图片".to_string());
    }
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片不能超过 20MB".to_string());
    }
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return Err("仅支持 PNG、JPEG、GIF 或 WebP 图片".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 定位当前进程所属的 `.app` 包路径（`…/Aurevoy.app`）。
#[cfg(target_os = "macos")]
fn macos_app_bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().and_then(|s| s.to_str()) == Some("app") {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// 清除本应用 bundle 的 quarantine 属性。
///
/// 用于**自动更新安装完成后、重启前**：未签名分发时，更新包常再次带上
/// `com.apple.quarantine`，导致「已损坏 / 无法验证」。首次从网上下载仍需用户手动放行一次。
/// 非 macOS 为 no-op；失败不抛致命错误（由调用方决定是否忽略）。
#[tauri::command]
fn clear_app_quarantine() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = macos_app_bundle_path()
            .ok_or_else(|| "无法定位 .app bundle（非标准 macOS 应用布局？）".to_string())?;
        let status = std::process::Command::new("/usr/bin/xattr")
            .args(["-cr"])
            .arg(&bundle)
            .status()
            .map_err(|e| format!("执行 xattr 失败: {e}"))?;
        if !status.success() {
            return Err(format!(
                "xattr -cr {:?} 退出码 {:?}",
                bundle,
                status.code()
            ));
        }
        Ok(bundle.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(String::new())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .manage(AgentProcessState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_agent_process,
            agent_process_status,
            file_metadata,
            save_temp_file,
            read_image_data_url,
            clear_app_quarantine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
