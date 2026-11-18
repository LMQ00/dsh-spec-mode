/**
 * The interview protocol injected while spec mode is active, and the
 * cross-session notice for an unfinished draft.
 *
 * What lands is a chart collection under `.spec/flows/`: one overview of what the
 * product does, one chart per module it points at, and one requirement brief per
 * chart. The protocol is injected into the system prompt on every request while
 * the mode is active, so it stays short: the validators in `mermaid-graph.js`,
 * `chart-md.js`, `flows.js` and `brief.js` name what they reject, and the tool
 * descriptions carry the parameter shapes.
 *
 * @module dsh-spec-mode/prompt
 */

/**
 * Rendered as the `spec:policy` prompt section on every request while the mode
 * is active. The exit step names this composition's actual command and tool.
 *
 * @param {string} draftPath - absolute path of the interview draft.
 * @returns {string} the complete section text.
 */
export function specModeContext(draftPath) {
	return `## Spec mode

你把用户的需求访谈成 \`.spec/flows/\` 图集：每张图一份 \`<id>.md\`——\`# 显示名\`、范围行、mermaid 块、\`## 简报\`。工作树只读：除草稿外，\`.spec/\` 与 \`AGENTS.md\` 也写不了。草稿（唯一可写目标）是 \`${draftPath}\`，用这个绝对路径写；相对路径按工作目录解析，对不上草稿就会被拦下。

### 访谈
用户会分多次补充。每轮把新结论立刻增量写进草稿，已定的不重问，未决的写进草稿「未决」而不是留在对话里。

- 每轮问当前最高价值的缺口，一次可以问多个；给选项、推荐与理由，含糊就追问到可验证：命令 + 退出码、阈值 + 测法、样例输入输出。「做好了 / 干净 / 能跑」不是答案。
- 用户说「本来是 X，后来改成 Y」时，只问清 Y 的边界与影响。
- 回答后用你的话复述理解，包括你从中推出的结论，让用户确认或纠正。发现 gap 先摆出来；与草稿冲突时让用户裁决。
- 每轮结尾一行：\`已定：… ｜ 待定：… ｜ 假设：…\`
- 四项都覆盖且用户确认过你的回述才算完成：目标与验收、用户可见行为、数据与状态、约束与选型（含明确不做什么；只记选了什么，不记为什么不选别的）。
- 落盘前整体回述：每张图、每个框、每条简报要点讲一遍；草稿「假设」逐条被确认或否掉。

### 图集
\`overview\` 是产品全貌，全册一张；其余图被父图的模块框引用。

\`\`\`mermaid
flowchart LR
  n1["用户输入 /spec"] --> n2["模型逐轮访谈"]
  n2 -->|有缺项| n1
  n2 --> n4[["check<br/>入：本次提交的图<br/>出：通过或点名报错"]]
  n4 -->|通过| n5["落盘"]
\`\`\`

- 第一行固定 \`flowchart LR\`。节点一行一个 \`n1["谁做了什么"]\`，不超过 120 字符；模块框 \`n4[["<子图 id><br/>入：…<br/>出：…"]]\`，端口至少一条、写在父图上，框上的字取自子图标题。
- 箭头一行一条 \`n1 --> n2\`；分叉写 \`n1 -->|条件| n2\`（可选，不超过 40 字），同一个框的两条出边不能同字。
- 一张图恰好一个起点；会重复的一步用回箭头指回重来的框；多个终点可以，但每个都是「到此为止」。顶层模块框最多六七个。
- 框里写日常说法：不写函数名、变量名、源码文件名、代码、理由与验收阈值。
- 图和简报讲同一件事：每个框、每条箭头都能在简报里找到对应需求，反之亦然；对不上就是还没问清。

### 简报
文件末尾 \`## 简报\`，四节每条一行：\`### 目标\`（一句话）、\`### 要做什么\`（需求本身）、\`### 验收\`（可观察）、\`### 约束\`（没有就省）。
不写标题、代码、理由与背景、被否决的方案、本机绝对路径。用户还没想清就空着，不为凑格式编内容。

### 落盘
用户确认访谈结束后，先整体回述，再调 \`spec_resolve\`（工具先校验再弹确认框）：

- \`charts\` 只放新图与改过的图，没提交的图保持盘上原样；只改图不动简报时省掉 \`brief\`，显式空串才是清空。\`removed\` 列要删的 id；被引用的图和唯一的 \`overview\` 删不掉。
- 用户选「退出并落盘」→ 工具写文件、删草稿、退出模式；选「继续访谈」→ 这一轮到此为止，别重复调用；关掉确认框 → 等他说话；校验报错 → 按点名处改完再调。
- 用户自己 \`/spec off\` 后，你照同样的形状写 \`.spec/flows/\`、删草稿，再更新 \`AGENTS.md\`。
- \`AGENTS.md\` 只放文档索引与可证伪的开发规范规则，每条标 enforcement：代码强制 / 提示词；不写现状、进度、待办、里程碑。归属判断：这条规则换一种实现就失效 → 产品特性，进简报；不会 → 开发规范，进 \`AGENTS.md\`。
- 产出文件只用仓库相对路径，不写本机绝对路径。

### 访谈之外
不在 spec mode 时用 \`flow_read\` 读图集、\`flow_write\` 改一张，两者跑同一套校验；spec mode 开着时不要用 \`flow_write\`。`;
}

/**
 * Injected at session start when a draft is on disk and the mode is off. The
 * draft file alone cannot say whether it is unfinished (the interview
 * continues) or already landed with the delete step skipped, so the notice
 * names both readings and how to tell them apart instead of asserting the file
 * is unfinished.
 *
 * @param {string} draftPath - absolute path of the interview draft.
 * @returns {string} the notice text.
 */
export function pendingDraftNotice(draftPath) {
	return `\`${draftPath}\` 是 spec mode 的访谈草稿，但本会话没有 spec 记录——它可能已经落盘、只是没被删掉。`
		+ '用 flow_read 读出 `.spec/flows/` 与这份草稿对照：已被取代就直接删掉它，未被取代才接着访谈，已确定的字段不要重问。'
		+ '要恢复工作树只读守卫就先运行 /spec。';
}
