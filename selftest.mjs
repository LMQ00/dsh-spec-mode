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
	codeFreeAdvisories,
	decisionRationaleAdvisories,
	deliverableAdvisories,
	documentationRulesAdvisories,
	plainLanguageAdvisories,
	specDeliverableWrite,
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

check('the plain-language lead warning fires only when the lead is missing', () => {
	const readable =
		'# 标题\n\n'
		+ '这份文档回答一个问题：插件在什么时候拦下写入。读完你就知道哪些操作会被挡住，以及被挡住时该怎么办。\n\n'
		+ '## 细节\n\n正文。\n';
	assert.deepEqual(plainLanguageAdvisories('doc', readable), []);
	assert.equal(plainLanguageAdvisories('doc', '# 标题\n\n## 细节\n\n正文。\n').length, 1);
	assert.equal(plainLanguageAdvisories('doc', '# 标题\n\n```js\nconst a = 1;\n```\n\n## 细节\n').length, 1);
	assert.equal(plainLanguageAdvisories('doc', '# 标题\n\n| 文档 | 何时读 |\n| --- | --- |\n').length, 1);
	assert.equal(plainLanguageAdvisories('doc', '# 标题\n\n- 一份说明。\n').length, 1);
	assert.equal(plainLanguageAdvisories('agents', '# AGENTS.md\n\n| 文档 | 何时读 |\n| --- | --- |\n').length, 1);
	assert.equal(
		plainLanguageAdvisories('doc', '# 标题\n\n想弄清写入是怎么被拦下的，先读 docs/api.md 那份文档，它比这里细。\n').length,
		1,
	);
	assert.deepEqual(plainLanguageAdvisories('doc', '   '), []);
});

check('the code warning spares terms and commands', () => {
	const hasCode = (text) => codeFreeAdvisories(text).length > 0;
	assert.equal(hasCode('# 标题\n\n状态折叠那一步返回同一个对象，术语可以出现。\n'), false);
	// A command is a run instruction, not code.
	assert.equal(hasCode('# 标题\n\n复现：\n\n```\nnode selftest.mjs\n```\n'), false);
	assert.equal(hasCode('# 标题\n\n复现：\n\n```\n$ npm run build\n```\n'), false);
	assert.equal(hasCode('# 标题\n\n先在仓库根目录跑 node selftest.mjs，不带参数。\n'), false);
	assert.equal(hasCode('# 标题\n\n```\n/spec off\n```\n'), false);
	// Source text, identifiers and file names are not.
	assert.equal(hasCode('# 标题\n\n```js\nconst a = 1;\n```\n'), true);
	assert.equal(hasCode('# 标题\n\n改 state.js 的 apply() 之前先看这里。\n'), true);
	assert.equal(hasCode('# 标题\n\n见 `apply()` 的实现。\n'), true);
	assert.equal(hasCode('# 标题\n\n投影的状态版本号叫 PROJECTION_VERSION。\n'), true);
	// A document's own path is an address, not code.
	assert.equal(hasCode('# 标题\n\n文档索引：docs/api.md 什么时候读？\n'), false);
	// A listing may cite a file name; citing one mid-sentence may not.
	assert.equal(hasCode('| 文件 | 职责 |\n| --- | --- |\n| state.js | 恢复状态 |\n'), false);
	assert.equal(hasCode('改 state.js 里的状态折叠逻辑。\n'), true);
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
		+ '- 文档不写代码，术语可以用、命令可以有。\n'
		+ '- 每份文档首段是外行读得懂的白话导读。\n'
		+ '- 决策只记结论，不写被否决的方案与理由。\n';
	assert.deepEqual(documentationRulesAdvisories(complete), []);
	assert.equal(documentationRulesAdvisories('过时了就改，文档不写代码，首段要白话。\n').length, 1);
	assert.deepEqual(documentationRulesAdvisories('   '), []);
});

check('one deliverable collects the line budget and every writing check', () => {
	const long = Array.from({ length: 201 }, () => 'x').join('\n');
	assert.equal(deliverableAdvisories('agents', long).length, 2);
	assert.deepEqual(deliverableAdvisories('doc', long), []);
	assert.equal(deliverableAdvisories('doc', '## 为什么不选 X\n\n正文。\n').length, 2);
	assert.equal(deliverableAdvisories('doc', '# 标题\n\n```js\nconst a = 1;\n```\n').length, 2);
});

console.log(`\n${passed} checks passed`);
