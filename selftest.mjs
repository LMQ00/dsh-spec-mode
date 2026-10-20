/**
 * Dependency-free smoke test for the pure modules of dsh-spec-mode.
 * It exercises the parts that decide behavior — the draft anchor, the path
 * predicate, the projection fold, and the deliverable advisories — without a
 * Host.
 *
 * Run: node selftest.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	agentsMdAdvisories,
	agentsMdWriteContent,
	decisionRationaleAdvisories,
	deliverableAdvisories,
	documentationRulesAdvisories,
	progressAdvisories,
	reasonAdvisories,
	reproductionAdvisories,
	specDeliverableWrite,
	supersededAdvisories,
} from './advisories.js';
import { classifyTarget, extractTargetPaths, isDestructiveTool, isWriteTool } from './guard.js';
import { createSpecProjection, findProjectAnchor, resolveDraftPath } from './state.js';

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
	assert.equal(resolveDraftPath(nested), join(project, 'docs', 'spec-draft.md'));
});

check('anchor falls back to cwd without a marker', () => {
	const bare = join(sandbox, 'bare', 'deep');
	mkdirSync(bare, { recursive: true });
	assert.equal(findProjectAnchor(bare), bare);
});

/* ---- path classification ---- */

const draft = resolveDraftPath(nested);

check('the draft itself is allowed, everything else is the working tree', () => {
	assert.equal(classifyTarget(draft, nested, draft), 'draft');
	assert.equal(classifyTarget('docs/spec-draft.md', project, draft), 'draft');
	assert.equal(classifyTarget('docs/notes.md', project, draft), 'working-tree');
	assert.equal(classifyTarget('README.md', project, draft), 'working-tree');
	assert.equal(classifyTarget('docs', project, draft), 'working-tree');
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
	// new selection while `active` still holds the committed one. Reading the
	// effective state inside a handler would therefore report the NEW value.
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

/* ---- advisories ---- */

check('the line budget fires only above the limit', () => {
	assert.deepEqual(agentsMdAdvisories('a\nb\nc'), []);
	assert.equal(agentsMdAdvisories(Array.from({ length: 201 }, () => 'x').join('\n')).length, 1);
});

check('only a successful write of AGENTS.md is inspected', () => {
	assert.equal(agentsMdWriteContent('write', { file_path: 'AGENTS.md', content: 'hi' }, false), 'hi');
	assert.equal(agentsMdWriteContent('write', { file_path: 'docs/AGENTS.md', content: 'hi' }, false), 'hi');
	assert.equal(agentsMdWriteContent('edit', { file_path: 'AGENTS.md' }, false), undefined);
	assert.equal(agentsMdWriteContent('write', { file_path: 'AGENTS.md', content: 'hi' }, true), undefined);
	assert.equal(agentsMdWriteContent('write', { file_path: 'README.md', content: 'hi' }, false), undefined);
});

check('a deliverable write is classified by its target', () => {
	assert.equal(specDeliverableWrite('write', { file_path: 'AGENTS.md', content: 'hi' }, false).kind, 'agents');
	assert.equal(specDeliverableWrite('write', { path: 'docs/AGENTS.md', content: 'hi' }, false).kind, 'agents');
	assert.equal(specDeliverableWrite('write', { path: 'docs/api.md', content: 'hi' }, false).kind, 'doc');
	assert.equal(specDeliverableWrite('write', { file_path: 'docs/api/auth.md', content: 'hi' }, false).kind, 'doc');
	assert.equal(specDeliverableWrite('write', { file_path: 'docs/spec-draft.md', content: 'x' }, false).base, 'spec-draft.md');
	assert.equal(specDeliverableWrite('write', { file_path: 'README.md', content: 'hi' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'src/docs.txt', content: 'hi' }, false), undefined);
	assert.equal(specDeliverableWrite('edit', { file_path: 'docs/api.md' }, false), undefined);
	assert.equal(specDeliverableWrite('write', { file_path: 'docs/api.md', content: 'x' }, true), undefined);
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
	// A docs/ deliverable may record status; only the baseline may not.
	assert.deepEqual(deliverableAdvisories('doc', '## 现状\n\n已装入。\n'), []);
	assert.deepEqual(progressAdvisories('   '), []);
});

check('a code block is reported unless it is a step the reader performs', () => {
	const reports = (text) => reproductionAdvisories(text).length > 0;
	// Code as a step, with the three parts: where it goes, what to run, what success looks like.
	const explained =
		'# 标题\n\n把下面这段存成仓库根目录的检查脚本，然后执行 node check.mjs，'
		+ '输出三行 ok 就是通过。\n\n```js\nconst a = 1;\n```\n';
	assert.equal(reports(explained), false);
	// A bare code block explains implementation instead of saying it in words.
	assert.equal(reports('# 标题\n\n```js\nconst a = 1;\n```\n'), true);
	assert.equal(reports('# 标题\n\n状态折叠那一步返回同一个对象。\n\n```ts\nexport function fold(state) { return state; }\n```\n'), true);
	// A command block is already a step the reader performs.
	assert.equal(reports('# 标题\n\n```\nnode selftest.mjs\n```\n'), false);
	// So is a picture block: a picture is not code, so nothing is required of it.
	assert.equal(reports('# 标题\n\n```mermaid\nflowchart LR\n  A --> B\n```\n'), false);
	assert.equal(reports('# 标题\n\n```\n┌───┐\n│ A │\n└───┘\n```\n'), false);
	assert.deepEqual(reproductionAdvisories('   '), []);
});

check('the decision-rationale warning fires only on labelled rejections', () => {
	assert.equal(decisionRationaleAdvisories('# 决策\n\n## 日志落盘\n\n选定 JSONL，一行一条事件。\n').length, 0);
	assert.equal(decisionRationaleAdvisories('## 为什么不选 SQLite\n\n写入放大。\n').length, 1);
	assert.equal(decisionRationaleAdvisories('- 被否决方案：改用 SQLite。\n').length, 1);
	assert.equal(decisionRationaleAdvisories('**Alternatives considered**：SQLite.\n').length, 1);
	// A table row that merely mentions the rejected option is not a dedicated block.
	assert.equal(decisionRationaleAdvisories('| 被否决方案 | `decisions.md` |\n').length, 0);
	// The rule that forbids the record is not a record of one.
	assert.equal(decisionRationaleAdvisories('- 决策只记结论，不写被否决的方案与理由。\n').length, 0);
});

check('the documentation rule block is required in AGENTS.md', () => {
	assert.equal(documentationRulesAdvisories('| 文档 | 何时读 |\n').length, 1);
	const complete =
		'- 改代码前判断本次改动是否让 docs/ 过时。\n'
		+ '- AGENTS.md 只放文档索引与规范规则，不写现状、进度、待办这类内容。\n'
		+ '- 写进 docs/ 的文档只写结论与硬事实，不解释：删掉一句话读者照做也不出错，就删。\n'
		+ '- 文档信息密度极高：一行一个结论，能进表格就进表格。\n'
		+ '- 代码能不出就不出，只在读者要照着做时给，并且每段代码都要跟着复现步骤：写进哪个文件、执行什么、看到什么算成功。\n'
		+ '- 决策只记结论，不写被否决的方案与理由。\n';
	assert.deepEqual(documentationRulesAdvisories(complete), []);
	assert.equal(
		documentationRulesAdvisories('过时了就改；规则文件不写进度；只写结论不解释；信息密度极高；代码要跟着复现步骤；决策只记结论。\n').length,
		0,
	);
	// The wording this standard replaced — a plain-language document — no longer
	// satisfies the rule block.
	assert.equal(
		documentationRulesAdvisories('过时了就改；代码跟着复现步骤不写进度；文档整篇说人话；决策只记结论。\n').length,
		1,
	);
	assert.deepEqual(documentationRulesAdvisories('   '), []);
});

check('a section that exists to explain itself is reported', () => {
	const reports = (text) => reasonAdvisories(text).length > 0;
	assert.equal(reports('# 标题\n\n## 已知限制\n\n- 用 shell 写文件不拦。\n'), false);
	// The rule that forbids the section is not the section.
	assert.equal(reports('# 规则\n\n- 文档不写背景、动机与设计考量。\n'), false);
	assert.equal(reports('# 规则\n\n**不写导读与小结。**\n'), false);
	assert.equal(reports('## 背景\n\n为什么会有这个插件。\n'), true);
	assert.equal(reports('# 标题\n\n## 本章小结\n\n正文。\n'), true);
	assert.equal(reports('### 设计考量\n\n正文。\n'), true);
	assert.equal(reports('**取舍**\n\n正文。\n'), true);
	// Prose that merely uses one of the words is not a section.
	assert.equal(reports('# 标题\n\n这里记录了当时的权衡结果，不改。\n'), false);
	assert.deepEqual(reasonAdvisories('   '), []);
});

check('every offending section is named in one message', () => {
	// Reporting the first finding and returning would hide the rest: a document
	// with three filler sections is one fix, not three rounds.
	const [message] = reasonAdvisories('## 背景\n\nx\n\n## 小结\n\ny\n\n## 为什么要这样\n\nz\n');
	assert.equal(typeof message, 'string');
	for (const label of ['背景', '小结', '为什么要这样']) assert.ok(message.includes(label), `${label} 未出现在警告里`);
	// More than three findings collapse to a count, so the message stays readable.
	const many = Array.from({ length: 5 }, (_, index) => `## 背景与目标${index}\n\nx\n`).join('\n');
	assert.ok(reasonAdvisories(many)[0].includes('等 5 处'));
});

check('a filler heading is matched as a whole title, never as a substring', () => {
	const reports = (text) => reasonAdvisories(text).length > 0;
	// A compound naming a fact is not the filler word inside it.
	assert.equal(reports('## 背景色\n\n默认 #fff。\n'), false);
	assert.equal(reports('## 历史记录\n\n正文。\n'), false);
	assert.equal(reports('## 总结性数据\n\n正文。\n'), false);
	assert.equal(reports('## 动机触发器\n\n正文。\n'), false);
	assert.equal(reports('## 权衡参数\n\n正文。\n'), false);
	assert.equal(reports('## 取舍规则\n\n正文。\n'), false);
	// The word joined to a sibling idea still names the filler section.
	assert.equal(reports('## 背景与目标\n\n正文。\n'), true);
	// `历史版本` is a change log: the history this rule targets, not a dataset.
	assert.equal(reports('## 历史版本\n\n| 版本 | 日期 |\n| --- | --- |\n'), true);
	assert.equal(reports('## 历史\n\n正文。\n'), true);
	assert.equal(reports('## 技术沿革\n\n正文。\n'), true);
	// A heading that asks why is the explanation itself.
	assert.equal(reports('## 为什么用 TypeScript\n\n正文。\n'), true);
});

check('a superseded value is reported only when the marker bites into it', () => {
	const reports = (text) => supersededAdvisories(text).length > 0;
	// Two answers to one question, in a shape that states the pair outright.
	assert.equal(reports('技术栈：vite（此前为 webpack）。\n'), true);
	assert.equal(reports('| 构建工具 | vite（原 webpack） |\n| --- | --- |\n'), true);
	assert.equal(reports('API v1 已弃用。\n'), true);
	// Deliberately not caught: a pair written as bare prose, with no bracket, no
	// arrow, no table and no deprecation word — `vite，替代了 webpack`. Telling it
	// apart from an instruction needs a guess about wording, and the guess cost
	// more false reports than the catch was worth. The prompt covers this shape.
	assert.equal(reports('- 构建：vite，替代了 webpack\n'), false);
	assert.equal(reports('我们从 MySQL 迁移到了 PostgreSQL。\n'), false);
	// Instructions that happen to use a connective are not migration history.
	assert.equal(reports('如果校验失败，改为返回错误码 `E_INVALID`。\n'), false);
	assert.equal(reports('执行 `npm install` 之前，先运行 `npm ci`。\n'), false);
	assert.equal(reports('调用 `close()` 之前必须先 `flush()`。\n'), false);
	assert.equal(reports('升级到 Node 22 后，`fetch` 可直接使用。\n'), false);
	assert.equal(reports('早期返回用 `return null`。\n'), false);
	// A document that states only the current value says nothing about the past.
	assert.equal(reports('| 构建工具 | vite |\n| --- | --- |\n'), false);
	assert.equal(reports('原因如下：先读缓存。\n'), false);
	assert.deepEqual(supersededAdvisories('   '), []);
});

check('a bare replacement verb names one value, so it is a step not a history', () => {
	const reports = (text) => supersededAdvisories(text).length > 0;
	// One answer only: a step the reader performs. Reporting it would have the
	// model delete a correct instruction.
	assert.equal(reports('改用 `pnpm` 安装依赖。\n'), false);
	assert.equal(reports('把 `timeout` 换成 `5000`。\n'), false);
	assert.equal(reports('改为调用 `reset()`。\n'), false);
	assert.equal(reports('部署之前用 `docker build` 构建镜像。\n'), false);
	// A bracket marks the retired value, so the parenthetical rule catches it.
	assert.equal(reports('改用 `vite`（此前用 `webpack`）。\n'), true);
	// Deliberately not caught: `现在改用 SQLite` names one value. The contrast
	// word alone does not turn a step into a two-answer line.
	assert.equal(reports('现在改用 SQLite。\n'), false);
	assert.equal(reports('迁移自 `webpack`。\n'), false);
});

check('a superseded pair is caught by shape, not only by wording', () => {
	const reports = (text) => supersededAdvisories(text).length > 0;
	// A table with an old and a current column states the pair with no marker.
	assert.equal(reports('| 项 | 旧值 | 当前值 |\n| --- | --- | --- |\n| 构建 | `webpack` | `vite` |\n'), true);
	// An arrow joins exactly two values: a replacement.
	assert.equal(reports('- 迁移：`webpack` → `vite`\n'), true);
	// An arrow chain is a dependency direction, not a replacement.
	assert.equal(reports('`api` → `core` → `infra`，不反向。\n'), false);
	// Deliberately not caught: a past-state word separated from its value by an
	// arbitrary phrase. Guessing how far a marker reaches is what produced the
	// false reports; these shapes are the prompt's job.
	assert.equal(reports('之前的实现用的是 `lodash`。\n'), false);
	assert.equal(reports('## 历史上这个字段叫 `userId`。\n'), false);
	// A parenthetical states the same thing without a guess.
	assert.equal(reports('数据库：PostgreSQL（原 MySQL）。\n'), true);
	// But a trailing clause after the bracket is prose, not a parenthetical pair.
	assert.equal(reports('原来的默认端口（8080）已改成 9090。\n'), false);
	// A trailing marker keeps its own ordering.
	assert.equal(reports('`JQuery` 已被移除。\n'), true);
	// Weak deprecation words need a value beside them.
	assert.equal(reports('清除废弃数据前先备份。\n'), false);
	assert.equal(reports('缓存不再使用时设置 `CACHE=0`。\n'), false);
	assert.equal(reports('该函数保留原名 `init`。\n'), false);
});

check('both orderings of a replacement are caught', () => {
	const reports = (text) => supersededAdvisories(text).length > 0;
	// The retired value may follow the deprecation word rather than precede it.
	assert.equal(reports('`JQuery` 已被移除。\n'), true);
	assert.equal(reports('`webpack` 已被 `vite` 取代。\n'), true);
	// Prose forms with no bracket, arrow, table or deprecation word stay out.
	assert.equal(reports('用 `vite` 替换 `webpack`。\n'), false);
	assert.equal(reports('`webpack` was replaced by `vite`.\n'), false);
	assert.equal(reports('从 `webpack` 迁移至 `vite`。\n'), false);
	// `改为使用 vite` names one value only — a step, not a history record.
	assert.equal(reports('改为使用 `vite`。\n'), false);
});

check('ordinary words that merely contain a marker stay out', () => {
	const reports = (text) => supersededAdvisories(text).length > 0;
	// `原` closes a verb here, it does not open a past state.
	assert.equal(reports('从备份还原 SQL 数据库。\n'), false);
	assert.equal(reports('还原SQL。\n'), false);
	// `旧版` qualifies a browser, not a retired value.
	assert.equal(reports('旧版浏览器不支持该 API。\n'), false);
	// A JavaScript arrow is not a replacement arrow.
	assert.equal(reports('items.map(x=>x.id)\n'), false);
	assert.equal(reports('const f = x => x + 1\n'), false);
	// A configuration step names no past state.
	assert.equal(reports('将 `NODE_ENV` 改为 `production` 再启动。\n'), false);
	// `此前` opening an instruction is a time word.
	assert.equal(reports('此前请先运行 `npm ci`。\n'), false);
});

check('a filler heading keeps its identifier through trailing punctuation', () => {
	const reports = (text) => reasonAdvisories(text).length > 0;
	// A trailing colon or parenthetical is heading style, not meaning.
	assert.equal(reports('## 历史：\n\n正文。\n'), true);
	assert.equal(reports('## 术语表（缩略语）\n\n正文。\n'), true);
	assert.equal(reports('**历史：**\n\n正文。\n'), true);
	// A subject before the word still names the filler section.
	assert.equal(reports('## 版本历史\n\n正文。\n'), true);
	assert.equal(reports('## 设计动机\n\n正文。\n'), true);
	// A word continuing into a concrete noun still names a fact.
	assert.equal(reports('## 历史数据\n\n正文。\n'), false);
	assert.equal(reports('## 背景图\n\n正文。\n'), false);
});

check('a rule statement is exempt however it is worded', () => {
	// The rule file spells its own rules; each of these forbids the practice
	// rather than performing it, and none may be reported.
	const exemptions = [
		'- 文档不写历史版本，不写「原来用 X，后来改成 Y」。',
		'- 不写已被取代的值（如 `vite（原 webpack）`）。',
		'- 文档不出现「此前为 `x`」这类表述。',
		'- 一律不保留「此前为 `x`」。',
		'- 不收录旧值。',
	];
	for (const line of exemptions) {
		assert.equal(supersededAdvisories(line).length, 0, line);
	}
});

check('one deliverable collects the line budget and every writing check', () => {
	const long = Array.from({ length: 201 }, () => 'x').join('\n');
	assert.equal(deliverableAdvisories('agents', long).length, 2);
	assert.deepEqual(deliverableAdvisories('doc', long), []);
	// A section named after the rejected alternative trips both the "why" heading
	// check and the decision-rationale check.
	assert.equal(deliverableAdvisories('doc', '## 为什么不选 X\n\n正文。\n').length, 2);
	assert.equal(deliverableAdvisories('doc', '# 标题\n\n```js\nconst a = 1;\n```\n').length, 1);
	assert.equal(deliverableAdvisories('doc', '## 背景\n\n正文。\n').length, 1);
	// A baseline carrying progress reports both the missing rule block and the
	// progress record itself.
	const withProgress = '## 现状\n\n- 已能启动。\n';
	assert.equal(deliverableAdvisories('agents', withProgress).length, 2);
});

console.log(`\n${passed} checks passed`);
