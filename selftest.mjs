/**
 * Dependency-free smoke test for the pure modules of dsh-spec-mode.
 * It exercises the parts that decide behavior — the `.spec` anchor, the path
 * predicate, the projection fold, and the two product validators — without a
 * Host.
 *
 * Run: node selftest.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentsMdAdvisories, deliverableAdvisories, progressAdvisories, specDeliverableWrite } from './advisories.js';
import { parseBrief, renderBrief, validateBrief } from './brief.js';
import { backEdgesOf, validateFlow } from './flow.js';
import { renderFlowSvg, layersOf, wrapLabel } from './flow-svg.js';
import {
	canonicalModel,
	chartBriefPath,
	chartImagePath,
	chartModelPath,
	drawableChart,
	parentsOf,
	readChartBrief,
	readCollection,
	referenceGraph,
	removeChartFiles,
	revisionOf,
	validateChart,
	validateCollection,
	writeChartBrief,
	writeChartModel,
} from './flows.js';
import { svgSize } from './rasterize.js';
import { classifyTarget, extractTargetPaths, isDestructiveTool, isWriteTool } from './guard.js';
import {
	createSpecProjection,
	findProjectAnchor,
	resolveDraftPath,
	resolveFlowsDir,
	resolveSpecDir,
} from './state.js';

let passed = 0;
function check(label, fn) {
	fn();
	passed += 1;
	console.log(`ok - ${label}`);
}

/**
 * Sample one SVG path (as the renderer writes it: `M`, `L`, `C` only) so a test
 * can ask whether it runs through a rectangle.
 *
 * @param {string} d - the `d` attribute.
 * @returns {[number, number][]} points every couple of pixels along the path.
 */
function sampleSvgPath(d) {
	const tokens = d.match(/[MLC]|-?[\d.]+/g);
	const points = [];
	let current = [0, 0];
	for (let index = 0; index < tokens.length; ) {
		const command = tokens[index];
		if (command === 'M') {
			current = [Number(tokens[index + 1]), Number(tokens[index + 2])];
			points.push(current);
			index += 3;
		} else if (command === 'L') {
			const next = [Number(tokens[index + 1]), Number(tokens[index + 2])];
			pushSegment(points, current, next, 2);
			current = next;
			index += 3;
		} else if (command === 'C') {
			const [c1x, c1y, c2x, c2y, endX, endY] = tokens.slice(index + 1, index + 7).map(Number);
			for (let step = 1; step <= 48; step += 1) {
				const t = step / 48;
				const m = 1 - t;
				points.push([
					m ** 3 * current[0] + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t ** 3 * endX,
					m ** 3 * current[1] + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t ** 3 * endY,
				]);
			}
			current = [endX, endY];
			index += 7;
		} else {
			index += 1;
		}
	}
	return points;
}

/**
 * Append points along one straight leg, `step` pixels apart.
 * @param {[number, number][]} points - the accumulator.
 * @param {[number, number]} from - the leg's start.
 * @param {[number, number]} to - the leg's end.
 * @param {number} step - the sampling distance.
 */
function pushSegment(points, from, to, step) {
	const count = Math.max(2, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / step));
	for (let index = 1; index <= count; index += 1) {
		points.push([from[0] + ((to[0] - from[0]) * index) / count, from[1] + ((to[1] - from[1]) * index) / count]);
	}
}

/* ---- project anchor ---- */

const sandbox = mkdtempSync(join(tmpdir(), 'spec-mode-'));
const project = join(sandbox, 'project');
const nested = join(project, 'a', 'b');
mkdirSync(nested, { recursive: true });
mkdirSync(join(project, '.git'), { recursive: true });

check('anchor walks up to the nearest .git', () => {
	assert.equal(findProjectAnchor(nested), project);
	assert.equal(resolveSpecDir(nested), join(project, '.spec'));
});

check('the product paths all live in the anchored .spec directory', () => {
	assert.equal(resolveDraftPath(nested), join(project, '.spec', 'draft.md'));
	assert.equal(resolveFlowsDir(nested), join(project, '.spec', 'flows'));
});

check('anchor falls back to cwd without a marker', () => {
	const bare = join(sandbox, 'bare', 'deep');
	mkdirSync(bare, { recursive: true });
	assert.equal(findProjectAnchor(bare), bare);
	assert.equal(resolveDraftPath(bare), join(bare, '.spec', 'draft.md'));
});

/* ---- path classification ---- */

const draft = resolveDraftPath(nested);

check('the draft itself is allowed, everything else is the working tree', () => {
	assert.equal(classifyTarget(draft, nested, draft), 'draft');
	assert.equal(classifyTarget('.spec/draft.md', project, draft), 'draft');
	assert.equal(classifyTarget('.spec/brief.md', project, draft), 'working-tree');
	assert.equal(classifyTarget('.spec/flow.md', project, draft), 'working-tree');
	assert.equal(classifyTarget('.spec', project, draft), 'working-tree');
	assert.equal(classifyTarget('docs/notes.md', project, draft), 'working-tree');
	assert.equal(classifyTarget('README.md', project, draft), 'working-tree');
});

check('protocol paths pass and unparsable input fails closed', () => {
	assert.equal(classifyTarget('local://x', project, draft), 'protocol');
	assert.equal(classifyTarget('artifact://x/y', project, draft), 'protocol');
	assert.equal(classifyTarget('   ', project, draft), 'protocol');
	assert.equal(classifyTarget(undefined, project, draft), 'protocol');
});

check('targets are collected across key spellings', () => {
	assert.deepEqual(extractTargetPaths({ file_path: 'a', path: 'b' }), ['a', 'b']);
	assert.deepEqual(extractTargetPaths({ paths: ['a', 'b'] }), ['a', 'b']);
	assert.deepEqual(extractTargetPaths({ content: 'x' }), []);
	assert.deepEqual(extractTargetPaths(null), []);
});

check('tool-name predicates', () => {
	assert.equal(isWriteTool('write'), true);
	assert.equal(isWriteTool('edit'), true);
	assert.equal(isWriteTool('read'), false);
	assert.equal(isDestructiveTool('delete_file'), true);
	assert.equal(isDestructiveTool('move'), true);
	assert.equal(isDestructiveTool('write'), false);
});

/* ---- projection fold ---- */

const unit = createSpecProjection('spec', 'spec_resolve');
const init = unit.init({}, 0);
const run = (state, type, data) => unit.apply(state, { type, data });

check('a successful /spec commits the mode', () => {
	let state = init;
	assert.equal(state.active, false);
	state = run(state, 'command/run', { commandId: 'c1', name: 'spec', args: '' });
	assert.deepEqual(state.running, { commandId: 'c1', wanted: true });
	state = run(state, 'command/done', { commandId: 'c1', kind: 'success' });
	assert.equal(state.active, true);
	assert.equal(state.running, null);
});

check('a failed /spec leaves the mode alone', () => {
	const on = { active: true, running: null, exitCall: null };
	let state = run(on, 'command/run', { commandId: 'c2', name: 'spec', args: '' });
	state = run(state, 'command/done', { commandId: 'c2', kind: 'error' });
	assert.equal(state.active, true);
	assert.equal(state.running, null);
});

check('/spec off commits the exit', () => {
	let state = run({ active: true, running: null, exitCall: null }, 'command/run', {
		commandId: 'c3',
		name: 'spec',
		args: ' off',
	});
	assert.equal(state.running.wanted, false);
	state = run(state, 'command/done', { commandId: 'c3', kind: 'success' });
	assert.equal(state.active, false);
});

check('an unrelated command never moves the state', () => {
	const before = { active: true, running: null, exitCall: null };
	assert.equal(run(before, 'command/run', { commandId: 'c9', name: 'plan', args: '' }), before);
	assert.equal(run(before, 'assistant/message', {}), before);
});

check('command/run moves the pending selection before the handler runs', () => {
	// The invariant the /spec handler relies on: `running.wanted` is already the
	// new selection while `active` still holds the committed one.
	const committedOn = { active: true, running: null, exitCall: null };
	const duringOff = run(committedOn, 'command/run', { commandId: 'c4', name: 'spec', args: ' off' });
	assert.equal(duringOff.active, true);
	assert.equal(duringOff.running.wanted, false);

	const committedOff = { active: false, running: null, exitCall: null };
	const duringOn = run(committedOff, 'command/run', { commandId: 'c5', name: 'spec', args: '' });
	assert.equal(duringOn.active, false);
	assert.equal(duringOn.running.wanted, true);
});

check('a declined review keeps the mode on', () => {
	let state = run({ active: true, running: null, exitCall: null }, 'tool/call', {
		callId: 't1',
		name: 'spec_resolve',
	});
	assert.equal(state.exitCall, 't1');
	state = run(state, 'tool/result', { message: { toolCallId: 't1', isError: true } });
	assert.equal(state.active, true);
	assert.equal(state.exitCall, null);
});

check('an approved review leaves the mode', () => {
	let state = run({ active: true, running: null, exitCall: null }, 'tool/call', {
		callId: 't2',
		name: 'spec_resolve',
	});
	state = run(state, 'tool/result', { message: { toolCallId: 't2', isError: false } });
	assert.equal(state.active, false);
	assert.equal(state.exitCall, null);
});

check('a result for another tool is ignored', () => {
	const before = { active: true, running: null, exitCall: 't3' };
	assert.equal(run(before, 'tool/result', { message: { toolCallId: 'other' } }), before);
});

check('the state schema accepts its own output and rejects junk', () => {
	const state = { active: true, running: null, exitCall: 'x' };
	assert.deepEqual(unit.stateSchema.parse(state), state);
	assert.throws(() => unit.stateSchema.parse(null));
	assert.throws(() => unit.stateSchema.parse({ active: 'yes' }));
	assert.throws(() => unit.stateSchema.parse({ active: true, running: { commandId: 1 } }));
});

/* ---- brief ---- */

const goodBrief = {
	title: '导出功能',
	goal: '用户在列表页能把当前筛选结果导出成一份 CSV。',
	requirements: ['列表页右上角有「导出」按钮。', '导出范围是当前筛选结果，不是全部数据。'],
	acceptance: ['点「导出」后 3 秒内下载到文件，文件行数等于列表行数。', '未筛选时导出全部，`node check.mjs` 退出码 0。'],
	constraints: ['只支持 CSV。'],
};

check('a complete brief validates and renders its four sections', () => {
	const outcome = validateBrief(goodBrief);
	assert.equal(outcome.ok, true);
	const text = renderBrief(outcome.brief);
	assert.ok(text.startsWith('# 导出功能\n'));
	for (const heading of ['## 目标', '## 要做什么', '## 验收', '## 约束']) assert.ok(text.includes(heading), `${heading} 缺失`);
	assert.ok(text.endsWith('\n'));
});

check('an empty constraints list omits the section', () => {
	const outcome = validateBrief({ ...goodBrief, constraints: [] });
	assert.equal(outcome.ok, true);
	const text = renderBrief(outcome.brief);
	assert.equal(text.includes('## 约束'), false);
	assert.ok(text.includes('## 验收'));
});

check('a brief rejects missing and empty fields with a field path', () => {
	const missing = validateBrief({ title: 'x' });
	assert.equal(missing.ok, false);
	assert.ok(missing.errors.some((error) => error.startsWith('brief.goal')));
	assert.ok(missing.errors.some((error) => error.startsWith('brief.requirements')));
	assert.ok(missing.errors.some((error) => error.startsWith('brief.acceptance')));

	const emptyList = validateBrief({ ...goodBrief, requirements: [] });
	assert.equal(emptyList.ok, false);
	assert.ok(emptyList.errors[0].startsWith('brief.requirements'));

	const blankItem = validateBrief({ ...goodBrief, requirements: ['导出按钮。', '  '] });
	assert.equal(blankItem.ok, false);
	assert.equal(blankItem.errors[0], 'brief.requirements[1]: 不能为空');
});

check('a brief rejects code, including a fence smuggled into one bullet', () => {
	for (const bad of ['```js\nconsole.log(1)\n```', '调用 `doExport()` 完成任务。', '需求\n```js\nconst a = 1;\n```']) {
		const outcome = validateBrief({ ...goodBrief, requirements: [bad] });
		assert.equal(outcome.ok, false, bad);
		// A multi-line bullet is caught as a line-break violation before the fence
		// rule sees it; both readings reject the same input.
		assert.ok(/代码|一行/.test(outcome.errors[0]), outcome.errors[0]);
	}
});

check('a brief keeps a runnable command: an acceptance check is a command', () => {
	for (const good of [
		'运行 `node selftest.mjs`，退出码 0。',
		'用 `wc -l` 计得 1001 行。',
		'运行 `node check.mjs --format=csv`，退出码 0。',
		'运行 `NODE_ENV=test node check.mjs`，退出码 0。',
		'执行 /spec off 退出。',
	]) {
		const outcome = validateBrief({ ...goodBrief, acceptance: [good] });
		assert.equal(outcome.ok, true, `${good} → ${outcome.ok ? '' : outcome.errors[0]}`);
	}
	// A call or a block in backticks is still code, commands are not.
	for (const bad of ['调用 `doExport()` 完成任务。', '用 `a => b` 传参。', '返回 `{ok:true}`。']) {
		const outcome = validateBrief({ ...goodBrief, acceptance: [bad] });
		assert.equal(outcome.ok, false, bad);
		assert.ok(outcome.errors[0].includes('代码'), outcome.errors[0]);
	}
});

check('a bullet carrying a line break is rejected rather than silently halved', () => {
	// The renderer writes one bullet per item, so a second line would be read
	// back as nothing — the requirement would disappear at landing time.
	const outcome = validateBrief({ ...goodBrief, requirements: ['第一行\n第二行'] });
	assert.equal(outcome.ok, false);
	assert.ok(outcome.errors[0].includes('一行'), outcome.errors[0]);
});

check('a brief rejects reasoning and background', () => {
	for (const bad of ['先做导出，因为用户要求。', '之所以选 CSV，是为了兼容 Excel。', '权衡之后只做 CSV。', '背景：用户之前用 Excel 导出。']) {
		const outcome = validateBrief({ ...goodBrief, requirements: [bad] });
		assert.equal(outcome.ok, false, bad);
		assert.ok(outcome.errors[0].includes('理由'), outcome.errors[0]);
	}
});

check('a brief rejects machine-specific paths and multi-line fields', () => {
	const absolute = validateBrief({ ...goodBrief, acceptance: ['把文件写到 /home/lmq/out.csv。'] });
	assert.equal(absolute.ok, false);
	assert.ok(absolute.errors[0].includes('绝对路径'));

	const multiline = validateBrief({ ...goodBrief, goal: '第一行\n第二行' });
	assert.equal(multiline.ok, false);
	assert.ok(multiline.errors[0].includes('一行'));
});

check('a value that would read back as a heading is rejected', () => {
	// The renderer puts each value on its own line, so `## 目标` as a goal would
	// be read back as a new empty section and the sentence would vanish.
	for (const field of ['title', 'goal']) {
		const outcome = validateBrief({ ...goodBrief, [field]: '## 目标' });
		assert.equal(outcome.ok, false, field);
		assert.ok(outcome.errors[0].includes('#'), outcome.errors[0]);
	}
	const requirement = validateBrief({ ...goodBrief, requirements: ['## 要做什么'] });
	assert.equal(requirement.ok, false);
	assert.ok(requirement.errors[0].includes('#'));
});

check('a rendered brief reads back into the same brief', () => {
	const outcome = validateBrief(goodBrief);
	const back = parseBrief(renderBrief(outcome.brief));
	assert.equal(back.ok, true);
	assert.deepEqual(back.brief, outcome.brief);
});

check('a hand-written brief is not held to the model shape', () => {
	// The four-section rule exists so a model's plan is readable. A note someone
	// wrote for themselves is not a plan, so the write path says nothing about it.
	const text = '# 导出\n\n## 目标\n能导出。\n\n## 要做什么\n- 先做导出，因为要导出。\n';
	assert.deepEqual(deliverableAdvisories(text), []);
	const missing = '# 导出\n\n## 目标\n能导出。\n';
	assert.deepEqual(deliverableAdvisories(missing), []);
});

check('only AGENTS.md is classified as a spec advisory target', () => {
	assert.deepEqual(specDeliverableWrite('write', { file_path: '.spec/flows/overview.brief.md', content: '# x' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: '# x' }, false).kind, 'agents');
});

/* ---- flow ---- */

const goodFlow = {
	nodes: [
		{ id: 'N1', label: '用户输入 /spec，模式打开' },
		{ id: 'N2', label: '模型把需求逐条写进草稿' },
		{ id: 'N3', label: '用户补充需求，草稿增量更新' },
		{ id: 'N4', label: '用户确认后写两份产物' },
	],
	edges: [
		{ from: 'N1', to: 'N2' },
		{ from: 'N2', to: 'N3', when: '还有没问到的' },
		{ from: 'N3', to: 'N4' },
		{ from: 'N2', to: 'N4', when: '一次说清' },
	],
};

check('a well-formed flow validates', () => {
	const outcome = validateFlow(goodFlow);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.flow.nodes.length, 4);
	assert.equal(outcome.flow.edges.length, 4);
});

check('a flow has exactly one entry', () => {
	// One procedure starts in one place; two sources means two stories stacked.
	const twoStarts = validateFlow({
		nodes: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'C', label: 'c' }],
		edges: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }],
	});
	assert.equal(twoStarts.ok, false);
	assert.ok(twoStarts.errors[0].includes('起点'), twoStarts.errors.join('；'));

	// Several exits are legitimate: an attempt can end in more than one way —
	// but a branch has to carry the condition that picks it.
	const twoEnds = validateFlow({
		nodes: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'C', label: 'c' }],
		edges: [{ from: 'A', to: 'B', when: '用户批准' }, { from: 'A', to: 'C', when: '用户拒绝' }],
	});
	assert.equal(twoEnds.ok, true);

	const silentBranch = validateFlow({
		nodes: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'C', label: 'c' }],
		edges: [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }],
	});
	assert.equal(silentBranch.ok, false);
	assert.ok(silentBranch.errors[0].includes('when'), silentBranch.errors.join('；'));

	const diamond = validateFlow({
		nodes: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'C', label: 'c' }, { id: 'D', label: 'd' }],
		edges: [
			{ from: 'A', to: 'B', when: '通过' },
			{ from: 'A', to: 'C', when: '不通过' },
			{ from: 'B', to: 'D' },
			{ from: 'C', to: 'D' },
		],
	});
	assert.equal(diamond.ok, true);
});

check('the chart is an SVG image with every node and edge drawn', () => {
	const outcome = validateFlow(goodFlow);
	const svg = renderFlowSvg(outcome.flow, '导出：功能流程');
	assert.ok(svg.startsWith('<svg '), '必须是 SVG 文档');
	assert.ok(svg.endsWith('</svg>\n'));
	assert.ok(svg.includes('导出：功能流程'));
	// One text element per label, plus the title and the two edge notes.
	for (const node of outcome.flow.nodes) assert.ok(svg.includes(node.label) || wrapLabel(node.label).some((line) => svg.includes(line)), node.label);
	assert.ok(svg.includes('还有没问到的'));
	assert.ok(svg.includes('一次说清'));
	// Every edge is a path with an arrow head.
	assert.equal((svg.match(/marker-end="url\(#arrow\)"/g) ?? []).length, outcome.flow.edges.length);
	const size = svgSize(svg);
	assert.ok(size !== undefined);
	assert.ok(size.width > 200 && size.height > 200, JSON.stringify(size));
});

check('layers stack every edge downward', () => {
	// The rendering assumption: in a DAG each edge goes from a lower layer to a
	// higher one, which is what makes a top-down picture readable.
	const outcome = validateFlow(goodFlow);
	const layers = layersOf(outcome.flow);
	for (const edge of outcome.flow.edges) {
		assert.ok(layers.get(edge.from) < layers.get(edge.to), `${edge.from} -> ${edge.to}`);
	}
});

check('an edge that skips rows goes around the boxes, not through them', () => {
	// A branch out of a long chain would otherwise draw down the column shared by
	// every row, straight through the boxes standing in between.
	const outcome = validateFlow({
		nodes: [
			{ id: 'S', label: '起点' },
			{ id: 'A', label: '主线一步' },
			{ id: 'X', label: '旁路一步' },
			{ id: 'B', label: '主线二步' },
			{ id: 'C', label: '两条路汇合' },
		],
		edges: [
			{ from: 'S', to: 'A', when: '走主线' },
			{ from: 'S', to: 'X', when: '走旁路' },
			{ from: 'A', to: 'B' },
			{ from: 'B', to: 'C' },
			{ from: 'X', to: 'C' },
		],
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	const svg = renderFlowSvg(outcome.flow, '长跨度连线');
	const boxes = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="9"/g)]
		.map((match) => ({
			left: Number(match[1]),
			top: Number(match[2]),
			right: Number(match[1]) + Number(match[3]),
			bottom: Number(match[2]) + Number(match[4]),
		}));
	const rightmost = Math.max(...boxes.map((box) => box.right));
	// The arrow-head marker is a path too; the edges are the ones on a line.
	const paths = [...svg.matchAll(/<path d="(M [^"]+)"/g)].map((match) => match[1]);
	const skip = paths.find((path) => path.split(' L ').length > 4);
	assert.ok(skip !== undefined, JSON.stringify(paths));
	// It leaves the diagram to one side instead of cutting across it.
	const points = [...skip.matchAll(/(?:M|L) ([\d.]+) ([\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
	assert.ok(points.some((point) => point.x > rightmost), `${JSON.stringify(points)} 全部在 ${rightmost} 之内`);
	// No leg of the route may pass through a box. A segment is inside one when
	// its bounding box overlaps the box interior on both axes.
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1];
		const b = points[index];
		const hit = boxes.find((box) => Math.max(a.x, b.x) > box.left + 1 && Math.min(a.x, b.x) < box.right - 1
			&& Math.max(a.y, b.y) > box.top + 1 && Math.min(a.y, b.y) < box.bottom - 1);
		assert.equal(hit, undefined, `第 ${index} 段穿过框 ${JSON.stringify(hit)}`);
	}
	// An adjacent-row drift still uses the smooth curve.
	assert.ok(paths.some((path) => path.includes('C')), JSON.stringify(paths));
});

check('a loop is drawn as a route around the boxes', () => {
	// The retry is the whole point of allowing a loop: the picture has to show
	// that the step repeats, and the route must not cut through the boxes in
	// between.
	const outcome = validateFlow({
		nodes: [
			{ id: 'submit', label: '模型提交两份产物' },
			{ id: 'check', label: '插件校验' },
			{ id: 'err', label: '报错点名字段' },
			{ id: 'dialog', label: '弹确认框' },
		],
		edges: [
			{ from: 'submit', to: 'check' },
			{ from: 'check', to: 'err', when: '不通过' },
			{ from: 'check', to: 'dialog', when: '通过' },
			{ from: 'err', to: 'check' },
		],
	});
	assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join('；'));
	const svg = renderFlowSvg(outcome.flow, '回边');
	const boxes = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="9"/g)]
		.map((match) => ({
			left: Number(match[1]),
			top: Number(match[2]),
			right: Number(match[1]) + Number(match[3]),
			bottom: Number(match[2]) + Number(match[4]),
		}));
	const paths = [...svg.matchAll(/<path d="(M [^"]+)"/g)].map((match) => match[1]);
	// The loop is the only route with more than one bend.
	const loop = paths.find((path) => path.split(' L ').length > 4);
	assert.ok(loop !== undefined, JSON.stringify(paths));
	const points = [...loop.matchAll(/(?:M|L) ([\d.]+) ([\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
	for (let index = 1; index < points.length; index += 1) {
		const a = points[index - 1];
		const b = points[index];
		const hit = boxes.find((box) => Math.max(a.x, b.x) > box.left + 1 && Math.min(a.x, b.x) < box.right - 1
			&& Math.max(a.y, b.y) > box.top + 1 && Math.min(a.y, b.y) < box.bottom - 1);
		assert.equal(hit, undefined, `第 ${index} 段穿过框`);
	}
	// It leaves the diagram on one side or the other, which is what keeps it clear
	// of the downward arrows. Which side is the shorter detour depends on where the
	// two boxes sit, so either is correct; running down the middle is not.
	const rightmost = Math.max(...boxes.map((box) => box.right));
	const leftmost = Math.min(...boxes.map((box) => box.left));
	assert.ok(
		points.some((point) => point.x > rightmost || point.x < leftmost),
		`${JSON.stringify(points)} 全部在 [${leftmost}, ${rightmost}] 之内`,
	);
});

check('a retry onto the first row is drawn below the title', () => {
	// Every other retry comes in through the gap above its target row. The first
	// row has no gap above it, so without a reserved band the return run would be
	// drawn straight across the chart's title.
	const outcome = validateFlow({
		nodes: [
			{ id: 'open', label: '用户打开设置页' },
			{ id: 'save', label: '保存后回读校验' },
			{ id: 'bad', label: '提示哪一项不合法' },
			{ id: 'ok', label: '提示已保存' },
		],
		edges: [
			{ from: 'open', to: 'save' },
			{ from: 'save', to: 'bad', when: '校验不通过' },
			{ from: 'save', to: 'ok', when: '校验通过' },
			{ from: 'bad', to: 'open' },
		],
	});
	assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.errors.join('；'));
	const title = '设置页保存与回读校验的完整流程说明，这一行故意写得非常长填满整个标题带';
	const svg = renderFlowSvg(outcome.flow, title);
	const baseline = Number(/<text x="28" y="(\d+)"[^>]*font-size="16"/.exec(svg)[1]);
	// The route's return run comes in over the first row's top edge.
	const topRowTop = Math.min(...[...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="[\d.]+" rx="9"/g)]
		.map((match) => Number(match[1])));
	const routes = [...svg.matchAll(/<path d="(M [^"]+)" fill="none"/g)].map((match) => match[1]);
	const loop = routes.find((path) => path.split(' L ').length > 4);
	assert.ok(loop !== undefined, JSON.stringify(routes));
	const ys = [...loop.matchAll(/(?:M|L) [\d.]+ ([\d.]+)/g)].map((match) => Number(match[1]));
	// Nothing above the first row may be drawn over the title's text band.
	const highest = Math.min(...ys);
	assert.ok(highest > baseline + 6, `回箭头最上面在 y=${highest}，标题基线在 ${baseline}`);
	assert.ok(highest < topRowTop, `回箭头最上面在 y=${highest}，第一行顶边在 ${topRowTop}`);
});

check('conditions on one branch do not overlap each other', () => {
	// All three edges share the gap under the branching box, so the notes have
	// only that gap's height and the picture's width to separate in.
	const outcome = validateFlow({
		nodes: [
			{ id: 'S', label: '用户点保存' },
			{ id: 'L', label: '先落本地' },
			{ id: 'R', label: '先传服务端' },
			{ id: 'E', label: '提示失败' },
		],
		edges: [
			{ from: 'S', to: 'L', when: '用户选了只存本地这一项' },
			{ from: 'S', to: 'R', when: '用户选了上传服务端这一项' },
			{ from: 'S', to: 'E', when: '网络正断着' },
			{ from: 'L', to: 'E' },
			{ from: 'R', to: 'E' },
		],
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	const svg = renderFlowSvg(outcome.flow, '并列条件');
	const pills = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="18" rx="4"/g)]
		.map((match) => ({
			left: Number(match[1]),
			top: Number(match[2]),
			right: Number(match[1]) + Number(match[3]),
			bottom: Number(match[2]) + 18,
		}));
	assert.equal(pills.length, 3);
	for (let i = 0; i < pills.length; i += 1) {
		for (let j = i + 1; j < pills.length; j += 1) {
			const a = pills[i];
			const b = pills[j];
			const overlap = Math.min(a.right, b.right) > Math.max(a.left, b.left)
				&& Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
			assert.equal(overlap, false, `标签 ${i} 与 ${j} 重叠：${JSON.stringify([a, b])}`);
		}
	}
	// And they all stay inside the picture.
	const width = Number(/<svg[^>]*width="(\d+)"/.exec(svg)[1]);
	for (const pill of pills) assert.ok(pill.left >= 0 && pill.right <= width, JSON.stringify(pill));
});

check('a condition note sits on its own line, not on a sibling branch', () => {
	// Every edge leaving one box starts at the same pixel, so a note placed at
	// the midpoint of its gap can land on the line of a sibling branch; the
	// reader then attaches the condition to the wrong arrow.
	const outcome = validateFlow({
		nodes: [
			{ id: 'S', label: '用户点保存' },
			{ id: 'L', label: '先落本地' },
			{ id: 'R', label: '先传服务端' },
			{ id: 'E', label: '提示失败' },
		],
		edges: [
			{ from: 'S', to: 'L', when: '只存本地' },
			{ from: 'S', to: 'R', when: '传服务端' },
			{ from: 'S', to: 'E', when: '网络断着' },
			{ from: 'L', to: 'E' },
			{ from: 'R', to: 'E' },
		],
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	const svg = renderFlowSvg(outcome.flow, '标签不压线');

	// Paths are emitted one per edge, in edge order; notes in the same order,
	// skipping the edges that carry none.
	const paths = [...svg.matchAll(/<path d="(M [^"]+)" fill="none"/g)].map((match) => sampleSvgPath(match[1]));
	const notes = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="18" rx="4"/g)]
		.map((match) => ({
			left: Number(match[1]),
			top: Number(match[2]),
			right: Number(match[1]) + Number(match[3]),
			bottom: Number(match[2]) + 18,
		}));
	const owners = outcome.flow.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => edge.when !== undefined);
	assert.equal(notes.length, owners.length);
	assert.equal(paths.length, outcome.flow.edges.length);

	notes.forEach((note, noteIndex) => {
		const owner = owners[noteIndex].index;
		paths.forEach((samples, edgeIndex) => {
			if (edgeIndex === owner) return;
			const hit = samples.some(([x, y]) => x > note.left + 2 && x < note.right - 2 && y > note.top + 2 && y < note.bottom - 2);
			assert.equal(hit, false, `「${outcome.flow.edges[owner].when}」标签压在 ${outcome.flow.edges[edgeIndex].from}->${outcome.flow.edges[edgeIndex].to} 上`);
		});
	});
});

check('a long label wraps instead of overflowing its box', () => {
	const lines = wrapLabel('模型调用 spec_resolve 把两份产物的结构化内容一起提交上来，先过参数 schema 再过内容校验');
	assert.ok(lines.length > 1, JSON.stringify(lines));
	for (const line of lines) assert.ok(line.length <= 60, line);
	// A lone trailing character is pulled back rather than left orphaned.
	assert.ok(lines.every((line) => line.length > 1));
	assert.deepEqual(wrapLabel('短'), ['短']);
});

check('a flow rejects bad ids, duplicates and dangling edges', () => {
	const badId = validateFlow({ nodes: [{ id: '1n', label: 'x' }, { id: 'N2', label: 'y' }], edges: [] });
	assert.equal(badId.ok, false);
	assert.ok(badId.errors.some((error) => error.includes('flow.nodes[0].id')));

	const duplicate = validateFlow({ nodes: [{ id: 'N1', label: 'x' }, { id: 'N1', label: 'y' }], edges: [] });
	assert.equal(duplicate.ok, false);
	assert.ok(duplicate.errors.some((error) => error.includes('重复的节点 id')));

	const dangling = validateFlow({ nodes: [{ id: 'N1', label: 'x' }, { id: 'N2', label: 'y' }], edges: [{ from: 'N1', to: 'N9' }] });
	assert.equal(dangling.ok, false);
	assert.ok(dangling.errors.some((error) => error.includes('flow.edges[0].to')));
});

check('a flow accepts a retry loop and still rejects a self-loop', () => {
	// A retry is a loop and has to stay one: unrolling it makes the picture claim
	// the procedure runs it once.
	const retry = validateFlow({
		nodes: [
			{ id: 'submit', label: '模型提交两份产物' },
			{ id: 'check', label: '插件校验' },
			{ id: 'err', label: '报错点名字段' },
			{ id: 'done', label: '弹确认框' },
		],
		edges: [
			{ from: 'submit', to: 'check' },
			{ from: 'check', to: 'err', when: '不通过' },
			{ from: 'check', to: 'done', when: '通过' },
			{ from: 'err', to: 'submit' },
		],
	});
	assert.equal(retry.ok, true, retry.ok ? '' : retry.errors.join('；'));

	const selfLoop = validateFlow({ nodes: [{ id: 'N1', label: 'x' }, { id: 'N2', label: 'y' }], edges: [{ from: 'N1', to: 'N1' }, { from: 'N1', to: 'N2' }] });
	assert.equal(selfLoop.ok, false);
	assert.ok(selfLoop.errors.some((error) => error.includes('连向自己')));
});

check('a loop edge is recognized and kept out of the layering', () => {
	const flow = {
		nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
		edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }],
	};
	const back = backEdgesOf(flow);
	assert.deepEqual([...back], ['c->b']);
	const layers = layersOf(flow);
	assert.equal(layers.get('a'), 0);
	assert.equal(layers.get('b'), 1);
	assert.equal(layers.get('c'), 2);
});

check('a flow that is only nodes is not a flow', () => {
	const outcome = validateFlow({ nodes: [{ id: 'N1', label: 'x' }, { id: 'N2', label: 'y' }], edges: [] });
	assert.equal(outcome.ok, false);
	assert.ok(outcome.errors[0].includes('flow.edges'), outcome.errors[0]);
});

check('a flow rejects a single node and code in a label', () => {
	assert.equal(validateFlow({ nodes: [{ id: 'N1', label: 'x' }], edges: [] }).ok, false);
	const coded = validateFlow({
		nodes: [{ id: 'N1', label: '调用 `run()` 之后' }, { id: 'N2', label: '结束' }],
		edges: [{ from: 'N1', to: 'N2' }],
	});
	assert.equal(coded.ok, false);
	assert.ok(coded.errors[0].includes('代码'));
});

check('a flow rejects reasoning in a label', () => {
	const outcome = validateFlow({
		nodes: [{ id: 'N1', label: '因为要导出所以点按钮' }, { id: 'N2', label: '结束' }],
		edges: [{ from: 'N1', to: 'N2' }],
	});
	assert.equal(outcome.ok, false);
	assert.ok(outcome.errors[0].includes('理由'));
});

check('a label carrying a line break is rejected rather than silently halved', () => {
	// One node renders as one `- N1 …` line, so a second line would read back as
	// nothing and the step would disappear at landing time.
	const outcome = validateFlow({
		nodes: [{ id: 'N1', label: '第一行\n第二行' }, { id: 'N2', label: '结束' }],
		edges: [{ from: 'N1', to: 'N2' }],
	});
	assert.equal(outcome.ok, false);
	assert.ok(outcome.errors[0].includes('一行'), outcome.errors[0]);
});

check('a hand-written brief that would silently lose content is reported', () => {
	// A repeated heading replaces the earlier list, and a non-bullet line under a
	// list section is dropped by the bullet reader. Both would land a file whose
	// text is not what the writer wrote.
	const duplicate = '# t\n\n## 目标\n甲。\n\n## 目标\n乙。\n\n## 要做什么\n- a\n\n## 验收\n- b\n';
	const duplicateOutcome = parseBrief(duplicate);
	assert.equal(duplicateOutcome.ok, false);
	assert.ok(duplicateOutcome.errors.some((error) => error.includes('不止一次')), duplicateOutcome.errors.join('；'));

	const prose = '# t\n\n## 目标\ng\n\n## 要做什么\n- a\n没有写列表符号的一条需求\n\n## 验收\n- b\n';
	const proseOutcome = parseBrief(prose);
	assert.equal(proseOutcome.ok, false);
	assert.ok(proseOutcome.errors.some((error) => error.includes('不是一条列表项')), proseOutcome.errors.join('；'));
});

/* ---- chart collection ---- */

/** A minimal valid overview, used as the base of most collection checks. */
const overviewChart = {
	id: 'overview',
	kind: 'overview',
	name: '总览',
	scope: '从用户提出想法到产物写回盘上',
	nodes: [
		{ id: 'n1', label: '用户提出想法' },
		{ id: 'n2', label: '模型整理成图集' },
	],
	edges: [{ from: 'n1', to: 'n2' }],
};

/** A module chart the overview can point at. */
const moduleChart = {
	id: 'landing',
	kind: 'module',
	name: '落盘',
	scope: '从确认到写文件',
	nodes: [
		{ id: 'm1', label: '用户确认' },
		{ id: 'm2', label: '工具写文件' },
	],
	edges: [{ from: 'm1', to: 'm2' }],
};

/** The overview with a module node added, for the checks that need one. */
const withModule = (ports = ['入：图集已校验', '出：盘上有三件套']) => ({
	...overviewChart,
	nodes: [
		{ id: 'n1', label: '用户提出想法' },
		{ id: 'n2', module: 'landing', ports },
	],
});

/** A temporary `.spec` directory for the checks that write files. */
function specSandbox() {
	const root = mkdtempSync(join(tmpdir(), 'spec-flows-'));
	const specDir = join(root, '.spec');
	mkdirSync(specDir, { recursive: true });
	return specDir;
}

check('a chart model carries the four fields a reader needs', () => {
	const outcome = validateChart(overviewChart);
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	assert.deepEqual(Object.keys(outcome.model), ['id', 'kind', 'name', 'scope', 'nodes', 'edges']);
});

check('a chart without a scope, name or kind is refused by field path', () => {
	const missingScope = validateChart({ ...overviewChart, scope: '' });
	assert.equal(missingScope.ok, false);
	assert.ok(missingScope.errors[0].startsWith('chart.scope'), missingScope.errors[0]);

	const missingName = validateChart({ ...overviewChart, name: '  ' });
	assert.equal(missingName.ok, false);
	assert.ok(missingName.errors[0].startsWith('chart.name'));

	const badKind = validateChart({ ...overviewChart, kind: 'flow' });
	assert.equal(badKind.ok, false);
	assert.ok(badKind.errors[0].startsWith('chart.kind'));

	// The id is the file name, so its shape is the file system's, not prose's.
	const badId = validateChart({ ...overviewChart, id: 'Landing Page' });
	assert.equal(badId.ok, false);
	assert.ok(badId.errors[0].startsWith('chart.id'));
});

check('a scope that names no boundary is refused', () => {
	// 「本次」「相关」 is exactly the ambiguity this field exists to remove: a chart
	// labelled that way is back to being an unlabelled one.
	for (const vague of ['本次相关流程', '和导出相关的部分', '一些模块']) {
		const outcome = validateChart({ ...overviewChart, scope: vague });
		assert.equal(outcome.ok, false, vague);
		assert.ok(outcome.errors[0].includes('无边界'), outcome.errors[0]);
	}
});

check('a module node takes its words from the chart it points at', () => {
	const models = new Map([
		['overview', withModule()],
		['landing', moduleChart],
	]);
	const drawn = drawableChart(models.get('overview'), models);
	const box = drawn.nodes.find((node) => node.id === 'n2');
	assert.equal(box.label, '落盘');
	assert.equal(box.isModule, true);
	assert.deepEqual(box.ports, ['入：图集已校验', '出：盘上有三件套']);

	// Renaming the module chart changes the parent's box without touching the
	// parent's model — that is why the name is not stored in the parent.
	const renamed = new Map(models);
	renamed.set('landing', { ...moduleChart, name: '写入磁盘' });
	assert.equal(drawableChart(renamed.get('overview'), renamed).nodes.find((node) => node.id === 'n2').label, '写入磁盘');
});

check('a module node without ports, a label or a real target is refused', () => {
	const noPorts = validateChart({
		...overviewChart,
		nodes: [{ id: 'n1', label: '开始' }, { id: 'n2', module: 'landing' }],
	}, { knownModules: new Set(['landing']) });
	assert.equal(noPorts.ok, false);
	assert.ok(noPorts.errors.some((error) => error.includes('ports')), noPorts.errors.join('；'));

	const withLabel = validateChart({
		...overviewChart,
		nodes: [{ id: 'n1', label: '开始' }, { id: 'n2', module: 'landing', label: '落盘', ports: ['出：写好了'] }],
	}, { knownModules: new Set(['landing']) });
	assert.equal(withLabel.ok, false);
	assert.ok(withLabel.errors.some((error) => error.includes('label')), withLabel.errors.join('；'));

	const dangling = validateChart({
		...overviewChart,
		nodes: [{ id: 'n1', label: '开始' }, { id: 'n2', module: 'nowhere', ports: ['出：写好了'] }],
	}, { knownModules: new Set(['landing']) });
	assert.equal(dangling.ok, false);
	assert.ok(dangling.errors.some((error) => error.includes('nowhere')), dangling.errors.join('；'));
});

check('the same module may appear twice in one parent, each with its own ports', () => {
	const twice = {
		...overviewChart,
		nodes: [
			{ id: 'n1', label: '开始' },
			{ id: 'n2', module: 'landing', ports: ['入：走了这条路'] },
			{ id: 'n3', module: 'landing', ports: ['入：走了那条路'] },
		],
		edges: [{ from: 'n1', to: 'n2', when: '甲' }, { from: 'n1', to: 'n3', when: '乙' }],
	};
	const outcome = validateChart(twice, { knownModules: new Set(['landing']) });
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
});

check('the collection needs exactly one overview', () => {
	const none = validateCollection(new Map([['landing', moduleChart]]));
	assert.equal(none.errors.length, 1);
	assert.ok(none.errors[0].includes('总览'), none.errors[0]);

	const two = validateCollection(new Map([
		['overview', overviewChart],
		['outline', { ...overviewChart, id: 'outline' }],
	]));
	assert.equal(two.errors.length, 1);
	assert.ok(two.errors[0].includes('只能有一张'), two.errors[0]);

	const one = validateCollection(new Map([
		['overview', withModule()],
		['landing', moduleChart],
	]));
	assert.deepEqual(one.errors, []);
});

check('a reference to a chart that is not there is named on both ends', () => {
	const outcome = validateCollection(new Map([['overview', withModule()]]));
	assert.equal(outcome.errors.length, 1);
	assert.ok(outcome.errors[0].includes('overview'), outcome.errors[0]);
	assert.ok(outcome.errors[0].includes('landing'), outcome.errors[0]);
});

check('a reference cycle is reported as the path that closes it', () => {
	const a = { ...moduleChart, id: 'a', nodes: [{ id: 'x', label: '一' }, { id: 'y', module: 'b', ports: ['出：到 b'] }], edges: [{ from: 'x', to: 'y' }] };
	const b = { ...moduleChart, id: 'b', nodes: [{ id: 'x', label: '二' }, { id: 'y', module: 'a', ports: ['出：回 a'] }], edges: [{ from: 'x', to: 'y' }] };
	const outcome = validateCollection(new Map([
		['overview', overviewChart],
		['a', a],
		['b', b],
	]));
	assert.ok(outcome.errors.some((error) => error.includes('成环')), outcome.errors.join('；'));
	assert.ok(outcome.errors.some((error) => error.includes('a') && error.includes('b')), outcome.errors.join('；'));
});

check('an orphan chart is a warning, never an error', () => {
	const outcome = validateCollection(new Map([
		['overview', overviewChart],
		['landing', moduleChart],
	]));
	assert.deepEqual(outcome.errors, []);
	assert.equal(outcome.warnings.length, 1);
	assert.ok(outcome.warnings[0].includes('landing'), outcome.warnings[0]);
});

check('a layer wider than the page wraps instead of growing sideways', () => {
	// Without wrapping, eight module boxes on one layer are 1481px wide, so the
	// reader has to drag the pane left and right to read one diagram.
	const fan = (count) => ({
		nodes: [
			{ id: 's', label: '开始' },
			...Array.from({ length: count }, (_, index) => ({ id: `m${index}`, label: `模块 ${index + 1}` })),
			{ id: 'e', label: '结束' },
		],
		edges: [
			...Array.from({ length: count }, (_, index) => ({ from: 's', to: `m${index}`, when: `条件 ${index + 1}` })),
			...Array.from({ length: count }, (_, index) => ({ from: `m${index}`, to: 'e' })),
		],
	});
	const wide = renderFlowSvg(fan(15), '十五个模块');
	const width = Number(/<svg[^>]*width="(\d+)"/.exec(wide)[1]);
	assert.ok(width < 1400, `十五个模块画成 ${width}px 宽，读者得左右拖`);
	// The wrap is real: those boxes occupy several visual rows.
	const rows = new Set([...wide.matchAll(/data-row="(\d+)"/g)].map((match) => match[1]));
	assert.ok(rows.size > 3, `视觉行只有 ${rows.size} 个`);
	// Every box is still inside the canvas: wrapping moves boxes, it does not crop them.
	for (const match of wide.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="9"/g)) {
		const left = Number(match[1]);
		assert.ok(left >= 0 && left + Number(match[3]) <= width, `框在画布外：x=${left}, 画布宽 ${width}`);
	}
});

check('a continuation row sits closer than the next step', () => {
	// The gap is the only cue that two rows are one step: spaced like a step, the
	// reader reads a wrapped layer as two stages of the flow.
	const fan = (count) => ({
		nodes: [{ id: 's', label: '开始' }, ...Array.from({ length: count }, (_, index) => ({ id: `m${index}`, label: `模块 ${index + 1}` }))],
		edges: Array.from({ length: count }, (_, index) => ({ from: 's', to: `m${index}`, when: `条件 ${index + 1}` })),
	});
	const svg = renderFlowSvg(fan(9), '换行间距');
	const tops = new Map();
	for (const match of svg.matchAll(/data-layer="(\d+)" data-row="(\d+)"[^>]*>\s*<rect x="[-\d.]+" y="([\d.]+)"/g)) {
		tops.set(`${match[1]}:${match[2]}`, Number(match[3]));
	}
	const sameLayer = [...tops.entries()].filter(([key]) => key.startsWith('1:')).map(([, y]) => y).sort((a, b) => a - b);
	assert.ok(sameLayer.length > 1, JSON.stringify([...tops.keys()]));
	const wrapStep = sameLayer[1] - sameLayer[0];
	// The only other layer is the source row above it.
	const earlier = tops.get('0:0');
	const nextStep = sameLayer[0] - earlier;
	assert.ok(wrapStep < nextStep, `同层换行间距 ${wrapStep}，到上一层 ${nextStep}`);
});

check('the picture carries the ids the view needs to make it clickable', () => {
	const outcome = validateFlow(goodFlow);
	const plain = renderFlowSvg(outcome.flow, '可点');
	for (const node of outcome.flow.nodes) assert.ok(plain.includes(`data-node="${node.id}"`), node.id);
	// The separator is escaped in the attribute, which is how XML carries `>`.
	for (const edge of outcome.flow.edges) assert.ok(plain.includes(`data-edge="${edge.from}-&gt;${edge.to}"`));
	// The product written to disk has no drag handle: a handle on a diagram is
	// chrome the reader cannot use.
	assert.equal((plain.match(/data-handle=/g) ?? []).length, 0);
	const interactive = renderFlowSvg(outcome.flow, '可点', { interactive: true });
	assert.equal((interactive.match(/data-handle=/g) ?? []).length, outcome.flow.nodes.length);
});

check('a chart with more than six modules at the top is warned about', () => {
	const nodes = [{ id: 'n0', label: '开始' }];
	const edges = [];
	for (let index = 1; index <= 7; index += 1) {
		nodes.push({ id: `n${index}`, module: 'landing', ports: [`入：第 ${index} 条路`] });
		edges.push({ from: 'n0', to: `n${index}`, when: `条件 ${index}` });
	}
	const outcome = validateCollection(new Map([
		['overview', { ...overviewChart, nodes, edges }],
		['landing', moduleChart],
	]));
	assert.deepEqual(outcome.errors, []);
	assert.ok(outcome.warnings.some((warning) => warning.includes('7 个模块框')), outcome.warnings.join('；'));
});

check('deleting a chart that something points at, or the only overview, is refused', () => {
	const models = new Map([
		['overview', withModule()],
		['landing', moduleChart],
	]);
	const referenced = validateCollection(models, { removed: ['landing'] });
	assert.ok(referenced.errors.some((error) => error.includes('overview')), referenced.errors.join('；'));

	const theOverview = validateCollection(models, { removed: ['overview'] });
	assert.ok(theOverview.errors.some((error) => error.includes('总览')), theOverview.errors.join('；'));

	const clean = validateCollection(new Map([['overview', overviewChart], ['landing', moduleChart]]), { removed: ['landing'] });
	assert.deepEqual(clean.errors, []);
});

check('the revision is a hash of the canonical model, so reordering the same model agrees', () => {
	const first = revisionOf(overviewChart);
	const rebuilt = JSON.parse(JSON.stringify(overviewChart));
	assert.equal(revisionOf(rebuilt), first);
	// The canonical text fixes the key order, so two writers that build the same
	// model in a different field order still produce one revision.
	assert.equal(revisionOf({ edges: overviewChart.edges, nodes: overviewChart.nodes, scope: overviewChart.scope, name: overviewChart.name, kind: overviewChart.kind, id: overviewChart.id }), first);
	assert.equal(canonicalModel(overviewChart).startsWith('{\n\t"id"'), true);
	// A real edit changes it.
	assert.notEqual(revisionOf({ ...overviewChart, scope: '从别处到别处' }), first);
});

check('a chart round-trips through disk with its brief', () => {
	const specDir = specSandbox();
	const written = writeChartModel(specDir, overviewChart);
	assert.equal(written.path, chartModelPath(specDir, 'overview'));
	assert.equal(written.path, join(specDir, 'flows', 'overview.json'));
	assert.equal(chartImagePath(specDir, 'overview'), join(specDir, 'flows', 'overview.png'));
	assert.equal(chartBriefPath(specDir, 'overview'), join(specDir, 'flows', 'overview.brief.md'));

	writeChartBrief(specDir, 'overview', '# 总览\n\n## 目标\n看得懂。\n');
	assert.ok(readChartBrief(specDir, 'overview').includes('# 总览'));

	const { charts, problems } = readCollection(specDir);
	assert.deepEqual(problems, []);
	assert.equal(charts.get('overview').revision, written.revision);

	// An empty brief removes the file, so "no brief yet" has one representation.
	writeChartBrief(specDir, 'overview', '   ');
	assert.equal(readChartBrief(specDir, 'overview'), '');

	removeChartFiles(specDir, 'overview');
	assert.equal(readCollection(specDir).charts.size, 0);
});

check('a chart file that will not parse is reported and does not hide the rest', () => {
	const specDir = specSandbox();
	writeChartModel(specDir, overviewChart);
	writeFileSync(join(specDir, 'flows', 'broken.json'), '{ not json', 'utf8');
	const { charts, problems } = readCollection(specDir);
	assert.equal(charts.size, 1);
	assert.equal(problems.length, 1);
	assert.ok(problems[0].includes('broken'), problems[0]);
});

check('the reference graph reports parents and children both ways', () => {
	const models = new Map([
		['overview', withModule()],
		['landing', moduleChart],
	]);
	const graph = referenceGraph(models);
	assert.deepEqual(graph.parents.get('landing'), ['overview']);
	assert.deepEqual(graph.children.get('overview'), ['landing']);
	assert.deepEqual(graph.cycles, []);
	assert.deepEqual(parentsOf(models, 'landing'), ['overview']);
	assert.deepEqual(parentsOf(models, 'overview'), []);
});

check('a module box draws its name and ports, and the port lines stay inside the box', () => {
	const models = new Map([
		['overview', withModule()],
		['landing', moduleChart],
	]);
	const svg = renderFlowSvg(drawableChart(models.get('overview'), models), '图集：功能流程');
	assert.ok(svg.includes('落盘'), '框上要有子图的名字');
	assert.ok(svg.includes('入：图集已校验'));
	assert.ok(svg.includes('出：盘上有三件套'));
	// A module box carries a second, inset outline: it is a container, and the
	// outline says so before the reader parses the ports.
	const outlines = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="(\d)"/g)];
	const nested = outlines.filter((match) => match[5] === '7');
	assert.equal(nested.length, 1, JSON.stringify(outlines.map((match) => match[5])));
});

/* ---- deliverable classification ---- */

check('a deliverable write is classified by its target', () => {
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: 'hi' }, false).kind, 'agents');
	assert.equal(specDeliverableWrite('write', { path: 'docs/AGENTS.md', content: 'hi' }, false).kind, 'agents');
	// A chart brief is a chart's own file, not a landing deliverable: a person may
	// edit it freely and a model writes it through a tool that validates it.
	assert.equal(specDeliverableWrite('write', { path: '.spec/flows/overview.brief.md', content: 'hi' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: '.spec/flows/overview.json', content: '{}' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: '.spec/draft.md', content: 'x' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'docs/api.md', content: 'hi' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'README.md', content: 'hi' }, false), undefined);
	assert.equal(specDeliverableWrite('edit', { file_path: 'AGENTS.md' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: 'x' }, true), undefined);
});

/* ---- AGENTS.md ---- */

check('the line budget fires only above the limit', () => {
	assert.deepEqual(agentsMdAdvisories('a\nb\nc'), []);
	assert.equal(agentsMdAdvisories(Array.from({ length: 201 }, () => 'x').join('\n')).length, 1);
});

check('progress content is reported only on labelled structural lines', () => {
	const reports = (text) => progressAdvisories(text).length > 0;
	assert.equal(reports('# 规则\n\n- 临时文件放 tmp/。\n'), false);
	assert.equal(reports('## 现状\n\n已装入 profile。\n'), true);
	assert.equal(reports('- 待办：补测试。\n'), true);
	assert.equal(reports('**下一步**：升级宿主。\n'), true);
	assert.equal(reports('## 里程碑\n'), true);
	assert.equal(reports('## 变更记录\n'), true);
	// Prose that merely uses a status word is not a progress section.
	assert.equal(reports('折叠对无关事件必须返回同一个引用，否则投影的增量机制失效。\n'), false);
	// The rule that forbids progress content is not progress content.
	assert.equal(reports('- AGENTS.md 只放文档索引与规范规则，不写进度类内容。\n'), false);
	assert.equal(reports('- 落盘的规范文件里不写现状、待办与里程碑。\n'), false);
	assert.deepEqual(progressAdvisories('   '), []);
});

check('one AGENTS.md write collects both its checks', () => {
	const body = `${Array.from({ length: 201 }, () => 'x').join('\n')}\n\n## 现状\n\n已装入。\n`;
	assert.equal(deliverableAdvisories(body).length, 2);
});

console.log(`\n${passed} checks passed`);
