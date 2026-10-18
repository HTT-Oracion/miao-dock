//! 自检提权与静默档参数。
//!
//! 目标行为：双击（默认「为所有用户安装」）⇒ 先弹一次 UAC，一次授权到底；
//! 静默档或显式 `--per-user` ⇒ 不提权，直接按当前权限干活。
//!
//! 🔴 **参数解析必须在提权之前**：提权重启时要把同一组参数原样传回去，
//! 否则新进程会以为自己是被双击启动的，再弹一次 UAC（无限套娃）。
//! 🔴 静默档**不自动提权**：自动化场景里「起一个提权子进程然后自己退出」
//! 会让调用方拿不到退出码，e2e 只能靠猜。权限不够就如实报错。

/// 命令行开关（`--silent <dir?>` / `--per-user` / `--no-shortcuts`）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cli {
    /// 无界面直接装（e2e 与包管理器用）
    pub silent: bool,
    /// 静默档的目标目录
    pub dir: Option<String>,
    /// 仅为我安装（HKCU + `%LOCALAPPDATA%`）
    pub per_user: bool,
    /// 静默档不建任何入口
    pub no_shortcuts: bool,
}

impl Cli {
    pub fn parse(args: &[String]) -> Self {
        let mut cli = Self::default();
        let mut iter = args.iter().peekable();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--silent" => cli.silent = true,
                "--per-user" => cli.per_user = true,
                "--no-shortcuts" => cli.no_shortcuts = true,
                "--dir" => cli.dir = iter.next().cloned(),
                _ => {
                    // 兼容 `--dir=xxx` 形态
                    if let Some(value) = arg.strip_prefix("--dir=") {
                        cli.dir = Some(value.to_string());
                    }
                }
            }
        }
        cli
    }

    /// 拼回命令行（提权重启用）；顺序固定，便于单测与日志对照
    pub fn to_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.per_user {
            args.push("--per-user".to_string());
        }
        if self.no_shortcuts {
            args.push("--no-shortcuts".to_string());
        }
        if self.silent {
            args.push("--silent".to_string());
        }
        if let Some(dir) = &self.dir {
            args.push("--dir".to_string());
            args.push(dir.clone());
        }
        args
    }

    /// 是否表现为「为所有用户安装」（默认口径）
    pub fn machine_scope(&self) -> bool {
        !self.per_user
    }
}

/// 生成参数（单测用；`is_elevated` 依赖真实权限，故这里只判「要不要提权」的纯逻辑）
pub fn should_relaunch_with(cli: &Cli, elevated: bool) -> bool {
    cli.machine_scope() && !cli.silent && !elevated
}

/// 当前进程是否已提权
pub fn is_elevated() -> bool {
    crate::registry::can_write_machine()
}

/// 需不需要自检提权重启
pub fn should_relaunch(cli: &Cli) -> bool {
    should_relaunch_with(cli, is_elevated())
}

/// 以管理员身份重启自身（`runas`），成功后**调用方应立即退出**
#[cfg(windows)]
pub fn relaunch_elevated(args: &[String]) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = std::env::current_exe().map_err(|e| format!("取不到自身路径：{e}"))?;
    let exe_w = wide(&exe.to_string_lossy());
    let verb_w = wide("runas");
    let params = args.iter().map(|arg| quote_arg(arg)).collect::<Vec<_>>().join(" ");
    let params_w = wide(&params);

    let code = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            exe_w.as_ptr(),
            params_w.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;

    // ShellExecute 的约定：返回值 > 32 才算成功
    if code <= 32 {
        return Err(format!(
            "没拿到管理员权限（ShellExecuteW 返回 {code}）—— 是否在授权弹窗里点了「否」？"
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn relaunch_elevated(_args: &[String]) -> Result<(), String> {
    Err("安装器只在 Windows 上运行".to_string())
}

/// 命令行参数里含空格 / 制表符时必须加引号，否则会被拆成两个参数
pub fn quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if arg.contains(' ') || arg.contains('\t') {
        format!("\"{arg}\"")
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_both_spellings_of_dir() {
        let split = Cli::parse(&args(&["--silent", "--dir", "D:\\Apps\\MiaoDock"]));
        assert!(split.silent);
        assert_eq!(split.dir.as_deref(), Some("D:\\Apps\\MiaoDock"));

        let joined = Cli::parse(&args(&["--dir=D:\\Apps\\MiaoDock"]));
        assert_eq!(joined.dir.as_deref(), Some("D:\\Apps\\MiaoDock"));
        assert!(!joined.silent);
    }

    /// 提权重启要把参数原样传回去 —— 丢一个就会变成「装错范围」或「再弹一次 UAC」
    #[test]
    fn args_roundtrip_through_to_args() {
        let original = Cli {
            silent: true,
            dir: Some("D:\\Apps\\MiaoDock".to_string()),
            per_user: true,
            no_shortcuts: true,
        };
        assert_eq!(Cli::parse(&original.to_args()), original);

        let gui = Cli {
            silent: false,
            dir: None,
            per_user: false,
            no_shortcuts: false,
        };
        assert_eq!(Cli::parse(&gui.to_args()), gui);
    }

    /// 提权口径：默认（全机）且非静默且未提权 ⇒ 提权；其余三种情况都不提权
    #[test]
    fn relaunch_policy_covers_four_cases() {
        let gui = Cli::default();
        assert!(should_relaunch_with(&gui, false), "默认双击：弹 UAC");
        assert!(!should_relaunch_with(&gui, true), "已提权：不再弹");

        let per_user = Cli {
            per_user: true,
            ..Cli::default()
        };
        assert!(!should_relaunch_with(&per_user, false), "仅为我：免管理员");

        let silent = Cli {
            silent: true,
            ..Cli::default()
        };
        assert!(!should_relaunch_with(&silent, false), "静默档：如实报权限错误");
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote_arg("--silent"), "--silent");
        assert_eq!(quote_arg("C:\\Apps\\MiaoDock"), "C:\\Apps\\MiaoDock");
        assert_eq!(
            quote_arg("C:\\Program Files\\MiaoDock"),
            "\"C:\\Program Files\\MiaoDock\""
        );
        assert_eq!(quote_arg(""), "\"\"");
    }

    /// 静默档的命令行必须能被自己重新解析成同一份意图
    #[test]
    fn silent_command_line_is_self_consistent() {
        let cli = Cli {
            silent: true,
            dir: Some("C:\\Program Files\\MiaoDock".to_string()),
            per_user: false,
            no_shortcuts: true,
        };
        let line = cli
            .to_args()
            .iter()
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(line.contains("\"C:\\Program Files\\MiaoDock\""));
        assert_eq!(Cli::parse(&cli.to_args()), cli);
    }
}
