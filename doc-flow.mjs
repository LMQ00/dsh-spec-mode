// Generates this repository's own chart collection into .spec/flows/.
//
// The charts live in code rather than in the landed JSON for one reason: this
// repository is the plugin's own first user, so its charts have to be
// regenerable after every change without re-running an interview.
//
// Run: npm run flow

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { validateChart, validateCollection, writeChartModel } from './flows.js';
import { renderFlowSvg } from './flow-svg.js';
import { drawableChart } from './flows.js';
import { rasterize, svgSize } from './rasterize.js';
import { resolveFlowsDir, resolveSpecDir } from './state.js';

/** Where the run writes, regardless of where npm invoked it from. */
const ROOT = new URL('.', import.meta.url).pathname;

/** The overview: the whole product, with every step below summarised as a module. */
export const overview = {
	id: 'overview',
	kind: 'overview',
	name: '一次 spec 访谈',
	scope: '从用户说出这次要做什么，到 .spec/flows/ 里出现新的图集',
	nodes: [
		{ id: 'n1', label: '用户输入 /spec，说清这次要做什么' },
		{ id: 'n2', label: '模型逐轮访谈，每轮把结论写进草稿' },
		{ id: 'n3', label: '用户确认访谈结束，模型提交图集' },
		{ id: 'n4', module: 'check', ports: ['入：本次提交的图与各自的简报', '出：校验通过或点名报错'] },
		{ id: 'n5', module: 'land', ports: ['入：校验通过的图集', '出：.spec/flows/ 下三件套齐了'] },
		{ id: 'n6', module: 'view', ports: ['入：.spec/flows/ 里有图集', '出：改好的图与简报回到盘上'] },
		{ id: 'n7', label: '模型更新 AGENTS.md 的文档索引' },
	],
	edges: [
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
		{ from: 'n5', to: 'n6' },
		{ from: 'n6', to: 'n7' },
	],
};

/** Landing: the reviewed write of one landing call. */
export const land = {
	id: 'land',
	kind: 'module',
	name: '落盘',
	scope: '从用户点「退出并落盘」到草稿消失',
	nodes: [
		{ id: 'n1', label: '用户点「退出并落盘」' },
		{ id: 'n2', label: '只写本次提交的图，未提交的保持原样' },
		{ id: 'n3', label: '删掉删除列表里的图' },
		{ id: 'n4', label: '重画这些图与引用它们的图' },
		{ id: 'n5', label: '删掉草稿，模式退出' },
	],
	edges: [
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
	],
};

/** Validation: the gate before anything is written. */
export const check = {
	id: 'check',
	kind: 'module',
	name: '校验',
	scope: '从收到提交的图集到给出通过或逐条报错',
	nodes: [
		{ id: 'n1', label: '逐张查 id、kind、name、scope' },
		{ id: 'n2', label: '逐张查节点、连线、回箭头、分叉条件' },
		{ id: 'n3', label: '查整册：恰好一张总览、引用都指得到、不成环' },
		{ id: 'n4', label: '给用户看确认框' },
		{ id: 'n5', label: '点名报错，模型改完重交' },
	],
	edges: [
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4', when: '全部通过' },
		{ from: 'n3', to: 'n5', when: '有一条不过' },
		{ from: 'n5', to: 'n1' },
	],
};

/** The view: what a person does in the conversation's chart page. */
export const view = {
	id: 'view',
	kind: 'module',
	name: '看图改图',
	scope: '从打开「流程图」页到把改好的图存回盘上',
	nodes: [
		{ id: 'n1', label: '用户打开会话视图的「流程图」页' },
		{ id: 'n2', label: '左栏按引用关系列出图集，选中一张' },
		{ id: 'n3', label: '主区并排显示这张图与它的简报' },
		{ id: 'n4', label: '用户改框里的文字或连线上的条件' },
		{ id: 'n5', label: '用户按 Ctrl/Cmd+S' },
		{ id: 'n6', label: '写盘并重画这张图' },
		{ id: 'n7', label: '提示冲突，等用户重新载入' },
	],
	edges: [
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
		{ from: 'n5', to: 'n6', when: '盘上没有别人改过' },
		{ from: 'n5', to: 'n7', when: '盘上的图已经变了' },
		{ from: 'n7', to: 'n3' },
	],
};

/** Everything the run writes, in the order it writes them. */
export const charts = [overview, check, land, view];

/**
 * Write one chart's model and picture.
 * @param {string} specDir - the absolute `.spec` directory.
 * @param {string} flowsDir - the absolute chart directory.
 * @param {object} model - the chart to draw.
 * @param {Map<string, object>} models - every chart, for module boxes' names.
 */
async function writeOne(specDir, flowsDir, model, models) {
	writeChartModel(specDir, model);
	const svg = renderFlowSvg(drawableChart(model, models), `${model.name}：功能流程`);
	const vector = join(flowsDir, `${model.id}.svg`);
	const image = join(flowsDir, `${model.id}.png`);
	await import('node:fs').then((fs) => fs.writeFileSync(vector, svg, 'utf8'));
	const renderer = await rasterize(vector, image, svgSize(svg) ?? { width: 640, height: 480 });
	if (renderer !== undefined) {
		await import('node:fs').then((fs) => {
			try { fs.unlinkSync(vector); } catch { /* keep the SVG: it is still a picture */ }
		});
	}
}

/** Validate everything, then write it. Validation first: a broken chart would land a broken picture. */
async function main() {
	const cwd = process.cwd();
	const specDir = resolveSpecDir(cwd);
	const flowsDir = resolveFlowsDir(cwd);
	mkdirSync(flowsDir, { recursive: true });

	const models = new Map(charts.map((chart) => [chart.id, chart]));
	const known = new Set(models.keys());
	const errors = [];
	for (const chart of charts) {
		const outcome = validateChart(chart, { knownModules: known });
		if (!outcome.ok) errors.push(...outcome.errors.map((error) => `${chart.id}: ${error}`));
		else models.set(chart.id, outcome.model);
	}
	const collection = validateCollection(models);
	errors.push(...collection.errors);
	if (errors.length > 0) {
		console.error(errors.join('\n'));
		process.exitCode = 1;
		return;
	}
	for (const warning of collection.warnings) console.warn(`warning: ${warning}`);

	for (const chart of charts) await writeOne(specDir, flowsDir, models.get(chart.id), models);
	for (const chart of charts) console.log(`${chart.id}: ${models.get(chart.id).name}`);
	console.log(`\n写到 ${flowsDir}`);
}

main();
