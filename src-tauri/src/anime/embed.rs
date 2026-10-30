//! 嵌入式渲染（R1-B）：在应用窗口里开一个**子窗口**，把 mpv 的画面画进去。
//!
//! ## 为什么不走 libmpv FFI（A 方案，已登记未做）
//! A 要 mpv 把解码帧交给宿主、宿主用 D3D11/OpenGL 画到一块 surface；Tauri 的 WebView 是系统 webview，
//! **没把 surface 暴露给 Rust**。要做 A 得额外合成层，成本与风险都远高于本轮能收口的量。
//!
//! ## B 方案的形状
//! 子窗口是 WebView2 的**兄弟**（同一个父窗口下），用 `SetWindowPos(HWND_TOP)` 排在网页之上。
//! 前端只把「画面区」的矩形交给它（底部控制条留出高度），所以控件仍然可见、可点。
//!
//! ## 坐标
//! 前端给的是 **CSS 像素**（WebView 视口坐标）；Win32 子窗口要的是**父窗口客户区的物理像素**。
//! 两者差一个 DPI 缩放（`GetDpiForWindow / 96`）。这里统一在 `physical_rect` 里换算，
//! 纯函数、可单测 —— 换算错了画面会错位，这是最容易在真机上才发现的坑。

use std::sync::{Mutex, OnceLock};

/// 前端给的画面矩形（CSS 像素，视口坐标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 物理像素矩形（父窗口客户区坐标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// CSS → 物理像素。宽高至少 1（0 宽的子窗口在 Win32 上等于隐藏，会让"画面区没显示"变成谜）。
pub fn physical_rect(css: CssRect, dpi: u32) -> PhysRect {
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    let px = |v: f64| (v * scale).round() as i32;
    PhysRect {
        x: px(css.x),
        y: px(css.y),
        w: px(css.w).max(1),
        h: px(css.h).max(1),
    }
}

static CHILD: OnceLock<Mutex<Option<u64>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<u64>> {
    CHILD.get_or_init(|| Mutex::new(None))
}

/// 当前子窗口句柄（没建过就是 None）。
pub fn child() -> Option<u64> {
    slot().lock().ok().and_then(|g| *g)
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH, HBRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, RegisterClassW, SetWindowPos,
        ShowWindow, CS_HREDRAW, CS_VREDRAW, HWND_TOP, SWP_NOACTIVATE, SW_HIDE, SW_SHOW, WNDCLASSW,
        WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
    };

    const CLASS_NAME: &str = "MiaoDockVideoSurface";

    static REGISTERED: OnceLock<bool> = OnceLock::new();

    fn class() -> bool {
        *REGISTERED.get_or_init(|| unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let brush = GetStockObject(BLACK_BRUSH) as HBRUSH;
            // 类名必须先绑成局部变量：临时 `Vec` 在语句结束就释放，`as_ptr()` 会悬空
            let cls = to_wide(CLASS_NAME);
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(DefWindowProcW),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: brush,
                lpszMenuName: std::ptr::null(),
                lpszClassName: cls.as_ptr(),
            };
            RegisterClassW(&wc) != 0
        })
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 建（或复用）子窗口，父窗口是应用主窗口。
    pub fn ensure(parent: u64) -> Result<u64, String> {
        if let Some(h) = child() {
            return Ok(h);
        }
        if !class() {
            return Err("视频子窗口类注册失败".into());
        }
        let class_name = to_wide(CLASS_NAME);
        let title = to_wide("MiaoDockVideo");
        unsafe {
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent as HWND,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                return Err("视频子窗口创建失败（父窗口句柄可能无效）".into());
            }
            let v = hwnd as usize as u64;
            if let Ok(mut g) = slot().lock() {
                *g = Some(v);
            }
            Ok(v)
        }
    }

    /// 摆到指定物理矩形（父窗口客户区坐标），并置顶到兄弟窗口之上。
    pub fn place(hwnd: u64, r: PhysRect) -> Result<(), String> {
        unsafe {
            let ok = SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                r.x,
                r.y,
                r.w,
                r.h,
                SWP_NOACTIVATE,
            );
            if ok == 0 {
                return Err("视频子窗口定位失败".into());
            }
        }
        Ok(())
    }

    pub fn set_visible(hwnd: u64, on: bool) {
        unsafe {
            ShowWindow(hwnd as HWND, if on { SW_SHOW } else { SW_HIDE });
        }
    }

    pub fn destroy(hwnd: u64) {
        unsafe {
            DestroyWindow(hwnd as HWND);
        }
        if let Ok(mut g) = slot().lock() {
            *g = None;
        }
    }

    /// 父窗口的 DPI（96 = 100%）。
    pub fn dpi_of(hwnd: u64) -> u32 {
        unsafe { GetDpiForWindow(hwnd as HWND) }
    }

    /// 父窗口客户区尺寸（物理像素）。
    pub fn client_size(hwnd: u64) -> Option<(i32, i32)> {
        unsafe {
            let mut r = std::mem::zeroed();
            if GetClientRect(hwnd as HWND, &mut r) == 0 {
                return None;
            }
            Some((r.right - r.left, r.bottom - r.top))
        }
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;
    pub fn ensure(_parent: u64) -> Result<u64, String> {
        Err("嵌入式渲染目前只在 Windows 上实现（macOS 要挂 NSView 层级）".into())
    }
    pub fn place(_hwnd: u64, _r: PhysRect) -> Result<(), String> {
        Err("嵌入式渲染目前只在 Windows 上实现".into())
    }
    pub fn set_visible(_hwnd: u64, _on: bool) {}
    pub fn destroy(_hwnd: u64) {}
    pub fn dpi_of(_hwnd: u64) -> u32 {
        96
    }
    pub fn client_size(_hwnd: u64) -> Option<(i32, i32)> {
        None
    }
}

pub use win::{client_size, destroy, dpi_of, ensure, place, set_visible};

/// 前端矩形 → 子窗口摆放（一次做完换算与定位）。`visible=false` 只隐藏不销毁。
pub fn apply(parent: u64, css: Option<CssRect>, visible: bool) -> Result<Option<u64>, String> {
    let hwnd = ensure(parent)?;
    if !visible {
        set_visible(hwnd, false);
        return Ok(Some(hwnd));
    }
    let Some(rect) = css else {
        set_visible(hwnd, false);
        return Ok(Some(hwnd));
    };
    let dpi = dpi_of(parent);
    let mut phys = physical_rect(rect, dpi);
    // 夹到客户区内：超出父窗口的子窗口会被系统裁掉，但坐标算错时先夹住能少一次"画面飞了"
    if let Some((cw, ch)) = client_size(parent) {
        if phys.x < 0 {
            phys.w += phys.x;
            phys.x = 0;
        }
        if phys.y < 0 {
            phys.h += phys.y;
            phys.y = 0;
        }
        phys.w = phys.w.min(cw - phys.x).max(1);
        phys.h = phys.h.min(ch - phys.y).max(1);
    }
    place(hwnd, phys)?;
    set_visible(hwnd, true);
    Ok(Some(hwnd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_to_physical_scales_by_dpi() {
        let r = physical_rect(CssRect { x: 10.0, y: 20.0, w: 320.0, h: 180.0 }, 96);
        assert_eq!(r, PhysRect { x: 10, y: 20, w: 320, h: 180 });
        let r = physical_rect(CssRect { x: 10.0, y: 20.0, w: 320.0, h: 180.0 }, 144);
        assert_eq!(r, PhysRect { x: 15, y: 30, w: 480, h: 270 });
    }

    #[test]
    fn zero_size_is_clamped_to_one() {
        let r = physical_rect(CssRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }, 96);
        assert_eq!((r.w, r.h), (1, 1));
    }

    #[test]
    fn zero_dpi_falls_back_to_one_to_one() {
        let r = physical_rect(CssRect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 }, 0);
        assert_eq!(r, PhysRect { x: 1, y: 2, w: 3, h: 4 });
    }

    /// 真开一个父窗口，把子窗口建出来、摆一次、显隐一次、销毁 —— 无头也能跑（不需要消息循环）。
    #[cfg(windows)]
    #[test]
    fn creates_places_hides_and_destroys_child_window() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, IsWindow, IsWindowVisible, ShowWindow, SW_SHOW,
            WS_OVERLAPPEDWINDOW,
        };

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(std::iter::once(0)).collect()
        }

        // 父窗口用系统已注册的 STATIC 类：不必自己注册类，也不依赖 Tauri
        let cls = wide("STATIC");
        let title = wide("embed-test-parent");
        let parent = unsafe {
            CreateWindowExW(
                0,
                cls.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                800,
                600,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert!(!parent.is_null(), "父窗口建不出来");
        let parent = parent as usize as u64;
        // IsWindowVisible 要求**所有祖先都可见**：父窗口不显示的话，子窗口永远报 0
        unsafe {
            ShowWindow(parent as _, SW_SHOW);
        }

        let first = ensure(parent).expect("子窗口建不出来");
        assert!(first != 0);
        assert_eq!(ensure(parent).expect("第二次 ensure 应复用"), first, "ensure 必须复用");

        let css = CssRect { x: 16.0, y: 24.0, w: 320.0, h: 180.0 };
        apply(parent, Some(css), true).expect("摆放失败");
        assert_ne!(unsafe { IsWindowVisible(first as _) }, 0, "摆放后应可见");

        apply(parent, None, false).expect("隐藏失败");
        assert_eq!(unsafe { IsWindowVisible(first as _) }, 0, "隐藏后不该可见");

        destroy(first);
        assert_eq!(unsafe { IsWindow(first as _) }, 0, "销毁后窗口不该存在");
        assert!(child().is_none(), "销毁后槽位应清空");
        unsafe {
            DestroyWindow(parent as _);
        }
    }
}
