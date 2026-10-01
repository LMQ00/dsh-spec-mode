/**
 * Spec mode for the DeepSeek Harness.
 *
 * Spec mode is logged per-session collaboration state: while it is active, the
 * `spec:policy` prompt section carries an interview protocol, a monotonic tool
 * guard keeps the working tree read-only except for one draft file, and
 * `spec_resolve` presents the finished interview for the user's review before
 * leaving the mode and landing `AGENTS.md` plus `docs/*.md`.
 *
 * Enter and leave with `/spec [idea]` and `/spec off`. A bare `/spec` only
 * selects the mode and submits no message of its own, so the interview begins
 * with whatever the user writes — inline after `/spec`, or as the next ordinary
 * message. The state is a fold over
 * the session log (`command/run` + `command/done`, `tool/call` + `tool/result`),
 * so resume, fork, and replay restore it without a plugin-owned event type.
 *
 * @module @local/dsh-spec-mode
 */

import { randomUUID } from 'node:crypto';

import { agentsMdAdvisories, agentsMdWriteContent } from './advisories.js';
import { classifyTarget, extractTargetPaths, isDestructiveTool, isWriteTool } from './guard.js';
import { pendingDraftNotice, specModeContext } from './prompt.js';
import {
	PROJECTION_KEY,
	createSpecProjection,
	draftHasContent,
	ensureParentDir,
	resolveDraftPath,
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

/** The model-facing tool that presents the finished interview for review. */
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
	'访谈完成、且用户确认过整体回述后调用：弹出确认框，让用户决定是否退出 spec mode 并落盘。'
	+ '选「退出并落盘」→ 退出模式、工作树恢复可写，随后立刻按草稿写 AGENTS.md 与 docs/*.md 并删除草稿；'
	+ '选「继续访谈」→ 模式不变、工作树仍只读，等用户补充需求后继续更新草稿。';

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
function noticeMessage(text, summary) {
	return userMessage([{ type: 'text', text }], {
		kind: 'spec-mode',
		form: 'notice',
		summary: String(summary ?? text).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_SUMMARY_MAX_CHARS),
	});
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
			definitionId: '@local/dsh-spec-mode',
			name: COMMAND_NAME,
			description: 'Spec mode: 访谈式需求固化 — 增量写草稿，工作树只读，退出后落盘 AGENTS.md 与技术文档',
			input: { hint: '[off|初始想法]', attachments: true },
			handler: ({ agent, rawInput, attachments }) => {
				const session = agent.session;
				const message = rawInput.trim();
				const draftPath = draftPathFor(session);

				if (message === 'off') {
					if (!loggedActive(session)) return { kind: 'success', text: 'Spec mode 未开启。' };
					agent.inject(
						noticeMessage(
							'用户退出了 spec mode，工作树恢复可写。现在按顺序落盘：AGENTS.md → docs/*.md → 删除草稿。',
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
				ensureParentDir(draftPath);

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

	/* ---------------- reviewed exit ---------------- */

	ctx.tools.register({
		name: EXIT_TOOL_NAME,
		description: EXIT_DESCRIPTION,
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					exited: { type: 'boolean', const: true },
					draftPath: { type: 'string' },
				},
				required: ['exited', 'draftPath'],
			},
			render: (_args, value) => [
				{
					type: 'text',
					text:
						'已退出 spec mode，工作树可写。现在按顺序落盘，不要跳步：\n'
						+ '1. AGENTS.md（只放文档索引与可证伪的规则，并标注 enforcement）\n'
						+ '2. docs/*.md（只写实际存在的）\n'
						+ `3. 删除草稿 ${value.draftPath}`,
				},
			],
		},
		async execute(_args, exec) {
			const agent = exec.agent;
			if (agent === undefined) {
				throw new Error(`${EXIT_TOOL_NAME} 需要一个调用它的 agent（没有会话可以切换）`);
			}
			const session = agent.session;
			if (!isSpecActive(session)) {
				throw new Error(`${EXIT_TOOL_NAME} 只能在 spec mode 中调用`);
			}
			const draftPath = draftPathFor(session);
			const interaction = ctx.get('userQuestions');
			if (interaction === undefined) {
				throw new Error(
					'当前组合没有 userQuestions 通道，弹不出确认框。访谈结论留在草稿里，请用户运行 /spec off 退出。',
				);
			}
			const answer = await interaction
				.ask({
					questions: [
						{
							id: REVIEW_ID,
							header: 'Spec mode',
							question: '退出 spec mode 并落盘？',
							detail:
								'工作树恢复可写，随后按草稿写 AGENTS.md 与 docs/*.md，并删除草稿。\n'
								+ `草稿：${draftPath}`,
							options: [
								{ label: APPROVE_LABEL, description: '退出模式；从下一轮开始落盘。' },
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

			liveExits.add(session);
			return { exited: true, draftPath };
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
			if (touchesDraft) return 'Spec mode: 草稿在合并进 AGENTS.md 前不可删除或改名。';
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

	/* ---------------- AGENTS.md advisories ---------------- */

	ctx.on('tools/post-execute', async (exec, result, next) => {
		const decision = await next();
		try {
			const content = agentsMdWriteContent(exec.name, exec.arguments, result.isError === true);
			if (content === undefined || decision.kind !== 'accept') return decision;
			const messages = agentsMdAdvisories(content);
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
			agent.inject(noticeMessage(pendingDraftNotice(draftPath), '未完成的 spec 草稿'));
		} catch {
			// A session whose state cannot be read simply gets no notice.
		}
	});
}
