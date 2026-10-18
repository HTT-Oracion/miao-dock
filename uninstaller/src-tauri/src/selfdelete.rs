//! 自删 —— 卸载器把自己连同安装目录一起清掉。
//!
//! 做法：起一个 **detached** 的 `cmd`，反复尝试 `del` 自身 + `rmdir` 安装目录。
//!
//! 为什么重试：进程退出要时间，而 Windows 不允许删掉仍在运行的 exe；
//! 卸载器把窗口一关就退出，脚本下一次重试就能删干净。重试有上限（约 20 秒），
//! 上限之内没删掉只会留下「一个 1 MB 的 exe + 空目录」，不会挂一个永久进程。
//!
//! 为什么用命令行而不是临时 `.bat`：少一个需要清理的文件；
//! 命令串是纯函数拼出来的，可以直接单测。

use std::path::Path;

/// 重试次数（每轮之间 ping 回路约 1 秒）
pub const ATTEMPTS: usize = 20;

/// 拼清理命令：每轮先等一下、再删 exe、再删目录（纯函数，便于单测）
pub fn cleanup_command(dir: &Path, exe: &Path) -> String {
    let mut steps: Vec<String> = Vec::new();
    for _ in 0..ATTEMPTS {
        steps.push("ping -n 2 127.0.0.1>nul".to_string());
        steps.push(format!("del /f /q \"{}\" 2>nul", quote(exe)));
        steps.push(format!("rmdir /s /q \"{}\" 2>nul", quote(dir)));
    }
    steps.join(" & ")
}

/// 起一个不占窗口、不连控制台的 detached 进程去干这件事。
///
/// 调用方负责「只在该删的时候调」—— 这里不做幂等判断：重复调用只会多一个
/// 同样无害的清理进程，而漏调会让卸载器永远留在用户的机器上。
pub fn schedule(dir: &Path, exe: &Path) -> Result<(), String> {
    platform::spawn_cmd(&cleanup_command(dir, exe))
}

/// 命令行里的路径：cmd 的 `%` 是变量前缀，要双写；引号由调用方加
fn quote(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%").replace('"', "")
}

#[cfg(windows)]
mod platform {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub fn spawn_cmd(line: &str) -> Result<(), String> {
        // 🔴 `raw_arg` 而不是 `arg`：cmd.exe 不认 Rust 那套 `\"` 转义，
        //    只有原样把 `"<整条命令>"` 递进去，里面的引号才会被当成路径边界。
        Command::new("cmd")
            .raw_arg("/c")
            .raw_arg(format!("\"{line}\""))
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("安排自删失败：{e}"))
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn spawn_cmd(_line: &str) -> Result<(), String> {
        Err("卸载器只在 Windows 上运行".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        cleanup_command(
            Path::new("C:\\Program Files\\MiaoDock"),
            Path::new("C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe"),
        )
    }

    /// 两个路径都要在命令里，且各被引号包住（含空格才不会断成两段）
    #[test]
    fn command_quotes_both_paths() {
        let line = sample();
        assert!(line.contains("\"C:\\Program Files\\MiaoDock\""));
        assert!(line.contains("\"C:\\Program Files\\MiaoDock\\MiaoDock-Uninstaller.exe\""));
    }

    /// 重试次数写死并断言：少了删不掉运行中的自己，多了是空转
    #[test]
    fn command_retries_a_bounded_number_of_times() {
        let line = sample();
        assert_eq!(line.matches("del /f /q").count(), ATTEMPTS);
        assert_eq!(line.matches("rmdir /s /q").count(), ATTEMPTS);
        assert_eq!(line.matches("ping -n 2").count(), ATTEMPTS);
    }

    /// 先删 exe 再删目录：目录非空时 rmdir 会失败
    #[test]
    fn deletes_the_exe_before_the_directory() {
        let line = sample();
        let del = line.find("del /f /q").unwrap();
        let rmdir = line.find("rmdir /s /q").unwrap();
        assert!(del < rmdir, "顺序反了会删不动目录");
    }

    /// `%` 在 cmd 里是变量前缀，路径里出现时必须双写，否则会被展开成空
    #[test]
    fn percent_signs_are_escaped() {
        let line = cleanup_command(Path::new("D:\\a%20b"), Path::new("D:\\a%20b\\u.exe"));
        assert!(line.contains("a%%20b"));
        assert!(!line.contains("a%20b"));
    }
}
