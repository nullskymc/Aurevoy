use serde::Serialize;
use std::{
    env,
    fs,
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const AGENT_HOST: &str = "127.0.0.1";
const AGENT_PORT: u16 = 8787;
const AGENT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_HEALTH_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct AgentProcessState {
    child: Mutex<Option<ManagedAgentChild>>,
}

struct ManagedAgentChild {
    child: Child,
    command_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProcessStatus {
    pub base_url: String,
    pub mode: AgentProcessMode,
    pub running: bool,
    pub pid: Option<u32>,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentProcessMode {
    External,
    Managed,
    Unavailable,
}

impl Drop for AgentProcessState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut managed) = guard.take() {
                let _ = managed.child.kill();
                let _ = managed.child.wait();
            }
        }
    }
}

#[tauri::command]
pub fn ensure_agent_process(
    state: tauri::State<'_, AgentProcessState>,
) -> Result<AgentProcessStatus, String> {
    if agent_port_is_open() {
        return Ok(external_status());
    }

    if let Some(status) = current_managed_status(&state)? {
        return Ok(status);
    }

    let spec = resolve_agent_command()?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env("AUREVOY_HOST", AGENT_HOST)
        .env("AUREVOY_PORT", AGENT_PORT.to_string());
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 Agent 引擎失败：{err}"))?;

    // 捕获 agent 进程 stderr 便于诊断启动错误
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                if let Ok(line) = line {
                    eprintln!("[agent stderr] {}", line);
                }
            }
        });
    }

    let pid = child.id();
    let command_label = spec.label.clone();
    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| "Agent 进程状态锁已损坏".to_string())?;
        *guard = Some(ManagedAgentChild {
            child,
            command_label,
        });
    }

    if wait_for_agent_port() {
        return Ok(AgentProcessStatus {
            base_url: agent_base_url(),
            mode: AgentProcessMode::Managed,
            running: true,
            pid: Some(pid),
            message: format!("Agent 引擎已由桌面壳托管启动：{}", spec.label),
            error: None,
        });
    }

    stop_managed_child(&state)?;
    Ok(AgentProcessStatus {
        base_url: agent_base_url(),
        mode: AgentProcessMode::Unavailable,
        running: false,
        pid: None,
        message: "Agent 引擎启动后未在超时时间内响应".to_string(),
        error: Some("health check timeout".to_string()),
    })
}

#[tauri::command]
pub fn agent_process_status(
    state: tauri::State<'_, AgentProcessState>,
) -> Result<AgentProcessStatus, String> {
    if agent_port_is_open() {
        return Ok(external_status());
    }
    Ok(
        current_managed_status(&state)?.unwrap_or_else(|| AgentProcessStatus {
            base_url: agent_base_url(),
            mode: AgentProcessMode::Unavailable,
            running: false,
            pid: None,
            message: "Agent 引擎未运行".to_string(),
            error: None,
        }),
    )
}

fn current_managed_status(
    state: &tauri::State<'_, AgentProcessState>,
) -> Result<Option<AgentProcessStatus>, String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Agent 进程状态锁已损坏".to_string())?;

    let Some(managed) = guard.as_mut() else {
        return Ok(None);
    };

    match managed.child.try_wait() {
        Ok(None) => Ok(Some(AgentProcessStatus {
            base_url: agent_base_url(),
            mode: AgentProcessMode::Managed,
            running: true,
            pid: Some(managed.child.id()),
            message: format!("Agent 引擎子进程运行中：{}", managed.command_label),
            error: None,
        })),
        Ok(Some(status)) => {
            let label = managed.command_label.clone();
            *guard = None;
            Ok(Some(AgentProcessStatus {
                base_url: agent_base_url(),
                mode: AgentProcessMode::Unavailable,
                running: false,
                pid: None,
                message: format!("Agent 引擎子进程已退出：{label}"),
                error: Some(status.to_string()),
            }))
        }
        Err(err) => Ok(Some(AgentProcessStatus {
            base_url: agent_base_url(),
            mode: AgentProcessMode::Unavailable,
            running: false,
            pid: None,
            message: "无法读取 Agent 引擎子进程状态".to_string(),
            error: Some(err.to_string()),
        })),
    }
}

fn stop_managed_child(state: &tauri::State<'_, AgentProcessState>) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "Agent 进程状态锁已损坏".to_string())?;

    if let Some(mut managed) = guard.take() {
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }
    Ok(())
}

struct AgentCommandSpec {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    label: String,
    env: Vec<(String, String)>,
}

/// 返回打包后的 Resources 目录，平台感知。
///
/// macOS:   Aurevoy.app/Contents/Resources/
/// Windows: <exe_dir>/resources/
/// Linux:   <exe_dir>/resources/
fn resources_dir() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    #[cfg(target_os = "macos")]
    {
        // Aurevoy.app/Contents/MacOS/desktop → Aurevoy.app/Contents/Resources
        exe.parent()?.parent().map(|p| p.join("Resources"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows / Linux: resources 与可执行文件平级（NSIS/AppImage/Deb 打包行为）
        exe.parent().map(PathBuf::from)
    }
}

/// 确保安装版数据目录存在（~/.aurevoy/ 及其子目录）。
/// 失败不阻塞启动 —— 目录可能已存在或由 Agent 自行创建。
fn ensure_data_dirs() {
    let Some(home) = dirs_next() else {
        eprintln!("[agent_process] 无法获取用户主目录，跳过数据目录创建");
        return;
    };
    let base = home.join(".aurevoy");
    let dirs = [
        base.clone(),
        base.join("workspace"),
        base.join("logs"),
        base.join("skills"),
    ];
    for dir in &dirs {
        if let Err(err) = fs::create_dir_all(dir) {
            eprintln!(
                "[agent_process] 创建数据目录失败 {}：{err}",
                dir.display()
            );
        }
    }
}

/// 获取用户主目录
fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // macOS: 直接读 HOME 环境变量（最可靠）
        if let Ok(home) = env::var("HOME") {
            let p = PathBuf::from(home);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = env::var("HOME") {
            let p = PathBuf::from(home);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = env::var("USERPROFILE") {
            let p = PathBuf::from(home);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn resolve_agent_command() -> Result<AgentCommandSpec, String> {
    if let Ok(path) = env::var("AUREVOY_AGENT_SIDECAR") {
        let program = PathBuf::from(path);
        let cwd = program
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok(AgentCommandSpec {
            label: program.display().to_string(),
            program,
            args: Vec::new(),
            cwd,
            env: Vec::new(),
        });
    }

    if cfg!(debug_assertions) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .map_err(|err| format!("无法定位仓库根目录：{err}"))?;
        return Ok(AgentCommandSpec {
            program: PathBuf::from(npm_program()),
            args: vec!["run".to_string(), "dev:agent".to_string()],
            cwd: repo_root,
            label: "npm run dev:agent".to_string(),
            env: Vec::new(),
        });
    }

    // 生产模式：确保用户数据目录存在，再查找 Resources/agent-dist/index.js
    ensure_data_dirs();
    let resources = resources_dir()
        .ok_or_else(|| "无法定位应用资源目录".to_string())?;
    let agent_entry = resources.join("agent-dist").join("index.js");
    if !agent_entry.exists() {
        return Err(
            "未找到 Agent 引擎。请确保 Node.js 已安装，或设置 AUREVOY_AGENT_SIDECAR 指向 Agent 可执行文件。"
                .to_string(),
        );
    }
    let node = find_node().unwrap_or_else(|| PathBuf::from("node"));
    Ok(AgentCommandSpec {
        program: node.clone(),
        args: vec![agent_entry.to_string_lossy().to_string()],
        cwd: resources.join("agent-dist"),
        label: format!("{} {}", node.display(), agent_entry.display()),
        env: Vec::new(),
    })
}

/// 查找 Node.js 可执行文件，优先使用打包内置的版本。
fn find_node() -> Option<PathBuf> {
    // 1. 优先使用 App 内置的 Node.js（保证 ABI 兼容）
    if let Some(resources) = resources_dir() {
        let node_name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let bundled = resources.join("node-runtime").join("bin").join(node_name);
        if bundled.exists() {
            eprintln!("[agent_process] using bundled Node.js: {}", bundled.display());
            return Some(bundled);
        }
    }
    // 2. 回退到系统安装的 Node.js
    find_system_node()
}

/// 搜索系统安装的 Node.js 可执行文件。
fn find_system_node() -> Option<PathBuf> {
    find_system_node_impl()
}

#[cfg(target_os = "macos")]
fn find_system_node_impl() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/local/bin/node",
    ];
    for path in &candidates {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    which_node_via_shell("command -v node")
}

#[cfg(target_os = "windows")]
fn find_system_node_impl() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        r"C:\ProgramData\chocolatey\lib\nodejs\tools\node.exe",
    ];
    for path in &candidates {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    which_node_via_shell("where node")
}

#[cfg(target_os = "linux")]
fn find_system_node_impl() -> Option<PathBuf> {
    let candidates = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/home/linuxbrew/.linuxbrew/bin/node",
        "/snap/bin/node",
    ];
    for path in &candidates {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").ok()?;
    let user_paths = [
        format!("{home}/.local/share/fnm/node-versions/latest/installation/bin/node"),
        format!("{home}/.nvm/versions/node/current/bin/node"),
    ];
    for path in &user_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    which_node_via_shell("command -v node")
}

/// 通过 shell 命令（command -v / where）查找 node 可执行文件。
fn which_node_via_shell(shell_cmd: &str) -> Option<PathBuf> {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "windows") {
        ("cmd", &["/c", shell_cmd])
    } else {
        ("/bin/sh", &["-c", shell_cmd])
    };
    if let Ok(output) = std::process::Command::new(program).args(args).output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .trim()
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

fn wait_for_agent_port() -> bool {
    let started = Instant::now();
    while started.elapsed() < AGENT_STARTUP_TIMEOUT {
        if agent_port_is_open() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn agent_port_is_open() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], AGENT_PORT));
    TcpStream::connect_timeout(&address, AGENT_HEALTH_TIMEOUT).is_ok()
}

fn external_status() -> AgentProcessStatus {
    AgentProcessStatus {
        base_url: agent_base_url(),
        mode: AgentProcessMode::External,
        running: true,
        pid: None,
        message: "检测到已有 Agent 引擎在线，桌面壳将复用该进程".to_string(),
        error: None,
    }
}

fn agent_base_url() -> String {
    format!("http://{AGENT_HOST}:{AGENT_PORT}")
}

fn npm_program() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}
