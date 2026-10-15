/**
 * Advisory-only checks for a spec-mode deliverable write: `AGENTS.md` or a
 * Markdown file under a `docs/` directory.
 *
 * Content-quality constraints stay prompt-level: nothing here blocks a write.
 * `@deepseek-ai/dsh-agent-instructions` reads `AGENTS.md` as a byte-budgeted
 * baseline when the deployment composes it, so an over-long rule file is
 * truncated or dropped rather than merely verbose — the same reason the line
 * budget exists here. The writing checks encode the landing protocol as a nudge
 * at write time: a rule file records rules and nothing else, a document records
 * conclusions and hard facts rather than the reasoning behind them, code appears
 * only as a step the reader performs (and then must say which file, what to
 * execute, and what success looks like — command and picture blocks excepted),
 * and `AGENTS.md` carries the rule block that keeps this standard alive inside
 * the repository.
 *
 * Whether a document is written so a layperson can follow it is a judgement of
 * the whole text, not of its opening paragraph, so no check tries to approximate
 * it: a "plain lead" check only ever rewarded a single opening sentence while
 * the rest of the document stayed unreadable.
 *
 * @module dsh-spec-mode/advisories
 */

/** Line budget above which AGENTS.md adherence measurably degrades. */
export const AGENTS_MD_LINE_LIMIT = 200;

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
	['规则文件只放索引与规范，不写进度', /(进度|待办|下一步|现状)/],
	['文档只写结论、不解释', /(?:(?:只写|不写)[^\n]{0,20}(?:结论|硬事实|解释))|(?:(?:结论|硬事实|解释)[^\n]{0,20}(?:只写|不写))/],
	['文档信息密度极高', /(信息密度|一行一个结论|能进表格就进表格)/],
	['代码只在要人照做时出现，且跟着复现步骤', /复现/],
	['决策只记结论', /(决策只记结论|只记结论)/],
];

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

/**
 * Section headings that carry no fact a reader can use. A document states
 * conclusions; motivation, background and reasoning are the explanation it must
 * not contain, a glossary defines what the text should say in passing, and a
 * lead or a summary restates what the rest already says.
 */
const FILLER_HEADING_RE = /(?:导读|引言|前言|背景|动机|初衷|由来|缘起|历史|沿革|为什么|设计考量|设计思路|设计权衡|权衡|取舍|术语表|术语解释|名词解释|本章小结|小结|总结|综上|后记|结语)/;

/** Heads that introduce a block whose text is the reader's reference. */
const HEADING_RE = /^\s*#{1,6}\s+\S/;

/** A line that opens with a bold label, the other way a block gets a title. */
const BOLD_LABEL_RE = /^\s*\*\*\S/;

/** Longest a labelled line may run before it reads as prose rather than a title. */
const TITLE_MAX_CHARS = 40;

/**
 * Whether a structural line reads as a title rather than as prose carrying a
 * word. Only headings and short bold labels are titles: a bullet is normally a
 * statement, and reporting one would flag the very rule that forbids the
 * practice.
 * @param {string} line - the trimmed line.
 * @returns {boolean} true when the line introduces a block.
 */
function isBlockTitle(line) {
	if (HEADING_RE.test(line)) return true;
	return BOLD_LABEL_RE.test(line) && line.length <= TITLE_MAX_CHARS;
}

/**
 * The label of one structural line, stripped of its marker and any emphasis.
 * @param {string} line - the trimmed line.
 * @returns {string} the label, for quoting in a message.
 */
function titleLabel(line) {
	return line
		.replace(/^#{1,6}\s+/, '')
		.replace(/^\*\*/, '')
		.replace(/\*\*$/, '')
		.trim();
}

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
			+ '这几条要跟着落盘文件传下去（自举）——改代码前同步过时文档、规则文件只放索引与规范不写进度、'
			+ '文档只写结论不解释、信息密度极高、代码跟着复现步骤、决策只记结论。'
			+ '见提示词「完成后的落盘顺序」的文档规则块。',
	];
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
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || !STRUCTURAL_LINE_RE.test(line) || !PROGRESS_RE.test(line)) continue;
		// The rule that forbids the record is not a record of one.
		if (PROGRESS_PROHIBITION_RE.test(line)) continue;
		return [
			`Spec mode: AGENTS.md 里出现了进度类内容：「${excerptOf(line)}」。`
				+ '这份文件只放文档索引与开发规范规则——不写现状、进度、待办、下一步、里程碑、'
				+ '已完成或未完成清单、变更记录。它是每个会话都读进上下文的基线，进度会挤占规则的位置、'
				+ '而且很快过期没人删。进度属于提交历史、issue 或对话。'
				+ '见提示词「完成后的落盘顺序」。',
		];
	}
	return [];
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
				+ '见提示词「产出文档的写法：只写结论，写干货」。',
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
 * Advisory messages for a deliverable that explains itself: a section reserved
 * for motivation, background, design reasoning or a summary. A document states
 * conclusions and hard facts; the reasoning behind them is not the reader's
 * business, and a lead or a summary only restates what the rest already says.
 * Prose that happens to use one of these words is not reported — the check reads
 * block titles only, the same way the progress and rejection checks do.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function reasonAdvisories(content) {
	const text = typeof content === 'string' ? content : '';
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || !isBlockTitle(line)) continue;
		const label = titleLabel(line);
		if (!FILLER_HEADING_RE.test(label)) continue;
		// The rule that forbids such a section is not one.
		if (PROHIBITION_RE.test(label)) continue;
		return [
			`Spec mode: 文档里出现了不写事实的小节：「${excerptOf(label)}」。`
				+ '文档只写结论与硬事实——写了什么、怎么用、什么条件下不成立、下一步做什么；'
				+ '动机、背景、设计考量、小结这类小节删掉，开场不铺引言，结尾不做总结，'
				+ '纯事实的清单（命令、文件、参数）除外。见提示词「产出文档的写法：只写结论，写干货」。',
		];
	}
	return [];
}

/**
 * Every advisory for one deliverable write, in a stable order: the AGENTS.md
 * line budget, its required rule block, and its ban on progress content first
 * (all three change what the file does as a baseline), then the writing checks —
 * code without a reproduction step, the self-explaining section that must not be
 * written, and the rejected alternative that must not be recorded.
 * @param {'agents' | 'doc'} kind - which deliverable this is.
 * @param {string} content - the exact content being written.
 * @returns {string[]} zero or more advisory messages.
 */
export function deliverableAdvisories(kind, content) {
	return [
		...(kind === 'agents' ? agentsMdAdvisories(content) : []),
		...(kind === 'agents' ? documentationRulesAdvisories(content) : []),
		...(kind === 'agents' ? progressAdvisories(content) : []),
		...reproductionAdvisories(content),
		...reasonAdvisories(content),
		...decisionRationaleAdvisories(content),
	];
}