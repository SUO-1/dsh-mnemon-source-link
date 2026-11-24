# dsh-mnemon-source-link

联邦只读记忆源（Federated read-only Memory Source），把 **Obsidian vault**、**LogiNote 学习笔记库** 与 **工作区任务台账** 三类本地数据接入 `dsh-mnemon` 的统一召回。

- 包类型：`dsh-mnemon` Source 插件（`role=link` / `typeId=federated-link`）
- 构建产物：`lib/`（ESM）
- 许可证：MIT

## 功能

- **三源联邦**：一次安装即可只读挂载 Obsidian（Markdown 知识库）、LogiNote（`vault/*.md` + 只读 `metadata.json`）、台账（工作区交接/任务文本）。
- **统一召回**：通过 `dsh-mnemon` 的 `search` / `read` / `browse` / `related` 路由参与组合召回，每条证据带 `provenance`（源文件路径，台账另带行号）。
- **有界扫描**：`maxFiles`（默认 5000）与 `maxFileBytes`（默认 1 MB）限制扫描规模；超大文件只取前若干行并标记 `truncated`，不会 OOM。
- **本地优先**：只读本地文件，不依赖云服务、不外发内容。

## 只读与 0-LLM 保证

- **只读**：绝不写入 Obsidian vault，绝不修改 LogiNote 的 `metadata.json`；不声明任何写能力（无 `write` / `forget` / `archive` / `import`）。
- **0-LLM**：检索与解析全部为确定性逻辑，不调用任何大模型，断网可用，不产生模型费用。
- **越界防护**：读取被限制在各源 `root` 的真实路径内，`../` 路径穿越与指向根外的符号链接会被跳过并记入诊断。

## 安装

```bash
# 在本包目录内构建
pnpm install
pnpm build

# 通过 DSH 插件管理器安装本目录（bundle patch 自动并入 loader）
```

安装后默认 `enabled: false` + 空 `root`，插件在面板可见但不参与召回；由用户在各源填入根目录并开启后才开始读取。

## 配置概览

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `obsidian.enabled` | boolean | `false` | 是否启用 Obsidian 源 |
| `obsidian.root` | string | `""` | Obsidian vault 根目录（绝对路径） |
| `loginote.enabled` | boolean | `false` | 是否启用 LogiNote 源 |
| `loginote.root` | string | `""` | LogiNote vault 根目录 |
| `ledger.enabled` | boolean | `false` | 是否启用台账源 |
| `ledger.root` | string | `""` | 台账所在工作区目录 |
| `maxFiles` | number | `5000` | 单次扫描文件上限 |
| `maxFileBytes` | number | `1048576` | 单文件读取字节上限（1 MB） |

更多安装后说明见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试（vitest）
pnpm build       # 构建到 lib/
pnpm verify      # typecheck + test + build
```

## 说明

本仓库当前处于脚手架阶段（Task 1）。业务逻辑（解析、适配器、扫描、注册表、Source 定义）将在后续任务中逐步填入 `src/`。
