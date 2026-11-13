/**
 * The "流程图" conversation view: one page that lists the chart collection, draws
 * the selected chart's mermaid source, and edits that source beside its brief.
 *
 * A chart is one `.spec/flows/<id>.md` — a title, a scope line, a `mermaid` block
 * and a brief. The picture is a preview of that block, so the editor is the text:
 * one copy of the diagram, in the file it is stored in.
 *
 * All reads and writes go through the Host's `/spec/flows` routes. The view never
 * decides whether a chart is valid: it shows the Host's errors verbatim, which is
 * what keeps one set of rules instead of two.
 */

/**
 * The whole module is wrapped in a function expression, and that is not style.
 *
 * The Host serves client code as `plugins/??a,b,c` bundles — several packages
 * concatenated into ONE script — and this package is shipped in two of them at
 * once. A `const` at the top of this file is therefore a `const` at the top of a
 * script that is executed twice in the same realm, which is a SyntaxError:
 * "Identifier has already been declared". The first version of this file did
 * exactly that and the view silently failed to load, with the whole page falling
 * back to an empty column.
 *
 * Keeping every declaration inside this function makes the file safe to
 * concatenate, concatenate again, and evaluate in any order.
 */
(() => {
/** The locale namespace and the View's registration id. */
const SPEC_FLOWS_NS = 'specFlows';
const SPEC_FLOWS_CHART_ID = 'spec-flows';
/** Where the Host mounts the collection routes. */
const SPEC_FLOWS_ROUTE = 'spec/flows';

window.__ModuleLoader__.load({
	id: 'dsh-spec-mode',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const zh = {
			view: '流程图',
			title: '流程图集',
			empty: '这个项目还没有流程图集。用 /spec 访谈一次，或在这里新建一张。',
			noBrief: '这张图还没有简报。访谈时模型会补上；也可以直接在这里写。',
			loading: '载入中…',
			saving: '保存中…',
			saved: '已保存',
			dirty: '未保存',
			conflict: '盘上的图已经变了，先重新载入再改。',
			reload: '重新载入',
			save: '保存',
			create: '新建图',
			createTitle: '新建一张图',
			remove: '删除',
			removeConfirm: '删掉这张图？被别的图引用时会被拒绝。',
			id: '编号（文件名，不再改）',
			name: '显示名',
			scope: '作用范围：这张图从哪一步到哪一步',
			brief: '需求简报',
			preview: '预览',
			source: '源码',
			sourceHint: '第一行 `flowchart LR`；节点一行一个 `n1["谁做了什么"]`；箭头一行一条 `n1 --> n2`，分叉写成 `n1 -->|条件| n2`。',
			briefHint: '四节：目标 / 要做什么 / 验收 / 约束。人可以随便写，模型写的会被校验。',
			renderFailed: '渲染失败',
			mermaidFailed: 'mermaid 库没加载起来：宿主那条 mermaid.js 路由没通。',
			problems: '读不出来的文件',
			parents: '被引用',
			noSelection: '左边选一张图。',
			keyboard: 'Ctrl/Cmd+S 保存',
			cancel: '取消',
			ok: '确定',
		};

		const en = {
			view: 'Charts',
			title: 'Chart collection',
			empty: 'This project has no charts yet. Run /spec once, or create one here.',
			noBrief: 'This chart has no brief yet. The interview fills it in; you can also write it here.',
			loading: 'Loading…',
			saving: 'Saving…',
			saved: 'Saved',
			dirty: 'Unsaved',
			conflict: 'The chart on disk has changed. Reload before saving.',
			reload: 'Reload',
			save: 'Save',
			create: 'New chart',
			createTitle: 'New chart',
			remove: 'Delete',
			removeConfirm: 'Delete this chart? A chart something points at is refused.',
			id: 'Id (file name, never renamed)',
			name: 'Display name',
			scope: 'Scope: which step this chart runs from and to',
			brief: 'Requirement brief',
			preview: 'Preview',
			source: 'Source',
			sourceHint: 'First line `flowchart LR`; one node per line, `n1["who does what"]`; one arrow per line, `n1 --> n2`, and a fork written `n1 -->|condition| n2`.',
			briefHint: 'Four sections: goal / what to build / acceptance / constraints. A person may write freely; a model’s brief is validated.',
			renderFailed: 'Render failed',
			mermaidFailed: 'The mermaid library did not load: the Host route for mermaid.js is not answering.',
			problems: 'Unreadable files',
			parents: 'Referenced by',
			noSelection: 'Pick a chart on the left.',
			keyboard: 'Ctrl/Cmd+S saves',
			cancel: 'Cancel',
			ok: 'OK',
		};

		/**
		 * Resolve one route under the page's own base, so a GUI served behind a
		 * directory prefix still reaches its Host.
		 * @param {string} verb - the route verb.
		 * @param {Record<string, string>} [query] - query parameters.
		 * @returns {string} the URL.
		 */
		function routeUrl(verb, query = {}) {
			const params = new URLSearchParams(query);
			const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI;
			const url = new URL(`${SPEC_FLOWS_ROUTE}/${verb}`, base);
			for (const [key, value] of params) url.searchParams.set(key, value);
			return url.toString();
		}

		/**
		 * One request against the collection routes.
		 * @param {string} verb - the route verb.
		 * @param {{ query?: Record<string, string>, body?: unknown }} [options] - request options.
		 * @returns {Promise<any>} the parsed payload.
		 */
		async function call(verb, options = {}) {
			const init = { method: options.body === undefined ? 'GET' : 'POST' };
			if (options.body !== undefined) {
				init.headers = { 'content-type': 'application/json' };
				init.body = JSON.stringify(options.body);
			}
			const response = await fetch(routeUrl(verb, options.query), init);
			const payload = await response.json().catch(() => ({ ok: false, code: 'bad-json', message: '返回的不是 JSON' }));
			return { status: response.status, ...payload };
		}

		/** 第一次加载的 promise 存下来：两张图连着切不会各下一遍几 MB 的库。 */
		let mermaidLoading = null;

		/**
		 * mermaid 只有宿主那条路由，客户端 bundle 里没有这个包。
		 * @returns {Promise<any>} `window.mermaid`.
		 */
		function loadMermaid() {
			if (typeof window.mermaid !== 'undefined') return Promise.resolve(window.mermaid);
			if (mermaidLoading !== null) return mermaidLoading;
			// 失败也留着同一个 rejected promise，否则每次重画都会重下一遍坏掉的脚本。
			mermaidLoading = new Promise((resolve, reject) => {
				const script = document.createElement('script');
				script.src = routeUrl('mermaid.js');
				script.async = true;
				script.onload = () => (typeof window.mermaid === 'undefined'
					? reject(Object.assign(new Error('mermaid'), { code: 'mermaid-load' }))
					: resolve(window.mermaid));
				script.onerror = () => reject(Object.assign(new Error('mermaid'), { code: 'mermaid-load' }));
				document.head.appendChild(script);
			});
			return mermaidLoading;
		}

		/**
		 * Below this many pixels of page width the three panes stack instead of
		 * sharing one row. 720px is what the picture, the source and the brief need
		 * before each still shows a usable column.
		 */
		const NARROW_WIDTH = 720;

		const styles = {
			// The height comes from the shell's own variable, not from `100%`.
			// `100%` resolves against the View area, which the shell declares
			// `flex: 1 0 auto` — so it grows to whatever the tallest column needs, and
			// `100%` grows with it. The page then stood 1514px tall inside a 724px
			// scroller, the whole conversation body scrolled, and the composer's ghost
			// strip drifted over the brief. Pinning the read height keeps every column
			// scrolling inside the page, where it belongs.
			page: {
				display: 'flex',
				height: 'var(--dsh-conversation-viewport-height, 100%)',
				maxHeight: 'var(--dsh-conversation-viewport-height, 100%)',
				overflow: 'hidden',
				minHeight: 0,
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
			},
			side: {
				width: 240,
				flex: '0 0 240px',
				borderRight: '1px solid var(--dsw-alias-border-l1)',
				overflowY: 'auto',
				padding: '12px 8px',
				background: 'var(--dsw-alias-bg-layer-1)',
			},
			// The three panes side by side need room the Desktop window does not always
			// have: its minimum width is 520px and the shell sidebar takes 280 of them.
			// Below `NARROW_WIDTH` the page stacks — list on top, picture above its
			// brief — instead of running its toolbar and inputs off the right edge.
			stackedSide: {
				width: '100%',
				flex: '0 0 auto',
				// `box-sizing` is border-box here: the padding is inside the 100%, so the
				// column cannot be two pixels wider than the page and push a scrollbar
				// onto it.
				boxSizing: 'border-box',
				maxHeight: '34%',
				borderRight: 'none',
				borderBottom: '1px solid var(--dsw-alias-border-l1)',
				overflowY: 'auto',
				padding: '12px 8px',
				background: 'var(--dsw-alias-bg-layer-1)',
			},
			sideTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', padding: '0 8px 8px' },
			item: (active) => ({
				display: 'block',
				width: '100%',
				textAlign: 'left',
				border: 'none',
				borderRadius: 8,
				background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
				color: 'var(--dsw-alias-label-primary)',
				padding: '7px 8px',
				cursor: 'pointer',
				font: 'inherit',
			}),
			itemName: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 },
			// `scope` is one sentence about what the chart covers, and it is the one
			// thing that tells two similar charts apart. Truncating it with an ellipsis
			// removed exactly the half that named the boundary, so it wraps instead.
			itemMeta: { fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)', marginTop: 2, overflowWrap: 'anywhere' },
			badge: {
				fontSize: 10,
				padding: '1px 5px',
				borderRadius: 4,
				border: '1px solid var(--dsw-alias-border-l1)',
				color: 'var(--dsw-alias-label-secondary)',
			},
			main: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
			bar: {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '10px 14px',
				borderBottom: '1px solid var(--dsw-alias-border-l1)',
				flex: '0 0 auto',
				// The window can be dragged down to the Desktop shell's own minimum
				// width, where two inputs and two buttons no longer fit on one line.
				// They wrap instead of being pushed off the pane.
				flexWrap: 'wrap',
				rowGap: 6,
			},
			// The name and the scope are long strings in a toolbar: they take the slack
			// but stop short of squeezing the buttons off the row.
			barInput: {
				flex: '1 1 150px',
				minWidth: 0,
				maxWidth: 280,
				padding: '4px 8px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 6,
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit',
				fontSize: 12,
			},
			spacer: { flex: 1 },
			body: { flex: 1, minHeight: 0, display: 'flex' },
			stackedBody: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
			// The picture scrolls inside its own box: a wide diagram must not push the
			// hint line under it out of the pane.
			canvas: { flex: '1 1 58%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 14, background: 'var(--dsw-alias-bg-base)' },
			stackedCanvas: { flex: '1 1 60%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 14, background: 'var(--dsw-alias-bg-base)' },
			preview: {
				flex: 1,
				minHeight: 0,
				overflow: 'auto',
				padding: 10,
				borderRadius: 10,
				border: '1px solid var(--dsw-alias-border-l1)',
				background: 'var(--dsw-alias-bg-base)',
				boxSizing: 'border-box',
			},
			previewEmpty: {
				flex: 1,
				minHeight: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: 10,
				borderRadius: 10,
				border: '1px solid var(--dsw-alias-border-l1)',
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: 12,
				boxSizing: 'border-box',
			},
			source: {
				flex: 1,
				minHeight: 0,
				width: '100%',
				boxSizing: 'border-box',
				padding: '8px 10px',
				borderRadius: 10,
				border: '1px solid var(--dsw-alias-border-l1)',
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: 12,
				lineHeight: 1.6,
				resize: 'none',
			},
			brief: {
				flex: '1 1 42%',
				minWidth: 0,
				borderLeft: '1px solid var(--dsw-alias-border-l1)',
				overflowY: 'auto',
				padding: 14,
				background: 'var(--dsw-alias-bg-layer-1)',
			},
			stackedBrief: {
				flex: '0 0 40%',
				minHeight: 0,
				minWidth: 0,
				borderLeft: 'none',
				borderTop: '1px solid var(--dsw-alias-border-l1)',
				overflowY: 'auto',
				padding: 14,
				background: 'var(--dsw-alias-bg-layer-1)',
			},
			paneCol: { display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' },
			briefArea: {
				flex: 1,
				minHeight: 96,
				width: '100%',
				boxSizing: 'border-box',
				marginTop: 4,
				marginBottom: 10,
				padding: '6px 8px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 6,
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit',
				fontSize: 12,
				lineHeight: 1.6,
				resize: 'vertical',
			},
			input: {
				display: 'block',
				width: '100%',
				boxSizing: 'border-box',
				marginTop: 4,
				marginBottom: 10,
				padding: '6px 8px',
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 6,
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit',
			},
			label: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
			button: {
				padding: '5px 10px',
				borderRadius: 6,
				border: '1px solid var(--dsw-alias-border-l1)',
				background: 'var(--dsw-alias-bg-layer-1)',
				color: 'var(--dsw-alias-label-primary)',
				cursor: 'pointer',
				font: 'inherit',
				fontSize: 12,
			},
			primary: {
				padding: '5px 12px',
				borderRadius: 6,
				border: '1px solid var(--dsw-alias-brand-primary)',
				background: 'var(--dsw-alias-brand-primary)',
				// The brand fill flips to near-white in the dark scheme, so the text on
				// it has to come from the token that flips with it. A literal `#fff`
				// painted white on white and the button read as empty.
				color: 'var(--dsw-alias-label-primary-foreground)',
				cursor: 'pointer',
				font: 'inherit',
				fontSize: 12,
			},
			// Wrapping: the status row holds a button and a badge, and the toolbar holds
			// two inputs and two buttons, which is wider than the pane once the window
			// is small. Without this the last control hangs past the page's right edge.
			row: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' },
			error: {
				border: '1px solid var(--dsw-alias-state-error-primary)',
				color: 'var(--dsw-alias-state-error-primary)',
				borderRadius: 8,
				padding: '8px 10px',
				marginBottom: 10,
				fontSize: 12,
				whiteSpace: 'pre-wrap',
			},
			warn: {
				border: '1px solid var(--dsw-alias-state-warn-primary)',
				color: 'var(--dsw-alias-state-warn-primary)',
				borderRadius: 8,
				padding: '8px 10px',
				marginBottom: 10,
				fontSize: 12,
				whiteSpace: 'pre-wrap',
			},
			hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
			sectionTitle: { fontSize: 12, fontWeight: 600, margin: '12px 0 6px' },
		};

		/**
		 * One labelled input.
		 * @param {object} props - label, value, onChange, placeholder, disabled.
		 * @returns {object} the element.
		 */
		function Field({ label, value, onChange, placeholder, disabled = false }) {
			const id = React.useId();
			return h('div', null,
				h('label', { htmlFor: id, style: styles.label }, label),
				h('input', {
					id,
					value,
					placeholder,
					disabled,
					onChange: (event) => onChange(event.target.value),
					style: { ...styles.input, opacity: disabled ? 0.6 : 1 },
				}));
		}

		/**
		 * The chart page.
		 * @param {object} props - the slot props.
		 * @returns {object} the element.
		 */
		function FlowsView(props) {
			const sessionId = props.sessionId;
			const t = props.t ?? ((key) => zh[key] ?? key);
			const [state, setState] = React.useState({ phase: 'loading', charts: [], problems: [] });
			const [selected, setSelected] = React.useState('');
			// The three fields the file stores besides the brief: id never changes, the
			// other two are inputs.
			const [draft, setDraft] = React.useState(null);
			// What the textarea edits, byte for byte what the file holds.
			const [source, setSource] = React.useState('');
			// The same picture with module boxes already renamed by the Host; only the
			// Host can do that, because the name lives in the chart it points at.
			const [drawn, setDrawn] = React.useState('');
			const [brief, setBrief] = React.useState('');
			const [baseRevision, setBaseRevision] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [banner, setBanner] = React.useState(null);
			const [creating, setCreating] = React.useState(false);
			// Whether the editor differs from what was loaded. Tracked as a flag set by
			// every edit and cleared by a save or a reload, because comparing the whole
			// text on every keystroke would need a copy of what was loaded.
			const [dirty, setDirty] = React.useState(false);
			// Set by the first keystroke in the textarea. Until then the preview gets the
			// Host's version, which names module boxes after the charts they point at.
			const [sourceEdited, setSourceEdited] = React.useState(false);
			const [svg, setSvg] = React.useState('');
			const [renderError, setRenderError] = React.useState('');
			// null follows the width: a narrow pane opens on the source, a wide one on
			// the picture. The toggle pins the choice.
			const [mode, setMode] = React.useState(null);
			const [dark, setDark] = React.useState(false);
			// Editing a chart is not a conversation turn: the composer competes with the
			// editor for the bottom of the page, and a message typed there lands in a
			// Session whose working tree this page is editing. It is hidden only while
			// this View is mounted — the shell renders just the active View, so leaving
			// the tab puts it back. The rule keys off the Host's own
			// `data-composer-seat` marker; if that attribute ever changes the rule stops
			// matching and the composer simply reappears, which is the safe failure.
			React.useEffect(() => {
				const root = document.documentElement;
				root.setAttribute('data-spec-flows-view', '');
				const style = document.createElement('style');
				// The shell also draws two invisible `col-resize` strips at the edges of
				// the chat column. In this View they land on top of the brief pane — a
				// 10px-wide ghost that changes the cursor to `col-resize` and swallows the
				// click — while resizing a column that is not on screen. Both controls
				// belong to the conversation layout this View replaces.
				style.textContent = 'html[data-spec-flows-view] [data-composer-seat],'
					+ 'html[data-spec-flows-view] [data-width-handle]{display:none}'
					// The drawn picture keeps its natural size for mermaid and is scaled to
					// the column it is read in; `height:auto` keeps that scale uniform.
					+ 'html[data-spec-flows-view] [data-spec-preview] svg{max-width:100%;height:auto;display:block;margin:0 auto}';
				document.head.appendChild(style);
				return () => {
					root.removeAttribute('data-spec-flows-view');
					style.remove();
				};
			}, []);
			// The three panes need a width the window does not always offer: the Desktop
			// shell allows its window down to 520px and its own sidebar takes 280 of
			// them. Measured on the page itself, so the switch follows the space the
			// View actually got rather than the window.
			const [narrow, setNarrow] = React.useState(false);
			const pageRef = React.useRef(null);
			// `phase` is a dependency because the page element does not exist until the
			// collection has loaded: an effect with `[]` would run once against a null
			// ref and never observe anything.
			React.useEffect(() => {
				const root = pageRef.current;
				if (root === null || typeof ResizeObserver === 'undefined') return undefined;
				const observer = new ResizeObserver((entries) => {
					const width = entries[0]?.contentRect.width ?? 0;
					setNarrow(width < NARROW_WIDTH);
				});
				observer.observe(root);
				return () => observer.disconnect();
			}, [state.phase]);
			// mermaid's theme is a global setting chosen at initialize time, so the
			// scheme has to be read before every draw and watched for the whole session.
			React.useEffect(() => {
				const body = document.body;
				if (body === null || typeof MutationObserver === 'undefined') return undefined;
				const read = () => setDark(body.hasAttribute('data-ds-dark-theme'));
				read();
				const observer = new MutationObserver(read);
				observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
				return () => observer.disconnect();
			}, []);

			const load = React.useCallback(async (id) => {
				setState((current) => ({ ...current, phase: current.charts.length === 0 ? 'loading' : current.phase }));
				const listing = await call('list', { query: { session: sessionId } });
				if (!listing.ok) {
					setState({ phase: 'failed', charts: [], problems: [], error: listing.message });
					return;
				}
				setState({ phase: 'ready', charts: listing.charts, problems: listing.problems ?? [] });
				// `??` would keep an empty string: `selected` starts as '' and a chart
				// whose id is blank would win the fallback and select nothing.
				const want = id || selected || listing.charts[0]?.id || '';
				if (want === '') {
					setSelected('');
					setDraft(null);
					setSource('');
					setDrawn('');
					setBrief('');
					setBaseRevision('');
					setSourceEdited(false);
					setDirty(false);
					return;
				}
				setSelected(want);
				const one = await call('chart', { query: { session: sessionId, id: want } });
				if (!one.ok) {
					setBanner({ kind: 'error', text: one.message });
					return;
				}
				setDraft({ id: one.chart.id, name: one.chart.name, scope: one.chart.scope });
				setSource(one.source ?? '');
				setDrawn(one.drawn ?? '');
				setBrief(one.chart.brief ?? '');
				setBaseRevision(one.revision);
				setSourceEdited(false);
				setDirty(false);
			}, [sessionId]);

			React.useEffect(() => { void load(); }, [load]);

			/** Mark the editor dirty; every mutator goes through this. */
			const touch = () => {
				setDirty(true);
				setBanner(null);
			};

			/**
			 * Replace one field of the loaded chart.
			 * @param {string} key - the field.
			 * @param {unknown} value - the new value.
			 */
			const setField = (key, value) => {
				setDraft((current) => (current === null ? current : { ...current, [key]: value }));
				touch();
			};

			// 没改过源码就用宿主画好的那份，改了就直接画源码。
			const text = sourceEdited || drawn === '' ? source : drawn;
			const shown = mode ?? (narrow ? 'source' : 'preview');

			// 源码视图里也照画：写错一行时红字要和那段源码在同一屏。
			// 每敲一个字画一次会把手速变成卡顿，攒 200ms 再画；重新排期时上一轮作废。
			const renderId = React.useRef(0);
			React.useEffect(() => {
				if (text.trim() === '') {
					setSvg('');
					setRenderError('');
					return undefined;
				}
				let live = true;
				const timer = window.setTimeout(() => {
					void (async () => {
						try {
							const mermaid = await loadMermaid();
							if (!live) return;
							// 主题是全局配置，每次画之前重新 initialize 一次。
							mermaid.initialize({
								startOnLoad: false,
								securityLevel: 'strict',
								htmlLabels: true,
								suppressErrorRendering: true,
								theme: dark ? 'dark' : 'default',
							});
							renderId.current += 1;
							const result = await mermaid.render(`spec-flow-${renderId.current}`, text);
							if (!live) return;
							setSvg(typeof result === 'string' ? result : String(result?.svg ?? ''));
							setRenderError('');
						} catch (error) {
							if (!live) return;
							// 报错原文照显示：用户看得见哪一行，才改得对。
							setSvg('');
							setRenderError(error?.code === 'mermaid-load' ? t('mermaidFailed') : String(error?.message ?? error));
						}
					})();
				}, 200);
				return () => {
					live = false;
					window.clearTimeout(timer);
				};
			}, [text, dark, t]);

			/** Save the four edited fields, guarded by the revision that was loaded. */
			const save = React.useCallback(async () => {
				if (draft === null || busy) return;
				setBusy(true);
				setBanner(null);
				try {
					const answer = await call('save', {
						query: { session: sessionId },
						body: { chart: { id: draft.id, name: draft.name, scope: draft.scope, source, brief }, revision: baseRevision },
					});
					if (answer.ok) {
						setBanner({ kind: 'saved' });
						setBaseRevision(answer.revision);
						setDirty(false);
						setSourceEdited(false);
						await load(draft.id);
						// The write succeeded, but the collection may still carry warnings —
						// a chart that no longer points anywhere, say. The Host's words, again.
						if ((answer.warnings ?? []).length > 0) setBanner({ kind: 'warn', text: answer.warnings.join('\n') });
					} else if (answer.code === 'conflict') {
						setBanner({ kind: 'conflict', text: t('conflict') });
					} else {
						setBanner({ kind: 'error', text: (answer.errors ?? [answer.message]).join('\n') });
					}
				} catch (error) {
					setBanner({ kind: 'error', text: String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			}, [draft, source, brief, baseRevision, busy, sessionId, t, load]);

			// Ctrl/Cmd+S is the gesture the page advertises; the browser's own
			// save-page dialog must not win when the page owns a document that is
			// meant to be saved this way.
			React.useEffect(() => {
				const onKey = (event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
						event.preventDefault();
						void save();
					}
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [save]);

			/**
			 * Create one chart and open it.
			 * @param {{ id: string, name: string, scope: string }} fields - the new chart.
			 */
			const create = async (fields) => {
				const answer = await call('create', { query: { session: sessionId }, body: fields });
				if (!answer.ok) {
					setBanner({ kind: 'error', text: (answer.errors ?? [answer.message]).join('\n') });
					return;
				}
				setCreating(false);
				await load(answer.id);
			};

			const remove = async () => {
				if (draft === null) return;
				const answer = await call('delete', { query: { session: sessionId }, body: { id: draft.id } });
				if (!answer.ok) {
					setBanner({ kind: 'error', text: (answer.errors ?? [answer.message]).join('\n') });
					return;
				}
				setBanner({ kind: 'saved' });
				setSelected('');
				setDraft(null);
				await load();
			};

			if (state.phase === 'loading') return h('div', { style: { padding: 24 } }, t('loading'));
			if (state.phase === 'failed') return h('div', { style: { padding: 24, color: 'var(--dsw-alias-state-error-primary)' } }, state.error);

			return h('div', { ref: pageRef, style: narrow ? { ...styles.page, flexDirection: 'column' } : styles.page },
				h('div', { style: narrow ? styles.stackedSide : styles.side },
					h('div', { style: styles.sideTitle }, t('title')),
					state.charts.length === 0
						? h('div', { style: { ...styles.hint, padding: '0 8px' } }, t('empty'))
						: state.charts.map((chart) => h('div', { key: chart.id },
							h('button', {
								type: 'button',
								style: styles.item(chart.id === selected),
								onClick: () => { setBanner(null); void load(chart.id); },
							},
							h('span', { style: styles.itemName }, chart.name || chart.id),
							h('span', { style: styles.itemMeta }, chart.scope || chart.id),
							chart.parents.length > 0 ? h('span', { style: styles.itemMeta }, `${t('parents')}：${chart.parents.join('、')}`) : null,
							chart.modules.length > 0 ? h('span', { style: styles.itemMeta }, `→ ${chart.modules.join('、')}`) : null,
						))),
					state.problems.length > 0 ? h('div', { style: { ...styles.hint, padding: '8px' } }, `${t('problems')}：${state.problems.join('；')}`) : null,
					h('div', { style: { padding: '8px' } },
						h('button', { type: 'button', style: styles.button, onClick: () => setCreating(true) }, t('create')),
					),
				),
				h('div', { style: styles.main },
					h('div', { style: styles.bar },
						draft === null
							? h('span', { style: { ...styles.sectionTitle, margin: 0 } }, t('title'))
							: h('div', { style: { ...styles.row, flex: 1, marginBottom: 0 } },
								h('input', {
									style: styles.barInput,
									value: draft.name,
									placeholder: t('name'),
									'aria-label': t('name'),
									onChange: (event) => setField('name', event.target.value),
								}),
								h('input', {
									style: styles.barInput,
									value: draft.scope,
									placeholder: t('scope'),
									'aria-label': t('scope'),
									onChange: (event) => setField('scope', event.target.value),
								}),
							),
						h('span', { style: styles.spacer }),
						h('button', {
							type: 'button',
							style: styles.button,
							disabled: draft === null,
							onClick: () => setMode(shown === 'preview' ? 'source' : 'preview'),
						}, shown === 'preview' ? t('source') : t('preview')),
						h('button', { type: 'button', style: styles.button, disabled: busy || draft === null, onClick: () => { if (window.confirm(t('removeConfirm'))) void remove(); } }, t('remove')),
					),
					h('div', { style: narrow ? styles.stackedBody : styles.body },
						h('div', { style: narrow ? styles.stackedCanvas : styles.canvas },
							banner?.kind === 'error' ? h('div', { style: styles.error }, banner.text) : null,
							draft === null
								? h('div', { style: styles.hint }, t('noSelection'))
								: shown === 'source'
									? h('textarea', {
										style: styles.source,
										value: source,
										spellCheck: false,
										'aria-label': t('source'),
										onChange: (event) => {
											setSource(event.target.value);
											setSourceEdited(true);
											touch();
										},
									})
									: svg === ''
										? h('div', { style: styles.previewEmpty }, renderError === '' && text.trim() !== '' ? t('loading') : '')
										: h('div', {
											'data-spec-preview': '',
											style: styles.preview,
											dangerouslySetInnerHTML: { __html: svg },
										}),
							// 渲染失败的红字贴着预览放，因为要改的是上面那段源码。
							renderError === '' ? null : h('div', { style: { ...styles.error, marginTop: 8, marginBottom: 0 } }, `${t('renderFailed')}：${renderError}`),
							draft === null ? null : h('div', { style: { ...styles.hint, marginTop: 8, marginBottom: 0 } }, `${t('sourceHint')} ${t('keyboard')}`),
						),
						h('div', { style: narrow ? styles.stackedBrief : styles.brief },
							draft === null ? null : h('div', { style: styles.paneCol },
								h('div', { style: { ...styles.sectionTitle, margin: '0 0 6px' } }, t('brief')),
								brief.trim() === '' ? h('div', { style: styles.hint }, t('noBrief')) : null,
								h('div', { style: styles.hint }, t('briefHint')),
								h('textarea', {
									style: styles.briefArea,
									value: brief,
									'aria-label': t('brief'),
									onChange: (event) => { setBrief(event.target.value); touch(); },
								}),
								h('div', { style: { ...styles.row, marginBottom: 0 } },
									h('button', { type: 'button', style: styles.primary, disabled: busy || draft === null, onClick: () => { void save(); } }, busy ? t('saving') : `${t('save')} (Ctrl/Cmd+S)`),
									h('span', { style: styles.badge }, dirty ? t('dirty') : t('saved')),
									banner?.kind === 'conflict'
										? h('button', { type: 'button', style: styles.button, onClick: () => { setBanner(null); void load(draft.id); } }, t('reload'))
										: null,
								),
								banner?.kind === 'conflict' ? h('div', { style: styles.warn }, banner.text) : null,
								banner?.kind === 'warn' ? h('div', { style: styles.warn }, banner.text) : null,
							),
						),
					),
				),
				creating
					? h(NewChartDialog, { t, onCancel: () => setCreating(false), onCreate: create })
					: null,
			);
		}

		/**
		 * The "new chart" dialog. Kept in the page rather than a portal: it is one
		 * short form, and a portal would need its own focus handling to match.
		 * @param {object} props - t, onCancel, onCreate.
		 * @returns {object} the element.
		 */
		function NewChartDialog({ t, onCancel, onCreate }) {
			const [id, setId] = React.useState('');
			const [name, setName] = React.useState('');
			const [scope, setScope] = React.useState('');
			return h('div', {
				role: 'dialog',
				'aria-modal': true,
				style: {
					position: 'fixed',
					inset: 0,
					background: 'rgba(0,0,0,0.35)',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					zIndex: 60,
				},
			},
			h('div', {
				style: {
					width: 380,
					background: 'var(--dsw-alias-bg-overlay)',
					color: 'var(--dsw-alias-label-primary)',
					border: '1px solid var(--dsw-alias-border-l2)',
					borderRadius: 12,
					padding: 16,
				},
			},
			h('div', { style: { ...styles.sectionTitle, fontSize: 14 } }, t('createTitle')),
			h(Field, { label: t('id'), value: id, onChange: setId, placeholder: 'checkout' }),
			h(Field, { label: t('name'), value: name, onChange: setName, placeholder: t('name') }),
			h(Field, { label: t('scope'), value: scope, onChange: setScope, placeholder: t('scope') }),
			h('div', { style: { ...styles.row, justifyContent: 'flex-end' } },
				h('button', { type: 'button', style: styles.button, onClick: onCancel }, t('cancel')),
				h('button', {
					type: 'button',
					style: styles.primary,
					onClick: () => onCreate({ id, name, scope }),
				}, t('ok')),
			)),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const t = ctx.locale.bind(SPEC_FLOWS_NS);
				ctx.effect(() => ctx.locale.register(SPEC_FLOWS_NS, { zh, en }), 'spec-mode: chart view dictionary');
				ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
					name: 'conversation.view',
					id: SPEC_FLOWS_CHART_ID,
					order: 20,
					locale: SPEC_FLOWS_NS,
					label: () => t('view'),
				}, (props) => h(FlowsView, { ...props, t }))), 'spec-mode: chart view');
			},
		};
	},
});
})();
