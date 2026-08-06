mod agent_process;
mod tray_menu;

use agent_process::{agent_process_status, ensure_agent_process, AgentProcessState};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tray_menu::{setup_tray, update_tray_recent, TrayState};

#[derive(Debug, Clone, Serialize)]
struct FileMetadata {
    name: String,
    size: u64,
    is_dir: bool,
    mime_type: String,
}

#[tauri::command]
fn file_metadata(app: tauri::AppHandle, path: String) -> Result<FileMetadata, String> {
    let canonical = scoped_path(&app, &path)?;
    let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    let mime = mime_guess::from_path(&canonical)
        .first_or_octet_stream()
        .to_string();
    let name = canonical
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

#[derive(Default)]
struct WorkspaceAssetScope {
    roots: std::sync::Mutex<Vec<std::path::PathBuf>>,
}

fn canonical_existing_path(path: &str) -> Result<std::path::PathBuf, String> {
    let requested = std::path::PathBuf::from(path.trim());
    if !requested.is_absolute() {
        return Err("path scope requires an absolute path".to_string());
    }
    std::fs::canonicalize(&requested)
        .map_err(|error| format!("cannot resolve selected path: {error}"))
}

fn is_sensitive_user_path(path: &std::path::Path) -> bool {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let Some(home) = home else { return false };
    [".ssh", ".aws", ".gnupg"]
        .iter()
        .any(|name| path.starts_with(home.join(name)))
}

fn remember_asset_root(
    app: &tauri::AppHandle,
    path: std::path::PathBuf,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|error| format!("cannot grant asset scope: {error}"))?;
    let scope = app.state::<WorkspaceAssetScope>();
    let mut roots = scope
        .roots
        .lock()
        .map_err(|_| "workspace asset scope is unavailable".to_string())?;
    if !roots.iter().any(|root| path.starts_with(root)) {
        roots.push(path);
    }
    Ok(())
}

/// 只为用户已选择的工作区授予 asset protocol 范围，支持工作区位于 HOME 之外的情况。
/// 敏感的用户凭证目录即使被误选也拒绝，避免把它们暴露给 WebView。
#[tauri::command]
fn allow_asset_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical = canonical_existing_path(&path)?;
    if !canonical.is_dir() {
        return Err("asset scope requires a directory".to_string());
    }
    if is_sensitive_user_path(&canonical) {
        return Err("refusing to expose a sensitive user directory".to_string());
    }
    remember_asset_root(&app, canonical)
}

/// 用户从文件选择器或拖放选择文件时，登记其父目录供预览和系统打开使用。
#[tauri::command]
fn allow_asset_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical = canonical_existing_path(&path)?;
    let root = if canonical.is_dir() {
        canonical
    } else {
        canonical
            .parent()
            .ok_or_else(|| "selected path has no parent directory".to_string())?
            .to_path_buf()
    };
    if is_sensitive_user_path(&root) {
        return Err("refusing to expose a sensitive user directory".to_string());
    }
    remember_asset_root(&app, root)
}

fn scoped_path(app: &tauri::AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = canonical_existing_path(path)?;
    if is_sensitive_user_path(&canonical) {
        return Err("refusing to open a sensitive user path".to_string());
    }
    let scope = app.state::<WorkspaceAssetScope>();
    let roots = scope
        .roots
        .lock()
        .map_err(|_| "workspace asset scope is unavailable".to_string())?;
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(canonical)
    } else {
        Err("path is outside a user-approved workspace".to_string())
    }
}

#[tauri::command]
fn open_workspace_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical = scoped_path(&app, &path)?;
    app.opener()
        .open_path(canonical.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| format!("cannot open workspace path: {error}"))
}

#[tauri::command]
fn reveal_workspace_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical = scoped_path(&app, &path)?;
    app.opener()
        .reveal_item_in_dir(&canonical)
        .map_err(|error| format!("cannot reveal workspace path: {error}"))
}

use base64::Engine;

/// 将粘贴的图片 base64 数据写入临时文件，返回绝对路径供 Agent 读取。
#[tauri::command]
fn save_temp_file(app: tauri::AppHandle, name: String, data: String) -> Result<String, String> {
    // 从 "data:image/png;base64,xxx" 或纯 base64 中提取数据
    let b64 = if let Some(idx) = data.find(";base64,") {
        &data[idx + 8..]
    } else {
        &data
    };
    const MAX_TEMP_FILE_BYTES: usize = 20 * 1024 * 1024;
    // base64 的长度约为原始字节数的 4/3；先限制输入，避免超大请求在 decode 前分配内存。
    if b64.len() > (MAX_TEMP_FILE_BYTES / 3) * 4 + 8 {
        return Err("临时文件不能超过 20MB".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if bytes.len() > MAX_TEMP_FILE_BYTES {
        return Err("临时文件不能超过 20MB".to_string());
    }
    let mut dir = std::env::temp_dir();
    dir.push("aurevoy-clipboard");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    // 文件名防冲突
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe_name: String = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        .take(120)
        .collect();
    let safe_name = if safe_name.is_empty() {
        "clipboard.bin".to_string()
    } else {
        safe_name
    };
    let file_path = dir.join(format!("{ts}_{safe_name}"));
    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    remember_asset_root(&app, dir)?;
    Ok(file_path.to_string_lossy().to_string())
}

/// 读取用户选中的图片，编码为 data URL 交给前端上传到本地 Agent 引擎。
#[tauri::command]
fn read_image_data_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let canonical = scoped_path(&app, &path)?;
    let metadata = std::fs::metadata(&canonical).map_err(|e| format!("读取图片信息失败: {e}"))?;
    if metadata.is_dir() {
        return Err("不能上传目录作为图片".to_string());
    }
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片不能超过 20MB".to_string());
    }
    let mime = mime_guess::from_path(&canonical)
        .first_or_octet_stream()
        .to_string();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return Err("仅支持 PNG、JPEG、GIF 或 WebP 图片".to_string());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("读取图片失败: {e}"))?;
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
        .manage(WorkspaceAssetScope::default())
        .manage(AgentProcessState::default())
        .manage(TrayState::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // macOS 菜单栏 / Windows 托盘；失败只记日志，不阻断启动。
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            if let Err(err) = setup_tray(app.handle()) {
                eprintln!("[tray] setup failed: {err}");
            }
            // 明确恢复主窗口可见和焦点，避免桌面会话/托盘初始化把首次窗口留在隐藏状态。
            // 这也是 macOS/Windows 真实 WebView smoke 的启动契约：进程启动不等于用户能看到窗口。
            if let Some(window) = app.get_webview_window("main") {
                window
                    .show()
                    .map_err(|error| format!("无法显示主窗口：{error}"))?;
                window
                    .set_focus()
                    .map_err(|error| format!("无法聚焦主窗口：{error}"))?;
            } else {
                return Err("未找到 main WebView 窗口".into());
            }
            Ok(())
        })
        // macOS / Windows：关窗只隐藏 UI，引擎与托盘继续；退出走菜单 Quit / Cmd+Q。
        .on_window_event(|window, event| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = (window, event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            ensure_agent_process,
            agent_process_status,
            file_metadata,
            allow_asset_directory,
            allow_asset_path,
            open_workspace_path,
            reveal_workspace_path,
            save_temp_file,
            read_image_data_url,
            clear_app_quarantine,
            update_tray_recent
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Cmd+Q / Quit Aurevoy / 非托盘平台关最后一窗：在 process::exit 前显式杀托管引擎。
            // Tauri 用 process::exit 退出，managed state 的 Drop 不会执行。
            tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<AgentProcessState>() {
                    state.stop_managed();
                }
            }
            // Dock 点图标：若窗口被隐藏，重新显示。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows, ..
            } => {
                if !has_visible_windows {
                    tray_menu::show_main_window(app_handle);
                }
            }
            _ => {}
        });
}
