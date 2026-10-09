#!/usr/bin/env node
/**
 * setup-engine.mjs —— 引擎运行时装配（Python 解释器 + 引擎源码）
 * =============================================================================
 * 只做「manifest 管不到的那几件事」：
 *   · Python 解释器（python-build-standalone）→ runtimes/manga-translator/python-3.11/
 *   · venv（用上面那个解释器建）            → runtimes/manga-translator/venv/
 *   · 引擎源码（上游 commit 归档）        → runtimes/manga-translator/src/
 *   · 源码补丁（幂等，只改我们自己发现的缺陷，见 patchEngineSource）→ 同上 src/
 * 模型权重 / llama.cpp 二进制走 `engine/scripts/fetch-models.mjs`（manifest 是唯一清单）。
 *
 * 版本一律以 `engine/VERSIONS.lock` 为准（本文件里的常量与那份 lock 一一对应）。
 *
 * 用法：
 *   node engine/scripts/setup-engine.mjs            # 装 Python + venv + 引擎源码（+ 打补丁）
 *   node engine/scripts/setup-engine.mjs --python   # 只装 Python 运行时
 *   node engine/scripts/setup-engine.mjs --venv     # 只建 venv（需 Python 已就位）
 *   node engine/scripts/setup-engine.mjs --source   # 只装引擎源码（+ 打补丁）
 *   node engine/scripts/setup-engine.mjs --check    # 只报告现状，不下载
 *
 * 环境变量：
 *   MIAO_MODEL_ROOT   模型根目录（默认 runtimes/manga-translator）
 *   MIAO_PY_URL / MIAO_SRC_URL  覆盖下载地址（换镜像用）
 *
 * ⚠️ 幂等：目标目录已存在且非空则跳过；`--force` 才重下。
 * ⚠️ 只依赖 node 内置模块 + 系统 `tar`（Windows 10 自带 bsdtar，可解 tar.gz 与 zip）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RT = process.env.MIAO_MODEL_ROOT || path.join(REPO, 'runtimes', 'manga-translator');

/** 与 engine/VERSIONS.lock §2 / §1 对应（换版本改这两处 + 那份 lock） */
const PY_VERSION = '3.11.17';
const PY_TAG = '20261003';
const ENGINE_COMMIT = '441d07c59a735c7db3db2e7bb8b07920afd8a9cc';

/** 按平台选 python-build-standalone 的产物三元组 */
function pyTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return a === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

const PY_TRIPLE = pyTriple();
const PY_URL = process.env.MIAO_PY_URL
  || `https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/${PY_TAG}/cpython-${PY_VERSION}%2B${PY_TAG}-${PY_TRIPLE}-install_only.tar.gz`;
const SRC_URL = process.env.MIAO_SRC_URL
  || `https://codeload.github.com/zyddnys/manga-image-translator/tar.gz/${ENGINE_COMMIT}`;

const PY_DIR = path.join(RT, 'python-3.11');
const SRC_DIR = path.join(RT, 'src');
const VENV_DIR = path.join(RT, 'venv');
const CACHE = path.join(RT, '.download-cache');

/** Python 运行时里的解释器 —— Windows 是 `python.exe`，POSIX 是 `bin/python3`。 */
function pyExe() {
  return process.platform === 'win32'
    ? path.join(PY_DIR, 'python.exe')
    : path.join(PY_DIR, 'bin', 'python3');
}

/** venv 里的解释器 —— Windows 是 `venv/Scripts/python.exe`，POSIX 是 `venv/bin/python`。 */
function venvExe() {
  return process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
}

const log = (m) => console.log(m);

async function existsNonEmpty(dir) {
  try {
    const ents = await fsp.readdir(dir);
    return ents.length > 0;
  } catch { return false; }
}

/**
 * 引擎源码是否**真的**装好了。
 * 🔴 判据必须是源码标志文件（`server/main.py`），**不能**是"src/ 目录非空" ——
 *    `fetch-models.mjs --link` 会先往 `src/models/` 里建链接，于是 `src/` 非空但**根本没有源码**，
 *    用"非空"当判据会把"没装源码"误判成"已装"（本脚本第一版就踩了这个坑）。
 */
async function sourceReady() {
  return fs.existsSync(path.join(SRC_DIR, 'server', 'main.py'));
}

/** 流式下载（支持断点续传；失败重试 3 次）。 */
async function download(url, dest, { retries = 3 } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let offset = 0;
    try { offset = (await fsp.stat(dest)).size; } catch { offset = 0; }
    try {
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const acceptsRange = res.status === 206;
      const from = offset > 0 && acceptsRange ? offset : 0;
      const ws = fs.createWriteStream(dest, { flags: from > 0 ? 'a' : 'w' });
      let received = from;
      const total = acceptsRange
        ? Number((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1]) || null
        : Number(res.headers.get('content-length') || 0) || null;
      const reader = res.body.getReader();
      let lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        received += buf.length;
        if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  ${path.basename(dest)} ${pct}%（${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）`);
          }
        }
      }
      ws.end();
      await new Promise((r, j) => { ws.on('finish', r); ws.on('error', j); });
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      return dest;
    } catch (e) {
      if (attempt >= retries) throw new Error(`下载失败 ${url}：${e.message}`);
      log(`  [重试 ${attempt + 1}] ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function extract(archive, destDir, { strip = 1 } = {}) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const args = ['-xf', archive, '-C', destDir];
  if (strip > 0) args.push(`--strip-components=${strip}`);
  const rc = spawnSync('tar', args, { stdio: 'inherit' });
  if (rc.status !== 0) throw new Error(`解包失败（exit ${rc.status}）：${archive}`);
}

async function installPython(force) {
  if (!force && await existsNonEmpty(PY_DIR)) { log(`[跳过] Python 运行时已就位：${PY_DIR}`); return; }
  const cache = path.join(CACHE, path.basename(decodeURIComponent(PY_URL)));
  log(`Python ${PY_VERSION}（${PY_TRIPLE}）`);
  log(`  URL: ${PY_URL}`);
  await download(PY_URL, cache);
  log('  解包…');
  extract(cache, PY_DIR);
  // 校验解释器存在
  const exe = pyExe();
  if (!fs.existsSync(exe)) throw new Error(`解包后未找到解释器：${exe}`);
  log(`  ✓ 解释器：${exe}`);
}

/**
 * 用装好的 Python 运行时建 venv。
 * 🔴 引擎依赖（`install-engine-deps.mjs` / `pip -r requirements.txt`）都装进**这个 venv**，
 *    服务侧 `config.enginePython` 与 e2e 也**只认这个路径** ⇒ 它必须在装依赖**之前**建好。
 *    venv 就位判据用「解释器文件存在」而不是「venv/ 目录存在」—— 目录非空但缺 Scripts/bin 是残的。
 */
async function installVenv(force) {
  if (!force && fs.existsSync(venvExe())) { log(`[跳过] venv 已就位：${VENV_DIR}`); return; }
  const exe = pyExe();
  if (!fs.existsSync(exe)) throw new Error(`Python 运行时不在 ${exe}（先跑一次 setup-engine.mjs --python）`);
  log(`建 venv → ${VENV_DIR}`);
  const rc = spawnSync(exe, ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });
  if (rc.status !== 0) throw new Error(`创建 venv 失败（exit ${rc.status}）：${VENV_DIR}`);
  if (!fs.existsSync(venvExe())) throw new Error(`venv 建好后未找到解释器：${venvExe()}`);
  log(`  ✓ venv：${venvExe()}`);
}

async function installSource(force) {
  if (!force && await sourceReady()) { log(`[跳过] 引擎源码已就位：${SRC_DIR}`); return; }
  const cache = path.join(CACHE, `manga-translator-${ENGINE_COMMIT.slice(0, 12)}.tar.gz`);
  log(`引擎源码 commit ${ENGINE_COMMIT.slice(0, 12)}`);
  await download(SRC_URL, cache);
  log('  解包…');
  extract(cache, SRC_DIR);
  if (!fs.existsSync(path.join(SRC_DIR, 'server', 'main.py'))) {
    throw new Error(`解包后未找到 server/main.py：${SRC_DIR}`);
  }
  log(`  ✓ 源码：${SRC_DIR}`);
}

// ================================================================ 上游源码补丁
//
// 上游引擎源码**不入库**（`runtimes/` 在 .gitignore 内），由 installSource() 从锁定 commit 解包。
// 因此我们对上游的每一处修改，都必须以「幂等补丁」的形式**声明在这张表里** —— 否则换机或换版本
// 装配出来的引擎就少了它，而缺陷会以「翻译没字」「译文崩坏」这类**静默**面目回来（本项目已两次踩到）。
//
// 每个补丁三件套：
//   · mark   —— 幂等判据，也是「这处已被我们改过」的唯一凭据；目标文件里出现它即跳过。
//   · edits  —— 若干 `{anchor, patch}`。**anchor 必须是上游原样字节**（含缩进）。
//               anchor 找不到就**抛错**，绝不静默跳过：源码钉在 ENGINE_COMMIT 上，
//               锚点失效 = 「装出来的引擎已不是我们验过的那份」。
//   · patch 以**函数**形式喂给 replace（见 applyPatches），避免替换串里的 `$` 被当成特殊记号。
//
// ⚠️ 同一文件的多个补丁按**数组顺序**依次应用 ⇒ anchor 必须两两不相交。

const srcPy = (...rel) => path.join(SRC_DIR, ...rel);

/** 补丁表（SSOT）。新增补丁只加一项；`e2e/engine/engine-patches-check.mjs` 逐条取证。 */
export const ENGINE_PATCHES = [
  {
    id: 'sakura-fail-not-list',
    mark: '# miao-dock 补丁 D-86',
    file: srcPy('manga_translator', 'translators', 'sakura.py'),
    desc: 'Sakura 翻译失败时不再 return list（上游会糊成 TypeError，D-86）',
    edits: [{
      // 锚点 = 上游原样三行。取整个 `except` 分支体（含缩进）而不是单独一句 `return prompt`，
      // 因为 `return prompt` 在文件里可能有别的语境；带上前一行 logger.error 才唯一。
      anchor: [
        "                    self.logger.error(f'Sakura API请求失败。错误信息： {e}')",
        '                    return prompt',
        '',
      ].join('\n'),
      patch: [
        "                    self.logger.error(f'Sakura API请求失败。错误信息： {e}')",
        '                    # miao-dock 补丁 D-86：原样的 return prompt 返回的是 list（prompt 就是调用方',
        '                    # 传进来的 queries），而上游调用点按 str 用它（_translate 里对 response 做字符串拼接）⇒',
        '                    # TypeError: can only concatenate str (not "list") to str —— 把"翻译接口不可用"',
        '                    # 这句真话糊成一句 python 内部错误（16 张图全 failed、对外只剩 engine_engine_error）。',
        '                    # 改为显式抛错，让失败以真实原因上抛。',
        '                    # 🔴 不能改成 return str(prompt)：prompt 是**日文原文**，那样会把原文当译文',
        '                    #    静默输出，比失败更坏（用户拿到一页没翻译的"结果"却以为翻译过了）。',
        "                    raise RuntimeError(f'Sakura API请求失败（已重试 {server_error_attempt} 次）：{e}')",
        '',
      ].join('\n'),
    }],
  },
  {
    id: 'translator-config-from-lang',
    mark: '# miao-dock 补丁 D-97a',
    file: srcPy('manga_translator', 'config.py'),
    desc: 'TranslatorConfig 增 from_lang，让「显式方向」有地方可放',
    edits: [{
      anchor: [
        "    target_lang: str = 'ENG' #todo: validate VALID_LANGUAGES #todo: convert to enum",
        '    """Destination language"""',
      ].join('\n'),
      patch: [
        "    target_lang: str = 'ENG' #todo: validate VALID_LANGUAGES #todo: convert to enum",
        '    """Destination language"""',
        '    from_lang: Optional[str] = None',
        '    """# miao-dock 补丁 D-97a：显式源语言（内部语言码，如 ENG）。',
        '    上游只有 auto（交给 langid 自动检测），而实测该检测在本项目的英文漫画短句上判错',
        '    ⇒ 由服务端按任务下发方向（用户显式选方向，不做静默兜底）。',
        '    None = 完全保持上游的 auto 行为（默认值即此，故不影响日译中）。"""',
      ].join('\n'),
    }],
  },
  {
    id: 'dispatch-explicit-src-lang',
    mark: '# miao-dock 补丁 D-97b',
    file: srcPy('manga_translator', 'translators', '__init__.py'),
    desc: 'dispatch 不再把源语言写死为 auto，改用 TranslatorConfig.from_lang',
    edits: [
      {
        anchor: ['    if not queries:', '        return queries'].join('\n'),
        patch: [
          '    if not queries:',
          '        return queries',
          '',
          '    # miao-dock 补丁 D-97b：把「源语言」从写死的字面量改成可由调用方指定的参数。',
          '    #   上游在本函数里 6 处硬编码 \'auto\'（chain.langs[flag] 与 tgt_lang 两侧），于是',
          '    #   TranslatorConfig 里配的方向**根本传不到翻译器**：nllb 只能靠 langid 自动检测，',
          '    #   实测对英文漫画短句判错 ⇒ 落 "Could not detect source language, skipping translation"，',
          '    #   整页译文变空串（用户看到「翻译跑过了、却一个字都没有」）。',
          '    #   取值优先级：translator_config.from_lang（显式）> \'auto\'（上游原行为，逐字保留）。',
          "    _src_lang = getattr(translator_config, 'from_lang', None) if translator_config is not None else None",
          "    _src_lang = _src_lang or 'auto'",
        ].join('\n'),
      },
      {
        anchor: "                await translator.load('auto', chain.langs[flag], device)",
        patch: "                await translator.load(_src_lang, chain.langs[flag], device)",
      },
      {
        anchor: "                queries = await translator.translate('auto', chain.langs[flag], queries, args)",
        patch: "                queries = await translator.translate(_src_lang, chain.langs[flag], queries, args)",
      },
      {
        anchor: "                queries = await translator.translate('auto', chain.langs[flag], queries, use_mtpe)",
        patch: "                queries = await translator.translate(_src_lang, chain.langs[flag], queries, use_mtpe)",
      },
      {
        anchor: "            await translator.load('auto', tgt_lang, device)",
        patch: "            await translator.load(_src_lang, tgt_lang, device)",
      },
      {
        anchor: "            queries = await translator.translate('auto', tgt_lang, queries, args)",
        patch: "            queries = await translator.translate(_src_lang, tgt_lang, queries, args)",
      },
      {
        anchor: "            queries = await translator.translate('auto', tgt_lang, queries, use_mtpe)",
        patch: "            queries = await translator.translate(_src_lang, tgt_lang, queries, use_mtpe)",
      },
    ],
  },
  {
    id: 'nllb-load-cache-dir',
    mark: '# miao-dock 补丁 D-97c',
    file: srcPy('manga_translator', 'translators', 'nllb.py'),
    desc: 'nllb 加载：cache_dir 与 _download 一致，且预置权重时零网络（local_files_only）',
    edits: [{
      anchor: [
        '        self.tokenizer = AutoTokenizer.from_pretrained(self._TRANSLATOR_MODEL)',
        '        self.model = AutoModelForSeq2SeqLM.from_pretrained(self._TRANSLATOR_MODEL)',
      ].join('\n'),
      patch: [
        '        # miao-dock 补丁 D-97c：加载端要满足两条，缺一条在「权重已预置」的产品形态下都会坏。',
        '        #   ① **cache_dir 必须与 `_download()` 一致** —— 上游 `_download()` 写',
        '        #      `cache_dir=self._MODEL_SUB_DIR`（= <引擎>/src/models/translators/nllb），而这里不传',
        '        #      ⇒ 读的是默认 HF 缓存（~/.cache/huggingface）⇒「下载落 A、加载读 B」：',
        '        #      默认缓存为空时必报 "couldn\'t connect to huggingface.co"。',
        '        #   ② **即便 cache_dir 对了，`from_pretrained` 仍会为取 etag 发一次网络请求** ——',
        '        #      本机 HF 不可达 / 系统代理拦路时会抛 ProxyError: 502 Bad Gateway（实测），',
        '        #      把「权重已预置」变成「引擎起不来」。故先探一次缓存：命中即 local_files_only=True',
        '        #      （零网络）；未命中才退回上游的联网行为（首次下载路径）。',
        '        #      探针用 try_to_load_from_cache 的返回值类型判定：命中=str 路径；已知不存在=哨兵；未知=None。',
        '        #   🔴 用 `self._MODEL_SUB_DIR` 而非字面量：NLLBBigTranslator 覆写了它，子类自动跟着对。',
        '        import huggingface_hub',
        '        def _miao_cached(name):',
        '            return isinstance(huggingface_hub.try_to_load_from_cache(',
        '                self._TRANSLATOR_MODEL, name, cache_dir=self._MODEL_SUB_DIR), str)',
        "        _miao_local_only = _miao_cached('pytorch_model.bin') or _miao_cached('model.safetensors')",
        '        self.tokenizer = AutoTokenizer.from_pretrained(',
        '            self._TRANSLATOR_MODEL, cache_dir=self._MODEL_SUB_DIR, local_files_only=_miao_local_only)',
        '        self.model = AutoModelForSeq2SeqLM.from_pretrained(',
        '            self._TRANSLATOR_MODEL, cache_dir=self._MODEL_SUB_DIR, local_files_only=_miao_local_only)',
      ].join('\n'),
    }],
  },
  {
    id: 'nllb-tokenizer-lang-id',
    mark: '# miao-dock 补丁 D-97d',
    file: srcPy('manga_translator', 'translators', 'nllb.py'),
    desc: 'nllb 不再用被 transformers>=5 移除的 lang_code_to_id（AttributeError 被 except 吞成静默空串）',
    edits: [{
      anchor: '            target_lang_id = self.tokenizer.lang_code_to_id[to_lang]',
      patch: [
        "            # miao-dock 补丁 D-97d：transformers>=5 移除了 `NllbTokenizer.lang_code_to_id`",
        '            #   ⇒ 上游这行抛 AttributeError，而它被下面 `except Exception` **吞掉**，',
        '            #   于是 _translate_batch 静默返回 [\'\'] * len(queries) —— 用户看到「翻译跑完了、',
        '            #   却一个字都没有」。改用 `convert_tokens_to_ids`（新旧版本都在）。',
        '            #   保留旧 API 优先：不是为兼容旧版，而是万一将来又恢复，行为不会变。',
        "            if hasattr(self.tokenizer, 'lang_code_to_id'):",
        '                target_lang_id = self.tokenizer.lang_code_to_id[to_lang]',
        '            else:',
        '                target_lang_id = self.tokenizer.convert_tokens_to_ids(to_lang)',
      ].join('\n'),
    }],
  },
  {
    id: 'textblock-dehyphen',
    mark: '# miao-dock 补丁 D-98',
    file: srcPy('manga_translator', 'utils', 'textblock.py'),
    desc: 'TextBlock 拼接时合并断行连字符（消除 OCR 断词导致的整句译文崩坏）',
    edits: [{
      anchor: [
        '        self.texts = texts if texts is not None else []',
        '        self.text = texts[0]',
        '        if self.text and len(texts) > 1:',
        '            for txt in texts[1:]:',
        String.raw`                first_cjk = '\u3000' <= self.text[-1] <= '\u9fff'`,
      ].join('\n'),
      patch: [
        '        self.texts = texts if texts is not None else []',
        '        self.text = texts[0]',
        '        if self.text and len(texts) > 1:',
        '            for txt in texts[1:]:',
        '                # miao-dock 补丁 D-98：断行连字符合并。',
        '                #   检测器会把一个词切成两个 region（实测 `ARE IN-` + `CREDIBLE.` 两块），',
        '                #   而这里按行拼接时走拉丁分支 ⇒ 在 `-` 与后半截之间插了空格：',
        '                #   "ARE IN-" + "CREDIBLE." = "ARE IN- CREDIBLE."，翻译器当两个词 ⇒ 整句语义崩坏',
        '                #   （实测 nllb：「你真的是可信的」而不是「你真的是难以置信的」）。',
        '                #   判据：上一行以 `-` 结尾、`-` 前是字母数字、下一行首字符也是字母数字 ⇒ 去 `-` 直接相连。',
        '                #   🔴 只有这一步**同时知道「这是两行之间的接缝」**，所以只能在这里做：拼接前用全局',
        '                #      正则（re.sub(r"-\\s+","")) 会把 `well- known` 这类正常写法一起合掉。',
        '                #   ⚠️ 已知误伤：行尾破折号被打断（`I WANT TO-` + `NO!` → `I WANT TONO!`）。它与断行连字符',
        '                #      在廉价规则下不可区分；且本字段只用于**翻译查询**（排版用 `region.lines`），',
        '                #      误伤只坏一句译文、不动版面 ⇒ 接受。',
        "                if (len(self.text) >= 2 and self.text.endswith('-')",
        '                        and self.text[-2].isalnum() and txt[:1].isalnum()):',
        '                    self.text = self.text[:-1] + txt',
        '                    continue',
        String.raw`                first_cjk = '\u3000' <= self.text[-1] <= '\u9fff'`,
      ].join('\n'),
    }],
  },
];

/**
 * 上游源码补丁：把 ENGINE_PATCHES 里声明的每一处修改打到上游源码上。
 *
 * 为什么补丁挂在这里而不是 `install-engine-deps.mjs`：那个脚本是 **Windows 专用**
 * （macOS 手动 `pip -r requirements.txt`，见 README），挂在那边会让 macOS 装配**永远拿不到**
 * 这些补丁 —— 而缺陷本身与平台无关。
 *
 * 🔴 锚点缺失时**直接抛错**，不静默跳过（见 ENGINE_PATCHES 头注）。
 * ⚠️ 补丁**不受 installSource 的跳过分支影响**：源码早就在（常见情形）也要能补上 ⇒ main() 里
 *    无条件调用本函数。
 */
function patchEngineSource() {
  for (const p of ENGINE_PATCHES) {
    if (!fs.existsSync(p.file)) {
      throw new Error(`找不到补丁目标源码（${p.id}）：${p.file}\n  ⇒ 引擎源码未装，先跑 setup-engine.mjs --source`);
    }
    let cur = fs.readFileSync(p.file, 'utf8');
    const eol = cur.includes('\r\n') ? '\r\n' : '\n';
    const norm = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));
    // 🔴 锚点/替换体在表里一律用 `\n` 书写，这里按**文件实际 EOL** 归一化。
    //    上游源码并非同一套行尾（实测 `utils/textblock.py` 是 CRLF，`config.py` 是 LF）——
    //    不归一化的后果不是报错而是**锚点永不命中**（然后被当成"源码变了"），排查起来极费时。
    // 幂等：marker 出现即已打过（重复打会在文件里堆第二份注释与语句）
    if (cur.includes(p.mark)) { log(`[跳过] 源码补丁已应用：${p.id}`); continue; }
    for (const [i, e] of p.edits.entries()) {
      const anchor = norm(e.anchor);
      const patch = norm(e.patch);
      if (!cur.includes(anchor)) {
        throw new Error([
          `补丁 ${p.id} 的第 ${i + 1} 个锚点未找到（源码已变）。`,
          `  文件：${p.file}`,
          `  期望锚点：${JSON.stringify(e.anchor)}`,
          '  ⇒ 换上游 commit 时必须**重新核对并更新** ENGINE_PATCHES 里的锚点/替换体',
          '    （engine/VERSIONS.lock 的 ENGINE_COMMIT 与 setup-engine.mjs 的 ENGINE_COMMIT 同步改）。',
        ].join('\n'));
      }
      // 函数式替换：替换串里的 `$` 不会被当成 replace 的特殊记号（替换体里有 `{e}` 之类，别赌）
      cur = cur.replace(anchor, () => patch);
    }
    fs.writeFileSync(p.file, cur, 'utf8');
    log(`  ✓ 已打补丁：${p.id}（${p.desc}）`);
  }
}

/** `--check` 用：报告每个补丁的现状（不改文件） */
function sourcePatchState() {
  return ENGINE_PATCHES.map((p) => {
    let state;
    try { state = fs.readFileSync(p.file, 'utf8').includes(p.mark) ? '✓ 已打' : '✗ 未打'; }
    catch { state = '✗ 缺（源码未装）'; }
    return `  · ${p.id}：${state}`;
  }).join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const check = args.has('--check');
  const force = args.has('--force');
  const onlyPy = args.has('--python');
  const onlyVenv = args.has('--venv');
  const onlySrc = args.has('--source');

  log(`模型根目录：${RT}`);
  if (check) {
    log(`Python(${PY_VERSION})：${fs.existsSync(pyExe()) ? '✓ 已装' : '✗ 缺'}`);
    log(`venv：${fs.existsSync(venvExe()) ? '✓ 已建' : '✗ 缺'}`);
    log(`引擎源码：${await sourceReady() ? '✓ 已装' : '✗ 缺'}`);
    log(`源码补丁：${sourcePatchState()}`);
    return 0;
  }
  await fsp.mkdir(RT, { recursive: true });
  // 给了任一「只装某一步」的开关 ⇒ 只跑被点名的那一步；一个都没给 ⇒ 三步全跑（顺序：Python → venv → 源码）。
  const selective = onlyPy || onlyVenv || onlySrc;
  if (!selective || onlyPy) await installPython(force);
  if (!selective || onlyVenv) await installVenv(force);
  if (!selective || onlySrc) await installSource(force);
  // 补丁**不受 installSource 的跳过分支影响**：源码早就在（本次会话的常见情形）也要能补上。
  // 幂等：已打过就跳过。见 patchEngineSource。
  patchEngineSource();
  log('完成。');
  return 0;
}

// 只有「被当作脚本直接运行」时才执行装配 —— 被 `import`（如 e2e/engine/engine-patches-check.mjs
// 取 ENGINE_PATCHES 做取证）时**不得**触发下载/打补丁这类副作用。
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`\n✗ ${e.stack || e.message}`); process.exit(1); });
}
