# dsh-spec-mode

DSH 插件：由模型主导的增量访谈，把用户逐步浮现的需求固化成 **AGENTS.md 开发规范** +
**`docs/` 技术文档**。

- 入口：`index.js`（Host 插件，`export function apply(ctx)`）
- 依赖：仅 `node:crypto` / `node:fs` / `node:os` / `node:path`。不 import 任何
  `@deepseek-ai/*` 包，所以只靠 profile 自身解析，不装第二份 Harness 运行时。
- 安装形态：`link:` 进 profile `web`，Loader 行为 `include:spec-mode`。

## 用法

```
/spec [初始想法]        # 进入；带想法时想法作为这一轮的用户消息提交
/spec off               # 退出，工作树恢复可写，草稿保留
```

裸 `/spec` **只切模式**，不提交任何消息：访谈从用户真正写下的东西开始——`/spec` 后面的
想法，或他随后发的第一条普通消息。

访谈结束时不需要用户手动退出：模型调用 `spec_resolve` 弹确认框，用户选「退出并落盘」
或「继续访谈」。访谈期间工作树只读，唯一可写目标是 `<项目根>/docs/spec-draft.md`。

## 规则

- **改投影状态字段或 fold 语义时，必须同时把 `state.js` 的 `PROJECTION_VERSION` 加一。**
  否则持久化缓存里的旧行会被前向 fold 成垃圾。
- **裸 `/spec` 不得合成消息。** 命令面本身不产生模型消息；补一条「起轮」消息等于替用户
  开题。访谈必须由用户写下的内容触发（`/spec <想法>`，或他随后发的第一条消息）。
- **不要在 `index.js` 里读「有效状态」来回答「这条命令进来之前是什么状态」。**
  `command/run` 在 handler 之前入日志，那个问题只能问 `loggedActive()`。
- **`icon.svg` 用显式颜色，不要 `currentColor`。** 图标以 `data:` URL 渲染，SVG 拿不到
  宿主 CSS 的 `color`，`currentColor` 会变成不可见的黑色。
- **`state.js` 的 `apply()` 对无关事件必须返回同一个 state 引用**，否则投影的增量机制失效。
- **不要引 `@deepseek-ai/*` 依赖。** 需要宿主 helper 时按等价实现内联（`defineTool`、
  `createUserMessage` 已有先例）。

## 文档索引

| 文档 | 何时读 |
| --- | --- |
| [`docs/插件说明.md`](docs/插件说明.md) | 想知道这个插件做什么、怎么用、拦什么不拦什么、界面出现在哪、有哪些限制时 |
| [`docs/实现逻辑.md`](docs/实现逻辑.md) | 要改代码、或要理解状态为什么用投影 fold、守卫为什么这么判时 |
| [`docs/交接文档.md`](docs/交接文档.md) | 接手这个插件、要跑验证清单、或升级宿主后排查时 |
| [`selftest.mjs`](selftest.mjs) | 改完 `state.js` / `guard.js` / `advisories.js` / `prompt.js` 后跑 `node selftest.mjs` |

## 自测

```
node selftest.mjs      # 17 项纯逻辑断言，不需要 Host
```

## 协议

[MIT](LICENSE)
