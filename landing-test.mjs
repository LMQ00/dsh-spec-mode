/**
 * Drives the plugin's real `apply()` against a fake Cordis context, so the
 * landing path — validate, review, write, delete, exit — runs end to end without
 * a Host. The pure-logic suite cannot reach `execute` at all: it only sees the
 * modules, and the landing step is where a bug strands a session (mode exited,
 * files unwritten).
 *
 * Run: node landing-test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './index.js';

let passed = 0;
function check(label, fn) {
	fn();
	passed += 1;
	console.log(`ok - ${label}`);
}

/* ---- fake Cordis context ---- */

function makeContext(projectDir, { answers = [] } = {}) {
	const registered = { tools: [], guards: [], sections: [], projections: [], commands: [], listeners: new Map() };
	const asked = [];
	const ctx = {
		sessionProjections: {
			register: (unit) => {
				registered.projections.push(unit);
				ctx._unit = unit;
				return { stateOf: () => ctx._state };
			},
			stateOf: (_session, key) => (key === 'spec' ? ctx._state : undefined),
		},
		systemPrompt: {
			getSectionOrder: () => 0,
			section: (definition) => registered.sections.push(definition),
		},
		tools: {
			register: (definition, options) => registered.tools.push({ definition, options }),
			guard: (fn) => registered.guards.push(fn),
		},
		inject: (_deps, fn) => fn({
			commands: { register: (definition) => registered.commands.push(definition) },
		}),
		get: (name) => {
			if (name === 'userQuestions') {
				return {
					ask: async (request) => {
						asked.push(request);
						const answer = answers.shift() ?? { answers: [] };
						return answer;
					},
				};
			}
			return undefined;
		},
		on: (event, handler) => {
			if (!registered.listeners.has(event)) registered.listeners.set(event, []);
			registered.listeners.get(event).push(handler);
		},
		_state: { active: false, running: null, exitCall: null },
	};
	ctx._registered = registered;
	ctx._asked = asked;
	ctx._projectDir = projectDir;
	apply(ctx);
	return ctx;
}

const session = (cwd) => ({ header: { cwd }, append() {} });

const goodArgs = (title) => ({
	brief: {
		title: `记 <${title}> 的需求`,
		goal: '用户在列表页能导出当前筛选结果为 CSV。',
		requirements: ['列表页右上角有「导出」按钮。', '导出范围是当前筛选结果。'],
		acceptance: ['1000 条导出后文件 1001 行（含表头）。'],
		constraints: ['只做 CSV。'],
	},
	flow: {
		nodes: [
			{ id: 'N1', label: '用户点击导出按钮' },
			{ id: 'N2', label: '页面按当前筛选读取账单' },
			{ id: 'N3', label: '浏览器开始下载 CSV 文件' },
		],
		edges: [{ from: 'N1', to: 'N2' }, { from: 'N2', to: 'N3' }],
	},
});

const approve = { answers: [{ id: 'spec-review', selected: ['退出并落盘'] }] };
const decline = { answers: [{ id: 'spec-review', selected: ['继续访谈'] }] };

const sandbox = mkdtempSync(join(tmpdir(), 'spec-landing-'));
const project = join(sandbox, 'project');
mkdirSync(join(project, '.git'), { recursive: true });

/* ---- registration ---- */

check('apply registers the projection, the section, the command, the tool and the guard', () => {
	const ctx = makeContext(project);
	const r = ctx._registered;
	assert.equal(r.projections.length, 1);
	assert.equal(r.projections[0].key, 'spec');
	assert.equal(r.projections[0].stateVersion, 1);
	assert.equal(r.sections.length, 1);
	assert.equal(r.sections[0].name, 'spec:policy');
	assert.equal(r.commands.length, 1);
	assert.equal(r.commands[0].name, 'spec');
	assert.equal(r.tools.length, 1);
	assert.equal(r.tools[0].definition.name, 'spec_resolve');
	assert.equal(r.guards.length, 1);
	assert.ok(r.listeners.has('tools/post-execute'));
	assert.ok(r.listeners.has('agent/created'));
});

check('the prompt section is empty while the mode is off and non-empty while it is on', () => {
	const ctx = makeContext(project);
	const section = ctx._registered.sections[0];
	const agent = { session: session(project) };
	ctx._state = { active: false, running: null, exitCall: null };
	assert.equal(section.text({ agent }), '');
	ctx._state = { active: true, running: null, exitCall: null };
	const text = section.text({ agent });
	assert.ok(text.includes('## Spec mode'));
	assert.ok(text.includes('.spec/draft.md'));
	assert.ok(text.includes('brief'));
	assert.ok(text.includes('flow'));
	assert.equal(section.text({}), '');
});

/* ---- reviewed landing ---- */

check('a rejection keeps the mode and writes nothing', async () => {
	const dir = join(sandbox, 'reject');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [decline] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const agent = { session: session(dir) };
	let threw;
	try {
		await tool.execute(goodArgs('reject'), { agent, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined, '驳回必须抛错');
	assert.ok(threw.message.includes('保持开启'));
	assert.equal(existsSync(join(dir, '.spec', 'brief.md')), false);
	assert.equal(existsSync(join(dir, '.spec', 'flow.md')), false);
});

check('a validation failure throws before the review box opens', async () => {
	const dir = join(sandbox, 'invalid');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const agent = { session: session(dir) };
	const broken = goodArgs('invalid');
	broken.brief.requirements = ['先做导出，因为用户要求。'];
	let threw;
	try {
		await tool.execute(broken, { agent, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined);
	assert.ok(threw.message.includes('brief.requirements[0]'));
	assert.ok(threw.message.includes('理由'));
	assert.equal(ctx._asked.length, 0, '校验不过时不得弹框');
});

check('an approval writes the brief and a chart image, deletes the draft', async () => {
	const dir = join(sandbox, 'approve');
	mkdirSync(join(dir, '.git'), { recursive: true });
	mkdirSync(join(dir, '.spec'), { recursive: true });
	writeFileSync(join(dir, '.spec', 'draft.md'), '# 草稿\n\n未决：无\n', 'utf8');
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const agent = { session: session(dir) };
	const value = await tool.execute(goodArgs('approve'), { agent, signal: undefined });

	assert.equal(value.exited, true);
	assert.equal(value.briefPath, join(dir, '.spec', 'brief.md'));
	// Either format is a legitimate landing: a machine with no rasterizer keeps
	// the SVG, and the preview shows it just the same.
	assert.ok(
		value.flowPath === join(dir, '.spec', 'flow.png') || value.flowPath === join(dir, '.spec', 'flow.svg'),
		value.flowPath,
	);

	const brief = readFileSync(value.briefPath, 'utf8');
	assert.ok(brief.startsWith('# 记 <approve> 的需求\n'));
	assert.ok(brief.includes('## 目标'));
	assert.ok(brief.includes('## 要做什么'));
	assert.ok(brief.includes('## 验收'));
	assert.ok(brief.includes('## 约束'));

	// The chart is a picture: PNG bytes, or SVG source when no renderer exists.
	const chart = readFileSync(value.flowPath);
	if (value.flowPath.endsWith('.png')) {
		assert.equal(chart.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 头');
		assert.ok(chart.length > 1000, `图片太小：${chart.length}`);
	} else {
		const svg = chart.toString('utf8');
		assert.ok(svg.startsWith('<svg'));
		assert.ok(svg.includes('用户点击导出按钮'));
	}

	assert.equal(existsSync(join(dir, '.spec', 'draft.md')), false, '草稿必须被删掉');
	assert.equal(ctx._asked.length, 1, '批准前弹过一次框');
	assert.ok(ctx._asked[0].questions[0].detail.includes('== 需求简报'));
	assert.ok(ctx._asked[0].questions[0].detail.includes('== 功能流程图'));
	assert.ok(ctx._asked[0].questions[0].detail.includes('用户点击导出按钮'), '确认框要列出图上那些框');
});

check('a missing draft is not a landing failure', async () => {
	const dir = join(sandbox, 'nodraft');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const value = await tool.execute(goodArgs('nodraft'), { agent: { session: session(dir) }, signal: undefined });
	assert.equal(value.exited, true);
	assert.ok(existsSync(value.briefPath));
});

check('calling the tool outside the mode throws', async () => {
	const dir = join(sandbox, 'off');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: false, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	let threw;
	try {
		await tool.execute(goodArgs('off'), { agent: { session: session(dir) }, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined);
	assert.ok(threw.message.includes('只能在 spec mode 中调用'));
	assert.equal(ctx._asked.length, 0);
});

check('an unwritable target keeps the mode and leaves the draft alone', async () => {
	const dir = join(sandbox, 'readonly');
	mkdirSync(join(dir, '.git'), { recursive: true });
	// `.spec` exists as a FILE, so creating the directory and writing into it fails.
	writeFileSync(join(dir, '.spec'), 'not a directory', 'utf8');
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	let threw;
	try {
		await tool.execute(goodArgs('readonly'), { agent: { session: session(dir) }, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined);
	assert.ok(threw.message.includes('落盘失败'), threw.message);
	assert.ok(threw.message.includes('.spec'), threw.message);
});

/* ---- guard ---- */

check('the guard only lets the draft through while the mode is on', () => {
	const dir = join(sandbox, 'guard');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir);
	const guard = ctx._registered.guards[0];
	const agent = { session: session(dir) };
	const runGuard = (name, args) => guard({ name, arguments: args, agent });

	ctx._state = { active: false, running: null, exitCall: null };
	assert.equal(runGuard('write', { file_path: 'README.md' }), undefined, '模式关着时放行');

	ctx._state = { active: true, running: null, exitCall: null };
	assert.equal(runGuard('write', { file_path: 'README.md' }), 'Spec mode: 工作树只读。访谈结论写入 ' + join(dir, '.spec', 'draft.md') + '；要改代码先运行 /spec off。');
	assert.ok(runGuard('write', { file_path: '.spec/brief.md' }) !== undefined, '.spec 产物同样被拦');
	assert.ok(runGuard('write', { file_path: '.spec/flow.md' }) !== undefined);
	assert.equal(runGuard('write', { file_path: join(dir, '.spec', 'draft.md') }), undefined);
	assert.equal(runGuard('edit', { file_path: '.spec/draft.md' }), undefined);
	assert.equal(runGuard('read', { file_path: 'README.md' }), undefined);
	assert.equal(runGuard('write', { file_path: 'local://x' }), undefined, '协议路径放行');
	assert.ok(runGuard('delete_file', { file_path: join(dir, '.spec', 'draft.md') }) !== undefined, '草稿不可删');
	assert.equal(runGuard('delete_file', { file_path: 'README.md' }), undefined);
});

/* ---- advisories ---- */

check('a product write during a landing is reported, and one outside it is not', async () => {
	const dir = join(sandbox, 'advisory');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir);
	const listener = ctx._registered.listeners.get('tools/post-execute')[0];
	const agent = { session: session(dir) };
	const next = async () => ({ kind: 'accept' });
	const badBrief = '# t\n\n## 目标\ngoal\n\n## 要做什么\n- a\n\n## 验收\n';

	ctx._state = { active: false, running: null, exitCall: null };
	const outside = await listener(
		{ name: 'write', arguments: { file_path: join(dir, '.spec', 'brief.md'), content: badBrief }, agent },
		{ isError: false },
		next,
	);
	assert.equal(outside.additionalContexts, undefined, '不在 spec 工作期间不提醒');

	ctx._state = { active: true, running: null, exitCall: null };
	const inside = await listener(
		{ name: 'write', arguments: { file_path: join(dir, '.spec', 'brief.md'), content: badBrief }, agent },
		{ isError: false },
		next,
	);
	assert.equal(inside.additionalContexts.length, 1);
	assert.ok(inside.additionalContexts[0].content[0].text.includes('brief.md 不合格'));
	assert.ok(inside.additionalContexts[0].source.summary.includes('简报检查'));

	const draftWrite = await listener(
		{ name: 'write', arguments: { file_path: join(dir, '.spec', 'draft.md'), content: badBrief }, agent },
		{ isError: false },
		next,
	);
	assert.equal(draftWrite.additionalContexts, undefined, '草稿不检查');
});

check('the AGENTS.md line budget reports outside the mode too', async () => {
	const dir = join(sandbox, 'budget');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir);
	const listener = ctx._registered.listeners.get('tools/post-execute')[0];
	const agent = { session: session(dir) };
	ctx._state = { active: false, running: null, exitCall: null };
	const long = Array.from({ length: 201 }, () => 'x').join('\n');
	const decision = await listener(
		{ name: 'write', arguments: { file_path: join(dir, 'AGENTS.md'), content: long }, agent },
		{ isError: false },
		async () => ({ kind: 'accept' }),
	);
	assert.equal(decision.additionalContexts.length, 1);
	assert.ok(decision.additionalContexts[0].content[0].text.includes('200 行'));
});

console.log(`\n${passed} checks passed`);
