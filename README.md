# dsh-host-paths

> 让 DSH 真正认得出你拖进来的**文件夹**——把它的绝对路径写进输入框，变成一个
> `@路径/` 引用块。同时给工具栏加一个「📁+ 添加文件夹」按钮，可从本机任意位置选。

仓库名叫 `DSH_Folder_Index`，包名是 **`dsh-host-paths`**（安装后 `dsh.profile.bundles`
里出现的是后者）。

---

## 它解决什么问题

DSH 客户端（`@deepseek-ai/dsh-client-ui-conversation`）的附件入口里有这么一段：

```js
const bridge = hostPathBridge();                    // 读 globalThis.__DSH_HOST_PATHS__
if (bridge === void 0 && directory) return t("attachment.directoryDesktopOnly");
const path = bridge?.pathFor(file) ?? "";           // 同步取绝对路径
```

- 文件夹拖放的**归属权本来就在 DSH 自己手里**，它只缺一个同步的 `pathFor(file)`；
- 桥在 → 文件夹（一次拖多个也行）变成 `@相对路径/` 引用块；
- 桥不在 → 只弹一句 `只有桌面端支持添加文件夹，浏览器里请添加单个文件`。

问题是：**很多壳没有注入这个桥**。作者在社区 Tauri 桌面壳与官方 macOS 桌面端上
都验证过——两边的全应用搜索里，`__DSH_HOST_PATHS__` 只有消费方，没有注入方。
于是「拖文件夹进去什么也不发生」。

本插件把桥补上。它**不抢拖拽事件**（不 `preventDefault`、不 `stopPropagation`），
所以原生遮罩层与原生附件流程全程照旧；**普通文件依旧走上传**，只有文件夹被接管。

---

## 安装

### 方式 A：单文件安装器（推荐，任意 profile）

适合所有人，尤其是**官方桌面端**——它的 profile 被 App 独占管理，`dsh plugin` 会被
守卫拒绝（`profile "xxx" is managed exclusively by the Electron application`），
而安装器会自动改走等价的三步流程。

```bash
node install-dsh-host-paths.mjs --dry-run          # 先看它要做什么
node install-dsh-host-paths.mjs                    # 装进当前 profile
node install-dsh-host-paths.mjs --profile desktop  # 有多个 profile 时指定
node install-dsh-host-paths.mjs --uninstall        # 卸载
```

它会：把源文件写到 `<DSH_HOME>/plugins/dsh-host-paths` → 先试官方 CLI →
被守卫拒绝时自动备份 profile 清单、写入相对的 `link:` 依赖与 `dsh.profile.bundles`、
执行 `pnpm install` → 打印重启与验证命令。

> 这个文件是自包含的（源码快照内联其中），也可以单独拷到另一台机器上跑；
> 在仓库目录里跑时，它优先使用**同目录的当前源文件**而不是快照。

### 方式 B：GitHub 源码

```bash
dsh plugin --profile <profile> add github:quimir/DSH_Folder_Index
# 建议锁定 commit，避免后续推送悄悄改变实际运行的内容：
dsh plugin --profile <profile> add github:quimir/DSH_Folder_Index#<sha>
```

pnpm ≥10 默认拒绝执行 git 依赖的构建脚本。本包**没有构建步骤**（源码即产物，
没有 `prepare` 脚本），正常不会触发授权；若 dsh 仍然提示需要授权，按它给出的确切
包键写进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-host-paths: true
```

### 方式 C：本地 tarball

```bash
pnpm pack                                  # 产出 dsh-host-paths-0.3.0.tgz
dsh plugin --profile <profile> add ./dsh-host-paths-0.3.0.tgz
```

预构建、免授权，适合内网或离线机器。

### 装完必须重启

**宿主半体没有热重载**（客户端半体有），而且客户端模块图是重启时才重新扫描的——
不重启两边都不生效。桌面端：完全退出再打开；`dsh web`：停掉进程重开。

---

## 验证

```bash
curl -s http://127.0.0.1:<端口>/dsh-host-paths/log
```

期望看到 `platform` / `known` / `mounts` / `denied` / `entries`。
**端口不是固定 3080**：读环境变量 `DSH_WEB_URL`（macOS 官方桌面端是 43120）。

浏览器侧（刷新页面后）：控制台里 `typeof globalThis.__DSH_HOST_PATHS__` 应为
`"object"`；拖一个文件夹应出现 `@…/`；`__DSH_HOST_PATHS__.trace()` 看最近 20 次判定。

---

## 平台支持

| 能力 | win32 | darwin | linux |
|---|---|---|---|
| 已知文件夹 | 注册表 `User Shell Folders`（Explorer 会重定向，别猜 `%USERPROFILE%`） | `~/Desktop` `~/Documents` `~/Downloads` `~/Pictures` `~/Movies` `~/Music` + iCloud Drive | `~/.config/user-dirs.dirs` 的 XDG_*_DIR |
| 额外挂载点 | 存在的盘符 | `/Volumes/*` | `/mnt/*`、`/media/*` |
| 名字索引 | PowerShell + Windows Search（取 `System.ItemUrl`，**不是**本地化的假路径 `System.ItemPathDisplay`） | `mdfind -name`（Spotlight） | `plocate -b` → `locate -b` |

三端都已实测：Windows 社区 Tauri 壳、macOS 官方桌面端（Electron）。平台分支只有
宿主半体的上面三处，其余是平台无关的 `node:path` / `node:fs`，**不需要维护两份代码**。

---

## 边界（这是设计，不是没做完）

- **拖拽只负责「附近」**：工作区根 ±2 层、平台已知文件夹、你用过的地方（会被记住），
  外加平台文件索引。浏览器不会把绝对路径交给页面，拖拽 payload 里只有文件夹**名字**；
  两端实测连 `text/uri-list` 都是空的。
- **全盘递归搜索不做**：实测剪枝后跑一遍 318GB 的分区要 **28.5 秒 / 66,059 个目录**，
  同步做等于卡死页面。所以定位不到时会**明确失败**（DSH 提示「无法获取文件夹路径，
  请重新拖入」），而不是塞一个假路径。
- **任意位置靠按钮**：工具栏「📁+ 添加文件夹」调 DSH 自己的原生选择器
  （`uiWorkspace.pickDirectory()`，macOS 上是 `osascript` 的 `choose folder`），
  系统直接给出真实路径，没有搜索也没有同名歧义。
- **多选还差一步**：现在一次选一个（点几次加几个）。要一个对话框里多选，需要改 DSH
  自带那个 koffi/COM 子进程（加 `FOS_ALLOWMULTISELECT`，把 `GetResult` 换成
  `GetResults`）——那属于改 DSH 自己的包，本仓库没有动。

---

## 诊断

`GET /dsh-host-paths/log`：

| 字段 | 含义 |
|---|---|
| `platform` | `win32` / `darwin` / `linux` |
| `entries` | 最近 80 条事件：`drop`（拖了什么）、`locate`（找没找到、耗时、是否走了索引）、`hit`/`miss`（浏览器侧判定） |
| `containers` | 已学到的容器（持久化在 `~/.dsh/storages/dsh-host-paths/containers.json`） |
| `known` | 本机真实已知文件夹 |
| `denied` | **存在但枚举不了**的已知文件夹（macOS TCC：`~/Documents` 过得了 `existsSync` 却被 `opendir` 拒绝）。非空就往「完全磁盘访问权限」方向查 |
| `mounts` | 探测用的挂载点 |

路由只接受回环来源；若把 GUI 暴露到局域网，需要把该 authority 写进
`webRuntime.trustedHosts`（与 DSH 自带插件的信任栅栏同一套规则），否则 `/locate`
会返回 403。

---

## 实现要点与交接

见 [`HANDOFF.md`](./HANDOFF.md)：DSH 契约的 grep 锚点、安装/回滚、macOS 落地实测、
以及多选对话框要改的 vtable 槽位。

---

## English

A DSH plugin that supplies the `globalThis.__DSH_HOST_PATHS__` bridge shells are
supposed to inject, so a **dropped folder** becomes a real `@path/` reference
instead of the "only the desktop app can add folders" notice. It never touches
drag-event ownership, never fabricates a path, and leaves plain-file drops on the
normal upload path. It also adds an **Add folder** button that opens DSH's own
native picker, which reaches any location on the machine.

```bash
node install-dsh-host-paths.mjs            # works on managed (desktop-app) profiles too
# or: dsh plugin --profile <p> add github:quimir/DSH_Folder_Index
```

Verified on Windows 11 (community Tauri shell) and macOS (official DSH Desktop).
MIT licensed.
