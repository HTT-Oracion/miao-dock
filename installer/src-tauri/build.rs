//! 构建脚本：保证 `payload/payload.zip` 存在，并让 cargo 追踪它。
//!
//! 真实载荷由 `scripts/pack-install-payload.mjs` 生成（体积大、每版都变，不入库）。
//! 没有它，`include_bytes!` 会让**任何** cargo 命令直接编译失败 —— 连 `cargo check`
//! 和 `cargo test` 都跑不起来。所以缺失时补一个单字节占位：编译能过，
//! 但运行时 `Payload::open` 会明确报「载荷未打包」，不会静默装出半个程序。

use std::fs;
use std::path::PathBuf;

fn main() {
    ensure_payload_present();
    tauri_build::build();
}

fn ensure_payload_present() {
    let dir = PathBuf::from("payload");
    let zip = dir.join("payload.zip");
    if !zip.exists() {
        let _ = fs::create_dir_all(&dir);
        // 单字节内容不是合法 zip —— 故意的：占位只负责让编译过
        let _ = fs::write(&zip, b"\0");
        println!(
            "cargo:warning=payload/payload.zip 不存在，已补占位（真载荷：npm run task -- install:pack）"
        );
    }
    println!("cargo:rerun-if-changed=payload/payload.zip");
}
