/**
 * Spec mode for the DeepSeek Harness.
 *
 * Spec mode is logged per-session collaboration state: while it is active, the
 * `spec:policy` prompt section carries an interview protocol, a monotonic tool
 * guard keeps the working tree read-only except for one draft file, and
 * `spec_resolve` validates the finished interview, presents it for the user's
 * review, and lands two products in `.spec/`: a requirement brief a later model
 * reads as its plan, and a functional flow chart a person reads.
 *
 * Enter and leave with `/spec [idea]` and `/spec off`. A bare `/spec` only
 * selects the mode and submits no message of its own, so the interview begins
 * with whatever the user writes — inline after `/spec`, or as the next ordinary
 * message. The state is a fold over the session log (`command/run` +
 * `command/done`, `tool/call` + `tool/result`), so resume, fork, and replay
 * restore it without a plugin-owned event type.
 *
 * @module dsh-spec-mode
 */

import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';

import { agentsMdAdvisories, deliverableAdvisories, specDeliverableWrite } from './advisories.js';
import { renderBrief, validateBrief } from './brief.js';
import { validateFlow } from './flow.js';
import { renderFlowSvg } from './flow-svg.js';
import { classifyTarget, extractTargetPaths, isDestructiveTool, isWriteTool } from './guard.js';
import { pendingDraftNotice, specModeContext } from './prompt.js';
import { rasterize, svgSize } from './rasterize.js';
import {
	PROJECTION_KEY,
	createSpecProjection,
	draftHasContent,
	ensureSpecDir,
	resolveBriefPath,
	resolveDraftPath,
	resolveFlowImagePath,
	resolveFlowVectorPath,
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
	'访谈完成、且用户确认过整体回述后调用：先校验两份产物，再弹确认框，用户批准后落盘并退出 spec mode。'
	+ '两份产物——`brief` 是给 AI 读的需求简报（只有目标、要做什么、验收、约束；不写代码、不写为什么），'
	+ '`flow` 是给人看的流程图（节点是谁做什么，连线是之后发生什么；插件会画成 `.spec/flow.png`）。'
	+ '用户选「退出并落盘」→ 写 `.spec/brief.md`、画出 `.spec/flow.png`、删掉草稿、退出模式、工作树恢复可写；'
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

/**
 * The JSON Schema for `spec_resolve`.
 *
 * Standard JSON Schema, NOT the `defineTool` DSL: `ctx.tools.register` takes the
 * raw schema straight to the provider, so requiredness is the per-object
 * `required: [...]` string array. Putting `required: true` on a property is
 * rejected by the provider.
 *
 * The content rules JSON Schema cannot express (no code, no reasoning, no local
 * paths) live in `brief.js` and `flow.js`.
 *
 * @returns {Record<string, unknown>} the parameter schema.
 */
function exitParameters() {
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			brief: {
				type: 'object',
				description: '给 AI 读的需求简报：只有需求，没有代码，没有为什么。',
				additionalProperties: false,
				properties: {
					title: text('简报标题，一行。'),
					goal: text('一句话：做完之后什么状态成立。'),
					requirements: texts('要做什么，一条一行。写需求本身，不写理由、背景、备选方案。'),
					acceptance: texts('验收，一条一行，每条可观察：命令加退出码、阈值加测法、样例输入输出。'),
					constraints: texts('约束，一条一行；没有就给空数组。'),
				},
				required: ['title', 'goal', 'requirements', 'acceptance', 'constraints'],
			},
			flow: {
				type: 'object',
				description: '给人看的流程图：节点是谁做什么，连线是之后发生什么。插件按它画成 .spec/flow.png。',
				additionalProperties: false,
				properties: {
					nodes: {
						type: 'array',
						description: '至少两个节点。',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: text('短标识，字母开头，字母数字下划线与短横，全篇唯一。'),
								label: text('谁做了什么，日常说法；画进图里就是这个框的字。不写函数名、变量名、源码文件名，不写代码，不写为什么。'),
							},
							required: ['id', 'label'],
						},
					},
					edges: {
						type: 'array',
						description: '图里的箭头。两端必须已声明为节点。要重复的一步用回箭头指回它重来的框。只允许一个起点。',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								from: text('起点节点 id。'),
								to: text('终点节点 id。'),
								when: text('可选。但一个节点有两条以上出边时，每条出边都必须写：分叉条件只存在于图上。'),
							},
							required: ['from', 'to'],
						},
					},
				},
				required: ['nodes', 'edges'],
			},
		},
		required: ['brief', 'flow'],
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
		throw new Error(`落盘失败（${filePath}）：${error?.message ?? error}。两份产物未写完，草稿保留，修正后重新调用。`);
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
			description: 'Spec mode: 访谈式需求固化 — 增量写草稿，工作树只读，退出后落盘 .spec/brief.md（给 AI 读的需求简报：只有需求，无代码、无理由）并把流程图渲染成 .spec/flow.png（给人看的图），并更新 AGENTS.md',
			input: { hint: '[off|初始想法]', attachments: true },
			handler: ({ agent, rawInput, attachments }) => {
				const session = agent.session;
				const message = rawInput.trim();
				const draftPath = draftPathFor(session);

				if (message === 'off') {
					if (!loggedActive(session)) return { kind: 'success', text: 'Spec mode 未开启。' };
					agent.inject(
						noticeMessage(
							'用户退出了 spec mode，工作树恢复可写。现在按格式自己写 .spec/brief.md（只写需求、无代码无理由）与流程图（节点写谁做什么、重试画成回箭头；自己画成图，或下次 /spec 重画），删掉草稿，然后更新 AGENTS.md。',
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
					briefPath: { type: 'string' },
					flowPath: { type: 'string' },
					flowFormat: { type: 'string' },
				},
				required: ['exited', 'briefPath', 'flowPath', 'flowFormat'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text:
						`已退出 spec mode，工作树可写。两份产物已落盘：\n`
						+ `- 需求简报（给 AI 读）：${value.briefPath}\n`
						+ `- 功能流程图（给人看）：${value.flowPath}（${value.flowFormat}）\n`
						+ '现在只剩一步：写 AGENTS.md —— 只放文档索引（指向 .spec/brief.md、.spec/flow.png 与本仓库的文档）'
						+ '与可证伪的开发规范规则（每条标注代码强制还是提示词），不写开头介绍句，'
						+ '不写现状、进度、待办、里程碑这类内容。不要新增 docs/ 文档。',
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

			// Validate before asking: the review must present what will actually be
			// written, not a first draft the model intends to fix afterwards.
			const briefOutcome = validateBrief(args?.brief);
			if (!briefOutcome.ok) throw repairError(EXIT_TOOL_NAME, briefOutcome.errors);
			const flowOutcome = validateFlow(args?.flow);
			if (!flowOutcome.ok) throw repairError(EXIT_TOOL_NAME, flowOutcome.errors);
			const brief = briefOutcome.brief;
			const flow = flowOutcome.flow;
			const briefText = renderBrief(brief);
			const flowTitle = `${brief.title}：功能流程`;
			const flowSvg = renderFlowSvg(flow, flowTitle);

			const interaction = ctx.get('userQuestions');
			if (interaction === undefined) {
				throw new Error(
					'当前组合没有 userQuestions 通道，弹不出确认框。访谈结论留在草稿里，请用户运行 /spec off 退出。',
				);
			}
			const cwd = sessionCwd(session);
			const briefPath = resolveBriefPath(cwd);
			const flowPath = resolveFlowImagePath(cwd);
			const fallbackPath = resolveFlowVectorPath(cwd);
			const answer = await interaction
				.ask({
					questions: [
						{
							id: REVIEW_ID,
							header: 'Spec mode',
							question: '退出 spec mode 并落盘？',
							detail:
								'两处写好后工作树恢复可写，草稿删除。\n\n'
								+ `== 需求简报 → ${briefPath} ==\n\n${briefText}\n`
								+ `== 功能流程图 → ${flowPath} ==\n\n`
								+ `节点（图里就是这些框，从上往下读）：\n`
								+ flow.nodes.map((node) => `- ${node.label}`).join('\n'),
							options: [
								{ label: APPROVE_LABEL, description: '退出模式，把上面两份写进 .spec/。' },
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

			ensureSpecDir(resolveSpecDir(cwd));
			writeProduct(briefPath, briefText);

			// The chart is a picture. Draw the SVG first, then rasterize it; a
			// machine with no renderer keeps the SVG, which the preview still shows.
			writeProduct(fallbackPath, flowSvg);
			const renderer = await rasterize(fallbackPath, flowPath, svgSize(flowSvg) ?? { width: 640, height: 480 });
			let flowFormat;
			if (renderer === undefined) {
				flowFormat = 'SVG（本机没有可用的转换器，预览照样能显示）';
			} else {
				flowFormat = `PNG，由 ${renderer} 转换`;
				try {
					unlinkSync(fallbackPath);
				} catch {
					// Leaving the SVG behind costs nothing but a stray file.
				}
			}

			try {
				unlinkSync(resolveDraftPath(cwd));
			} catch {
				// A draft already gone is not a landing failure.
			}
			liveExits.add(session);
			return { exited: true, briefPath, flowPath: renderer === undefined ? fallbackPath : flowPath, flowFormat };
		},
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
			const session = exec.agent?.session;
			let landing = false;
			if (session !== undefined) {
				const cwd = sessionCwd(session);
				// The interview draft is a `.spec` file but never a product: it is
				// written every turn and deleted at landing time.
				const isDraft = classifyTarget(write.path, cwd, resolveDraftPath(cwd)) === 'draft';
				landing = !isDraft && landingInProgress(session);
			}
			// The line budget constrains a file the host reads as a session baseline,
			// so it reports regardless of mode; the progress ban and the two product
			// shape checks belong to the landing protocol and report only while a
			// landing is plausible.
			const messages = landing
				? deliverableAdvisories(write.kind, write.content)
				: (write.kind === 'agents' ? agentsMdAdvisories(write.content) : []);
			if (messages.length === 0) return decision;
			const summary = write.kind === 'flow'
				? `Spec mode: 流程图检查 ${write.base}`
				: (write.kind === 'brief' ? `Spec mode: 简报检查 ${write.base}` : 'Spec mode: AGENTS.md 检查');
			const contexts = messages.map((text) => noticeMessage(text, summary));
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
