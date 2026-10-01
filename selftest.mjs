/**
 * Dependency-free smoke test for the pure modules of dsh-spec-mode.
 * It exercises the parts that decide behavior — the draft anchor, the path
 * predicate, the projection fold, and the AGENTS.md advisory — without a Host.
 *
 * Run: node selftest.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentsMdAdvisories, agentsMdWriteContent } from './advisories.js';
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

console.log(`\n${passed} checks passed`);
