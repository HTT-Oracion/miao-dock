//! PikPak 云离线（R5-6）：**只留接口**，不假装已接入。
//!
//! 用户明确过口径：BT 走本地 librqbit，PikPak 只留接口。所以这里给的是**契约形状**：
//! 调用方拿到的永远是 `NotConfigured`（或未来的真实错误），而不是一个"成功但没有任务"的假结果。
//! 界面显示"未接入"并说明缺什么（账号），不画一个能点但没反应的按钮。

use serde_json::{json, Value};

/// PikPak 接口的错误族（真接入时在这里补 `Auth` / `Quota` / `Upstream`）。
#[derive(Debug, Clone, PartialEq)]
pub enum PikPakError {
    /// 未配置账号 —— 当前唯一可能的结果
    NotConfigured,
}

impl PikPakError {
    pub fn message(&self) -> String {
        match self {
            PikPakError::NotConfigured => {
                "PikPak 未接入：接口已就绪，但还没有账号与客户端实现（R5-6）".to_string()
            }
        }
    }
}

/// 接口状态（界面据此显示"未接入"而不是"暂无任务"）。
///
/// `configured` 只反映**设置里的开关**，不代表能力可用 —— 能力可用要等真客户端落地。
pub fn status(enabled: bool) -> Value {
    let configured = enabled;
    json!({
        "implemented": false,
        "configured": configured,
        "reason": PikPakError::NotConfigured.message(),
        "contract": {
            "login": "POST /v1/pikpak/login {username,password} -> {token}",
            "submit": "POST /v1/pikpak/offline {magnet} -> {taskId}",
            "poll": "GET /v1/pikpak/task/{taskId} -> {state,progress,fileUrl}",
            "resolve": "GET /v1/pikpak/file/{fileId} -> {url,expiresAt}",
        },
    })
}

/// 提交离线任务：接口在，实现不在 —— 必须**明确失败**，不返回假 taskId。
pub fn submit(_magnet: &str) -> Result<Value, PikPakError> {
    Err(PikPakError::NotConfigured)
}

/// 轮询任务：同上。
pub fn poll(_task_id: &str) -> Result<Value, PikPakError> {
    Err(PikPakError::NotConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_honest_about_not_being_implemented() {
        let v = status(false);
        assert_eq!(v["implemented"], false);
        assert_eq!(v["configured"], false);
        assert!(v["reason"].as_str().unwrap().contains("未接入"));
        // 契约写清了四条路径（真接入时照这个实现）
        assert_eq!(v["contract"].as_object().unwrap().len(), 4);
    }

    #[test]
    fn configured_reflects_account_but_not_capability() {
        let v = status(true);
        assert_eq!(v["configured"], true);
        // 填了账号也不代表能用：能力位仍是 false
        assert_eq!(v["implemented"], false);
    }

    #[test]
    fn submit_never_returns_a_fake_task() {
        let err = submit("magnet:?xt=urn:btih:abc").unwrap_err();
        assert_eq!(err, PikPakError::NotConfigured);
        assert!(poll("t1").is_err());
    }
}
