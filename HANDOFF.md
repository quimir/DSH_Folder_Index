# dsh-host-paths 交接文档（v2 · 含 macOS 落地结果）

> **v2 变更**：Mac 侧的落地报告已并入本文档。原来标着「未验证」的四项现在有了实测
> 结论；§5 的安装方式被 Mac 实测推翻过一次，已改写；新增 §10「怎么把它变成一个
> 真正的插件」（分发问题）。
>
> 作者侧环境：Windows 11 + 社区 Tauri 桌面壳（`deepseek-harness-desktop.exe`），
> DSH `0.1.7-rc.2`，profile `tauri`。
> Mac 侧环境：官方 DSH Desktop `ai.deepseek.dsh.desktop`，DSH `0.1.7-rc.2`，
> profile `desktop`，GUI `http://127.0.0.1:43120`。

---

## 0. 一句话结论

**两端都通了。** 拖文件夹 → `@路径/` 引用块，在 Windows（Tauri 壳）与 macOS
（官方 Electron 桌面端）上都已实测可用。**不需要维护两份代码**：平台分支只有宿主
半体的三处（已知文件夹 / 挂载点 / 名字索引），其余是平台无关的 `node:path` + `node:fs`。

---

## 1. 这个插件解决什么问题

DSH 客户端（`@deepseek-ai/dsh-client-ui-conversation`）的附件入口里写死了这段逻辑：

```js
const bridge = hostPathBridge();                    // 读 globalThis.__DSH_HOST_PATHS__
if (bridge === void 0 && directory) return t("attachment.directoryDesktopOnly");
const path = bridge?.pathFor(file) ?? "";           // 同步取绝对路径
```

- **文件夹拖放的归属权本来就在 DSH 自己手里**，它只缺一个**同步**的 `pathFor(file)`。
- 桥在 → 文件夹（一次拖多个也行）走 `formatFileMention` 变成 `@相对路径/` 引用块。
- 桥不在 → 只弹一句提示：中文 `只有桌面端支持添加文件夹，浏览器里请添加单个文件`。

**两端都没有注入方**（Mac 侧全应用搜索 `__DSH_HOST_PATHS__` 只找到消费方
`dsh-client-ui-conversation/lib/client.js`），所以这个插件在两端都被需要。
`client-inject.js` 开头有 `if (globalThis.__DSH_HOST_PATHS__ !== undefined) return;`
——将来哪个壳自己实现了官方桥，插件会自动让位。

契约锚点（换 DSH 版本时先 grep 这几条）：

```bash
DSH=<dsh 包目录>
grep -rn "__DSH_HOST_PATHS__" "$DSH/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/"
grep -rn "input-insert-reference" "$DSH/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/"
grep -rn "formatFileMention" "$DSH/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/"
```

---

## 2. 交付物

| 文件 | 角色 |
|---|---|
| `index.js` | 宿主半体：注入桥脚本 + 回环路由 `/locate`、`/learn`、`/report`、`/log` |
| `client-inject.js` | 浏览器半体（内联进首页 `<head>`）：定义 `globalThis.__DSH_HOST_PATHS__` |
| `client.js` | 客户端模块：工具栏「📁+ 添加文件夹」，调 DSH 自带原生选择器 |
| `cordis.patch.yml` | bundle 补丁：插入一行 `dsh-host-paths` |
| `package.json` | 清单：`dsh.bundle.patch` + `dsh.client{platform:"web"}` |
| `install-dsh-host-paths.mjs` | **单文件自安装器**（见 §10），5 个源文件内联其中 |
| `SOURCE.md` | 单文件源码包（5 个源文件内联，便于粘贴/邮件传输） |

两条硬约束（改代码时请保持）：

1. **不抢拖拽事件**。全程不 `preventDefault`、不 `stopPropagation`。作者侧实测过抢事件
   的两条弯路：window 冒泡被 document 上的原生处理器抢先；改成捕获阶段 +
   `stopImmediatePropagation` 会卡死原生拖拽遮罩层。都不可取。
2. **只接管文件夹**。普通文件 `pathFor` 返回 `""`，继续走附件上传——拖文件的行为不变。

---

## 3. 路径从哪来

拖拽 payload 里只有文件夹**名字**，没有路径（浏览器安全模型）。两端实测
`text/uri-list` 都是 **0 行**（Windows WebView2 与 macOS Electron 皆然），
所以只能按名字找，四级：

1. **学到的容器**：上次成功解析/选择的目录，持久化在 `~/.dsh/storages/dsh-host-paths/containers.json`。
   Mac 实测第二次拖同一位置 **0ms** 命中（第一次 2ms）。
2. **工作区根 ±2 层 + 该根所在卷的挂载点**；
3. **平台已知文件夹**；
4. **平台文件索引**（限时子进程）。

全盘递归扫描**不做**：作者侧实测剪枝后跑一遍 Windows D:（318GB）= **28.5 秒 /
66,059 个目录**。落在这四级之外的目录会**明确失败**（`pathFor` 返回 `""` → DSH 提示
「无法获取文件夹路径，请重新拖入」），而不是塞一个假路径。

### 平台矩阵（全部已实测）

| 能力 | win32 | darwin | linux |
|---|---|---|---|
| 已知文件夹 | 注册表 `User Shell Folders` | `~/Desktop` `~/Documents` `~/Downloads` `~/Pictures` `~/Movies` `~/Music` + iCloud Drive（本机 7 项，iCloud 路径不存在被过滤） | `~/.config/user-dirs.dirs` 的 XDG_*_DIR |
| 额外挂载点 | A:–Z: 中存在的盘符 | `/Volumes/*`（Mac 本机只有 `/`） | `/mnt/*`、`/media/*` |
| 名字索引 | PowerShell + Windows Search（`System.ItemUrl`，**不是** `System.ItemPathDisplay`——后者是本地化假路径 `C:\用户\…`，盘上不存在） | **`mdfind -name`（Spotlight）**：深层目录 105ms 命中、未命中 37ms；1500ms 预算充裕 | `plocate -b` → `locate -b` |

**Mac 的索引明显更强**：Spotlight 覆盖全盘，`D:\Project` 这种工作目录在 Windows
上不在索引范围内，而 Mac 上一个不在任何容器里的深层目录也只需 105ms。

---

## 4. 诊断

`GET /dsh-host-paths/log` 返回：

```json
{ "ok": true, "platform": "darwin", "entries": [...],
  "containers": [...], "known": [...], "denied": [...], "mounts": [...] }
```

- `entries`：最近 80 条事件。浏览器半体的 `drop` / `hit` / `miss` 行能证明
  「脚本已进 `<head>`、`pathFor` 已被 DSH 调用、命中来自哪一级」。
- `denied`：**存在但枚举不了**的已知文件夹（macOS TCC 场景：`~/Documents` 能过
  `existsSync` 却被 `opendir` 拒绝，表现为「拖进去没反应且无任何线索」）。
  这一项由 Mac 侧补充，Mac 实测 `denied: []`。出现非空就往「完全磁盘访问权限」方向查。

---

## 5. 安装（三种方式，按环境选）

### 5.1 单文件安装器（推荐，两端通用）

```bash
node install-dsh-host-paths.mjs --profile <实际运行的那个>
node install-dsh-host-paths.mjs --dry-run          # 先看它要做什么
node install-dsh-host-paths.mjs --uninstall        # 卸载
```

它会：写副本到 `<DSH_HOME>/plugins/dsh-host-paths` → 先试官方 CLI → 被桌面端守卫
拒绝时自动改走等价三步 → 打印重启与验证命令。详见 §10。

### 5.2 官方 CLI（仅限**非**桌面端托管 的 profile）

```bash
dsh plugin --profile <那个profile> add /绝对路径/dsh-host-paths
```

**Mac 侧实测**：官方桌面端的 profile **不能用这条命令**——

```
error: profile "desktop" is managed exclusively by the Electron application
```

守卫在 `dsh/lib/bin.js`（Mac 侧定位到 `:36`）。这种 profile 只能由 App 自己的插件
管理器改，或者走 §5.3。

### 5.3 手工复刻 `installBundle`（桌面端托管 profile 的实际做法）

Mac 侧就是这么装上的，三步：

1. `pnpm add` 把插件放进 profile（或直接在 `<profile>/package.json` 的
   `dependencies` 里写 `"dsh-host-paths": "link:../../plugins/dsh-host-paths"`）；
2. 把 `"dsh-host-paths"` 追加进 `dsh.profile.bundles`；
3. 在 profile 目录 `pnpm install --no-frozen-lockfile`，然后重启 App。

依赖写成**相对** `link:` 而不是绝对路径：`<DSH_HOME>/profiles/<p>` →
`<DSH_HOME>/plugins/<name>` 的两级相对关系在 Windows 与 macOS 上完全一致，
所以同一份 profile 清单两端通用。`link:` 而不是 `file:`，改动副本后重启即生效。

### 5.4 验证

```bash
curl -s http://127.0.0.1:<端口>/dsh-host-paths/log | head -c 600
curl -s -X POST http://127.0.0.1:<端口>/dsh-host-paths/locate \
  -H 'content-type: application/json' -d '{"name":"Documents","directory":true}'
```

**端口不是固定 3080**：Mac 官方桌面端是 **43120**（读 `DSH_WEB_URL`）；
Windows 社区壳是 3080。先看环境变量，再试默认值。

浏览器侧（**刷新页面后**才生效）：`typeof globalThis.__DSH_HOST_PATHS__` 应为
`"object"`；拖一个文件夹应出现 `@…/`；`__DSH_HOST_PATHS__.trace()` 可看浏览器侧
最近 20 次判定。

---

## 6. Mac 实测结论（原「未验证项」的答案）

| 项 | 结论 |
|---|---|
| `mdfind -name` 语义与命中率 | **可用且很快**（命中 105ms / 未命中 37ms），候选另有 `basename` + `stat` 双重校验，索引里的陈旧行会被丢掉 |
| `uiWorkspace.pickDirectory()` | **走原生**：`dsh-host-directory-picker-auto` 在 darwin 选 `native`，`…-native` 用 `osascript` 的 `choose folder`，是系统对话框而非应用内浏览 |
| macOS 完全磁盘访问权限 | 本机无权限问题（`denied: []`） |
| `node --check`（Node v24.21.0） | 三个 JS 全部通过 |
| 跨平台路径转换回归 | `file:///C:/…` → `C:\…`、`file:///D:/…` → `D:\…`、`file:///Users/…` → `/Users/…`、含空格与中文的百分号编码均正确 |

Mac 侧唯一的人工确认缺口：工具栏「📁+ 添加文件夹」的**点击**流程还没点过
（事件日志里没有 `/learn` 记录）；后端与挂载已确认。

---

## 7. 已知边界

- **任意位置靠按钮，不靠拖拽**。拖拽负责「附近」（工作区、已知文件夹、你用过的地方），
  按钮（原生选择器）负责「任意位置」。这是刻意划的线，理由见 §3。
- **多选还差一步**：现在一次选一个（点几次加几个）。要一个对话框里多选，需要给 DSH
  自带的 koffi/COM 子进程（`@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs`）
  的 `IFileOpenDialog` 加 `FOS_ALLOWMULTISELECT`（`0x200`；当前 options 是 `104` = `0x68`），
  并把结果从 `GetResult` 换成 `GetResults`。vtable 槽位：

  | 调用 | 槽位 |
  |---|---|
  | `IFileOpenDialog::GetResults` | 27 |
  | `IShellItemArray::GetCount` | 7 |
  | `IShellItemArray::GetItemAt` | 8 |
  | `IShellItem::GetDisplayName` | 5（现有代码已在用） |

  作者侧**没有**改这一段（那属于改 DSH 自带包，是另一条隔离边界）。

---

## 8. 卸载 / 回滚

- 安装器：`node install-dsh-host-paths.mjs --uninstall`（保留 `~/.dsh/plugins` 下的副本）。
- 手工（Mac 侧用过的方式）：把 `dsh-host-paths` 从 `<profile>/package.json` 的
  `dependencies` 与 `dsh.profile.bundles` 里删掉，再 `pnpm install --no-frozen-lockfile`，
  重启 App。安装器每次改清单前都会备份到 `<profile>/.backup-<时间戳>/package.json.bak`。
- 功能级回滚：删掉插件后，拖文件夹恢复为「弹提示、不生效」，不影响附件上传。

---

## 9. 建议加载的 skills

- `cordis-plugin-development` — bundle 清单、Host/Client 半体、slot 注册、安装验证；
- `cordis-composition-reference` — `cordis.patch.yml` 的 Loader YAML 方言；
- `editing-cordis-compositions` — profile/bundle 的放置与校验。

可对照读的两份同类实现：
`dsh-better-sidebar`（`webServer.register` + `isTrustedApiRequest` 本地信任栅栏）、
`dsh-plugin-drop-path`（window 捕获抢拖拽的写法——**本插件刻意不走这条路**，读它是为了
理解为什么不能走）。

---

## 10. 分发：怎么把它变成一个「真正的插件」

DSH **不从拖拽安装插件**——安装入口只有三种：npm/`github:` 规格、profile 里的
`link:` 依赖、或 App 自带的插件管理 UI。所以「文件夹拖不进去」不是缺陷，是入口本来
就不在那儿。当前有三条路：

| 方式 | 命令 / 操作 | 适用 |
|---|---|---|
| **A. 单文件安装器**（已交付） | `node install-dsh-host-paths.mjs` | 任意机器、任意 profile，含桌面端托管 profile；不需要账号 |
| **B. GitHub 规格** | 推到仓库后：`dsh plugin --profile <p> add github:<owner>/dsh-host-paths` | 非托管 profile；一次推送，之后两端一条命令 |
| **C. npm 包** | `npm publish` 后由 App 的插件管理 UI 一键安装 | 桌面端托管 profile 的最省事路径（若它的 UI 接受 spec） |

B/C 的仓库准备清单（`private: true` 只挡 `npm publish`，不影响 `github:` 安装）：

1. 仓库根放 `package.json`、`cordis.patch.yml`、`index.js`、`client-inject.js`、`client.js`；
2. **构建产物直接提交**（本插件没有构建步骤，源码即产物），
   `files` 字段已经限定了发布内容；
3. 加 `README.md`（写清「它解决什么 + 三种安装方式 + 验证命令」）与 `LICENSE`；
4. 需要 npm 发布时：删掉 `private`、确认包名未被占用、`npm publish --access public`。

---

## 11. 脱敏说明

文档与源码里的 Windows 路径（`D:\Desktop`、`E:\Downloads`、`C:\Users\<user>\…`）
与 Mac 路径（`/Users/<user>/…`）都是两端机器上的实测样本，用于解释「为什么不能猜
`%USERPROFILE%\Desktop`」「为什么端口不能写死」。不含密钥、口令或凭据。
