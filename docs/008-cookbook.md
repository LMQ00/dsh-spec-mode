# 008 手册

这份手册教怎么给这个项目加一个新的转换器。它用 [001 领域模型](001-domain.md) 的术语与 [007 架构](007-architecture.md) 的模块分工。

## 映射

| 概念 | 这里对应什么 |
| --- | --- |
| 图片 | `<id>.png`，由模型画出的 SVG 转成 |
| 转换器 | 本机上能把 SVG 变成 PNG 的可执行程序 |
| 落盘 | 调用转换器的唯一时机：写图之后、删草稿之前 |

转换器不是领域概念：插件只按顺序试，用第一个能出图的。探测列表在 `rasterize.js`。

## 1. 加一个候选

打开 `rasterize.js`，把新程序加进 `attempts` 列表。列表按优先级从上往下试。

```js
if (usable('my-renderer')) {
	attempts.push(['my-renderer', ['--out', pngPath, '--width', width, '--height', height, svgPath]]);
}
```

三处要对：

- `usable()` 判断这个程序在不在：PATH 上的名字直接返回 true，绝对路径用 `existsSync`。
- 参数里的 `svgPath` 与 `pngPath` 都是绝对路径，尺寸是字符串。
- 从 `svgPath` 到 `pngPath` 的转换成功与否，由转换完之后 `existsSync(pngPath)` 判定。

要点：

- **顺序就是优先级。** 越靠前越先试，失败才试下一个；一个新的候选放在哪一行决定它有多常用。
- **失败必须能被吞掉。** `attempt()` 抛错时循环继续，所以一个装坏了的程序不会挡住后面的候选。
- **超时是 20 秒一项。** 某一项超时按失败处理，下一个继续。
- **候选只做栅格化。** 排版属于 `flow-svg.js`，转换器拿到的是画好的 SVG。

## 2. 处理特殊退出码

有的转换器成功时也返回非零。这种情况给它单独的 `attempt` 分支，别改全局的超时与吞错逻辑。

```js
try {
	await run('my-renderer', [...], { timeout: TIMEOUT_MS, windowsHide: true });
} catch {
	// 退出码非零但图已经写出来了，`existsSync` 会认它。
}
```

要点：

- **判据是文件，不是退出码。** 循环用 `existsSync(pngPath)` 决定成不成功。
- **`windowsHide: true` 留着。** Windows 上不加会弹一个黑框。

## 3. 让它接进落盘

不需要改落盘。`index.js` 的 `drawChart()` 先写 SVG，再调 `rasterize()`，再按返回决定留 PNG 还是留 SVG。

看到成功的唯一标志：跑一次落盘之后，工具结果里写 `PNG，由 <名字> 转换`。

## 4. 补断言

在 `selftest.mjs` 末尾加一条，验的是「探测顺序与失败回退」这条逻辑，不是真的调用外部程序。

```js
check('a candidate that produces no file falls through to the next', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'raster-'));
	const svg = join(dir, 'a.svg');
	writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
	const who = await rasterize(svg, join(dir, 'a.png'), { width: 10, height: 10 });
	assert.ok(who === undefined || typeof who === 'string');
});
```

跑：

```sh
node selftest.mjs
```

看到 `70 checks passed` 变成 71。

要点：

- **测的是回退，不是外部程序。** 断言写成「要么成功、要么干净地返回 undefined」，就不会因为跑测试的机器上装了不同的转换器而红。
- **临时目录用 `mkdtempSync`。** 断言自己清理，不留下文件。

## 5. 更新文档

改完 `rasterize.js` 的顺序表，同步这三处：

- `README.md` 里「转换器按顺序探测」那一句。
- [006 部署](006-deployment.md) 的排障表里那些「没有转换器」的行。
- 本文件第 1 步的代码块。

## 检查清单

1. 新程序加进 `attempts`，位置按常用程度定。
2. 失败能吞，成功按 `existsSync(pngPath)` 判。
3. 不改 SVG，排版留在 `flow-svg.js`。
4. 跑一次落盘，工具结果里出现新名字。
5. `node selftest.mjs` 全绿，项数加一。
6. 三处文档同步改完。
