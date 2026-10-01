/**
 * Advisory-only checks for an AGENTS.md write.
 *
 * Content-quality constraints stay prompt-level: nothing here blocks a write.
 * `@deepseek-ai/dsh-agent-instructions` reads `AGENTS.md` as a byte-budgeted
 * baseline when the deployment composes it, so an over-long rule file is
 * truncated or dropped rather than merely verbose — the same reason the line
 * budget exists here.
 *
 * @module dsh-spec-mode/advisories
 */

/** Line budget above which AGENTS.md adherence measurably degrades. */
export const AGENTS_MD_LINE_LIMIT = 200;

/**
 * Advisory messages for one AGENTS.md body.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function agentsMdAdvisories(content) {
	const messages = [];
	const text = typeof content === 'string' ? content : '';
	const lines = text.split('\n').length;
	if (lines > AGENTS_MD_LINE_LIMIT) {
		messages.push(
			`Spec mode: 这次写的 AGENTS.md 有 ${lines} 行，超过 ${AGENTS_MD_LINE_LIMIT} 行预算。`
				+ '细节外移到 docs/ 或 skill，规则文件只留可证伪的条目——它是项目基线，越短越容易被真正遵守。',
		);
	}
	return messages;
}

/**
 * Whether one tool call is a successful write of an `AGENTS.md` file.
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @param {boolean} isError - whether the call settled as an error.
 * @returns {string | undefined} the written content, when this is such a write.
 */
export function agentsMdWriteContent(toolName, args, isError) {
	if (isError || toolName !== 'write') return undefined;
	if (args === null || typeof args !== 'object') return undefined;
	const target = args.file_path ?? args.path;
	if (typeof target !== 'string') return undefined;
	const base = target.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
	if (base !== 'AGENTS.md') return undefined;
	return typeof args.content === 'string' ? args.content : '';
}
