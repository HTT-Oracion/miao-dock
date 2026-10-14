;
; 喵坞 · Windows 安装器钩子（E2 / E3）
; ================================================================
; 由 `app/src-tauri/tauri.windows.conf.json` 的
; `bundle.windows.nsis.installerHooks` 引入；Tauri 的 NSIS 模板会在相应时点调用
; 下面这几个 `!macro`。
;
; 🔴 这里只做**两件用户看得见的事**，不碰任何"顺手优化"：
;   ① 安装后检查系统长路径开关（`LongPathsEnabled`）—— 引擎源码树很深，
;      关着的时候装配会在半路失败，而报错与根因离得极远；
;   ② 卸载时**提示**引擎运行时的位置与体积，默认**保留**。
;
; ⚠️ 不改 `HKLM`（长路径是系统级设置，改它要提权；本安装器是**当前用户**安装模式）。
;    这里只"读 + 告诉用户怎么改"，把决定权留在用户手上。
;

; ------------------------------------------------ ① 长路径开关（E2）
;
; 引擎运行时（用户自装）落在 `%LOCALAPPDATA%\runtimes\manga-translator\`，
; 其 Python venv 的 site-packages 路径长这样：
;   ...\venv\Lib\site-packages\transformers\models\...
; 再叠上上游源码树与模型缓存，很容易越过 260 字符 —— 而 Windows 默认（未开长路径时）
; 会在**装配中途**抛 `文件名或扩展名太长`，与"长路径没开"这件事看不出关系。
;
; `SetRegView 64`：`HKLM\SYSTEM` 在 64 位 Windows 上要读 64 位视图（默认视图是 32 位）。
!macro NSIS_HOOK_POSTINSTALL
  ; 🔴 **静默模式必须直接跳过**（`IfSilent` 必须在**任何 MessageBox 之前**）：
  ;    NSIS 的 `MessageBox` 在 `/S` 静默安装下**照样弹窗并阻塞**（`/SD` 只决定"默认按钮是谁"、
  ;    不决定"要不要弹"）⇒ 不跳过的话，`npm run check:packaged` 的静默安装会**挂住**：
  ;    不是变红，是永远不返回。而"时红时绿"已经够坏了，"挂住"更坏。
  IfSilent moor_longpath_done
  SetRegView 64
  ReadRegDWORD $0 HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled"
  SetRegView default
  StrCmp $0 "1" moor_longpath_done
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "还差一步：Windows 的「长路径」开关没开。$\r$\n$\r$\n翻译引擎的依赖树很深，没开这个开关时，$\r$\n首次装配会在中途报「文件名或扩展名太长」。$\r$\n$\r$\n请以管理员身份打开 PowerShell，执行下面这一行，然后重启电脑：$\r$\n$\r$\n    New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `$\r$\n      -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`$\r$\n$\r$\n（同一段说明也写在安装引导文档里：docs/install-guide-windows.md）" \
      /SD IDOK
  moor_longpath_done:
!macroend

; ------------------------------------------------ ② 卸载时提示引擎资产（E3）
;
; 🔴 为什么必须**问一句**而不是直接删：引擎运行时是**用户自己按要求装的**
;    （不随包，见开发计划 §0 裁定②），可能有 10 GB 以上。直接删掉 = 把人家几十分钟的
;    装配成果消灭；直接留着不说 = 十几 GB 无人认领。
;
; 🔴 默认是**保留**：`MB_DEFBUTTON2` 让回车/误触落在「否」那一支。
;    只有用户**明确**点「是」才删。
!macro NSIS_HOOK_PREUNINSTALL
  ; 🔴 同上（**静默模式必须直接跳过**）：`uninstall.exe /S` 若被 MessageBox 拦住，
  ;    `check:packaged` 的收尾清理就再也跑不完。静默卸载 = 走默认档 = **保留**。
  IfSilent moor_keep_runtimes
  IfFileExists "$LOCALAPPDATA\runtimes\manga-translator\*.*" 0 moor_no_runtimes
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "要不要一并删除翻译引擎运行时？$\r$\n$\r$\n它不在安装目录里，而是在：$\r$\n$\r$\n    $LOCALAPPDATA\runtimes\manga-translator$\r$\n$\r$\n里面有你自己装的 Python 依赖与模型权重（常见 10 GB 以上，重装一次要几十分钟）。$\r$\n$\r$\n选「否」= 保留它（默认）。以后想清理，手动删掉上面那个目录即可。" \
      IDYES moor_wipe_runtimes
    Goto moor_keep_runtimes
  moor_wipe_runtimes:
    RMDir /r "$LOCALAPPDATA\runtimes\manga-translator"
  moor_keep_runtimes:
  moor_no_runtimes:
!macroend

; ⚠️ 明确不碰的东西（写在这里是为了让后来者改这个文件时看得见）：
;   · 用户的作品目录 `%USERPROFILE%\Pictures\Box 漫画` —— 卸载**永不**触碰；
;   · `%LOCALAPPDATA%\Box\state`（应用状态）—— 由安装器自己的卸载逻辑处理，这里不插手。
