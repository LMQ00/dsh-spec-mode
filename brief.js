/**
 * The requirement brief: the product a later session reads as its plan.
 *
 * Only requirements go in here — what to build, how it is judged done, which
 * constraints bound it. No code, no reasoning, no background: everything that is
 * not a requirement competes with the requirements for the reader's attention,
 * so the format bans it structurally instead of asking for restraint in prose.
 *
 * `validateBrief` is the one gate both landing paths share: the reviewed exit
 * renders a validated object, and the hand-written path runs the same checks on
 * the finished text before reporting a shape problem.
 *
 * @module dsh-spec-mode/brief
 */

/** Longest a single line may run before it stops being one requirement. */
const LINE_MAX_CHARS = 400;

/**
 * Wording that is never a requirement: it explains, justifies or rehearses the
 * decision instead of stating what to build. Matched case-insensitively.
 */
const REASON_RE = new RegExp(
	[
		'为什么', '为何', '因为', '之所以', '权衡', '取舍', '背景', '动机',
		'被否决', '否决', '备选方案', '替代方案', '方案比较', '好处是', '理由是', '考虑到', '出于',
		'\\bwhy\\b', '\\bbecause\\b', '\\btrade-?offs?\\b', '\\brationale\\b',
		'\\bbackground\\b', '\\bmotivation\\b', '\\brejected\\b', '\\balternatives?\\b',
	].join('|'),
	'i',
);

/**
 * A machine-specific absolute path. These resolve on one machine only and leak
 * the directory layout, so they never belong in a brief.
 */
const LOCAL_PATH_RE = /(?:^|[\s(（`"'])(?:\/home\/|\/Users\/|\/storage\/|\/nix\/store\/|[A-Za-z]:[\\/])/;

/** A fenced code block: the brief carries requirements, never code. */
const CODE_FENCE_RE = /^\s*```/;

/**
 * Inline markers that make a backticked snippet code rather than a name: a call,
 * an arrow, a block, a statement, or a comparison. A bare command stays fine —
 * that is how an acceptance check is written down — so `=` is handled separately
 * from these, because a flag (`--format=csv`) and an environment prefix
 * (`NODE_ENV=test`) also contain one.
 */
const CODE_MARK_RE = /=>|\(\)|\{\}|[{};]|\bfunction\b|\bconst\b|\breturn\b|[=!<>]=/;

/**
 * Whether one backticked snippet is code.
 * @param {string} body - the snippet without its backticks.
 * @returns {boolean} true when it is code rather than a command or a name.
 */
function isCodeSnippet(body) {
	if (CODE_MARK_RE.test(body)) return true;
	for (const assignment of body.match(/[^\s=]+\s*=(?!=)\s*\S+/g) ?? []) {
		const lhs = assignment.slice(0, assignment.indexOf('=')).trim();
		if (lhs.startsWith('-')) continue; // a flag carrying a value: --format=csv
		if (/^[A-Z][A-Z0-9_]*$/.test(lhs)) continue; // an environment prefix: NODE_ENV=test
		return true; // an assignment: x = 1
	}
	return false;
}

/**
 * The inline snippets of one line that are code rather than a name.
 * @param {string} line - one trimmed line.
 * @returns {string[]} the offending snippets, backticks included.
 */
function codeSnippets(line) {
	return (line.match(/`[^`\n]*`/g) ?? []).filter((snippet) => isCodeSnippet(snippet.slice(1, -1)));
}

/**
 * A line that opens as a Markdown heading. The renderer writes one bullet or one
 * paragraph line per value, so a value starting with `#` reads back as a new
 * section — the text would be lost, and the section it named would be empty.
 */
const HEADING_RE = /^#{1,6}\s/;

/**
 * One content problem, or `undefined` when the line is usable as a requirement.
 * A value carrying a line break is checked line by line: a fence or a block
 * smuggled into one bullet is still code, and a wrapped requirement is still two
 * requirements the reader has to rejoin.
 * @param {string} line - the trimmed field value.
 * @param {string} path - the field path, for the message.
 * @returns {string | undefined} the problem.
 */
function lineProblem(line, path) {
	if (line === '') return `${path}: 不能为空`;
	if (line.length > LINE_MAX_CHARS) return `${path}: 超过 ${LINE_MAX_CHARS} 字符，拆成多条`;
	for (const part of line.split('\n')) {
		const problem = singleLineProblem(part.trim(), path);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

/**
 * The problems of one already-split line.
 * @param {string} line - one trimmed line.
 * @param {string} path - the field path, for the message.
 * @returns {string | undefined} the problem.
 */
function singleLineProblem(line, path) {
	// A value opening with `#` would be read back as a section heading: the
	// renderer puts it on its own line, so the reader and the parser both see a
	// new section instead of a value. The text survives only if it cannot be
	// mistaken for structure.
	if (HEADING_RE.test(line)) {
		return `${path}: 不能以 # 开头，会被当成小节标题`;
	}
	if (CODE_FENCE_RE.test(line)) {
		return `${path}: 含代码；brief 只写需求，不写代码`;
	}
	const snippets = codeSnippets(line);
	if (snippets.length > 0) {
		return `${path}: 含代码「${snippets[0]}」；brief 只写需求，不写代码`;
	}
	const reason = REASON_RE.exec(line);
	if (reason !== null) {
		return `${path}: 含「${reason[0]}」这类理由说明；brief 只写需求，不写为什么`;
	}
	if (LOCAL_PATH_RE.test(line)) {
		return `${path}: 含本机绝对路径；换成相对仓库根的路径`;
	}
	return undefined;
}

/**
 * The content problems of one text field.
 * @param {string} value - the raw field value.
 * @param {string} path - the field path.
 * @returns {string[]} zero or more problems.
 */
function textProblems(value, path) {
	if (typeof value !== 'string') return [`${path}: 必须是字符串`];
	const trimmed = value.trim();
	if (trimmed === '') return [`${path}: 不能为空`];
	if (trimmed.includes('\n')) return [`${path}: 只能一行，不要换行`];
	const problem = lineProblem(trimmed, path);
	return problem === undefined ? [] : [problem];
}

/**
 * The content problems of one bullet list. A bullet is one line by definition:
 * a value carrying a line break would render as two bullets and read back as
 * one, so the second line would be lost at landing time.
 * @param {unknown} value - the raw array.
 * @param {string} path - the field path.
 * @param {boolean} required - whether an empty list is a problem.
 * @returns {string[]} zero or more problems.
 */
function listProblems(value, path, required) {
	if (value === undefined || value === null) {
		return required ? [`${path}: 缺失`] : [];
	}
	if (!Array.isArray(value)) return [`${path}: 必须是字符串数组`];
	if (required && value.length === 0) return [`${path}: 至少一条`];
	const problems = [];
	value.forEach((item, index) => {
		const itemPath = `${path}[${index}]`;
		if (typeof item !== 'string') {
			problems.push(`${itemPath}: 必须是字符串`);
			return;
		}
		const trimmed = item.trim();
		if (trimmed.includes('\n')) {
			problems.push(`${itemPath}: 只能一行，不要换行`);
			return;
		}
		const problem = lineProblem(trimmed, itemPath);
		if (problem !== undefined) problems.push(problem);
	});
	return problems;
}

/**
 * Validate and normalize one brief.
 *
 * Returns problems instead of throwing: the reviewed-exit tool turns them into
 * one repair instruction, and the hand-written path reports them as advisories.
 *
 * @param {unknown} input - the model-supplied brief.
 * @returns {{ ok: true, brief: object } | { ok: false, errors: string[] }} the outcome.
 */
export function validateBrief(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return { ok: false, errors: ['brief: 必须是一个对象 { title, goal, requirements, acceptance, constraints }'] };
	}
	const errors = [
		...textProblems(input.title, 'brief.title'),
		...textProblems(input.goal, 'brief.goal'),
		...listProblems(input.requirements, 'brief.requirements', true),
		...listProblems(input.acceptance, 'brief.acceptance', true),
		...listProblems(input.constraints, 'brief.constraints', false),
	];
	if (errors.length > 0) return { ok: false, errors };
	const list = (value) => (Array.isArray(value) ? value.map((item) => item.trim()) : []);
	return {
		ok: true,
		brief: {
			title: input.title.trim(),
			goal: input.goal.trim(),
			requirements: list(input.requirements),
			acceptance: list(input.acceptance),
			constraints: list(input.constraints),
		},
	};
}

/**
 * Render one validated brief to the exact file content.
 * @param {object} brief - the validated brief.
 * @returns {string} the Markdown text, ending in one newline.
 */
export function renderBrief(brief) {
	const lines = [`# ${brief.title}`, '', '## 目标', brief.goal, '', '## 要做什么'];
	for (const item of brief.requirements) lines.push(`- ${item}`);
	lines.push('', '## 验收');
	for (const item of brief.acceptance) lines.push(`- ${item}`);
	if (brief.constraints.length > 0) {
		lines.push('', '## 约束');
		for (const item of brief.constraints) lines.push(`- ${item}`);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Read back a hand-written brief. Tolerant on layout, strict on meaning: a
 * missing section or an unusable line becomes a problem, not a silent pass.
 * @param {string} content - the written file content.
 * @returns {{ ok: true, brief: object } | { ok: false, errors: string[] }} the outcome.
 */
export function parseBrief(content) {
	if (typeof content !== 'string' || content.trim() === '') {
		return { ok: false, errors: ['brief.md: 文件为空'] };
	}
	// A file written on another platform carries CRLF; the heading and bullet
	// patterns anchor on `$`, so the trailing CR has to go before matching.
	const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const title = lines.map((line) => /^#\s+(.+?)\s*$/.exec(line)).find((match) => match !== null);
	const sections = new Map();
	const duplicates = [];
	let current = null;
	for (const raw of lines) {
		const heading = /^##\s+(.+?)\s*$/.exec(raw);
		if (heading !== null) {
			current = heading[1].replace(/[：:]\s*$/, '');
			// A repeated heading replaces the stored list, so keeping both would
			// silently drop everything under the first one.
			if (sections.has(current) && !duplicates.includes(current)) duplicates.push(current);
			sections.set(current, []);
			continue;
		}
		if (current !== null) sections.get(current).push(raw);
	}
	const errors = [];
	for (const name of duplicates) errors.push(`brief.md: 「## ${name}」出现了不止一次，合成一节`);
	if (title === null) errors.push('brief.md: 缺 `# 标题`');
	for (const name of ['目标', '要做什么', '验收']) {
		if (!sections.has(name)) errors.push(`brief.md: 缺「## ${name}」小节`);
	}
	// A bullet list drops anything that is not a bullet. A paragraph written under
	// one would vanish without a trace, so every non-empty non-bullet line there
	// is a problem rather than silence.
	for (const name of ['要做什么', '验收', '约束']) {
		for (const raw of sections.get(name) ?? []) {
			const line = raw.trim();
			if (line === '' || /^\s*[-*+]\s+/.test(raw)) continue;
			errors.push(`brief.md: 「## ${name}」里的「${line.slice(0, 30)}」不是一条列表项，每条前面加「- 」`);
		}
	}
	const bullets = (name) => {
		const body = sections.get(name) ?? [];
		return body.map((line) => /^\s*[-*+]\s+(.*)$/.exec(line)).filter((match) => match !== null).map((match) => match[1]);
	};
	const paragraph = (name) => (sections.get(name) ?? []).map((line) => line.trim()).filter((line) => line !== '').join(' ');
	const constraints = sections.has('约束') ? bullets('约束') : [];
	if (errors.length > 0) return { ok: false, errors };
	return validateBrief({
		title: title[1],
		goal: paragraph('目标'),
		requirements: bullets('要做什么'),
		acceptance: bullets('验收'),
		constraints: constraints.length > 0 ? constraints : undefined,
	});
}

/**
 * Shape problems for a hand-written brief, phrased as one advisory per file.
 * @param {string} content - the written file content.
 * @returns {string[]} zero or one advisory message.
 */
export function briefAdvisories(content) {
	const outcome = parseBrief(content);
	if (outcome.ok) return [];
	const shown = outcome.errors.slice(0, 5).join('；');
	return [
		`Spec mode: brief.md 不合格——${shown}。`
			+ 'brief 只写需求：`# 标题`，然后「## 目标」「## 要做什么」「## 验收」三节各一行一条，'
			+ '「## 约束」可有可无；不写代码、不写为什么、不写背景与方案比较，不出现本机绝对路径。'
			+ '改完再写一次覆盖它。',
	];
}
