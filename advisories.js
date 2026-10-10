/**
 * Advisory-only checks for a spec-mode deliverable write: `AGENTS.md` or a
 * Markdown file under a `docs/` directory.
 *
 * Content-quality constraints stay prompt-level: nothing here blocks a write.
 * `@deepseek-ai/dsh-agent-instructions` reads `AGENTS.md` as a byte-budgeted
 * baseline when the deployment composes it, so an over-long rule file is
 * truncated or dropped rather than merely verbose — the same reason the line
 * budget exists here. The writing checks encode the landing protocol as a nudge
 * at write time: every deliverable opens with a plain-language lead a layperson
 * can read, code appears only as a step the reader performs (and then must say
 * which file, what to execute, and what success looks like — command and picture
 * blocks excepted), a decision is recorded as the decision alone, and
 * `AGENTS.md` carries the rule block that keeps this standard alive inside the
 * repository.
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

/**
 * Words that start a command a reader can run. A command block is already a
 * reproduction step, so it never needs the three-part explanation around it.
 */
const COMMAND_WORDS = 'npm|pnpm|yarn|npx|node|deno|bun|git|python3?|pip3?|uv|cargo|rustc|go|make|cmake'
	+ '|docker|kubectl|curl|wget|tar|unzip|ssh|scp|rsync|pwsh|powershell|bash|sh|zsh'
	+ '|reg|schtasks|netsh|choco|winget|apt|apt-get';

/** A line that begins with a command, ignoring a prompt prefix or a leading path. */
const COMMAND_START_RE = new RegExp(`^(?:sudo\\s+)?(?:\\.{1,2}[\\\\/])?(?:${COMMAND_WORDS})\\b`, 'i');

/** Fence tags that mean the block draws a picture instead of showing code. */
const PICTURE_INFOS = new Set(['mermaid', 'dot', 'graphviz', 'plantuml', 'puml', 'text', 'txt', 'ascii']);

/** Arrows and box drawing: the block is a picture even without a picture tag. */
const PICTURE_MARK_RE = /(?:-->|==>|→|⇢|←|─|│|┌|└|├|┐|┘|╰|╯)/;

/**
 * Wording that tells a reader how to make a block run: where it goes, what to
 * execute, or what success looks like.
 */
const REPRODUCTION_CUE_RE = /(写进|写入|保存为|保存到|存成|放进|放到|新建|创建|执行|运行|跑一下|跑一遍|复现|命令|示例|输出|看到|结果|expect)/i;

/** How many lines around a code block are read when looking for that wording. */
const CUE_LINES_BEFORE = 3;
const CUE_LINES_AFTER = 6;

/**
 * The clauses the produced AGENTS.md must carry, each with the wording that
 * marks it. The plugin's own writing requirements travel with the file — that is
 * what keeps the next session in the repository writing this way.
 */
const DOC_RULE_MARKERS = [
	['改代码前同步过时文档', /过时/],
	['代码只在要人照做时出现，且跟着复现步骤', /复现/],
	['首段白话导读', /(导读|白话|外行)/],
	['决策只记结论', /(决策只记结论|只记结论)/],
];

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
 * The document's fenced blocks, each with where it sits and what its info string
 * claims to be.
 * @param {string} text - the written content.
 * @returns {{ info: string, lines: string[], start: number, end: number }[]} the blocks.
 */
function fencedBlocks(text) {
	const lines = text.split('\n');
	const blocks = [];
	let open;
	for (let index = 0; index < lines.length; index += 1) {
		const fence = /^\s*```\s*(\S*)/.exec(lines[index]);
		if (fence === null) {
			if (open !== undefined) open.lines.push(lines[index]);
			continue;
		}
		if (open === undefined) {
			open = { info: fence[1].toLowerCase(), lines: [], start: index, end: index };
			continue;
		}
		open.end = index;
		blocks.push(open);
		open = undefined;
	}
	if (open !== undefined) {
		// An unterminated fence still runs to the end of the document.
		open.end = lines.length - 1;
		blocks.push(open);
	}
	return blocks;
}

/**
 * The non-empty lines of a block, trimmed.
 * @param {{ lines: string[] }} block - one fenced block.
 * @returns {string[]} its content lines.
 */
function blockBody(block) {
	return block.lines.map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * Whether a block runs as commands — every line a command, a flag, a flag
 * continuation, or a shell comment.
 * @param {{ info: string, lines: string[] }} block - one fenced block.
 * @returns {boolean} true for a command block.
 */
function isCommandBlock(block) {
	const body = blockBody(block);
	return body.length > 0 && body.every((line) => isCommandLine(line) || /^[-|>#]/.test(line));
}

/**
 * Whether a block draws a picture: tagged as a picture format, or built from
 * arrows and box drawing. A picture is not code, so it needs no reproduction
 * step — this only keeps the check from misreporting one.
 * @param {{ info: string, lines: string[] }} block - one fenced block.
 * @returns {boolean} true for a picture block.
 */
function isPictureBlock(block) {
	if (PICTURE_INFOS.has(block.info)) return true;
	return PICTURE_MARK_RE.test(block.lines.join('\n'));
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
 * Advisory messages for an AGENTS.md whose rule block is missing the writing
 * rules the landing protocol requires.
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
			+ '这几条要跟着落盘文件传下去（自举）——改代码前同步过时文档、代码跟着复现步骤、'
			+ '首段白话导读、决策只记结论。见提示词「完成后的落盘顺序」的文档规则块。',
	];
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
			+ '说明它回答什么问题、谁在什么场景下读、读完能做什么。写法见提示词「产出文档的写法：说人话」。',
	];
}

/**
 * Advisory messages for a code block that does not say how to make it run. A
 * command block already is a reproduction step, and a picture block is not code,
 * so neither is reported.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function reproductionAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	if (text.trim() === '') return [];
	const lines = text.split('\n');
	for (const block of fencedBlocks(text)) {
		if (isCommandBlock(block) || isPictureBlock(block)) continue;
		const body = blockBody(block);
		if (body.length === 0) continue;
		const around = [
			...lines.slice(Math.max(0, block.start - CUE_LINES_BEFORE), block.start),
			...lines.slice(block.end + 1, block.end + 1 + CUE_LINES_AFTER),
		].join('\n');
		if (REPRODUCTION_CUE_RE.test(around)) continue;
		return [
			`Spec mode: 这段代码旁边没有复现步骤：「${excerptOf(body[0])}」。`
				+ '代码能不出就不出——要靠贴代码讲实现，说明这段逻辑还没讲清；真要给读者照做的步骤，'
				+ '就补上三件事：写进哪个文件（或直接在哪执行）、执行什么、看到什么算成功。'
				+ '命令行块与图形块不必（命令行本身就是步骤，图形不是代码）。'
				+ '见提示词「产出文档的写法：说人话」。',
		];
	}
	return [];
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
 * Every advisory for one deliverable write, in a stable order: the AGENTS.md
 * line budget and its required rule block first (both change what the file does
 * as a baseline), then the writing checks — code without a reproduction step,
 * the lead a layperson can read, and the rejected alternative that must not be
 * recorded.
 * @param {'agents' | 'doc'} kind - which deliverable this is.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function deliverableAdvisories(kind, content) {
	return [
		...(kind === 'agents' ? agentsMdAdvisories(content) : []),
		...(kind === 'agents' ? documentationRulesAdvisories(content) : []),
		...reproductionAdvisories(content),
		...plainLanguageAdvisories(kind, content),
		...decisionRationaleAdvisories(content),
	];
}