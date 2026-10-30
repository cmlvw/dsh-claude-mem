# dsh-claude-mem · M6 交付文档（互斥开关 / 打包 / 迁移与回滚 / 真实演练）

本文件是 M6 卡的交付说明：做了什么、怎么验证、证据在哪、边界在哪。
逐条验收的命令与原始输出都在下面，且都可以一条命令复跑。

---

## 1. 交付清单

| # | 交付物 | 位置 | 验收标准 |
|---|---|---|---|
| 1 | 与 meow 阵营的互斥检测 | `src/mutex.js` + `src/index.js` | 检测到同时启用 → 记日志 + **拒绝装配** |
| 2 | 打包（install_bundle 可加载、默认 disabled） | `package.json` + `cordis.patch.yml` | install 后默认 `disabled: true` |
| 3 | 一键迁移 | `tools/migrate.mjs`（M1 已有，本卡验通） | dry-run 报告 → `--apply` |
| 4 | 一键回滚 | `tools/rollback.ps1` + `tools/_rollback-verify.mjs` | 真跑通，且自带静态校验 |
| 5 | 真实回滚演练 | `tools/rehearsal/run-rehearsal.mjs` | 装→生效→回滚→meow 接管，往返闭合 |
| 6 | 默认关的证据生成器 | `tools/check-default-disabled.mjs` | 三条独立断言 |

---

## 2. 互斥开关（验收 1）

### 2.1 判定语义（本卡与用户确认）

- **阵营**：`meow-memory`（上游）与 `dsh-meow-mem`（fork，内部 `PLUGIN_NAME` 仍是 `meow-memory`）**都算**。
  用户拍板：**两者任一启用即冲突** —— 漏检 fork 等于允许双重注入。
- **判据来源**：`ctx.loader.entries()` 的实时行状态（`options.id` / `options.name` / `disabled`），
  不读 profile YAML。好处：plugin-manager 热启停立刻反映；跨 profile 挂载也正确。
  （姿势对齐现网插件 `dsh-better-sidebar/lib/index.js` 的 `ownEntryId()`。）
- **拒绝的时机**：`apply()` 里**建库之前**。拒绝时不建库、不挂钩子、不注册工具、不挂手册——
  不留任何副作用。
- **降级**：反射拿不到 loader（fake ctx / 老内核）→ **不阻断**，只记 `reflected=false` + warning。
  互斥是防重复注入的安全网，不是加载的硬前置。

### 2.2 运行期守卫

加载之后用户仍可能在 plugin-manager 里热启 meow。pre-step 每轮都判（默认 `ttlMs=0`，
因为 `loader.entries()` 只是遍历内存里的几十个行对象，而「热启用后 30 秒仍双重注入」不可接受）；
命中冲突当轮**不注入**，日志按 10 分钟 cooldown 节流。

### 2.3 可取证：审计落盘

headless profile 的 `ctx.logger` 是 **no-op**，只记 logger 等于没有凭证。
所以互斥事件额外写 `audit.jsonl`（JSONL，一行一条），落点是 **`globalDbPath` 所在目录**：

- 真机默认：`D:\dsh-claude-mem\audit.jsonl`
- 测试/演练：给临时库路径 → 审计天然隔离，**不会往用户真实 `~/.dsh` 写测试残留**
  （这条是踩过坑后改的，见 §5 坑 3）。

事件类型：`mutex.refused` / `mutex.runtime_refused` / `mutex.passed` / `mutex.unavailable`
——能区分「拒绝了」「运行期拒绝了」「通过」「没检测」四种情况。

### 2.4 命令与原始输出

```powershell
# 单测：互斥判定 + apply 集成 + 审计落盘
node --test test/mutex.test.mjs test/mutex-apply.test.mjs test/mutex-audit.test.mjs
```
```
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

真机互斥证据（两家同时启用，`server/...` 见演练第 6 步）：

```json
{"at":"2026-10-28T17:11:39.023Z","plugin":"dsh-claude-mem","event":"mutex.refused","reason":"检测到同时启用：meow-memory(meow-memory)","rivals":[{"id":"meow-memory","pkg":"meow-memory"}],"self":[{"id":"dsh-claude-mem","enabled":true}]}
```

同一次请求里模型收到的是：

```
[1] ===== 长期记忆 ===== 【关于user】 - MEOW-MARKER-ROUNDTRIP：...
[2] both enabled
```

即：**只有 meow 注入，我们的注入块和手册都没有出现**（手册没进 system prompt 也要断言，
因为「拒绝装配」必须连 system prompt section 一起不挂）。

---

## 3. 打包与默认 disabled（验收 2）

`cordis.patch.yml`（随包发布）自带：

```yaml
- insert:
    - id: dsh-claude-mem
      name: 'dsh-claude-mem'
      disabled: true
```

`package.json` 里 `dsh.bundle.patch` 指向它，`files` 也带上它。

### 命令与原始输出

```powershell
$env:DSH_HOME = "C:\Users\User\dsh-claude-mem\.rehearsal\dsh-home"
node tools/check-default-disabled.mjs --profile-dir ".rehearsal\dsh-home\profiles\headless"
```
```
PASS  包自带的 cordis.patch.yml 里 disabled: true
PASS  用户 profile 层没有手写我们的 disabled（默认关来自 bundle，不是手写的）
PASS  真机 --dump-config 合成后是 disabled: true

3/3 通过
```

三条断言的设计意图：只证明「dump 里是 true」不够，还要证明**不是谁手写上去的**，
否则等于把「默认关」这件事交给人工纪律。第 2 条断言抓到过一次真实问题（§5 坑 4）。

真机 dump 片段：

```
# == dsh-claude-mem
- id: dsh-claude-mem
  name: dsh-claude-mem
  disabled: true
```

---

## 4. 迁移与回滚（验收 3、4）

### 4.1 迁移（只读源库）

```powershell
node tools/migrate.mjs --from "C:\Users\User\.dsh\profiles\desktop\.dsh-meow\memory.db" `
  --global ".rehearsal\migrate-real\global.db" --workspace ".rehearsal\migrate-real\ws"
```
```
source : C:\Users\User\.dsh\profiles\desktop\.dsh-meow\memory.db
mode   : DRY-RUN（不写库）

level      rows  import  dup  quarantine
user         10      10    0           0
project      65      65    0           0
fact         22      22    0           0
lesson       57      57    0           0
topic        13      13    0           0
rules         5       5    0           0
合计          172     172    0           0
```

真库 172 条全部识别、零隔离、源库只读。确认报告后才加 `--apply`。

### 4.2 回滚脚本

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\rollback.ps1 -ProfileDir <profile目录>
```

行为约定（**都按用户要求**）：

1. **改之前先备份** → `cordis.patch.yml.bak-rollback-<时间戳>`，并把备份路径 + 恢复命令打印出来；
2. **默认不重启 DSH**（重启是用户的动作），要重启显式加 `-Restart`；
3. **幂等**：用 `# >>> dsh-claude-mem rollback (managed) >>>` 显式块包住，重跑整块替换，不会越加越长；
4. **自校验**：写完调用 `tools/_rollback-verify.mjs` 按 YAML 行结构解析最终 disabled 状态，
   不对就非零退出并提示备份仍在；
5. `-Patch <占位>` 走 dry-run：只打印应追加的补丁，不碰任何文件。

### 4.3 为什么这个脚本"能真跑"而不是"留了个位"

被真实执行过 **4 次以上**，并且每次真机 `--dump-config` 都能正常合成（演练第 3 步断言）。
两次真实失败都在这里被逼出来并修掉（§5 坑 1、坑 2）——这就是"逐字节确认可用"的含义：
不是看代码觉得对，而是**启动真 DSH 让它读这个文件**。

---

## 5. 真实回滚演练（验收 3 的核心）

### 5.1 为什么在隔离 profile 上做

`dsh --profile desktop` 会被直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

即 desktop 归 Electron 独占，CLI 无法 boot 它。所以演练用**独立 DSH_HOME + 独立 profile +
真实 DSH 进程**：`~/.dsh` 一个字没改，桌面 profile 的 `cordis.patch.yml` 全程只读。

模型侧接的是本地 mock（`tools/rehearsal/mock-llm.mjs`），因为：
本机 127.0.0.1:8080 的千问当时没在跑，且真模型输出有随机性；
mock 把每次请求的 `messages` 原样写进 JSONL，**注入块可以逐字断言**——这比"有个模型回了话"硬得多。

### 5.2 演练链（六步，全部真机）

```powershell
node tools/rehearsal/run-rehearsal.mjs
```
```
=== 0. 环境：隔离 DSH_HOME + mock 模型 ===
PASS  mock 模型可访问  ← port=18777
=== 0b. 种子：工作区库 + 全局库 + meow 库 ===
PASS  种子写入（工作区 + 全局）
=== 1. install 后默认 disabled（R3 锁后交付） ===
PASS  安装后 dsh-claude-mem 行存在
PASS  安装后 dsh-claude-mem 是 disabled: true  ← disabled=true
PASS  同一 dump 里 meow-memory 行存在  ← found=true
=== 2. 启用本插件 → 真机 boot → 断言注入 ===
PASS  boot 成功（exit 0）  ← code=0
PASS  boot 无 "did not activate" 警告
PASS  模型收到了请求
  [1] 【长期记忆 · 2026-10-29】 [准则·sl5t2x] REHEARSAL-MARKER-GLOBAL：全局层注入链路证明。 ...
  [2] 我们之前说好的备份规则是什么
PASS  出现本插件的【长期记忆】块  ← 块数=1
PASS  块里含 REHEARSAL-MARKER（种子真的进了注入）
PASS  没有 meow 的长期记忆块（互斥期）
PASS  注入块排在真实用户消息之前  ← own=1, user=2
=== 3. 跑 tools/rollback.ps1（真实执行，不是 dry-run） ===
==> 已备份：...cordis.patch.yml.bak-rollback-20261029-010918
PASS  回滚状态正确：meow-memory=on, dsh-claude-mem=off
PASS  回滚脚本 exit 0  ← code=0
PASS  脚本打印了备份路径
PASS  脚本自带校验 PASS
PASS  回滚后 YAML 不再有孤立 []（否则解析失败）
PASS  dump-config 还能正常合成（回滚没写坏 profile）  ← code=0
=== 4. 回滚后真机 boot → 断言 meow 接管 ===
  [1] ===== 长期记忆 ===== 【关于user】 - MEOW-MARKER-ROUNDTRIP：这条是 meow-memory 写的...
  [2] 我们之前说好的备份规则是什么
PASS  回滚后 boot 成功  ← code=0
PASS  出现 meow 的长期记忆块
PASS  meow 块里含 MEOW-MARKER（meow 真的在工作）
PASS  没有本插件的【长期记忆】块
=== 5. 再次启用本插件 → 断言切回来（往返闭合） ===
PASS  再次启用 boot 成功  ← code=0
PASS  切回后本插件注入恢复
PASS  切回后没有 meow 块
=== 6. 两家同时启用 → 断言互斥拒绝 + 审计落盘 ===
PASS  同时启用时 boot 不崩  ← code=0
PASS  互斥：没有本插件的注入块
PASS  互斥：本插件手册也没进 system prompt
PASS  互斥：meow 仍正常注入
PASS  审计里有 mutex.refused（可事后取证）  ← 条数=1
PASS  审计记了对手包名

ALL PASS（报告：C:\Users\User\dsh-claude-mem\.rehearsal\report）
```

关键点：第 4 步 **meow 是真的在干活**（`MEOW-MARKER-ROUNDTRIP` 被注入），
不是"它没报错所以算恢复"——后者是假完成。第 5 步保证这是**往返**而不是单向降级。

原始记录留档：`.rehearsal/report/summary.json`、`.rehearsal/report/transcript.md`、
`.rehearsal/mock.jsonl`（每次请求的完整 messages）。

---

## 6. 测试与复跑入口

```powershell
node --test                          # 全套
node tools/rehearsal/run-rehearsal.mjs  # 回滚演练（隔离环境，可反复跑）
node tools/check-default-disabled.mjs --profile-dir <profile>  # 默认关证据
```

| 命令 | 结果 |
|---|---|
| `node --test` | **164 passed / 0 failed** |
| `node tools/rehearsal/run-rehearsal.mjs` | **ALL PASS（26 项断言）** |
| `node tools/check-default-disabled.mjs` | **3/3** |
| `node tools/e2e-tools.mjs`（回归） | **24/24** |
| `node tools/live-check.mjs`（真库只读，回归） | **8/8** |
| `node tools/load-check.mjs`（回归） | **22/22** |

演练与默认关检查都**可重复跑**：收尾自动释放 mock 端口、还原 profile patch 层，
连跑两次结果一致（实测）。

---

## 7. 边界与未做的事

- **没改 `C:\Users\User\.dsh\` 下任何文件**，没重启 DSH，没动 `F:\models`。
  演练全部在 `C:\Users\User\dsh-claude-mem\.rehearsal\` 下。
- **没有接进现网 desktop**。要接需改 desktop 的 `cordis.patch.yml` + 重启 DSH，
  属「改变用户环境状态」，必须先问用户、先发回滚文件地址、先补改前备份。
- `rollback.ps1 -Profile desktop -Restart` 这条路径**没有真跑过**（会重启用户正在用的桌面）。
  脚本的备份/写入/校验逻辑已被隔离演练验证，重启段是照已有做法写的，未实测。
- 演练用的是上游 `meow-memory` 作为回滚目标；现网实际跑的是 fork `dsh-meow-mem`。
  回滚脚本**已支持**（`-MeowBundle dsh-meow-mem`，或按 profile `package.json` 自动探测）。
- 互斥**不阻断**加载（反射失败时 fail-open），这是设计选择，不是遗漏。

---

## 8. 下一步（编号，按顺序）

1. **接现网前先问用户**：改 `C:\Users\User\.dsh\profiles\desktop\cordis.patch.yml`
   （把 `dsh-meow-mem` 置 `disabled: true`、插入 `dsh-claude-mem` 且 `disabled: false`），
   并把 `tools/rollback.ps1` 的备份输出先发给用户。
2. **真机接现网前补备份**：`desktop/cordis.patch.yml` + `.dsh-meow/memory.db` 各一份。
3. 接现网后跑一次 `node tools/migrate.mjs --from <desktop/.dsh-meow/memory.db> --apply`，
   把 meow 的数据迁到新库（先 dry-run 给用户看报告）。
4. `dream.mode` 仍 `observe`，观察后由用户拍板切 `push`。
5. `recall.rerank` 仍默认关；`en.json` 工具文案仍缺（M4 遗留）。
6. 首轮未识别项目时是否仍注入「最近项目」——用户未拍板，不改。
