# 007 架构

这份文档把 [001 领域模型](001-domain.md) 的概念映射到文件与函数，并给两张索引表：模块表与测试表。先读「核心对象」与「依赖规则」，两张表当索引用。它建立在 [000 原则](000-philosophy.md) 到 [006 部署](006-deployment.md) 之上。

## 核心对象

模型的层次是：一份草稿喂出一册图集，图集里每张图管自己的模型、图片与简报；每条入口都收在同一个校验器上。

```mermaid
flowchart LR
  CMD[/spec] --> STATE[state.js 投影]
  STATE --> PROMPT[prompt.js spec:policy]
  PROMPT --> MODEL[模型]
  MODEL --> DRAFT[.spec/draft.md]
  MODEL --> RESOLVE[spec_resolve]
  RESOLVE --> FLOWS[flows.js 校验]
  FLOWS --> FLOW[flow.js 校验]
  FLOWS --> SVG[flow-svg.js 排版]
  SVG --> RASTER[rasterize.js 转换]
  RASTER --> DISK[.spec/flows/]
  PAGE[client.js 流程图页] --> API[flows-api.js 路由]
  API --> FLOWS
  API --> SVG
  MODEL --> TOOLS[flow_read / flow_write]
  TOOLS --> FLOWS
```

## 核心类

### 投影 `state.js`

拥有的：投影键 `spec`、状态版本 `1`、状态三个字段 `active` / `running` / `exitCall`、所有产物路径的解析函数、创建 `.spec/` 目录、判断草稿是否有内容。

依赖：`node:fs`、`node:path`。

### 校验 `flow.js`

拥有的：单张图的规则——节点、模块节点、连线、分叉条件、起点、回箭头识别。导出 `validateFlow()` 与 `backEdgesOf()`。

输入：一张图的 `{ nodes, edges }`，不知道图集里有几张图，也不知道文件名。

### 校验 `flows.js`

拥有的：图集的规则——恰好一张总览、引用指得到、引用不成环、孤儿与模块过多的警告、删除保护。还有全部磁盘读写与修订号。导出 `validateChart()`、`validateCollection()`、`readCollection()`、`writeChartModel()` 等。

输入：已经过 `validateFlow` 的图；输出：六个字段的模型与磁盘读写。

依赖：`flow.js`、`node:crypto`、`node:fs`、`node:path`。

### 排版 `flow-svg.js`

拥有的：层与折行、框的尺寸与位置、连线走位、条件标签落点、画布尺寸。导出 `renderFlowSvg()`、`layersOf()`、`wrapLabel()`。

输入：已经过 `validateFlow` 的图；输出：一段 SVG 文本。

依赖：`flow.js`（取回箭头）。

### 转换 `rasterize.js`

拥有的：探测本机转换器并按顺序试，导出 `rasterize()` 与 `svgSize()`。

输入：写好的 SVG 文件；输出：PNG 文件，或者 `undefined` 表示本机没有可用转换器。

依赖：`node:child_process`、`node:fs`、`node:url`、`node:util`。

### 路由 `flows-api.js`

拥有的：`/spec/flows/{list,chart,preview,save,create,delete}` 六个接口、请求体上限、403 与 404 的拒绝。

输入：HTTP 请求；输出：JSON 响应，图合不合格由 `flows.js` 判定。

依赖：`flows.js`、`flow-svg.js`。

### 守卫 `guard.js`

拥有的：路径分类 `draft` / `working-tree` / `protocol`，工具名谓词。

输入：一次工具调用的名字与参数；输出：`protocol` / `draft` / `working-tree` 三种分类。

依赖：`node:path`。

## 依赖规则

谁可以 import 谁：

| 模块 | 可以 import |
| --- | --- |
| `state.js`、`guard.js`、`prompt.js`、`advisories.js`、`brief.js` | 只有 `node:` 标准库 |
| `flow.js` | 无 |
| `flows.js` | `flow.js` + 标准库 |
| `flow-svg.js` | `flow.js` |
| `rasterize.js` | 标准库 |
| `flows-api.js` | `flows.js`、`flow-svg.js` |
| `index.js` | 上面全部 |
| `client.js` | 只经 HTTP 与宿主注入，不 import 服务端模块 |

状态只有一个写者：

| 状态 | 写者 |
| --- | --- |
| 草稿 | 访谈中的模型 |
| 图的模型 | `spec_resolve`、`flow_write`、`/spec/flows/save`、`/spec/flows/create` |
| 图集目录与删除 | `spec_resolve`、`/spec/flows/delete` |
| 简报 | `spec_resolve`、`flow_write`、`/spec/flows/save` |
| 模式 | `state.js` 的折叠，唯一 |
| `AGENTS.md` | 模型，插件只提醒 |

## 模块

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口：注册投影、提示词段落、`/spec` 命令、三个工具、守卫、图集路由，并决定落盘顺序 |
| `state.js` | 折叠会话日志得出模式状态，解析产物路径 |
| `guard.js` | 把工具目标路径分类成草稿、工作树或协议路径 |
| `prompt.js` | 提供 `spec:policy` 提示词与跨会话草稿提醒的文字 |
| `advisories.js` | 对 `AGENTS.md` 的写入做行数与进度两条不阻止写入的提醒 |
| `brief.js` | 校验与渲染简报的四个小节，并把写好的简报读回结构 |
| `flow.js` | 校验单张图的节点、模块节点、连线、分叉条件与起点，识别回箭头 |
| `flows.js` | 校验整册图集的引用与唯一的 overview，读写图集文件，计算修订号 |
| `flow-svg.js` | 把一张图排成 SVG：分层、折行、框、连线、条件标签、画布尺寸 |
| `rasterize.js` | 探测本机可用的转换器，把 SVG 转成 PNG |
| `flows-api.js` | 提供 `/spec/flows` 下六个 HTTP 接口给流程图页用 |
| `client.js` | 流程图页：列图集、看图、改模型、保存、新建、删除 |
| `doc-flow.mjs` | 生成这个仓库自己的图集：`npm run flow` |
| `selftest.mjs` | 纯逻辑断言：不启宿主也能跑的 70 项 |
| `landing-test.mjs` | 用假上下文驱动真实 `apply()` 的 13 项接线断言 |

## 测试

| 测试 | 覆盖什么 |
| --- | --- |
| `selftest.mjs` | 锚点与路径、守卫分类、投影折叠、简报校验、单图校验、图集规则、分层与折行、条件标签落点、SVG 结构、修订号、读盘往返、`AGENTS.md` 提醒 |
| `landing-test.mjs` | `apply()` 的注册、路由挂载、提示词段落、确认框的三条分支、落盘写盘、守卫拦截、`AGENTS.md` 提醒接线 |

## 持久化

| 文件 | 存什么 | 谁写 |
| --- | --- | --- |
| `.spec/draft.md` | 访谈期间的结论 | 模型 |
| `.spec/flows/<id>.json` | 图的模型，六个字段，键序固定 | 三个入口 |
| `.spec/flows/<id>.png` | 由模型画出的图 | 落盘与保存 |
| `.spec/flows/<id>.svg` | 没有转换器时的图 | 落盘与保存 |
| `.spec/flows/<id>.brief.md` | 四节需求 | 落盘与保存 |
| `AGENTS.md` | 文档索引与开发规范规则 | 模型 |

投影状态由宿主持久化，插件自己不写：键 `spec`，版本 `1`。

## 对外接口

工具：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `spec_resolve` | `charts[]` 每项含 `id`、`kind`、`name`、`scope`、`nodes`、`edges` 与可选 `brief`；可选 `removed[]` | `exited`、`charts[]`（每张含 `model`、`picture`、`format`、`brief`）、`removed`、`warnings` |
| `flow_read` | 可选 `id` | `charts[]`、`problems[]`；带 `id` 时另有 `chart`、`revision`、`brief` |
| `flow_write` | `chart`、可选 `revision` | `id`、`revision`、`picture`、`format`、`warnings` |

路由：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/spec/flows/list` | `specDir`、`problems`、`charts[]` |
| GET | `/spec/flows/chart` | `chart`、`revision`、`brief`、`svg` |
| POST | `/spec/flows/preview` | `svg`；不校验、不写盘 |
| POST | `/spec/flows/save` | `id`、`revision`、`picture`、`warnings` |
| POST | `/spec/flows/create` | `id`、`revision` |
| POST | `/spec/flows/delete` | `removed` |

响应码：200 成功，403 `forbidden`，404 `no-session` / `no-chart` / `no-route`，409 `conflict` / `exists`，422 `invalid` / `unrenderable`，500 `failed`。

## 配置热更新

| 改动 | 生效方式 |
| --- | --- |
| 提示词、工具描述、命令描述 | 下一个请求，不需要重启 |
| 界面文案 | 重新加载页面 |
| 校验规则、产物路径 | 需要重启宿主 |
| `AGENTS.md` 行数预算 | 下一次写入 |
