# 记忆联动（dsh-mnemon-source-link）说明

> 联邦只读记忆源：把 Obsidian / LogiNote / 任务台账接入 Mnemon 统一召回，默认 0 LLM、只读、本地优先。

## 这是什么

「记忆联动」是一个 `dsh-mnemon` 的 Source 插件。它把三类分散在本地文件里的知识注册为一个联邦数据源（`role=narrative`、`typeId=federated-link`），并入 Mnemon 的组合视图（Composable View Memory）。会话召回时，模型可以像读取内置记忆一样检索这三类内容，并且每条证据都带来源路径（`provenance`），便于溯源。

它**不新增任何存储**、**不声明写能力**、**不调用其它插件的工具**、**不调用大模型**。

## 支持的数据源

| 源 | 读取对象 | 产出类型 |
| --- | --- | --- |
| Obsidian | vault 内的 `*.md`（frontmatter、标题、observations、`[[双链]]`、`#标签`） | `note` |
| LogiNote | `vault/*.md` + 只读 `metadata.json`（到期 / 待办） | `note` / `task` |
| 台账 | 工作区交接 / 任务台账文本，按标题或条目切块 | `ledger`（带行号 provenance） |

每个源的条目 id 带源前缀（`obsidian:` / `loginote:` / `ledger:`），跨源天然去重、结果稳定排序。

## 能力与路由

对 Host 暴露四个只读路由：

| 路由 | 能力 | 输入 | 说明 |
| --- | --- | --- | --- |
| `search` | `search` | `{ query, limit? }` | 跨三源检索，按分数 / 时间排序 |
| `read` | `read` | `{ id }` | 读取单条全文（id 须在授权白名单内） |
| `browse` | `browse` | `{ source? }` | 列出某源或全部源的条目摘要 |
| `related` | `related` | `{ id }` | 返回该条目的关联（双链 / 关系） |

`capabilities` 为 `['project','search','read','browse','related']`，**不含** `write` / `forget` / `archive` / `import`，因此面板与工具面不会出现任何写语义。`consistency: exact-snapshot`：每次 projection 用一份 id 白名单签发 ReadGrant，`query` 先验白名单再触碰适配器。

## 自动识别根目录

插件加载时会尽力探测三个源的默认根目录，作为设置项默认值（表单预填，也可随时改；**已保存的值覆盖探测值**）：

- **Obsidian**：在 `D:\azb\数据\Obsidian笔记`、`~/Documents`、`~/Obsidian` 下寻找直接包含 `.obsidian/` 的目录。
- **LogiNote**：寻找包含 `metadata.json` 的库；若其下有 `vault/` 子目录则取该目录。
- **台账**：取本插件所在仓库根（即工作区，含 `ledger/`、`交接.md`）。

也可用环境变量显式覆盖：`OBSIDIAN_VAULT` / `LOGINOTE_VAULT` / `LEDGER_ROOT`。

探测是启发式、只读、尽力而为：找不到就留空，可手填绝对路径。

## 配置项与设置界面

配置字段是 DSH 的 **volatile 设置字段**，因此本插件会作为一个设置命名空间 `mnemon-source-link` 暴露；表单渲染在 **插件 → dsh-mnemon-source-link → 详情页** 的 description 与 rows 之间（宿主 `configForms`）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `obsidian.enabled` / `loginote.enabled` / `ledger.enabled` | boolean | `false` | 是否启用对应源 |
| `obsidian.root` / `loginote.root` / `ledger.root` | string | 自动探测 | 绝对路径；启用但为空/相对会**报错**而非静默跳过 |
| `obsidian.excludes` | string[] | `[]` | 相对 `root` 的排除目录名；**空数组即默认** `.git` / `.obsidian` / `node_modules` |
| `loginote.metadataPath` | string | `""` | `metadata.json` 路径，缺省为 `root/metadata.json` |
| `ledger.file` | string | `交接.md` | 台账文件名（相对 `root`） |
| `maxFiles` | number | `5000` | 单次扫描文件上限 |
| `maxFileBytes` | number | `1048576`（1 MB） | 单文件读取字节上限；超出只取前若干字节并标 `truncated` |

保存语义：点「保存」写入 profile 的配置文档；**需重启 DSH**，插件重新加载后才会用新根目录构建 Source。也可直接编辑 profile `cordis.patch.yml` 中 `- id: mnemon-source-link` 的 `config`。

## 使用步骤

1. 安装本插件（bundle patch 会把 loader 行并入 `cordis.patch.yml`）。
2. 打开「插件 → dsh-mnemon-source-link → 详情页」，确认表单出现、三个根目录已按探测预填。
3. 按需修改 `root`，把对应源 `enabled` 打开。
4. **保存后重启 DSH**。
5. 在 Mnemon 的记忆视图（`memoryView`）中把本 Source 实例 `include:mnemon-source-link` 纳入召回（如加入 scoped 策略的 `sourceKeys`，或确认所选策略默认纳入全部源）。
6. 重启会话后，`mnemon_recall` 命中带 `provenance` 即表示打通。

## 只读与隐私

- 只读本地文件；**绝不写** Obsidian vault，**绝不改** LogiNote `metadata.json`。
- 不联网、不外发内容、不调用大模型，断网可用、零模型费用。
- 读取被限制在各源 `root` 的实路径内；`..` 穿越与指向根外的符号链接被跳过并记入诊断。
- 扫描有界：超 `maxFiles` 停止遍历；超 `maxFileBytes` 只取前若干行并标 `truncated`。
- 按 `(relPath, mtime, size)` 做进程内缓存，文件未变不重复读。

## 安装 / 卸载

- 安装：在包目录 `pnpm install && pnpm build` 后，用 DSH 插件管理器 `install_bundle` 指向本目录绝对路径。
- 卸载：用插件管理器移除本 bundle；不会删除或修改任何被读取的源文件。

## 边界与限制

- 本期只做**只读召回**，不做写回 / 沉淀（P2/P3 另行规划）。
- 不建本地库或向量索引；当前使用有界扫描 + mtime 缓存。
- 编码：统一按 UTF-8 读取并剥离 BOM；非法字节替换为 `�`，不因个别坏文件丢掉整库。
- 探测出的默认根目录只是常见位置的猜测；找不到时为空，需手填。

## 故障排查

- **看不到设置表单 / 显示「配置不可用」**：确认插件已启用、DSH 版本支持 volatile 设置；重启 DSH 后再看；页面会列出宿主当前提供的命名空间，可据此核对。
- **扫描不到内容**：检查 `root` 是否为绝对路径、`enabled` 是否打开、`excludes` 是否误排除了目标目录。
- **启用后构建报错**：`enabled: true` 但 `root` 为空或相对路径时会明确报错——填绝对路径或把该源关掉。
- **`availability` 为 degraded / unavailable**：对应源目录不存在或不可读。
- **LogiNote 的 `metadata.json` 缺失或损坏**：安全跳过（按「无元数据」处理），源保持 reachable，不会崩溃。
- **召回无 provenance**：确认本 Source 实例 `include:mnemon-source-link` 已被纳入当前记忆视图，并已重启会话。

## 开发与测试

```bash
pnpm typecheck   # 类型检查
pnpm test        # vitest（7 个测试文件 / 69 条用例）
pnpm build       # 构建到 lib/
pnpm verify      # typecheck + test + build
```
