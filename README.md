# dsh-mnemon-source-link

联邦只读记忆源（Federated read-only Memory Source），把 **Obsidian vault**、**LogiNote 学习笔记库** 与 **工作区任务台账** 三类本地数据接入 [`dsh-mnemon`](https://www.npmjs.com/package/dsh-mnemon) 的统一召回。

- 包类型：`dsh-mnemon` Source 插件（`role=narrative` / `typeId=federated-link`）
- 构建产物：`lib/`（ESM）
- 许可证：MIT

## 功能

- **三源联邦**：一次安装即可只读挂载 Obsidian（Markdown 知识库）、LogiNote（`vault/*.md` + 只读 `metadata.json`）、台账（工作区交接 / 任务文本）。
- **统一召回**：通过 `dsh-mnemon` 的 `search` / `read` / `browse` / `related` 路由参与组合召回，每条证据带 `provenance`（源文件路径，台账另带行号）。
- **有界扫描**：`maxFiles`（默认 5000）与 `maxFileBytes`（默认 1 MB）限制扫描规模；超大文件只取前若干行并标记 `truncated`，不会 OOM。
- **本地优先**：只读本地文件，不依赖云服务、不外发内容。
- **自动识别根目录**：安装后无需手填路径，加载时自动探测三个源的默认根目录并预填到设置（见下）。

## 只读与 0-LLM 保证

- **只读**：绝不写入 Obsidian vault，绝不修改 LogiNote 的 `metadata.json`；不声明任何写能力（无 `write` / `forget` / `archive` / `import`）。
- **0-LLM**：检索与解析全部为确定性逻辑，不调用任何大模型，断网可用，不产生模型费用。
- **越界防护**：读取被限制在各源 `root` 的真实路径内，`../` 路径穿越与指向根外的符号链接会被跳过并记入诊断。

## 自动识别根目录

插件加载时会尽力探测三个源的默认根目录，作为设置项的默认值（表单预填，也可随时改）：

- **Obsidian**：在常见位置（`D:\azb\数据\Obsidian笔记`、`~/Documents`、`~/Obsidian`）寻找直接包含 `.obsidian/` 的目录。
- **LogiNote**：寻找包含 `metadata.json` 的库（若其下有 `vault/` 子目录则取该目录）。
- **台账**：默认取本插件所在仓库根（即工作区，含 `ledger/`、`交接.md`）。

也可用环境变量显式覆盖：`OBSIDIAN_VAULT` / `LOGINOTE_VAULT` / `LEDGER_ROOT`。

探测是**启发式、只读、尽力而为**的：找不到时留空，用户可在设置里手动填写绝对路径；任何已保存的值都会覆盖探测默认。

## 设置（DSH 插件详情页）

配置字段是 DSH 的 **volatile 设置字段**，因此本插件会作为一个设置命名空间（`mnemon-source-link`）暴露，表单渲染在 **插件 → dsh-mnemon-source-link → 详情页** 的 description 与 rows 之间（宿主 `configForms`）。

- 修改后点「保存」即写入 profile 的配置文档。
- **保存后需重启 DSH**，插件重新加载时才会用新的根目录构建 Source。
- 也可以直接编辑 profile 的 `cordis.patch.yml` 中 `- id: mnemon-source-link` 的 `config`。

## 安装

```bash
# 在本包目录内构建
pnpm install
pnpm build
```

然后在 DSH 中用插件管理器安装本目录（bundle patch 会自动并入 loader）：

```
plugin_manager install_bundle  target: <本目录绝对路径>
```

安装后默认 `enabled: false`（可见但不扫描、不参与召回）；探测到的根目录已预填，按需把对应源 `enabled` 置为 `true` 即可。

## 配置概览

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `obsidian.enabled` | boolean | `false` | 是否启用 Obsidian 源 |
| `obsidian.root` | string | 自动探测 | Obsidian vault 根目录（绝对路径） |
| `obsidian.excludes` | string[] | `[]` | 相对 `root` 的排除目录名 |
| `loginote.enabled` | boolean | `false` | 是否启用 LogiNote 源 |
| `loginote.root` | string | 自动探测 | LogiNote vault 根目录 |
| `loginote.metadataPath` | string | `""` | `metadata.json` 路径，缺省为 `root/metadata.json` |
| `ledger.enabled` | boolean | `false` | 是否启用台账源 |
| `ledger.root` | string | 自动探测 | 台账所在工作区目录 |
| `ledger.file` | string | `交接.md` | 台账文件名（相对 `root`） |
| `maxFiles` | number | `5000` | 单次扫描文件上限 |
| `maxFileBytes` | number | `1048576` | 单文件读取字节上限（1 MB） |

更多安装后说明见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 接入召回（Mnemon View）

安装并启用后，本 Source 实例键为 `include:mnemon-source-link`。要让它真正参与召回，需在 `dsh-mnemon` 的 `memoryView` 策略里纳入它（例如加进 `include:mnemon-strategy-scoped` 的 `sourceKeys`，或确认所选策略默认纳入全部源）。重启会话后，`mnemon_recall` 的命中会带 `provenance`。

## 兼容与依赖

- Node ≥ 20。
- peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`dsh-mnemon ^0.5.53`。
- 设置表单依赖 DSH 的 volatile 设置机制与 Web 客户端（`dsh.client`）。

## 目录结构

```
src/
  index.ts       插件入口：Config（volatile 设置字段）、memoryPlugin、apply（解包 Volatile 后安装 Source）
  detect.ts      自动探测三个源的默认根目录
  source.ts      dsh-mnemon Composable Memory Source 定义（search/read/browse/related）
  registry.ts    适配器注册与配置归一化（并发检索、去重、字符预算）
  markdown.ts    Markdown 解析与片段匹配
  scan.ts        有界目录扫描（maxFiles / maxFileBytes / excludes / 越界防护）
  adapters/      obsidian.ts / loginote.ts / ledger.ts 三个只读适配器
  types.ts       共享类型
tests/           vitest 单元与组合测试
```

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试（vitest）
pnpm build       # 构建到 lib/
pnpm verify      # typecheck + test + build
```
