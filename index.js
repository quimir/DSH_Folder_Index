/**
 * dsh-host-paths — 宿主半体（跨平台：win32 / darwin / linux）
 *
 * 一句话：**给没实现桌面桥的壳，补上 DSH 自己要的那个 `globalThis.__DSH_HOST_PATHS__`。**
 *
 * # 为什么是这个东西，而不是「抢拖拽事件」
 *
 * DSH 客户端（`@deepseek-ai/dsh-client-ui-conversation`）在附件入口里写死了这段：
 *
 *     const bridge = hostPathBridge();                    // globalThis.__DSH_HOST_PATHS__
 *     if (bridge === void 0 && directory) return t("attachment.directoryDesktopOnly");
 *     const path = bridge?.pathFor(file) ?? "";           // 同步拿绝对路径
 *
 * 也就是说：**文件夹拖放的归属权本来就在 DSH 自己手里**，它只是缺一个同步的
 * `pathFor(file)`。桥在 → 文件夹（含一次拖多个）会走 `formatFileMention` 变成
 * `@相对路径/` 引用块；桥不在 → 只弹「只有桌面端支持添加文件夹」（英文 locale
 * 下是 `attachment.directoryDesktopOnly`）。
 *
 * 所以这里不碰 dragenter/dragover/drop 的归属：不 preventDefault、不
 * stopPropagation，原生遮罩层和原生处理器全程照旧。我们只是把桥补上。
 *
 * # 路径从哪来（按代价从低到高）
 *
 * 浏览器不给绝对路径（安全模型）。拖拽 payload 里只有文件夹的**名字**，所以
 * 只能按名字找，四级：
 *
 *   1. 学到的容器：上次成功解析/选择过的目录（持久化在 ~/.dsh/storages/…，最可能命中）；
 *   2. 工作区根 ±2 层 + 根所在卷的挂载点；
 *   3. 平台已知文件夹（见下表）；
 *   4. 平台文件索引（见下表）。
 *
 * 每一级都是 `stat(<容器>/<名字>)`，有界（≤160 次）。全盘递归扫描实测约
 * **28.5 秒 / 6.6 万目录**（Windows，D 盘 318GB），所以不做——落在这四级之外的
 * 目录会明确失败，`pathFor` 返回 ""，DSH 自己提示「无法获取文件夹路径，请重新
 * 拖入」。**任意位置**靠 client.js 里那个原生选择器按钮，不靠搜索。
 *
 * # 平台差异（只有这三处，其余全是 node:path / node:fs 的平台无关调用）
 *
 * | 能力 | win32 | darwin | linux |
 * |---|---|---|---|
 * | 已知文件夹 | 注册表 `User Shell Folders`（作者机器上是 D:\Desktop、D:\Documents、E:\Downloads —— 别猜 %USERPROFILE%） | `~/Desktop` `~/Documents` `~/Downloads` `~/Pictures` `~/Movies` `~/Music` + iCloud Drive | `~/.config/user-dirs.dirs` 的 XDG_*_DIR，缺失时退回 home 相对路径 |
 * | 额外挂载点 | A:–Z: 中存在的盘符 | `/Volumes/*` | `/mnt/*`、`/media/*` |
 * | 名字索引 | PowerShell + Windows Search（取 `System.ItemUrl`，**不是** `System.ItemPathDisplay`，后者是本地化假路径 `C:\用户\…`，盘上不存在） | `mdfind -name`（Spotlight，默认覆盖全盘，三个平台里最好用） | `plocate -b` → `locate -b` |
 *
 * macOS 的 Spotlight 覆盖全盘，所以在 Mac 上「拖任意位置」的成功率明显高于
 * Windows——Windows 的索引只覆盖已知文件夹那一片，`D:\Project` 这类工作目录
 * 不在其中。
 *
 * # 诊断
 *
 * `GET /dsh-host-paths/log` 返回最近 80 条事件 + 当前平台、容器列表、已知文件夹、
 * 已知但读不了的目录（macOS TCC）、挂载点。只监听回环地址，不往磁盘写敏感内容。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse as parsePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-host-paths'
/** Services required before mounting: the webserver routes and the index tap. */
export const inject = ['webServer']

const BASE = '/dsh-host-paths'
/** Directory of this host-half module (the browser script lives next to it). */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The browser script inlined into the served index.html. */
const CLIENT_SCRIPT = readFileSync(join(HERE, 'client-inject.js'), 'utf8')
/** Diagnostic ring size. */
const MAX_LOG = 80
/** Hard ceiling on filesystem probes for one lookup. */
const MAX_STAT = 160
/** Where learned containers persist (next to the other plugin storages). */
const STORE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-host-paths', 'containers.json')
/** How many learned containers to keep. */
const MAX_LEARNED = 40
/** Search-index result cache lifetime. */
const INDEX_TTL_MS = 60_000
/** How many index candidates to keep after verification. */
const MAX_INDEX_HITS = 25

/**
 * Whether one request may reach these routes.
 *
 * Loopback is always allowed. A deployment that serves the GUI beyond loopback
 * (the LAN-access composition) must name those authorities in
 * `ctx.webRuntime.trustedHosts`; they are accepted exactly the way the shipped
 * plugins accept them (`isTrustedApiRequest`), because the page calling us is
 * served from that very authority. Everything else — a cross-site browser
 * request, or an authority nobody vouched for — is refused: these routes hand
 * out local absolute paths.
 *
 * The host header is checked first, so an unlisted LAN origin gets a 403 instead
 * of silently breaking the drag bridge; if that happens, add the authority to
 * `webRuntime.trustedHosts` (or `connection`), not a wildcard here.
 *
 * @param request - node HTTP request.
 * @param ctx - host plugin context (reads the optional webRuntime service).
 * @returns true when the request is same-origin as the GUI we serve.
 */
function trusted(request, ctx) {
	const host = request.headers.host
	if (typeof host !== 'string' || host === '') return false
	if (request.headers['sec-fetch-site'] === 'cross-site') return false
	const hostname = host.replace(/:\d+$/u, '')
	const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/iu.test(hostname)
	if (!loopback && !trustedAuthority(host, hostname, ctx)) return false
	const origin = request.headers.origin
	if (typeof origin !== 'string' || origin === '') return true
	try {
		return new URL(origin).hostname === hostname
	} catch {
		return false
	}
}

/**
 * The authorities this deployment vouches for, from the optional `webRuntime`
 * service. A port-less entry (`192.168.1.9`) matches any port.
 *
 * @param host - the raw Host header.
 * @param hostname - the Host header without its port.
 * @param ctx - host plugin context.
 * @returns true when the authority is listed.
 */
function trustedAuthority(host, hostname, ctx) {
	let hosts = []
	try {
		hosts = ctx.get('webRuntime')?.trustedHosts ?? []
	} catch {
		hosts = []
	}
	if (!Array.isArray(hosts)) return false
	const full = host.toLowerCase()
	const bare = hostname.toLowerCase()
	return hosts.some((entry) => {
		if (typeof entry !== 'string' || entry === '') return false
		const normalized = entry.toLowerCase().replace(/^https?:\/\//u, '').replace(/\/+$/u, '')
		return normalized === full || normalized === bare
	})
}

/** Write one JSON response with caching disabled. */
function send(response, status, body) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	})
	response.end(JSON.stringify(body))
}

/** Read and parse a bounded JSON request body. */
function readBody(request, limit = 64 * 1024) {
	return new Promise((done, fail) => {
		let size = 0
		const chunks = []
		request.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				fail(new Error('body too large'))
				request.destroy()
				return
			}
			chunks.push(chunk)
		})
		request.on('end', () => {
			try {
				done(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
			} catch (error) {
				fail(error)
			}
		})
		request.on('error', fail)
	})
}

/**
 * Run a child process and collect stdout, never rejecting.
 *
 * @param command - executable name resolved through PATH.
 * @param args - argv passed without a shell.
 * @param timeout - milliseconds before the child is killed.
 * @returns stdout text ('' on any failure).
 */
function run(command, args, timeout) {
	return new Promise((done) => {
		try {
			execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
				done(error === null || error === undefined ? String(stdout) : '')
			})
		} catch {
			done('')
		}
	})
}

/**
 * Synchronous child run, used only for the one-time registry read on Windows.
 *
 * @param command - executable name resolved through PATH.
 * @param args - argv passed without a shell.
 * @returns stdout text ('' on any failure).
 */
function runSync(command, args) {
	try {
		return String(execFileSync(command, args, { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }))
	} catch {
		return ''
	}
}

/** `%VAR%` (Windows registry values) expansion. */
function expandPercentVars(value) {
	return value.replace(/%([^%]+)%/gu, (whole, name) => process.env[name] ?? whole)
}

/** `$VAR` / `${VAR}` (XDG user-dirs values) expansion. */
function expandDollarVars(value) {
	return value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (whole, name) => process.env[name] ?? whole)
}

/** Keep only the paths that exist, de-duplicated case-insensitively. */
function existing(list) {
	const seen = new Set()
	const kept = []
	for (const value of list) {
		if (typeof value !== 'string' || value === '') continue
		const key = value.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		if (!existsSync(value)) continue
		kept.push(value)
	}
	return kept
}

/**
 * Known folders this process can see but cannot enumerate.
 *
 * On macOS a TCC-protected folder such as `~/Documents` still passes
 * `existsSync` while `opendir` is refused, so a drop inside it fails with no
 * visible reason. Reporting the denial turns that silent miss into a diagnosis:
 * grant the DSH host process Full Disk Access, then restart it.
 *
 * Added by the macOS landing session (2026-09-29); Windows behaviour unchanged.
 *
 * @returns absolute known-folder paths that exist but cannot be listed.
 */
function deniedKnownFolders() {
	const denied = []
	for (const folder of knownFolders()) {
		try {
			readdirSync(folder)
		} catch {
			denied.push(folder)
		}
	}
	return denied
}

/**
 * Windows: the real shell folders, which Explorer relocates freely.
 *
 * @returns existing absolute known-folder paths.
 */
function windowsKnownFolders() {
	const map = new Map()
	const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
	const text = runSync('reg.exe', ['query', key])
	for (const line of text.split(/\r?\n/u)) {
		const match = /^\s{4}(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/u.exec(line)
		if (match === null) continue
		map.set(match[1].toUpperCase(), expandPercentVars(match[2]))
	}
	const home = homedir()
	const pick = (name, fallback) => {
		const value = map.get(name)
		return typeof value === 'string' && value !== '' ? value : fallback
	}
	return existing([
		pick('DESKTOP', join(home, 'Desktop')),
		pick('PERSONAL', join(home, 'Documents')),
		pick('{374DE290-123F-4565-9164-39C4925E467B}', join(home, 'Downloads')),
		pick('MY PICTURES', join(home, 'Pictures')),
		home
	])
}

/**
 * macOS: the standard home folders, plus iCloud Drive. `existsSync` filters the
 * ones this account does not have (or has relocated).
 *
 * @returns existing absolute known-folder paths.
 */
function macKnownFolders() {
	const home = homedir()
	return existing([
		join(home, 'Desktop'),
		join(home, 'Documents'),
		join(home, 'Downloads'),
		join(home, 'Pictures'),
		join(home, 'Movies'),
		join(home, 'Music'),
		join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
		home
	])
}

/**
 * Linux: XDG user dirs when `~/.config/user-dirs.dirs` exists, conventional names
 * otherwise.
 *
 * @returns existing absolute known-folder paths.
 */
function linuxKnownFolders() {
	const home = homedir()
	const map = new Map()
	try {
		const text = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8')
		for (const line of text.split(/\r?\n/u)) {
			const match = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"?([^"\n]+)"?/u.exec(line)
			if (match === null) continue
			map.set(match[1].toUpperCase(), expandDollarVars(match[2]))
		}
	} catch {
		/* no user-dirs.dirs: fall back to the conventional names */
	}
	const pick = (name, fallback) => {
		const value = map.get(name)
		return typeof value === 'string' && value !== '' ? value : fallback
	}
	return existing([
		pick('DESKTOP', join(home, 'Desktop')),
		pick('DOCUMENTS', join(home, 'Documents')),
		pick('DOWNLOAD', join(home, 'Downloads')),
		pick('PICTURES', join(home, 'Pictures')),
		home
	])
}

/**
 * The machine's real known folders, read once.
 *
 * @returns absolute known-folder paths that exist on this machine.
 */
function knownFolders() {
	if (knownFolders.cache !== undefined) return knownFolders.cache
	try {
		if (process.platform === 'win32') knownFolders.cache = windowsKnownFolders()
		else if (process.platform === 'darwin') knownFolders.cache = macKnownFolders()
		else knownFolders.cache = linuxKnownFolders()
	} catch {
		knownFolders.cache = existing([homedir()])
	}
	return knownFolders.cache
}

/** Small synchronous readdir that returns [] instead of throwing. */
function readdirDirectories(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	} catch {
		return []
	}
}

/**
 * Mount points worth probing: Windows drive letters, macOS `/Volumes`, Linux
 * `/mnt` and `/media` children.
 *
 * @returns absolute mount roots that exist.
 */
function mountRoots() {
	if (mountRoots.cache !== undefined) return mountRoots.cache
	const list = []
	if (process.platform === 'win32') {
		for (let code = 65; code <= 90; code += 1) {
			const root = `${String.fromCharCode(code)}:\\`
			if (existsSync(root)) list.push(root)
		}
	} else {
		const bases = process.platform === 'darwin' ? ['/Volumes'] : ['/mnt', '/media']
		for (const base of bases) {
			for (const child of readdirDirectories(base)) list.push(join(base, child))
		}
		list.push('/')
	}
	mountRoots.cache = existing(list)
	return mountRoots.cache
}

/** Containers learned from folders this user has resolved or picked before. */
function learnedContainers() {
	if (learnedContainers.cache !== undefined) return learnedContainers.cache
	try {
		const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
		learnedContainers.cache = Array.isArray(parsed?.containers) ? parsed.containers.filter((v) => typeof v === 'string') : []
	} catch {
		learnedContainers.cache = []
	}
	return learnedContainers.cache
}

/** Remember one directory whose children are worth checking first next time. */
function learn(dir) {
	if (typeof dir !== 'string' || dir === '') return
	const list = learnedContainers()
	const key = dir.toLowerCase()
	const next = [dir, ...list.filter((value) => value.toLowerCase() !== key)].slice(0, MAX_LEARNED)
	learnedContainers.cache = next
	try {
		mkdirSync(dirname(STORE_FILE), { recursive: true })
		writeFileSync(STORE_FILE, JSON.stringify({ containers: next }, null, 2), 'utf8')
	} catch {
		/* a failed write only costs the hint */
	}
}

/**
 * Directories that may hold the dropped item, most likely first.
 *
 * @param ctx - host plugin context.
 * @returns ordered candidate container directories, de-duplicated case-insensitively.
 */
function containers(ctx) {
	const list = []
	const seen = new Set()
	const add = (value) => {
		if (typeof value !== 'string' || value === '') return
		const key = value.toLowerCase()
		if (seen.has(key)) return
		seen.add(key)
		list.push(value)
	}
	/* 1. Learned first: the places this user actually works from. */
	for (const learned of learnedContainers()) add(learned)
	/* 2. Workspace roots, their parents, and the volume roots they live on. */
	const roots = []
	try {
		const registry = ctx.get('workspaceRegistry')
		for (const workspace of registry?.list?.() ?? []) {
			const path = workspace?.path ?? workspace?.cwd
			if (typeof path === 'string' && path !== '') roots.push(path)
		}
	} catch {
		/* registry absent: fall back to the process cwd alone */
	}
	roots.push(process.cwd())
	for (const root of roots) {
		let cursor = root
		for (let depth = 0; depth < 3; depth += 1) {
			add(cursor)
			const parent = dirname(cursor)
			if (parent === cursor) break
			cursor = parent
		}
		add(parsePath(root).root)
	}
	/* 3. Known folders, the places they live, and every other mount. */
	for (const folder of knownFolders()) {
		add(folder)
		add(dirname(folder))
	}
	for (const mount of mountRoots()) add(mount)
	return list
}

/**
 * Keep the index candidates whose basename really is `name` and whose kind matches.
 *
 * Platform indexes all match loosely (`mdfind -name`, `locate -b`, Windows Search),
 * so every candidate is verified against the real filesystem before it is trusted.
 *
 * @param candidates - raw paths reported by the platform index.
 * @param name - the exact base name the drop asked for.
 * @param directory - whether a folder is required.
 * @returns verified absolute paths, capped at {@link MAX_INDEX_HITS}.
 */
async function verifyCandidates(candidates, name, directory) {
	const hits = []
	const seen = new Set()
	for (const candidate of candidates) {
		if (hits.length >= MAX_INDEX_HITS) break
		if (typeof candidate !== 'string' || candidate === '') continue
		if (basename(candidate) !== name) continue
		const key = candidate.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		try {
			const info = await stat(candidate)
			if (directory === true ? info.isDirectory() : info.isDirectory() || info.isFile()) hits.push(candidate)
		} catch {
			/* a stale index row is simply skipped */
		}
	}
	return hits
}

/**
 * Windows Search through PowerShell + OleDb.
 *
 * `System.ItemUrl` carries the real path (`file:C:/Users/...`); `System.ItemPathDisplay`
 * is the localized display form (`C:\用户\...`) which does not exist on disk, so it is
 * never used.
 *
 * @param name - the base name to look up.
 * @param budget - child-process timeout in milliseconds.
 * @returns raw candidate paths.
 */
async function windowsIndex(name, budget) {
	const literal = name.replace(/'/gu, "''")
	const script = [
		"$ErrorActionPreference='Stop'",
		"$c=New-Object System.Data.OleDb.OleDbConnection \"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\"",
		'$c.Open()',
		'$q=$c.CreateCommand()',
		`$q.CommandText="SELECT TOP ${MAX_INDEX_HITS} System.ItemUrl FROM SYSTEMINDEX WHERE System.FileName = '${literal}'"`,
		'$r=$q.ExecuteReader()',
		'while($r.Read()){ $r.GetValue(0) }',
		'$c.Close()'
	].join('; ')
	const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
	let text = await run('pwsh.exe', args, budget)
	if (text === '') text = await run('powershell.exe', args, Math.min(budget, 2500))
	const paths = []
	for (const line of text.split(/\r?\n/u)) {
		const value = line.trim()
		if (!value.toLowerCase().startsWith('file:')) continue
		let candidate = value.slice(5).replace(/\//gu, '\\')
		if (/^\\[A-Za-z]:/u.test(candidate)) candidate = candidate.slice(1)
		try {
			paths.push(decodeURIComponent(candidate))
		} catch {
			paths.push(candidate)
		}
	}
	return paths
}

/**
 * macOS Spotlight: the widest reach of the three platforms (whole disk by default).
 *
 * @param name - the base name to look up.
 * @param budget - child-process timeout in milliseconds.
 * @returns raw candidate paths.
 */
async function macIndex(name, budget) {
	const text = await run('mdfind', ['-name', name], budget)
	return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
}

/**
 * Linux: plocate first, then locate.
 *
 * @param name - the base name to look up.
 * @param budget - child-process timeout in milliseconds.
 * @returns raw candidate paths.
 */
async function linuxIndex(name, budget) {
	for (const tool of ['plocate', 'locate']) {
		const text = await run(tool, ['-b', '-l', String(MAX_INDEX_HITS), name], budget)
		if (text !== '') return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
	}
	return []
}

/**
 * Ask the platform's file index for a name and return verified absolute paths.
 *
 * @param name - the base name to look up.
 * @param budget - child-process timeout in milliseconds.
 * @param directory - whether a folder is required.
 * @returns existing matching paths.
 */
async function searchIndex(name, budget, directory) {
	const cacheKey = `${directory === true ? 'd' : 'f'}:${name.toLowerCase()}`
	const hit = indexCache.get(cacheKey)
	if (hit !== undefined && Date.now() - hit.at < INDEX_TTL_MS) return hit.paths
	let raw = []
	try {
		if (process.platform === 'win32') raw = await windowsIndex(name, budget)
		else if (process.platform === 'darwin') raw = await macIndex(name, budget)
		else raw = await linuxIndex(name, budget)
	} catch {
		raw = []
	}
	const paths = await verifyCandidates(raw, name, directory)
	indexCache.set(cacheKey, { at: Date.now(), paths })
	return paths
}
/** Search-index result cache. */
const indexCache = new Map()

/**
 * Resolve one dropped item's absolute path by name against the candidate containers.
 *
 * @param ctx - host plugin context.
 * @param name - the dropped item's base name (no separators; anything else is refused).
 * @param directory - whether the item is a folder (folders must resolve to a folder).
 * @param budget - search-index child-process timeout; 0 skips the index entirely.
 * @returns the absolute path, or undefined when nothing matched inside the budget.
 */
async function locate(ctx, name, directory, budget) {
	if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return undefined
	if (/[\\/\u0000]/u.test(name)) return undefined
	let probes = MAX_STAT
	for (const container of containers(ctx)) {
		if (probes <= 0) break
		probes -= 1
		const candidate = join(container, name)
		try {
			const info = await stat(candidate)
			if (directory === true ? info.isDirectory() : info.isDirectory() || info.isFile()) {
				learn(container)
				return candidate
			}
		} catch {
			/* not under this container */
		}
	}
	if (budget > 0) {
		const found = await searchIndex(name, budget, directory)
		if (found.length > 0) {
			learn(dirname(found[0]))
			return found[0]
		}
	}
	return undefined
}

/** Insert the bridge script first in <head> so it beats every module that reads it. */
function injectScript(html) {
	const tag = `<script data-dsh-host-paths="1">${CLIENT_SCRIPT}</script>`
	return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
}

/**
 * Mount the index tap and the loopback routes.
 *
 * @param ctx - host plugin context (webServer available through inject).
 */
export function apply(ctx) {
	const log = []
	const record = (entry) => {
		log.push({ at: new Date().toISOString(), ...entry })
		while (log.length > MAX_LOG) log.shift()
	}

	ctx.effect(() => ctx.webServer.tapIndex(injectScript), 'dsh-host-paths: index injection')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${BASE}/locate`,
		handler: async (request, response) => {
			if (!trusted(request, ctx)) {
				send(response, 403, { error: 'forbidden' })
				return
			}
			if (request.method !== 'POST') {
				send(response, 405, { error: 'method' })
				return
			}
			const started = Date.now()
			try {
				const body = await readBody(request)
				const deep = body?.deep === true
				const path = await locate(ctx, body?.name, body?.directory === true, deep ? 3500 : 1500)
				record({
					kind: 'locate',
					name: typeof body?.name === 'string' ? body.name : '',
					directory: body?.directory === true,
					deep,
					hit: path !== undefined,
					path: path ?? '',
					ms: Date.now() - started
				})
				send(response, 200, path === undefined ? { path: '' } : { path })
			} catch (error) {
				record({ kind: 'locate-error', message: String(error?.message ?? error) })
				send(response, 200, { path: '' })
			}
		}
	}), 'dsh-host-paths: locate route')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${BASE}/learn`,
		handler: async (request, response) => {
			if (!trusted(request, ctx)) {
				send(response, 403, { error: 'forbidden' })
				return
			}
			try {
				const body = await readBody(request)
				if (typeof body?.path === 'string' && body.path !== '') {
					learn(dirname(body.path))
					record({ kind: 'learn', path: body.path })
				}
			} catch {
				/* a malformed hint is not an error */
			}
			send(response, 200, { ok: true })
		}
	}), 'dsh-host-paths: learn route')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${BASE}/report`,
		handler: async (request, response) => {
			if (!trusted(request, ctx)) {
				send(response, 403, { error: 'forbidden' })
				return
			}
			try {
				record({ kind: 'page', ...(await readBody(request)) })
			} catch {
				/* a malformed diagnostic must never surface as an error */
			}
			send(response, 200, { ok: true })
		}
	}), 'dsh-host-paths: report route')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${BASE}/log`,
		handler: async (request, response) => {
			if (!trusted(request, ctx)) {
				send(response, 403, { error: 'forbidden' })
				return
			}
			send(response, 200, {
				ok: true,
				platform: process.platform,
				entries: log,
				containers: learnedContainers(),
				known: knownFolders(),
				denied: deniedKnownFolders(),
				mounts: mountRoots()
			})
		}
	}), 'dsh-host-paths: log route')
}
