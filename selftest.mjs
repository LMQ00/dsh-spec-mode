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
import { canonicalMarkdown, chartPath, parseChartMarkdown, revisionOf } from './chart-md.js';
import {
	drawableChart,
	kindOf,
	parentsOf,
	readChartBrief,
	readCollection,
	referenceGraph,
	removeChartFiles,
	validateChart,
	validateCollection,
	writeChart,
} from './flows.js';
import { backEdgesOf, drawMermaid, parseMermaid } from './mermaid-graph.js';
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
	assert.deepEqual(specDeliverableWrite('write', { file_path: '.spec/flows/overview.md', content: '# x' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: '# x' }, false).kind, 'agents');
});

/* ---- mermaid graph ---- */

/** A well-formed diagram, as a person would write it in the file. */
const goodSource = [
	'flowchart LR',
	'  n1["用户输入 /spec，模式打开"]',
	'  n2["模型把需求逐条写进草稿"]',
	'  n3["用户补充需求，草稿增量更新"]',
	'  n4["用户确认后写产物"]',
	'  n1 --> n2',
	'  n2 -->|还有没问到的| n3',
	'  n2 -->|一次说清| n4',
	'  n3 --> n4',
].join('\n');

/**
 * Wrap a list of diagram lines into a chart the validators take.
 * @param {object} over - fields to override on the base chart.
 * @returns {object} the chart.
 */
function chartOf(over = {}) {
	return { id: 'overview', name: '总览', scope: '从用户提出想法到产物写回盘上', source: goodSource, brief: '', ...over };
}

check('a well-formed diagram parses and validates', () => {
	const parsed = parseMermaid(goodSource);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
	assert.equal(parsed.graph.direction, 'LR');
	assert.deepEqual(parsed.graph.nodes.map((node) => node.id), ['n1', 'n2', 'n3', 'n4']);
	assert.deepEqual(parsed.graph.edges.map((edge) => `${edge.from}>${edge.to}`), ['n1>n2', 'n2>n3', 'n2>n4', 'n3>n4']);
	const checked = validateChart(chartOf());
	assert.equal(checked.ok, true, JSON.stringify(checked.errors));
});

check('a diagram has exactly one entry', () => {
	// One procedure starts in one place; two sources means two stories stacked.
	const twoStarts = validateChart(chartOf({
		source: 'flowchart LR\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> C\n  B --> C\n',
	}));
	assert.equal(twoStarts.ok, false);
	assert.ok(twoStarts.errors[0].includes('起点'), twoStarts.errors.join('；'));

	// Several exits are legitimate: an attempt can end in more than one way —
	// but a branch has to carry the condition that picks it.
	const twoEnds = validateChart(chartOf({
		source: 'flowchart LR\n  A["a"]\n  B["b"]\n  C["c"]\n  A -->|用户批准| B\n  A -->|用户拒绝| C\n',
	}));
	assert.equal(twoEnds.ok, true, JSON.stringify(twoEnds.errors));

	const silentBranch = validateChart(chartOf({
		source: 'flowchart LR\n  A["a"]\n  B["b"]\n  C["c"]\n  A --> B\n  A --> C\n',
	}));
	assert.equal(silentBranch.ok, false);
	assert.ok(silentBranch.errors[0].includes('条件'), silentBranch.errors.join('；'));

	// A condition on the only way out reads as "there is another way", which the
	// picture does not show.
	const lonelyCondition = validateChart(chartOf({
		source: 'flowchart LR\n  A["a"]\n  B["b"]\n  A -->|一定| B\n',
	}));
	assert.equal(lonelyCondition.ok, false);
	assert.ok(lonelyCondition.errors[0].includes('不用写条件'), lonelyCondition.errors.join('；'));

	// Two arrows out of one box under the same words cannot be told apart.
	const sameWords = validateChart(chartOf({
		source: 'flowchart LR\n  A["a"]\n  B["b"]\n  C["c"]\n  A -->|通过| B\n  A -->|通过| C\n',
	}));
	assert.equal(sameWords.ok, false);
	assert.ok(sameWords.errors[0].includes('分不出'), sameWords.errors.join('；'));
});

check('a retry is a loop and stays one', () => {
	// Unrolling a retry makes the picture claim the step happens once.
	const source = [
		'flowchart LR',
		'  n1["提问"]',
		'  n2["等回答"]',
		'  n3["写进草稿"]',
		'  n1 --> n2',
		'  n2 --> n3',
		'  n3 --> n1',
	].join('\n');
	const outcome = validateChart(chartOf({ source }));
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	assert.deepEqual([...backEdgesOf(outcome.graph)], ['n3->n1']);
	// A self-loop is not a retry, it is a box that does nothing.
	const loop = validateChart(chartOf({ source: 'flowchart LR\n  A["a"]\n  B["b"]\n  A --> B\n  B --> B\n' }));
	assert.equal(loop.ok, false);
	assert.ok(loop.errors[0].includes('自己'), loop.errors.join('；'));
});

check('a module box names the chart it points at and carries its ports', () => {
	const source = [
		'flowchart LR',
		'  n1["开始"]',
		'  n2[["landing<br/>入：图集已校验<br/>出：盘上有图"]]',
		'  n1 --> n2',
	].join('\n');
	const outcome = validateChart(chartOf({ source }), { knownModules: new Set(['landing']) });
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	const box = outcome.graph.nodes.find((node) => node.id === 'n2');
	assert.equal(box.module, 'landing');
	assert.deepEqual(box.ports, ['入：图集已校验', '出：盘上有图']);

	// Without ports the reader cannot tell where the module attaches.
	const noPorts = validateChart(chartOf({
		source: 'flowchart LR\n  n1["开始"]\n  n2[["landing"]]\n  n1 --> n2\n',
	}), { knownModules: new Set(['landing']) });
	assert.equal(noPorts.ok, false);
	assert.ok(noPorts.errors.some((error) => error.includes('端口')), noPorts.errors.join('；'));

	// A box that points at nothing would be a door to an empty room.
	const dangling = validateChart(chartOf({
		source: 'flowchart LR\n  n1["开始"]\n  n2[["nowhere<br/>出：写好了"]]\n  n1 --> n2\n',
	}), { knownModules: new Set(['landing']) });
	assert.equal(dangling.ok, false);
	assert.ok(dangling.errors.some((error) => error.includes('nowhere')), dangling.errors.join('；'));
});

check('the same module may appear twice in one parent, each with its own ports', () => {
	const source = [
		'flowchart LR',
		'  n1["开始"]',
		'  n2[["landing<br/>入：走了这条路"]]',
		'  n3[["landing<br/>入：走了那条路"]]',
		'  n1 -->|甲| n2',
		'  n1 -->|乙| n3',
	].join('\n');
	const outcome = validateChart(chartOf({ source }), { knownModules: new Set(['landing']) });
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
});

check('a diagram the host cannot read is refused with the line number', () => {
	const cases = [
		['没有头', 'n1["a"]\n  n2["b"]\n  n1 --> n2\n', 'flowchart LR'],
		['子图', 'flowchart LR\n  subgraph 一组\n  n1["a"]\n  end\n  n2["b"]\n  n1 --> n2\n', 'subgraph'],
		['括号不成对', 'flowchart LR\n  n1["a"\n  n2["b"]\n  n1 --> n2\n', '不成对'],
		['箭头后没节点', 'flowchart LR\n  n1["a"]\n  n2["b"]\n  n1 -->\n', '箭头'],
		['只有节点', 'flowchart LR\n  n1["a"]\n  n2["b"]\n', '连线'],
		['一个节点', 'flowchart LR\n  n1["a"]\n', '至少两个'],
	];
	for (const [name, source, expected] of cases) {
		const outcome = validateChart(chartOf({ source }));
		assert.equal(outcome.ok, false, name);
		assert.ok(outcome.errors.some((error) => error.includes(expected)), `${name}: ${outcome.errors.join('；')}`);
	}
});

check('a box that explains itself is refused', () => {
	const reject = (label) => validateChart(chartOf({
		source: `flowchart LR\n  n1["${label}"]\n  n2["下一步"]\n  n1 --> n2\n`,
	}));
	assert.ok(reject('因为要校验').errors[0].includes('理由'), '理由说明');
	assert.ok(reject('`validateChart()`').errors[0].includes('代码'), '代码');
	assert.ok(reject('/home/someone/app').errors[0].includes('绝对路径'), '绝对路径');
	// The words sit inside mermaid's own quotes, so a quote or an angle bracket in
	// them would end the label or start markup.
	assert.ok(reject('他说"不行"').errors[0].includes('双引号'), '双引号');
	assert.ok(reject('少于<br/>三秒').errors[0].includes('<'), '尖括号');
	// A chart's title is copied into every parent's box, so it obeys the same rule.
	const title = validateChart(chartOf({ name: '他说"不行"' }));
	assert.equal(title.ok, false);
	assert.ok(title.errors.some((error) => error.startsWith('chart.name')), title.errors.join('；'));
	// Two boxes with the same words are indistinguishable in the picture.
	const same = validateChart(chartOf({
		source: 'flowchart LR\n  A["一样"]\n  B["一样"]\n  A --> B\n',
	}));
	assert.equal(same.ok, false);
	assert.ok(same.errors.some((error) => error.includes('一字不差')), same.errors.join('；'));
});

check('a diagram survives a round trip through its own writer', () => {
	const first = parseMermaid(goodSource);
	assert.equal(first.ok, true);
	const text = drawMermaid(first.graph);
	const second = parseMermaid(text);
	assert.equal(second.ok, true, JSON.stringify(second.errors));
	// Same boxes, same arrows, same words — the line they sit on follows the
	// writer's layout, so it is compared through what the reader sees.
	const shapeOf = (graph) => ({
		direction: graph.direction,
		nodes: graph.nodes.map((node) => `${node.id}:${node.label ?? node.module}:${(node.ports ?? []).join('|')}`),
		edges: graph.edges.map((edge) => `${edge.from}>${edge.to}:${edge.when ?? ''}`),
	});
	assert.deepEqual(shapeOf(second.graph), shapeOf(first.graph));
	// The module box writes its ports back as separate lines, which is what makes
	// the text editable by hand.
	const moduleText = drawMermaid({
		direction: 'LR',
		nodes: [{ id: 'n1', label: 'a' }, { id: 'n2', module: 'landing', ports: ['入：甲', '出：乙'] }],
		edges: [{ from: 'n1', to: 'n2' }],
	});
	assert.ok(moduleText.includes('n2[["landing<br/>入：甲<br/>出：乙"]]'), moduleText);
});

/* ---- chart files ---- */

/** A module chart the overview can point at. */
const moduleChart = chartOf({
	id: 'landing',
	name: '落盘',
	scope: '从确认到写文件',
	source: 'flowchart LR\n  m1["用户确认"]\n  m2["工具写文件"]\n  m1 --> m2\n',
});

/**
 * The overview with a module box added, for the checks that need one.
 * @param {string[]} ports - the ports on the module box.
 * @returns {object} the chart.
 */
function withModule(ports = ['入：图集已校验', '出：盘上有图']) {
	return chartOf({
		source: [
			'flowchart LR',
			'  n1["用户提出想法"]',
			`  n2[["landing${ports.map((port) => `<br/>${port}`).join('')}"]]`,
			'  n1 --> n2',
		].join('\n'),
	});
}

/**
 * Build one collection entry the way `readCollection` would.
 * @param {object} chart - the chart.
 * @returns {{ chart: object, graph: object, revision: string }} the entry.
 */
function entryOf(chart) {
	const outcome = validateChart(chart);
	assert.equal(outcome.ok, true, JSON.stringify(outcome.errors));
	return { chart: outcome.chart, graph: outcome.graph, revision: revisionOf(canonicalMarkdown(outcome.chart)) };
}

/** A temporary `.spec` directory for the checks that write files. */
function specSandbox() {
	const root = mkdtempSync(join(tmpdir(), 'spec-flows-'));
	const specDir = join(root, '.spec');
	mkdirSync(specDir, { recursive: true });
	return specDir;
}

check('a chart file opens as the same chart that was written', () => {
	const text = canonicalMarkdown({ ...chartOf(), brief: '### 目标\n看得懂。\n' });
	const parsed = parseChartMarkdown('overview', text);
	assert.equal(parsed.broken, undefined);
	assert.equal(parsed.chart.id, 'overview');
	assert.equal(parsed.chart.name, '总览');
	assert.equal(parsed.chart.scope, '从用户提出想法到产物写回盘上');
	assert.equal(parsed.chart.source.trim(), goodSource);
	assert.ok(parsed.chart.brief.includes('看得懂'));
	// Writing what was read produces the same bytes, so a save that changes
	// nothing leaves the revision alone.
	assert.equal(canonicalMarkdown({ ...parsed.chart }), text);
});

check('a file missing one of its parts names the part', () => {
	const ok = { ...chartOf(), brief: '' };
	assert.ok(parseChartMarkdown('x', canonicalMarkdown(ok).replace('# 总览\n', '')).broken.includes('标题'));
	assert.ok(parseChartMarkdown('x', canonicalMarkdown(ok).replace('```mermaid', '```text')).broken.includes('mermaid'));
	assert.ok(parseChartMarkdown('x', canonicalMarkdown(ok).replace('从用户提出想法到产物写回盘上\n', '')).broken.includes('范围'));
	assert.ok(parseChartMarkdown('x', canonicalMarkdown(ok).replace('```\n\n## 简报', '\n\n## 简报')).broken.includes('闭合'));
});

check('the revision is a hash of the file, so the same text agrees and an edit does not', () => {
	const first = revisionOf(canonicalMarkdown(chartOf()));
	assert.equal(revisionOf(canonicalMarkdown(chartOf())), first);
	assert.notEqual(revisionOf(canonicalMarkdown(chartOf({ scope: '从别处到别处' }))), first);
	// The brief is part of the same file, so editing it changes the revision too.
	assert.notEqual(revisionOf(canonicalMarkdown({ ...chartOf(), brief: '### 目标\n改了。' })), first);
});

check('a chart round-trips through disk with its brief', () => {
	const specDir = specSandbox();
	const written = writeChart(specDir, { ...chartOf(), brief: '### 目标\n看得懂。\n' });
	assert.equal(written.path, chartPath(specDir, 'overview'));
	assert.equal(written.path, join(specDir, 'flows', 'overview.md'));

	const { charts, problems } = readCollection(specDir);
	assert.deepEqual(problems, []);
	assert.equal(charts.get('overview').revision, written.revision);
	assert.equal(readChartBrief(specDir, 'overview'), '### 目标\n看得懂。');

	// An empty brief is one representation: an empty section, not a missing file.
	const blank = writeChart(specDir, chartOf());
	assert.equal(readChartBrief(specDir, 'overview'), '');
	assert.notEqual(blank.revision, written.revision);

	removeChartFiles(specDir, 'overview');
	assert.equal(readCollection(specDir).charts.size, 0);
});

check('a chart file that will not parse is reported and does not hide the rest', () => {
	const specDir = specSandbox();
	writeChart(specDir, chartOf());
	writeFileSync(join(specDir, 'flows', 'broken.md'), 'no title here\n', 'utf8');
	const { charts, problems } = readCollection(specDir);
	assert.equal(charts.size, 1);
	assert.equal(problems.length, 1);
	assert.ok(problems[0].includes('broken'), problems[0]);
});

check('a module box draws the name of the chart it points at', () => {
	const entries = new Map([
		['overview', entryOf(withModule())],
		['landing', entryOf(moduleChart)],
	]);
	const drawn = drawableChart(entries.get('overview'), entries);
	assert.ok(drawn.includes('n2[["落盘<br/>入：图集已校验<br/>出：盘上有图"]]'), drawn);

	// Renaming the module chart changes the parent's box without touching the
	// parent's file — that is why the name is not stored in the parent.
	const renamed = new Map(entries);
	renamed.set('landing', entryOf({ ...moduleChart, name: '写入磁盘' }));
	assert.ok(drawableChart(renamed.get('overview'), renamed).includes('n2[["写入磁盘<br/>'));
});

check('the collection needs a chart filed as overview', () => {
	const none = validateCollection(new Map([['landing', entryOf(moduleChart)]]));
	assert.equal(none.errors.length, 1);
	assert.ok(none.errors[0].includes('总览'), none.errors[0]);

	const one = validateCollection(new Map([
		['overview', entryOf(withModule())],
		['landing', entryOf(moduleChart)],
	]));
	assert.deepEqual(one.errors, []);
});

check('a reference to a chart that is not there is named on both ends', () => {
	const outcome = validateCollection(new Map([['overview', entryOf(withModule())]]));
	assert.equal(outcome.errors.length, 1);
	assert.ok(outcome.errors[0].includes('overview'), outcome.errors[0]);
	assert.ok(outcome.errors[0].includes('landing'), outcome.errors[0]);
});

check('a reference cycle is reported as the path that closes it', () => {
	const a = entryOf(chartOf({
		id: 'a',
		source: 'flowchart LR\n  x["一"]\n  y[["b<br/>出：到 b"]]\n  x --> y\n',
	}));
	const b = entryOf(chartOf({
		id: 'b',
		source: 'flowchart LR\n  x["二"]\n  y[["a<br/>出：回 a"]]\n  x --> y\n',
	}));
	const outcome = validateCollection(new Map([['overview', entryOf(chartOf())], ['a', a], ['b', b]]));
	assert.ok(outcome.errors.some((error) => error.includes('成环')), outcome.errors.join('；'));
	assert.ok(outcome.errors.some((error) => error.includes('a') && error.includes('b')), outcome.errors.join('；'));
});

check('an orphan chart is a warning, never an error', () => {
	const outcome = validateCollection(new Map([
		['overview', entryOf(chartOf())],
		['landing', entryOf(moduleChart)],
	]));
	assert.deepEqual(outcome.errors, []);
	assert.equal(outcome.warnings.length, 1);
	assert.ok(outcome.warnings[0].includes('landing'), outcome.warnings[0]);
});

check('a chart with more than six module boxes is warned about', () => {
	const source = ['flowchart LR', '  n0["开始"]'];
	const edges = [];
	for (let index = 1; index <= 7; index += 1) {
		source.push(`  n${index}[["landing<br/>入：第 ${index} 条路"]]`);
		edges.push(`  n0 -->|条件 ${index}| n${index}`);
	}
	const outcome = validateCollection(new Map([
		['overview', entryOf(chartOf({ source: [...source, ...edges].join('\n') }))],
		['landing', entryOf(moduleChart)],
	]));
	assert.deepEqual(outcome.errors, []);
	assert.ok(outcome.warnings.some((warning) => warning.includes('7 个模块框')), outcome.warnings.join('；'));
});

check('deleting a chart that something points at, or the overview, is refused', () => {
	const charts = new Map([
		['overview', entryOf(withModule())],
		['landing', entryOf(moduleChart)],
	]);
	const referenced = validateCollection(charts, { removed: ['landing'] });
	assert.ok(referenced.errors.some((error) => error.includes('overview')), referenced.errors.join('；'));

	const theOverview = validateCollection(charts, { removed: ['overview'] });
	assert.ok(theOverview.errors.some((error) => error.includes('总览')), theOverview.errors.join('；'));

	// A chart nothing points at goes without a word.
	const spare = new Map(charts);
	spare.set('spare', entryOf(chartOf({ id: 'spare', source: 'flowchart LR\n  p1["甲"]\n  p2["乙"]\n  p1 --> p2\n' })));
	assert.deepEqual(validateCollection(spare, { removed: ['spare'] }).errors, []);
});

check('the reference graph reports parents and children both ways', () => {
	const charts = new Map([
		['overview', entryOf(withModule())],
		['landing', entryOf(moduleChart)],
	]);
	const graph = referenceGraph(charts);
	assert.deepEqual(graph.parents.get('landing'), ['overview']);
	assert.deepEqual(graph.children.get('overview'), ['landing']);
	assert.deepEqual(graph.cycles, []);
	assert.deepEqual(parentsOf(charts, 'landing'), ['overview']);
	assert.deepEqual(parentsOf(charts, 'overview'), []);
});

check('the kind of a chart is its id, not a field someone has to remember', () => {
	assert.equal(kindOf('overview'), 'overview');
	assert.equal(kindOf('landing'), 'module');
	assert.equal(kindOf('overview-ish'), 'module');
});

/* ---- deliverable classification ---- */

check('a deliverable write is classified by its target', () => {
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: 'hi' }, false).kind, 'agents');
	assert.equal(specDeliverableWrite('write', { path: 'docs/AGENTS.md', content: 'hi' }, false).kind, 'agents');
	// A chart brief is a chart's own file, not a landing deliverable: a person may
	// edit it freely and a model writes it through a tool that validates it.
	assert.equal(specDeliverableWrite('write', { path: '.spec/flows/overview.md', content: 'hi' }, false), undefined);
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
