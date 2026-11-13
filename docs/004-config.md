# 004 配置与提示词

这份文档说明哪些文字是人能改的、哪些写死在代码里，以及它们怎么拼进一次请求、工具的每个参数收什么。它建立在 [001 领域模型](001-domain.md) 到 [003 生命周期](003-lifecycle.md) 之上。

## 可编辑区

| 区 | 装什么 | 在哪 |
| --- | --- | --- |
| 访谈协议 | 一整段 `spec:policy` 提示词：前提、每轮目标、要拿全的四项、图集的形状、每张图怎么画、简报怎么写、完成后的落盘、访谈之外也能改图 | `prompt.js` 的 `specModeContext()` |
| 落盘后的指引 | 一句「现在只剩一步：写 AGENTS.md」 | `index.js` 里 `spec_resolve` 的 `render` |
| 草稿提醒 | 新会话看到的那段「草稿可能已落盘」 | `prompt.js` 的 `pendingDraftNotice()` |
| 命令描述 | 斜杠菜单里显示的一行 | `index.js` 的 `commands.register` |
| 工具描述 | 三个工具的 `description`，模型据此决定怎么调 | `index.js` |
| 界面文案 | 流程图页的中英文两套 | `client.js` 的 `zh` / `en` |
| 插件元数据 | 插件列表里的标题与描述 | `locale/zh.json`、`locale/en.json` |

## 装配顺序

1. 插件注册 `spec:policy` 这个段落，`order` 取自宿主的 `PLAN_POLICY` 位置。
2. 每次组装请求时，宿主调用这个段落的 `text(context)`。
3. 段落读 `context.agent`；没有 agent、模式没生效、或读取抛错时返回空串。
4. 模式生效时返回完整协议，草稿路径以绝对路径拼进去。
5. 模型看到的最后一段是这份协议；它由人改不了，只能在代码里改。

改动 `specModeContext()` 的返回值不改变任何校验：协议说的规则与 `mermaid-graph.js`、`chart-md.js`、`flows.js` 的检查是两份文字，后者才是强制的那份。

## 工具参数

三张图共用一个参数形状：`{ id, name, scope, source, brief? }`。

| 参数 | 收什么 |
| --- | --- |
| `id` | 文件名，小写字母开头，只用小写字母、数字与短横，最长 24 位；`overview` 那张是产品全貌 |
| `name` | 文件第一行，也是模块框上显示的字 |
| `scope` | 文件第二行，一行写死从哪一步到哪一步 |
| `source` | 文件里 `mermaid` 块的内容：`flowchart LR` 头、节点行、连线行 |
| `brief` | 可选，文件末尾 `## 简报` 一节：`### 目标`、`### 要做什么`、`### 验收`、`### 约束` |

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `spec_resolve` | `charts[]` 每项是一张图；可选 `removed[]` 列出要删的图 id | `exited`、`charts[]`（每项 `id`、`path`、`brief`）、`removed`、`warnings` |
| `flow_read` | 可选 `id` | `charts[]`、`problems[]`；带 `id` 时另有 `chart`（含 `source`）、`revision`、`brief` |
| `flow_write` | `chart`、可选 `revision` | `id`、`revision`、`path`、`warnings` |

`flow_read` 返回的是文件里的原文，`flow_write` 收的也是原文：一个读者把读到的 `source` 原样交回去，文件不变。

## 优先级

从强到弱：

1. 代码里的校验器：`mermaid-graph.js`、`chart-md.js`、`flows.js`、`brief.js` 不接受的东西写不进磁盘。
2. 代码里的常量：产物路径 `.spec/`、`.spec/flows/`、请求体上限、行数预算、mermaid 库的查找顺序。
3. `spec:policy` 提示词：告诉模型怎么访谈、怎么写图，模型可以偏离，偏离的产物会被第 1 条拦下。
4. 仓库里的 `AGENTS.md`：每个会话都读进上下文，只影响开发规范。
5. 用户当场说的话：可以推翻上面任何一条的意思，但推翻不了第 1 条。

## 版本与迁移

当前插件版本 4.0.0，产物是每张图一份 `.spec/flows/<id>.md`。

| 改动 | 会发生什么 |
| --- | --- |
| 改投影状态字段或折叠语义 | 必须把 `PROJECTION_VERSION` 加一；否则持久化缓存里的旧行会被前向折叠成错误状态 |
| 改提示词 | 下一个请求就生效，不需要重启 |
| 改界面文案 | 重新加载页面后生效；客户端包里带 `immediately: true` |
| 改 mermaid 库的位置 | 设 `DSH_SPEC_MERMAID` 后重启宿主；查找顺序见 006 部署的「配置」一节 |
| 改 `AGENTS.md` 的行数预算 | 下一次写入的提醒阈值跟着变；已经写好的文件不动 |
| 改产物路径 | 老项目的产物留在原处，插件只认新路径 |

`AGENTS.md` 由模型写的部分在升级时不会被插件改动：插件只在写入时检查行数，从不改写内容。
