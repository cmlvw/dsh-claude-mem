# HANDOVER · dsh-claude-mem M6（2026-10-29 01:1x）

## 当前状态

- 目录：`C:\Users\User\dsh-claude-mem`。**现网仍是 meow 阵营**（desktop profile 里
  `meow-memory` 已 disabled、跑的是 fork `dsh-meow-mem`），**未改 profile、未重启 DSH、未动 F:\models**。
- M0–M5 已完成；本次完成 **M6：互斥开关 / 打包默认 disabled / 一键迁移与回滚 / 真实回滚演练 / 交付文档**。
- 交付说明见 `DELIVERY-M6.md`（命令 + 原始输出 + 边界）。

## 本次新增

| 文件 | 作用 |
|---|---|
| `src/mutex.js` | 互斥判定（`checkMutex` / `createMutexGuard` / `findEnabledMeow`） |
| `src/index.js` | 接入互斥（建库前拒绝装配）+ 运行期守卫 + `appendAudit` 审计落盘 |
| `src/config.js` | 新增 `dataDir`（跟随 `globalDbPath` 目录，测试天然隔离） |
| `cordis.patch.yml` | 已有 `disabled: true`（本次验通，未改） |
| `tools/rollback.ps1` | 一键回滚（备份→写入→自校验→可选重启） |
| `tools/_rollback-verify.mjs` | 回滚静态校验（按 YAML 行结构解析最终 disabled） |
| `tools/check-default-disabled.mjs` | 「默认关」三条独立证据 |
| `tools/rehearsal/*` | 演练基础设施（mock 模型 / 种子 / 六步演练脚本） |
| `test/mutex*.test.mjs` | 互斥判定、apply 集成、审计落盘 |

## 验收证据（可复跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 全套单测 | `node --test` | **164 passed / 0 failed**（原 138 + 新增 26） |
| 回滚演练 | `node tools/rehearsal/run-rehearsal.mjs` | **ALL PASS，26 项断言** |
| 默认 disabled | `node tools/check-default-disabled.mjs --profile-dir <profile>` | **3/3** |
| 加载验收 | `node tools/load-check.mjs` | 未回归 |
| 迁移 dry-run（真库） | `node tools/migrate.mjs --from <desktop/.dsh-meow/memory.db> ...` | 172 条全部识别，0 隔离 |

演练报告在 `.rehearsal/report/`（`summary.json` / `transcript.md`），
模型侧原始请求在 `.rehearsal/mock.jsonl`。

## 实现要点（接手别重造）

- **互斥判据是 `ctx.loader.entries()`**，不是读 profile YAML：热启停立刻反映、跨 profile 正确。
  姿势对齐 `dsh-better-sidebar/lib/index.js` 的 `ownEntryId()`。
- **阵营包含 fork**：`meow-memory` 与 `dsh-meow-mem` 任一启用即冲突（用户拍板）。
  fork 内部 `PLUGIN_NAME` 仍是 `meow-memory`，靠包名判定即可。
- **拒绝发生在建库之前**：不建库、不挂钩子、不注册工具、不挂手册——零副作用。
- **运行期守卫默认 `ttlMs=0`**（每轮都反射）：遍历几十个内存行对象成本可忽略，
  而「热启用后 30 秒仍在双重注入」不可接受。
- **审计落点跟随 `globalDbPath` 目录**（`dataDir`），不是硬编码 `$DSH_HOME`：
  测试给临时库路径 → 审计天然隔离，不会污染用户真实目录。
- **`apply()` 在真机必须返回 undefined**：cordis 把返回值当 effect，
  返回 status 对象会 `TypeError: Invalid effect` → 整条插件 `did not activate`。
  所以拆成 `applyPlugin()`（返回 status 给测试）+ `apply()`（真机返回 undefined）。
- **演练必须用隔离 profile**：`dsh --profile desktop` 被 Electron 独占，
  CLI 直接报 `managed exclusively by the Electron application`。

## 踩到的坑（重要）

1. **`apply()` 返回值不是自由字段**：真机 cordis 把 apply 的返回值当 effect
   （`cordis/lib/index.js:1139-1167` 只接受函数/null/Promise/可迭代）。
   返回 status 对象 → `TypeError: Invalid effect` → `1 entry did not activate`。
   **fake ctx 测试全绿也发现不了**，只有真机 boot 才暴露。meow 的做法也是不返回值。
2. **回滚脚本往空数组后面追加 = 写坏 YAML**：profile 的 patch 层是「注释 + `[]`」，
   直接追加 `- id:` 会被解析器拒（`end of the stream or a document separator is expected`）。
   必须先删掉孤立的 `[]` 行。**这是真机 boot 才发现的**。
3. **审计写到真实 `~/.dsh` 造成测试污染**：最初 `appendAudit` 用 `$DSH_HOME`，
   5 个测试文件都调 apply → 真实目录被写进 31 行测试残留。
   改成跟随 `globalDbPath` 目录（`dataDir`）后天然隔离。已把残留备份到
   `.rehearsal/polluted-audit-backup.jsonl` 并清空真实文件。
4. **「默认 disabled」的断言不能只看结果**：`check-default-disabled.mjs` 第 2 条
   （profile 用户层没有手写我们的 disabled）真抓到过一次——上一轮回滚脚本写进的管理块
   让「默认关来自 bundle」这条证据失效。演练脚本因此每次先重置 profile patch。
5. **PS 5.1 读无 BOM 的 UTF-8 会乱码**：`rollback.ps1` 存成 UTF-8 **带 BOM**，
   否则中文被按 GBK 解 → 语法错误。用 edit 工具改完必须补 BOM。
   另外本机没有 `pwsh`，只有 `powershell`，脚本要 5.1 兼容。
6. **`dsh.cmd` 不能用 `spawnSync` 直跑**：Windows 上 .cmd 不是可执行二进制，
   要 `shell: true`，否则拿到 `code=null`（进程根本没起来）。
7. **headless 的 `ctx.logger` 是 no-op**：`--json` 也只给运行事件、不含插件日志。
   所以互斥必须有独立落盘（`audit.jsonl`），否则「记日志」这条验收无法取证。
8. **`spawn('node', ...)` 的 kill 杀不掉监听进程**：Windows 上会先起包装进程，
   `mock.kill()` 只杀掉包装，端口一直被占（实测 18777 反复残留）。
   改成 `detached:true` + `taskkill /T /F` 整组杀 + 按端口兜底清理。
   **注意顺序**：先 `freePort()` 清残留、**再** spawn —— 反过来会把自己刚起的服务杀掉
   （这个顺序错误当场造成 7 个 FAIL）。
9. **演练脚本收尾必须还原 profile**：跑完留在「回滚态」会让下一次
   `check-default-disabled.mjs` 在「用户层手写了 disabled」那条上失败，
   看起来像证据链坏了，其实只是上一轮没收拾。收尾已自动清回空白用户层。

## 下一步（按顺序）

1. **问用户是否接现网**（属「改变用户环境状态」）：改 desktop 的 `cordis.patch.yml`
   （`dsh-meow-mem` 置 `disabled: true`，插入 `dsh-claude-mem` 且 `disabled: false`）。
   **先发备份文件地址、先补改前备份，再动手。**
2. 备份 `C:\Users\User\.dsh\profiles\desktop\cordis.patch.yml` 与
   `C:\Users\User\.dsh\profiles\desktop\.dsh-meow\memory.db`，把路径发给用户。
3. 接现网后迁移数据：先 `node tools/migrate.mjs --from ...`（dry-run）给用户看报告，
   确认后才 `--apply`。
4. `rollback.ps1 -Profile desktop -Restart` 这条**未真跑过**（会重启用户桌面），
   接现网前若要用，先在用户同意的时间窗做一次。
5. `dream.mode` 仍 `observe`，观察期后由用户拍板切 `push`。
6. `recall.rerank` 仍默认关；`en.json` 工具文案仍缺（M4 遗留）。
7. 首轮未识别项目时是否仍注入「最近项目」——用户未拍板，不改代码。

## 不要做

- 不改 `C:\Users\User\.dsh\profiles\desktop\cordis.patch.yml`，不重启 DSH（本卡边界）。
- 不动 `F:\models`。
- 不把 `dream.mode` 默认值改成 `push`（默认值改动等于替用户拍板）。
- 不把互斥做成「硬阻断加载」：反射失败时必须 fail-open（互斥是安全网，不是前置）。
