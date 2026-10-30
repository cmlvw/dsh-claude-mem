# dsh-claude-mem 修复方案

> 依据：《dsh claude mem 修改建议与验收报告》（2026-10-30）
> 制定：2026-10-30
> 原则：**先补测试，再改实现**；每批可独立验收；**未获你同意前不动 profile、不接现网**

---

## 〇、我独立复验的结论

对方报告里的 8 个问题，我逐条对着源码验证了一遍，**全部属实**，没有夸大也没有误报：

| # | 问题 | 我的验证方式 | 结果 |
|---|---|---|---|
| 1 | 全局层写入没进全局库 | `grep rememberInto(workspaceDb src/tools.js` → 第 509 行硬编码 | ✅ 属实 |
| 2 | 注入前不扫敏感信息 | `grep scanSecrets src/inject.js` → 零结果 | ✅ 属实 |
| 3 | mem_update 可绕过密钥扫描 | title/keywords 分支无 scanSecrets 调用 | ✅ 属实 |
| 4 | 关键词 13 上限未执行 | 只有 `< range.min` 检查，无 `> range.max` | ✅ 属实 |
| 5 | source_hash 被普通更新覆盖 | `store.js:174` 无条件重算 | ✅ 属实 |
| 6 | 迁移无事务 | `grep BEGIN/COMMIT src/migrate.js` → 零结果 | ✅ 属实 |
| 7 | source_session 未真正写入 | `rememberInto` 签名无 sessionId 参数 | ✅ 属实 |
| 8 | 英文文案缺失 | `en.json` 只有 4 个字段，无 `tools` | ✅ 属实 |

**一个补充发现**（报告里点到但我核实得更具体）：

问题 1 的链条比报告说的更清晰——
- `src/config.js:188` 定义了 `isGlobalLevel`，挂在 `resolveConfig` 返回对象上
- `src/index.js:641` 调用 `registerTools(service, deps, deps.prompts)`，**第三个参数是 prompts，不是 config**
- `src/tools.js:150` 读 `cfg?.isGlobalLevel?.(level)`，**这个 cfg 实际取不到该方法**
- 所以不管传什么 level，`scope` 永远是 `undefined`，然后第 509 行固定写 workspaceDb

**这不是"配置没生效"，是参数根本没传进去。**

---

## 一、总体策略

### 为什么不能一次改完

8 个问题分属三个层面：
- **安全问题**（2、3）——会导致密钥泄露到上下文，最高优先级
- **数据归属问题**（1）——会让用户偏好按工作区漂移
- **一致性问题**（4、5、7）——数据完整性，不立即致命但会累积错误
- **可靠性问题**（6）——迁移失败可能留半完成状态
- **交付完整性问题**（8）——不影响功能

按报告的批次划分是对的，我沿用，但**调整了批次内的顺序**：先写测试（红），再改代码（绿），最后回归。

### 每批的统一流程

```
1. 写复现测试 → 必须红
2. 改实现 → 测试转绿
3. 跑全量 164 个测试 → 必须仍全绿
4. 跑端到端 + 真机演练 → 无回归
5. 出证据（命令 + 原始输出）
6. 你验收
```

---

## 二、批次一：安全与分层（阻断项）

**目标：清掉两个阻断项 + 一个绕过路径。**

### 1.1 修复全局库路由

**改法**：

```js
// src/index.js —— registerTools 传入路由能力
const registered = registerTools(service, {
  ...deps,
  config: resolved.config,
  isGlobalLevel: resolved.isGlobalLevel,   // ← 显式传入
}, deps.prompts)
```

```js
// src/tools.js —— 按条目选库，不固定 workspaceDb
const targetDb = cfg?.isGlobalLevel?.(args.level, args.scope) ? globalDb : workspaceDb
if (targetDb === null || targetDb === undefined) {
  return { ok: false, error: '目标库不可用，拒绝降级写入工作区' }   // 禁止静默降级
}
const result = rememberInto(targetDb, args, cfg)
```

**测试**：
- `level=user` → 断言 `global.db` 有该条、`workspace.db` 无
- `level=project` → 断言只在 `workspace.db`
- `level=rules`、`level=soul` → 同 user
- 全局库置 null → 断言返回明确 error，**不写 workspace**
- 模拟下一会话首轮 → 断言核心块里能看到刚写的 user 条目

**验收标准**：`global.db` 与 `workspace.db` 各自的条数与你用 `memory_project` 查到的归属一致；核心块可见。

### 1.2 注入前统一安全出口

**改法**：在 `src/inject.js` 增加唯一出口，三条注入路径全部过它：

```js
function safeRender(entries) {
  return entries.filter(e => {
    const hit = scanSecrets(`${e.title}\n${e.body}`)
    return !hit.hit      // 命中就整条不注入，不做替换后继续
  })
}
```

接入点：
- `collectCore`（核心块，第 128 行附近）
- `renderHitBlock`（命中块，第 152 行附近）
- 压缩重注入（`buildReinjection`）

**关键决策：命中即整条跳过，不做打码继续。** 报告建议的也是这个。理由：打码后的残留仍是信息泄露，且用户无法判断内容完整性。

**测试**：
- 直接往临时库写含 `api_key` / 私钥块 / `password=xxx` 的条目
- 断言首轮核心块、命中块、重注入三条路径**都不出现秘文**
- 断言干净条目正常注入（不误伤）

### 1.3 mem_update 全字段扫描

**改法**：把更新后的 title + body + keywords 合并成候选条目，统一扫描：

```js
// 不论本次改了哪个字段，都对"更新后的完整条目"扫描一次
const candidate = { title: newTitle, body: newBody, keywords: newKeywords }
const hit = scanSecrets(`${candidate.title}\n${candidate.body}\n${candidate.keywords.join(' ')}`)
if (hit.hit) return { ok: false, error: '内容疑似含密钥/凭据，已拒收' }
```

**测试**：仅改 title 含密钥 → 拒收；仅改 keywords 含密钥 → 拒收；仅改 content → 拒收（原有行为保持）

### 1.4 历史库清理工具

**改法**：新增 `tools/scan-quarantine.mjs`，一次性扫描已有数据，命中条目移到 `quarantine` 表。

**注意**：这是**破坏性操作**，我会：
- 先 `--dry-run` 出报告，你看过再执行
- 执行前备份数据库
- 报告逐条列出将被隔离的条目（不含秘文，只列 id + 命中规则名）

---

## 三、批次二：约束一致性

### 2.1 关键词上限

```js
if (keywords.length > range.max) {
  return { ok: false, error: `keywords 太多：${keywords.length} 个，最多 ${range.max} 个` }
}
```
- 先去重再计数（避免重复词占额度）
- 参数 schema 加 `minItems: 8, maxItems: 13`
- 测试：7 / 8 / 13 / 14 个关键词四个边界

### 2.2 source_hash 与内容 hash 分离

**改法**：
- 新增 `origin_hash` 字段存迁移来源键，**永不被普通更新覆盖**
- `current_content_hash` 记录当前内容（用于去重）
- 兼容：已有非空 `source_hash` 的条目保持原值

**测试**：迁移一条 → 改它的 title → 再次迁移 → 断言 `imported=0`

### 2.3 source_session 真正写入

**改法**：`rememberInto` 增加显式 `sessionId` 参数，首次写入时直接写；删掉那个空 patch 更新。

**测试**：写入后回读，断言 `source_session` 等于当前 session id

---

## 四、批次三：迁移可靠性

### 3.1 显式事务

```js
db.exec('BEGIN')
try {
  // 逐条写入
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  throw e
}
```

对**每个目标库**分别加事务（全局库和工作区库各自独立）。

**不做**：跨两库的强原子提交。报告的判断我认同——当前阶段不需要 ATTACH 那套复杂度。

### 3.2 失败报告

报告里写明：每个目标库的提交状态（committed / rolled-back）、失败在第几条、原错误信息。

**测试**：
- 模拟中途失败（注入一个会抛错的条目）
- 断言：已提交的库数据完整、回滚的库无残留
- 再次运行 → 断言可恢复（幂等）

---

## 五、批次四：交付完整性

### 4.1 英文文案

补齐 `src/prompts/en.json` 的 `tools` 字段（五个工具的 description + 参数说明）。

**测试**：`promptLang=en` 时注册的工具描述不含中文。

---

## 六、批次五：重新验收

改完后跑全套：

| 项 | 命令 | 期望 |
|---|---|---|
| 单测 | `node --test` | 164 + 新增，全绿 |
| 加载检查 | `node tools/load-check.mjs` | 22/22 |
| 工具端到端 | `node tools/e2e-tools.mjs` | 24/24 |
| 真机回滚演练 | 隔离 DSH_HOME | 全步骤 PASS |
| 真实库只读检查 | 新增脚本 | 无秘文、无法归属错乱 |
| 注入预览 | `node tools/inject-preview.mjs` | 核心块无秘文 |

**全部通过 + 8 个阻断清零**，才谈接现网。

---

## 七、风险与回滚

| 风险 | 应对 |
|---|---|
| 改路由后旧数据归属混乱 | 迁移前先 dry-run 出报告，你确认后再动 |
| 注入前扫描误伤正常条目 | 用真实库跑一遍 preview，逐条核对被跳过的条目 |
| 事务改动影响迁移性能 | 129 条量级可忽略，实测耗时 |
| 改坏现有 164 个测试 | 每批改完立刻跑全量，红就回退 |

**回滚**：每批改动前 `git init` 或整目录备份到 `dsh-claude-mem.bak-<时间戳>`。

> 现在没有 git，我建议**先 `git init`**，否则改错了没法精确回退。

---

## 八、我的建议

**先做批次一**（三个阻断项），这是接入现网的硬门槛。

需要你确认三件事：

1. **是否先 `git init`**（我强烈建议，否则改动无版本可回退）
2. **批次一做完就验收**，还是连着做批次二
3. **历史库清理**要不要做（这是破坏性操作，涉及现有 129 条数据）

确认后我开工。**在你点头前，我不动 profile、不接现网。**
