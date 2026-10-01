/**
 * Tool-call path predicate for spec mode: which targets a call names, and
 * whether each is the draft, a protocol path, or the working tree.
 *
 * @module dsh-spec-mode/guard
 */

import { resolve } from 'node:path';

/**
 * `scheme://` targets (local://, artifact://, …) are tool-device paths, never
 * working-tree files.
 */
const PROTOCOL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Every key a file-touching tool in this composition has used for its target(s).
 * `@deepseek-ai/dsh-tool-fs` uses `file_path` for `write`/`edit`/`read`; `path`
 * and `paths` are accepted so a future tool that spells it differently does not
 * silently pass the guard.
 */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'paths'];

/** Tool names whose whole purpose is to remove or relocate an existing file. */
const DESTRUCTIVE_RE = /^(delete|remove|move|rename)/i;

/** Tool names that mutate file content and are therefore guardable by path. */
const WRITE_TOOLS = new Set(['write', 'edit']);

/**
 * Whether a tool name is a delete/move/rename-shaped operation.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true for destructive names.
 */
export function isDestructiveTool(toolName) {
	return DESTRUCTIVE_RE.test(toolName);
}

/**
 * Whether a tool name mutates file content.
 * @param {string} toolName - the model-facing tool name.
 * @returns {boolean} true for `write`/`edit`.
 */
export function isWriteTool(toolName) {
	return WRITE_TOOLS.has(toolName);
}

/**
 * Classify one tool-supplied path. `draft` is the draft file and nothing else —
 * the draft lives inside the project's `docs/` directory, so a directory-wide
 * allowance would leak write access to real documentation. Anything
 * unresolvable is `working-tree`, so a parse failure fails closed.
 *
 * @param {string} raw - the raw path argument.
 * @param {string} cwd - the base relative paths resolve against.
 * @param {string} draftPath - the absolute draft path.
 * @returns {'protocol' | 'draft' | 'working-tree'} the classification.
 */
export function classifyTarget(raw, cwd, draftPath) {
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (trimmed === '' || PROTOCOL_RE.test(trimmed)) return 'protocol';
	let absolute;
	try {
		absolute = resolve(cwd, trimmed);
	} catch {
		return 'working-tree';
	}
	return absolute === draftPath ? 'draft' : 'working-tree';
}

/**
 * Collect every path a tool call names, across the known key spellings and the
 * plural form.
 * @param {unknown} input - the parsed tool arguments.
 * @returns {string[]} the named paths, in argument order.
 */
export function extractTargetPaths(input) {
	if (input === null || typeof input !== 'object') return [];
	const paths = [];
	for (const key of PATH_KEYS) {
		const value = input[key];
		if (typeof value === 'string') paths.push(value);
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === 'string') paths.push(item);
		}
	}
	return paths;
}
