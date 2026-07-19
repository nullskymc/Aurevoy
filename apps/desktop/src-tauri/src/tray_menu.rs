//! 系统托盘（macOS 菜单栏 / Windows 通知区域）。
//!
//! 菜单结构参考 ChatGPT 托盘：Recent → 任务项 → More → New Chat / Open / Quit。
//! 关窗后托盘仍可用；Quit / Cmd+Q 才会退出并停托管 Agent。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

const TRAY_ID: &str = "aurevoy-tray";
const EVENT_TRAY_ACTION: &str = "tray-action";

/// 主菜单展示的最近任务条数。
const RECENT_MAIN: usize = 5;
/// More 子菜单额外条数。
const RECENT_MORE: usize = 12;
/// 菜单标题最大长度。
const TITLE_MAX_CHARS: usize = 42;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayRecentItem {
    pub id: String,
    pub title: String,
    /// 副标题（如项目名）；原生菜单无真正两行，会拼进主标题。
    #[serde(default)]
    pub subtitle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayActionPayload {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Default)]
pub struct TrayState {
    icon: Mutex<Option<TrayIcon>>,
    recent: Mutex<Vec<TrayRecentItem>>,
}

impl TrayState {
    fn set_icon(&self, tray: TrayIcon) {
        if let Ok(mut guard) = self.icon.lock() {
            *guard = Some(tray);
        }
    }

    fn set_recent(&self, items: Vec<TrayRecentItem>) {
        if let Ok(mut guard) = self.recent.lock() {
            *guard = items;
        }
    }

    fn recent_snapshot(&self) -> Vec<TrayRecentItem> {
        self.recent
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}

/// 在 setup 中创建托盘。失败不阻断启动。
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let recent = app
        .try_state::<TrayState>()
        .map(|s| s.recent_snapshot())
        .unwrap_or_default();
    let menu = build_menu(app, &recent).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Aurevoy")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            // Windows：双击打开主窗口（单击出菜单）。
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // Dedicated template icon: black silhouette on transparent background.
    // The app window icon has an opaque background → renders as a white square
    // when icon_as_template(true) discards color and uses only the alpha channel.
    #[cfg(target_os = "macos")]
    {
        let icon_bytes = include_bytes!("../icons/tray-icon@2x.png");
        if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
            builder = builder.icon(icon);
        }
        builder = builder.icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }

    let tray = builder.build(app).map_err(|e| e.to_string())?;

    if let Some(state) = app.try_state::<TrayState>() {
        state.set_icon(tray);
    }

    Ok(())
}

/// 前端同步最近任务列表到托盘菜单。
#[tauri::command]
pub fn update_tray_recent(
    app: AppHandle,
    state: State<'_, TrayState>,
    items: Vec<TrayRecentItem>,
) -> Result<(), String> {
    state.set_recent(items.clone());
    rebuild_menu(&app, &state, &items)
}

fn rebuild_menu(
    app: &AppHandle,
    state: &TrayState,
    items: &[TrayRecentItem],
) -> Result<(), String> {
    let menu = build_menu(app, items).map_err(|e| e.to_string())?;
    let guard = state
        .icon
        .lock()
        .map_err(|_| "托盘状态锁已损坏".to_string())?;
    if let Some(tray) = guard.as_ref() {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_menu(app: &AppHandle, items: &[TrayRecentItem]) -> tauri::Result<Menu<tauri::Wry>> {
    let recent_header = MenuItem::with_id(app, "recent_header", "Recent", false, None::<&str>)?;

    let main_slice: Vec<&TrayRecentItem> = items.iter().take(RECENT_MAIN).collect();
    let more_slice: Vec<&TrayRecentItem> = items
        .iter()
        .skip(RECENT_MAIN)
        .take(RECENT_MORE)
        .collect();

    let empty_item = if main_slice.is_empty() {
        Some(MenuItem::with_id(
            app,
            "recent_empty",
            "No recent chats",
            false,
            None::<&str>,
        )?)
    } else {
        None
    };

    let mut main_task_items: Vec<MenuItem<tauri::Wry>> = Vec::with_capacity(main_slice.len());
    for item in &main_slice {
        let label = format_item_label(item);
        let id = format!("task:{}", item.id);
        main_task_items.push(MenuItem::with_id(app, id, label, true, None::<&str>)?);
    }

    let mut more_task_items: Vec<MenuItem<tauri::Wry>> = Vec::with_capacity(more_slice.len());
    for item in &more_slice {
        let label = format_item_label(item);
        let id = format!("task:{}", item.id);
        more_task_items.push(MenuItem::with_id(app, id, label, true, None::<&str>)?);
    }

    let more_sep = PredefinedMenuItem::separator(app)?;
    let open_all = MenuItem::with_id(
        app,
        "more_open_all",
        "Open all chats…",
        true,
        None::<&str>,
    )?;

    let mut more_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
    for item in &more_task_items {
        more_refs.push(item);
    }
    if !more_task_items.is_empty() {
        more_refs.push(&more_sep);
    }
    more_refs.push(&open_all);
    let more = Submenu::with_id_and_items(app, "more", "More", true, &more_refs)?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let new_chat = MenuItem::with_id(app, "new_chat", "New Chat", true, None::<&str>)?;
    let open_app = MenuItem::with_id(app, "open_app", "Open Aurevoy", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Aurevoy", true, None::<&str>)?;

    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&recent_header];
    if let Some(ref empty) = empty_item {
        refs.push(empty);
    } else {
        for item in &main_task_items {
            refs.push(item);
        }
    }
    refs.push(&more);
    refs.push(&sep1);
    refs.push(&new_chat);
    refs.push(&open_app);
    refs.push(&sep2);
    refs.push(&quit);

    Menu::with_items(app, &refs)
}

fn format_item_label(item: &TrayRecentItem) -> String {
    let title = truncate_chars(item.title.trim(), TITLE_MAX_CHARS);
    let title = if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    };
    match item
        .subtitle
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // 原生菜单无副标题行，用 " · " 贴近 ChatGPT 的两行信息。
        Some(sub) => format!("{}  ·  {}", title, truncate_chars(sub, 24)),
        None => title,
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let take = max.saturating_sub(1);
    let mut out: String = s.chars().take(take).collect();
    out.push('…');
    out
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => {
            app.exit(0);
        }
        "open_app" | "more_open_all" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_ACTION,
                TrayActionPayload {
                    action: "open".into(),
                    task_id: None,
                },
            );
        }
        "new_chat" => {
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_ACTION,
                TrayActionPayload {
                    action: "new-chat".into(),
                    task_id: None,
                },
            );
        }
        "recent_header" | "recent_empty" | "more" => {}
        other if other.starts_with("task:") => {
            let task_id = other.trim_start_matches("task:").to_string();
            if task_id.is_empty() {
                return;
            }
            show_main_window(app);
            let _ = app.emit(
                EVENT_TRAY_ACTION,
                TrayActionPayload {
                    action: "open-task".into(),
                    task_id: Some(task_id),
                },
            );
        }
        _ => {}
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
