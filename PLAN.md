# dsh-claude-mem · 自有记忆插件设计方案 v2（从零实现）

> 立项 2026-10-28 18:10 ｜ 状态：**待确认，尚未写代码**
> 路线：不使用 fork。独立包从零写，先在 `C:\Users\User\dsh-claude-mem` 隔离开发，**不改 profile、不影响现网**。
> 参考：Claude Code 源码（ChinaSiro/claude-code-sourcemap）+ 视频 BV1z6SXBzEYh + meow-memory v0.32.1 的工程实践（只借鉴结论与坑，不复制代码结构）。

---

## 0. 摘要

三句话：

1. **记得更少但更准**：注入的不再是记忆全文，而是「索引」——每项目 ≤12 行、每行 ≤60 字；详情让模型用 `mem_read` 按需拉。
2. **该不该说由判断决定**：召回三阶段（规则门 → FTS5 粗筛 → 可选语义精排），没有命中就**什么都不注入**；写入有「不记什么」的硬清单。
3. **数据分两层**：soul/user/rules 进全局库（跨项目共用一份），project/fact/lesson/topic 进工作区库（跟项目走）。解决 meow 把用户偏好按工作区复制多份、逐渐漂移的问题。

现网关系：**本方案不动任何 profile 配置**。安装是最后一步，且装完 `disabled: true`，由你验收后再开。

---

## 1. 为什么从零写，而不是继续 fork

| 维度 | meow-memory 现状 | dsh-claude-mem 做法 |
|---|---|---|
| 注入内容 | 项目全景**全量渲染正文**，无字数上限 | 只灌**索引行**（≤12×60 字），正文按需读 |
| 注入时机 | 每条用户消息都跑关键词命中 | 首轮一次核心块 + **命中才注入** ≤2 条 |
| 召回 | 纯 BM25（关键词撞） | 规则门 → FTS5(trigram) 粗筛 → 可选语义精排 |
| 数据归属 | 每个工作区一套七层库，用户偏好重复 | **全局库 + 工作区库**两层，按层路由 |
| dream 触发 | 空闲 3 小时即触发，一晚可跑五六次 | 24h + 5 会话 + 10 分钟节流（官方门控） |
| 写入纪律 | 有敏感信息扫描 | 敏感信息**拒收** + 不记清单 + 语义去重 |
| 升级 | 上游一升级就要手工合并 fork 补丁 | 自有代码，无合并负担 |

fork 路线失败两次的教训（插件身份四处、duplicate factory registration）在新包里不存在：我们从一开始就是独立包、独立 id、独立数据目录。

---

## 2. 六个设计面（官方值 / 自定值分开标）

| # | 设计面 | Claude Code 源码里的做法 | dsh-claude-mem 的做法 | 值来源 |
|---|---|---|---|---|
| 1 | 索引与详情分离 | `MEMORY.md` 超 200 行截断；`MAX_MEMORY_FILES=200`；记忆按主题分文件 | 每项目索引 ≤12 行 × ≤60 字；超出折叠为「还有 N 条」；正文只在 `mem_read` 时返回 | 200 行/200 文件=**官方**；12×60=**自定** |
| 2 | 选择性写入 | extractMemories 有明确的「记 / 不记」清单：工具用法文档排除，gotchas 保留 | 写入工具描述 + 硬校验双保险（见 §7） | 清单思路=**官方**；具体条目=**自定** |
| 3 | 语义召回 | sideQuery 小模型 + JSON schema + `max_tokens 256`，最多 5 条，不确定即弃，先过滤已展示 | 默认规则召回；可选本地千问精排（≤5 条、600ms 超时、fail-open） | 5 条/256 token=**官方**；超时/默认关=**自定** |
| 4 | 会话记忆与压缩 | Session Memory 初始 10000 token，之后每 +5000 token 或 3 次工具调用更新 | v1 只做「压缩后重注入核心块」；会话笔记留到 M5 再评估 | 阈值=**官方**；v1 范围=**自定** |
| 5 | 周期整合 | autoDream：`minHours=24`、`minSessions=5`、扫描节流 10 分钟 | 照搬门控；在同一会话里 `followup` 推进三轮，不 fork 后台代理 | 门控=**官方**；执行方式=**自定** |
| 6 | 安全与边界 | teamMemorySync 带 secretScanner；记忆目录有归属/信任概念 | 写入前正则+熵检测，命中**拒收**；迁移时命中进隔离表；注入前再扫一遍 | 机制=**官方**；拒收而不是仅扫描=**自定** |

> 说明：网上二手转述的「每条记忆 150 字符」在源码里没找到，不采用为官方值；我们用的是自定的 60 字索引行。

---

## 3. 架构

```
C:\Users\User\dsh-claude-mem\            # 开发目录（隔离，不在 $DSH_HOME 下）
├── package.json                  # name: dsh-claude-mem, dsh.bundle.patch 指向自带 patch
├── cordis.patch.yml              # 只 insert 一行
├── src/
│   ├── index.js                  # cordis 入口：Config schema + 装配 + 钩子
│   ├── config.js                 # 默认值 + 校验
│   ├── db.js                     # node:sqlite 打开/建表/迁移/FTS5
│   ├── store.js                  # 条目 CRUD、索引投影、注入记录
│   ├── scope.js                  # 全局库/工作区库路由
│   ├── recall.js                 # gate → 粗筛 → 精排 → 预算装配
│   ├── inject.js                 # pre-step 快照消息构造
│   ├── write.js                  # 写入纪律、去重合并
│   ├── secret.js                 # 密钥/凭据检测
│   ├── dream.js                  # 门控 + 三轮整理 + 租约
│   ├── migrate.js                # 从 meow 的 memory.db 只读导入
│   └── prompts/{zh,en}.json      # 文案槽位（注入头、工具描述、告警）
├── tools/                        # 可跑的验收脚本（证据来源）
│   ├── load-check.mjs            # 用 fake ctx 加载插件并跑一遍钩子
│   ├── migrate-dryrun.mjs
│   ├── inject-preview.mjs        # 打印某工作区首轮注入块 + 字数
│   ├── recall-eval.mjs           # 10 条真实 query 的召回评测
│   └── rollback.ps1              # 一键回滚（禁 dsh-claude-mem / 恢复 meow）
└── test/                         # node --test
```

插件依赖：仅 `@deepseek-ai/schemastery`（peer，DSH 自带）+ Node 内置 `node:sqlite` / `node:crypto` / `node:fs`。**零第三方运行时依赖，无原生模块。**

扩展点（全部用 DSH 现有 API，已核对）：

| 用途 | API |
|---|---|
| 静态记忆使用说明（恒定文本，缓存友好） | `ctx.systemPrompt.section({name:'dsh-claude-mem:guide', order: ...})` |
| 首轮核心块 / 命中 / 压缩后重注入 | `ctx.on('agent/pre-step', ...)` 在真实 user 消息前插一条 plugin snapshot 消息 |
| 工具注册 | `ctx.tools.register({name, description, parameters, execute})` |
| dream 触发点 | `ctx.on('agent/turn-stopping', ...)` + `agent.followup(msg)` 推三轮 |
| 压缩检测 | `ctx.on('session/event', ...)` 里识别 compaction 事件 |
| 语义精排 / 写入判断（可选） | `ctx.llm.stream(...)` → 本地 qwen27b（127.0.0.1:8080），600–800ms 超时 |
| 设置页 | `ctx.settings.configure({auto:true})` 自动把 Config schema 投影成表单，v1 不写客户端 UI |

---

## 4. 数据模型

### 4.1 两个库

| 库 | 位置 | 放什么 |
|---|---|---|
| 全局库 | `$DSH_HOME/dsh-claude-mem/global.db`（默认 `~/.dsh/dsh-claude-mem/global.db`） | `soul` / `user` / `rules`，以及显式标 `scope=global` 的 fact/lesson |
| 工作区库 | `<workspace>/.dsh-claude-mem/memory.db` | `project` / `fact` / `lesson` / `topic`（及项目专属 rules） |

写入时按 level 路由；两个库同一套 schema，代码只写一份。

### 4.2 表

```sql
entries(
  id TEXT PRIMARY KEY,            -- <毫秒时间戳>-<6位随机>，id 顺序≈创建顺序
  level TEXT NOT NULL,            -- soul|user|rules|project|fact|lesson|topic
  scope TEXT NOT NULL,            -- global|workspace
  project TEXT,                   -- project 层必填；其它层可空
  subcategory TEXT,               -- overview|structure|decisions|quotes|ops|todo
  goal TEXT,                      -- topic 的目标句
  title TEXT NOT NULL,            -- 一行索引就靠它，≤40 字
  body TEXT NOT NULL,             -- 正文，≤400 字（topic ≤300）
  keywords TEXT NOT NULL,         -- 空格分隔 8–13 个
  importance INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',   -- active|stale|archived
  source_session TEXT,
  source_hash TEXT,               -- 迁移幂等键
  created_at INTEGER, updated_at INTEGER, accessed_at INTEGER,
  inject_count INTEGER DEFAULT 0
);
entries_fts USING fts5(title, keywords, body, content='entries',
                       content_rowid=rowid, tokenize='trigram');  -- 中文子串可用（已实测）
injections(session_id, entry_id, kind, at, PRIMARY KEY(session_id, entry_id));
sessions(session_id, workspace, started_at, last_seen_at, injected_chars);
dream_runs(id, started_at, finished_at, sessions_since, rounds, outcome);
quarantine(id, source, raw, reason, at);   -- 迁移时命中密钥的内容，不导入
meta(key PRIMARY KEY, value);              -- schema_version / last_dream_at / throttle
```

保留七层是为了迁移直接映射、也符合你已经在用的心智模型；**变化在注入方式，不在分层**。

### 4.3 索引投影（关键）

每个项目生成一段索引，规则：

1. 只取 `status='active'`，按 `subcategory 优先级 → importance → updated_at` 排序；
2. 每条一行：`[子类] 标题（时间标签）`，**≤60 字**；
3. 最多 12 行，超出显示 `还有 N 条：mem_project(项目名)`；
4. 索引实时生成（不建物化表），保证永远最新。

---

## 5. 注入策略（硬上限，可测）

| 场景 | 内容 | 上限 | 频率 |
|---|---|---|---|
| 静态 | 记忆使用说明（何时记/不记什么/工具） | ≤600 字 | 常量，随 system prompt |
| 会话首轮 | soul + user + rules + 当前项目索引 + 导引 | ≤1600 字 | 每会话 1 次 |
| 每轮命中 | ≤2 条正文（每条 ≤180 字）+ 时间标签 | ≤450 字 | 命中才注入 |
| 压缩后 | 重注入核心块（标记 reinject） | 同首轮 | 检测到压缩事件后 1 次 |

- **去重**：同一条目同一会话只注入一次（`injections` 表）。
- **时间标签**：`刚刚 / N 小时前 / 昨天 / N 天前`，模型不用算日期；**>1 天**才附加「时间点观察，非实时，断言前先验证」。
- **超预算丢弃顺序**：非当前项目 → importance 低 → 更旧 → 已展示过。
- **没有命中就不注入**，不留空块、不加套话。
- 注入形态：`agent/pre-step` 里在真实 user 消息前插一条 `form:'snapshot'` 的插件消息，**不改写用户 prompt**（与 meow 相同的安全姿势）。

预估对现网的效果：qwen38 项目当前注入 2222 字，索引版预计 ≤1200 字（**目标降幅 ≥45%**，M2 实测确认，不达标就调参）。

---

## 6. 召回策略

### Stage 0：规则门（0ms，可关）
- 跳过：子代理会话、消息 <4 字、纯命令/纯确认、本会话命中数已达上限（8）、meow 仍在启用（互斥期）。
- 触发信号（满足任一）：`之前/上次/记不记得/我们说好/为什么/偏好/习惯`；当前项目名或别名；消息里出现记忆条目关键词的高 IDF 词。
- 这一层就是「语义判断」的第一道：**不相关的问题不问记忆**。

### Stage 1：FTS5 粗筛
- `MATCH` 查询（trigram 分词，中文可用），范围 = 全局库 + 当前工作区库，`status='active'`，排除本会话已注入；
- 取 Top 20；排序 = BM25 + importance 加权 + 时间衰减 + 当前项目加成。

### Stage 2：语义精排（可选，默认关）
- 输入：Top 20 的「标题 + 60 字摘要」，输出 JSON `{"ids":[...]}`，≤5 条；
- 规则照官方：**不确定就返回空**、可以一条都不选；
- 模型：本地 qwen27b；600ms 超时；失败/超时 → 直接用 Stage 1 的分数，不重试；
- 有开关 `recall.rerank.enabled`，默认 off——先实测「规则版够不够准」，再决定开不开（符合你「先实测再定默认」的偏好）。

### Stage 3：预算装配
按分数顺序装入 §5 的预算，装不下就丢；0 条则不注入。

---

## 7. 写入与整理

### 工具（5 个，都有中文描述）
`mem_remember` / `mem_search` / `mem_read` / `mem_update` / `mem_project`

### 写入硬规则（写在工具描述里 + 代码校验）
**拒收**：
1. 含密钥/token/密码/私钥/连接串（正则 + 高熵串检测）；
2. 正文 >400 字（提示拆成 topic 或多条）；
3. 缺少 level/project/keywords（8–13 个）。

**软提示（不拒收，但工具返回警告）**：
- 含绝对路径 / 端口 / 版本号 / provider 配置 —— 这类「读文件就能知道」的信息按你定的边界不该进记忆；
- 与已有条目相似度 ≥0.9（同 level+project）→ 自动**合并更新**旧条，返回旧 id，不新增。

**语义判断（可选）**：写入前让本地千问判断「是否值得长期记住 / 是否可由代码查到 / 是否与已有条目重复」，800ms 超时，失败退回规则。默认开，因为写入频率低。

### dream（周期整合）
- 门控：`now - last_dream_at ≥ 24h` **且** 期间会话数 ≥5 **且** 扫描节流 10 分钟；
- 手动：`/mem-dream` 命令随时触发，不受门控限制；
- 执行：`agent/turn-stopping` → 用 `agent.followup()` 推一条整理指令，同一会话内三轮（原子记忆 / topic / 项目总结），每轮结束用租约推进；中断可恢复；
- 整理时先查重、合并、归档过时条目，**不新增重复**。

v1 不做「后台子代理抽取」（DSH 里成本高、不可控），保持主线程可见、可中断。

---

## 8. 安全

- 写入拒收密钥；迁移时命中密钥进 `quarantine` 表，不导入、不注入；
- 注入前对最终文本再扫一遍（防止历史数据里带进来的）；
- 路径白名单：插件只读写 `<workspace>/.dsh-claude-mem/` 与 `$DSH_HOME/dsh-claude-mem/`；
- 全部数据留本机，不联网（除可选的本地千问 rerank，走 127.0.0.1）。

---

## 9. 迁移与回滚

### 迁移（meow → dsh-claude-mem）
```
node tools/migrate.mjs --from "<workspace>/.dsh-meow/memory.db" --dry-run
node tools/migrate.mjs --from ... --apply
```
- **只读**源库（`readonly: true`），不改一个字；
- 按 level 路由到全局库/工作区库；`source_hash` 去重，可重复执行；
- 输出报告：每层导入 N 条、合并 M 条、隔离 K 条、耗时；
- 先 dry-run 给你看报告，确认后才 apply。

### 回滚（任何时候 5 分钟内可回）
1. 改配置前先备份 `cordis.patch.yml`（带时间戳），并把备份路径发你；
2. 一键脚本 `tools/rollback.ps1`：`dsh-claude-mem` 置 `disabled: true` + 把 `meow-memory` 恢复 `disabled: false`；
3. 两份数据目录互不影响，回滚不删数据；
4. 回滚后用桌面的「DSH 安全启动」验证，并检查插件行状态。

---

## 10. 里程碑与验收证据

| 阶段 | 内容 | 预估 | 可验收证据 |
|---|---|---|---|
| M0 | 骨架：Config、db、fake-ctx 加载 | 0.5d | `node --test` 全绿；`tools/load-check.mjs` 输出 apply 成功、钩子可挂、0 异常 |
| M1 | 存储层 + 迁移 | 1d | `migrate --dry-run` 报告：与源库条数一致、密钥隔离数正确；二次 apply 不产生重复 |
| M2 | 注入层（索引 + 预算 + 时间标签） | 1d | `inject-preview` 打印首轮块；对比 meow 现网同项目字数，**降幅 ≥45%**；超限丢弃测试通过 |
| M3 | 召回层（规则版） | 1d | `recall-eval` 在 10 条真实 query 上的命中/误报表；无命中时确认「零注入」 |
| M4 | 写入层（纪律/去重/密钥） | 1d | 密钥 5/5 拒收、0 误伤；重复写入合并为 1 条；超长拒收 |
| M5 | dream + 压缩重注入 | 1.5d | 假时钟测试：24h 内多次空闲只触发 1 次；压缩模拟后下一轮出现重注入 |
| M6 | 打包 / 并存开关 / 回滚演练 | 1d | `install_bundle` 后默认 disabled；互斥检测日志；`rollback.ps1` 演练成功 |

每个 M 结束时给你：**跑的命令 + 原始输出 + 我的判断**，不写「做完了」。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 插件异常导致 DSH 起不来 | 所有钩子 try/catch + fail-open；Config 校验宽松；加载期不 throw；先 disabled 安装 |
| 注入破坏缓存 | 核心块每会话只插一次且位置固定；命中块小（≤450 字） |
| 本地千问没启动 | 60s 健康检查缓存；不可用则永久回退规则版（本次进程） |
| 与 meow 双重注入 | 检测到 meow 启用 → dsh-claude-mem 不注入、不报错，日志+首轮提示一次 |
| 索引行太短导致模型看不懂 | 索引给「是什么」，正文给「细节」；工具描述里明确「先看索引，需要细节再 mem_read」 |
| 迁移把库写坏 | 只读源库；新库独立；dry-run 先行 |

---

## 12. 需要你拍板的三件事

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| A | 数据分层 | ① 全局库 + 工作区库（两层） ② 沿用 meow 的每工作区单库 | **①**：用户偏好只有一份，不会每个项目各漂各的 |
| B | 语义精排 | ① v1 规则版，精排默认关、实测后再定 ② 直接接本地千问 | **①**：先拿数据说话，避免每条消息多 1 秒延迟 |
| C | 启用方式 | ① 装完默认 disabled，你看过 dry-run 再开 ② 装完直接替换 meow | **①**：现网敏感，先影子运行 |

另外两个小点，你可以顺带定：
- 包名用 `dsh-claude-mem`（工作名），数据目录 `.dsh-claude-mem/`，有没有偏好？
- 全局库默认放 `~/.dsh/dsh-claude-mem/global.db`，要不要挪到 D 盘之类的非 C 盘位置（你之前提过 C 盘紧）？

---

## 13. 拍板记录（2026-10-28 18:20，用户已确认）

| # | 决策 | 结论 |
|---|---|---|
| A | 数据分层 | **① 全局库 + 工作区库两层** |
| B | 语义精排 | **① v1 规则版，精排默认关**，实测后再定 |
| C | 启用方式 | **① 装完默认 disabled**，dry-run 验收后再开 |
| 包名 | — | **dsh-claude-mem**（注意是 claude，不是 cluade） |
| 数据目录 | — | `.dsh-claude-mem/` |
| 全局库位置 | — | **不要放 C 盘**，放 D 盘（如 `D:\dsh-claude-mem\global.db`），C 盘紧 |

开发目录已从 `C:\Users\User\dsh-mem` 改名为 `C:\Users\User\dsh-claude-mem`。

*本文件是方案，不是实现。确认后我才开始写代码；代码全部在 `C:\Users\User\dsh-claude-mem` 内，不碰 profile。*
