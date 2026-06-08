mod agent_process;

use agent_process::{agent_process_status, ensure_agent_process, AgentProcessState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AgentProcessState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_agent_process,
            agent_process_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
