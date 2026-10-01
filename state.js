/**
 * Spec-mode state: the session-log projection that owns "is spec mode on for
 * this session", plus the draft-path resolution that both the guard and the
 * interview protocol use.
 *
 * DSH forbids a plugin from appending a new session event type (`SessionEventMap`
 * is merge-extensible for typing, but the persistence read path refuses a log
 * whose event type is outside the generated `KNOWN_SESSION_EVENT_TYPES` set
 * unless the envelope carries `ignorable: true`, and `Session.append()` cannot
 * set that marker). So this unit derives its state entirely from events the
 * surrounding composition already writes:
 *
 *   command/run  name === 'spec'  → the selection is pending, read from `args`
 *   command/done (paired id)      → commit `success`, discard otherwise
 *   tool/call    spec_resolve     → remember the call id under review
 *   tool/result  (paired id)      → a non-error result means the user approved
 *
 * Everything is a pure synchronous fold, so resume, fork, and replay restore the
 * mode from the log alone. `init` runs for the empty log; a unit uninterested in
 * an event returns the same state reference.
 *
 * @module dsh-spec-mode/state
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The projection key this unit owns. */
export const PROJECTION_KEY = 'spec';

/** Bump whenever the state fields or the fold semantics change. */
export const PROJECTION_VERSION = 1;

/** The draft lives in the project's documentation directory, not in agent state. */
export const DRAFT_DIR = 'docs';

/** The draft's file name. */
export const DRAFT_BASENAME = 'spec-draft.md';

/**
 * DSH's own project-root marker. `@deepseek-ai/dsh-agent-instructions` resolves
 * the project root with `projectRootMarkers` defaulting to `['.git']` and falls
 * back to the session cwd; anchoring the draft the same way keeps the draft
 * inside the same project the instruction files come from.
 */
const PROJECT_ROOT_MARKERS = ['.git'];

/**
 * Nearest ancestor of `cwd` carrying a project-root marker, else `cwd` itself.
 * @param {string} cwd - the session working directory.
 * @returns {string} the absolute project anchor.
 */
export function findProjectAnchor(cwd) {
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		for (const marker of PROJECT_ROOT_MARKERS) {
			if (existsSync(join(current, marker))) return current;
		}
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/**
 * Absolute path of the interview draft for one working directory.
 * @param {string} cwd - the session working directory.
 * @returns {string} the absolute draft path.
 */
export function resolveDraftPath(cwd) {
	return join(findProjectAnchor(cwd), DRAFT_DIR, DRAFT_BASENAME);
}

/**
 * Create the draft's parent directory without going through the tool layer, so
 * the guard never has to allow writes to `docs/` as a directory.
 * @param {string} filePath - the absolute draft path.
 */
export function ensureParentDir(filePath) {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
	} catch {
		// A concurrent creation or an unwritable parent surfaces later as a tool error.
	}
}

/**
 * Whether a draft file exists and is non-empty.
 * @param {string} filePath - the absolute draft path.
 * @returns {boolean} true when the draft has content.
 */
export function draftHasContent(filePath) {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

/**
 * Structural validator standing in for the `ZodType` a projection unit declares.
 * The registry only ever calls `parse` on a persisted cache row before seeding a
 * fold, so a throwing `parse` discards that row rather than corrupting state.
 */
const stateSchema = {
	parse(value) {
		if (value === null || typeof value !== 'object') {
			throw new TypeError('spec projection state must be an object');
		}
		if (typeof value.active !== 'boolean') {
			throw new TypeError('spec projection state.active must be a boolean');
		}
		const running = value.running;
		if (running !== null && running !== undefined) {
			if (typeof running !== 'object' || typeof running.commandId !== 'string' || typeof running.wanted !== 'boolean') {
				throw new TypeError('spec projection state.running must be { commandId, wanted } or null');
			}
		}
		return {
			active: value.active,
			running: running === null || running === undefined ? null : { commandId: running.commandId, wanted: running.wanted },
			exitCall: typeof value.exitCall === 'string' ? value.exitCall : null,
		};
	},
};

/**
 * Build the `spec` projection unit.
 * @param {string} commandName - the human command that enters and leaves the mode.
 * @param {string} exitToolName - the model-facing tool whose approval leaves the mode.
 * @returns {object} a registry-ready projection definition.
 */
export function createSpecProjection(commandName, exitToolName) {
	return {
		key: PROJECTION_KEY,
		stateVersion: PROJECTION_VERSION,
		stateSchema,
		init: () => ({ active: false, running: null, exitCall: null }),
		apply(state, event) {
			if (event === null || typeof event !== 'object') return state;
			const data = event.data;
			switch (event.type) {
				case 'command/run': {
					if (data === null || typeof data !== 'object' || data.name !== commandName) return state;
					const args = typeof data.args === 'string' ? data.args : '';
					return { ...state, running: { commandId: String(data.commandId), wanted: args.trim() !== 'off' } };
				}
				case 'command/done': {
					const running = state.running;
					if (running === null || data === null || typeof data !== 'object') return state;
					if (data.commandId !== running.commandId) return state;
					if (data.kind !== 'success') return { ...state, running: null };
					return { active: running.wanted, running: null, exitCall: state.exitCall };
				}
				case 'tool/call': {
					if (data === null || typeof data !== 'object' || data.name !== exitToolName) return state;
					return { ...state, exitCall: String(data.callId) };
				}
				case 'tool/result': {
					if (state.exitCall === null || data === null || typeof data !== 'object') return state;
					const message = data.message;
					if (message === null || typeof message !== 'object' || message.toolCallId !== state.exitCall) return state;
					if (message.isError === true) return { ...state, exitCall: null };
					return { active: false, running: null, exitCall: null };
				}
				default:
					return state;
			}
		},
	};
}
