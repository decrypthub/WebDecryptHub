#![cfg_attr(not(windows), allow(dead_code))]
// 原生嵌入：把会话的真实有头 Chrome 顶层窗口变成主窗口的子窗口，覆盖在左侧浏览器面板上。
// 结构：主窗口 → 每会话一个“宿主”子窗口(= 面板矩形，负责裁剪) → Chrome 顶层窗口(去边框，向上/左偏移 inset，
// 把 Chrome 自带标签栏/地址栏裁掉，只露出网页内容)。
// Windows: Win32 (EnumWindows by PID + SetParent + WS_CHILD)；Linux X11: Xlib (_NET_WM_PID + XReparentWindow)。
// 所有原生调用都在主线程执行（同步 tauri 命令本来就在主线程；定时同步用 run_on_main_thread）。
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Default, serde::Deserialize)]
pub struct CssRect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }
#[derive(Clone, Copy, Debug, PartialEq, Default, serde::Deserialize)]
pub struct CssInset { pub top: f64, pub left: f64, pub right: f64, pub bottom: f64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct PxRect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }

/// 面板 CSS 矩形 → 主窗口客户区物理像素（宿主窗口位置）。宽高用两端取整后相减，避免 1px 缝隙
pub fn host_rect(r: CssRect, dpr: f64) -> PxRect {
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let x0 = (r.x * d).round() as i32; let y0 = (r.y * d).round() as i32;
    let x1 = ((r.x + r.w) * d).round() as i32; let y1 = ((r.y + r.h) * d).round() as i32;
    PxRect { x: x0, y: y0, w: (x1 - x0).max(1), h: (y1 - y0).max(1) }
}
/// Chrome 窗口在宿主内的位置：向左上偏移 inset，使内容区正好填满宿主
pub fn chrome_rect(host: PxRect, inset: CssInset, dpr: f64) -> PxRect {
    let d = if dpr.is_finite() && dpr > 0.0 { dpr } else { 1.0 };
    let c = |v: f64| (v.max(0.0).min(400.0) * d).round() as i32;
    let (t, l, r, b) = (c(inset.top), c(inset.left), c(inset.right), c(inset.bottom));
    PxRect { x: -l, y: -t, w: host.w + l + r, h: host.h + t + b }
}

// Win32 样式位（与 windows crate 常量一致，写成纯函数以便在 Linux 上单测）
pub const WS_CHILD: u32 = 0x4000_0000; pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_CAPTION: u32 = 0x00C0_0000; pub const WS_THICKFRAME: u32 = 0x0004_0000;
pub const WS_SYSMENU: u32 = 0x0008_0000; pub const WS_MINIMIZEBOX: u32 = 0x0002_0000; pub const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
pub const WS_MINIMIZE: u32 = 0x2000_0000; pub const WS_MAXIMIZE: u32 = 0x0100_0000;
pub const WS_CLIPSIBLINGS: u32 = 0x0400_0000; pub const WS_CLIPCHILDREN: u32 = 0x0200_0000;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000; pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_WINDOWEDGE: u32 = 0x0000_0100; pub const WS_EX_CLIENTEDGE: u32 = 0x0000_0200; pub const WS_EX_DLGMODALFRAME: u32 = 0x0000_0001;
pub fn child_style(s: u32) -> u32 {
    (s & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MINIMIZE | WS_MAXIMIZE)) | WS_CHILD | WS_CLIPSIBLINGS
}
pub fn child_exstyle(e: u32) -> u32 { (e & !(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME)) | WS_EX_TOOLWINDOW }

struct Entry { pid: u32, host: u64, wins: Vec<u64> }
#[derive(Default)]
pub struct EmbedState { entries: HashMap<String, Entry>, focused: Option<String>, rect: PxRect, inset: CssInset, dpr: f64, visible: bool }
pub static STATE: Mutex<Option<EmbedState>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut EmbedState) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(EmbedState::default))
}

fn parent_of(win: &tauri::WebviewWindow) -> Result<u64, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let h = win.window_handle().map_err(|e| e.to_string())?;
    match h.as_raw() {
        #[cfg(windows)] RawWindowHandle::Win32(w) => Ok(w.hwnd.get() as u64),
        RawWindowHandle::Xlib(x) => Ok(x.window as u64),
        RawWindowHandle::Xcb(x) => Ok(x.window.get() as u64),
        _ => Err("当前窗口系统不支持原生嵌入（需要 Win32 或 X11）".into()),
    }
}

/// 显示某会话的 Chrome（必要时先找到并收养窗口），隐藏其它会话
pub fn show(win: &tauri::WebviewWindow, sid: &str, pid: u32, rect: CssRect, dpr: f64, inset: CssInset) -> Result<serde_json::Value, String> {
    let parent = parent_of(win)?;
    let hr = host_rect(rect, dpr);
    with(|st| {
        st.rect = hr; st.inset = inset; st.dpr = dpr; st.visible = true; st.focused = Some(sid.to_string());
        if st.entries.get(sid).map(|e| e.pid != pid || !imp::alive(e.host)).unwrap_or(false) {
            if let Some(e) = st.entries.remove(sid) { imp::destroy_host(e.host); }
        }
        if !st.entries.contains_key(sid) {
            let host = imp::create_host(parent)?;
            st.entries.insert(sid.to_string(), Entry { pid, host, wins: vec![] });
        }
        adopt_new(st, sid);
        let e = st.entries.get(sid).unwrap();
        if e.wins.is_empty() { return Err(format!("未找到 PID {} 的 Chrome 顶层窗口", pid)); }
        apply(st);
        Ok(serde_json::json!({ "host": hr.w.to_string() + "x" + &hr.h.to_string(), "windows": st.entries[sid].wins.len() }))
    })
}

fn adopt_new(st: &mut EmbedState, sid: &str) {
    let Some(e) = st.entries.get_mut(sid) else { return };
    e.wins.retain(|w| imp::alive(*w));
    for w in imp::find_top_windows(e.pid) {
        if !e.wins.contains(&w) && imp::adopt(e.host, w).is_ok() { e.wins.push(w); }
    }
}

fn apply(st: &EmbedState) {
    let cr = chrome_rect(st.rect, st.inset, st.dpr);
    for (id, e) in &st.entries {
        let on = st.visible && st.focused.as_deref() == Some(id.as_str());
        if on {
            imp::place(e.host, st.rect);
            // 最新收养的窗口(弹出窗口)叠在最上面
            for w in &e.wins { imp::place(*w, cr); imp::raise(*w); }
        }
        imp::set_visible(e.host, on);
    }
}

/// 隐藏全部（覆盖层打开/无运行中的会话/回落 screencast）
pub fn hide_all() { with(|st| { st.visible = false; apply(st); }); }
/// 会话浏览器关闭：销毁宿主
pub fn release(sid: &str) { with(|st| { if let Some(e) = st.entries.remove(sid) { imp::destroy_host(e.host); } }); }
/// 定时：收养新弹出的 Chrome 窗口、清理已关闭窗口、保持几何（主线程调用）
pub static REMAPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub fn tick() {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    with(|st| {
        let ids: Vec<String> = if n % 20 == 0 { st.entries.keys().cloned().collect() } else { vec![] }; // 收养/清理约每 600ms
        let mut changed = false;
        for id in &ids { let n = st.entries[id].wins.len(); adopt_new(st, id); if st.entries[id].wins.len() != n { changed = true; } }
        if changed { apply(st); }
        // 看门狗：收养时我们 unmap 了 WM 管理中的 Chrome 窗口，WM 会异步“撤销管理”（ICCCM withdraw：
        // 把窗口 reparent 回根窗口并/或 unmap）。若这一步晚于我们的 XReparentWindow，结果是 Chrome 留在宿主里但未映射（黑屏），
        // 或被挪回根窗口盖在应用上。每 ~150ms 检查一次，未映射则重新映射并放回原位。
        if n % 5 == 0 && st.visible {
            if let Some(e) = st.focused.as_deref().and_then(|f| st.entries.get(f)) {
                let cr = chrome_rect(st.rect, st.inset, st.dpr);
                for w in &e.wins { if imp::ensure_embedded(e.host, *w) { imp::place(*w, cr); imp::raise(*w); REMAPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed); eprintln!("[embed] re-embedded 0x{:x}", w); } }
            }
        }
        imp::focus_follow(st.entries.get(st.focused.as_deref().unwrap_or("")).filter(|_| st.visible).map(|e| (e.host, e.wins.clone())));
    });
}

// ------------------------------------------------------------------ Windows
#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{w, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::*;

    fn h(v: u64) -> HWND { HWND(v as isize as *mut core::ffi::c_void) }
    pub fn alive(v: u64) -> bool { unsafe { IsWindow(Some(h(v))).as_bool() } }
    pub fn create_host(parent: u64) -> Result<u64, String> {
        unsafe {
            let hw = CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("WDH-EmbedHost"),
                WINDOW_STYLE(super::WS_CHILD | super::WS_CLIPCHILDREN | super::WS_CLIPSIBLINGS), 0, 0, 10, 10, Some(h(parent)), None, None, None)
                .map_err(|e| format!("CreateWindowEx: {}", e))?;
            Ok(hw.0 as isize as u64)
        }
    }
    pub fn destroy_host(v: u64) { unsafe { let _ = DestroyWindow(h(v)); } }
    struct Ctx { pid: u32, out: Vec<u64> }
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let ctx = &mut *(lp.0 as *mut Ctx);
        let mut pid = 0u32; GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != ctx.pid { return true.into(); }
        let mut buf = [0u16; 64]; let n = GetClassNameW(hwnd, &mut buf);
        if String::from_utf16_lossy(&buf[..n.max(0) as usize]) != "Chrome_WidgetWin_1" { return true.into(); }
        // 只要浏览器主框架：无 owner、有标题栏/可调边框（菜单、下拉、提示气泡等是 WS_POPUP 且有 owner）
        if GetWindow(hwnd, GW_OWNER).map(|o| !o.0.is_null()).unwrap_or(false) { return true.into(); }
        let st = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        if st & (super::WS_CAPTION | super::WS_THICKFRAME) == 0 { return true.into(); }
        let mut r = RECT::default(); let _ = GetWindowRect(hwnd, &mut r);
        if r.right - r.left < 150 || r.bottom - r.top < 100 { return true.into(); }
        ctx.out.push(hwnd.0 as isize as u64);
        true.into()
    }
    pub fn find_top_windows(pid: u32) -> Vec<u64> {
        let mut ctx = Ctx { pid, out: vec![] };
        unsafe { let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize)); }
        ctx.out
    }
    pub fn adopt(host: u64, v: u64) -> Result<(), String> {
        unsafe {
            let hw = h(v);
            let _ = ShowWindow(hw, SW_HIDE);
            let st = GetWindowLongPtrW(hw, GWL_STYLE) as u32;
            let ex = GetWindowLongPtrW(hw, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(hw, GWL_STYLE, super::child_style(st) as isize);
            SetWindowLongPtrW(hw, GWL_EXSTYLE, super::child_exstyle(ex) as isize);
            SetParent(hw, Some(h(host))).map_err(|e| format!("SetParent: {}", e))?;
            SetWindowPos(hw, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE).map_err(|e| e.to_string())?;
            let _ = ShowWindow(hw, SW_SHOWNA);
            Ok(())
        }
    }
    pub fn place(v: u64, r: PxRect) {
        unsafe { let _ = SetWindowPos(h(v), Some(HWND_TOP), r.x, r.y, r.w, r.h, SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS); }
    }
    pub fn raise(v: u64) { unsafe { let _ = SetWindowPos(h(v), Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS); } }
    pub fn set_visible(v: u64, on: bool) { unsafe { let _ = ShowWindow(h(v), if on { SW_SHOWNA } else { SW_HIDE }); } }
    pub fn ensure_embedded(host: u64, v: u64) -> bool { unsafe { if GetParent(h(v)).ok() != Some(h(host)) { let _ = adopt(host, v); return true; } if IsWindowVisible(h(v)).as_bool() { false } else { let _ = ShowWindow(h(v), SW_SHOWNA); true } } }
    pub fn focus_follow(_cur: Option<(u64, Vec<u64>)>) {} // Win32 子窗口点击即获得焦点（SetParent 后输入队列已关联）
}

// ------------------------------------------------------------------ Linux X11 (Xlib 动态加载)
#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::os::raw::{c_int, c_uchar, c_uint, c_ulong};
    use x11_dl::xlib;

    struct X { xl: xlib::Xlib, d: *mut xlib::Display, pid_atom: c_ulong, _xi: Option<x11_dl::xinput2::XInput2> }
    thread_local! { static XC: std::cell::RefCell<Option<X>> = const { std::cell::RefCell::new(None) }; }
    unsafe extern "C" fn quiet(_: *mut xlib::Display, _: *mut xlib::XErrorEvent) -> c_int { 0 }

    /// 在独立 Display 连接上执行，期间临时替换 Xlib 错误处理器（BadWindow 不致命），结束后恢复 GDK 的处理器
    fn x<R: Default>(f: impl FnOnce(&X) -> R) -> R {
        XC.with(|c| {
            let mut c = c.borrow_mut();
            if c.is_none() {
                let Ok(xl) = xlib::Xlib::open() else { return R::default() };
                let d = unsafe { (xl.XOpenDisplay)(std::ptr::null()) };
                if d.is_null() { return R::default(); }
                let pid_atom = unsafe { (xl.XInternAtom)(d, c"_NET_WM_PID".as_ptr(), 0) };
                // XInput2 原始按键事件：任何客户端都可订阅，不受 Chrome 已占用 ButtonPress 的限制；用于可靠的点击聚焦
                let xi = x11_dl::xinput2::XInput2::open().ok().filter(|xi| unsafe {
                    let (mut op, mut ev, mut er) = (0, 0, 0);
                    if (xl.XQueryExtension)(d, c"XInputExtension".as_ptr(), &mut op, &mut ev, &mut er) == 0 { return false; }
                    let (mut ma, mut mi) = (2, 0);
                    if (xi.XIQueryVersion)(d, &mut ma, &mut mi) != 0 { return false; }
                    let mut bits = [0u8; 4];
                    bits[(x11_dl::xinput2::XI_RawButtonPress >> 3) as usize] |= 1 << (x11_dl::xinput2::XI_RawButtonPress & 7);
                    let mut m = x11_dl::xinput2::XIEventMask { deviceid: x11_dl::xinput2::XIAllMasterDevices, mask_len: 4, mask: bits.as_mut_ptr() };
                    (xi.XISelectEvents)(d, (xl.XDefaultRootWindow)(d), &mut m, 1) == 0
                });
                *c = Some(X { xl, d, pid_atom, _xi: xi });
            }
            let xx = c.as_ref().unwrap();
            unsafe {
                let old = (xx.xl.XSetErrorHandler)(Some(quiet));
                let r = f(xx);
                (xx.xl.XSync)(xx.d, 0);
                (xx.xl.XSetErrorHandler)(old);
                r
            }
        })
    }
    unsafe fn pid_of(xx: &X, w: c_ulong) -> Option<u32> {
        let (mut at, mut fmt, mut n, mut after, mut data) = (0, 0, 0, 0, std::ptr::null_mut::<c_uchar>());
        let ok = (xx.xl.XGetWindowProperty)(xx.d, w, xx.pid_atom, 0, 1, 0, xlib::XA_CARDINAL, &mut at, &mut fmt, &mut n, &mut after, &mut data);
        let r = if ok == 0 && !data.is_null() && n == 1 && fmt == 32 { Some(*(data as *const c_ulong) as u32) } else { None };
        if !data.is_null() { (xx.xl.XFree)(data as *mut _); }
        r
    }
    unsafe fn children(xx: &X, w: c_ulong) -> Vec<c_ulong> {
        let (mut root, mut par, mut kids, mut n) = (0, 0, std::ptr::null_mut(), 0 as c_uint);
        if (xx.xl.XQueryTree)(xx.d, w, &mut root, &mut par, &mut kids, &mut n) == 0 { return vec![]; }
        let v = if kids.is_null() { vec![] } else { std::slice::from_raw_parts(kids, n as usize).to_vec() };
        if !kids.is_null() { (xx.xl.XFree)(kids as *mut _); }
        v
    }
    pub fn alive(v: u64) -> bool {
        x(|xx| unsafe { let mut a: xlib::XWindowAttributes = std::mem::zeroed(); (xx.xl.XGetWindowAttributes)(xx.d, v as c_ulong, &mut a) != 0 })
    }
    pub fn create_host(parent: u64) -> Result<u64, String> {
        let w = x(|xx| unsafe {
            let w = (xx.xl.XCreateSimpleWindow)(xx.d, parent as c_ulong, 0, 0, 10, 10, 0, 0, 0);
            (xx.xl.XFlush)(xx.d); w as u64
        });
        if w == 0 { Err("XCreateSimpleWindow 失败（无 X11 显示？）".into()) } else { Ok(w) }
    }
    pub fn destroy_host(v: u64) { x(|xx| unsafe { (xx.xl.XDestroyWindow)(xx.d, v as c_ulong); }) }
    /// 根窗口下(含 WM 框架内一层)带 _NET_WM_PID=pid 的大尺寸窗口 = Chrome 浏览器框架
    pub fn find_top_windows(pid: u32) -> Vec<u64> {
        x(|xx| unsafe {
            let root = (xx.xl.XDefaultRootWindow)(xx.d);
            let mut out = vec![];
            for top in children(xx, root) {
                let mut cands = vec![top]; cands.extend(children(xx, top));
                for w in cands {
                    if pid_of(xx, w) != Some(pid) { continue; }
                    let mut a: xlib::XWindowAttributes = std::mem::zeroed();
                    if (xx.xl.XGetWindowAttributes)(xx.d, w, &mut a) == 0 { continue; }
                    if a.override_redirect != 0 || a.width < 150 || a.height < 100 || a.class != xlib::InputOutput { continue; }
                    // 只收养 Chrome 已映射（已首帧/已被 WM 管理）的窗口：Chrome 启动时会创建同 PID 的隐藏辅助窗口，
                    // 收养它会把空白窗口叠在页面上；过早收养真正的窗口也会与 WM 的首次管理竞争
                    if a.map_state != xlib::IsViewable { continue; }
                    out.push(w as u64);
                }
            }
            out
        })
    }
    pub fn adopt(host: u64, v: u64) -> Result<(), String> {
        x(|xx| unsafe {
            (xx.xl.XUnmapWindow)(xx.d, v as c_ulong);
            (xx.xl.XSync)(xx.d, 0);
            (xx.xl.XReparentWindow)(xx.d, v as c_ulong, host as c_ulong, 0, 0);
            (xx.xl.XMapWindow)(xx.d, v as c_ulong);
            (xx.xl.XFlush)(xx.d);
        });
        Ok(())
    }
    pub fn ensure_embedded(host: u64, v: u64) -> bool {
        x(|xx| unsafe {
            let mut a: xlib::XWindowAttributes = std::mem::zeroed();
            if (xx.xl.XGetWindowAttributes)(xx.d, v as c_ulong, &mut a) == 0 { return false; }
            let (mut root, mut par, mut kids, mut n) = (0, 0, std::ptr::null_mut(), 0 as c_uint);
            if (xx.xl.XQueryTree)(xx.d, v as c_ulong, &mut root, &mut par, &mut kids, &mut n) == 0 { return false; }
            if !kids.is_null() { (xx.xl.XFree)(kids as *mut _); }
            if par != host as c_ulong { (xx.xl.XReparentWindow)(xx.d, v as c_ulong, host as c_ulong, 0, 0); (xx.xl.XMapWindow)(xx.d, v as c_ulong); return true; }
            if a.map_state == xlib::IsUnmapped { (xx.xl.XMapWindow)(xx.d, v as c_ulong); return true; }
            false
        })
    }
    pub fn place(v: u64, r: PxRect) { x(|xx| unsafe { (xx.xl.XMoveResizeWindow)(xx.d, v as c_ulong, r.x, r.y, r.w.max(1) as c_uint, r.h.max(1) as c_uint); }) }
    pub fn raise(v: u64) { x(|xx| unsafe { (xx.xl.XRaiseWindow)(xx.d, v as c_ulong); }) }
    pub fn set_visible(v: u64, on: bool) { x(|xx| unsafe { if on { (xx.xl.XMapRaised)(xx.d, v as c_ulong); } else { (xx.xl.XUnmapWindow)(xx.d, v as c_ulong); } }) }
    /// X11 下被收养的窗口不再由 WM 管理，点击不会自动获得键盘焦点：按下鼠标时根据指针位置切换输入焦点
    pub fn focus_follow(cur: Option<(u64, Vec<u64>)>) {
        let Some((host, wins)) = cur else { return };
        let Some(&top) = wins.last() else { return };
        x(|xx| unsafe {
            let (mut r, mut c, mut rx, mut ry, mut wx, mut wy, mut m) = (0, 0, 0, 0, 0, 0, 0 as c_uint);
            if (xx.xl.XQueryPointer)(xx.d, host as c_ulong, &mut r, &mut c, &mut rx, &mut ry, &mut wx, &mut wy, &mut m) == 0 { return; }
            // 期间是否有过按键（快速点击可能在两次轮询之间按下又松开）
            let mut pressed = false;
            while (xx.xl.XPending)(xx.d) > 0 { let mut ev: xlib::XEvent = std::mem::zeroed(); (xx.xl.XNextEvent)(xx.d, &mut ev); if ev.get_type() == xlib::GenericEvent { pressed = true; } }
            if pressed && std::env::var_os("JSRA_EMBED_DEBUG").is_some() { eprintln!("[embed] raw press"); }
            if !pressed && m & (xlib::Button1Mask | xlib::Button3Mask) == 0 { return; }
            let mut a: xlib::XWindowAttributes = std::mem::zeroed();
            if (xx.xl.XGetWindowAttributes)(xx.d, host as c_ulong, &mut a) == 0 || a.map_state != xlib::IsViewable { return; }
            let inside = wx >= 0 && wy >= 0 && wx < a.width && wy < a.height;
            let (mut fw, mut rv) = (0, 0); (xx.xl.XGetInputFocus)(xx.d, &mut fw, &mut rv);
            if inside && fw != top as c_ulong { if std::env::var_os("JSRA_EMBED_DEBUG").is_some() { eprintln!("[embed] focus -> 0x{:x} (was 0x{:x}, raw={})", top, fw, pressed); } (xx.xl.XSetInputFocus)(xx.d, top as c_ulong, xlib::RevertToParent, xlib::CurrentTime); }
            else if !inside && fw == top as c_ulong {
                // 点到应用其它区域：焦点还给主窗口（宿主的父窗口）
                let (mut root, mut par, mut kids, mut n) = (0, 0, std::ptr::null_mut(), 0 as c_uint);
                if (xx.xl.XQueryTree)(xx.d, host as c_ulong, &mut root, &mut par, &mut kids, &mut n) != 0 {
                    if !kids.is_null() { (xx.xl.XFree)(kids as *mut _); }
                    (xx.xl.XSetInputFocus)(xx.d, par, xlib::RevertToParent, xlib::CurrentTime);
                }
            }
        })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::*;
    pub fn alive(_: u64) -> bool { false }
    pub fn create_host(_: u64) -> Result<u64, String> { Err("此平台不支持原生嵌入".into()) }
    pub fn destroy_host(_: u64) {}
    pub fn find_top_windows(_: u32) -> Vec<u64> { vec![] }
    pub fn adopt(_: u64, _: u64) -> Result<(), String> { Err("unsupported".into()) }
    pub fn ensure_embedded(_: u64, _: u64) -> bool { false }
    pub fn place(_: u64, _: PxRect) {}
    pub fn raise(_: u64) {}
    pub fn set_visible(_: u64, _: bool) {}
    pub fn focus_follow(_: Option<(u64, Vec<u64>)>) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_rect_scales_by_dpr() {
        let r = host_rect(CssRect { x: 0.0, y: 76.0, w: 873.5, h: 860.25 }, 1.5);
        assert_eq!(r, PxRect { x: 0, y: 114, w: 1310, h: 1290 });
        assert_eq!(host_rect(CssRect { x: 10.0, y: 20.0, w: 100.0, h: 50.0 }, 1.0), PxRect { x: 10, y: 20, w: 100, h: 50 });
        assert_eq!(host_rect(CssRect { x: 1.0, y: 1.0, w: 10.0, h: 10.0 }, f64::NAN).w, 10);
    }
    #[test]
    fn adjacent_rects_have_no_gap() {
        let a = host_rect(CssRect { x: 0.0, y: 0.0, w: 333.33, h: 10.0 }, 1.25);
        let b = host_rect(CssRect { x: 333.33, y: 0.0, w: 100.0, h: 10.0 }, 1.25);
        assert_eq!(a.x + a.w, b.x);
    }
    #[test]
    fn chrome_rect_crops_toolbar() {
        let host = PxRect { x: 0, y: 114, w: 1310, h: 1290 };
        let c = chrome_rect(host, CssInset { top: 80.0, left: 8.0, right: 8.0, bottom: 8.0 }, 1.5);
        assert_eq!(c, PxRect { x: -12, y: -120, w: 1334, h: 1422 });
        // 负数/荒谬 inset 被夹住
        let c = chrome_rect(host, CssInset { top: -5.0, left: 9999.0, right: 0.0, bottom: 0.0 }, 1.0);
        assert_eq!((c.y, c.x), (0, -400));
    }
    #[test]
    fn styles() {
        let top = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MAXIMIZE | 0x1000_0000; // WS_VISIBLE 保留
        let s = child_style(top);
        assert_eq!(s & (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MAXIMIZE), 0);
        assert_ne!(s & WS_CHILD, 0); assert_ne!(s & 0x1000_0000, 0);
        let e = child_exstyle(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | 0x8);
        assert_eq!(e & (WS_EX_APPWINDOW | WS_EX_WINDOWEDGE), 0); assert_ne!(e & WS_EX_TOOLWINDOW, 0); assert_ne!(e & 0x8, 0);
    }
}
