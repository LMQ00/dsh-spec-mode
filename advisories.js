/**
 * Advisory-only checks for a spec-mode deliverable write: `AGENTS.md` or
 * `.spec/brief.md`. The flow chart is an image the plugin draws itself, so there
 * is nothing for a write-time check to inspect.
 *
 * Nothing here blocks a write. `@deepseek-ai/dsh-agent-instructions` reads
 * `AGENTS.md` as a byte-budgeted baseline when the deployment composes it, so an
 * over-long rule file is truncated or dropped rather than merely verbose — the
 * same reason the line budget exists here. `AGENTS.md` is also read into every
 * session's context, so progress recorded in it crowds out the rules and then
 * goes stale with nobody responsible for removing it.
 *
 * The two product files carry their own shape rules, and the hand-written
 * landing path is where those rules need a nudge: a reviewer-approved landing
 * renders from validated arguments, while a `/spec off` landing is written
 * freehand. {@link deliverableAdvisories} reports the shape problems of a
 * freehand write; it never prevents it.
 *
 * @module dsh-spec-mode/advisories
 */

import { briefAdvisories } from './brief.js';

/** Line budget above which AGENTS.md adherence measurably degrades. */
export const AGENTS_MD_LINE_LIMIT = 200;

/** The directory both products live in, as a path segment. */
const PRODUCT_DIR = '.spec';

/** Line shapes that introduce a labelled block, where a progress record would be written. */
const STRUCTURAL_LINE_RE = /^\s*(?:#{1,6}\s|\*\*|[-*+]\s|\d+[.)]\s)/;

/**
 * Wording that marks a progress record rather than a rule. Matched on
 * structural lines only, so prose that happens to use one of these words does
 * not fire. `AGENTS.md` is read into every session's context as a baseline, so
 * a status section both crowds out the rules and goes stale unowned.
 */
const PROGRESS_RE = /(进度|待办|待办事项|下一步|接下来的|未完成|已完成|待完成|进度表|里程碑|roadmap|TODO|TBD|changelog|更新日志|变更记录|当前状态|现状)/i;

/**
 * A line that forbids progress content rather than being an instance of it —
 * the rule statement itself.
 */
const PROGRESS_PROHIBITION_RE = /(不写|不记|不要写|别写|禁止写|不需要写|避免写|不记录|不属于|不放|不含|不收|不留|只放)/;

/** Longest quoted excerpt of an offending line, in characters. */
const EXCERPT_MAX_CHARS = 40;

/**
 * Shorten one line so a message can quote it.
 * @param {string} line - the offending line, already trimmed.
 * @returns {string} the line, truncated when long.
 */
function excerptOf(line) {
	return line.length > EXCERPT_MAX_CHARS ? `${line.slice(0, EXCERPT_MAX_CHARS)}…` : line;
}

/**
 * The write target's path segments, or `undefined` when this call names none.
 * @param {unknown} args - the parsed tool arguments.
 * @returns {{ target: string, segments: string[] } | undefined} split target.
 */
function writeTarget(args) {
	if (args === null || typeof args !== 'object') return undefined;
	const target = args.file_path ?? args.path;
	if (typeof target !== 'string') return undefined;
	return { target, segments: target.replace(/[\\/]+$/, '').split(/[\\/]+/) };
}

/**
 * Whether one tool call is a successful write of a spec-mode deliverable.
 * `AGENTS.md` counts wherever it lives (that is where the host reads it from);
 * a Markdown file counts as a product when it sits inside a `.spec` directory
 * and carries one of the two product names. The interview draft is a `.spec`
 * file too — the caller excludes it.
 *
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @param {boolean} isError - whether the call settled as an error.
 * @returns {{ kind: 'agents' | 'brief', path: string, base: string, content: string } | undefined} the write.
 */
export function specDeliverableWrite(toolName, args, isError) {
	if (isError || toolName !== 'write') return undefined;
	const target = writeTarget(args);
	if (target === undefined) return undefined;
	const segments = [...target.segments];
	const base = segments.pop() ?? '';
	const content = typeof args.content === 'string' ? args.content : '';
	if (base === 'AGENTS.md') return { kind: 'agents', path: target.target, base, content };
	if (!segments.includes(PRODUCT_DIR)) return undefined;
	if (base === 'brief.md') return { kind: 'brief', path: target.target, base, content };
	return undefined;
}

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
				+ '细节外移到 README 或 skill，规则文件只留可证伪的条目——它是项目基线，越短越容易被真正遵守。',
		);
	}
	return messages;
}

/**
 * Advisory message for an `AGENTS.md` that records progress. Progress belongs
 * to the commit history and the conversation; the rule file is read into every
 * session's context, so a status section crowds out the rules and then goes
 * stale with nobody responsible for removing it.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or one advisory message.
 */
export function progressAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	if (text.trim() === '') return [];
	const offending = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || !STRUCTURAL_LINE_RE.test(line) || !PROGRESS_RE.test(line)) continue;
		// The rule that forbids the record is not a record of one.
		if (PROGRESS_PROHIBITION_RE.test(line)) continue;
		offending.push(line);
	}
	if (offending.length === 0) return [];
	const shown = offending.slice(0, 3).map((line) => `「${excerptOf(line)}」`).join('');
	const more = offending.length > 3 ? `等 ${offending.length} 处` : '';
	return [
		`Spec mode: AGENTS.md 里出现了进度类内容：${shown}${more}。`
			+ '这份文件只放文档索引与开发规范规则——不写现状、进度、待办、下一步、里程碑、'
			+ '已完成或未完成清单、变更记录。它是每个会话都读进上下文的基线，进度会挤占规则的位置、'
			+ '而且很快过期没人删。进度属于提交历史、issue 或对话。',
	];
}

/**
 * Every advisory for one deliverable write, in a stable order.
 * @param {'agents' | 'brief'} kind - which deliverable this is.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function deliverableAdvisories(kind, content) {
	if (kind === 'brief') return briefAdvisories(content);
	return [...agentsMdAdvisories(content), ...progressAdvisories(content)];
}
