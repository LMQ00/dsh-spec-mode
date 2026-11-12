/**
 * The "流程图" conversation view: one page that lists the chart collection, shows
 * the selected chart beside its own requirement brief, and edits the model.
 *
 * The page is a viewer with a form, not a drawing canvas. Every box's position is
 * derived — a row per layer, a column per declaration order — so dragging a box
 * would either be ignored at the next draw or produce a picture whose geometry
 * contradicts its arrows. What a person actually wants ("this box belongs one row
 * lower", "this condition belongs on that arrow") is expressed by editing the
 * graph, which is what the controls do.
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
			discard: '丢弃我的修改',
			save: '保存',
			create: '新建图',
			createTitle: '新建一张图',
			remove: '删除',
			removeConfirm: '删掉这张图？被别的图引用时会被拒绝。',
			id: '编号（文件名，不再改）',
			name: '显示名',
			scope: '作用范围',
			kind: '类型',
			overview: '总览',
			module: '模块',
			ports: '端口（一行一条）',
			label: '框里的话',
			when: '条件',
			addNode: '加一个框',
			addEdge: '加一条连线',
			needBothEnds: '先选好两头：从哪个框、到哪个框。',
			noSelfEdge: '一个框不能连向自己。',
			edgeExists: '这两个框之间已经有这条线了。',
			fromBox: '从',
			toBox: '到',
			addModule: '加一个模块框',
			removeNode: '删掉这个框',
			removeEdge: '删掉这条线',
			up: '上移',
			down: '下移',
			nodes: '框',
			edges: '连线',
			brief: '需求简报',
			enter: '进入',
			back: '返回总览',
			problems: '读不出来的文件',
			parents: '被引用',
			noSelection: '左边选一张图。',
			error: '出错了',
			readonly: '访谈进行中：图仍可改，保存会比对盘上版本。',
			moduleNode: '这是一个模块框，字取自被引用图的名字',
			step: '步骤',
			add: '加',
			cancel: '取消',
			ok: '确定',
			deleteBlocked: '删不掉',
			axis: '显示全部图',
			briefHint: '四节：目标 / 要做什么 / 验收 / 约束。人可以随便写，模型写的会被校验。',
			keyboard: 'Ctrl/Cmd+S 保存',
			canvasHint: '点框或连线选中它，右边就出现它的属性；把框拖到同一行的另一个位置可以改顺序；从框右侧的圆点拖到另一个框，就多一条线。',
			selected: '已选中',
			nothing: '没选中任何东西',
			fixErrors: '先改这几处才能保存',
			autoWrapped: '一行放得下的框会换到下一行继续排，画布不必左右滚',
			connect: '拖到另一个框上连一条线',
			connectHint: '从框右侧的圆点拖到另一个框上，就连出一条线',
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
			discard: 'Discard my changes',
			save: 'Save',
			create: 'New chart',
			createTitle: 'New chart',
			remove: 'Delete',
			removeConfirm: 'Delete this chart? A chart something points at is refused.',
			id: 'Id (file name, never renamed)',
			name: 'Display name',
			scope: 'Scope',
			kind: 'Kind',
			overview: 'Overview',
			module: 'Module',
			ports: 'Ports (one per line)',
			label: 'Box text',
			when: 'Condition',
			addNode: 'Add box',
			addEdge: 'Add arrow',
			needBothEnds: 'Pick both ends: from which box, to which box.',
			noSelfEdge: 'A box cannot point at itself.',
			edgeExists: 'These two boxes are already connected.',
			fromBox: 'From',
			toBox: 'To',
			addModule: 'Add module box',
			removeNode: 'Remove box',
			removeEdge: 'Remove arrow',
			up: 'Up',
			down: 'Down',
			nodes: 'Boxes',
			edges: 'Arrows',
			brief: 'Requirement brief',
			enter: 'Open',
			back: 'Back to overview',
			problems: 'Unreadable files',
			parents: 'Referenced by',
			noSelection: 'Pick a chart on the left.',
			error: 'Failed',
			readonly: 'Interview running: charts stay editable, and saving compares against disk.',
			moduleNode: 'A module box takes its words from the chart it points at',
			step: 'Step',
			add: 'Add',
			cancel: 'Cancel',
			ok: 'OK',
			deleteBlocked: 'Cannot delete',
			axis: 'Show every chart',
			briefHint: 'Four sections: goal / what to build / acceptance / constraints. A person may write freely; a model’s brief is validated.',
			keyboard: 'Ctrl/Cmd+S saves',
			canvasHint: 'Click a box or an arrow to select it; its properties appear on the right. Drag a box sideways within its row to reorder it, or pull an arrow from the dot on its right edge to another box.',
			selected: 'Selected',
			nothing: 'Nothing selected',
			fixErrors: 'Fix these before saving',
			autoWrapped: 'Boxes that do not fit one row continue on the next, so the picture never needs sideways scrolling',
			connect: 'Drop on another box to connect',
			connectHint: 'Drag from the dot on a box to another box to draw an arrow',
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

		/**
		 * Below this many pixels of page width the three panes stack instead of
		 * sharing one row. 720px is what the picture, the brief and the list need
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
			// Below `NARROW` the page stacks — list on top, picture above its brief —
			// instead of running its toolbar and forms off the right edge.
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
				// width, where the title, the status badge and two buttons no longer
				// fit on one line. They wrap instead of being pushed off the pane.
				flexWrap: 'wrap',
				rowGap: 6,
			},
			barTitle: { fontSize: 14, fontWeight: 600 },
			barMeta: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			spacer: { flex: 1 },
			body: { flex: 1, minHeight: 0, display: 'flex' },
			stackedBody: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
			canvas: { flex: '1 1 58%', minWidth: 0, overflow: 'auto', padding: 14, background: 'var(--dsw-alias-bg-base)' },
			stackedCanvas: { flex: '1 1 60%', minHeight: 0, minWidth: 0, overflow: 'auto', padding: 14, background: 'var(--dsw-alias-bg-base)' },
			svgBox: {
				background: '#fff',
				borderRadius: 10,
				border: '1px solid var(--dsw-alias-border-l1)',
				padding: 6,
				display: 'block',
				width: '100%',
				boxSizing: 'border-box',
				// Dragging a box would otherwise drag a text selection over the
				// picture, which turns every reorder into a blue smear.
				userSelect: 'none',
				touchAction: 'none',
				// A box dragged past the picture's edge is still being dragged: clipping
				// it mid-gesture hides the very feedback the reader is looking at.
				overflow: 'visible',
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
			field: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 10 },
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
			textarea: {
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
				minHeight: 72,
				resize: 'vertical',
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
			row: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 },
			rowCard: {
				border: '1px solid var(--dsw-alias-border-l1)',
				borderRadius: 8,
				padding: 8,
				marginBottom: 6,
				background: 'var(--dsw-alias-bg-base)',
			},
			nodeRow: { display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 6 },
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
			briefText: {
				whiteSpace: 'pre-wrap',
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: 12,
				lineHeight: 1.6,
				margin: 0,
			},
		};

		/**
		 * One labelled input.
		 * @param {object} props - label, value, onChange, textarea, placeholder, disabled.
		 * @returns {object} the element.
		 */
		function Field({ label, value, onChange, textarea = false, placeholder, disabled = false }) {
			const id = React.useId();
			return h('div', null,
				h('label', { htmlFor: id, style: styles.label }, label),
				textarea
					? h('textarea', {
						id,
						value,
						placeholder,
						disabled,
						onChange: (event) => onChange(event.target.value),
						style: { ...styles.textarea, opacity: disabled ? 0.6 : 1 },
					})
					: h('input', {
						id,
						value,
						placeholder,
						disabled,
						onChange: (event) => onChange(event.target.value),
						style: { ...styles.input, opacity: disabled ? 0.6 : 1 },
					}));
		}

		/**
		 * Add the one thing the picture cannot carry from the renderer: what a click
		 * on it does.
		 *
		 * The SVG is a product first — the same document is written to disk as the
		 * chart — so the interaction chrome is added here, in the view, instead of
		 * being baked into the file. Cursor feedback and the selection outline are
		 * CSS inside the document, because a per-element inline style would have to
		 * be rewritten on every selection and the markup would grow with the chart.
		 *
		 * @param {string} svg - the rendered document.
		 * @param {(key: string) => string} t - the translator.
		 * @returns {string} the document with the interaction styles.
		 */
		function decorateSvg(svg, t) {
			// `max-width:100%` is what removes the sideways scroll: the document keeps
			// its natural size for the file on disk, and the view scales it down to the
			// column it is read in. `height:auto` keeps that scale uniform.
			const style = '<style>'
				+ 'svg{max-width:100%;height:auto;display:block}'
				+ '[data-node]{cursor:pointer}'
				+ '[data-edge]{cursor:pointer}'
				+ '[data-node]:hover rect:first-of-type{stroke:var(--dsw-alias-brand-primary);stroke-width:1.6}'
				+ '[data-node][data-selected="true"] rect:first-of-type{stroke:var(--dsw-alias-brand-primary);stroke-width:2}'
				+ '[data-edge][data-selected="true"]{stroke:var(--dsw-alias-brand-primary);stroke-width:2.2}'
				+ '</style>';
			const clean = svg.replace(/^<\?xml[^>]*>\s*/, '');
			const cut = clean.indexOf('>');
			return cut === -1 ? clean : `${clean.slice(0, cut + 1)}${style}${clean.slice(cut + 1)}`;
		}

		/**
		 * The `viewBox` of a rendered document, so an overlay can share its frame.
		 * @param {string} svg - the rendered document.
		 * @returns {string} the viewBox, or a square fallback.
		 */
		function viewBoxOf(svg) {
			const found = /viewBox="([^"]+)"/.exec(svg);
			return found === null ? '0 0 100 100' : found[1];
		}

		/**
		 * The pair of selects that adds an arrow. Two ends are chosen explicitly
		 * instead of guessed, so the button always has something to do.
		 * @param {object} props - t, nodes, onAdd.
		 * @returns {object} the element.
		 */
		function NewEdge({ t, nodes, onAdd }) {
			const [from, setFrom] = React.useState('');
			const [to, setTo] = React.useState('');
			const options = nodes.map((node) => h('option', { key: node.id, value: node.id }, node.id));
			return h('div', { style: styles.row },
				h('select', { style: styles.button, value: from, onChange: (event) => setFrom(event.target.value), 'aria-label': t('fromBox') },
					h('option', { value: '' }, `${t('fromBox')}…`),
					options,
				),
				h('select', { style: styles.button, value: to, onChange: (event) => setTo(event.target.value), 'aria-label': t('toBox') },
					h('option', { value: '' }, `${t('toBox')}…`),
					options,
				),
				h('button', {
					type: 'button',
					style: styles.button,
					onClick: () => onAdd(from, to),
				}, t('addEdge')),
			);
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
			const [draft, setDraft] = React.useState(null);
			const [brief, setBrief] = React.useState('');
			const [baseRevision, setBaseRevision] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [banner, setBanner] = React.useState(null);
			const [creating, setCreating] = React.useState(false);
			const [svg, setSvg] = React.useState('');
			// What the picture has selected: `{ kind: 'node', id }` or
			// `{ kind: 'edge', from, to }`. Selecting on the picture is what makes it
			// a diagram rather than an illustration — the form on the right follows
			// this, so there is one place a thing is described.
			const [selection, setSelection] = React.useState(null);
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
					+ 'html[data-spec-flows-view] [data-width-handle]{display:none}';
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
			// The connect gesture: pressing a box's handle and releasing on another
			// box. Kept in a ref because it changes on every mousemove and nothing
			// else renders from it.
			const connectRef = React.useRef({ from: '', to: '', over: '' });
			// The box being dragged sideways, with the pointer x it was last measured
			// at. Null while no drag is running.
			const dragRef = React.useRef(null);
			// The line drawn under the pointer while an arrow is being pulled out of a
			// box. In picture coordinates; null when no such gesture is running.
			const [ghost, setGhost] = React.useState(null);
			// Where a dragged box will land, in viewport coordinates: a thin marker is
			// cheaper to draw and easier to read than the box snapping around.
			const [dropHint, setDropHint] = React.useState(null);
			// Whether the editor differs from what was loaded. Tracked as a flag set by
			// every edit and cleared by a save or a reload, because comparing the whole
			// model on every keystroke would need a deep copy of what was loaded.
			const [dirty, setDirty] = React.useState(false);

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
					setSvg('');
					return;
				}
				setSelected(want);
				const one = await call('chart', { query: { session: sessionId, id: want } });
				if (!one.ok) {
					setBanner({ kind: 'error', text: one.message });
					return;
				}
				setDraft(one.chart);
				setBrief(one.brief ?? '');
				setBaseRevision(one.revision);
				setSvg(one.svg ?? '');
				setDirty(false);
			}, [sessionId]);

			React.useEffect(() => { void load(); }, [load]);

			// The selection is applied to the drawn document AFTER it is inserted, and
			// never by changing the HTML string. That is not a micro-optimisation: a
			// changed string makes React replace the whole `<svg>`, which throws away
			// the box group a drag is holding, so the gesture moves a detached node and
			// the picture appears not to move at all.
			const pictureRef = React.useRef(null);
			React.useEffect(() => {
				const root = pictureRef.current;
				if (root === null) return;
				for (const node of root.querySelectorAll('[data-selected]')) node.removeAttribute('data-selected');
				if (selection === null) return;
				const target = selection.kind === 'node'
					? root.querySelector(`[data-node="${selection.id}"]`)
					: root.querySelector(`[data-edge="${selection.from}-&gt;${selection.to}"]`);
				target?.setAttribute('data-selected', 'true');
			}, [svg, selection]);

			/** Mark the editor dirty; every mutator goes through this. */
			const touch = () => {
				setDirty(true);
				setBanner(null);
			};

			/**
			 * Replace one field of the loaded model.
			 * @param {string} key - the field.
			 * @param {unknown} value - the new value.
			 */
			const setField = (key, value) => {
				setDraft((current) => (current === null ? current : { ...current, [key]: value }));
				touch();
			};

			/**
			 * Replace one node.
			 * @param {number} index - the node index.
			 * @param {object} next - the new node.
			 */
			const setNode = (index, next) => {
				setDraft((current) => {
					if (current === null) return current;
					const nodes = current.nodes.map((node, at) => (at === index ? next : node));
					return { ...current, nodes };
				});
				touch();
			};

			/**
			 * Replace one edge.
			 * @param {number} index - the edge index.
			 * @param {object} next - the new edge.
			 */
			const setEdge = (index, next) => {
				setDraft((current) => {
					if (current === null) return current;
					const edges = current.edges.map((edge, at) => (at === index ? next : edge));
					return { ...current, edges };
				});
				touch();
			};

			/**
			 * Move one node within its row.
			 * @param {number} index - the node index.
			 * @param {number} delta - -1 up, +1 down.
			 */
			const reorder = (index, delta) => {
				setDraft((current) => {
					if (current === null) return current;
					const at = index + delta;
					if (at < 0 || at >= current.nodes.length) return current;
					const nodes = [...current.nodes];
					[nodes[index], nodes[at]] = [nodes[at], nodes[index]];
					return { ...current, nodes };
				});
				touch();
			};

			/** Add a step box after the selected node. */
			const addNode = () => {
				setDraft((current) => {
					if (current === null) return current;
					const used = new Set(current.nodes.map((node) => node.id));
					let index = current.nodes.length + 1;
					while (used.has(`n${index}`)) index += 1;
					return { ...current, nodes: [...current.nodes, { id: `n${index}`, label: t('step') }] };
				});
				touch();
			};

			/**
			 * Add a module box pointing at another chart.
			 * @param {string} moduleId - the chart id.
			 */
			const addModule = (moduleId) => {
				setDraft((current) => {
					if (current === null) return current;
					const used = new Set(current.nodes.map((node) => node.id));
					let index = current.nodes.length + 1;
					while (used.has(`m${index}`)) index += 1;
					return { ...current, nodes: [...current.nodes, { id: `m${index}`, module: moduleId, ports: ['入：'] }] };
				});
				touch();
			};

			/** Add an arrow between the first two boxes when there is room. */
			/**
			 * Add an arrow between two boxes the author picks.
			 *
			 * The old version guessed the first two boxes, so a chart that already had
			 * that pair — or fewer than two boxes — did nothing at all, with no message.
			 * A button that silently does nothing is worse than no button: the reader
			 * cannot tell "already there" from "broken". The picker makes the pair an
			 * explicit choice and the banner says why nothing happened.
			 */
			const addEdge = (from, to) => {
				if (from === '' || to === '') {
					setBanner({ kind: 'error', text: t('needBothEnds') });
					return;
				}
				if (from === to) {
					setBanner({ kind: 'error', text: t('noSelfEdge') });
					return;
				}
				if (draft !== null && draft.edges.some((edge) => edge.from === from && edge.to === to)) {
					setBanner({ kind: 'error', text: t('edgeExists') });
					return;
				}
				setDraft((current) => {
					if (current === null) return current;
					return { ...current, edges: [...current.edges, { from, to }] };
				});
				touch();
			};

			/** Save the loaded model plus the edited brief. */
			const save = React.useCallback(async () => {
				if (draft === null || busy) return;
				setBusy(true);
				setBanner(null);
				try {
					const answer = await call('save', {
						query: { session: sessionId },
						body: { chart: draft, revision: baseRevision, brief },
					});
					if (answer.ok) {
						setBanner({ kind: 'saved' });
						setDirty(false);
						setBaseRevision(answer.revision);
						await load(draft.id);
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
			}, [draft, brief, baseRevision, busy, sessionId, t]);

			/**
			 * Everything a click on the picture can mean, resolved from the DOM node
			 * it landed on. The SVG carries `data-node` / `data-edge` / `data-handle`,
			 * so the picture itself says what was hit — no coordinate math, and no
			 * guessing from geometry.
			 * @param {EventTarget | null} target - the event target.
			 * @returns {{ kind: 'node', id: string } | { kind: 'edge', from: string, to: string } | { kind: 'handle', id: string } | null} the hit.
			 */
			const hitOf = (target) => {
				if (target === null || typeof (/** @type {any} */ (target).closest) !== 'function') return null;
				const element = /** @type {any} */ (target);
				// The handle is checked first: it sits inside the box group, so a
				// box-first lookup would report a plain click and the connect gesture
				// would never start.
				const handle = element.closest('[data-handle]');
				if (handle !== null) return { kind: 'handle', id: handle.getAttribute('data-handle') };
				const group = element.closest('[data-node]');
				if (group !== null) return { kind: 'node', id: group.getAttribute('data-node'), row: group.getAttribute('data-row') ?? '' };
				const path = element.closest('[data-edge]');
				if (path !== null) return { kind: 'edge', from: path.getAttribute('data-from'), to: path.getAttribute('data-to') };
				return null;
			};

			/**
			 * A pointer position in the picture's own coordinate system.
			 *
			 * The document is drawn at its natural size and then scaled by CSS to fit
			 * the pane, so `clientX` is not a coordinate in the drawing. The scale is
			 * read from the live `viewBox` ratio instead of assumed to be 1: at any
			 * other zoom the ghost line would trail away from the cursor.
			 *
			 * @param {{ clientX: number, clientY: number }} event - the pointer event.
			 * @param {Element | null} scope - an element inside the picture.
			 * @returns {{ x: number, y: number } | null} the position, or null when the
			 *   element is not inside a drawn document.
			 */
			const pointIn = (event, scope) => {
				const svg = scope?.closest?.('svg') ?? null;
				if (svg === null) return null;
				const rect = svg.getBoundingClientRect();
				const box = svg.viewBox.baseVal;
				if (rect.width === 0 || rect.height === 0 || box.width === 0) return null;
				return {
					x: ((event.clientX - rect.left) / rect.width) * box.width,
					y: ((event.clientY - rect.top) / rect.height) * box.height,
				};
			};

			/**
			 * Drag one box sideways within the row it sits in.
			 *
			 * Only sideways, and only within the same visual row, because that is the
			 * only movement the model has a field for: the row comes from the layer
			 * (which the arrows decide) and the column comes from `nodes` order. A drag
			 * across rows would be undone by the next render, which is worse than not
			 * offering it — the form's 「加一条连线」 is how a box changes rows.
			 *
			 * The sibling list is measured from the picture, not assumed from the model
			 * order: after wrapping, one layer occupies several rows, and the boxes it
			 * shares a row with are read from `data-row`.
			 *
			 * @param {{ id: string, row: string, startX: number, siblings: string[] }} source - what was pressed.
			 * @param {number} clientX - where the pointer is now.
			 */
			/**
			 * Where a dragged box would land, from where the pointer is.
			 *
			 * The pointer is compared against the midpoint of every sibling box in the
			 * row, in drawn order: a box that has been passed by half its width hands
			 * its place over. That is the rule every list the reader has ever dragged
			 * follows, and it is why the gesture can be evaluated without moving the
			 * boxes — the picture is derived, so it must not be the thing being edited.
			 *
			 * @param {{ id: string, row: string }} source - the box being dragged.
			 * @param {number} clientX - the pointer.
			 * @param {Element} scope - the picture's root.
			 * @returns {{ seat: number, at: { x: number, y: number, height: number } } | null} the
			 *   desired seat and the place to draw the insertion marker, or null while
			 *   the pointer is still over its own slot.
			 */
			const dropTarget = (source, clientX, scope) => {
				const siblings = [...scope.querySelectorAll('[data-node]')]
					.filter((node) => node.getAttribute('data-row') === source.row);
				// The marker is drawn inside the picture's box, so its place must be in
				// that box's coordinates -- `getBoundingClientRect` answers in viewport
				// ones, and using them directly put the marker a pane-width away.
				const origin = scope.getBoundingClientRect();
				const boxes = siblings.map((node) => {
					const rect = node.getBoundingClientRect();
					return {
						id: node.getAttribute('data-node'),
						left: rect.left - origin.left,
						top: rect.top - origin.top,
						width: rect.width,
						height: rect.height,
					};
				});
				if (boxes.length === 0) return null;
				let seat = 0;
				let here = 0;
				boxes.forEach((box, index) => {
					if (box.id === source.id) {
						here = index;
						return;
					}
					if (clientX > box.left + origin.left + box.width / 2) seat += 1;
				});
				// Dropping past the last box means landing at the end, which is where the
				// marker goes too; the marker sits on the near edge of that slot.
				const marker = boxes[Math.min(seat, boxes.length - 1)];
				const after = seat >= boxes.length - 1 && seat !== here;
				return {
					seat,
					here,
					at: { x: marker.left + (after ? marker.width : 0), y: marker.top, height: marker.height },
				};
			};

			/**
			 * Drag one box sideways within the row it sits in.
			 *
			 * The box follows the pointer and a marker shows where it will land; the
			 * model is only reordered once, on release. Reordering on every mousemove
			 * would send a preview draw per pixel — the picture lags a third of a second
			 * behind the hand, which is what "does not behave like a diagram" feels like.
			 *
			 * Sideways only, and only within one visual row, because that is the only
			 * movement the model has a field for: the row comes from the arrows, the
			 * column from `nodes` order. A drag across rows would be undone by the next
			 * render, which is worse than not offering it — 加一条连线 is how a box
			 * changes rows.
			 *
			 * @param {{ id: string, row: string, startX: number, group: Element, moved: boolean }} source - what was pressed.
			 * @param {number} clientX - where the pointer is now.
			 * @param {Element} scope - the picture's root.
			 */
			const dragWithinRow = (source, clientX, scope) => {
				if (draft === null) return;
				const dx = clientX - source.startX;
				// A few pixels of slop, so a click with a shaky hand is still a click.
				if (!source.moved && Math.abs(dx) < 4) return;
				source.moved = true;
				// The box itself moves, not a copy: the pointer holds the thing it
				// grabbed. `translate` on the group is enough and costs no re-render.
				source.group.style.transform = `translateX(${dx}px)`;
				source.group.style.opacity = '0.75';
				const target = dropTarget(source, clientX, scope);
				setDropHint(target === null || target.here === target.seat ? null : { at: target.at });
				source.seat = target === null ? source.seat : target.seat;
			};

			/**
			 * Commit the reorder a drag decided, once the pointer is released.
			 *
			 * The seat is a position among the boxes DRAWN in that row, which is not the
			 * position in `nodes`: a row is a slice of the flat list, so the seat is
			 * translated to the node that currently occupies it and the dragged node is
			 * moved in front of that one.
			 *
			 * @param {{ id: string, row: string, seat: number, moved: boolean }} source - the drag.
			 * @param {Element} scope - the picture's root.
			 */
			const dropWithinRow = (source, scope) => {
				if (!source.moved || draft === null) return;
				const siblings = [...scope.querySelectorAll('[data-node]')]
					.filter((node) => node.getAttribute('data-row') === source.row)
					.map((node) => node.getAttribute('data-node'));
				const wanted = Math.max(0, Math.min(siblings.length - 1, source.seat));
				const neighbour = siblings[wanted];
				if (neighbour === undefined || neighbour === source.id) return;
				setDraft((current) => {
					if (current === null) return current;
					const nodes = [...current.nodes];
					const at = nodes.findIndex((node) => node.id === source.id);
					const target = nodes.findIndex((node) => node.id === neighbour);
					if (at === -1 || target === -1) return current;
					const [moved] = nodes.splice(at, 1);
					// Dropping to the right of the neighbour means landing after it.
					nodes.splice(source.seat > siblings.indexOf(source.id) ? target + 1 : target, 0, moved);
					return { ...current, nodes };
				});
				touch();
			};

			// The picture follows the editor. Every edit schedules one preview draw; the
			// timer collapses a burst of keystrokes into one render, and a stale reply
			// is dropped by comparing the sequence number, so a slow draw can never
			// overwrite a newer one.
			const previewSeq = React.useRef(0);
			const previewTimer = React.useRef(0);
			const schedulePreview = React.useCallback((chart) => {
				if (chart === null) return;
				previewSeq.current += 1;
				const seq = previewSeq.current;
				window.clearTimeout(previewTimer.current);
				previewTimer.current = window.setTimeout(async () => {
					const answer = await call('preview', { query: { session: sessionId }, body: { chart } });
					if (seq !== previewSeq.current) return;
					if (answer.ok) setSvg(answer.svg);
				}, 180);
			}, [sessionId]);

			/** Add an arrow, or update it when the pair already exists. */
			const connect = (from, to) => {
				if (from === to || from === '' || to === '') return;
				setDraft((current) => {
					if (current === null) return current;
					if (current.edges.some((edge) => edge.from === from && edge.to === to)) return current;
					return { ...current, edges: [...current.edges, { from, to }] };
				});
				touch();
			};

			React.useEffect(() => {
				if (draft === null) return;
				schedulePreview(draft);
			}, [draft, schedulePreview]);

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

			const others = state.charts.filter((chart) => draft === null || chart.id !== draft.id);

			return h('div', { ref: pageRef, style: narrow ? { ...styles.page, flexDirection: 'column' } : styles.page },
				h('div', { style: narrow ? styles.stackedSide : styles.side },
					h('div', { style: styles.sideTitle }, t('title')),
					state.charts.length === 0
						? h('div', { style: { ...styles.hint, padding: '0 8px' } }, t('empty'))
						: state.charts.map((chart) => h('div', { key: chart.id },
							h('button', {
								type: 'button',
								style: styles.item(chart.id === selected),
								onClick: () => { void load(chart.id); },
							},
							h('span', { style: styles.itemName },
								h('span', null, chart.name || chart.id),
								h('span', { style: styles.badge }, chart.kind === 'overview' ? t('overview') : t('module')),
							),
							h('span', { style: styles.itemMeta }, chart.scope || chart.id),
							chart.modules.length > 0 ? h('span', { style: styles.itemMeta }, `→ ${chart.modules.join('、')}`) : null,
						))),
					state.problems.length > 0 ? h('div', { style: { ...styles.hint, padding: '8px' } }, `${t('problems')}：${state.problems.join('；')}`) : null,
					h('div', { style: { padding: '8px' } },
						h('button', { type: 'button', style: styles.button, onClick: () => setCreating(true) }, t('create')),
					),
				),
				h('div', { style: styles.main },
					h('div', { style: styles.bar },
						h('span', { style: styles.barTitle }, draft?.name ?? t('title')),
						h('span', { style: styles.barMeta }, draft?.scope ?? ''),
						h('span', { style: styles.spacer }),
						banner?.kind === 'saved' ? h('span', { style: { ...styles.badge, color: 'var(--dsw-alias-state-success-primary)' } }, t('saved')) : null,
						banner?.kind === 'dirty' ? h('span', { style: styles.badge }, t('dirty')) : null,
						banner?.kind === 'conflict'
							? h('span', { style: styles.row },
								h('button', { type: 'button', style: styles.button, onClick: () => { void load(draft.id); } }, t('reload')))
							: null,
						h('button', { type: 'button', style: styles.button, disabled: busy || draft === null, onClick: () => { if (window.confirm(t('removeConfirm'))) void remove(); } }, t('remove')),
						h('button', { type: 'button', style: styles.primary, disabled: busy || draft === null, onClick: () => { void save(); } }, busy ? t('saving') : `${t('save')} (Ctrl/Cmd+S)`),
					),
					h('div', { style: narrow ? styles.stackedBody : styles.body },
						h('div', { style: narrow ? styles.stackedCanvas : styles.canvas },
							banner?.kind === 'error' ? h('div', { style: styles.error }, banner.text) : null,
							draft === null
								? h('div', { style: styles.hint }, t('noSelection'))
								: h('div', null,
									h('div', {
										// The pointer surface is this wrapper, not the SVG inside it. The
										// picture is replaced through `dangerouslySetInnerHTML`, so its
										// `<svg>` element is thrown away on every draw; a listener attached
										// there (React copies them onto the replaced child) loses its
										// `setPointerCapture` the moment the element is detached, which
										// aborted the drag handler before it could run. This wrapper
										// persists, and `closest('svg')` still reaches the drawing.
										style: { position: 'relative', outline: 'none' },
										onPointerDown: (event) => {
											const hit = hitOf(event.target);
											if (hit === null) {
												setSelection(null);
												setGhost(null);
												return;
											}
											if (hit.kind === 'node') {
												setSelection({ kind: 'node', id: hit.id });
												if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture?.(event.pointerId);
												dragRef.current = {
													id: hit.id,
													row: hit.row ?? '',
													startX: event.clientX,
													scope: event.currentTarget,
													// The box group inside the picture, or null when the click landed
													// on something that is not a box group (only the caption is).
													group: /** @type {any} */ (event.target).closest?.('[data-node]') ?? null,
													moved: false,
													seat: 0,
												};
												return;
											}
											if (hit.kind === 'edge') {
												setSelection({ kind: 'edge', from: hit.from, to: hit.to });
												return;
											}
											// The connect handle: pull an arrow out of the box, which is what a
											// reader expects from a small circle on an edge.
											if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture?.(event.pointerId);
											connectRef.current = { from: hit.id, to: '', over: '' };
											const start = pointIn(event, event.currentTarget.querySelector(`[data-node="${hit.id}"]`));
											if (start !== null) setGhost({ from: hit.id, x1: start.x, y1: start.y, x2: start.x, y2: start.y });
										},
										onPointerMove: (event) => {
											const drag = dragRef.current;
											if (drag !== null) {
												dragWithinRow(drag, event.clientX, drag.scope);
												return;
											}
											if (connectRef.current.from === '') return;
											// The pointer is captured by this wrapper, so `event.target` stays
											// the wrapper for the whole gesture and `hitOf` would answer
											// "nothing" even over a box. The element actually under the
											// pointer has to be asked for by position.
											const under = document.elementFromPoint(event.clientX, event.clientY);
											const hit = hitOf(under);
											connectRef.current.over = hit !== null && hit.kind === 'node' ? hit.id : '';
											const start = pointIn(event, event.currentTarget.querySelector(`[data-node="${connectRef.current.from}"]`));
											const here = pointIn(event, event.currentTarget);
											if (start !== null && here !== null) {
												setGhost({ from: connectRef.current.from, x1: start.x, y1: start.y, x2: here.x, y2: here.y });
											}
										},
										onPointerUp: (event) => {
											const drag = dragRef.current;
											if (drag !== null) {
												// Put the box back where the renderer drew it: the model is about
												// to say where it really goes, and the picture must not keep a
												// transform the next draw knows nothing about.
												if (drag.group !== null) {
													drag.group.style.transform = '';
													drag.group.style.opacity = '';
												}
												dropWithinRow(drag, drag.scope);
											}
											dragRef.current = null;
											setDropHint(null);
											setGhost(null);
											const pending = connectRef.current;
											connectRef.current = { from: '', to: '', over: '' };
											if (pending.from === '') return;
											// Same reason as in `onPointerMove`: the captured pointer makes the
											// event target useless, so the drop target is read from the position.
											const under = document.elementFromPoint(event.clientX, event.clientY);
											const hit = hitOf(under);
											if (hit !== null && hit.kind === 'node') connect(pending.from, hit.id);
										},
										onPointerCancel: () => {
											const drag = dragRef.current;
											if (drag?.group != null) {
												drag.group.style.transform = '';
												drag.group.style.opacity = '';
											}
											dragRef.current = null;
											connectRef.current = { from: '', to: '', over: '' };
											setDropHint(null);
											setGhost(null);
										},
									},
									h('div', {
										ref: pictureRef,
										style: { ...styles.svgBox, position: 'relative' },
										dangerouslySetInnerHTML: { __html: decorateSvg(svg, t) },
									}),
									dropHint === null ? null : h('div', {
										style: {
											position: 'absolute',
											left: dropHint.at.x - 1,
											top: dropHint.at.y,
											width: 3,
											height: dropHint.at.height,
											borderRadius: 2,
											background: 'var(--dsw-alias-brand-primary)',
											pointerEvents: 'none',
										},
									}),
									ghost === null ? null : h('svg', {
										// Two SVGs, one viewBox: the overlay is positioned exactly over
										// the picture, so a point in picture coordinates lands where the
										// reader's cursor is whatever the pane width.
										viewBox: viewBoxOf(svg),
										preserveAspectRatio: 'xMidYMin meet',
										style: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
									},
									h('line', { x1: ghost.x1, y1: ghost.y1, x2: ghost.x2, y2: ghost.y2, stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2, strokeDasharray: '5 4' }),
									h('circle', { cx: ghost.x2, cy: ghost.y2, r: 4, fill: 'var(--dsw-alias-brand-primary)' }),
									),
									h('div', { style: styles.hint, marginTop: 8 }, `${t('canvasHint')} ${t('keyboard')}`),
									h('div', { style: styles.hint }, t('autoWrapped')),
									),
								),
						),
						h('div', { style: narrow ? styles.stackedBrief : styles.brief },
							draft === null ? null : h('div', null,
								// The selected thing, first: clicking a box on the picture puts its
								// editor here, so the picture and the form describe one object
								// instead of two lists that the reader has to match up.
								selection === null ? null : h('div', { style: { ...styles.rowCard, borderColor: 'var(--dsw-alias-brand-primary)' } },
									h('div', { style: styles.row },
										h('span', { style: styles.sectionTitle, margin: 0 }, t('selected')),
										h('span', { style: styles.spacer }),
										h('button', { type: 'button', style: styles.button, onClick: () => setSelection(null) }, '×'),
									),
									selection.kind === 'node'
										? (() => {
											const index = draft.nodes.findIndex((node) => node.id === selection.id);
											if (index === -1) return h('div', { style: styles.hint }, selection.id);
											const node = draft.nodes[index];
											return h('div', null,
												h('div', { style: styles.hint }, node.id),
												node.module === undefined
													? h(Field, { label: t('label'), value: node.label ?? '', onChange: (value) => setNode(index, { ...node, label: value }) })
													: h('div', null,
														h('div', { style: styles.hint }, t('moduleNode')),
														h(Field, { label: t('ports'), value: (node.ports ?? []).join('\n'), textarea: true, onChange: (value) => setNode(index, { ...node, ports: value.split('\n') }) }),
													),
												h('div', { style: styles.row },
													h('button', { type: 'button', style: styles.button, onClick: () => reorder(index, -1) }, '↑'),
													h('button', { type: 'button', style: styles.button, onClick: () => reorder(index, 1) }, '↓'),
												),
											);
										})()
										: (() => {
											const index = draft.edges.findIndex((edge) => edge.from === selection.from && edge.to === selection.to);
											if (index === -1) return h('div', { style: styles.hint }, `${selection.from} → ${selection.to}`);
											const edge = draft.edges[index];
											return h('div', null,
												h('div', { style: styles.hint }, `${edge.from} → ${edge.to}`),
												h(Field, {
													label: t('when'),
													value: edge.when ?? '',
													onChange: (value) => {
														const next = { ...edge };
														if (value.trim() === '') delete next.when;
														else next.when = value;
														setEdge(index, next);
													},
												}),
												h('div', { style: styles.row },
													h('button', {
														type: 'button',
														style: styles.button,
														onClick: () => {
															setDraft((current) => (current === null ? current : { ...current, edges: current.edges.filter((_, at) => at !== index) }));
															setSelection(null);
															touch();
														},
													}, t('removeEdge')),
												),
											);
										})(),
								),
								h('div', { style: styles.sectionTitle }, t('brief')),
								brief.trim() === '' ? h('div', { style: styles.hint }, t('noBrief')) : null,
								h(Field, { label: t('briefHint'), value: brief, onChange: (value) => { setBrief(value); touch(); }, textarea: true }),
								h('div', { style: styles.sectionTitle }, t('nodes')),
								draft.nodes.map((node, index) => h('div', { key: node.id, style: styles.rowCard },
									h('div', { style: styles.row },
										h('span', { style: { ...styles.badge } }, node.module === undefined ? node.id : `${node.id} → ${node.module}`),
										h('span', { style: styles.spacer }),
										h('button', { type: 'button', style: styles.button, onClick: () => reorder(index, -1) }, '↑'),
										h('button', { type: 'button', style: styles.button, onClick: () => reorder(index, 1) }, '↓'),
										h('button', {
											type: 'button',
											style: styles.button,
											onClick: () => {
												setDraft((current) => (current === null ? current : {
													...current,
													nodes: current.nodes.filter((_, at) => at !== index),
													edges: current.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id),
												}));
												touch();
											},
										}, t('removeNode')),
									),
									node.module === undefined
										? h(Field, { label: t('label'), value: node.label ?? '', onChange: (value) => setNode(index, { ...node, label: value }) })
										: h('div', null,
											h('div', { style: styles.hint }, t('moduleNode')),
											h(Field, { label: t('ports'), value: (node.ports ?? []).join('\n'), textarea: true, onChange: (value) => setNode(index, { ...node, ports: value.split('\n') }) }),
										),
								)),
								h('div', { style: styles.row },
									h('button', { type: 'button', style: styles.button, onClick: addNode }, t('addNode')),
									h(NewEdge, { t, nodes: draft.nodes, onAdd: addEdge }),
									others.length > 0
										? h('select', {
											style: styles.button,
											value: '',
											onChange: (event) => { if (event.target.value !== '') addModule(event.target.value); },
										},
										h('option', { value: '' }, t('addModule')),
										others.map((chart) => h('option', { key: chart.id, value: chart.id }, chart.name || chart.id)),
										)
										: null,
								),
								h('div', { style: styles.sectionTitle }, t('edges')),
								draft.edges.map((edge, index) => h('div', { key: `${edge.from}-${edge.to}-${index}`, style: styles.rowCard },
									h('div', { style: styles.row },
										h('span', { style: styles.badge }, `${edge.from} → ${edge.to}`),
										h('span', { style: styles.spacer }),
										h('button', {
											type: 'button',
											style: styles.button,
											onClick: () => {
												setDraft((current) => (current === null ? current : { ...current, edges: current.edges.filter((_, at) => at !== index) }));
												touch();
											},
										}, t('removeEdge')),
									),
									h(Field, {
										label: t('when'),
										value: edge.when ?? '',
										onChange: (value) => {
											const next = { ...edge };
											if (value.trim() === '') delete next.when;
											else next.when = value;
											setEdge(index, next);
										},
									}),
								)),
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
			const [kind, setKind] = React.useState('module');
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
			h('label', { style: styles.label }, t('kind')),
			h('select', { value: kind, onChange: (event) => setKind(event.target.value), style: styles.input },
				h('option', { value: 'module' }, t('module')),
				h('option', { value: 'overview' }, t('overview')),
			),
			h('div', { style: { ...styles.row, justifyContent: 'flex-end' } },
				h('button', { type: 'button', style: styles.button, onClick: onCancel }, t('cancel')),
				h('button', {
					type: 'button',
					style: styles.primary,
					onClick: () => onCreate({ id, name, scope, kind }),
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
