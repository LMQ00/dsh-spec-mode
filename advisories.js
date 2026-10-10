/**
 * Advisory-only checks for a spec-mode deliverable write: `AGENTS.md` or a
 * Markdown file under a `docs/` directory.
 *
 * Content-quality constraints stay prompt-level: nothing here blocks a write.
 * `@deepseek-ai/dsh-agent-instructions` reads `AGENTS.md` as a byte-budgeted
 * baseline when the deployment composes it, so an over-long rule file is
 * truncated or dropped rather than merely verbose — the same reason the line
 * budget exists here. The writing checks encode three landing-protocol
 * requirements as a nudge at write time: every deliverable opens with a
 * plain-language lead a layperson can read, carries no code (terms stay welcome,
 * commands a reader can run stay too), and records a decision as the decision
 * alone, never together with the alternative it beat.
 *
 * @module dsh-spec-mode/advisories
 */

/** Line budget above which AGENTS.md adherence measurably degrades. */
export const AGENTS_MD_LINE_LIMIT = 200;

/** Shortest lead paragraph still able to carry a plain-language summary. */
export const PLAIN_LEAD_MIN_CHARS = 24;

/** Inline code in the lead means the lead was not written for a layperson. */
const CODE_MARK_RE = /`/;

/** A path-ish token: `docs/api.md`, `./x`, `C:\x`, `https://x`. */
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|(?:^|[^\w-])[\w.-]*[\\/][\w.-]+)/;

/** Line shapes that never carry the prose of a lead paragraph. */
const NON_PROSE_LINE_RE = /^\s*(?:#{1,6}\s|```|\||>|[-*+]\s|\d+[.)]\s)/;

/** Line shapes that introduce a labelled block, where a decision would be recorded. */
const STRUCTURAL_LINE_RE = /^\s*(?:#{1,6}\s|\*\*|[-*+]\s|\d+[.)]\s)/;

/** Source and config file extensions: a name carrying one of these is code. */
const SOURCE_EXT = String.raw`(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|php|java|kt|swift|json|toml|ya?ml|cfg|ini|lock|sql)`;

/** A source or config file name, which a produced document never cites. */
const FILE_REF = String.raw`\b[\w.-]+\.${SOURCE_EXT}\b`;

/**
 * Words that start a command a reader can run. Reproduction steps and run
 * instructions belong in a document, so text hanging off one of these is never
 * reported as code.
 */
const COMMAND_WORDS = 'npm|pnpm|yarn|npx|node|deno|bun|git|python3?|pip3?|uv|cargo|rustc|go|make|cmake'
	+ '|docker|kubectl|curl|wget|tar|unzip|ssh|scp|rsync|pwsh|powershell|bash|sh|zsh'
	+ '|reg|schtasks|netsh|choco|winget|apt|apt-get';

/** A line that begins with a command, ignoring a prompt prefix or a leading path. */
const COMMAND_START_RE = new RegExp(`^(?:sudo\\s+)?(?:\\.{1,2}[\\\\/])?(?:${COMMAND_WORDS})\\b`, 'i');

/** A command and its target file, as written mid-sentence. */
const COMMAND_TARGET_RE = new RegExp(`\\b(?:${COMMAND_WORDS})\\s+[\\w./\\\\-]+\\.[\\w-]+`, 'gi');

/** A code-shaped span: a file name, a call, or an identifier. */
const CODE_SPAN_RE = new RegExp(
	[FILE_REF, String.raw`\w+\(\)`, String.raw`[a-z]+_[a-z_]+`, String.raw`[A-Z][A-Z0-9]*_[A-Z0-9_]+`, String.raw`[=;{}]`].join('|'),
);

/** A call written as `foo()`, or a constant in screaming case. These never stay. */
const IDENTIFIER_REF_RE = new RegExp(
	[String.raw`\b[A-Za-z_$][\w$]*(?:\.[\w$]+)*\(\)`, String.raw`\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b`].join('|'),
);

/** A source or config file name on its own. A listing may cite one. */
const FILE_REF_RE = new RegExp(FILE_REF);

/**
 * Whether one line is a command a reader could run, ignoring a prompt prefix.
 * A slash command counts: it is what the reader types.
 * @param {string} line - the trimmed line.
 * @returns {boolean} true for a runnable command.
 */
function isCommandLine(line) {
	const stripped = line.replace(/^(?:\$\s+|PS>\s+|>\s+)/, '').trim();
	return stripped.startsWith('/') || COMMAND_START_RE.test(stripped);
}

/**
 * The document's fenced blocks, each as its own list of inner lines.
 * @param {string} text - the written content.
 * @returns {string[][]} one entry per fenced block.
 */
function fencedBlocks(text) {
	const blocks = [];
	let current;
	for (const line of text.split('\n')) {
		if (/^\s*```/.test(line)) {
			if (current === undefined) current = [];
			else {
				blocks.push(current);
				current = undefined;
			}
			continue;
		}
		if (current !== undefined) current.push(line);
	}
	return blocks;
}

/**
 * The first fenced block that is source text rather than a runnable command. A
 * block counts as runnable when every line of it is a command, a flag or flag
 * continuation, or a shell comment — the shape a reproduction step takes.
 * @param {string} text - the written content.
 * @returns {string | undefined} the block's first line, when the block is source.
 */
function firstSourceBlock(text) {
	for (const block of fencedBlocks(text)) {
		const lines = block.map((line) => line.trim()).filter((line) => line !== '');
		if (lines.length === 0) continue;
		const runnable = lines.every((line) => isCommandLine(line) || /^[-|>#]/.test(line));
		if (!runnable) return lines[0];
	}
	return undefined;
}

/**
 * The document without its fenced blocks, so the prose passes do not report a
 * block twice.
 * @param {string} text - the written content.
 * @returns {string} the content with fences and their bodies removed.
 */
function withoutFences(text) {
	const kept = [];
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) kept.push(line);
	}
	return kept.join('\n');
}

/**
 * Split inline spans out of the prose. Spans are examined on their own, because
 * a span holding a command stays and a span holding an identifier does not.
 * @param {string} text - the content, already stripped of fenced blocks.
 * @returns {{ spans: string[], rest: string }} the span contents and the prose.
 */
function splitSpans(text) {
	const spans = [];
	const rest = text.replace(/`([^`\n]+)`/g, (_match, span) => {
		spans.push(String(span));
		return ' ';
	});
	return { spans, rest };
}

/**
 * One line with every mid-sentence command and its target removed, so a run
 * instruction does not read as a file-name citation.
 * @param {string} line - the trimmed line.
 * @returns {string} the line without command segments.
 */
function withoutCommandTargets(line) {
	return line.replace(COMMAND_TARGET_RE, ' ');
}

/**
 * The first plain-text line citing code, skipping lines that run as commands. A
 * table row may cite a file name — that is a listing, an address — but never a
 * call or a constant.
 * @param {string} text - the prose, already stripped of fences and spans.
 * @returns {string | undefined} the offending line, when there is one.
 */
function firstCodeReference(text) {
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || isCommandLine(line)) continue;
		const stripped = withoutCommandTargets(line);
		if (IDENTIFIER_REF_RE.test(stripped)) return line;
		if (!line.includes('|') && FILE_REF_RE.test(stripped)) return line;
	}
	return undefined;
}

/**
 * Wording that means a decision was written down together with the alternative
 * it replaced. Matched only on structural lines, so prose that merely mentions
 * an alternative does not fire.
 */
const REJECTION_RE = /(为什么不|为何不|不选它|不采用|被否决|否决的|替代方案|备选方案|rejected|alternatives?\s+considered|why\s+not)/i;

/**
 * A line that forbids the rejection record rather than making one — the rule
 * statement itself. Such a line is about the practice, not an instance of it.
 */
const PROHIBITION_RE = /(不写|不记|不要写|别写|禁止写|不需要写|避免写|不记录)/;

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
 * One code advisory message, quoting the line that triggered it.
 * @param {string} label - what kind of code was found.
 * @param {string} line - the offending line, already trimmed.
 * @returns {string} the advisory text.
 */
function codeMessage(label, line) {
	return `Spec mode: 文档里出现了${label}：「${excerptOf(line)}」。`
		+ '产出文档写人话——源码、函数名、字段名、配置文件名、调用形式都不该出现；'
		+ '命令可以有（复现某一步、要执行什么时照原样给），术语也可以用。'
		+ '要指代代码里的东西，就用它在系统里干的那件事来称呼。'
		+ '见提示词「产出文档的写法：要说人话，不写代码」。';
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
 * a Markdown file counts as a document when any of its directories is `docs/`.
 * The interview draft is a deliverable by this rule too — the caller excludes it.
 *
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @param {boolean} isError - whether the call settled as an error.
 * @returns {{ kind: 'agents' | 'doc', path: string, base: string, content: string } | undefined} the write.
 */
export function specDeliverableWrite(toolName, args, isError) {
	if (isError || toolName !== 'write') return undefined;
	const target = writeTarget(args);
	if (target === undefined) return undefined;
	const segments = [...target.segments];
	const base = segments.pop() ?? '';
	const content = typeof args.content === 'string' ? args.content : '';
	if (base === 'AGENTS.md') return { kind: 'agents', path: target.target, base, content };
	if (!base.endsWith('.md')) return undefined;
	if (!segments.includes('docs')) return undefined;
	return { kind: 'doc', path: target.target, base, content };
}

/**
 * The written content of an `AGENTS.md` write, or `undefined` when this call is
 * something else.
 * @param {string} toolName - the model-facing tool name.
 * @param {unknown} args - the parsed tool arguments.
 * @param {boolean} isError - whether the call settled as an error.
 * @returns {string | undefined} the written content, when this is such a write.
 */
export function agentsMdWriteContent(toolName, args, isError) {
	const write = specDeliverableWrite(toolName, args, isError);
	return write !== undefined && write.kind === 'agents' ? write.content : undefined;
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
				+ '细节外移到 docs/ 或 skill，规则文件只留可证伪的条目——它是项目基线，越短越容易被真正遵守。',
		);
	}
	return messages;
}

/**
 * The document's opening region: every line before its first level-2 heading,
 * with fenced code excluded.
 * @param {string} text - the written content.
 * @returns {string} the lead region.
 */
function leadRegion(text) {
	const kept = [];
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && /^#{2,}\s/.test(line)) break;
		if (!inFence) kept.push(line);
	}
	return kept.join('\n');
}

/**
 * Whether the lead carries a paragraph a layperson can read: prose long enough
 * to say something, with no inline code and no path.
 * @param {string} text - the written content.
 * @returns {boolean} true when such a paragraph exists.
 */
function hasPlainLead(text) {
	for (const block of leadRegion(text).split(/\n\s*\n/)) {
		const paragraph = block
			.split('\n')
			.filter((line) => !NON_PROSE_LINE_RE.test(line))
			.join('\n')
			.trim();
		if (paragraph.length < PLAIN_LEAD_MIN_CHARS) continue;
		if (CODE_MARK_RE.test(paragraph)) continue;
		if (PATH_TOKEN_RE.test(paragraph)) continue;
		return true;
	}
	return false;
}

/**
 * Advisory messages for a deliverable that does not open with a plain-language
 * lead.
 * @param {'agents' | 'doc'} kind - which deliverable this is.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function plainLanguageAdvisories(kind, content) {
	const text = typeof content === 'string' ? content : '';
	if (text.trim() === '' || hasPlainLead(text)) return [];
	const subject = kind === 'agents' ? 'AGENTS.md' : '这份文档';
	return [
		`Spec mode: ${subject}开头没有外行读得懂的白话导读。`
			+ `第一个小节标题之前要有至少一段 ${PLAIN_LEAD_MIN_CHARS} 字以上的白话（不含代码、反引号、字段名、路径），`
			+ '说明它回答什么问题、谁在什么场景下读、读完能做什么。写法见提示词「产出文档的写法：要说人话，不写代码」。',
	];
}

/**
 * Advisory messages for a deliverable that records a decision together with the
 * alternative it beat.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function decisionRationaleAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || !STRUCTURAL_LINE_RE.test(line) || !REJECTION_RE.test(line)) continue;
		// The rule that forbids the record is not a record of one.
		if (PROHIBITION_RE.test(line)) continue;
		return [
			'Spec mode: 文档里出现了「为什么不选别的方案」的痕迹：'
				+ `「${excerptOf(line)}」。决策只记结论——定了什么、约束谁、怎么用；`
				+ '被否决方案与理由删掉。见提示词「决策只记结论，不记否决理由」。',
		];
	}
	return [];
}

/**
 * Advisory messages for a deliverable that carries code. Terms are welcome and
 * commands a reader can run stay — a reproduction step or a run instruction
 * belongs in a document. What does not: source text, source and config file
 * names, function and field names, calls written as `foo()`, and constants.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function codeFreeAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	if (text.trim() === '') return [];
	const messages = [];
	const source = firstSourceBlock(text);
	if (source !== undefined) messages.push(codeMessage('源码代码块', source));
	const prose = withoutFences(text);
	const { spans, rest } = splitSpans(prose);
	for (const span of spans) {
		const line = span.trim();
		if (line === '' || isCommandLine(line) || !CODE_SPAN_RE.test(line)) continue;
		messages.push(codeMessage('行内代码（源码文件名、函数名或标识符）', line));
		break;
	}
	const reference = firstCodeReference(rest);
	if (reference !== undefined) messages.push(codeMessage('代码引用（源码文件名、函数名或常量）', reference));
	return messages;
}

/**
 * The clauses the produced AGENTS.md must carry, each with the wording that
 * marks it. The plugin's own documentation requirements travel with the file —
 * that is what keeps the next session in the repository writing this way.
 */
const DOC_RULE_MARKERS = [
	['改代码前同步过时文档', /过时/],
	['文档不写代码（术语可用、命令可有）', /(不写代码|不出现代码)/],
	['首段白话导读', /(导读|白话|外行)/],
	['决策只记结论', /(决策只记结论|只记结论)/],
];

/**
 * Advisory messages for an AGENTS.md whose rule block is missing the
 * documentation rules the landing protocol requires.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function documentationRulesAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	if (text.trim() === '') return [];
	const missing = DOC_RULE_MARKERS.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
	if (missing.length === 0) return [];
	return [
		`Spec mode: AGENTS.md 的规则块缺少文档相关规则：${missing.join('、')}。`
			+ '这四条要跟着落盘文件传下去（自举）——改代码前同步过时文档、文档不写代码（术语可用、命令可有）、'
			+ '首段白话导读、决策只记结论。见提示词「完成后的落盘顺序」的文档规则块。',
	];
}

/**
 * Every advisory for one deliverable write, in a stable order: the AGENTS.md
 * line budget and its required rule block first (both change what the file does
 * as a baseline), then the three writing checks — code, the lead a layperson can
 * read, and the rejected alternative that must not be recorded.
 * @param {'agents' | 'doc'} kind - which deliverable this is.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function deliverableAdvisories(kind, content) {
	return [
		...(kind === 'agents' ? agentsMdAdvisories(content) : []),
		...(kind === 'agents' ? documentationRulesAdvisories(content) : []),
		...codeFreeAdvisories(content),
		...plainLanguageAdvisories(kind, content),
		...decisionRationaleAdvisories(content),
	];
}
