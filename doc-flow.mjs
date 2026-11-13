// Generates this repository's own chart collection into .spec/flows/.
//
// The charts live in code rather than in the landed markdown for one reason: this
// repository is the plugin's own first user, so its charts have to be
// regenerable after every change without re-running an interview.
//
// Run: npm run flow

import { mkdirSync } from 'node:fs';

import { flowsDirPath, validateChart, validateCollection, writeChart } from './flows.js';
import { drawMermaid } from './mermaid-graph.js';
import { resolveSpecDir } from './state.js';

/** Where the run writes, regardless of where npm invoked it from. */
const ROOT = new URL('.', import.meta.url).pathname;

/**
 * One chart, with its diagram written from the steps and arrows listed here.
 * @param {string} id - the file name.
 * @param {string} name - the title.
 * @param {string} scope - where the chart starts and stops.
 * @param {object[]} nodes - the boxes.
 * @param {object[]} edges - the arrows.
 * @returns {object} the chart.
 */
function chart(id, name, scope, nodes, edges) {
	return { id, name, scope, source: drawMermaid({ direction: 'LR', nodes, edges }), brief: '' };
}

/** The overview: the whole product, with every step below summarised as a module. */
export const overview = chart(
	'overview',
	'一次 spec 访谈',
	'从用户说出这次要做什么，到 .spec/flows/ 里出现新的图集',
	[
		{ id: 'n1', label: '用户输入 /spec，说清这次要做什么' },
		{ id: 'n2', label: '模型逐轮访谈，每轮把结论写进草稿' },
		{ id: 'n3', label: '用户确认访谈结束，模型提交图集' },
		{ id: 'n4', module: 'check', ports: ['入：本次提交的图与各自的简报', '出：校验通过或点名报错'] },
		{ id: 'n5', module: 'land', ports: ['入：校验通过的图集', '出：.spec/flows/ 下每张图一份 md'] },
		{ id: 'n6', module: 'view', ports: ['入：.spec/flows/ 里有图集', '出：改好的图与简报回到盘上'] },
		{ id: 'n7', label: '模型更新 AGENTS.md 的文档索引' },
	],
	[
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
		{ from: 'n5', to: 'n6' },
		{ from: 'n6', to: 'n7' },
	],
);

/** Landing: the reviewed write of one landing call. */
export const land = chart(
	'land',
	'落盘',
	'从用户点「退出并落盘」到草稿消失',
	[
		{ id: 'n1', label: '用户点「退出并落盘」' },
		{ id: 'n2', label: '只写本次提交的图，未提交的保持原样' },
		{ id: 'n3', label: '删掉删除列表里的图' },
		{ id: 'n4', label: '每张图写成一份 md，草稿删掉' },
		{ id: 'n5', label: '模式退出，工作树恢复可写' },
	],
	[
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
	],
);

/** Validation: the gate before anything is written. */
export const check = chart(
	'check',
	'校验',
	'从收到提交的图集到给出通过或逐条报错',
	[
		{ id: 'n1', label: '逐张查 id、标题、范围与 mermaid 块' },
		{ id: 'n2', label: '逐张查起点、回箭头、分叉条件' },
		{ id: 'n3', label: '查整册：有总览、引用都指得到、不成环' },
		{ id: 'n4', label: '给用户看确认框' },
		{ id: 'n5', label: '点名报错，模型改完重交' },
	],
	[
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4', when: '全部通过' },
		{ from: 'n3', to: 'n5', when: '有一条不过' },
		{ from: 'n5', to: 'n1' },
	],
);

/** The view: what a person does in the conversation's chart page. */
export const view = chart(
	'view',
	'看图改图',
	'从打开「流程图」页到把改好的图存回盘上',
	[
		{ id: 'n1', label: '用户打开会话视图的「流程图」页' },
		{ id: 'n2', label: '左栏按引用关系列出图集，选中一张' },
		{ id: 'n3', label: '主区渲染这张图的 mermaid，右边是它的简报' },
		{ id: 'n4', label: '用户改源码里的文字或连线上的条件' },
		{ id: 'n5', label: '模型或用户按 Ctrl/Cmd+S' },
		{ id: 'n6', label: '写盘，重新渲染这张图' },
		{ id: 'n7', label: '提示冲突，等用户重新载入' },
	],
	[
		{ from: 'n1', to: 'n2' },
		{ from: 'n2', to: 'n3' },
		{ from: 'n3', to: 'n4' },
		{ from: 'n4', to: 'n5' },
		{ from: 'n5', to: 'n6', when: '盘上没有别人改过' },
		{ from: 'n5', to: 'n7', when: '盘上的图已经变了' },
		{ from: 'n7', to: 'n3' },
	],
);

/** Everything the run writes, in the order it writes them. */
export const charts = [overview, check, land, view];

/** Validate everything, then write it. Validation first: a broken chart would land a broken file. */
async function main() {
	const specDir = resolveSpecDir(process.cwd());
	mkdirSync(flowsDirPath(specDir), { recursive: true });

	const entries = new Map();
	const known = new Set(charts.map((entry) => entry.id));
	const errors = [];
	for (const entry of charts) {
		const outcome = validateChart(entry, { knownModules: known });
		if (!outcome.ok) {
			errors.push(...outcome.errors.map((error) => `${entry.id}: ${error}`));
			continue;
		}
		entries.set(entry.id, { chart: outcome.chart, graph: outcome.graph, revision: '' });
	}
	const collection = validateCollection(entries);
	errors.push(...collection.errors);
	if (errors.length > 0) {
		console.error(errors.join('\n'));
		process.exitCode = 1;
		return;
	}
	for (const warning of collection.warnings) console.warn(`warning: ${warning}`);

	for (const entry of charts) {
		const written = writeChart(specDir, entries.get(entry.id).chart);
		console.log(`${entry.id}: ${written.path}`);
	}
	console.log(`\n写到 ${flowsDirPath(specDir)}`);
}

main();
