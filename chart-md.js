/**
 * One chart, as the markdown file a person opens.
 *
 * `.spec/flows/<id>.md` is the whole chart: a title, the line that says from
 * where to where it runs, its `mermaid` block, and the requirements it exists
 * for. Markdown is the storage because it is also the reading format — the same
 * file renders in the panel, in an editor's preview, and on the repository page,
 * with no picture to regenerate and nothing to keep in sync.
 *
 * The file is written from a fixed shape, so two writers that agree on the chart
 * agree on the bytes, and the revision — a hash of those bytes — is what a stale
 * editor is checked against.
 *
 * @module dsh-spec-mode/chart-md
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parseMermaid, validateGraph } from './mermaid-graph.js';

/** The directory name, under `.spec`, that holds the collection. */
export const FLOWS_DIR = 'flows';

/** The file extension a chart is stored under. */
export const CHART_EXT = '.md';

/** The heading the brief starts at inside the same file. */
const BRIEF_HEADING = '## 简报';

/** The fence that opens the diagram block. */
const FENCE = '```mermaid';

/**
 * Absolute path of one chart's file.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} id - the chart id.
 * @returns {string} the path.
 */
export function chartPath(specDir, id) {
	return join(specDir, FLOWS_DIR, `${id}${CHART_EXT}`);
}

/**
 * The revision of one chart file's text.
 * @param {string} text - the canonical markdown.
 * @returns {string} the revision.
 */
export function revisionOf(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The text one chart is stored as.
 * @param {{ name: string, scope: string, source: string, brief?: string }} chart - the chart.
 * @returns {string} the markdown.
 */
export function canonicalMarkdown(chart) {
	const brief = (chart.brief ?? '').trim();
	// The four blocks are joined with exactly the blank lines between them. Nothing
	// is collapsed: the diagram and the brief are text someone wrote, and rewriting
	// its blank lines would change bytes it never asked to change.
	const head = `# ${chart.name}\n\n${chart.scope}\n\n`;
	const block = `${FENCE}\n${chart.source.trimEnd()}\n\`\`\`\n\n`;
	const tail = brief === '' ? BRIEF_HEADING : `${BRIEF_HEADING}\n\n${brief}`;
	return `${head}${block}${tail}\n`;
}

/**
 * Read one chart out of its markdown.
 *
 * Every part is required except the brief: a file without a title, a scope or a
 * mermaid block is a file nobody can act on, so it comes back as one named
 * problem rather than as a chart with empty fields.
 *
 * @param {string} id - the chart id, which is the file stem.
 * @param {string} text - the file's text.
 * @returns {{ chart: object } | { broken: string }} the chart or the problem.
 */
export function parseChartMarkdown(id, text) {
	// A byte-order mark is what an editor leaves behind; without stripping it the
	// title line is not a heading and the whole file "has no title".
	const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
	const titleAt = lines.findIndex((line) => /^#\s+\S/.test(line));
	if (titleAt === -1) return { broken: `${id}${CHART_EXT} 少了标题行「# 这张图叫什么」` };
	const name = lines[titleAt].replace(/^#\s+/, '').trim();

	const fenceAt = lines.findIndex((line, index) => index > titleAt && line.trim() === FENCE);
	if (fenceAt === -1) return { broken: `${id}${CHART_EXT} 少了 \`\`\`mermaid 块——图就在这里` };
	const closeAt = lines.findIndex((line, index) => index > fenceAt && line.trim() === '```');
	if (closeAt === -1) return { broken: `${id}${CHART_EXT} 的 mermaid 块没有闭合的 \`\`\`` };

	const scope = lines
		.slice(titleAt + 1, fenceAt)
		.join('\n')
		.trim();
	if (scope === '') return { broken: `${id}${CHART_EXT} 少了范围行：标题下面一句话，写这张图从哪一步到哪一步` };

	const briefAt = lines.findIndex((line, index) => index > closeAt && line.trim() === BRIEF_HEADING);
	const brief = briefAt === -1 ? '' : lines.slice(briefAt + 1).join('\n').trim();
	const source = `${lines.slice(fenceAt + 1, closeAt).join('\n').trimEnd()}\n`;

	return { chart: { id, name, scope, source, brief } };
}

/**
 * Parse one chart's source into its graph, refusing a block that will not draw.
 * @param {{ source: string }} chart - the chart.
 * @param {{ knownModules?: Set<string> }} [options] - ids a module node may name.
 * @returns {{ ok: true, graph: object } | { ok: false, errors: string[] }} the outcome.
 */
export function graphOf(chart, options = {}) {
	const parsed = parseMermaid(chart.source);
	if (!parsed.ok) return parsed;
	return validateGraph(parsed.graph, options);
}
