# 008 手册

这份手册教怎么给这个项目加一条新的校验规则。它用 [001 领域模型](001-domain.md) 的术语与 [007 架构](007-architecture.md) 的模块分工。

## 映射

| 概念 | 这里对应什么 |
| --- | --- |
| 源码 | `.spec/flows/<id>.md` 里 ` ```mermaid ` 块的内容，一行一个节点或一条连线 |
| 单图规则 | 解析源码时逐行发生的检查：`mermaid-graph.js` 的 `parseMermaid()` |
| 整图规则 | 要看全图的检查：`mermaid-graph.js` 的 `validateGraph()` |
| 整册规则 | 要看全部文件的检查：`flows.js` 的 `validateCollection()` |
| 报错 | 一段中文，单图规则前置「第 N 行:」 |
| 入口 | `spec_resolve`、`flow_write`、`/spec/flows/save`、`/spec/flows/create` 全跑 `validateChart()` |

## 1. 选层

| 这条规则要看什么 | 写在哪 |
| --- | --- |
| 一行源码的形状：括号、箭头、模块框的第一行、某条端口 | `mermaid-graph.js` 的 `parseMermaid()` |
| 整张图：起点、分叉条件、重复说明、重复连线 | `mermaid-graph.js` 的 `validateGraph()` |
| 整册图集：overview、引用、成环、删除、孤儿 | `flows.js` 的 `validateCollection()` |
| 文件四块与字段长度：标题、范围、id | `chart-md.js` 的 `parseChartMarkdown()`、`flows.js` 的 `validateChart()` |

报错与行号：`parseMermaid()` 里用 `lineNumber`，`validateGraph()` 里用 `node.line` / `edge.line`，两者都写进消息的开头。

## 2. 在解析层加一条

例子：模块框的每条端口以「入：」或「出：」开头。打开 `mermaid-graph.js`，在格式常量旁边加一个正则：

```js
/** A port says which side of the boundary it is on. */
const PORT_DIRECTION_RE = /^(入|出)[：:]/;
```

再在 `parseMermaid()` 的 `ports.forEach` 里、`labelProblem` 之前加判断：

```js
if (!PORT_DIRECTION_RE.test(port)) {
	errors.push(`第 ${lineNumber} 行: 模块框第 ${portIndex + 1} 条端口要以「入：」或「出：」开头`);
	return;
}
```

复现：把这段写进去，然后跑

```sh
node -e "import('./flows.js').then(({validateChart}) => console.log(JSON.stringify(validateChart({ id: 'p', name: '端口', scope: '从一个框到另一个框', source: 'flowchart LR\n  n1[\"开始\"]\n  n2[[\"landing<br/>没有方向\"]]\n  n1 --> n2\n'}, { knownModules: new Set(['landing']) }))))"
```

看到 `ok:false`，`errors` 里有一句带「第 3 行」的端口问题。

## 3. 补断言

在 `selftest.mjs` 的源码校验一节末尾加一条。它验的是规则本身，不碰磁盘：

```js
check('a module port names which side it is on', () => {
	const outcome = validateChart({
		id: 'p', name: '端口', scope: '从一个框到另一个框',
		source: 'flowchart LR\n  n1["开始"]\n  n2[["landing<br/>没有方向"]]\n  n1 --> n2\n',
	}, { knownModules: new Set(['landing']) });
	assert.equal(outcome.ok, false);
	assert.ok(outcome.errors.some((error) => error.includes('入：')), outcome.errors.join('；'));
});
```

复现：写进 `selftest.mjs`，跑

```sh
node selftest.mjs
```

看到 `58 checks passed` 变成 `59 checks passed`。

## 4. 跑全套

```sh
npm test
```

退出码 0：`59 checks passed` 与 `17 checks passed` 都出现。碰了路由或落盘接线时，17 项那一套才会拦到问题。

## 5. 让仓库自己的图集过新规则

```sh
npm run flow
```

它先跑一遍 `validateChart()` 与 `validateCollection()` 再写盘。新规则如果会把现有图判红，命令非零退出并打出图 id 与行号，改 `doc-flow.mjs` 里那张图的节点或端口，再跑一次，看到四行 `<id>: <path>` 与一行「写到 …/flows」。

## 6. 更新文档

| 改了什么 | 同步哪里 |
| --- | --- |
| 单图规则 | [001 领域模型](001-domain.md) 的「单张图的规则」加一行 |
| 图集规则 | [001 领域模型](001-domain.md) 的「图集的规则」加一行，标强度 |
| 拒绝的原因 | [002 规则与权限](002-rules.md) 的强度表 |
| 测试项数 | [007 架构](007-architecture.md) 的测试表与本文件第 3、4 步的数字 |
| 提示词里同一句话 | [004 配置与提示词](004-config.md) 的可编辑区，改 `prompt.js` |

## 检查清单

1. 规则落在对的层：行内检查进 `parseMermaid()`，全图进 `validateGraph()`，全册进 `validateCollection()`。
2. 报错开头有行号，结尾说清改哪里。
3. `selftest.mjs` 加一条断言，项数加一。
4. `npm test` 两套全过。
5. `npm run flow` 通过，仓库自己的四张图仍然有效。
6. 001 与 002 的表格同步，007 的项数同步。
