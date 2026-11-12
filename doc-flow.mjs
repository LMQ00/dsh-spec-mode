/**
 * Regenerates this repository's own flow chart — `.spec/flow.png`, the picture
 * the README shows.
 *
 * The chart is not hand-drawn: it is what the plugin itself produces, run
 * through the same three steps a landing takes (`validateFlow` → `renderFlowSvg`
 * → `rasterize`), so the picture in the README cannot drift from the behaviour
 * the code has. The nodes below restate the protocol in `prompt.js`; changing
 * the protocol means changing these nodes and running `npm run flow`.
 *
 * @module dsh-spec-mode/doc-flow
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateFlow } from './flow.js';
import { renderFlowSvg } from './flow-svg.js';
import { rasterize, svgSize } from './rasterize.js';
import { ensureSpecDir, resolveFlowImagePath, resolveFlowVectorPath, resolveSpecDir } from './state.js';

/** Drawn above the boxes; it is the one line a reader sees before the graph. */
export const TITLE = '一次 spec 访谈的流程';

/**
 * Two loops, both drawn as back arrows: the interview repeats until the user
 * says the requirements are complete, and a rejected submission repeats until
 * the two products pass validation. Unrolling either would tell the reader it
 * happens once.
 */
const chart = {
	nodes: [
		{ id: 'n1', label: '用户输入 /spec，模式打开，工作树变只读' },
		{ id: 'n2', label: '模型每轮把新需求写进草稿' },
		{ id: 'n3', label: '模型用自己的话复述，用户确认或纠正' },
		{ id: 'n4', label: '用户确认访谈结束，模型提交简报与流程图' },
		{ id: 'n5', label: '插件先校验这两份产物' },
		{ id: 'n6', label: '报错点名字段，模型改完再提交一次' },
		{ id: 'n7', label: '弹确认框，正文是简报全文与图上那些框' },
		{ id: 'n8', label: '模式保持不变，这次到此为止，等用户说话' },
		{ id: 'n9', label: '插件写 brief.md、画出 flow.png，删掉草稿' },
		{ id: 'n10', label: '模式退出，工作树恢复可写' },
		{ id: 'n11', label: '模型更新 AGENTS.md' },
	],
	edges: [
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n2', when: '还有要补的需求' },
		{ from: 'n3', to: 'n4', when: '用户确认结束' },
		{ from: 'n4', to: 'n5' },
		{ from: 'n5', to: 'n6', when: '校验不通过' },
		{ from: 'n6', to: 'n5' },
		{ from: 'n5', to: 'n7', when: '校验通过' },
		{ from: 'n7', to: 'n8', when: '继续访谈或关掉确认框' },
		{ from: 'n7', to: 'n9', when: '退出并落盘' },
		{ from: 'n9', to: 'n10' },
		{ from: 'n10', to: 'n11' },
	],
};

/** The chart as the plugin would validate it; throws only if this file is edited into an invalid graph. */
export const repoFlow = (() => {
	const outcome = validateFlow(chart);
	if (!outcome.ok) throw new Error(`doc-flow.mjs 自己画不出合法的图：\n${outcome.errors.join('\n')}`);
	return outcome.flow;
})();

/**
 * Write the chart to `.spec/`, the same way a landing does.
 * @param {string} cwd - the repository root to anchor `.spec` at.
 * @returns {Promise<string>} one line describing what was written.
 */
export async function writeRepoFlow(cwd = process.cwd()) {
	const svg = renderFlowSvg(repoFlow, TITLE);
	ensureSpecDir(resolveSpecDir(cwd));

	// Same order as a landing: the SVG is the layout, the PNG is the product. A
	// machine with no rasterizer keeps the SVG, which the README would still show.
	const vector = resolveFlowVectorPath(cwd);
	writeFileSync(vector, svg);
	const image = resolveFlowImagePath(cwd);
	const renderer = await rasterize(vector, image, svgSize(svg) ?? { width: 640, height: 480 });
	if (renderer === undefined) return `没有可用的转换器，留下矢量图 ${relative(cwd, vector)}`;
	unlinkSync(vector);
	return `已写出 ${relative(cwd, image)}（${renderer}）`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.log(await writeRepoFlow());
}
