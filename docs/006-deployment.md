# 006 部署

这份文档覆盖安装、配置、启停与排障。它建立在 [001 领域模型](001-domain.md) 到 [005 界面](005-panel.md) 之上。

## 运行什么

| 组件 | 必须 | 说明 |
| --- | --- | --- |
| DSH 宿主进程 | 是 | `dsh web` 或 DSH Desktop，插件跑在它里面 |
| 插件的 Host 半 | 是 | 一个 Cordis 行，`id` 是 `spec-mode` |
| 插件的 Client 半 | 否 | 流程图页；没有它仍能访谈与落盘 |
| 宿主的 web 服务 | 否 | 没有它就没有图集路线，页面打不开 |
| 本机转换器 | 否 | 有它出 PNG，没有它留 SVG |

## 前置条件

| 项 | 要求 |
| --- | --- |
| Node | 能跑 `node --version` 即可，插件只用标准库 |
| DSH | `dsh --version` 能跑；本仓库验证过 0.2.2-rc.1 |
| pnpm | 宿主安装插件时用，随 DSH 一起来 |
| 仓库位置 | 任意本地目录，装的时候给绝对路径 |

## 安装

```sh
# 1. 把仓库装进 web profile，记录绝对路径
dsh plugin --profile web add link:~/Projects/dsh-spec-mode

# 2. 重启 web 服务，让加载器重新读 profile
dsh web
```

第 1 条把仓库软链进 profile 的 `node_modules`，加载器里的行为名是 `include:spec-mode`。第 2 条启动后，浏览器打开宿主的地址，会话标签栏里出现「流程图」。

装完之后校验一次：

```sh
dsh plugin --profile web list
```

输出里应有 `dsh-spec-mode`，状态为已启用。

Desktop 的 `desktop` profile 由应用独占：

```sh
dsh plugin --profile desktop list
```

输出 `error: profile "desktop" is managed exclusively by the Electron application`。在 Desktop 里装：打开「插件」页 → 添加插件 → 包名或地址一栏填仓库的**绝对**路径。

## 配置

没有配置项。协议文本、产物路径、行数预算、请求体上限、排版尺寸都是代码里的常量。

| 键 | 是否必填 | 含义 |
| --- | --- | --- |
| — | — | 这个插件不读任何配置键 |

`package.json` 里有三个描述性字段，改它们不影响运行：

| 键 | 值 | 含义 |
| --- | --- | --- |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 加载器插哪一行 |
| `dsh.client.platform` | `web` | 前端平台；Desktop 载入的也是同一份 |
| `dsh.client.inject` | `["@deepseek-ai/dsh-client-ui-conversation"]` | 视图挂在哪个客户端包上 |

## 启停与状态

| 命令 | 作用 |
| --- | --- |
| `dsh web` | 启动宿主与 web 服务 |
| `dsh plugin --profile web list` | 看插件是否启用 |
| `dsh --profile web --dump-config` | 看合成后的配置，插件行在 `insert` 里 |
| `npm test` | 跑这个插件自己的两套断言 |

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功 |
| 1 | `npm test` 有断言失败；`npm run flow` 校验不过 |

日志跟着宿主进程的输出去：`dsh web` 在前台运行时直接看终端。

## 升级

1. 更新仓库到目标版本。
2. 重启宿主：`dsh web`。
3. 跑 `npm test`，两套断言全过。
4. 在流程图页打开一张图，确认它照常显示并能保存。

回滚就是把仓库切回上一个版本再重启。

## 排障

| 现象 | 原因与修法 |
| --- | --- |
| `error: profile "desktop" is managed exclusively by the Electron application` | 用 Desktop 的「插件」页安装，别用命令行 |
| 插件列表里没有 `dsh-spec-mode` | 重启 `dsh web`；加载器只在启动时读 profile |
| 标签栏里没有「流程图」 | 宿主的客户端包没加载，或 `dsh.client.platform` 被改过 |
| 页面显示「这个项目还没有流程图集」 | 这个项目的 `.spec/flows/` 还没有图；跑一次 `/spec` 访谈，或在页面上「新建图」 |
| 页面上报「盘上的图已经变了，先重新载入再改」 | 盘上的模型被别处改过；点「重新载入」取回盘上那一版 |
| 页面报「找不到这个会话」 | 请求里的会话 id 在当前宿主里不存在；回到那个会话再打开这一页 |
| 落盘后留下 `<id>.svg` 而不是 `<id>.png` | 本机没有可用的转换器；装 `rsvg-convert`、Chrome 或 inkscape 任意一个 |
| 工具报「工作树只读」 | 模式开着；结论写进草稿，改代码先跑 `/spec off` |
| 工具报「当前组合没有 userQuestions 通道」 | 这个 profile 没有提问通道；运行 `/spec off` 退出 |
| `npm run flow` 非零退出 | 仓库自己的图集校验不过，按报错里的字段路径改 `doc-flow.mjs` |
