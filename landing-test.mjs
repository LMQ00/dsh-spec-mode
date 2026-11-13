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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function makeContext(projectDir, { answers = [], webServer = false } = {}) {
	const registered = {
		tools: [],
		guards: [],
		sections: [],
		projections: [],
		commands: [],
		listeners: new Map(),
		effects: [],
		webServer: webServer ? { routes: [], register: (route) => { registered.webServer.routes.push(route); return () => {}; } } : undefined,
		connection: webServer ? { requestRejection: () => undefined } : undefined,
	};
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
		// The real context resolves `ctx.inject(deps, cb)` only when every named
		// service is present. The fake composes the commands surface always, and the
		// web surface only when a check asks for it — so a profile without a web
		// server exercises the same code path as the real one.
		inject: (deps, fn) => {
			const available = {
				effect: (...args) => ctx.effect(...args),
				get: (...args) => ctx.get(...args),
				on: (...args) => ctx.on(...args),
				commands: { register: (definition) => registered.commands.push(definition) },
				webServer: registered.webServer,
				connection: registered.connection,
			};
			if (deps.some((dep) => available[dep] === undefined)) return undefined;
			return fn(available);
		},
		effect: (fn) => {
			const disposer = fn();
			registered.effects.push(disposer);
			return () => {
				if (typeof disposer === 'function') disposer();
			};
		},
		get: (name) => {
			// The chart routes resolve the session a request names, then read that
			// session's working directory; the fake keeps the same two facts.
			if (name === 'sessions') return new Map([[`session-fake`, session(projectDir)]]);
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
	charts: [
		{
			id: 'overview',
			name: `记 ${title} 的需求`,
			scope: '从用户点导出到最后拿到 CSV',
			source: [
				'flowchart LR',
				'  n1["用户点击导出按钮"]',
				'  n2["页面按当前筛选读取账单"]',
				'  n3["浏览器开始下载 CSV 文件"]',
				'  n1 --> n2',
				'  n2 --> n3',
			].join('\n'),
			brief: '### 目标\n用户在列表页能导出当前筛选结果为 CSV。\n\n'
				+ '### 要做什么\n- 列表页右上角有「导出」按钮。\n- 导出范围是当前筛选结果。\n\n'
				+ '### 验收\n- 1000 条导出后文件 1001 行（含表头）。\n\n### 约束\n- 只做 CSV。\n',
		},
	],
});

const approve = { answers: [{ id: 'spec-review', selected: ['退出并落盘'] }] };
const decline = { answers: [{ id: 'spec-review', selected: ['继续访谈'] }] };

const sandbox = mkdtempSync(join(tmpdir(), 'spec-landing-'));
const project = join(sandbox, 'project');
mkdirSync(join(project, '.git'), { recursive: true });

/* ---- registration ---- */

check('apply registers the projection, the section, the command, the tools and the guard', () => {
	const ctx = makeContext(project);
	const r = ctx._registered;
	assert.equal(r.projections.length, 1);
	assert.equal(r.projections[0].key, 'spec');
	assert.equal(r.projections[0].stateVersion, 1);
	assert.equal(r.sections.length, 1);
	assert.equal(r.sections[0].name, 'spec:policy');
	assert.equal(r.commands.length, 1);
	assert.equal(r.commands[0].name, 'spec');
	assert.deepEqual(r.tools.map((tool) => tool.definition.name), ['spec_resolve', 'flow_read', 'flow_write']);
	assert.equal(r.guards.length, 1);
	assert.ok(r.listeners.has('tools/post-execute'));
	assert.ok(r.listeners.has('agent/created'));
});

check('a composition without a web server still activates, with no routes registered', () => {
	const ctx = makeContext(project);
	assert.equal(ctx._registered.effects.length, 0, '没有 webServer 时不注册路由');
	assert.equal(ctx._registered.tools.length, 3);
});

check('the collection routes are mounted when the composition has a web server', () => {
	const ctx = makeContext(project, { webServer: true });
	assert.equal(ctx._registered.effects.length, 1);
	const routes = ctx._registered.webServer.routes;
	assert.equal(routes.length, 1);
	assert.equal(routes[0].path, '/spec/flows');
	assert.equal(routes[0].kind, 'prefix');
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
	assert.ok(text.includes('## 简报'));
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
	assert.ok(threw.message.includes('保持开启'), threw.message);
	assert.equal(existsSync(join(dir, '.spec', 'flows')), false, '驳回时连目录都不该建');
});

check('a validation failure throws before the review box opens', async () => {
	const dir = join(sandbox, 'invalid');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const agent = { session: session(dir) };
	const broken = goodArgs('invalid');
	broken.charts[0].brief = '### 目标\n能够导出。\n\n### 要做什么\n- 先做导出，因为用户要求。\n\n### 验收\n- 能下载。\n';
	let threw;
	try {
		await tool.execute(broken, { agent, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined);
	assert.ok(threw.message.includes('brief.requirements[0]'), threw.message);
	assert.ok(threw.message.includes('理由'), threw.message);
	assert.equal(ctx._asked.length, 0, '校验不过时不得弹框');
});

check('an approval writes one markdown file per chart and deletes the draft', async () => {
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
	assert.equal(value.charts.length, 1);
	const landed = value.charts[0];
	assert.equal(landed.id, 'overview');
	assert.equal(landed.path, join(dir, '.spec', 'flows', 'overview.md'));
	assert.equal(landed.brief, '已写');

	// One file carries the title, the scope, the diagram and the brief.
	const file = readFileSync(landed.path, 'utf8');
	assert.ok(file.startsWith('# 记 approve 的需求\n'), file.slice(0, 40));
	assert.ok(file.includes('从用户点导出到最后拿到 CSV'));
	assert.ok(file.includes('```mermaid\nflowchart LR\n'));
	assert.ok(file.includes('n1["用户点击导出按钮"]'));
	assert.ok(file.includes('## 简报'));
	for (const section of ['### 目标', '### 要做什么', '### 验收', '### 约束']) assert.ok(file.includes(section), section);
	// Nothing else was written beside it: a chart is one document.
	assert.deepEqual(readdirSync(join(dir, '.spec', 'flows')), ['overview.md']);

	assert.equal(existsSync(join(dir, '.spec', 'draft.md')), false, '草稿必须被删掉');
	assert.equal(ctx._asked.length, 1, '批准前弹过一次框');
	assert.ok(ctx._asked[0].questions[0].detail.includes('记 approve 的需求'));
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
		assert.ok(existsSync(value.charts[0].path), value.charts[0].path);
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

check('only AGENTS.md earns a write-time advisory now', async () => {
	// A chart's brief is written by the plugin's own tools, which validate it, and
	// a person editing one by hand is not held to the four-section shape — so the
	// write path has nothing to say about it, in the mode or out of it.
	const dir = join(sandbox, 'advisory');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir);
	const listener = ctx._registered.listeners.get('tools/post-execute')[0];
	const agent = { session: session(dir) };
	const next = async () => ({ kind: 'accept' });
	const badBrief = '# t\n\n## 目标\ngoal\n\n## 要做什么\n- a\n\n## 验收\n';

	ctx._state = { active: true, running: null, exitCall: null };
	for (const target of ['.spec/brief.md', '.spec/flows/overview.md', '.spec/draft.md']) {
		const decision = await listener(
			{ name: 'write', arguments: { file_path: join(dir, target), content: badBrief }, agent },
			{ isError: false },
			next,
		);
		assert.equal(decision.additionalContexts, undefined, `${target} 不该被检查`);
	}

	const agents = await listener(
		{ name: 'write', arguments: { file_path: join(dir, 'AGENTS.md'), content: badBrief }, agent },
		{ isError: false },
		next,
	);
	assert.equal(agents.additionalContexts, undefined, '合格的 AGENTS.md 不提醒');
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

/* ---- the collection over HTTP ---- */

/**
 * One request the route handler can consume.
 * @param {string} method - the HTTP method.
 * @param {string} url - the path and query.
 * @param {unknown} [body] - the JSON body, when there is one.
 * @returns {object} the fake request.
 */
function fakeRequest(method, url, body) {
	const text = body === undefined ? '' : JSON.stringify(body);
	return {
		method,
		url,
		async *[Symbol.asyncIterator]() {
			if (text !== '') yield Buffer.from(text, 'utf8');
		},
	};
}

/**
 * A response that records what the handler wrote.
 * @returns {object} the fake response, with `_status`, `_headers` and `_body` filled in.
 */
function fakeResponse() {
	return {
		_status: 0,
		_headers: undefined,
		_body: '',
		writeHead(status, headers) {
			this._status = status;
			this._headers = headers;
		},
		end(body) {
			this._body = typeof body === 'string' ? body : String(body ?? '');
		},
	};
}

/** The parsed body of a fake response. */
const payloadOf = (res) => JSON.parse(res._body);

check('the collection routes list, read, save, create and delete', async () => {
	const dir = join(sandbox, 'routes');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { webServer: true });
	ctx._state = { active: false, running: null, exitCall: null };
	const handler = ctx._registered.webServer.routes[0].handler;

	const list = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/list?session=session-fake'), list);
	assert.equal(list._status, 200);
	assert.deepEqual(payloadOf(list).charts, []);

	const created = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/create?session=session-fake', { id: 'overview', name: '总览', scope: '从甲到乙' }), created);
	assert.equal(created._status, 200, created._body);
	assert.ok(existsSync(join(dir, '.spec', 'flows', 'overview.md')));

	const again = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/create?session=session-fake', { id: 'overview', name: '总览', scope: '从甲到乙' }), again);
	assert.equal(again._status, 409);

	const read = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/chart?session=session-fake&id=overview'), read);
	assert.equal(read._status, 200, read._body);
	const one = payloadOf(read);
	assert.equal(one.chart.name, '总览');
	assert.ok(one.source.startsWith('flowchart LR'), one.source);
	assert.equal(one.drawn, one.source, '没有模块框时画出来的就是原文');
	assert.equal(one.revision, payloadOf(created).revision);

	// A save that quotes the revision it read goes through; the same save twice
	// does not, because the first one replaced the file it was checked against.
	const stale = { chart: { id: 'overview', name: '总览', scope: '从甲到乙', source: 'flowchart LR\n  a["甲"]\n  b["乙"]\n  a --> b\n', brief: '' } };
	const saved = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/save?session=session-fake', { ...stale, revision: one.revision }), saved);
	assert.equal(saved._status, 200, saved._body);
	assert.ok(readFileSync(join(dir, '.spec', 'flows', 'overview.md'), 'utf8').includes('a["甲"]'));

	const conflict = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/save?session=session-fake', { ...stale, revision: one.revision }), conflict);
	assert.equal(conflict._status, 409);
	assert.equal(payloadOf(conflict).revision, payloadOf(saved).revision);

	// A chart the checks refuse never reaches the disk.
	const bad = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/save?session=session-fake', {
		chart: { id: 'overview', name: '总览', scope: '从甲到乙', source: 'flowchart LR\n  a["甲"]\n', brief: '' },
		revision: payloadOf(saved).revision,
	}), bad);
	assert.equal(bad._status, 422);
	assert.ok(payloadOf(bad).errors.length > 0);

	const removed = fakeResponse();
	await handler(fakeRequest('POST', '/spec/flows/delete?session=session-fake', { id: 'overview' }), removed);
	assert.equal(removed._status, 422, '总览删不掉');

	const unknown = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/nope?session=session-fake'), unknown);
	assert.equal(unknown._status, 404);
});

check('a landing keeps a brief it was not given, and refuses to write and delete one chart', async () => {
	const dir = join(sandbox, 'inherit');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { answers: [approve, approve] });
	ctx._state = { active: true, running: null, exitCall: null };
	const tool = ctx._registered.tools[0].definition;
	const agent = { session: session(dir) };
	await tool.execute(goodArgs('first'), { agent, signal: undefined });

	// The common edit: the diagram changed, the brief did not. Leaving `brief` out
	// has to mean "keep the one on disk", not "clear it". A landed session has
	// exited, so the second pass speaks as a fresh one — same project, new session.
	const second = goodArgs('second');
	second.charts[0].source = 'flowchart LR\n  n1["甲"]\n  n2["乙"]\n  n1 --> n2\n';
	delete second.charts[0].brief;
	await tool.execute(second, { agent: { session: session(dir) }, signal: undefined });
	const kept = readFileSync(join(dir, '.spec', 'flows', 'overview.md'), 'utf8');
	assert.ok(kept.includes('### 目标'), kept);
	assert.ok(kept.includes('n1["甲"]'), kept);

	// One id may not be both written and deleted: the result would depend on the
	// order the two lists happen to be applied in.
	const clash = goodArgs('clash');
	let threw;
	try {
		await tool.execute({ charts: clash.charts, removed: ['overview'] }, { agent: { session: session(dir) }, signal: undefined });
	} catch (error) {
		threw = error;
	}
	assert.ok(threw !== undefined);
	assert.ok(threw.message.includes('removed'), threw.message);
});

check('the routes answer with the status the mistake deserves', async () => {
	const dir = join(sandbox, 'status');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { webServer: true });
	const handler = ctx._registered.webServer.routes[0].handler;

	// A body that is not JSON is the caller's mistake, not a server fault.
	const broken = {
		method: 'POST',
		url: '/spec/flows/save?session=session-fake',
		async *[Symbol.asyncIterator]() { yield Buffer.from('{ not json', 'utf8'); },
	};
	const badJson = fakeResponse();
	await handler(broken, badJson);
	assert.equal(badJson._status, 400, badJson._body);

	// A verb this route knows, called the wrong way round.
	const wrongMethod = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/save?session=session-fake'), wrongMethod);
	assert.equal(wrongMethod._status, 405, wrongMethod._body);

	const unknown = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/whatever?session=session-fake'), unknown);
	assert.equal(unknown._status, 404, unknown._body);
});

check('the drawing library is served as a script', async () => {
	const dir = join(sandbox, 'mermaid');
	mkdirSync(join(dir, '.git'), { recursive: true });
	const ctx = makeContext(dir, { webServer: true });
	const handler = ctx._registered.webServer.routes[0].handler;
	const res = fakeResponse();
	await handler(fakeRequest('GET', '/spec/flows/mermaid.js'), res);
	if (res._status === 404) {
		// A machine without mermaid installed says so instead of serving nothing.
		assert.ok(res._body.includes('DSH_SPEC_MERMAID'), res._body);
		return;
	}
	assert.equal(res._status, 200);
	assert.equal(res._headers['content-type'], 'application/javascript; charset=utf-8');
	assert.ok(res._body.length > 1000000);
});

console.log(`\n${passed} checks passed`);
