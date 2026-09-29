/**
 * dsh-host-paths — 浏览器半体（由宿主半体内联进首页 <head>）
 *
 * 它只做一件事：定义 `globalThis.__DSH_HOST_PATHS__`，也就是 DSH 客户端
 * （`dsh-client-ui-conversation` 的 `hostPathBridge()`）要找的那个桌面桥。
 *
 * # 契约（照抄 DSH 客户端的调用点）
 *
 *     const bridge = hostPathBridge();                 // globalThis.__DSH_HOST_PATHS__
 *     if (bridge === void 0 && directory) return t("attachment.directoryDesktopOnly");
 *     const path = bridge?.pathFor(file) ?? "";        // 必须是**同步**返回字符串
 *
 * 返回 "" 表示「这次拿不到路径」，DSH 会提示「无法获取文件夹路径，请重新拖入」；
 * 返回路径则由 DSH 自己 `relativizeToCwd` + `formatFileMention` 变成 `@相对路径/`
 * 引用块——包括一次拖入多个文件夹。
 *
 * # 边界
 *
 * 1. **不抢拖拽事件。** 全程不 preventDefault、不 stopPropagation：原生遮罩层
 *    和原生处理器照旧跑。我们只在 document 捕获阶段**读**一次 dataTransfer，
 *    因为捕获阶段一定早于 DSH 挂在 document 冒泡阶段的处理器。
 * 2. **只接管文件夹。** 普通文件 `pathFor` 直接返回 ""，于是继续走原来的附件
 *    上传流程——拖文件的行为一个字节都没变。
 * 3. **拿不到就说拿不到。** 绝不用「名字」凑一个假路径：定位失败返回 ""。
 *
 * # 路径的来源，按优先级
 *
 * 1. 拖入瞬间的 `text/uri-list`（浏览器愿意给就是最准的，零延迟）；
 * 2. dragover 期间异步预取的宿主定位结果（按名字缓存，drop 时通常已经就绪）；
 * 3. drop 时同步询问宿主 `/dsh-host-paths/locate`（XMLHttpRequest 同步模式）。
 *
 * 第 3 条会短暂阻塞主线程，属于兜底；正常路径是第 1、2 条。
 */
(function () {
	'use strict';
	if (typeof globalThis === 'undefined') return;
	/* 真正的桌面端已经提供桥时不抢：它的 pathFor 是原生实现，一定比我们准。 */
	if (globalThis.__DSH_HOST_PATHS__ !== undefined) return;

	var BASE = '/dsh-host-paths';
	/** 本次拖拽里被判定为目录的 File 键。 */
	var dirKeys = [];
	/** File 键 → 已解析的绝对路径。 */
	var resolved = Object.create(null);
	/** 目录名 → 预取到的绝对路径。 */
	var prefetched = Object.create(null);
	/** 诊断用：最近 20 次判定。 */
	var trace = [];
	/** dragover 预取的节流时间戳。 */
	var prefetchAt = 0;

	/** File 的稳定标识：同名不同盘的两个文件夹才会撞键，代价可接受。 */
	function keyOf(file) {
		return String(file.name) + '\u0000' + String(file.size) + '\u0000' + String(file.lastModified);
	}

	/** 记一条诊断，并尽力送回宿主（失败静默）。 */
	function note(entry) {
		try {
			trace.push(entry);
			if (trace.length > 20) trace.shift();
			var xhr = new XMLHttpRequest();
			xhr.open('POST', BASE + '/report', true);
			xhr.setRequestHeader('content-type', 'application/json');
			xhr.send(JSON.stringify(entry));
		} catch (error) {
			/* 诊断失败不影响功能 */
		}
	}

	/** 把一条 file:// URI 转成本机绝对路径（Windows 反斜杠；其它平台保持斜杠）。 */
	function uriToPath(uri) {
		try {
			var url = new URL(String(uri).trim());
			if (url.protocol !== 'file:') return '';
			var path = decodeURIComponent(url.pathname);
			if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
			var windows = /^[A-Za-z]:/.test(path);
			return windows ? path.replace(/\//g, '\\') : path;
		} catch (error) {
			return '';
		}
	}

	/** dataTransfer 里的 text/uri-list（没有就返回空数组）。 */
	function uriList(transfer) {
		try {
			var raw = transfer.getData('text/uri-list') || '';
			if (raw === '') return [];
			return raw.split(/\r?\n/)
				.map(function (line) { return line.trim(); })
				.filter(function (line) { return line !== '' && line.charAt(0) !== '#'; })
				.map(uriToPath)
				.filter(function (path) { return path !== ''; });
		} catch (error) {
			return [];
		}
	}

	/** 同步询问宿主定位（兜底路径）。 */
	function locateSync(name) {
		try {
			var xhr = new XMLHttpRequest();
			xhr.open('POST', BASE + '/locate', false);
			xhr.setRequestHeader('content-type', 'application/json');
			xhr.send(JSON.stringify({ name: name, directory: true }));
			if (xhr.status !== 200) return '';
			var body = JSON.parse(xhr.responseText || '{}');
			return typeof body.path === 'string' ? body.path : '';
		} catch (error) {
			return '';
		}
	}

	/** 异步预取：dragover 期间把目录名交给宿主先查一遍，drop 时就能同步命中。 */
	function prefetch(transfer) {
		var now = Date.now();
		if (now - prefetchAt < 400) return;
		prefetchAt = now;
		try {
			var items = transfer.items || [];
			for (var index = 0; index < items.length; index += 1) {
				var item = items[index];
				if (item.kind !== 'file') continue;
				var entry = null;
				try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (error) { entry = null; }
				if (entry === null || entry === undefined || entry.isDirectory !== true) continue;
				if (prefetched[entry.name] !== undefined) continue;
				prefetched[entry.name] = '';
				(function (name) {
					try {
						var xhr = new XMLHttpRequest();
						xhr.open('POST', BASE + '/locate', true);
						xhr.setRequestHeader('content-type', 'application/json');
						xhr.onload = function () {
							try {
								var body = JSON.parse(xhr.responseText || '{}');
								if (typeof body.path === 'string' && body.path !== '') prefetched[name] = body.path;
							} catch (error) { /* keep the empty entry */ }
						};
						xhr.send(JSON.stringify({ name: name, directory: true }));
					} catch (error) { /* prefetch is best-effort */ }
				}(entry.name));
			}
		} catch (error) {
			/* prefetch is best-effort */
		}
	}

	/** 拖拽开始/结束时清空本次状态。 */
	function reset() {
		dirKeys = [];
		resolved = Object.create(null);
		prefetched = Object.create(null);
		prefetchAt = 0;
	}

	/**
	 * drop 的捕获阶段：只读，把「哪些 File 是目录」和 uri-list 记下来，
	 * 然后原样放行给 DSH 自己的处理器。
	 */
	function onDrop(event) {
		try {
			var transfer = event.dataTransfer;
			if (transfer === null || transfer === undefined) return;
			var files = transfer.files ? Array.prototype.slice.call(transfer.files) : [];
			var keys = [];
			var index = 0;
			var items = transfer.items || [];
			for (var cursor = 0; cursor < items.length; cursor += 1) {
				var item = items[cursor];
				if (item.kind !== 'file') continue;
				var file = files[index];
				index += 1;
				if (file === undefined) continue;
				var entry = null;
				try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (error) { entry = null; }
				if (entry !== null && entry !== undefined && entry.isDirectory === true) keys.push(keyOf(file));
			}
			dirKeys = keys;
			var uris = uriList(transfer);
			if (uris.length === files.length) {
				for (var at = 0; at < files.length; at += 1) {
					if (uris[at] !== '') resolved[keyOf(files[at])] = uris[at];
				}
			}
			note({
				kind: 'drop',
				files: files.length,
				directories: keys.length,
				uriList: uris.length,
				names: files.map(function (file) { return file.name; }).slice(0, 6)
			});
		} catch (error) {
			note({ kind: 'drop-error', message: String(error && error.message ? error.message : error) });
			return;
		}
		/* 状态留到 DSH 读完桥再清：pathFor 是在同一个事件派发里同步调用的。 */
		window.setTimeout(reset, 0);
	}

	/**
	 * 同步解析一个被拖入对象的绝对路径。
	 *
	 * @param file - dataTransfer 给出的 File；普通文件返回 "" 以保留原有上传行为。
	 * @returns 绝对路径，或 ""（DSH 会据此提示「无法获取文件夹路径」）。
	 */
	function pathFor(file) {
		try {
			if (file === null || file === undefined || typeof file.name !== 'string' || file.name === '') return '';
			var key = keyOf(file);
			/* 普通文件不是我们的活：返回 "" → 继续走附件上传。 */
			if (dirKeys.indexOf(key) === -1) return '';
			if (resolved[key] !== undefined && resolved[key] !== '') {
				note({ kind: 'hit', source: 'drop', name: file.name, path: resolved[key] });
				return resolved[key];
			}
			if (prefetched[file.name] !== undefined && prefetched[file.name] !== '') {
				resolved[key] = prefetched[file.name];
				note({ kind: 'hit', source: 'prefetch', name: file.name, path: prefetched[file.name] });
				return prefetched[file.name];
			}
			var located = locateSync(file.name);
			if (located !== '') {
				resolved[key] = located;
				note({ kind: 'hit', source: 'locate', name: file.name, path: located });
				return located;
			}
			note({ kind: 'miss', name: file.name });
			return '';
		} catch (error) {
			note({ kind: 'pathFor-error', message: String(error && error.message ? error.message : error) });
			return '';
		}
	}

	document.addEventListener('drop', onDrop, true);
	document.addEventListener('dragenter', function (event) {
		try {
			if (prefetchAt === 0) reset();
			if (event.dataTransfer !== null && event.dataTransfer !== undefined) prefetch(event.dataTransfer);
		} catch (error) { /* best-effort */ }
	}, true);
	document.addEventListener('dragover', function (event) {
		try {
			if (event.dataTransfer !== null && event.dataTransfer !== undefined) prefetch(event.dataTransfer);
		} catch (error) { /* best-effort */ }
	}, true);
	document.addEventListener('dragend', reset, true);
	window.addEventListener('blur', reset, true);

	globalThis.__DSH_HOST_PATHS__ = {
		pathFor: pathFor,
		/** 诊断出口：控制台里 `__DSH_HOST_PATHS__.trace()` 看最近 20 次判定。 */
		trace: function () { return trace.slice(); }
	};
}());
