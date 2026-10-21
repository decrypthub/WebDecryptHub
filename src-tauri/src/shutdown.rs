// 更新前停掉 sidecar 进程树。
// 在线更新在 Windows 上会由安装器替换 jsra-sidecar.exe / 捆绑 node.exe。
// tauri-plugin-updater 用 process::exit 退出，不会走到窗口 CloseRequested，
// 因此必须在拉起安装器之前自己把进程树停干净。
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// 先等优雅退出，再强制结束，最后仍然放行（安装器还会再试）。
pub const GRACE_MS: u64 = 8_000;
pub const FORCE_WAIT_MS: u64 = 4_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShutdownPlan {
    pub force: bool,
    pub proceed: bool,
}

pub fn shutdown_plan(elapsed_ms: u64, exited: bool) -> ShutdownPlan {
    if exited {
        return ShutdownPlan { force: false, proceed: true };
    }
    if elapsed_ms < GRACE_MS {
        ShutdownPlan { force: false, proceed: false }
    } else if elapsed_ms < GRACE_MS + FORCE_WAIT_MS {
        ShutdownPlan { force: true, proceed: false }
    } else {
        ShutdownPlan { force: true, proceed: true }
    }
}

fn normalize_path(path: &str) -> String {
    path.trim().trim_matches('"').replace('/', "\\")
}

fn dir_prefix(install_dir: &str) -> String {
    let mut dir = normalize_path(install_dir);
    while dir.ends_with('\\') {
        dir.pop();
    }
    if dir.is_empty() {
        return String::new();
    }
    dir.push('\\');
    dir
}

fn file_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

/// 安装目录里允许被结束的映像：主程序、sidecar、捆绑的 node.exe。
/// 路径必须落在安装目录内（带目录分隔符），避免误伤 WebDecryptHub-extra 或系统里的 node/Chrome。
pub fn is_install_dir_image(install_dir: &str, image: &str) -> bool {
    let prefix = dir_prefix(install_dir);
    if prefix.is_empty() {
        return false;
    }
    let image = normalize_path(image);
    if image.is_empty() || !image.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) {
        return false;
    }
    matches!(
        file_name(&image).to_ascii_lowercase().as_str(),
        "webdecrypthub.exe" | "jsra-sidecar.exe" | "node.exe"
    )
}

/// 自己的 pid 不能杀，否则还没来得及拉起安装器进程就没了。
pub fn should_terminate(install_dir: &str, image: &str, pid: u32, self_pid: u32) -> bool {
    pid != 0 && pid != self_pid && is_install_dir_image(install_dir, image)
}

pub fn pids_to_terminate(install_dir: &str, self_pid: u32, procs: &[(u32, &str)]) -> Vec<u32> {
    procs
        .iter()
        .filter(|(pid, image)| should_terminate(install_dir, image, *pid, self_pid))
        .map(|(pid, _)| *pid)
        .collect()
}

pub fn current_install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 文本帧。客户端必须掩码；本地回环用固定掩码即可。
pub fn ws_client_frame(payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x81);
    let n = payload.len();
    if n < 126 {
        out.push(0x80 | n as u8);
    } else if n < 65536 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    for (i, byte) in payload.iter().enumerate() {
        out.push(byte ^ mask[i % 4]);
    }
    out
}

pub fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id().to_string();
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid, "/T", "/F"]);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let _ = cmd.output();
        let _ = child.kill();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn reap_if_exited(sidecar: &Mutex<Option<Child>>) -> bool {
    let mut guard = sidecar.lock().unwrap();
    match guard.as_mut() {
        None => true,
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                true
            }
            _ => false,
        },
    }
}

fn force_kill_sidecar(sidecar: &Mutex<Option<Child>>) {
    {
        let mut guard = sidecar.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            kill_tree(child);
        }
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(2) {
        if reap_if_exited(sidecar) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn notify_sidecar_prepare_exit(port: u16) {
    if port == 0 {
        return;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(700)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    let req = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return;
    }
    let mut buf = [0u8; 2048];
    let mut seen = Vec::new();
    while seen.windows(4).all(|w| w != b"\r\n\r\n") && seen.len() < 4096 {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => seen.extend_from_slice(&buf[..n]),
        }
    }
    let payload = br#"{"type":"invoke","id":1,"channel":"prepare-exit","args":{}}"#;
    let _ = stream.write_all(&ws_client_frame(payload, [0x11, 0x22, 0x33, 0x44]));
}

fn list_processes() -> Vec<(u32, String)> {
    #[cfg(windows)]
    {
        windows_processes()
    }
    #[cfg(not(windows))]
    {
        linux_processes()
    }
}

#[cfg(not(windows))]
fn linux_processes() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for ent in entries.flatten() {
        let Some(pid) = ent.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if let Ok(path) = std::fs::read_link(ent.path().join("exe")) {
            out.push((pid, path.to_string_lossy().into_owned()));
        }
    }
    out
}

#[cfg(windows)]
fn windows_processes() -> Vec<(u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::PWSTR;

    let mut out = Vec::new();
    // HANDLE is Copy and does not close itself; both the snapshot and each process handle must be closed.
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(handle) => handle,
        Err(_) => return out,
    };
    unsafe {
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    let mut buf = vec![0u16; 32768];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok()
                    {
                        // On success `len` is the character count, not including the terminating NUL.
                        let n = (len as usize).min(buf.len());
                        let n = n.saturating_sub(usize::from(n > 0 && buf[n - 1] == 0));
                        if n > 0 {
                            out.push((pid, String::from_utf16_lossy(&buf[..n])));
                        }
                    }
                    let _ = CloseHandle(handle);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/F"]);
        cmd.creation_flags(0x0800_0000);
        let _ = cmd.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

pub fn terminate_install_dir(install_dir: &Path, self_pid: u32) {
    let dir = install_dir.to_string_lossy();
    for (pid, image) in list_processes() {
        if should_terminate(&dir, &image, pid, self_pid) {
            terminate_pid(pid);
        }
    }
}

fn wait_install_dir_clear(install_dir: &Path, self_pid: u32, budget: Duration) {
    let started = Instant::now();
    let dir = install_dir.to_string_lossy();
    while started.elapsed() < budget {
        let alive = list_processes()
            .into_iter()
            .any(|(pid, image)| should_terminate(&dir, &image, pid, self_pid));
        if !alive {
            return;
        }
        terminate_install_dir(install_dir, self_pid);
        thread::sleep(Duration::from_millis(200));
    }
}

/// 通知 sidecar 关掉浏览器、工作区任务和捆绑 Node，等到超时再按 PID 强制结束它的进程树，
/// 然后清掉安装目录里残留的 sidecar / node.exe。不按映像名全局结束，也不动其他 Chrome。
pub fn stop_sidecar_for_update(port: u16, sidecar: &Mutex<Option<Child>>, install_dir: &Path) {
    notify_sidecar_prepare_exit(port);
    let started = Instant::now();
    let mut forced = false;
    loop {
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let exited = reap_if_exited(sidecar);
        let plan = shutdown_plan(elapsed, exited);
        if plan.force && !forced {
            forced = true;
            force_kill_sidecar(sidecar);
            terminate_install_dir(install_dir, std::process::id());
        }
        if plan.proceed {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    terminate_install_dir(install_dir, std::process::id());
    wait_install_dir_clear(install_dir, std::process::id(), Duration::from_millis(1500));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_then_forces_then_proceeds() {
        assert_eq!(shutdown_plan(0, false), ShutdownPlan { force: false, proceed: false });
        assert_eq!(shutdown_plan(GRACE_MS - 1, false), ShutdownPlan { force: false, proceed: false });
        assert_eq!(shutdown_plan(GRACE_MS, false), ShutdownPlan { force: true, proceed: false });
        assert_eq!(
            shutdown_plan(GRACE_MS + FORCE_WAIT_MS - 1, false),
            ShutdownPlan { force: true, proceed: false }
        );
        assert_eq!(
            shutdown_plan(GRACE_MS + FORCE_WAIT_MS, false),
            ShutdownPlan { force: true, proceed: true }
        );
        assert_eq!(shutdown_plan(0, true), ShutdownPlan { force: false, proceed: true });
        assert_eq!(shutdown_plan(GRACE_MS + 10, true), ShutdownPlan { force: false, proceed: true });
    }

    #[test]
    fn only_install_dir_images_are_targets() {
        let dir = r"C:\Users\a\AppData\Local\WebDecryptHub";
        assert!(is_install_dir_image(dir, r"C:\Users\a\AppData\Local\WebDecryptHub\WebDecryptHub.exe"));
        assert!(is_install_dir_image(dir, r"C:\Users\a\AppData\Local\WebDecryptHub\jsra-sidecar.exe"));
        assert!(is_install_dir_image(
            dir,
            r"C:\Users\a\AppData\Local\WebDecryptHub\resources\node\node.exe"
        ));
        assert!(is_install_dir_image(dir, r"c:\users\a\appdata\local\webdecrypthub\JSRA-SIDECAR.EXE"));
        assert!(is_install_dir_image(dir, r"C:/Users/a/AppData/Local/WebDecryptHub/node.exe"));
        assert!(!is_install_dir_image(dir, r"C:\Users\a\AppData\Local\WebDecryptHub-extra\node.exe"));
        assert!(!is_install_dir_image(dir, r"C:\Program Files\nodejs\node.exe"));
        assert!(!is_install_dir_image(dir, r"C:\Program Files\Google\Chrome\Application\chrome.exe"));
        assert!(!is_install_dir_image(
            dir,
            r"C:\Users\a\AppData\Local\WebDecryptHub\uninstall.exe"
        ));
        assert!(!is_install_dir_image(dir, r"C:\Users\a\AppData\Local\WebDecryptHub\resources\node\npm.cmd"));
        assert!(!is_install_dir_image("", r"C:\WebDecryptHub.exe"));
        assert!(!is_install_dir_image(dir, ""));
    }

    #[test]
    fn does_not_terminate_self() {
        let dir = r"C:\Users\a\AppData\Local\WebDecryptHub";
        let procs = [
            (10u32, r"C:\Users\a\AppData\Local\WebDecryptHub\WebDecryptHub.exe"),
            (11, r"C:\Users\a\AppData\Local\WebDecryptHub\jsra-sidecar.exe"),
            (12, r"C:\Users\a\AppData\Local\WebDecryptHub\resources\node\node.exe"),
            (13, r"C:\Program Files\nodejs\node.exe"),
            (14, r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            (0, r"C:\Users\a\AppData\Local\WebDecryptHub\jsra-sidecar.exe"),
        ];
        assert_eq!(pids_to_terminate(dir, 10, &procs), vec![11, 12]);
    }

    #[test]
    fn websocket_frame_is_masked_text() {
        let frame = ws_client_frame(b"hi", [1, 2, 3, 4]);
        assert_eq!(frame[0], 0x81);
        assert_eq!(frame[1], 0x80 | 2);
        assert_eq!(&frame[2..6], &[1, 2, 3, 4]);
        assert_eq!(frame[6], b'h' ^ 1);
        assert_eq!(frame[7], b'i' ^ 2);
        let long = vec![b'a'; 200];
        let frame = ws_client_frame(&long, [9, 9, 9, 9]);
        assert_eq!(frame[1], 0x80 | 126);
        assert_eq!(&frame[2..4], &200u16.to_be_bytes());
    }
}
