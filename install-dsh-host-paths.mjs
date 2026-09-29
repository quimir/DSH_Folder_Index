#!/usr/bin/env node
/**
 * dsh-host-paths 自安装器（单文件，零依赖）
 *
 * 背景：DSH 不从"拖一个文件夹进去"安装插件——它的安装入口是 npm / github 规格，
 * 或 profile 里的 link: 依赖。所以这个文件把整件事压成**一条命令**：
 *
 *     node install-dsh-host-paths.mjs
 *
 * 它做三件事：
 *   1. 把 5 个源文件写到 `<DSH_HOME>/plugins/dsh-host-paths`（稳定副本）；
 *   2. 装进 profile：先试官方 CLI `dsh plugin --profile <p> add <dir>`；
 *      被 `profile "<p>" is managed exclusively by the Electron application` 挡下时，
 *      复刻它的三步（备份 profile/package.json → 写 link: 依赖 + dsh.profile.bundles
 *      → pnpm install）——官方桌面端的 profile 只能这样装；
 *   3. 打印重启与验证命令。
 *
 * 用法：
 *   node install-dsh-host-paths.mjs                    # 只有一个 profile 时自动选
 *   node install-dsh-host-paths.mjs --profile desktop  # 指定 profile
 *   node install-dsh-host-paths.mjs --dry-run          # 只打印将要做的事
 *   node install-dsh-host-paths.mjs --uninstall        # 卸载（保留 ~/.dsh/plugins 下的副本）
 *
 * 退出码：0 成功；1 参数或环境错误；2 安装步骤失败（已在失败点说明是否改动过文件）。
 *
 * 安全：任何写 profile/package.json 之前都会先备份到
 * `<profile>/.backup-<时间戳>/package.json.bak`，并且 --dry-run 全程不落盘。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** bundle 名字（等于包名）。 */
const BUNDLE = 'dsh-host-paths'
/** profile 里使用的依赖说明符：相对 link，Windows 与 macOS 通用。 */
const SPEC = 'link:../../plugins/dsh-host-paths'
/** 插件源码的内联快照（由构建脚本写入），键是文件名。 */
const EMBEDDED = /*__SOURCES_JSON__*/ {"package.json":"{\n  \"name\": \"dsh-host-paths\",\n  \"version\": \"0.3.0\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"main\": \"./index.js\",\n  \"description\": \"Supplies globalThis.__DSH_HOST_PATHS__ for DSH shells that do not implement the desktop bridge, so a dropped folder becomes a real @ reference instead of '只有桌面端支持添加文件夹'; also adds an 'Add folder' button that picks any folder on this machine. Cross-platform: win32 (registry + Windows Search), darwin (home folders + Spotlight mdfind), linux (XDG + plocate/locate).\",\n  \"keywords\": [\"deepseek\", \"harness\", \"dsh\", \"dsh-plugin\", \"drag-and-drop\", \"folder\", \"path\", \"drag-drop\"],\n  \"license\": \"MIT\",\n  \"repository\": { \"type\": \"git\", \"url\": \"git+https://github.com/quimir/DSH_Folder_Index.git\" },\n  \"homepage\": \"https://github.com/quimir/DSH_Folder_Index#readme\",\n  \"bugs\": { \"url\": \"https://github.com/quimir/DSH_Folder_Index/issues\" },\n  \"engines\": { \"node\": \">=20\" },\n  \"exports\": { \".\": \"./index.js\", \"./client\": \"./client.js\" },\n  \"files\": [\n    \"index.js\",\n    \"client.js\",\n    \"client-inject.js\",\n    \"cordis.patch.yml\",\n    \"install-dsh-host-paths.mjs\",\n    \"README.md\",\n    \"HANDOFF.md\",\n    \"LICENSE\"\n  ],\n  \"dsh\": {\n    \"bundle\": { \"patch\": \"./cordis.patch.yml\" },\n    \"client\": {\n      \"platform\": \"web\",\n      \"immediately\": true,\n      \"inject\": [\"@deepseek-ai/dsh-client-ui-conversation\"]\n    }\n  }\n}\n","cordis.patch.yml":"# dsh-host-paths bundle patch: mount the desktop-bridge shim row.\n#\n# The host half registers the /dsh-host-paths routes and injects one script into\n# the served index.html; the script defines globalThis.__DSH_HOST_PATHS__, which\n# @deepseek-ai/dsh-client-ui-conversation reads through hostPathBridge().\n- insert:\n    - id: dsh-host-paths\n      name: 'dsh-host-paths'\n","index.js":"/**\n * dsh-host-paths — 宿主半体（跨平台：win32 / darwin / linux）\n *\n * 一句话：**给没实现桌面桥的壳，补上 DSH 自己要的那个 `globalThis.__DSH_HOST_PATHS__`。**\n *\n * # 为什么是这个东西，而不是「抢拖拽事件」\n *\n * DSH 客户端（`@deepseek-ai/dsh-client-ui-conversation`）在附件入口里写死了这段：\n *\n *     const bridge = hostPathBridge();                    // globalThis.__DSH_HOST_PATHS__\n *     if (bridge === void 0 && directory) return t(\"attachment.directoryDesktopOnly\");\n *     const path = bridge?.pathFor(file) ?? \"\";           // 同步拿绝对路径\n *\n * 也就是说：**文件夹拖放的归属权本来就在 DSH 自己手里**，它只是缺一个同步的\n * `pathFor(file)`。桥在 → 文件夹（含一次拖多个）会走 `formatFileMention` 变成\n * `@相对路径/` 引用块；桥不在 → 只弹「只有桌面端支持添加文件夹」（英文 locale\n * 下是 `attachment.directoryDesktopOnly`）。\n *\n * 所以这里不碰 dragenter/dragover/drop 的归属：不 preventDefault、不\n * stopPropagation，原生遮罩层和原生处理器全程照旧。我们只是把桥补上。\n *\n * # 路径从哪来（按代价从低到高）\n *\n * 浏览器不给绝对路径（安全模型）。拖拽 payload 里只有文件夹的**名字**，所以\n * 只能按名字找，四级：\n *\n *   1. 学到的容器：上次成功解析/选择过的目录（持久化在 ~/.dsh/storages/…，最可能命中）；\n *   2. 工作区根 ±2 层 + 根所在卷的挂载点；\n *   3. 平台已知文件夹（见下表）；\n *   4. 平台文件索引（见下表）。\n *\n * 每一级都是 `stat(<容器>/<名字>)`，有界（≤160 次）。全盘递归扫描实测约\n * **28.5 秒 / 6.6 万目录**（Windows，D 盘 318GB），所以不做——落在这四级之外的\n * 目录会明确失败，`pathFor` 返回 \"\"，DSH 自己提示「无法获取文件夹路径，请重新\n * 拖入」。**任意位置**靠 client.js 里那个原生选择器按钮，不靠搜索。\n *\n * # 平台差异（只有这三处，其余全是 node:path / node:fs 的平台无关调用）\n *\n * | 能力 | win32 | darwin | linux |\n * |---|---|---|---|\n * | 已知文件夹 | 注册表 `User Shell Folders`（作者机器上是 D:\\Desktop、D:\\Documents、E:\\Downloads —— 别猜 %USERPROFILE%） | `~/Desktop` `~/Documents` `~/Downloads` `~/Pictures` `~/Movies` `~/Music` + iCloud Drive | `~/.config/user-dirs.dirs` 的 XDG_*_DIR，缺失时退回 home 相对路径 |\n * | 额外挂载点 | A:–Z: 中存在的盘符 | `/Volumes/*` | `/mnt/*`、`/media/*` |\n * | 名字索引 | PowerShell + Windows Search（取 `System.ItemUrl`，**不是** `System.ItemPathDisplay`，后者是本地化假路径 `C:\\用户\\…`，盘上不存在） | `mdfind -name`（Spotlight，默认覆盖全盘，三个平台里最好用） | `plocate -b` → `locate -b` |\n *\n * macOS 的 Spotlight 覆盖全盘，所以在 Mac 上「拖任意位置」的成功率明显高于\n * Windows——Windows 的索引只覆盖已知文件夹那一片，`D:\\Project` 这类工作目录\n * 不在其中。\n *\n * # 诊断\n *\n * `GET /dsh-host-paths/log` 返回最近 80 条事件 + 当前平台、容器列表、已知文件夹、\n * 已知但读不了的目录（macOS TCC）、挂载点。只监听回环地址，不往磁盘写敏感内容。\n */\nimport { execFile, execFileSync } from 'node:child_process'\nimport { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'\nimport { stat } from 'node:fs/promises'\nimport { homedir } from 'node:os'\nimport { basename, dirname, join, parse as parsePath } from 'node:path'\nimport { fileURLToPath } from 'node:url'\n\n/** Plugin identity for cordis.yml rows. */\nexport const name = 'dsh-host-paths'\n/** Services required before mounting: the webserver routes and the index tap. */\nexport const inject = ['webServer']\n\nconst BASE = '/dsh-host-paths'\n/** Directory of this host-half module (the browser script lives next to it). */\nconst HERE = dirname(fileURLToPath(import.meta.url))\n/** The browser script inlined into the served index.html. */\nconst CLIENT_SCRIPT = readFileSync(join(HERE, 'client-inject.js'), 'utf8')\n/** Diagnostic ring size. */\nconst MAX_LOG = 80\n/** Hard ceiling on filesystem probes for one lookup. */\nconst MAX_STAT = 160\n/** Where learned containers persist (next to the other plugin storages). */\nconst STORE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-host-paths', 'containers.json')\n/** How many learned containers to keep. */\nconst MAX_LEARNED = 40\n/** Search-index result cache lifetime. */\nconst INDEX_TTL_MS = 60_000\n/** How many index candidates to keep after verification. */\nconst MAX_INDEX_HITS = 25\n\n/**\n * Whether one request may reach these routes.\n *\n * Loopback is always allowed. A deployment that serves the GUI beyond loopback\n * (the LAN-access composition) must name those authorities in\n * `ctx.webRuntime.trustedHosts`; they are accepted exactly the way the shipped\n * plugins accept them (`isTrustedApiRequest`), because the page calling us is\n * served from that very authority. Everything else — a cross-site browser\n * request, or an authority nobody vouched for — is refused: these routes hand\n * out local absolute paths.\n *\n * The host header is checked first, so an unlisted LAN origin gets a 403 instead\n * of silently breaking the drag bridge; if that happens, add the authority to\n * `webRuntime.trustedHosts` (or `connection`), not a wildcard here.\n *\n * @param request - node HTTP request.\n * @param ctx - host plugin context (reads the optional webRuntime service).\n * @returns true when the request is same-origin as the GUI we serve.\n */\nfunction trusted(request, ctx) {\n\tconst host = request.headers.host\n\tif (typeof host !== 'string' || host === '') return false\n\tif (request.headers['sec-fetch-site'] === 'cross-site') return false\n\tconst hostname = host.replace(/:\\d+$/u, '')\n\tconst loopback = /^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/iu.test(hostname)\n\tif (!loopback && !trustedAuthority(host, hostname, ctx)) return false\n\tconst origin = request.headers.origin\n\tif (typeof origin !== 'string' || origin === '') return true\n\ttry {\n\t\treturn new URL(origin).hostname === hostname\n\t} catch {\n\t\treturn false\n\t}\n}\n\n/**\n * The authorities this deployment vouches for, from the optional `webRuntime`\n * service. A port-less entry (`192.168.1.9`) matches any port.\n *\n * @param host - the raw Host header.\n * @param hostname - the Host header without its port.\n * @param ctx - host plugin context.\n * @returns true when the authority is listed.\n */\nfunction trustedAuthority(host, hostname, ctx) {\n\tlet hosts = []\n\ttry {\n\t\thosts = ctx.get('webRuntime')?.trustedHosts ?? []\n\t} catch {\n\t\thosts = []\n\t}\n\tif (!Array.isArray(hosts)) return false\n\tconst full = host.toLowerCase()\n\tconst bare = hostname.toLowerCase()\n\treturn hosts.some((entry) => {\n\t\tif (typeof entry !== 'string' || entry === '') return false\n\t\tconst normalized = entry.toLowerCase().replace(/^https?:\\/\\//u, '').replace(/\\/+$/u, '')\n\t\treturn normalized === full || normalized === bare\n\t})\n}\n\n/** Write one JSON response with caching disabled. */\nfunction send(response, status, body) {\n\tresponse.writeHead(status, {\n\t\t'content-type': 'application/json; charset=utf-8',\n\t\t'cache-control': 'no-store'\n\t})\n\tresponse.end(JSON.stringify(body))\n}\n\n/** Read and parse a bounded JSON request body. */\nfunction readBody(request, limit = 64 * 1024) {\n\treturn new Promise((done, fail) => {\n\t\tlet size = 0\n\t\tconst chunks = []\n\t\trequest.on('data', (chunk) => {\n\t\t\tsize += chunk.length\n\t\t\tif (size > limit) {\n\t\t\t\tfail(new Error('body too large'))\n\t\t\t\trequest.destroy()\n\t\t\t\treturn\n\t\t\t}\n\t\t\tchunks.push(chunk)\n\t\t})\n\t\trequest.on('end', () => {\n\t\t\ttry {\n\t\t\t\tdone(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))\n\t\t\t} catch (error) {\n\t\t\t\tfail(error)\n\t\t\t}\n\t\t})\n\t\trequest.on('error', fail)\n\t})\n}\n\n/**\n * Run a child process and collect stdout, never rejecting.\n *\n * @param command - executable name resolved through PATH.\n * @param args - argv passed without a shell.\n * @param timeout - milliseconds before the child is killed.\n * @returns stdout text ('' on any failure).\n */\nfunction run(command, args, timeout) {\n\treturn new Promise((done) => {\n\t\ttry {\n\t\t\texecFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {\n\t\t\t\tdone(error === null || error === undefined ? String(stdout) : '')\n\t\t\t})\n\t\t} catch {\n\t\t\tdone('')\n\t\t}\n\t})\n}\n\n/**\n * Synchronous child run, used only for the one-time registry read on Windows.\n *\n * @param command - executable name resolved through PATH.\n * @param args - argv passed without a shell.\n * @returns stdout text ('' on any failure).\n */\nfunction runSync(command, args) {\n\ttry {\n\t\treturn String(execFileSync(command, args, { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }))\n\t} catch {\n\t\treturn ''\n\t}\n}\n\n/** `%VAR%` (Windows registry values) expansion. */\nfunction expandPercentVars(value) {\n\treturn value.replace(/%([^%]+)%/gu, (whole, name) => process.env[name] ?? whole)\n}\n\n/** `$VAR` / `${VAR}` (XDG user-dirs values) expansion. */\nfunction expandDollarVars(value) {\n\treturn value.replace(/\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?/gu, (whole, name) => process.env[name] ?? whole)\n}\n\n/** Keep only the paths that exist, de-duplicated case-insensitively. */\nfunction existing(list) {\n\tconst seen = new Set()\n\tconst kept = []\n\tfor (const value of list) {\n\t\tif (typeof value !== 'string' || value === '') continue\n\t\tconst key = value.toLowerCase()\n\t\tif (seen.has(key)) continue\n\t\tseen.add(key)\n\t\tif (!existsSync(value)) continue\n\t\tkept.push(value)\n\t}\n\treturn kept\n}\n\n/**\n * Known folders this process can see but cannot enumerate.\n *\n * On macOS a TCC-protected folder such as `~/Documents` still passes\n * `existsSync` while `opendir` is refused, so a drop inside it fails with no\n * visible reason. Reporting the denial turns that silent miss into a diagnosis:\n * grant the DSH host process Full Disk Access, then restart it.\n *\n * Added by the macOS landing session (2026-09-29); Windows behaviour unchanged.\n *\n * @returns absolute known-folder paths that exist but cannot be listed.\n */\nfunction deniedKnownFolders() {\n\tconst denied = []\n\tfor (const folder of knownFolders()) {\n\t\ttry {\n\t\t\treaddirSync(folder)\n\t\t} catch {\n\t\t\tdenied.push(folder)\n\t\t}\n\t}\n\treturn denied\n}\n\n/**\n * Windows: the real shell folders, which Explorer relocates freely.\n *\n * @returns existing absolute known-folder paths.\n */\nfunction windowsKnownFolders() {\n\tconst map = new Map()\n\tconst key = 'HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\User Shell Folders'\n\tconst text = runSync('reg.exe', ['query', key])\n\tfor (const line of text.split(/\\r?\\n/u)) {\n\t\tconst match = /^\\s{4}(.+?)\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$/u.exec(line)\n\t\tif (match === null) continue\n\t\tmap.set(match[1].toUpperCase(), expandPercentVars(match[2]))\n\t}\n\tconst home = homedir()\n\tconst pick = (name, fallback) => {\n\t\tconst value = map.get(name)\n\t\treturn typeof value === 'string' && value !== '' ? value : fallback\n\t}\n\treturn existing([\n\t\tpick('DESKTOP', join(home, 'Desktop')),\n\t\tpick('PERSONAL', join(home, 'Documents')),\n\t\tpick('{374DE290-123F-4565-9164-39C4925E467B}', join(home, 'Downloads')),\n\t\tpick('MY PICTURES', join(home, 'Pictures')),\n\t\thome\n\t])\n}\n\n/**\n * macOS: the standard home folders, plus iCloud Drive. `existsSync` filters the\n * ones this account does not have (or has relocated).\n *\n * @returns existing absolute known-folder paths.\n */\nfunction macKnownFolders() {\n\tconst home = homedir()\n\treturn existing([\n\t\tjoin(home, 'Desktop'),\n\t\tjoin(home, 'Documents'),\n\t\tjoin(home, 'Downloads'),\n\t\tjoin(home, 'Pictures'),\n\t\tjoin(home, 'Movies'),\n\t\tjoin(home, 'Music'),\n\t\tjoin(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),\n\t\thome\n\t])\n}\n\n/**\n * Linux: XDG user dirs when `~/.config/user-dirs.dirs` exists, conventional names\n * otherwise.\n *\n * @returns existing absolute known-folder paths.\n */\nfunction linuxKnownFolders() {\n\tconst home = homedir()\n\tconst map = new Map()\n\ttry {\n\t\tconst text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8')\n\t\tfor (const line of text.split(/\\r?\\n/u)) {\n\t\t\tconst match = /^\\s*XDG_([A-Z]+)_DIR\\s*=\\s*\"?([^\"\\n]+)\"?/u.exec(line)\n\t\t\tif (match === null) continue\n\t\t\tmap.set(match[1].toUpperCase(), expandDollarVars(match[2]))\n\t\t}\n\t} catch {\n\t\t/* no user-dirs.dirs: fall back to the conventional names */\n\t}\n\tconst pick = (name, fallback) => {\n\t\tconst value = map.get(name)\n\t\treturn typeof value === 'string' && value !== '' ? value : fallback\n\t}\n\treturn existing([\n\t\tpick('DESKTOP', join(home, 'Desktop')),\n\t\tpick('DOCUMENTS', join(home, 'Documents')),\n\t\tpick('DOWNLOAD', join(home, 'Downloads')),\n\t\tpick('PICTURES', join(home, 'Pictures')),\n\t\thome\n\t])\n}\n\n/**\n * The machine's real known folders, read once.\n *\n * @returns absolute known-folder paths that exist on this machine.\n */\nfunction knownFolders() {\n\tif (knownFolders.cache !== undefined) return knownFolders.cache\n\ttry {\n\t\tif (process.platform === 'win32') knownFolders.cache = windowsKnownFolders()\n\t\telse if (process.platform === 'darwin') knownFolders.cache = macKnownFolders()\n\t\telse knownFolders.cache = linuxKnownFolders()\n\t} catch {\n\t\tknownFolders.cache = existing([homedir()])\n\t}\n\treturn knownFolders.cache\n}\n\n/** Small synchronous readdir that returns [] instead of throwing. */\nfunction readdirDirectories(dir) {\n\ttry {\n\t\treturn readdirSync(dir, { withFileTypes: true })\n\t\t\t.filter((entry) => entry.isDirectory())\n\t\t\t.map((entry) => entry.name)\n\t} catch {\n\t\treturn []\n\t}\n}\n\n/**\n * Mount points worth probing: Windows drive letters, macOS `/Volumes`, Linux\n * `/mnt` and `/media` children.\n *\n * @returns absolute mount roots that exist.\n */\nfunction mountRoots() {\n\tif (mountRoots.cache !== undefined) return mountRoots.cache\n\tconst list = []\n\tif (process.platform === 'win32') {\n\t\tfor (let code = 65; code <= 90; code += 1) {\n\t\t\tconst root = `${String.fromCharCode(code)}:\\\\`\n\t\t\tif (existsSync(root)) list.push(root)\n\t\t}\n\t} else {\n\t\tconst bases = process.platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media']\n\t\tfor (const base of bases) {\n\t\t\tfor (const child of readdirDirectories(base)) list.push(join(base, child))\n\t\t}\n\t\tlist.push('/')\n\t}\n\tmountRoots.cache = existing(list)\n\treturn mountRoots.cache\n}\n\n/** Containers learned from folders this user has resolved or picked before. */\nfunction learnedContainers() {\n\tif (learnedContainers.cache !== undefined) return learnedContainers.cache\n\ttry {\n\t\tconst parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))\n\t\tlearnedContainers.cache = Array.isArray(parsed?.containers) ? parsed.containers.filter((v) => typeof v === 'string') : []\n\t} catch {\n\t\tlearnedContainers.cache = []\n\t}\n\treturn learnedContainers.cache\n}\n\n/** Remember one directory whose children are worth checking first next time. */\nfunction learn(dir) {\n\tif (typeof dir !== 'string' || dir === '') return\n\tconst list = learnedContainers()\n\tconst key = dir.toLowerCase()\n\tconst next = [dir, ...list.filter((value) => value.toLowerCase() !== key)].slice(0, MAX_LEARNED)\n\tlearnedContainers.cache = next\n\ttry {\n\t\tmkdirSync(dirname(STORE_FILE), { recursive: true })\n\t\twriteFileSync(STORE_FILE, JSON.stringify({ containers: next }, null, 2), 'utf8')\n\t} catch {\n\t\t/* a failed write only costs the hint */\n\t}\n}\n\n/**\n * Directories that may hold the dropped item, most likely first.\n *\n * @param ctx - host plugin context.\n * @returns ordered candidate container directories, de-duplicated case-insensitively.\n */\nfunction containers(ctx) {\n\tconst list = []\n\tconst seen = new Set()\n\tconst add = (value) => {\n\t\tif (typeof value !== 'string' || value === '') return\n\t\tconst key = value.toLowerCase()\n\t\tif (seen.has(key)) return\n\t\tseen.add(key)\n\t\tlist.push(value)\n\t}\n\t/* 1. Learned first: the places this user actually works from. */\n\tfor (const learned of learnedContainers()) add(learned)\n\t/* 2. Workspace roots, their parents, and the volume roots they live on. */\n\tconst roots = []\n\ttry {\n\t\tconst registry = ctx.get('workspaceRegistry')\n\t\tfor (const workspace of registry?.list?.() ?? []) {\n\t\t\tconst path = workspace?.path ?? workspace?.cwd\n\t\t\tif (typeof path === 'string' && path !== '') roots.push(path)\n\t\t}\n\t} catch {\n\t\t/* registry absent: fall back to the process cwd alone */\n\t}\n\troots.push(process.cwd())\n\tfor (const root of roots) {\n\t\tlet cursor = root\n\t\tfor (let depth = 0; depth < 3; depth += 1) {\n\t\t\tadd(cursor)\n\t\t\tconst parent = dirname(cursor)\n\t\t\tif (parent === cursor) break\n\t\t\tcursor = parent\n\t\t}\n\t\tadd(parsePath(root).root)\n\t}\n\t/* 3. Known folders, the places they live, and every other mount. */\n\tfor (const folder of knownFolders()) {\n\t\tadd(folder)\n\t\tadd(dirname(folder))\n\t}\n\tfor (const mount of mountRoots()) add(mount)\n\treturn list\n}\n\n/**\n * Keep the index candidates whose basename really is `name` and whose kind matches.\n *\n * Platform indexes all match loosely (`mdfind -name`, `locate -b`, Windows Search),\n * so every candidate is verified against the real filesystem before it is trusted.\n *\n * @param candidates - raw paths reported by the platform index.\n * @param name - the exact base name the drop asked for.\n * @param directory - whether a folder is required.\n * @returns verified absolute paths, capped at {@link MAX_INDEX_HITS}.\n */\nasync function verifyCandidates(candidates, name, directory) {\n\tconst hits = []\n\tconst seen = new Set()\n\tfor (const candidate of candidates) {\n\t\tif (hits.length >= MAX_INDEX_HITS) break\n\t\tif (typeof candidate !== 'string' || candidate === '') continue\n\t\tif (basename(candidate) !== name) continue\n\t\tconst key = candidate.toLowerCase()\n\t\tif (seen.has(key)) continue\n\t\tseen.add(key)\n\t\ttry {\n\t\t\tconst info = await stat(candidate)\n\t\t\tif (directory === true ? info.isDirectory() : info.isDirectory() || info.isFile()) hits.push(candidate)\n\t\t} catch {\n\t\t\t/* a stale index row is simply skipped */\n\t\t}\n\t}\n\treturn hits\n}\n\n/**\n * Windows Search through PowerShell + OleDb.\n *\n * `System.ItemUrl` carries the real path (`file:C:/Users/...`); `System.ItemPathDisplay`\n * is the localized display form (`C:\\用户\\...`) which does not exist on disk, so it is\n * never used.\n *\n * @param name - the base name to look up.\n * @param budget - child-process timeout in milliseconds.\n * @returns raw candidate paths.\n */\nasync function windowsIndex(name, budget) {\n\tconst literal = name.replace(/'/gu, \"''\")\n\tconst script = [\n\t\t\"$ErrorActionPreference='Stop'\",\n\t\t\"$c=New-Object System.Data.OleDb.OleDbConnection \\\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\\\"\",\n\t\t'$c.Open()',\n\t\t'$q=$c.CreateCommand()',\n\t\t`$q.CommandText=\"SELECT TOP ${MAX_INDEX_HITS} System.ItemUrl FROM SYSTEMINDEX WHERE System.FileName = '${literal}'\"`,\n\t\t'$r=$q.ExecuteReader()',\n\t\t'while($r.Read()){ $r.GetValue(0) }',\n\t\t'$c.Close()'\n\t].join('; ')\n\tconst args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]\n\tlet text = await run('pwsh.exe', args, budget)\n\tif (text === '') text = await run('powershell.exe', args, Math.min(budget, 2500))\n\tconst paths = []\n\tfor (const line of text.split(/\\r?\\n/u)) {\n\t\tconst value = line.trim()\n\t\tif (!value.toLowerCase().startsWith('file:')) continue\n\t\tlet candidate = value.slice(5).replace(/\\//gu, '\\\\')\n\t\tif (/^\\\\[A-Za-z]:/u.test(candidate)) candidate = candidate.slice(1)\n\t\ttry {\n\t\t\tpaths.push(decodeURIComponent(candidate))\n\t\t} catch {\n\t\t\tpaths.push(candidate)\n\t\t}\n\t}\n\treturn paths\n}\n\n/**\n * macOS Spotlight: the widest reach of the three platforms (whole disk by default).\n *\n * @param name - the base name to look up.\n * @param budget - child-process timeout in milliseconds.\n * @returns raw candidate paths.\n */\nasync function macIndex(name, budget) {\n\tconst text = await run('mdfind', ['-name', name], budget)\n\treturn text.split(/\\r?\\n/u).map((line) => line.trim()).filter((line) => line !== '')\n}\n\n/**\n * Linux: plocate first, then locate.\n *\n * @param name - the base name to look up.\n * @param budget - child-process timeout in milliseconds.\n * @returns raw candidate paths.\n */\nasync function linuxIndex(name, budget) {\n\tfor (const tool of ['plocate', 'locate']) {\n\t\tconst text = await run(tool, ['-b', '-l', String(MAX_INDEX_HITS), name], budget)\n\t\tif (text !== '') return text.split(/\\r?\\n/u).map((line) => line.trim()).filter((line) => line !== '')\n\t}\n\treturn []\n}\n\n/**\n * Ask the platform's file index for a name and return verified absolute paths.\n *\n * @param name - the base name to look up.\n * @param budget - child-process timeout in milliseconds.\n * @param directory - whether a folder is required.\n * @returns existing matching paths.\n */\nasync function searchIndex(name, budget, directory) {\n\tconst cacheKey = `${directory === true ? 'd' : 'f'}:${name.toLowerCase()}`\n\tconst hit = indexCache.get(cacheKey)\n\tif (hit !== undefined && Date.now() - hit.at < INDEX_TTL_MS) return hit.paths\n\tlet raw = []\n\ttry {\n\t\tif (process.platform === 'win32') raw = await windowsIndex(name, budget)\n\t\telse if (process.platform === 'darwin') raw = await macIndex(name, budget)\n\t\telse raw = await linuxIndex(name, budget)\n\t} catch {\n\t\traw = []\n\t}\n\tconst paths = await verifyCandidates(raw, name, directory)\n\tindexCache.set(cacheKey, { at: Date.now(), paths })\n\treturn paths\n}\n/** Search-index result cache. */\nconst indexCache = new Map()\n\n/**\n * Resolve one dropped item's absolute path by name against the candidate containers.\n *\n * @param ctx - host plugin context.\n * @param name - the dropped item's base name (no separators; anything else is refused).\n * @param directory - whether the item is a folder (folders must resolve to a folder).\n * @param budget - search-index child-process timeout; 0 skips the index entirely.\n * @returns the absolute path, or undefined when nothing matched inside the budget.\n */\nasync function locate(ctx, name, directory, budget) {\n\tif (typeof name !== 'string' || name === '' || name === '.' || name === '..') return undefined\n\tif (/[\\\\/\\u0000]/u.test(name)) return undefined\n\tlet probes = MAX_STAT\n\tfor (const container of containers(ctx)) {\n\t\tif (probes <= 0) break\n\t\tprobes -= 1\n\t\tconst candidate = join(container, name)\n\t\ttry {\n\t\t\tconst info = await stat(candidate)\n\t\t\tif (directory === true ? info.isDirectory() : info.isDirectory() || info.isFile()) {\n\t\t\t\tlearn(container)\n\t\t\t\treturn candidate\n\t\t\t}\n\t\t} catch {\n\t\t\t/* not under this container */\n\t\t}\n\t}\n\tif (budget > 0) {\n\t\tconst found = await searchIndex(name, budget, directory)\n\t\tif (found.length > 0) {\n\t\t\tlearn(dirname(found[0]))\n\t\t\treturn found[0]\n\t\t}\n\t}\n\treturn undefined\n}\n\n/** Insert the bridge script first in <head> so it beats every module that reads it. */\nfunction injectScript(html) {\n\tconst tag = `<script data-dsh-host-paths=\"1\">${CLIENT_SCRIPT}</script>`\n\treturn html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html\n}\n\n/**\n * Mount the index tap and the loopback routes.\n *\n * @param ctx - host plugin context (webServer available through inject).\n */\nexport function apply(ctx) {\n\tconst log = []\n\tconst record = (entry) => {\n\t\tlog.push({ at: new Date().toISOString(), ...entry })\n\t\twhile (log.length > MAX_LOG) log.shift()\n\t}\n\n\tctx.effect(() => ctx.webServer.tapIndex(injectScript), 'dsh-host-paths: index injection')\n\n\tctx.effect(() => ctx.webServer.register({\n\t\tkind: 'exact',\n\t\tpath: `${BASE}/locate`,\n\t\thandler: async (request, response) => {\n\t\t\tif (!trusted(request, ctx)) {\n\t\t\t\tsend(response, 403, { error: 'forbidden' })\n\t\t\t\treturn\n\t\t\t}\n\t\t\tif (request.method !== 'POST') {\n\t\t\t\tsend(response, 405, { error: 'method' })\n\t\t\t\treturn\n\t\t\t}\n\t\t\tconst started = Date.now()\n\t\t\ttry {\n\t\t\t\tconst body = await readBody(request)\n\t\t\t\tconst deep = body?.deep === true\n\t\t\t\tconst path = await locate(ctx, body?.name, body?.directory === true, deep ? 3500 : 1500)\n\t\t\t\trecord({\n\t\t\t\t\tkind: 'locate',\n\t\t\t\t\tname: typeof body?.name === 'string' ? body.name : '',\n\t\t\t\t\tdirectory: body?.directory === true,\n\t\t\t\t\tdeep,\n\t\t\t\t\thit: path !== undefined,\n\t\t\t\t\tpath: path ?? '',\n\t\t\t\t\tms: Date.now() - started\n\t\t\t\t})\n\t\t\t\tsend(response, 200, path === undefined ? { path: '' } : { path })\n\t\t\t} catch (error) {\n\t\t\t\trecord({ kind: 'locate-error', message: String(error?.message ?? error) })\n\t\t\t\tsend(response, 200, { path: '' })\n\t\t\t}\n\t\t}\n\t}), 'dsh-host-paths: locate route')\n\n\tctx.effect(() => ctx.webServer.register({\n\t\tkind: 'exact',\n\t\tpath: `${BASE}/learn`,\n\t\thandler: async (request, response) => {\n\t\t\tif (!trusted(request, ctx)) {\n\t\t\t\tsend(response, 403, { error: 'forbidden' })\n\t\t\t\treturn\n\t\t\t}\n\t\t\ttry {\n\t\t\t\tconst body = await readBody(request)\n\t\t\t\tif (typeof body?.path === 'string' && body.path !== '') {\n\t\t\t\t\tlearn(dirname(body.path))\n\t\t\t\t\trecord({ kind: 'learn', path: body.path })\n\t\t\t\t}\n\t\t\t} catch {\n\t\t\t\t/* a malformed hint is not an error */\n\t\t\t}\n\t\t\tsend(response, 200, { ok: true })\n\t\t}\n\t}), 'dsh-host-paths: learn route')\n\n\tctx.effect(() => ctx.webServer.register({\n\t\tkind: 'exact',\n\t\tpath: `${BASE}/report`,\n\t\thandler: async (request, response) => {\n\t\t\tif (!trusted(request, ctx)) {\n\t\t\t\tsend(response, 403, { error: 'forbidden' })\n\t\t\t\treturn\n\t\t\t}\n\t\t\ttry {\n\t\t\t\trecord({ kind: 'page', ...(await readBody(request)) })\n\t\t\t} catch {\n\t\t\t\t/* a malformed diagnostic must never surface as an error */\n\t\t\t}\n\t\t\tsend(response, 200, { ok: true })\n\t\t}\n\t}), 'dsh-host-paths: report route')\n\n\tctx.effect(() => ctx.webServer.register({\n\t\tkind: 'exact',\n\t\tpath: `${BASE}/log`,\n\t\thandler: async (request, response) => {\n\t\t\tif (!trusted(request, ctx)) {\n\t\t\t\tsend(response, 403, { error: 'forbidden' })\n\t\t\t\treturn\n\t\t\t}\n\t\t\tsend(response, 200, {\n\t\t\t\tok: true,\n\t\t\t\tplatform: process.platform,\n\t\t\t\tentries: log,\n\t\t\t\tcontainers: learnedContainers(),\n\t\t\t\tknown: knownFolders(),\n\t\t\t\tdenied: deniedKnownFolders(),\n\t\t\t\tmounts: mountRoots()\n\t\t\t})\n\t\t}\n\t}), 'dsh-host-paths: log route')\n}\n","client-inject.js":"/**\n * dsh-host-paths — 浏览器半体（由宿主半体内联进首页 <head>）\n *\n * 它只做一件事：定义 `globalThis.__DSH_HOST_PATHS__`，也就是 DSH 客户端\n * （`dsh-client-ui-conversation` 的 `hostPathBridge()`）要找的那个桌面桥。\n *\n * # 契约（照抄 DSH 客户端的调用点）\n *\n *     const bridge = hostPathBridge();                 // globalThis.__DSH_HOST_PATHS__\n *     if (bridge === void 0 && directory) return t(\"attachment.directoryDesktopOnly\");\n *     const path = bridge?.pathFor(file) ?? \"\";        // 必须是**同步**返回字符串\n *\n * 返回 \"\" 表示「这次拿不到路径」，DSH 会提示「无法获取文件夹路径，请重新拖入」；\n * 返回路径则由 DSH 自己 `relativizeToCwd` + `formatFileMention` 变成 `@相对路径/`\n * 引用块——包括一次拖入多个文件夹。\n *\n * # 边界\n *\n * 1. **不抢拖拽事件。** 全程不 preventDefault、不 stopPropagation：原生遮罩层\n *    和原生处理器照旧跑。我们只在 document 捕获阶段**读**一次 dataTransfer，\n *    因为捕获阶段一定早于 DSH 挂在 document 冒泡阶段的处理器。\n * 2. **只接管文件夹。** 普通文件 `pathFor` 直接返回 \"\"，于是继续走原来的附件\n *    上传流程——拖文件的行为一个字节都没变。\n * 3. **拿不到就说拿不到。** 绝不用「名字」凑一个假路径：定位失败返回 \"\"。\n *\n * # 路径的来源，按优先级\n *\n * 1. 拖入瞬间的 `text/uri-list`（浏览器愿意给就是最准的，零延迟）；\n * 2. dragover 期间异步预取的宿主定位结果（按名字缓存，drop 时通常已经就绪）；\n * 3. drop 时同步询问宿主 `/dsh-host-paths/locate`（XMLHttpRequest 同步模式）。\n *\n * 第 3 条会短暂阻塞主线程，属于兜底；正常路径是第 1、2 条。\n */\n(function () {\n\t'use strict';\n\tif (typeof globalThis === 'undefined') return;\n\t/* 真正的桌面端已经提供桥时不抢：它的 pathFor 是原生实现，一定比我们准。 */\n\tif (globalThis.__DSH_HOST_PATHS__ !== undefined) return;\n\n\tvar BASE = '/dsh-host-paths';\n\t/** 本次拖拽里被判定为目录的 File 键。 */\n\tvar dirKeys = [];\n\t/** File 键 → 已解析的绝对路径。 */\n\tvar resolved = Object.create(null);\n\t/** 目录名 → 预取到的绝对路径。 */\n\tvar prefetched = Object.create(null);\n\t/** 诊断用：最近 20 次判定。 */\n\tvar trace = [];\n\t/** dragover 预取的节流时间戳。 */\n\tvar prefetchAt = 0;\n\n\t/** File 的稳定标识：同名不同盘的两个文件夹才会撞键，代价可接受。 */\n\tfunction keyOf(file) {\n\t\treturn String(file.name) + '\\u0000' + String(file.size) + '\\u0000' + String(file.lastModified);\n\t}\n\n\t/** 记一条诊断，并尽力送回宿主（失败静默）。 */\n\tfunction note(entry) {\n\t\ttry {\n\t\t\ttrace.push(entry);\n\t\t\tif (trace.length > 20) trace.shift();\n\t\t\tvar xhr = new XMLHttpRequest();\n\t\t\txhr.open('POST', BASE + '/report', true);\n\t\t\txhr.setRequestHeader('content-type', 'application/json');\n\t\t\txhr.send(JSON.stringify(entry));\n\t\t} catch (error) {\n\t\t\t/* 诊断失败不影响功能 */\n\t\t}\n\t}\n\n\t/** 把一条 file:// URI 转成本机绝对路径（Windows 反斜杠；其它平台保持斜杠）。 */\n\tfunction uriToPath(uri) {\n\t\ttry {\n\t\t\tvar url = new URL(String(uri).trim());\n\t\t\tif (url.protocol !== 'file:') return '';\n\t\t\tvar path = decodeURIComponent(url.pathname);\n\t\t\tif (/^\\/[A-Za-z]:/.test(path)) path = path.slice(1);\n\t\t\tvar windows = /^[A-Za-z]:/.test(path);\n\t\t\treturn windows ? path.replace(/\\//g, '\\\\') : path;\n\t\t} catch (error) {\n\t\t\treturn '';\n\t\t}\n\t}\n\n\t/** dataTransfer 里的 text/uri-list（没有就返回空数组）。 */\n\tfunction uriList(transfer) {\n\t\ttry {\n\t\t\tvar raw = transfer.getData('text/uri-list') || '';\n\t\t\tif (raw === '') return [];\n\t\t\treturn raw.split(/\\r?\\n/)\n\t\t\t\t.map(function (line) { return line.trim(); })\n\t\t\t\t.filter(function (line) { return line !== '' && line.charAt(0) !== '#'; })\n\t\t\t\t.map(uriToPath)\n\t\t\t\t.filter(function (path) { return path !== ''; });\n\t\t} catch (error) {\n\t\t\treturn [];\n\t\t}\n\t}\n\n\t/** 同步询问宿主定位（兜底路径）。 */\n\tfunction locateSync(name) {\n\t\ttry {\n\t\t\tvar xhr = new XMLHttpRequest();\n\t\t\txhr.open('POST', BASE + '/locate', false);\n\t\t\txhr.setRequestHeader('content-type', 'application/json');\n\t\t\txhr.send(JSON.stringify({ name: name, directory: true }));\n\t\t\tif (xhr.status !== 200) return '';\n\t\t\tvar body = JSON.parse(xhr.responseText || '{}');\n\t\t\treturn typeof body.path === 'string' ? body.path : '';\n\t\t} catch (error) {\n\t\t\treturn '';\n\t\t}\n\t}\n\n\t/** 异步预取：dragover 期间把目录名交给宿主先查一遍，drop 时就能同步命中。 */\n\tfunction prefetch(transfer) {\n\t\tvar now = Date.now();\n\t\tif (now - prefetchAt < 400) return;\n\t\tprefetchAt = now;\n\t\ttry {\n\t\t\tvar items = transfer.items || [];\n\t\t\tfor (var index = 0; index < items.length; index += 1) {\n\t\t\t\tvar item = items[index];\n\t\t\t\tif (item.kind !== 'file') continue;\n\t\t\t\tvar entry = null;\n\t\t\t\ttry { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (error) { entry = null; }\n\t\t\t\tif (entry === null || entry === undefined || entry.isDirectory !== true) continue;\n\t\t\t\tif (prefetched[entry.name] !== undefined) continue;\n\t\t\t\tprefetched[entry.name] = '';\n\t\t\t\t(function (name) {\n\t\t\t\t\ttry {\n\t\t\t\t\t\tvar xhr = new XMLHttpRequest();\n\t\t\t\t\t\txhr.open('POST', BASE + '/locate', true);\n\t\t\t\t\t\txhr.setRequestHeader('content-type', 'application/json');\n\t\t\t\t\t\txhr.onload = function () {\n\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\tvar body = JSON.parse(xhr.responseText || '{}');\n\t\t\t\t\t\t\t\tif (typeof body.path === 'string' && body.path !== '') prefetched[name] = body.path;\n\t\t\t\t\t\t\t} catch (error) { /* keep the empty entry */ }\n\t\t\t\t\t\t};\n\t\t\t\t\t\txhr.send(JSON.stringify({ name: name, directory: true }));\n\t\t\t\t\t} catch (error) { /* prefetch is best-effort */ }\n\t\t\t\t}(entry.name));\n\t\t\t}\n\t\t} catch (error) {\n\t\t\t/* prefetch is best-effort */\n\t\t}\n\t}\n\n\t/** 拖拽开始/结束时清空本次状态。 */\n\tfunction reset() {\n\t\tdirKeys = [];\n\t\tresolved = Object.create(null);\n\t\tprefetched = Object.create(null);\n\t\tprefetchAt = 0;\n\t}\n\n\t/**\n\t * drop 的捕获阶段：只读，把「哪些 File 是目录」和 uri-list 记下来，\n\t * 然后原样放行给 DSH 自己的处理器。\n\t */\n\tfunction onDrop(event) {\n\t\ttry {\n\t\t\tvar transfer = event.dataTransfer;\n\t\t\tif (transfer === null || transfer === undefined) return;\n\t\t\tvar files = transfer.files ? Array.prototype.slice.call(transfer.files) : [];\n\t\t\tvar keys = [];\n\t\t\tvar index = 0;\n\t\t\tvar items = transfer.items || [];\n\t\t\tfor (var cursor = 0; cursor < items.length; cursor += 1) {\n\t\t\t\tvar item = items[cursor];\n\t\t\t\tif (item.kind !== 'file') continue;\n\t\t\t\tvar file = files[index];\n\t\t\t\tindex += 1;\n\t\t\t\tif (file === undefined) continue;\n\t\t\t\tvar entry = null;\n\t\t\t\ttry { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (error) { entry = null; }\n\t\t\t\tif (entry !== null && entry !== undefined && entry.isDirectory === true) keys.push(keyOf(file));\n\t\t\t}\n\t\t\tdirKeys = keys;\n\t\t\tvar uris = uriList(transfer);\n\t\t\tif (uris.length === files.length) {\n\t\t\t\tfor (var at = 0; at < files.length; at += 1) {\n\t\t\t\t\tif (uris[at] !== '') resolved[keyOf(files[at])] = uris[at];\n\t\t\t\t}\n\t\t\t}\n\t\t\tnote({\n\t\t\t\tkind: 'drop',\n\t\t\t\tfiles: files.length,\n\t\t\t\tdirectories: keys.length,\n\t\t\t\turiList: uris.length,\n\t\t\t\tnames: files.map(function (file) { return file.name; }).slice(0, 6)\n\t\t\t});\n\t\t} catch (error) {\n\t\t\tnote({ kind: 'drop-error', message: String(error && error.message ? error.message : error) });\n\t\t\treturn;\n\t\t}\n\t\t/* 状态留到 DSH 读完桥再清：pathFor 是在同一个事件派发里同步调用的。 */\n\t\twindow.setTimeout(reset, 0);\n\t}\n\n\t/**\n\t * 同步解析一个被拖入对象的绝对路径。\n\t *\n\t * @param file - dataTransfer 给出的 File；普通文件返回 \"\" 以保留原有上传行为。\n\t * @returns 绝对路径，或 \"\"（DSH 会据此提示「无法获取文件夹路径」）。\n\t */\n\tfunction pathFor(file) {\n\t\ttry {\n\t\t\tif (file === null || file === undefined || typeof file.name !== 'string' || file.name === '') return '';\n\t\t\tvar key = keyOf(file);\n\t\t\t/* 普通文件不是我们的活：返回 \"\" → 继续走附件上传。 */\n\t\t\tif (dirKeys.indexOf(key) === -1) return '';\n\t\t\tif (resolved[key] !== undefined && resolved[key] !== '') {\n\t\t\t\tnote({ kind: 'hit', source: 'drop', name: file.name, path: resolved[key] });\n\t\t\t\treturn resolved[key];\n\t\t\t}\n\t\t\tif (prefetched[file.name] !== undefined && prefetched[file.name] !== '') {\n\t\t\t\tresolved[key] = prefetched[file.name];\n\t\t\t\tnote({ kind: 'hit', source: 'prefetch', name: file.name, path: prefetched[file.name] });\n\t\t\t\treturn prefetched[file.name];\n\t\t\t}\n\t\t\tvar located = locateSync(file.name);\n\t\t\tif (located !== '') {\n\t\t\t\tresolved[key] = located;\n\t\t\t\tnote({ kind: 'hit', source: 'locate', name: file.name, path: located });\n\t\t\t\treturn located;\n\t\t\t}\n\t\t\tnote({ kind: 'miss', name: file.name });\n\t\t\treturn '';\n\t\t} catch (error) {\n\t\t\tnote({ kind: 'pathFor-error', message: String(error && error.message ? error.message : error) });\n\t\t\treturn '';\n\t\t}\n\t}\n\n\tdocument.addEventListener('drop', onDrop, true);\n\tdocument.addEventListener('dragenter', function (event) {\n\t\ttry {\n\t\t\tif (prefetchAt === 0) reset();\n\t\t\tif (event.dataTransfer !== null && event.dataTransfer !== undefined) prefetch(event.dataTransfer);\n\t\t} catch (error) { /* best-effort */ }\n\t}, true);\n\tdocument.addEventListener('dragover', function (event) {\n\t\ttry {\n\t\t\tif (event.dataTransfer !== null && event.dataTransfer !== undefined) prefetch(event.dataTransfer);\n\t\t} catch (error) { /* best-effort */ }\n\t}, true);\n\tdocument.addEventListener('dragend', reset, true);\n\twindow.addEventListener('blur', reset, true);\n\n\tglobalThis.__DSH_HOST_PATHS__ = {\n\t\tpathFor: pathFor,\n\t\t/** 诊断出口：控制台里 `__DSH_HOST_PATHS__.trace()` 看最近 20 次判定。 */\n\t\ttrace: function () { return trace.slice(); }\n\t};\n}());\n","client.js":"/**\n * dsh-host-paths — 浏览器半体（客户端模块）\n *\n * 拖入的归属权在 DSH 自己手里（见宿主半体的说明），这里只补一件它做不到的事：\n * **选一个项目外面的任意文件夹**。\n *\n * 路径不可能从浏览器里\"猜\"出来（WebView2 连 text/uri-list 都不给），但可以让\n * 系统直接给：这里调用 DSH 自己的 `uiWorkspace.pickDirectory()`，也就是工作区\n * 选择器用的那个原生 IFileOpenDialog 子进程——已经在这台机器上跑通，能到任意\n * 盘符、任意位置。\n *\n * 选中的路径按 DSH 引用块的写法插进草稿：\n *\n *     sessionCtx.bail(sessionCtx, 'slash/input-insert-reference', { reference, span })\n *\n * 这就是 `@` 补全（ui-reference 的 onPick）走的那条通道：`insertReference` 把\n * 指定选区替换成**一个引用块**，文档结构不丢、光标留在后面、序列化发给模型的\n * 是 `@路径` 本身。事件按会话作用域投递，所以要从 `sessions.scope(sessionId)`\n * 拿那个 ctx。\n *\n * `span` 是带 `draftRev` 的 CAS：草稿每次变化都会让上一次的 rev 失效，所以\n * 插入前必须用**渲染期**读到的最新快照（`useInput` 是真 React 钩子，在回调里\n * 调用会抛 React #321）。快照过期时重试几次，最后退回 `setDraft` 纯文本。\n */\nwindow.__ModuleLoader__.load({\n\tid: 'dsh-host-paths',\n\tfactory: (require) => {\n\t\tconst module = { exports: {} }\n\t\tconst exports = module.exports\n\t\tconst React = require('react')\n\t\tconst { useCallback, useEffect, useRef, useState } = React\n\n\t\t/** 插槽：输入框工具栏左侧的一格（会话作用域，随会话挂载/卸载）。 */\n\t\tconst SLOT = 'conversation.input.left'\n\t\t/** 本插件在这一格里的条目 id。 */\n\t\tconst ENTRY_ID = 'host-paths-pick'\n\t\t/** 引用块的来源名：ui-reference 用的就是它，序列化器按它路由。 */\n\t\tconst REFERENCE_SOURCE = 'reference'\n\t\t/** 学习接口：把选中目录的父目录告诉宿主，下次拖拽优先找那里。 */\n\t\tconst LEARN_PATH = '/dsh-host-paths/learn'\n\n\t\tconst COPY = {\n\t\t\tzh: {\n\t\t\t\tlabel: '添加文件夹',\n\t\t\t\ttitle: '添加项目外面的文件夹（插入它的路径引用）',\n\t\t\t\tbusy: '正在等待选择…',\n\t\t\t\tdenied: '路径含有无法引用的字符，请改名后再试',\n\t\t\t\tfailed: '路径插入失败，输入框状态可能已变化，请重试',\n\t\t\t\tpickFailed: '打开文件夹选择器失败'\n\t\t\t},\n\t\t\ten: {\n\t\t\t\tlabel: 'Add folder',\n\t\t\t\ttitle: 'Add a folder from anywhere on this machine (inserts its path reference)',\n\t\t\t\tbusy: 'Waiting for the picker…',\n\t\t\t\tdenied: 'That path has characters the reference grammar cannot carry',\n\t\t\t\tfailed: 'Could not insert the path — the composer changed, please retry',\n\t\t\t\tpickFailed: 'Could not open the folder picker'\n\t\t\t}\n\t\t}\n\n\t\t/** 判定语言：与上游一致（html lang 优先，其次 navigator.language）。 */\n\t\tfunction copy() {\n\t\t\tconst language = (typeof document !== 'undefined' && document.documentElement.lang)\n\t\t\t\t|| (typeof navigator === 'undefined' ? '' : navigator.language)\n\t\t\t\t|| ''\n\t\t\treturn String(language).toLowerCase().startsWith('zh') ? COPY.zh : COPY.en\n\t\t}\n\n\t\t/**\n\t\t * 把本机绝对路径写成引用文本。\n\t\t *\n\t\t * 规则照抄 `@deepseek-ai/dsh-file-reference/grammar` 与 DSH 附件入口对目录的\n\t\t * 处理：目录补尾斜杠；含空白就整体引号化；带控制字符或引号的路径返回\n\t\t * undefined——那种路径写进这个语法就是不安全的，而不是\"将就一下\"。\n\t\t *\n\t\t * @param {string} path 本机绝对路径（Windows 反斜杠照原样保留）。\n\t\t * @returns {string|undefined} 形如 `@D:\\a\\b\\` 或 `@\"D:\\a b\\\"` 的引用文本。\n\t\t */\n\t\tfunction folderMention(path) {\n\t\t\tconst raw = String(path).trim()\n\t\t\tif (raw.length === 0) return undefined\n\t\t\tconst isWindows = /^[A-Za-z]:[\\\\/]/u.test(raw) || raw.startsWith('\\\\\\\\')\n\t\t\tconst separator = isWindows ? '\\\\' : '/'\n\t\t\tconst withSlash = raw.endsWith('/') || raw.endsWith('\\\\') ? raw : raw + separator\n\t\t\tif (/[\\u0000-\\u001f\\u007f-\\u009f\"]/u.test(withSlash)) return undefined\n\t\t\treturn /\\s/u.test(withSlash) ? `@\"${withSlash}\"` : `@${withSlash}`\n\t\t}\n\n\t\t/** 引用块上显示的路径：加尾斜杠。 */\n\t\tfunction displayPath(path) {\n\t\t\tconst raw = String(path).trim()\n\t\t\tif (raw.length === 0) return raw\n\t\t\treturn raw.endsWith('/') || raw.endsWith('\\\\') ? raw : raw + '/'\n\t\t}\n\n\t\t/** 记一次学习，失败静默（只是提示，不是功能）。 */\n\t\tfunction learn(path) {\n\t\t\ttry {\n\t\t\t\tconst xhr = new XMLHttpRequest()\n\t\t\t\txhr.open('POST', LEARN_PATH, true)\n\t\t\t\txhr.setRequestHeader('content-type', 'application/json')\n\t\t\t\txhr.send(JSON.stringify({ path }))\n\t\t\t} catch {\n\t\t\t\t/* best-effort */\n\t\t\t}\n\t\t}\n\n\t\t/**\n\t\t * 把 `@路径` 插进当前会话的草稿。\n\t\t *\n\t\t * 快照来自 `live.current.draft`（渲染期读的），插入成功后 React 会因为草稿\n\t\t * 变化重新渲染并刷新它；所以每次重试都取最新那份，而不是闭包里那一帧。\n\t\t *\n\t\t * @param {{current: object}} live 最新一帧的 { sessionCtx, inputActions, draft }。\n\t\t * @param {string} path 选中的绝对路径。\n\t\t * @returns {Promise<boolean>} 是否插进去了。\n\t\t */\n\t\tasync function insertReference(live, path) {\n\t\t\tconst mention = folderMention(path)\n\t\t\tif (mention === undefined) return false\n\t\t\tconst label = displayPath(path)\n\t\t\tconst reference = {\n\t\t\t\tsource: REFERENCE_SOURCE,\n\t\t\t\tref: mention,\n\t\t\t\tlabel,\n\t\t\t\tappearance: 'folder',\n\t\t\t\tclipboardText: mention\n\t\t\t}\n\t\t\tfor (let attempt = 0; attempt < 8; attempt += 1) {\n\t\t\t\tconst target = live.current\n\t\t\t\tconst draft = target.draft\n\t\t\t\tif (target.sessionCtx !== undefined && target.sessionCtx !== null && draft !== undefined) {\n\t\t\t\t\ttry {\n\t\t\t\t\t\tconst span = { start: draft.text.length, end: draft.text.length, draftRev: draft.rev }\n\t\t\t\t\t\tif (target.sessionCtx.bail(target.sessionCtx, 'slash/input-insert-reference', { reference, span }) === true) return true\n\t\t\t\t\t} catch {\n\t\t\t\t\t\t/* 这台会话的输入机还没起来：等下一次渲染再试 */\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\tawait new Promise((resume) => setTimeout(resume, 80))\n\t\t\t}\n\t\t\ttry {\n\t\t\t\tconst target = live.current\n\t\t\t\tconst draft = target.draft\n\t\t\t\tif (target.inputActions !== undefined && draft !== undefined) {\n\t\t\t\t\tconst joined = draft.text.length === 0\n\t\t\t\t\t\t? mention\n\t\t\t\t\t\t: `${draft.text}${/\\s$/u.test(draft.text) ? '' : ' '}${mention}`\n\t\t\t\t\ttarget.inputActions.setDraft(joined)\n\t\t\t\t\treturn true\n\t\t\t\t}\n\t\t\t} catch {\n\t\t\t\t/* fall through to the caller's failure message */\n\t\t\t}\n\t\t\treturn false\n\t\t}\n\n\t\t/**\n\t\t * 工具栏上的「添加文件夹」按钮。\n\t\t *\n\t\t * @param {object} props 插槽注入面 + 会话标准座（sessionId / useInput / inputActions）。\n\t\t */\n\t\tfunction FolderPickButton(props) {\n\t\t\tconst { sessionId, sessionCtx, useInput, inputActions, uiWorkspace } = props\n\t\t\tconst [busy, setBusy] = useState(false)\n\t\t\tconst [message, setMessage] = useState('')\n\n\t\t\t/* 草稿快照必须在渲染期读：useInput 是真 React 钩子。 */\n\t\t\tconst draft = typeof useInput === 'function'\n\t\t\t\t? useInput(\n\t\t\t\t\t(snapshot) => ({ text: snapshot.draft, rev: snapshot.draftRev }),\n\t\t\t\t\t(left, right) => left.text === right.text && left.rev === right.rev\n\t\t\t\t)\n\t\t\t\t: undefined\n\n\t\t\t/** 每次点击现取：闭包里的 draft 会停在第一次渲染那一帧。 */\n\t\t\tconst live = useRef({ sessionId, sessionCtx, inputActions, draft })\n\t\t\tlive.current = { sessionId, sessionCtx, inputActions, draft }\n\n\t\t\t/** 写进去的提示 6 秒后自己收起来。 */\n\t\t\tuseEffect(() => {\n\t\t\t\tif (message === '') return undefined\n\t\t\t\tconst handle = setTimeout(() => setMessage(''), 6000)\n\t\t\t\treturn () => clearTimeout(handle)\n\t\t\t}, [message])\n\n\t\t\tconst onClick = useCallback(async () => {\n\t\t\t\tif (busy) return\n\t\t\t\tconst text = copy()\n\t\t\t\tsetBusy(true)\n\t\t\t\tsetMessage('')\n\t\t\t\ttry {\n\t\t\t\t\tif (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {\n\t\t\t\t\t\tsetMessage(text.pickFailed)\n\t\t\t\t\t\treturn\n\t\t\t\t\t}\n\t\t\t\t\tconst picked = await uiWorkspace.pickDirectory()\n\t\t\t\t\tif (typeof picked !== 'string' || picked === '') return\n\t\t\t\t\tlearn(picked)\n\t\t\t\t\tconst inserted = await insertReference(live, picked)\n\t\t\t\t\tif (!inserted) setMessage(folderMention(picked) === undefined ? text.denied : text.failed)\n\t\t\t\t} catch (error) {\n\t\t\t\t\tsetMessage(`${text.pickFailed}: ${error instanceof Error ? error.message : String(error)}`)\n\t\t\t\t} finally {\n\t\t\t\t\tsetBusy(false)\n\t\t\t\t}\n\t\t\t}, [busy, uiWorkspace])\n\n\t\t\tconst text = copy()\n\t\t\tconst title = busy ? text.busy : text.title\n\t\t\tconst tone = message === '' ? 'var(--dsw-alias-label-secondary, #8a8a8a)' : 'var(--dsw-alias-state-error-primary, #b23)'\n\t\t\treturn React.createElement(\n\t\t\t\t'span',\n\t\t\t\t{ style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },\n\t\t\t\tReact.createElement(\n\t\t\t\t\t'button',\n\t\t\t\t\t{\n\t\t\t\t\t\ttype: 'button',\n\t\t\t\t\t\tonClick,\n\t\t\t\t\t\tdisabled: busy,\n\t\t\t\t\t\ttitle,\n\t\t\t\t\t\t'aria-label': text.label,\n\t\t\t\t\t\t'data-dsh-host-paths': 'pick',\n\t\t\t\t\t\tstyle: {\n\t\t\t\t\t\t\tdisplay: 'inline-flex',\n\t\t\t\t\t\t\talignItems: 'center',\n\t\t\t\t\t\t\tgap: 4,\n\t\t\t\t\t\t\theight: 26,\n\t\t\t\t\t\t\tpadding: '0 8px',\n\t\t\t\t\t\t\tborder: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',\n\t\t\t\t\t\t\tborderRadius: 6,\n\t\t\t\t\t\t\tbackground: 'transparent',\n\t\t\t\t\t\t\tcolor: 'var(--dsw-alias-label-secondary, #8a8a8a)',\n\t\t\t\t\t\t\tfontSize: 12,\n\t\t\t\t\t\t\tlineHeight: '16px',\n\t\t\t\t\t\t\tcursor: busy ? 'progress' : 'pointer',\n\t\t\t\t\t\t\twhiteSpace: 'nowrap'\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\t\t\t\t\tReact.createElement('span', { 'aria-hidden': true }, busy ? '⏳' : '📁+'),\n\t\t\t\t\tReact.createElement('span', null, busy ? text.busy : text.label)\n\t\t\t\t),\n\t\t\t\tmessage === ''\n\t\t\t\t\t? null\n\t\t\t\t\t: React.createElement(\n\t\t\t\t\t\t'span',\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\trole: 'alert',\n\t\t\t\t\t\t\tstyle: {\n\t\t\t\t\t\t\t\tcolor: tone,\n\t\t\t\t\t\t\t\tfontSize: 12,\n\t\t\t\t\t\t\t\tlineHeight: '16px',\n\t\t\t\t\t\t\t\tmaxWidth: 320,\n\t\t\t\t\t\t\t\toverflow: 'hidden',\n\t\t\t\t\t\t\t\ttextOverflow: 'ellipsis',\n\t\t\t\t\t\t\t\twhiteSpace: 'nowrap'\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t},\n\t\t\t\t\t\tmessage\n\t\t\t\t\t)\n\t\t\t)\n\t\t}\n\n\t\t/**\n\t\t * 客户端插件入口。\n\t\t *\n\t\t * @param {object} ctx 客户端根上下文。\n\t\t */\n\t\tfunction apply(ctx) {\n\t\t\tconst slots = ctx.get('slots')\n\t\t\tconst sessions = ctx.get('sessions')\n\t\t\tif (slots === undefined || sessions === undefined) {\n\t\t\t\tctx.logger?.warn?.('dsh-host-paths: 缺少 slots/sessions 服务，按钮不挂载')\n\t\t\t\treturn\n\t\t\t}\n\t\t\t/* 原生选择器由 uiWorkspace 提供；缺席时按钮自己会说明，而不是静默失败。 */\n\t\t\tconst uiWorkspace = ctx.get('uiWorkspace')\n\t\t\tctx.effect(\n\t\t\t\t() => slots.inject(SLOT, () => slots.register({\n\t\t\t\t\tname: SLOT,\n\t\t\t\t\tid: ENTRY_ID,\n\t\t\t\t\torder: 30,\n\t\t\t\t\tlabel: () => copy().label,\n\t\t\t\t\tinject: (sessionId) => {\n\t\t\t\t\t\tconst sessionCtx = sessions.scope(sessionId)\n\t\t\t\t\t\treturn sessionCtx === undefined\n\t\t\t\t\t\t\t? { sessionId, uiWorkspace }\n\t\t\t\t\t\t\t: { sessionId, sessionCtx, uiWorkspace }\n\t\t\t\t\t}\n\t\t\t\t}, FolderPickButton)),\n\t\t\t\t'dsh-host-paths: 添加文件夹按钮'\n\t\t\t)\n\t\t}\n\n\t\texports.apply = apply\n\t\t/* 客户端插件的服务门：cordis 读到这个数组会等服务就绪再调 apply。 */\n\t\texports.inject = ['slots', 'sessions', 'uiWorkspace']\n\t\texports.__test__ = { folderMention, displayPath }\n\t\treturn module.exports\n\t}\n})\n"}

/**
 * 用哪一份源码。
 *
 * 从一个 clone 里跑本文件时，同目录就有全部源文件——那就装这个 clone 的**当前**
 * 内容，内联快照不会过期。单独把本文件拷到别的机器时（它自包含），退回内联快照。
 *
 * @returns {{ mode: 'sibling'|'embedded', files: Record<string, string> }}
 */
function sourceFiles() {
	const here = dirname(fileURLToPath(import.meta.url))
	const local = {}
	for (const name of Object.keys(EMBEDDED)) {
		try {
			local[name] = readFileSync(join(here, name), 'utf8')
		} catch {
			return { mode: 'embedded', files: EMBEDDED }
		}
	}
	try {
		if (JSON.parse(local['package.json']).name === BUNDLE) return { mode: 'sibling', files: local }
	} catch {
		/* a sibling package.json that is not ours: fall through to the snapshot */
	}
	return { mode: 'embedded', files: EMBEDDED }
}

const SOURCE = sourceFiles()
const FILES = SOURCE.files

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(`--${flag}`)
const valueOf = (flag) => {
	const index = argv.indexOf(`--${flag}`)
	if (index === -1) return undefined
	const next = argv[index + 1]
	return next === undefined || next.startsWith('--') ? true : next
}
const dryRun = has('dry-run')
const uninstall = has('uninstall')
const profileArg = valueOf('profile')

/**
 * Cross-platform child run.
 *
 * Windows resolves `dsh` / `pnpm` through `.cmd` shims, which `spawn` refuses to
 * execute without a shell. Rather than pass `shell: true` alongside an args array
 * (Node warns DEP0190: args are concatenated, not escaped), the whole command line
 * is quoted here and handed to `cmd.exe /d /s /c` as one argument.
 */
function run(command, args, options = {}) {
	const win = process.platform === 'win32'
	const quote = (arg) => (/\s|["^&|<>%]/u.test(arg) ? `"${arg.replace(/"/gu, '""')}"` : arg)
	const line = [command, ...args].map(quote).join(' ')
	const [file, argv] = win
		? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line]]
		: [command, args]
	return spawnSync(file, argv, {
		encoding: 'utf8',
		windowsHide: true,
		timeout: options.timeout ?? 300_000,
		cwd: options.cwd,
		env: process.env
	})
}

/** Print one step line. */
const say = (text) => process.stdout.write(`${text}\n`)
const fail = (text) => process.stderr.write(`${text}\n`)

/* ---------------------------------------------------------------- 环境发现 */

const dshHome = (process.env.DSH_HOME ?? '').trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')
const pluginDir = join(dshHome, 'plugins', BUNDLE)

if (!existsSync(dshHome)) {
	fail(`找不到 DSH_HOME：${dshHome}\n先确认 DSH 装好并至少启动过一次，或用 DSH_HOME=<路径> 指定。`)
	process.exit(1)
}

const profiles = existsSync(profilesDir)
	? readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	: []
if (profiles.length === 0) {
	fail(`在 ${profilesDir} 下没有找到任何 profile。\n先启动一次 DSH（桌面端或 dsh web），让它建立 profile。`)
	process.exit(1)
}

const profile = typeof profileArg === 'string'
	? profileArg
	: ((process.env.DSH_PROFILE ?? '').trim() !== ''
		? process.env.DSH_PROFILE.trim()
		: (profiles.length === 1 ? profiles[0] : undefined))
if (profile === undefined) {
	fail(`发现多个 profile，请用 --profile <名字> 指定其中一个：\n  ${profiles.join('\n  ')}\n` +
		`提示：把插件装进**实际运行的那个** profile 才生效；当前进程环境里 DSH_PROFILE=${process.env.DSH_PROFILE ?? '(未设置)'}。`)
	process.exit(1)
}
if (!profiles.includes(profile)) {
	fail(`profile "${profile}" 不存在。现有：${profiles.join(', ')}`)
	process.exit(1)
}

const profileDir = join(profilesDir, profile)
const manifestPath = join(profileDir, 'package.json')
say(`DSH_HOME   ${dshHome}`)
say(`profile    ${profile}   (${profileDir})`)
say(`插件副本   ${pluginDir}`)
say(dryRun ? '模式       --dry-run（不会写任何文件）' : '模式       实际安装')

/* ---------------------------------------------------------------- 工具函数 */

/** 读取 profile 清单；缺失或损坏时带着说明退出。 */
function readManifest() {
	if (!existsSync(manifestPath)) {
		fail(`profile 清单不存在：${manifestPath}\n这个 profile 可能还没被 DSH 初始化过。`)
		process.exit(1)
	}
	try {
		return JSON.parse(readFileSync(manifestPath, 'utf8'))
	} catch (error) {
		fail(`profile 清单不是合法 JSON：${manifestPath}\n${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}

/** 写文件，内容一致时跳过（安装可重复执行）。 */
function writeIfChanged(path, content) {
	if (existsSync(path) && readFileSync(path, 'utf8') === content) return false
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content, 'utf8')
	return true
}

/** 找 dsh 可执行文件：PATH 上的 dsh，其次 npx。 */
function dshCommand() {
	const probe = run('dsh', ['--version'], { timeout: 30_000 })
	if (probe.status === 0) return { command: 'dsh', prefix: [] }
	return { command: 'npx', prefix: ['--yes', '@deepseek-ai/dsh'] }
}

/** pnpm：PATH 上的 pnpm，其次 corepack pnpm，最后 npx pnpm。 */
function pnpmInvocation() {
	if (run('pnpm', ['--version'], { timeout: 30_000 }).status === 0) return { command: 'pnpm', prefix: [] }
	if (run('corepack', ['pnpm', '--version'], { timeout: 60_000 }).status === 0) return { command: 'corepack', prefix: ['pnpm'] }
	return { command: 'npx', prefix: ['--yes', 'pnpm'] }
}

/* ---------------------------------------------------------------- 卸载 */

if (uninstall) {
	const manifest = readManifest()
	let changed = false
	if (manifest.dependencies !== undefined && manifest.dependencies[BUNDLE] !== undefined) {
		delete manifest.dependencies[BUNDLE]
		changed = true
	}
	const bundles = manifest.dsh?.profile?.bundles
	if (Array.isArray(bundles)) {
		const next = bundles.filter((name) => name !== BUNDLE)
		if (next.length !== bundles.length) {
			manifest.dsh.profile.bundles = next
			changed = true
		}
	}
	if (!changed) {
		say('profile 里没有这个插件，无需改动。')
	} else if (dryRun) {
		say('[dry-run] 会从 profile 清单里移除依赖与 bundle 条目。')
	} else {
		const backupDir = join(profileDir, `.backup-uninstall-${Date.now()}`)
		mkdirSync(backupDir, { recursive: true })
		copyFileSync(manifestPath, join(backupDir, 'package.json.bak'))
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
		const pnpm = pnpmInvocation()
		say(`已移除清单条目（备份在 ${backupDir}），正在 pnpm install …`)
		const installed = run(pnpm.command, [...pnpm.prefix, 'install', '--no-frozen-lockfile'], { cwd: profileDir })
		if (installed.status !== 0) {
			fail(`pnpm install 失败，请手工在 ${profileDir} 里跑一次 pnpm install：\n${installed.stderr ?? ''}`)
			process.exit(2)
		}
	}
	say(`\n重启 DSH 后生效。插件副本仍在 ${pluginDir}（可手工删除）。`)
	process.exit(0)
}

/* ---------------------------------------------------------------- 1. 落地副本 */

const written = []
const unchanged = []
for (const [name, content] of Object.entries(FILES)) {
	const path = join(pluginDir, name)
	if (dryRun) {
		written.push(name)
		continue
	}
	if (writeIfChanged(path, content)) written.push(name)
	else unchanged.push(name)
}
say(`\n[1/3] 源文件 → ${pluginDir}`)
say(`      来源：${SOURCE.mode === 'sibling' ? '同目录源文件（clone 内的当前内容）' : '内联快照（自包含模式）'}`)
say(`      写入 ${written.length} 个${written.length > 0 ? `：${written.join(', ')}` : ''}` +
	(unchanged.length > 0 ? `\n      未变 ${unchanged.length} 个：${unchanged.join(', ')}` : ''))

/* ---------------------------------------------------------------- 2. 装进 profile */

say(`\n[2/3] 装进 profile "${profile}"`)

/** 官方 CLI 路径。桌面端 profile 会被它的守卫拒绝，这是预期分支之一。 */
function tryOfficialCli() {
	const dsh = dshCommand()
	const args = [...dsh.prefix, 'plugin', '--profile', profile, 'add', pluginDir]
	say(`      $ ${dsh.command} ${args.join(' ')}`)
	if (dryRun) return { ok: true, dryRun: true }
	const result = run(dsh.command, args)
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
	if (result.status === 0) return { ok: true, output }
	if (/managed exclusively/iu.test(output)) return { ok: false, managed: true, output }
	return { ok: false, output }
}

/** 复刻官方 installBundle：写 link: 依赖 + bundle 条目，再 pnpm install。 */
function installByManifest() {
	const manifest = readManifest()
	const before = JSON.stringify(manifest)
	if (typeof manifest.dependencies !== 'object' || manifest.dependencies === null) manifest.dependencies = {}
	manifest.dependencies[BUNDLE] = SPEC
	manifest.dsh ??= {}
	manifest.dsh.profile ??= {}
	const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
	if (!bundles.includes(BUNDLE)) manifest.dsh.profile.bundles = [...bundles, BUNDLE]
	if (JSON.stringify(manifest) === before) {
		say('      清单已经是目标状态，跳过写入。')
	} else if (dryRun) {
		say(`      [dry-run] 会在 dependencies 写入 "${BUNDLE}": "${SPEC}"，并把 "${BUNDLE}" 追加进 dsh.profile.bundles。`)
	} else {
		const backupDir = join(profileDir, `.backup-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
		mkdirSync(backupDir, { recursive: true })
		copyFileSync(manifestPath, join(backupDir, 'package.json.bak'))
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
		say(`      已写入清单（备份：${join(backupDir, 'package.json.bak')}）`)
	}
	if (dryRun) return true
	const pnpm = pnpmInvocation()
	say(`      $ ${pnpm.command} ${[...pnpm.prefix, 'install', '--no-frozen-lockfile'].join(' ')}   (cwd=${profileDir})`)
	const installed = run(pnpm.command, [...pnpm.prefix, 'install', '--no-frozen-lockfile'], { cwd: profileDir })
	if (installed.status !== 0) {
		fail(`      pnpm install 失败。清单已改但依赖未装；请手工执行：\n` +
			`        cd "${profileDir}" && pnpm install --no-frozen-lockfile\n${installed.stderr ?? ''}`)
		return false
	}
	return true
}

const official = tryOfficialCli()
let installed = false
if (official.ok) {
	installed = true
	say(dryRun ? '      [dry-run] 上面这条命令会实际执行' : '      ✓ 官方 CLI 安装成功')
} else if (official.managed === true) {
	say('      官方 CLI 拒绝：这个 profile 由桌面应用独占管理（Electron 守卫）。')
	say('      改用等价流程：写 link: 依赖 + bundle 条目 + pnpm install。')
	installed = installByManifest()
} else {
	say('      官方 CLI 失败，改用等价流程。')
	if (official.output !== undefined && official.output.trim() !== '') say(`      输出：${official.output.trim().split('\n').slice(-3).join(' / ')}`)
	installed = installByManifest()
}
if (!installed) process.exit(2)

/* ---------------------------------------------------------------- 3. 下一步 */

const webUrl = (process.env.DSH_WEB_URL ?? '').trim()
say(`\n[3/3] 下一步`)
say('      1) 重启 DSH（桌面端：完全退出再打开；dsh web：停掉进程重开）——宿主半体没有热重载。')
say('      2) 刷新页面，然后验证：')
const base = webUrl !== '' ? webUrl.replace(/\/$/u, '') : 'http://127.0.0.1:<端口>'
say(`         curl -s ${base}/dsh-host-paths/log`)
say(`         # 期望看到 "platform"、"known"、"mounts"、"denied"；端口在 macOS 桌面端是 43120，常见默认 3080。`)
say('      3) 拖一个文件夹进输入框 → 应出现 @路径/ 引用块；工具栏「📁+ 添加文件夹」可挑任意位置。')
say('      4) 不要了就：node install-dsh-host-paths.mjs --uninstall')
