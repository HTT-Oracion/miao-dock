// mangasvc/engine/fetch_models.rs —— S3 模型下载器的命令行入口（A3d）
//
// 移植自 `engine/scripts/fetch-models.mjs`（159 行）。子命令形态：`mangasvc --fetch-models [...]`
//
// ## 为什么挂 mangasvc（与 A3c 的 `--child-watch` 同一裁定）
// 它是**产品运行期**被 spawn 的：`POST /engine/models/verify` 与「重新下载模型」都要起它。
// A3「node 随包」作废 ⇒ 不能再 `node engine/scripts/fetch-models.mjs`。挂在 `mangasvc` 上则
// **不新增可执行文件、不改 `bundle.resources`**（`mangasvc` 本来就随包）。
//
// ## 对 Node 版新增的三个参数（只为双靶取证，不影响产品行为）
//   · `--manifest <p>` —— Node 版把清单路径**写死**在 `engine/models.manifest.json`。
//     双靶对拍必须用**夹具清单**（否则两靶都在比真清单，夹具服务器就没人打）⇒ 两边都加。
//   · `--report <p>`   —— 把结构化结果落盘。盘上取证比"解析 stdout 文本"可靠得多，
//     且两靶能读同一份 JSON（`check:models` 的谓词因此可以对两边共用）。
//   · `--progress-log <p>` —— 逐行 JSON 进度。续传/进度类断言靠它，不靠日志文字。
//
// 🔴  stdout 的**文本**必须与 Node 版逐字一致：`handlers.rs` 的 `models/verify` 是按
//     `校验：通过 X / 不符 Y / 缺失 Z（共 N）` 解析的，改一个字就是"字段解析不出来"。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::child_watch::hide_console;
use std::process::Command;

use serde_json::{json, Value};

use super::model_store::{
    ensure_models, link_models, verify_hf_cache, verify_models, LinkResult, Manifest, ModelStoreError,
    ProgressEvent,
};
use super::runtime_setup::{run_bootstrap, to_store_error};

use crate::paths;

struct Args {
    ids: Vec<String>,
    set: Option<String>,
    integrity: String,
    check: bool,
    extract: bool,
    link_only: bool,
    no_link: bool,
    help: bool,
    manifest: Option<PathBuf>,
    root: Option<PathBuf>,
    link_base: Option<PathBuf>,
    report: Option<PathBuf>,
    progress_log: Option<PathBuf>,
    /// G4：零配置装配总入口（裁定④）：下载 + 解包 + 建 venv + 装依赖 + 打补丁 + 解包 llama.cpp + 建链。
    engine_bootstrap: bool,
    /// G4：只跑到第几阶段（`--stage N`，缺省 = 不筛，与今天等价）。
    max_stage: Option<u8>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut out = Args {
        ids: Vec::new(),
        set: None,
        integrity: "cached".to_string(),
        check: false,
        extract: false,
        link_only: false,
        no_link: false,
        help: false,
        manifest: None,
        root: None,
        link_base: None,
        report: None,
        progress_log: None,
        engine_bootstrap: false,
        max_stage: None,
    };
    let mut i = 0usize;
    while i < argv.len() {
        let a = argv[i].as_str();
        let next = || -> Option<String> { argv.get(i + 1).cloned() };
        match a {
            "--set" => { out.set = Some(next().ok_or("--set 缺值")?); i += 1; }
            "--id" => { out.ids.push(next().ok_or("--id 缺值")?); i += 1; }
            "--integrity" => { out.integrity = next().ok_or("--integrity 缺值")?; i += 1; }
            "--manifest" => { out.manifest = Some(PathBuf::from(next().ok_or("--manifest 缺值")?)); i += 1; }
            "--root" => { out.root = Some(PathBuf::from(next().ok_or("--root 缺值")?)); i += 1; }
            "--link-base" => { out.link_base = Some(PathBuf::from(next().ok_or("--link-base 缺值")?)); i += 1; }
            "--report" => { out.report = Some(PathBuf::from(next().ok_or("--report 缺值")?)); i += 1; }
            "--progress-log" => { out.progress_log = Some(PathBuf::from(next().ok_or("--progress-log 缺值")?)); i += 1; }
            // G4：阶段筛选。**在 CLI 层翻译成 id 列表**（见下面 ids 那段的说明），
            // 而不是给 `select_files` 加参数 —— 那个函数有四个调用点，改签名会让
            // 「默认不筛」变成「每个调用点各自记得传 None」，漏一个就静默下错东西。
            "--stage" => {
                let raw = next().ok_or("--stage 缺值")?;
                let n = raw.parse::<u8>().map_err(|_| format!("--stage 要一个正整数，收到「{raw}」"))?;
                if n == 0 { return Err("--stage 从 1 起（1 = 先可用，2 = 后完整）".to_string()); }
                out.max_stage = Some(n);
                i += 1;
            }
            // G4：零配置装配总入口（裁定④）。与 `--extract` 一起传 ⇒ 产品路径也能产出 llama-server。
            "--engine-bootstrap" => {
                out.engine_bootstrap = true;
                i += 1;
            }
            "--check" => out.check = true,
            "--extract" => out.extract = true,
            "--link" => out.link_only = true,
            "--no-link" => out.no_link = true,
            "-h" | "--help" => out.help = true,
            other => return Err(format!("未知参数：{other}")),
        }
        i += 1;
    }
    Ok(out)
}

const USAGE: &str = "\
mangasvc --fetch-models —— S3 模型下载器
用法：
  mangasvc --fetch-models                          # 拉全套
  mangasvc --fetch-models --set visual             # 只拉视觉模型
  mangasvc --fetch-models --id ocr_48px            # 只拉一个
  mangasvc --fetch-models --check                  # 只校验、不联网（含 HF 缓存布局可解析性）
  mangasvc --fetch-models --set runtime --extract  # 拉 llama.cpp 并解包
  mangasvc --fetch-models --integrity cached       # 应用启动口径
  mangasvc --fetch-models --link                   # 只重建引擎树里的链接（零网络）
  mangasvc --fetch-models --no-link                # 拉完不建链
环境变量：MIAO_MODEL_ROOT 覆盖模型根目录（默认 <appData>/runtimes/manga-translator，随 MIAO_ENGINE_DIR 推导）
取证专用：--manifest <p> --root <p> --report <p> --progress-log <p>
";

fn human(n: Option<u64>) -> String {
    let n = match n {
        Some(v) => v,
        None => return "?".to_string(),
    };
    let units = ["B", "KB", "MB", "GB"];
    let mut i = 0usize;
    let mut v = n as f64;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{v:.0} {}", units[i])
    } else {
        format!("{v:.1} {}", units[i])
    }
}

fn load_manifest(p: &Path) -> Result<Manifest, ModelStoreError> {
    let text = fs::read_to_string(p).map_err(|e| {
        ModelStoreError::with_detail(
            "MODEL_MANIFEST_UNREADABLE",
            format!("读不到清单：{e}"),
            json!({ "path": p.display().to_string() }),
        )
    })?;
    serde_json::from_str::<Manifest>(&text).map_err(|e| {
        ModelStoreError::with_detail(
            "MODEL_MANIFEST_BAD",
            format!("清单不是合法 JSON：{e}"),
            json!({ "path": p.display().to_string() }),
        )
    })
}

/// 进度回调的落点：打印一行 + 逐行追加到 `--progress-log`（若有）。
struct ProgressSink {
    file: Option<File>,
    last: String,
}

impl ProgressSink {
    fn new(path: &Option<PathBuf>) -> Self {
        let file = path.as_ref().and_then(|p| {
            OpenOptions::new().create(true).truncate(true).write(true).open(p).ok()
        });
        Self { file, last: String::new() }
    }
    fn push(&mut self, e: &ProgressEvent) {
        let line = format!(
            "{} {} {}/{}",
            e.id,
            e.phase,
            human(Some(e.received)),
            human(e.total)
        );
        if line != self.last {
            self.last = line.clone();
            print!("\r{line:60}");
            std::io::stdout().flush().ok();
        }
        if let Some(f) = self.file.as_mut() {
            if let Ok(s) = serde_json::to_string(e) {
                let _ = writeln!(f, "{s}");
                let _ = f.flush();
            }
        }
    }
}

fn write_report(path: &Option<PathBuf>, payload: &Value) {
    if let Some(p) = path {
        let text = serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".to_string());
        fs::write(p, text).ok();
    }
}

pub fn run(argv: &[String]) -> i32 {
    let args = match parse_args(argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("参数错误：{e}");
            return 2;
        }
    };
    if args.help {
        print!("{USAGE}");
        return 0;
    }

    let manifest_path = args
        .manifest
        .clone()
        .unwrap_or_else(|| paths::model_manifest());
    let root = args
        .root
        .clone()
        .or_else(|| std::env::var("MIAO_MODEL_ROOT").ok().filter(|s| !s.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| paths::model_root());

    let manifest = match load_manifest(&manifest_path) {
        Ok(m) => m,
        Err(e) => return fail(&e),
    };

    let scope = if !args.ids.is_empty() {
        format!("id={}", args.ids.join(","))
    } else if let Some(s) = &args.set {
        format!("set={s}")
    } else {
        "全部".to_string()
    };
    println!("模型根目录：{}", root.display());
    let commit: String = manifest.engine_commit.chars().take(12).collect();
    println!("清单：v{} · 引擎 commit {} · 范围：{}", manifest.manifest_version, commit, scope);

    // G4：零配置装配总入口（裁定④）。把「四步手工装配」串成一次会话、一条进度流。
    //   🔴 与 `--extract` 配合 ⇒ 产品路径也能产出 `bin/llama/llama-b11417/llama-server[.exe]`。
    //   🔴 失败**不回滚**已就绪部分：重跑会续做（.ready 幂等 + extract 先解临时目录）。
    if args.engine_bootstrap {
        use std::cell::RefCell;
        let rt_manifest_path = paths::runtime_manifest();
        let rt_manifest = match load_manifest(&rt_manifest_path) {
            Ok(m) => m,
            Err(e) => return fail(&e),
        };
        let pip_index = std::env::var("MIAO_PY_INDEX")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://pypi.tuna.tsinghua.edu.cn/simple".to_string());
        let sink = RefCell::new(ProgressSink::new(&args.progress_log));
        let mut on_phase = |stage: &str, msg: &str| {
            println!("[{}] {}", stage, msg);
            sink.borrow_mut().push(&ProgressEvent {
                id: stage.to_string(),
                phase: "stage".to_string(),
                received: 0,
                total: None,
                url: None,
                resumed: false,
            });
        };
        let rt_dir = paths::runtimes_dir();
        match run_bootstrap(
            &rt_manifest,
            &manifest,
            &rt_dir,
            &root,
            &rt_dir,
            args.max_stage,
            &pip_index,
            &mut on_phase,
            &mut |e: ProgressEvent| sink.borrow_mut().push(&e),
        ) {
            Ok(()) => {
                println!("✓ 装配完成：运行时应就绪（mangasvc --check-runtime-gate real 应全绿）");
                return 0;
            }
            Err(e) => return fail(&to_store_error(e)),
        }
    }

    let mut ids: Option<Vec<String>> = if args.ids.is_empty() { None } else { Some(args.ids.clone()) };
    let set_ref = args.set.as_deref();

    // G4：阶段筛选在**这一层**翻译成 id 列表（而不是给 `select_files` 加参数）。
    //
    // 顺带白拿一条语义：`--id` 路径**不做二次平台过滤**，而这里的 id 已经是
    // `select_files_staged` 按当前平台筛过的 ⇒ 传下去的一定是本平台适用的那几条。
    if let Some(max) = args.max_stage {
        // 🔴 这里所在函数返回 `i32`（不是 Result）⇒ 用本文件既有的 `match … return fail(&e)`
        //    范式，**不能写 `?`** —— 那是个编译错误（E0277），而"顺手加个 ?"是最容易犯的。
        let picked =
            match super::model_store::select_files_staged(&manifest, ids.as_deref(), set_ref, Some(max)) {
                Ok(v) => v,
                Err(e) => return fail(&e),
            };
        if picked.is_empty() {
            return fail(&ModelStoreError::with_detail(
                "MODEL_STAGE_EMPTY",
                format!(
                    "stage ≤ {max} 在本平台没有任何条目（platform={}）",
                    super::model_store::platform_key()
                ),
                json!({ "stage": max }),
            ));
        }
        ids = Some(picked.into_iter().map(|f| f.id).collect());
    }
    let ids_ref = ids.as_deref();

    // ---------------------------------------------------------------- 只校验
    if args.check {
        let mut sink = ProgressSink::new(&args.progress_log);
        let r = match verify_models(&manifest, &root, ids_ref, set_ref, Some(&mut |e: ProgressEvent| sink.push(&e))) {
            Ok(v) => v,
            Err(e) => return fail(&e),
        };
        println!(
            "校验：通过 {} / 不符 {} / 缺失 {}（共 {}）",
            r.ok.len(),
            r.bad.len(),
            r.missing.len(),
            r.total
        );
        for b in &r.bad {
            println!("  ✗ {}：盘上 {}… ≠ 清单 {}…", b.id, &b.actual[..12], &b.expected[..12]);
        }
        for m in &r.missing {
            println!("  ✗ {m}：缺失");
        }

        // —— HF 缓存布局：光有 blobs 不够，HF 认的是 snapshots/<rev>/<file> + refs/main。
        //    这一节是"链接建完了、权重还是不被引擎认"的唯一承担者（见 docs/spec-notes.md D-99）。
        let hf = match verify_hf_cache(&manifest, &root, args.link_base.as_deref(), ids_ref, set_ref) {
            Ok(v) => v,
            Err(e) => return fail(&e),
        };
        if hf.total > 0 {
            println!(
                "HF 缓存布局：可解析 {} / 不可解析 {}（共 {}）",
                hf.ok.len(),
                hf.missing.len(),
                hf.total
            );
            for m in &hf.missing {
                println!(
                    "  ✗ {}：snapshot={} store={} refs/main={}",
                    m.id,
                    if m.snapshot { "有" } else { "缺" },
                    if m.store { "有" } else { "缺" },
                    if m.refs { "对" } else { "缺或不对" }
                );
            }
        }
        write_report(&args.report, &json!({ "verify": r, "hf": hf }));
        let bad = !r.bad.is_empty() || !r.missing.is_empty() || !hf.missing.is_empty();
        return if bad { 1 } else { 0 };
    }

    // ---------------------------------------------------------------- 只重建链接
    if args.link_only {
        let l = match link_models(&manifest, &root, args.link_base.as_deref(), ids_ref, set_ref, Some(&|m: &str| println!("{m}"))) {
            Ok(v) => v,
            Err(e) => return fail(&e),
        };
        println!("链接基准：{}", l.base);
        println!(
            "链接：新建 {} · 已是 {} · 复制 {} · 跳过 {}（共 {}）",
            l.linked.len(),
            l.already.len(),
            l.copied.len(),
            l.skipped.len(),
            l.total
        );
        if !l.hf.is_empty() {
            println!("HF 缓存布局：补齐 {} 个条目的 snapshot + refs/main", l.hf.len());
        }
        print_cross_device(&l);
        write_report(&args.report, &json!({ "link": l }));
        if !l.skipped.is_empty() {
            println!("✗ 有跳过项 ⇒ store 里还缺资产，先跑一次下载。");
            return 1;
        }
        return 0;
    }

    // ---------------------------------------------------------------- 下载
    let mut sink = ProgressSink::new(&args.progress_log);
    let r = match ensure_models(
        &manifest,
        &root,
        ids_ref,
        set_ref,
        &args.integrity,
        Some(&|m: &str| println!("{m}")),
        Some(&mut |e: ProgressEvent| sink.push(&e)),
    ) {
        Ok(v) => v,
        Err(e) => return fail(&e),
    };
    print!("\r{:60}\r", " ");
    println!(
        "复用 {} · 下载 {} · 因校验重下 {} · 传输 {}",
        r.reused.len(),
        r.downloaded.len(),
        r.redownloaded.len(),
        human(Some(r.bytes))
    );
    for (id, from) in &r.resume_from {
        if *from > 0 {
            println!("  续传：{id} 从 {} 接着下", human(Some(*from)));
        }
    }

    // —— 把 store 里的权威副本链进引擎源码树（视觉模型必须出现在 <引擎>/src/models/ 下）
    let mut link_report = Value::Null;
    if !args.no_link {
        match link_models(&manifest, &root, args.link_base.as_deref(), ids_ref, set_ref, None) {
            Ok(l) => {
                println!(
                    "链接：新建 {} · 已是 {} · 复制 {} · 跳过 {}",
                    l.linked.len(),
                    l.already.len(),
                    l.copied.len(),
                    l.skipped.len()
                );
                if !l.hf.is_empty() {
                    println!("HF 缓存布局：补齐 {} 个条目的 snapshot + refs/main", l.hf.len());
                }
                print_cross_device(&l);
                link_report = json!(l);
            }
            Err(e) => return fail(&e),
        }
    }
    write_report(&args.report, &json!({ "ensure": r, "link": link_report }));

    // ---------------------------------------------------------------- 解包
    if args.extract {
        // 按**当前平台**挑选带 `extractTo` 的 runtime 条目（Mac = macos tar.gz；Windows = win zip）。
        // 归档都用 `tar -xf` 解（Windows 10 自带 bsdtar，能解 zip 与 tar.gz）。
        let key = super::model_store::platform_key();
        let targets: Vec<_> = manifest
            .files
            .iter()
            .filter(|f| f.extract_to.is_some() && super::model_store::matches_platform(f, &key))
            .collect();
        if targets.is_empty() {
            eprintln!("\n✗ [MODEL_NO_EXTRACT_ENTRY] 清单里没有适用于当前平台的可解包条目（需要 extractTo 字段）");
            return 1;
        }
        for entry in targets {
            let arc_abs = root.join(&entry.dest);
            if !arc_abs.exists() {
                println!("  跳过 {}：归档不在 {}（先跑一次下载）", entry.id, arc_abs.display());
                continue;
            }
            let out_dir = root.join(entry.extract_to.as_deref().unwrap_or_default());
            fs::create_dir_all(&out_dir).ok();
            // 归档一般带一个顶层目录 ⇒ 默认 strip 掉第 1 层，让内容直接落在 outDir。
            let strip = entry.extract_strip.unwrap_or(1);
            let mut cmd = Command::new("tar");
            cmd.arg("-xf").arg(&arc_abs).arg("-C").arg(&out_dir);
            if strip > 0 {
                cmd.arg(format!("--strip-components={strip}"));
            }
            // `tar` 是控制台程序，mangasvc 无控制台 ⇒ 解包期间会闪黑框。
            hide_console(&mut cmd);
            match cmd.status() {
                Ok(st) if st.success() => println!("  已解包 {} → {}", entry.id, out_dir.display()),
                Ok(st) => {
                    eprintln!("\n✗ [MODEL_EXTRACT_FAILED] 解包失败（{st}）：{}", arc_abs.display());
                    return 1;
                }
                Err(e) => {
                    eprintln!("\n✗ [MODEL_EXTRACT_FAILED] 起不了 tar：{e}");
                    return 1;
                }
            }
        }
    }
    0
}

/// 跨卷降级要**说出来**（C2 验收③）。
///
/// 跨卷不是故障 —— 复制出来的文件引擎一样能用。但它会让落点下**多出一份**与权威副本等大的
/// 拷贝：按"几个 GB"留盘的人会不够，而我们只说一句"硬链接失败"就什么都没告诉他。
fn print_cross_device(l: &LinkResult) {
    if l.cross_device.is_empty() {
        return;
    }
    println!(
        "⚠️ 跨卷：{} 个条目与权威副本不在同一个盘 ⇒ 已改为复制（原样可用，但要额外占一份盘）：{}",
        l.cross_device.len(),
        l.cross_device.join("、")
    );
}

fn fail(e: &ModelStoreError) -> i32 {
    // 🔴 文案与 Node 版一致（`✗ [CODE] msg`）—— e2e 与 `handlers.rs` 都按这个形态抽错误码。
    eprintln!("\n✗ [{}] {}", e.code, e.message);
    1
}
