# 记忆联动（dsh-mnemon-source-link）

> 联邦只读记忆源：把 Obsidian / LogiNote / 任务台账接入 Mnemon 统一召回，默认 0 LLM、只读、本地优先。

## 这是什么

「记忆联动」是一个 `dsh-mnemon` 的 Source 插件。它把三类分散在本地文件里的知识，注册为一个联邦数据源（`role=link`、`typeId=federated-link`），并入 Mnemon 的组合视图（Composable View Memory）。当会话进行召回时，模型可以像读取内置记忆一样检索这三类内容，并且每条证据都带有来源路径（`provenance`），便于溯源。

它**不新增任何存储**、**不声明写能力**、**不调用其它插件的工具**、**不调用大模型**。

## 支持的数据源

| 源 | 读取对象 | 产出类型 |
| --- | --- | --- |
| Obsidian | vault 内的 `*.md`（frontmatter、标题、observations、`[[双链]]`、`#标签`） | `note` |
| LogiNote | `vault/*.md` + 只读 `metadata.json`（到期 / 待办） | `note` / `task` |
| 台账 | 工作区交接 / 任务台账文本，按标题或条目切块 | `ledger`（带行号 provenance） |

每个源的条目 id 带源前缀（`obsidian:` / `loginote:` / `ledger:`），跨源天然去重、结果稳定排序。

## 能力与路由

本 Source 对 Host 暴露四个只读路由：

| 路由 | 能力 | 输入 | 说明 |
| --- | --- | --- | --- |
| `search` | `search` | `{ query, limit? }` | 跨三源检索，按分数 / 时间排序 |
| `read` | `read` | `{ id }` | 读取单条全文（id 须在授权白名单内） |
| `browse` | `browse` | `{ source? }` | 列出某源或全部源的条目摘要 |
| `related` | `related` | `{ id }` | 返回该条目的关联（双链 / 关系） |

`capabilities` 为 `['project','search','read','browse','related']`，**不含** `write` / `forget` / `archive` / `import`，因此面板与工具面不会出现任何写语义。

## 配置项

安装后可在「插件 → 可组合记忆」面板调整。初始为 `enabled: false` + 空 `root`，可见但暂不读取。

- `obsidian`: `{ enabled, root, includes? , excludes? }`
- `loginote`: `{ enabled, root, metadataPath? }`
- `ledger`: `{ enabled, root, file? }`
- `maxFiles`: 扫描文件上限，默认 `5000`
- `maxFileBytes`: 单文件读取字节上限，默认 `1048576`（1 MB）

`root` 需填**绝对路径**。`excludes` 默认跳过 `.git` / `.obsidian` / `node_modules`。

## 使用步骤

1. 安装本插件（bundle patch 会把 loader 行并入 `cordis.patch.yml`）。
2. 打开「插件 → 可组合记忆」，找到「记忆联动」组件。
3. 逐个源填入 `root`，把对应 `enabled` 打开。建议先用夹具/小目录验证，避免一次性扫描大库。
4. 在 Mnemon 的记忆视图（`memoryView`）中确认本 Source 实例被纳入召回（如加入 `include` 的 `sourceKeys`）。
5. 重启会话后，`mnemon_recall` 命中带 `provenance` 即表示打通。

## 只读与隐私

- 只读本地文件；**绝不写** Obsidian vault，**绝不改** LogiNote `metadata.json`。
- 不联网、不外发内容、不调用大模型，断网可用、零模型费用。
- 读取被限制在各源 `root` 的实路径内；`..` 穿越与指向根外的符号链接被跳过并记入诊断。
- 扫描有界：超 `maxFiles` 停止遍历；超 `maxFileBytes` 只取前若干行并标 `truncated`。

## 安装 / 卸载

- 安装：在包目录 `pnpm install && pnpm build` 后，用 DSH 插件管理器 `install_bundle` 指向本目录绝对路径。
- 卸载：用插件管理器移除本 bundle；不会删除或修改任何被读取的源文件。

## 边界与限制

- 本期（P1）只做**只读召回**，不做写回 / 沉淀（P2/P3 另行规划）。
- 不建本地库或向量索引；v1 使用有界扫描 + mtime 缓存，必要时 v2 再上全文索引。
- 编码：统一按 UTF-8 读取并剥离 BOM；非法字节替换为 `�` 并在条目上留痕，不因个别坏文件丢掉整库。

## 故障排查

- **扫描不到内容**：检查 `root` 是否为绝对路径、`enabled` 是否打开、`excludes` 是否误排除了目标目录。
- **`availability` 为 degraded / unavailable**：对应源目录不存在或不可读；`hints.reason` 会说明（如 `metadata-missing`）。
- **召回无 provenance**：确认本 Source 实例已被纳入当前记忆视图的 `sourceKeys`，并已重启会话。
