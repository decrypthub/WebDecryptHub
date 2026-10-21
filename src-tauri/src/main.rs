#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

const KEYRING_SERVICE: &str = "com.webdecrypthub.app";
const LEGACY_KEYRING_SERVICE: &str = "com.niying.jsra";
const KEYRING_USER: &str = "llm-api-key";

struct AppState {
    port: Arc<Mutex<u16>>,
    sidecar: Arc<Mutex<Option<Child>>>,
    running: Arc<Mutex<bool>>,
}


fn sidecar_path() -> std::path::PathBuf {
    let name = if cfg!(windows) { "jsra-sidecar.exe" } else { "jsra-sidecar-linux" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [dir.join(name), dir.join("resources").join(name), dir.join("..").join("lib").join("jsra-tauri").join(name)] {
                if cand.exists() { return cand; }
            }
        }
    }
    std::path::PathBuf::from(format!("../build/{}", name))
}

// 端口由 sidecar 自己绑定 127.0.0.1:0（无竞态），启动后在 stdout 打印 JSRA_PORT=N，这里读出写入共享状态。
// 每次（重）启动都换新端口，旧端口被占用也不会陷入重启循环。
fn spawn_sidecar(port: &Arc<Mutex<u16>>) -> std::io::Result<Child> {
    let sc = sidecar_path();
    *port.lock().unwrap() = 0;
    let mut cmd = Command::new(&sc);
    cmd.env("JSRA_WS_PORT", "0")
        .env("JSRA_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹出控制台窗口
    }
    let mut child = cmd.spawn()?;
    if let Some(out) = child.stdout.take() {
        let p = port.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines() {
                let Ok(l) = line else { break };
                if let Some(v) = l.trim().strip_prefix("JSRA_PORT=") { if let Ok(n) = v.parse::<u16>() { *p.lock().unwrap() = n; } }
            }
        });
    }
    Ok(child)
}

#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    let _ = child.kill();
}
#[cfg(not(windows))]
fn kill_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn secret_set(value: String) -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        Ok(e) => e.set_password(&value).map_err(|err| err.to_string()),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
fn secret_get() -> Result<String, String> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        Ok(e) => match e.get_password() {
            Ok(p) => Ok(p),
            Err(keyring::Error::NoEntry) => {
                // 从 1.0.0（逆影）迁移已保存的密钥
                if let Ok(old) = keyring::Entry::new(LEGACY_KEYRING_SERVICE, KEYRING_USER) {
                    if let Ok(p) = old.get_password() {
                        let _ = e.set_password(&p);
                        let _ = old.delete_credential();
                        return Ok(p);
                    }
                }
                Ok(String::new())
            }
            Err(err) => Err(err.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
fn secret_clear() -> Result<(), String> {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = e.delete_credential();
    }
    Ok(())
}

// 原生保存对话框（导出 HAR 等）。必须是 async 命令，否则阻塞式对话框会在主线程上死锁
#[tauri::command]
async fn pick_save_path(app: tauri::AppHandle, default_name: String, filter_name: String, ext: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let exts = [ext.as_str()];
    app.dialog().file().set_title("导出").set_file_name(&default_name).add_filter(&filter_name, &exts)
        .blocking_save_file().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn get_ws_port(state: State<AppState>) -> u16 { *state.port.lock().unwrap() }

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "WebDecryptHub",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "keyringBackend": if cfg!(windows) { "Windows DPAPI (凭据管理器)" } else if cfg!(target_os="macos") { "macOS Keychain" } else { "Secret Service" },
    })
}

#[tauri::command]
fn restart_sidecar(state: State<AppState>) -> Result<(), String> {
    let mut guard = state.sidecar.lock().unwrap();
    if let Some(mut c) = guard.take() { kill_tree(&mut c); }
    match spawn_sidecar(&state.port) {
        Ok(c) => { *guard = Some(c); Ok(()) }
        Err(e) => Err(format!("重启逻辑进程失败: {}", e)),
    }
}

fn main() {
    let port: Arc<Mutex<u16>> = Arc::new(Mutex::new(0));
    let sidecar = Arc::new(Mutex::new(None));
    let running = Arc::new(Mutex::new(true));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { port: port.clone(), sidecar: sidecar.clone(), running: running.clone() })
        .invoke_handler(tauri::generate_handler![secret_set, secret_get, secret_clear, get_ws_port, app_info, restart_sidecar, pick_save_path])
        .setup(move |app| {
            match spawn_sidecar(&port) {
                Ok(c) => { *sidecar.lock().unwrap() = Some(c); }
                Err(e) => { eprintln!("启动逻辑进程失败: {}", e); }
            }
            // 崩溃自动重启监督线程
            let sc = sidecar.clone();
            let run = running.clone();
            let sp = port.clone();
            std::thread::spawn(move || {
                let mut fails: u32 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    if !*run.lock().unwrap() { break; }
                    let mut g = sc.lock().unwrap();
                    let dead = match g.as_mut() {
                        Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                        None => true,
                    };
                    if dead {
                        // 指数退避，避免异常时疯狂重启
                        fails += 1;
                        if fails > 1 { drop(g); std::thread::sleep(std::time::Duration::from_millis((500u64 << fails.min(5)).min(15000))); g = sc.lock().unwrap(); }
                        if let Ok(c) = spawn_sidecar(&sp) { *g = Some(c); }
                    } else if *sp.lock().unwrap() != 0 { fails = 0; }
                }
            });
            let shot = std::env::var("JSRA_SHOT").unwrap_or_default();
            let skip = matches!(std::env::var("JSRA_SKIP_ONBOARD").unwrap_or_default().trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes");
            let shoturl = std::env::var("JSRA_SHOT_URL").unwrap_or_default();
            let pulse = if shot.is_empty() { String::new() } else { "try{setInterval(function(){var b=document.body;if(b){b.style.outline=b.style.outline?'':'1px solid transparent';window.dispatchEvent(new Event('resize'));}},300);}catch(e){}".to_string() };
            let init = format!("window.__JSRA_WS_PORT = 0; window.__JSRA_NATIVE = true; window.__JSRA_SHOT = {:?}; window.__JSRA_SKIP_ONBOARD = {}; window.__JSRA_DEBUG = {}; window.__JSRA_SHOT_URL = {:?};{}", shot, skip, if std::env::var("JSRA_DEBUG").is_ok() { "true" } else { "false" }, shoturl, pulse);
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("WebDecryptHub · JS 逆向工作台")
                .inner_size(1560.0, 980.0)
                .min_inner_size(1080.0, 680.0)
                .decorations(false)
                .shadow(true)
                .center()
                .initialization_script(&init)
                // WebView2 新版 Chromium 的“本地网络访问”检查会拦截页面到 127.0.0.1 sidecar 的 WebSocket；保留 Tauri 默认禁用项并追加关闭
                .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights");
            if std::env::var("JSRA_MAXIMIZE").is_ok() { b = b.maximized(true); }
            let win = b.build()?;
            if !shot.is_empty() {
                let w = win.clone();
                std::thread::spawn(move || {
                    for i in 0..6 {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        let _ = w.set_size(tauri::LogicalSize::new(1540.0, 960.0 + (i as f64)));
                        let _ = w.set_focus();
                    }
                });
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state: State<AppState> = window.state();
                { *state.running.lock().unwrap() = false; }
                let child = { state.sidecar.lock().unwrap().take() };
                if let Some(mut c) = child { kill_tree(&mut c); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
