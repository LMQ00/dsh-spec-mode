/**
 * Spec mode for the DeepSeek Harness.
 *
 * Spec mode is logged per-session collaboration state: while it is active, the
 * `spec:policy` prompt section carries an interview protocol, a monotonic tool
 * guard keeps the working tree read-only except for one draft file, and
 * `spec_resolve` validates the finished interview, presents it for the user's
 * review, and lands the chart collection in `.spec/flows/`: an overview of the
 * product, the module charts it points at, and one requirement brief per chart.
 *
 * Enter and leave with `/spec [idea]` and `/spec off`. A bare `/spec` only
 * selects the mode and submits no message of its own, so the interview begins
 * with whatever the user writes — inline after `/spec`, or as the next ordinary
 * message. The state is a fold over the session log (`command/run` +
 * `command/done`, `tool/call` + `tool/result`), so resume, fork, and replay
 * restore it without a plugin-owned event type.
 *
 * Two tools edit the collection outside the interview: `flow_read` reads it and
 * `flow_write` rewrites one chart. They run the same validators the landing does,
 * so a chart that the tool accepted is a chart the landing would accept.
 *
 * @module dsh-spec-mode
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';

import { agentsMdAdvisories, specDeliverableWrite } from './advisories.js';
import { validateBrief } from './brief.js';
import {
	chartPath,
	ensureFlowsDir,
	kindOf,
	parentsOf,
	readCollection,
	removeChartFiles,
	validateChart,
	validateCollection,
	writeChart,
} from './flows.js';
import { registerFlowRoutes } from './flows-api.js';
import { classifyTarget, extractTargetPaths, isDestructiveTool, isWriteTool } from './guard.js';
import { pendingDraftNotice, specModeContext } from './prompt.js';
import {
	PROJECTION_KEY,
	createSpecProjection,
	draftHasContent,
	ensureSpecDir,
	resolveDraftPath,
	resolveSpecDir,
} from './state.js';

export const name = 'spec-mode';

/**
 * `sessionProjections` is required: it is the only durable, fork-correct home
 * for the mode. `commands` and `userQuestions` are optional and read
 * opportunistically, so the plugin still activates in a composition without
 * them (it just has no way in or out).
 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];

/** The human command that enters and leaves the mode. */
const COMMAND_NAME = 'spec';

/** The model-facing tool that validates, reviews, and lands the finished interview. */
const EXIT_TOOL_NAME = 'spec_resolve';

/** The model-facing tools that edit the collection outside an interview. */
const READ_TOOL_NAME = 'flow_read';
const WRITE_TOOL_NAME = 'flow_write';

/** The review question's id, echoed in the answer this tool reads. */
const REVIEW_ID = 'spec-review';

/** The review question's approve option label. */
const APPROVE_LABEL = '退出并落盘';

/** The review question's keep-interviewing option label. */
const KEEP_LABEL = '继续访谈';

/** Unique name of the prompt section spec mode contributes while active. */
const PROMPT_SECTION_NAME = 'spec:policy';

/** Bound on a `notice`-form context summary, mirroring the harness's own. */
const CONTEXT_SUMMARY_MAX_CHARS = 120;

const EXIT_DESCRIPTION =
	'访谈完成、且用户确认过整体回述后调用：先校验整册图集，再弹确认框，用户批准后落盘并退出 spec mode。'
	+ '`charts` 是本次改动的图，每张自带 id、name、scope、source（mermaid 源码）与可选 brief——只写这些，'
	+ '未提交的图原样留在盘上；`removed` 列出本次删掉的图 id，被引用的图不能删。'
	+ '每张图落在 `.spec/flows/<id>.md` 这一份文件里：标题、范围、mermaid 块、简报。'
	+ '用户选「退出并落盘」→ 写这些文件、删掉草稿、退出模式、工作树恢复可写；'
	+ '选「继续访谈」→ 模式不变、工作树仍只读，等用户补充需求后继续更新草稿。';

/* ------------------------------------------------------------------ */
/* Tool parameter schema                                               */
/* ------------------------------------------------------------------ */

/** A required string property with a description. */
function text(description) {
	return { type: 'string', description };
}

/** A required array-of-strings property. */
function texts(description) {
	return { type: 'array', items: { type: 'string' }, description };
}

/** How a chart's mermaid source is written, in the words the model reads. */
const SOURCE_DESCRIPTION =
	'这张图的 mermaid 源码，整块就是文件里的图。'
	+ '第一行 `flowchart LR`；节点一行一个，写 `n1["谁做了什么"]`；'
	+ '模块框写 `n4[["check<br/>入：什么条件进来<br/>出：出去之后是什么状态"]]`，引号里第一行是被引用图的 id，后面每行一条端口；'
	+ '箭头一行一条，写 `n1 --> n2`，分叉写成 `n1 -->|条件| n2`。'
	+ '只允许一个起点；要重复的一步，用回箭头指回重来的那个框。';

/**
 * The JSON Schema for one chart, shared by every tool that takes a chart so a
 * chart means the same thing wherever it is submitted.
 * @returns {Record<string, unknown>} the parameters.
 */
function chartShape() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			id: text('这张图的编号，也是文件名：小写字母开头，只用小写字母、数字与短横，最长 24 位。一经落盘不再改名。id 为 overview 的那张就是产品全貌，整册恰好一张。'),
			name: text('显示名，写进文件第一行，也画在引用它的模块框上。作用变了就改它。'),
			scope: text('一行写死这张图从哪一步到哪一步。写「本次」「相关」这类无边界说法会被拒。'),
			source: text(SOURCE_DESCRIPTION),
			brief: text('可选。这张图的需求简报，Markdown，四节：### 目标、### 要做什么、### 验收、### 约束。人不写就留空，模型在访谈里补。'),
		},
		required: ['id', 'name', 'scope', 'source'],
	};
}

/**
 * The JSON Schema for `spec_resolve`.
 *
 * Standard JSON Schema, NOT the `defineTool` DSL: `ctx.tools.register` takes the
 * raw schema straight to the provider, so requiredness is the per-object
 * `required: [...]` string array. Putting `required: true` on a property is
 * rejected by the provider.
 *
 * The content rules JSON Schema cannot express (no code, no reasoning, no local
 * paths) live in `flows.js` and `mermaid-graph.js`.
 *
 * @returns {Record<string, unknown>} the parameter schema.
 */
function exitParameters() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			charts: {
				type: 'array',
				description: '本次改动的图，一张一项。未出现在这里的图保持盘上原样。',
				items: chartShape(),
			},
			removed: {
				type: 'array',
				items: { type: 'string' },
				description: '本次删掉的图 id。被别的图引用的、以及唯一的 overview，都会被拒。',
			},
		},
		required: ['charts'],
	};
}

/* ------------------------------------------------------------------ */
/* Message helpers                                                     */
/* ------------------------------------------------------------------ */

/** Deep-freeze a freshly built message the way the harness's factories do. */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}

/**
 * Build one identified, frozen user-role message. Inlined rather than imported
 * so this bundle declares no dependency on a shipped Harness package and keeps
 * resolving from the profile alone.
 */
function userMessage(content, source) {
	return deepFreeze({ id: randomUUID(), role: 'user', content, source });
}

/**
 * A `notice`-form context message: one line of account, shown without expanding
 * the row.
 */
function noticeMessage(text_, summary) {
	return userMessage([{ type: 'text', text: text_ }], {
		kind: 'spec-mode',
		form: 'notice',
		summary: String(summary ?? text_).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_SUMMARY_MAX_CHARS),
	});
}

/* ------------------------------------------------------------------ */
/* Landing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn validator problems into one repair instruction.
 * @param {string} toolName - the tool the model called.
 * @param {string[]} errors - the validator's problems.
 * @returns {Error} the error to throw.
 */
function repairError(toolName, errors) {
	return new Error(
		`${toolName} 的参数不合格——先改这些再调一次：\n`
		+ errors.map((error) => `- ${error}`).join('\n'),
	);
}

/**
 * Write one file, surfacing the target path when it fails. A landing that half
 * succeeded must say which half.
 * @param {string} filePath - the absolute target path.
 * @param {string} content - the file content.
 */
function writeProduct(filePath, content) {
	try {
		writeFileSync(filePath, content, 'utf8');
	} catch (error) {
		throw new Error(`落盘失败（${filePath}）：${error?.message ?? error}。产物未写完，草稿保留，修正后重新调用。`);
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

/**
 * Plugin entry.
 * @param {object} ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
	/**
	 * Sessions whose exit this process already approved. The durable record is
	 * the `tool/result` fold, but the write that follows the tool call in the
	 * SAME step must not be blocked by a projection that has not folded yet, so
	 * an approved exit is also remembered here and cleared on re-entry.
	 */
	const liveExits = new WeakSet();

	/** Read this session's spec projection state, or `undefined` when unregistered. */
	function stateOf(session) {
		try {
			return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
		} catch {
			return undefined;
		}
	}

	/**
	 * Whether spec mode is in effect for one session. `command/run` is appended
	 * BEFORE the handler executes, so a command that is still running has already
	 * recorded its selection and the pending value wins — that is what makes the
	 * guard and the prompt section correct for the step the command starts.
	 */
	function isSpecActive(session) {
		if (liveExits.has(session)) return false;
		const state = stateOf(session);
		if (state === undefined) return false;
		return state.running === null ? state.active === true : state.running.wanted === true;
	}

	/**
	 * Whether spec mode was already committed to the log, ignoring a selection
	 * this command is still carrying. A command handler asks this question, not
	 * {@link isSpecActive}: by the time it runs, its own `command/run` has
	 * already moved the effective state.
	 */
	function loggedActive(session) {
		const state = stateOf(session);
		return state === undefined ? false : state.active === true;
	}

	/** The session's working directory, falling back to the host process cwd. */
	function sessionCwd(session) {
		try {
			const cwd = session.header?.cwd;
			if (typeof cwd === 'string' && cwd !== '') return cwd;
		} catch {
			// A session without readable metadata uses the process directory.
		}
		return process.cwd();
	}

	/** Absolute draft path for one session. */
	function draftPathFor(session) {
		return resolveDraftPath(sessionCwd(session));
	}

	/**
	 * Whether a spec-mode landing is plausible for one session: the mode is on,
	 * this process just approved the exit, or an interview draft is still on disk
	 * (a landing that follows a manual `/spec off`). The product advisories are
	 * landing-protocol judgements, so they stay quiet outside such work — merely
	 * having the plugin installed must not lecture unrelated writes.
	 */
	function landingInProgress(session) {
		if (isSpecActive(session) || liveExits.has(session)) return true;
		return draftHasContent(draftPathFor(session));
	}

	/* ---------------- durable state ---------------- */

	ctx.sessionProjections.register(createSpecProjection(COMMAND_NAME, EXIT_TOOL_NAME));

	/* ---------------- prompt ---------------- */

	ctx.systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
		text: (context) => {
			try {
				const agent = context.agent;
				if (agent === undefined) return '';
				if (!isSpecActive(agent.session)) return '';
				return specModeContext(draftPathFor(agent.session));
			} catch {
				// A provider that throws would break assembly; contribute nothing instead.
				return '';
			}
		},
	});

	/* ---------------- /spec ---------------- */

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			definitionId: 'dsh-spec-mode',
			name: COMMAND_NAME,
			description: 'Spec mode: 访谈式需求固化 — 增量写草稿，工作树只读，退出后落盘 .spec/flows/ 图集（每张图一份 Markdown：mermaid 图与需求简报），并更新 AGENTS.md',
			input: { hint: '[off|初始想法]', attachments: true },
			handler: ({ agent, rawInput, attachments }) => {
				const session = agent.session;
				const message = rawInput.trim();
				const draftPath = draftPathFor(session);

				if (message === 'off') {
					if (!loggedActive(session)) return { kind: 'success', text: 'Spec mode 未开启。' };
					agent.inject(
						noticeMessage(
							'用户退出了 spec mode，工作树恢复可写。现在按图集的形状自己写 .spec/flows/：每张图一份 `<id>.md`——标题、范围、mermaid 块、简报，id 为 overview 的那张是产品全貌，重试画成回箭头；然后用 flow_write 或直接写文件，删掉草稿，再更新 AGENTS.md。',
							'Spec mode off',
						),
					);
					return { kind: 'success', text: `Spec mode off. 草稿保留在 ${draftPath}` };
				}

				// One collaboration mode at a time: plan mode owns the session while it is on.
				if (!loggedActive(session)) {
					const planMode = ctx.get('planMode');
					if (planMode !== undefined) {
						let planActive = false;
						try {
							planActive = planMode.get(agent)?.active === true;
						} catch {
							planActive = false;
						}
						if (planActive) return { kind: 'error', text: 'Exit plan mode first.' };
					}
				}

				liveExits.delete(session);
				ensureSpecDir(resolveSpecDir(sessionCwd(session)));

				// A bare `/spec` is a silent mode toggle: it submits nothing, so the
				// interview starts only once the user supplies something to interview
				// about — inline here, or as the next ordinary message (the
				// `spec:policy` section is already in effect for that turn).
				if (message !== '' || attachments.length > 0) {
					agent.steer(
						userMessage(
							[
								...attachments,
								...(message === '' ? [] : [{ type: 'text', text: message }]),
							],
							{ kind: 'user' },
						),
					);
					return { kind: 'success', text: `Spec mode on. 草稿：${draftPath}` };
				}
				return {
					kind: 'success',
					text: `Spec mode on. 工作树只读；直接发消息即可开始访谈。草稿：${draftPath}`,
				};
			},
		});
	});

	/* ---------------- reviewed landing ---------------- */

	ctx.tools.register({
		name: EXIT_TOOL_NAME,
		description: EXIT_DESCRIPTION,
		parameters: exitParameters(),
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					exited: { type: 'boolean', const: true },
					charts: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: { type: 'string' },
								path: { type: 'string' },
								brief: { type: 'string' },
							},
							required: ['id', 'path', 'brief'],
						},
					},
					removed: { type: 'array', items: { type: 'string' } },
					warnings: { type: 'array', items: { type: 'string' } },
				},
				required: ['exited', 'charts', 'removed', 'warnings'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text:
						`已退出 spec mode，工作树可写。图集已落盘：\n`
						+ value.charts.map((chart) => `- ${chart.id}：${chart.path}（简报：${chart.brief}）`).join('\n')
						+ (value.removed.length > 0 ? `\n- 删掉：${value.removed.join('、')}` : '')
						+ (value.warnings.length > 0 ? `\n\n提醒：\n${value.warnings.map((line) => `- ${line}`).join('\n')}` : '')
						+ '\n\n现在只剩一步：写 AGENTS.md —— 只放文档索引（指向 `.spec/flows/` 与本仓库的文档）'
						+ '与可证伪的开发规范规则（每条标注代码强制还是提示词），不写开头介绍句，'
						+ '不写现状、进度、待办、里程碑这类内容。',
				},
			],
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === undefined) {
				throw new Error(`${EXIT_TOOL_NAME} 需要一个调用它的 agent（没有会话可以落盘）`);
			}
			const session = agent.session;
			if (!isSpecActive(session)) {
				throw new Error(`${EXIT_TOOL_NAME} 只能在 spec mode 中调用`);
			}

			const cwd = sessionCwd(session);
			const specDir = resolveSpecDir(cwd);
			const removed = Array.isArray(args?.removed) ? args.removed.map((id) => String(id).trim()).filter((id) => id !== '') : [];
			const submitted = Array.isArray(args?.charts) ? args.charts : [];

			// Validate before asking: the review must present what will actually be
			// written, not a first draft the model intends to fix afterwards. The
			// collection is what the new charts are merged into, so a chart may point
			// at a module this landing does not touch.
			const { charts: existing, problems } = readCollection(specDir);
			const entries = new Map(existing);
			const known = new Set([...entries.keys(), ...submitted.map((chart) => (typeof chart?.id === 'string' ? chart.id.trim() : ''))]);

			const errors = [...problems];
			const written = [];
			const briefs = new Map();
			for (const [index, raw] of submitted.entries()) {
				const outcome = validateChart(raw, { knownModules: known });
				if (!outcome.ok) {
					errors.push(...outcome.errors.map((error) => `charts[${index}] ${error}`));
					continue;
				}
				if (entries.has(outcome.chart.id) && submitted.filter((chart) => chart?.id === outcome.chart.id).length > 1) {
					errors.push(`charts[${index}].id: 同一次提交里出现了两张「${outcome.chart.id}」`);
				}
				entries.set(outcome.chart.id, { chart: outcome.chart, graph: outcome.graph, revision: '' });
				written.push(outcome.chart.id);
				if (typeof raw.brief === 'string' && raw.brief.trim() !== '') briefs.set(outcome.chart.id, raw.brief);
			}
			for (const id of removed) if (entries.has(id)) entries.delete(id);

			const collection = validateCollection(entries, { removed });
			errors.push(...collection.errors);
			if (errors.length > 0) throw repairError(EXIT_TOOL_NAME, errors);

			const briefErrors = [];
			for (const [id, brief] of briefs) {
				const outcome = validateBrief(sectionsOf(brief, entries.get(id)?.chart.name));
				if (!outcome.ok) briefErrors.push(...outcome.errors.map((error) => `${id} 的简报 ${error}`));
			}
			if (briefErrors.length > 0) throw repairError(EXIT_TOOL_NAME, briefErrors);

			const interaction = ctx.get('userQuestions');
			if (interaction === undefined) {
				throw new Error(
					'当前组合没有 userQuestions 通道，弹不出确认框。访谈结论留在草稿里，请用户运行 /spec off 退出。',
				);
			}

			// The review shows every box that will be on every picture, because that
			// is the one thing a person cannot check from the chart's JSON.
			const summary = written.map((id) => {
				const entry = entries.get(id);
				const lines = entry.graph.nodes.map((node) => (typeof node.module === 'string'
					? `- （模块）${node.module}：${entries.get(node.module)?.chart?.name ?? '缺图'}`
					: `- ${node.label}`));
				return `== ${entry.chart.name}（${id}）==\n${entry.chart.scope}\n${lines.join('\n')}`;
			}).join('\n\n');

			const answer = await interaction
				.ask({
					questions: [
						{
							id: REVIEW_ID,
							header: 'Spec mode',
							question: '退出 spec mode 并落盘？',
							detail:
								'图上这些框会连同各自的简报写进 .spec/flows/，写完工作树恢复可写，草稿删除。\n\n'
								+ `${summary}\n`
								+ (removed.length > 0 ? `\n== 删除 ==\n${removed.join('、')}\n` : '')
								+ (collection.warnings.length > 0 ? `\n== 提醒 ==\n${collection.warnings.map((line) => `- ${line}`).join('\n')}\n` : ''),
							options: [
								{ label: APPROVE_LABEL, description: '退出模式，把上面这些写进 .spec/flows/。' },
								{ label: KEEP_LABEL, description: '保持只读，继续补充需求。' },
							],
						},
					],
					agent,
					signal: exec.signal,
				})
				.catch((cause) => {
					if (cause !== null && typeof cause === 'object' && cause.code === 'ASK_CANCELLED') {
						throw new Error('用户关闭了确认框想直接说话：spec mode 保持开启，停下并等他的消息。');
					}
					throw cause;
				});

			const item = Array.isArray(answer?.answers)
				? answer.answers.find((entry) => entry?.id === REVIEW_ID)
				: undefined;
			const approved =
				item !== undefined
				&& Array.isArray(item.selected)
				&& item.selected.length === 1
				&& item.selected[0] === APPROVE_LABEL
				&& item.custom === undefined;
			if (!approved) {
				const feedback = typeof item?.custom === 'string' && item.custom !== '' ? `用户补充：${item.custom}` : '';
				throw new Error(
					'用户选择继续访谈：spec mode 保持开启，工作树仍只读。'
					+ `不要重复调用本工具，等用户补充需求后继续更新草稿。${feedback}`,
				);
			}

			ensureSpecDir(specDir);
			ensureFlowsDir(specDir);
			const landed = new Map();
			for (const id of written) {
				const brief = briefs.has(id) ? briefs.get(id) : entries.get(id).chart.brief;
				landed.set(id, writeChart(specDir, { ...entries.get(id).chart, brief }));
			}
			for (const id of removed) removeChartFiles(specDir, id);

			try {
				unlinkSync(resolveDraftPath(cwd));
			} catch {
				// A draft already gone is not a landing failure.
			}
			liveExits.add(session);
			return {
				exited: true,
				charts: written.map((id) => ({
					id,
					path: landed.get(id)?.path ?? chartPath(specDir, id),
					brief: (briefs.get(id) ?? entries.get(id).chart.brief).trim() === '' ? '（还没写）' : '已写',
				})),
				removed,
				warnings: collection.warnings,
			};
		},
	});

	/* ---------------- collection tools ---------------- */

	ctx.tools.register({
		name: READ_TOOL_NAME,
		description:
			'读 .spec/flows/ 这一册流程图：有哪些图、谁引用谁、每张图的 mermaid 源码与简报。不带 id 时返回清单；带 id 时返回那份文件的全文。'
			+ '不在 spec mode 时也能用；它只读，不改盘上任何东西。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				id: text('可选。给定时返回这张图的完整模型与简报。'),
			},
			required: [],
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					charts: { type: 'array', items: { type: 'object' } },
					problems: { type: 'array', items: { type: 'string' } },
					chart: { type: 'object' },
					revision: { type: 'string' },
					brief: { type: 'string' },
				},
				required: ['charts', 'problems'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text: value.chart === undefined
						? `图集共 ${value.charts.length} 张：\n`
							+ value.charts.map((chart) => `- ${chart.id}（${chart.kind}，${chart.revision}）：${chart.name}｜${chart.scope}${chart.parents.length > 0 ? `｜被 ${chart.parents.join('、')} 引用` : ''}`).join('\n')
							+ (value.problems.length > 0 ? `\n读不出来的文件：\n${value.problems.map((line) => `- ${line}`).join('\n')}` : '')
						: `== ${value.chart.id}（${value.chart.kind}，${value.revision}）==\n${value.chart.name}\n${value.chart.scope}\n\n`
							+ `\`\`\`mermaid\n${value.chart.source.trimEnd()}\n\`\`\``
							+ (value.brief === '' ? '\n\n（这张图还没有简报）' : `\n\n== 简报 ==\n${value.brief}`),
				},
			],
		},
		async execute(args, exec) {
			const cwd = sessionCwd(exec.agent?.session ?? {});
			const specDir = resolveSpecDir(cwd);
			const { charts, problems } = readCollection(specDir);
			const listing = [...charts.values()].map((entry) => ({
				id: entry.chart.id,
				kind: kindOf(entry.chart.id),
				name: entry.chart.name,
				scope: entry.chart.scope,
				revision: entry.revision,
				parents: parentsOf(charts, entry.chart.id),
			}));
			const id = typeof args?.id === 'string' ? args.id.trim() : '';
			if (id === '') return { charts: listing, problems };
			const entry = charts.get(id);
			if (entry === undefined) {
				throw new Error(`图集里没有「${id}」。现有：${[...charts.keys()].join('、') || '（空）'}`);
			}
			return {
				charts: listing,
				problems,
				chart: { id, kind: kindOf(id), name: entry.chart.name, scope: entry.chart.scope, source: entry.chart.source },
				revision: entry.revision,
				brief: entry.chart.brief,
			};
		},
	});

	ctx.tools.register({
		name: WRITE_TOOL_NAME,
		description:
			'改 .spec/flows/ 里的一张图：提交它的完整内容与可选简报，校验通过才写盘。'
			+ '不在 spec mode 时也能用；spec mode 开着时不行——那时图集只能走 spec_resolve 的确认框。'
			+ '传 revision 可以要求盘上仍是那一版，不一致就报冲突而不是覆盖。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				chart: chartShape(),
				revision: text('可选。读这张图时拿到的 revision；与盘上不一致就报冲突。'),
			},
			required: ['chart'],
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string' },
					revision: { type: 'string' },
					path: { type: 'string' },
					warnings: { type: 'array', items: { type: 'string' } },
				},
				required: ['id', 'revision', 'path', 'warnings'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text: `已写 ${value.id}（revision ${value.revision}）：${value.path}`
						+ (value.warnings.length > 0 ? `\n\n提醒：\n${value.warnings.map((line) => `- ${line}`).join('\n')}` : ''),
				},
			],
		},
		async execute(args, exec) {
			const session = exec.agent?.session;
			if (session !== undefined && isSpecActive(session)) {
				throw new Error(
					`${WRITE_TOOL_NAME} 在 spec mode 里不能用：图集要经 spec_resolve 的确认框写，否则用户在访谈中改过的图会被悄悄覆盖。`,
				);
			}
			const cwd = sessionCwd(session ?? {});
			const specDir = resolveSpecDir(cwd);
			const { charts: existing, problems } = readCollection(specDir);

			const outgoing = args?.chart;
			const candidateId = typeof outgoing?.id === 'string' ? outgoing.id.trim() : '';
			const known = new Set([...existing.keys(), candidateId]);
			const outcome = validateChart(outgoing, { knownModules: known });
			if (!outcome.ok) throw repairError(WRITE_TOOL_NAME, [...problems, ...outcome.errors]);

			// A brand-new chart may be added at any time; an existing one is only
			// overwritten when the caller saw the revision currently on disk.
			const current = existing.get(outcome.chart.id);
			const expected = typeof args?.revision === 'string' ? args.revision.trim() : '';
			if (current !== undefined && expected !== '' && expected !== current.revision) {
				throw new Error(
					`${outcome.chart.id} 在盘上已经变了（盘上 ${current.revision}，你手上 ${expected}）：`
					+ '先 flow_read 重新读一遍再改，别用旧版本覆盖。',
				);
			}
			existing.set(outcome.chart.id, { chart: outcome.chart, graph: outcome.graph, revision: current?.revision ?? '' });

			const collection = validateCollection(existing);
			if (collection.errors.length > 0) throw repairError(WRITE_TOOL_NAME, collection.errors);

			const brief = typeof outgoing?.brief === 'string' ? outgoing.brief : undefined;
			if (brief !== undefined && brief.trim() !== '') {
				const briefOutcome = validateBrief(sectionsOf(brief, outcome.chart.name));
				if (!briefOutcome.ok) throw repairError(WRITE_TOOL_NAME, briefOutcome.errors.map((error) => `chart.brief ${error}`));
			}

			ensureFlowsDir(specDir);
			const written = writeChart(specDir, outcome.chart);
			return { id: outcome.chart.id, revision: written.revision, path: written.path, warnings: collection.warnings };
		},
	});

	/* ---------------- collection over HTTP ---------------- */

	ctx.inject(['webServer', 'connection'], (webCtx) => {
		registerFlowRoutes(webCtx, {
			specDirOf: (session) => resolveSpecDir(sessionCwd(session)),
		});
	});

	/* ---------------- working-tree guard ---------------- */

	ctx.tools.guard((exec) => {
		const agent = exec.agent;
		if (agent === undefined) return undefined;
		const session = agent.session;
		if (!isSpecActive(session)) return undefined;

		const cwd = sessionCwd(session);
		const draftPath = resolveDraftPath(cwd);
		const targets = extractTargetPaths(exec.arguments);

		if (isDestructiveTool(exec.name)) {
			const touchesDraft = targets.some((target) => classifyTarget(target, cwd, draftPath) === 'draft');
			if (touchesDraft) return 'Spec mode: 草稿在提交成两份产物前不可删除或改名。';
			return undefined;
		}

		if (!isWriteTool(exec.name)) return undefined;

		for (const target of targets) {
			if (classifyTarget(target, cwd, draftPath) === 'working-tree') {
				return `Spec mode: 工作树只读。访谈结论写入 ${draftPath}；要改代码先运行 /spec off。`;
			}
		}
		return undefined;
	});

	/* ---------------- deliverable advisories ---------------- */

	ctx.on('tools/post-execute', async (exec, result, next) => {
		const decision = await next();
		try {
			const write = specDeliverableWrite(exec.name, exec.arguments, result.isError === true);
			if (write === undefined || decision.kind !== 'accept') return decision;
			// Only `AGENTS.md` carries a write-time advisory now: the brief belongs to
			// one chart and is validated when it is written through a tool, and a
			// person editing it by hand is not held to the four-section shape.
			if (write.kind !== 'agents') return decision;
			const messages = agentsMdAdvisories(write.content);
			if (messages.length === 0) return decision;
			const contexts = messages.map((text) => noticeMessage(text, 'Spec mode: AGENTS.md 检查'));
			return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), ...contexts] };
		} catch {
			return decision;
		}
	});

	/* ---------------- cross-session draft notice ---------------- */

	ctx.on('agent/created', ({ agent }) => {
		try {
			const header = agent.session.header;
			// Subagent children are not interviewers; only a root session gets the nudge.
			if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return;
			if (isSpecActive(agent.session)) return;
			const draftPath = draftPathFor(agent.session);
			if (!draftHasContent(draftPath)) return;
			agent.inject(noticeMessage(pendingDraftNotice(draftPath), 'spec 草稿：可能已落盘'));
		} catch {
			// A session whose state cannot be read simply gets no notice.
		}
	});
}

/**
 * The shape `validateBrief` expects, recovered from one chart's Markdown brief.
 *
 * A chart's brief is a file beside it, so a model submitting one through a tool
 * sends what it would have written there. Only the shape is read here; the
 * hand-written path never calls this, which is the difference between "the model
 * is held to the four sections" and "a person is not".
 *
 * @param {string} content - the Markdown brief.
 * @returns {object} the four-section object.
 */
/**
 * The four sections of a brief, with the chart's own title filling in for one the
 * brief does not repeat: the brief lives inside the chart's file, which already
 * starts with that title.
 * @param {string} content - the brief body.
 * @param {string} [title] - the chart's title.
 * @returns {object} the sections `validateBrief` takes.
 */
function sectionsOf(content, title) {
	const sections = parseBriefSections(content);
	return sections.title === '' && typeof title === 'string' ? { ...sections, title } : sections;
}

function parseBriefSections(content) {
	const lines = String(content).replace(/\r\n/g, '\n').split('\n');
	const title = lines.map((line) => /^#\s+(.+?)\s*$/.exec(line)).find((match) => match !== null);
	const sections = new Map();
	let current = null;
	for (const raw of lines) {
		const heading = /^#{2,3}\s+(.+?)\s*$/.exec(raw);
		if (heading !== null) {
			current = heading[1].replace(/[：:]\s*$/, '');
			sections.set(current, []);
			continue;
		}
		if (current !== null) sections.get(current).push(raw);
	}
	const bullets = (name) => (sections.get(name) ?? [])
		.map((line) => /^\s*[-*+]\s+(.*)$/.exec(line))
		.filter((match) => match !== null)
		.map((match) => match[1].trim());
	const paragraph = (name) => (sections.get(name) ?? []).map((line) => line.trim()).filter((line) => line !== '').join(' ');
	const constraints = bullets('约束');
	return {
		title: title == null ? '' : title[1],
		goal: paragraph('目标'),
		requirements: bullets('要做什么'),
		acceptance: bullets('验收'),
		constraints,
	};
}
