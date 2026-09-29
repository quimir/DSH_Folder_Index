/**
 * dsh-host-paths — 浏览器半体（客户端模块）
 *
 * 拖入的归属权在 DSH 自己手里（见宿主半体的说明），这里只补一件它做不到的事：
 * **选一个项目外面的任意文件夹**。
 *
 * 路径不可能从浏览器里"猜"出来（WebView2 连 text/uri-list 都不给），但可以让
 * 系统直接给：这里调用 DSH 自己的 `uiWorkspace.pickDirectory()`，也就是工作区
 * 选择器用的那个原生 IFileOpenDialog 子进程——已经在这台机器上跑通，能到任意
 * 盘符、任意位置。
 *
 * 选中的路径按 DSH 引用块的写法插进草稿：
 *
 *     sessionCtx.bail(sessionCtx, 'slash/input-insert-reference', { reference, span })
 *
 * 这就是 `@` 补全（ui-reference 的 onPick）走的那条通道：`insertReference` 把
 * 指定选区替换成**一个引用块**，文档结构不丢、光标留在后面、序列化发给模型的
 * 是 `@路径` 本身。事件按会话作用域投递，所以要从 `sessions.scope(sessionId)`
 * 拿那个 ctx。
 *
 * `span` 是带 `draftRev` 的 CAS：草稿每次变化都会让上一次的 rev 失效，所以
 * 插入前必须用**渲染期**读到的最新快照（`useInput` 是真 React 钩子，在回调里
 * 调用会抛 React #321）。快照过期时重试几次，最后退回 `setDraft` 纯文本。
 */
window.__ModuleLoader__.load({
	id: 'dsh-host-paths',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		const React = require('react')
		const { useCallback, useEffect, useRef, useState } = React

		/** 插槽：输入框工具栏左侧的一格（会话作用域，随会话挂载/卸载）。 */
		const SLOT = 'conversation.input.left'
		/** 本插件在这一格里的条目 id。 */
		const ENTRY_ID = 'host-paths-pick'
		/** 引用块的来源名：ui-reference 用的就是它，序列化器按它路由。 */
		const REFERENCE_SOURCE = 'reference'
		/** 学习接口：把选中目录的父目录告诉宿主，下次拖拽优先找那里。 */
		const LEARN_PATH = '/dsh-host-paths/learn'

		const COPY = {
			zh: {
				label: '添加文件夹',
				title: '添加项目外面的文件夹（插入它的路径引用）',
				busy: '正在等待选择…',
				denied: '路径含有无法引用的字符，请改名后再试',
				failed: '路径插入失败，输入框状态可能已变化，请重试',
				pickFailed: '打开文件夹选择器失败'
			},
			en: {
				label: 'Add folder',
				title: 'Add a folder from anywhere on this machine (inserts its path reference)',
				busy: 'Waiting for the picker…',
				denied: 'That path has characters the reference grammar cannot carry',
				failed: 'Could not insert the path — the composer changed, please retry',
				pickFailed: 'Could not open the folder picker'
			}
		}

		/** 判定语言：与上游一致（html lang 优先，其次 navigator.language）。 */
		function copy() {
			const language = (typeof document !== 'undefined' && document.documentElement.lang)
				|| (typeof navigator === 'undefined' ? '' : navigator.language)
				|| ''
			return String(language).toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
		}

		/**
		 * 把本机绝对路径写成引用文本。
		 *
		 * 规则照抄 `@deepseek-ai/dsh-file-reference/grammar` 与 DSH 附件入口对目录的
		 * 处理：目录补尾斜杠；含空白就整体引号化；带控制字符或引号的路径返回
		 * undefined——那种路径写进这个语法就是不安全的，而不是"将就一下"。
		 *
		 * @param {string} path 本机绝对路径（Windows 反斜杠照原样保留）。
		 * @returns {string|undefined} 形如 `@D:\a\b\` 或 `@"D:\a b\"` 的引用文本。
		 */
		function folderMention(path) {
			const raw = String(path).trim()
			if (raw.length === 0) return undefined
			const isWindows = /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('\\\\')
			const separator = isWindows ? '\\' : '/'
			const withSlash = raw.endsWith('/') || raw.endsWith('\\') ? raw : raw + separator
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(withSlash)) return undefined
			return /\s/u.test(withSlash) ? `@"${withSlash}"` : `@${withSlash}`
		}

		/** 引用块上显示的路径：加尾斜杠。 */
		function displayPath(path) {
			const raw = String(path).trim()
			if (raw.length === 0) return raw
			return raw.endsWith('/') || raw.endsWith('\\') ? raw : raw + '/'
		}

		/** 记一次学习，失败静默（只是提示，不是功能）。 */
		function learn(path) {
			try {
				const xhr = new XMLHttpRequest()
				xhr.open('POST', LEARN_PATH, true)
				xhr.setRequestHeader('content-type', 'application/json')
				xhr.send(JSON.stringify({ path }))
			} catch {
				/* best-effort */
			}
		}

		/**
		 * 把 `@路径` 插进当前会话的草稿。
		 *
		 * 快照来自 `live.current.draft`（渲染期读的），插入成功后 React 会因为草稿
		 * 变化重新渲染并刷新它；所以每次重试都取最新那份，而不是闭包里那一帧。
		 *
		 * @param {{current: object}} live 最新一帧的 { sessionCtx, inputActions, draft }。
		 * @param {string} path 选中的绝对路径。
		 * @returns {Promise<boolean>} 是否插进去了。
		 */
		async function insertReference(live, path) {
			const mention = folderMention(path)
			if (mention === undefined) return false
			const label = displayPath(path)
			const reference = {
				source: REFERENCE_SOURCE,
				ref: mention,
				label,
				appearance: 'folder',
				clipboardText: mention
			}
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const target = live.current
				const draft = target.draft
				if (target.sessionCtx !== undefined && target.sessionCtx !== null && draft !== undefined) {
					try {
						const span = { start: draft.text.length, end: draft.text.length, draftRev: draft.rev }
						if (target.sessionCtx.bail(target.sessionCtx, 'slash/input-insert-reference', { reference, span }) === true) return true
					} catch {
						/* 这台会话的输入机还没起来：等下一次渲染再试 */
					}
				}
				await new Promise((resume) => setTimeout(resume, 80))
			}
			try {
				const target = live.current
				const draft = target.draft
				if (target.inputActions !== undefined && draft !== undefined) {
					const joined = draft.text.length === 0
						? mention
						: `${draft.text}${/\s$/u.test(draft.text) ? '' : ' '}${mention}`
					target.inputActions.setDraft(joined)
					return true
				}
			} catch {
				/* fall through to the caller's failure message */
			}
			return false
		}

		/**
		 * 工具栏上的「添加文件夹」按钮。
		 *
		 * @param {object} props 插槽注入面 + 会话标准座（sessionId / useInput / inputActions）。
		 */
		function FolderPickButton(props) {
			const { sessionId, sessionCtx, useInput, inputActions, uiWorkspace } = props
			const [busy, setBusy] = useState(false)
			const [message, setMessage] = useState('')

			/* 草稿快照必须在渲染期读：useInput 是真 React 钩子。 */
			const draft = typeof useInput === 'function'
				? useInput(
					(snapshot) => ({ text: snapshot.draft, rev: snapshot.draftRev }),
					(left, right) => left.text === right.text && left.rev === right.rev
				)
				: undefined

			/** 每次点击现取：闭包里的 draft 会停在第一次渲染那一帧。 */
			const live = useRef({ sessionId, sessionCtx, inputActions, draft })
			live.current = { sessionId, sessionCtx, inputActions, draft }

			/** 写进去的提示 6 秒后自己收起来。 */
			useEffect(() => {
				if (message === '') return undefined
				const handle = setTimeout(() => setMessage(''), 6000)
				return () => clearTimeout(handle)
			}, [message])

			const onClick = useCallback(async () => {
				if (busy) return
				const text = copy()
				setBusy(true)
				setMessage('')
				try {
					if (uiWorkspace === undefined || typeof uiWorkspace.pickDirectory !== 'function') {
						setMessage(text.pickFailed)
						return
					}
					const picked = await uiWorkspace.pickDirectory()
					if (typeof picked !== 'string' || picked === '') return
					learn(picked)
					const inserted = await insertReference(live, picked)
					if (!inserted) setMessage(folderMention(picked) === undefined ? text.denied : text.failed)
				} catch (error) {
					setMessage(`${text.pickFailed}: ${error instanceof Error ? error.message : String(error)}`)
				} finally {
					setBusy(false)
				}
			}, [busy, uiWorkspace])

			const text = copy()
			const title = busy ? text.busy : text.title
			const tone = message === '' ? 'var(--dsw-alias-label-secondary, #8a8a8a)' : 'var(--dsw-alias-state-error-primary, #b23)'
			return React.createElement(
				'span',
				{ style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
				React.createElement(
					'button',
					{
						type: 'button',
						onClick,
						disabled: busy,
						title,
						'aria-label': text.label,
						'data-dsh-host-paths': 'pick',
						style: {
							display: 'inline-flex',
							alignItems: 'center',
							gap: 4,
							height: 26,
							padding: '0 8px',
							border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
							borderRadius: 6,
							background: 'transparent',
							color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
							fontSize: 12,
							lineHeight: '16px',
							cursor: busy ? 'progress' : 'pointer',
							whiteSpace: 'nowrap'
						}
					},
					React.createElement('span', { 'aria-hidden': true }, busy ? '⏳' : '📁+'),
					React.createElement('span', null, busy ? text.busy : text.label)
				),
				message === ''
					? null
					: React.createElement(
						'span',
						{
							role: 'alert',
							style: {
								color: tone,
								fontSize: 12,
								lineHeight: '16px',
								maxWidth: 320,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap'
							}
						},
						message
					)
			)
		}

		/**
		 * 客户端插件入口。
		 *
		 * @param {object} ctx 客户端根上下文。
		 */
		function apply(ctx) {
			const slots = ctx.get('slots')
			const sessions = ctx.get('sessions')
			if (slots === undefined || sessions === undefined) {
				ctx.logger?.warn?.('dsh-host-paths: 缺少 slots/sessions 服务，按钮不挂载')
				return
			}
			/* 原生选择器由 uiWorkspace 提供；缺席时按钮自己会说明，而不是静默失败。 */
			const uiWorkspace = ctx.get('uiWorkspace')
			ctx.effect(
				() => slots.inject(SLOT, () => slots.register({
					name: SLOT,
					id: ENTRY_ID,
					order: 30,
					label: () => copy().label,
					inject: (sessionId) => {
						const sessionCtx = sessions.scope(sessionId)
						return sessionCtx === undefined
							? { sessionId, uiWorkspace }
							: { sessionId, sessionCtx, uiWorkspace }
					}
				}, FolderPickButton)),
				'dsh-host-paths: 添加文件夹按钮'
			)
		}

		exports.apply = apply
		/* 客户端插件的服务门：cordis 读到这个数组会等服务就绪再调 apply。 */
		exports.inject = ['slots', 'sessions', 'uiWorkspace']
		exports.__test__ = { folderMention, displayPath }
		return module.exports
	}
})
