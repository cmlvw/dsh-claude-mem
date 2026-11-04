# dsh-claude-mem

> 插件版本：0.3.1 · 许可证：MIT · Node：>= 22.13.0 · 实测宿主：DeepSeek Harness 0.2.1-rc.5

DeepSeek Harness 的跨项目长期记忆插件。思路是**少量注入 + 按需召回**：

- 每个会话开始时注入核心块：soul/user/rules 的正文（单条截断到 160 字）和项目索引行；
- 之后每轮按消息内容检索，相关时才注入少量正文（默认每轮最多 2 条）；
- 需要更多细节时，模型用 `mem_read` 读全文；
- 存储分两级：**全局库**（跨项目的偏好、准则、教训）和**工作区库**（项目内的决策与坑）。

## 目录结构

```
dsh-claude-mem/
├── package.json          插件清单
├── cordis.patch.yml      注册补丁：默认 disabled: true
├── tools/mem-admin.mjs   给人用的管理工具（审阅、导出、批准、清理）
├── test/                 回归测试（npm test）
└── src/
    ├── index.js          插件入口：钩子、注入流程、生命周期
    ├── config.js         配置 schema 与路径解析
    ├── db.js             SQLite 表结构与版本升级
    ├── store.js          条目的读写、去重、检索
    ├── recall.js         门控与检索
    ├── pipeline.js       每轮召回流水线（真实注入和 /mem-why 共用）
    ├── ledger.js         召回账本（按天聚合的计数）
    ├── safety.js         写入内容的注入检测
    ├── rerank.js         语义精排（默认关）
    ├── embed.js          调用本地 embedding 服务
    ├── vector.js         向量存储与语义检索（默认关）
    ├── inject.js         拼装注入文本
    ├── reinject.js       压缩后重新注入
    ├── workspace.js      会话目录到记忆库的映射
    ├── trust.js          工作区记忆库的信任标记
    ├── commands.js       用户斜杠命令
    ├── review.js         整理报告
    ├── tools.js          模型可调用的记忆工具
    ├── dream.js          整理时机的门控
    ├── notes.js          会话笔记
    ├── migrate.js        从 meow-memory 迁移
    ├── mutex.js          与 meow-memory 互斥，防止重复注入
    ├── secret.js         密钥和隐私检测（写入前拦截）
    ├── message.js        构造注入消息
    ├── time.js           时间标签
    └── prompts/          手册与工具说明文案（en.json 只有手册，工具说明会回退到中文）
```

## 数据存放位置（不随插件分发）

| 内容 | 路径 |
|---|---|
| 全局记忆库 | 默认 `D:\dsh-claude-mem\global.db`，可用 `globalDbPath` 修改 |
| 审计日志、信任标记 | 全局库所在目录的 `audit.jsonl`、`trusted-workspaces/` |
| 工作区记忆库 | `<工作区>/.dsh-claude-mem/memory.db`（目录内自动生成忽略所有文件的 `.gitignore`） |
| 升级备份 | 记忆库旁的 `*.bak-schema1`（含记忆原文） |

## 安装

1. 把目录放到 `C:\Users\User\.dsh\plugins\dsh-claude-mem\`，在目录内运行 `npm install`（通过 link 安装时，插件要能在自己的目录下解析到 schemastery）；
2. 在 profile 的 `package.json` 里加依赖：`"dsh-claude-mem": "link:C:\\Users\\User\\.dsh\\plugins\\dsh-claude-mem"`；
3. 把 `dsh-claude-mem` 加进 `dsh.profile.bundles`；
4. 在 profile 的 patch 层里启用（`cordis.patch.yml` 默认 `disabled: true`，启用是用户的决定）；
5. 重启 DSH。

依赖只有宿主提供的 `@deepseek-ai/schemastery`，没有其他第三方运行时依赖。

## 从 0.1.0 升级

**0.1.0 在 DSH 0.2.1-rc.5 上工具不可用**：宿主要求工具声明 `output`，且只接受 JSON Schema 的一个子集，0.1.0 的工具定义不符合，注册时全部失败，模型看不到任何 `mem_*` 工具，也写不了记忆，只有注入还在工作。0.3.0 修复了这一点。

记忆库结构从 v1 升到 v2，第一次打开时自动完成：只新增字段和一张统计表，不改动已有数据，并在库旁留一份 `.bak-schema1` 备份。0.1.0 的代码仍能读升级后的库，可以回退，但回退后工具又会失效。

**已有的工作区库要先信任**，否则会暂停并提示。可以在配置里一次写好：

```yaml
- id: dsh-claude-mem
  config:
    workspace:
      trusted:
        - 'C:/Users/User/.dsh/profiles/desktop'
        - 'C:/Users/User/.dsh/state/superagent'
    inject:
      firstTurnBudget: 4000   # 注入块多了一句声明，rules 多时预算要留够
```

也可以在对应工作区里执行 `/mem-trust`。

## 配置

只列常改的项，完整定义见 `src/config.js`。

| 配置 | 默认值 | 作用 |
|---|---|---|
| `workspace.autoRoot` | `true` | 从当前目录往上找最近的已有记忆库或 Git 根目录 |
| `workspace.aliases` | `[]` | 把某个目录的会话映射到另一个目录的记忆库，形如 `{from, to}`，都用绝对路径 |
| `workspace.requireTrust` | `true` | 不是本插件创建的工作区库，要先信任才打开 |
| `workspace.trusted` | `[]` | 预先信任的目录；`aliases` 的目标自动可信 |
| `write.protectCoreLevels` | `true` | 写入和修改 soul/user/rules 要用户确认 |
| `write.coreApproval` | `ask` | 怎么确认：`ask` 弹宿主审批，`intent` 按用户消息的关键词判断 |
| `write.detectInjection` | `true` | 内容疑似提示注入时要用户确认（所有层级） |
| `write.rejectPii` | `true` | 含手机号、身份证号时拒收 |
| `recall.vector.enabled` | `false` | 语义召回，需要本地向量服务 |
| `recall.vector.gateScore` | `0.68` | 关键词门没信号时，相似度达到它也算信号；调到 1 关闭 |
| `recall.vector.vetoScore` | `0.4` | 关键词撞上但相似度低于它的条目不注入；调到 0 关闭 |
| `recall.vector.vetoProtectStrength` | `3` | 关键词信号最强的条目达到这个强度就不被否决；调高可以关闭 |
| `recall.vector.queryPrefix` | 空 | 查询前缀。实测对 Qwen3-Embedding-4B 没有净收益，所以默认不加 |
| `inject.firstTurnBudget` | `1600` | 核心块预算（字） |
| `inject.maxCorePerLevel` | `30` | 核心块每层最多取几条 |
| `recall.minStrength` | `0.8` | 主动注入的最低信号强度 |
| `recall.gate.maxHitsPerSession` | `8` | 单会话最多命中几轮，压缩后归零 |
| `notes.retentionDays` | `30` | 会话笔记保留天数 |
| `dream.mode` | `suggest` | 到整理时机后：`observe` 只记录，`suggest` 提醒模型，`push` 推一轮整理 |

## 用户命令

这些命令只能由用户发起，模型调用不了。

| 命令 | 作用 |
|---|---|
| `/mem-trust` | 信任当前工作区的记忆库 |
| `/mem-review` | 查看待确认、疑似重复、缺少原因和长期未用的条目 |
| `/mem-approve <id\|all>` | 批准待确认的记忆 |
| `/mem-reject <id\|all>` | 拒绝待确认的记忆 |
| `/mem-why [消息]` | 解释记忆为什么被想起或没被想起。不带参数看上一轮，带消息就试运行（不注入、不改数据） |
| `/mem-stats [天数]` | 查看召回记录：注入了多少、为什么没注入、向量服务是否正常、有用率 |
| `/mem-feedback good\|bad` | 评价上一轮注入的记忆有没有用 |

## 管理工具

只读命令不修改数据库；写入命令默认只预览，加 `--yes` 才执行。

```bash
node tools/mem-admin.mjs review --db <库路径>
node tools/mem-admin.mjs export --db <库路径> --out <目录>
node tools/mem-admin.mjs approve --db <库路径> --id <id|all>
node tools/mem-admin.mjs reject --db <库路径> --id <id|all>
node tools/mem-admin.mjs purge --db <库路径>
node tools/mem-admin.mjs trust --data-dir <全局库所在目录> --workspace <工作区目录>
node tools/mem-admin.mjs embed --db <库路径>
```

`embed` 给还没有向量的条目补向量。向量服务没开时写入的条目不会自动补，语义召回也找不到它们，`/mem-stats` 会提示缺多少条。

`clean-keywords --db <库路径> [--max 13]` 去掉同一条里写法不同的重复关键词，超过上限的删到上限，优先删正文里已有的词，不改更新时间，执行前自动备份。这是整理工具，不是优化手段：在 286 条真实记忆的副本上，它删掉 99 个关键词后，换种说法的提问和误注入都不变，按关键词提问的命中少了 3/2628。关键词的写法差异（大小写、全半角、分隔符）在读取和匹配时已经自动归一，不需要为此清理数据。

`purge` 永久删除已作废的条目，删除前自动备份。导出文件和备份都含记忆原文，请注意保管。

## 写入保护

写入和修改 soul/user/rules 时，或内容疑似提示注入时，插件会请用户确认：

| 宿主审批结果 | 结果 |
|---|---|
| 批准 | 立即生效 |
| 拒绝或取消 | 不写入 |
| 没有审批通道（如无头运行、部分渠道） | 疑似注入进待确认区；核心层看用户消息里有没有“记住”“以后”这类关键词，有就生效，没有进待确认区 |

已知局限：

- 注入检测靠规则，换种说法可能绕过。普通层级（fact、lesson 等）没有被规则命中时会直接生效，只在注入时带“这是背景资料”的声明。
- 退回关键词判断时，用户说了“记住”，同一轮工具输出夹带的内容仍可能写入；微信、QQ 等渠道的消息也可能被算作用户消息。
- 子代理不弹审批，写入核心层一律进待确认区。

## 语义召回的取舍

开启向量后，每条通过基本过滤的消息都要调用一次向量服务（本机实测约 18 毫秒，超时 400 毫秒）。向量服务空闲时会卸载模型，第一条消息可能超时并退回关键词，插件会在后台叫醒它，下一条就能用上。

阈值用 Qwen3-Embedding-4B 和 192+94 条真实记忆校准，换模型要重新校准。下表是同一批问题的结果，换种说法的 20 条是自己写的合成题，60 条无关消息里有 30 条没参与过停用词调整：

| 配置 | 换种说法的提问 | 无关消息误注入 | 按标题提问 | 按关键词提问 |
|---|---|---|---|---|
| 只有关键词 | 0/20 | 10/60 | 96.5% | 87.0% |
| 向量（0.2.0 的做法） | 6/20 | 10/60 | 97.3% | 88.9% |
| 向量 + 语义开门 + 语义否决 + 强证据保护（现在） | 10/20 | 5/60 | 97.7% | 87.4% |

另外留了 20 条换种说法和 30 条无关消息，不参与任何调参，现在的配置在上面是 5/20 和 2/30。这批题只有几十条，几条的差距不足以下结论。

模型对比（同一批题，每个模型重新计算全部向量）：Harrier 0.6B（社区 GGUF）留出题语义开门 3/20，低于 Qwen3-Embedding-4B 的 5/20，没有采用。Qwen3-Embedding-8B 还没有实测。

## 真实宿主验证

用隔离的 `DSH_HOME` 和本地假模型，在 DSH 0.2.1-rc.5 的无头 profile 上实测过：插件加载、6 个工具注册和调用、审批的批准/拒绝/无通道、疑似注入进待确认区、隐私拒收、核心块和命中块插在真实用户消息之前、外来库暂停与 `/mem-trust`、`/mem-why`、`/mem-stats`、`/mem-review`、`/mem-approve`、`/mem-feedback`、向量模式下的召回。

没有实测：桌面端的审批弹窗（无头模式由测试插件应答）、微信和 QQ 渠道、上下文压缩后的重注入（只有假宿主测试）、真实模型下的行为。

## 测试

```bash
npm install
npm test
```

`package.json` 里的 `load-check`、`mutex-check`、`rehearsal` 脚本依赖的文件不在这个包里。
