/**
 * devmem 金标：题型沿用 LongMemEval 的七类，tags 标注每题的额外难点。
 *
 * keys：答案串，外层是「都要有」，内层是「任一写法」。答案要靠推算的题，这里放推算所需的原料。
 * stale：过时或时间段不对的值。进了上下文而正确答案没进，就算读到旧值。
 * absent：拒答题的答案词，不得出现在任何会话里。
 */
const fact = (name, sessions, description, extra = {}) => ({
  name,
  type: 'project',
  label: 'durable',
  evidence_sessions: sessions,
  description,
  ...extra,
})
/** 已过时的旧版本，只写入记忆库，不作为任何题的答案。 */
const old = (name, session, description) => fact(name, [session], description, { label: 'superseded' })
/** 被后续会话推翻的事实，只认 from 那一次。 */
const updated = (name, sessions, from, description) => fact(name, sessions, description, { label: 'updated', answer_from: from })

export const FACTS = [
  fact('settle-cron', ['s05'], 'tidepool 日结算每天 03:17 启动，错开整点备份'),
  fact('idempotency-key', ['s07'], '幂等键是 merchant_id:biz_date:seq 三段拼接'),
  fact('lantern-staging', ['s04'], 'lantern 的 staging 在 8743 端口'),
  fact('ocr-engine', ['s03'], 'quillmark 选 PaddleOCR，因为 Tesseract 不擅长竖排中文'),
  fact('worker-concurrency', ['s03'], 'quillmark worker 并发 6，开到 12 会 OOM'),
  fact('dead-letter', ['s09'], '回调死信表叫 callback_dead_letter'),
  fact('backoff-cap', ['s09'], '回调退避上限 10 分钟'),
  fact('nas-model', ['s10'], '家里的 NAS 是群晖 DS923+'),
  fact('nas-first-disk', ['s10'], '第一次扩容买了 16TB 酷狼，1299 元'),
  fact('nas-second-disk', ['s23'], '第二次扩容买了 18TB 银河，1499 元'),
  fact('recon-topic', ['s28'], '对账新主题是 settle.recon.v2'),
  fact('recon-group', ['s28'], '对账消费组叫 recon-worker'),
  fact('mina-meeting', ['s49'], 'Mina 在柏林，会议放在北京时间 16:30 之后'),
  fact('schema-approval', ['s50'], '生产库表结构改动要先走老周审批'),
  fact('oncall-week', ['s49'], '值班固定在每月第二周'),
  fact('blog-stack', ['s33'], '博客用 Astro，部署在 Cloudflare Pages'),
  fact('v2-launch', ['s51'], '结算 v2 上线日期 2026-11-12'),
  fact('terminal-font', ['s52'], '终端字体 Maple Mono'),
  fact('uplot-choice', ['s02', 's04', 's06'], 'lantern 首页曲线换成 uPlot'),

  fact('incident-duplicate', ['s11'], '2026-04-07 重复结算事故，标注为 P1，影响 37 个商户'),
  fact('incident-kafka', ['s27'], 'Incident 2026-06-08: Kafka consumer lag hit 4.2 million, P2, root cause session.timeout.ms too low'),
  fact('incident-cert', ['s40'], 'Incident 2026-08-03: gateway TLS certificate expired, P1, down 47 minutes, NetworkPolicy blocked ACME'),

  fact('advisory-lock', ['s12'], '助手建议用 pg_advisory_xact_lock 让批处理和补单互斥'),
  fact('flaky-timezone', ['s13'], 'TestSettleCutoff 偶发失败：CI 容器时区是 UTC，本地是东八区'),
  fact('phone-regex', ['s21'], '手机号脱敏正则 1[3-9] 开头'),
  fact('book-ddia', ['s35'], '助手推荐《数据密集型应用系统设计》'),
  fact('chunk-name', ['s02'], 'uplot 拆成 chart-vendor chunk'),
  fact('pprof-flag', ['s39'], '查累计分配用 go tool pprof -alloc_space'),
  fact('partial-index', ['s20'], '待处理订单用带 WHERE 条件的部分索引'),
  fact('minio-sync', ['s30'], '迁移 MinIO 用 mc mirror'),
  fact('drain-prestop', ['s41'], '滚动发布用 preStop 等待 10 秒排空连接'),

  fact('pref-wrap-errors', ['s01'], '错误用 fmt.Errorf 加 %w 包装，不引 pkg/errors'),
  fact('pref-table-tests', ['s13'], '单测写成表驱动，手写 fake，不用 gomock 和 testify'),
  fact('pref-css-modules', ['s14'], 'lantern 用 CSS Modules，不用 Tailwind'),
  fact('pref-pnpm', ['s02'], '前端包管理统一用 pnpm'),
  fact('pref-pr-size', ['s19'], '单个 PR 不超过 400 行'),
  fact('pref-sqlc', ['s54'], '不用 ORM，用手写 SQL 加 sqlc'),
  fact('pref-commit', ['s53'], 'commit message 用英文 Conventional Commits'),
  fact('pref-comment-lang', ['s53'], '代码注释用中文'),
  fact('pref-answer-style', ['s53'], '回答先给结论，再说理由'),

  updated('pool-size', ['s01', 's25', 's46'], 's46', '老周收紧额度后，tidepool 的 max_open_conns 改成 64'),
  updated('go-version', ['s01', 's26'], 's26', 'tidepool 现在用 Go 1.24'),
  updated('lantern-deploy', ['s15', 's29'], 's29', 'lantern 现在部署在自建 k3s'),
  updated('parsed-bucket', ['s16', 's30'], 's30', '解析结果现在在 MinIO 的 quill-parsed-onprem'),
  updated('retry-attempts', ['s09', 's31'], 's31', '支付回调最多重试 7 次'),
  updated('weekly-meeting', ['s18', 's43'], 's43', 'tidepool 周会现在是每周四 14:30'),
  updated('tech-lead', ['s18', 's44'], 's44', 'tidepool 的 tech lead 换成唐工'),
  updated('lantern-ci', ['s34', 's48'], 's48', 'lantern 的 CI 现在在 Woodpecker'),
  updated('dev-machine', ['s52'], 's52', '开发机现在是 Windows 台式机'),
  updated('alerts-chart', ['s04', 's06'], 's06', '告警页退回 ECharts，首页保留 uPlot'),

  fact('go-version-before', ['s01'], '升级前 tidepool 用 go 1.22'),
  fact('pool-in-june', ['s25'], '6 月压测把 max_open_conns 提到 80'),
  fact('load-june', ['s25'], '6 月压测峰值 2100 QPS'),
  fact('load-september', ['s47'], '9 月压测峰值 3400 QPS'),
  fact('uplot-ship', ['s04'], 'uPlot 在 2026-03-12 上线'),
  fact('alerts-rollback', ['s06'], '告警页在 2026-03-20 退回 ECharts'),
  fact('rust-1', ['s17'], '学 Rust 第一次 3 小时，看所有权'),
  fact('rust-2', ['s24'], '学 Rust 第二次 5 小时'),
  fact('rust-3', ['s38'], '学 Rust 第三次 2 小时'),
  fact('ext-trgm', ['s22'], '生产库装了 pg_trgm'),
  fact('ext-partman', ['s32'], '用 pg_partman 管分区'),
  fact('ext-statements', ['s42'], '开了 pg_stat_statements'),
  fact('k3s-lantern', ['s29'], 'lantern-api 迁到 k3s'),
  fact('k3s-quill', ['s30'], 'quill-worker 迁到 k3s'),
  fact('k3s-gateway', ['s41'], 'tp-gateway 迁到 k3s'),
  fact('rollback-xnet', ['s36'], 'golang.org/x/net 升级被回滚'),
  fact('rollback-vite', ['s37'], 'vite 升级被回滚'),
  fact('rollback-pdfminer', ['s45'], 'pdfminer 升级被回滚'),

  fact('tmp-build-error', ['s55'], 'ERR-TMP-7731 是一次性构建错误，重跑即可', { label: 'ephemeral' }),

  // 已被推翻的旧值。线上不会有人替模型删掉它们，所以照样写进库，用来测读到旧值的情况。
  old('pool-initial', 's01', 'tidepool 初始 max_open_conns=40'),
  old('lantern-on-vercel', 's15', 'lantern 前端部署在 Vercel'),
  old('parsed-on-s3', 's16', '解析结果在 AWS S3，bucket 叫 quill-parsed-prod'),
  old('retry-five', 's09', '支付回调最多重试 5 次'),
  old('meeting-tuesday', 's18', 'tidepool 周会是每周二 10:00'),
  old('lead-he', 's18', 'tidepool 的 tech lead 是何工'),
  old('ci-actions', 's34', 'lantern 的 CI 迁到 GitHub Actions'),
]

const P = (id, kind, q, expect, answer, keys, more = {}) => ({ id, kind, q, expect, answer, keys, tags: [], ...more })
const NONE = (id, q, more = {}) => ({ id, kind: 'abstention', q, expect: [], answer: '历史记录里没有这个信息。', keys: [], tags: [], ...more })

const SSU = 'single-session-user'
const SSA = 'single-session-assistant'
const SSP = 'single-session-preference'
const KU = 'knowledge-update'
const MS = 'multi-session'
const TR = 'temporal-reasoning'

export const PROBES = [
  // 用户说过的事实
  P('u01', SSU, 'tidepool 的日结算任务每天几点开始跑？', ['settle-cron'], '每天 03:17', [['03:17']], { tags: ['distractor'] }),
  P('u02', SSU, '防止同一笔钱被收两回的那串东西长什么样？', ['idempotency-key'], 'merchant_id:biz_date:seq', [['merchant_id:biz_date:seq']], { tags: ['lexical-gap'] }),
  P('u03', SSU, 'lantern 的预览环境开在哪个端口？', ['lantern-staging'], '8743', [['8743']], { tags: ['distractor'] }),
  P('u04', SSU, 'quillmark 扫描件识别最后选了哪个引擎，为什么？', ['ocr-engine'], 'PaddleOCR，竖排中文效果更好', [['PaddleOCR'], ['竖排']]),
  P('u05', SSU, 'quillmark 的解析进程最多能开几个并发？', ['worker-concurrency'], '6 个，开到 12 会 OOM', [['worker 并发改成 6', '并发 6 下', 'worker 并发 6']], { stale: ['开到 12'], tags: ['distractor'] }),
  P('u06', SSU, '死信表叫什么？', ['dead-letter'], 'callback_dead_letter', [['callback_dead_letter']], { tags: ['short-query'] }),
  P('u07', SSU, '家里 NAS 是什么型号？', ['nas-model'], '群晖 DS923+', [['DS923']], { tags: ['alias'] }),
  P('u08', SSU, 'What is the new topic name for the reconciliation consumer?', ['recon-topic'], 'settle.recon.v2', [['settle.recon.v2']], { tags: ['cross-lingual'] }),
  P('u09', SSU, '对账的 consumer group 叫啥？', ['recon-group'], 'recon-worker', [['recon-worker']], { tags: ['alias'] }),
  P('u10', SSU, '要跟柏林那位同事开会，最早约几点比较合适？', ['mina-meeting'], '北京时间 16:30 之后', [['16:30', '四点半']]),
  P('u11', SSU, '改生产表结构前要先找谁？', ['schema-approval'], '先走老周审批', [['老周'], ['审批']]),
  P('u12', SSU, '我哪一周值班？', ['oncall-week'], '每月第二周', [['第二周']], { tags: ['short-query'] }),
  P('u13', SSU, '博客现在用什么搭的，放在哪？', ['blog-stack'], 'Astro，部署在 Cloudflare Pages', [['Astro'], ['Cloudflare Pages']]),
  P('u14', SSU, '结算 v2 什么时候上线？', ['v2-launch'], '2026-11-12', [['2026-11-12']]),
  P('u15', SSU, '终端用的什么字体？', ['terminal-font'], 'Maple Mono', [['Maple Mono']], { tags: ['short-query'] }),
  P('u16', SSU, '支付回调的退避上限是多少？', ['backoff-cap'], '10 分钟', [['10 分钟']]),
  P('u17', SSU, '6 月那次消息积压，消费者 lag 最高到了多少？', ['incident-kafka'], '420 万条', [['4.2 million', '420 万']], { tags: ['cross-lingual'] }),
  P('u18', SSU, '证书过期那次，根因是什么？', ['incident-cert'], 'NetworkPolicy 拦了 ACME 流量，cert-manager 续期失败', [['NetworkPolicy']], { tags: ['cross-lingual'] }),
  P('u19', SSU, '证书那次事故断了多久？', ['incident-cert'], '47 分钟', [['47 minutes', '47 分钟']], { tags: ['cross-lingual'] }),
  P('u20', SSU, '网页上的线条图卡顿，后来用了什么？', ['uplot-choice'], 'uPlot', [['uPlot']], { tags: ['lexical-gap'] }),
  P('u21', SSU, '照片和电影放不下了，当时是如何解决的？', ['nas-first-disk'], '买了一块 16TB 硬盘给 NAS 扩容', [['16TB']], { tags: ['lexical-gap'] }),

  // 助手说过的内容
  P('a01', SSA, '批处理和补单互斥，你当时建议用什么锁？', ['advisory-lock'], 'pg_advisory_xact_lock', [['pg_advisory_xact_lock']]),
  P('a02', SSA, 'TestSettleCutoff 偶发失败的根因是什么？', ['flaky-timezone'], 'CI 时区是 UTC，本地是东八区', [['容器时区是 UTC']]),
  P('a03', SSA, '你给过我一个手机号脱敏的正则，再发我一下。', ['phone-regex'], '1[3-9] 开头的 11 位数字，前后加否定断言', [['1[3-9]']]),
  P('a04', SSA, '你推荐过的那本分布式的书叫什么？', ['book-ddia'], '《数据密集型应用系统设计》', [['数据密集型应用系统设计']]),
  P('a05', SSA, 'uplot 打包时拆出来的那个 chunk 叫什么名字？', ['chunk-name'], 'chart-vendor', [['chart-vendor']]),
  P('a06', SSA, '内存涨得快但常驻不高，看分配热点的 pprof 参数是什么？', ['pprof-flag'], '-alloc_space', [['-alloc_space']]),
  P('a07', SSA, '待处理订单查询慢，建的那条索引有什么特别的？', ['partial-index'], '部分索引，只覆盖 status 为 pending 的行', [['部分索引']]),
  P('a08', SSA, '把解析结果同步到内网存储用的是什么命令？', ['minio-sync'], 'mc mirror', [['mc mirror']]),
  P('a09', SSA, '滚动发布时怎么让连接先排空？', ['drain-prestop'], '加 preStop 等待 10 秒', [['preStop']]),
  P('a10', SSA, '怕两条流程撞车，我们后来靠什么把它们隔开的？', ['advisory-lock'], 'pg_advisory_xact_lock', [['pg_advisory_xact_lock']], { tags: ['lexical-gap'] }),
  P('a11', SSA, '同一份校验在服务器上红、在我电脑上绿，那回的毛病出在哪？', ['flaky-timezone'], 'CI 时区是 UTC，本地是东八区', [['容器时区是 UTC']], { tags: ['lexical-gap'] }),
  P('a12', SSA, 'Kafka 积压那次改了哪个参数？', ['incident-kafka'], '调大 session.timeout.ms', [['session.timeout.ms']], { tags: ['cross-lingual'] }),

  // 偏好：多数是任务式消息，不问记忆，但回答要用上它
  P('p01', SSP, '给 tidepool 的 refund 包补一下错误返回。', ['pref-wrap-errors'], '应使用 fmt.Errorf 加 %w 包装，不引 pkg/errors', [['%w']], { tags: ['task-style'] }),
  P('p02', SSP, '给 settle 的汇率换算写几个单测。', ['pref-table-tests'], '应写成表驱动测试，依赖用手写 fake，不用 gomock 和 testify', [['表驱动'], ['fake']], { tags: ['task-style'] }),
  P('p03', SSP, 'lantern 新增的设置页样式怎么写比较好？', ['pref-css-modules'], '应使用 CSS Modules，不用 Tailwind', [['CSS Modules']], { tags: ['task-style'] }),
  P('p04', SSP, '给前端工程装一下 dayjs。', ['pref-pnpm'], '应使用 pnpm 安装，不提交 package-lock.json', [['统一用 pnpm']], { tags: ['task-style'] }),
  P('p05', SSP, '这次改动大概 900 行，帮我提个合并请求。', ['pref-pr-size'], '应提醒超过 400 行的底线，建议拆分', [['400 行']], { tags: ['task-style'] }),
  P('p06', SSP, 'tidepool 新模块的数据库访问层用什么好？', ['pref-sqlc'], '手写 SQL 加 sqlc，不用 ORM', [['sqlc']], { tags: ['task-style'] }),
  P('p07', SSP, '帮我写个提交说明。', ['pref-commit'], '英文，遵循 Conventional Commits', [['Conventional Commits']], { tags: ['task-style'] }),
  P('p08', SSP, 'Redis 和本地缓存哪个好，给我分析分析。', ['pref-answer-style'], '应先给结论再说理由，只给推荐方案', [['先给结论']], { tags: ['task-style', 'lexical-gap'] }),
  P('p09', SSP, '帮我在这段 Go 代码上加点说明。', ['pref-comment-lang'], '注释应使用中文', [['注释用中文']], { tags: ['task-style'] }),
  P('p10', SSP, '帮我安排下个月去上海出差的时间。', ['oncall-week'], '应避开每月第二周的值班', [['第二周']], { tags: ['task-style'] }),
  P('p11', SSP, 'settlement_orders 再加个字段，今晚直接上线吧。', ['schema-approval'], '应提醒先走老周审批，工单通过后才能上线', [['老周'], ['审批']], { tags: ['task-style'] }),

  // 知识更新
  P('k01', KU, 'tidepool 现在 max_open_conns 配的多少？', ['pool-size'], '64', [['改成 64']], { stale: ['max_open_conns=40', '提到 80'], tags: ['distractor'] }),
  P('k02', KU, 'tidepool 现在用的 Go 版本是多少？', ['go-version'], 'Go 1.24', [['Go 1.24']], { stale: ['go 1.22'] }),
  P('k03', KU, 'lantern 前端现在部署在哪里？', ['lantern-deploy'], '自建 k3s 集群', [['自建 k3s']], { stale: ['部署在 Vercel'] }),
  P('k04', KU, 'quillmark 解析结果现在存在哪个 bucket？', ['parsed-bucket'], 'quill-parsed-onprem', [['quill-parsed-onprem']], { stale: ['bucket 叫 quill-parsed-prod'] }),
  P('k05', KU, '支付回调最多重试几次？', ['retry-attempts'], '7 次', [['7 次']], { stale: ['最多重试 5 次'] }),
  P('k06', KU, 'tidepool 周会是什么时候？', ['weekly-meeting'], '每周四 14:30', [['周四 14:30']], { stale: ['周二 10:00'] }),
  P('k07', KU, 'tidepool 的 tech lead 是谁？', ['tech-lead'], '唐工', [['换成唐工']], { stale: ['tech lead 是何工'] }),
  P('k08', KU, 'lantern 的流水线现在跑在哪？', ['lantern-ci'], '内网 Woodpecker', [['Woodpecker']], { stale: ['GitHub Actions', 'Jenkins'] }),
  P('k09', KU, '我现在的开发机是什么？', ['dev-machine'], 'Windows 台式机', [['Windows 台式机']]),
  P('k10', KU, '告警页现在用的什么图表库？', ['alerts-chart'], 'ECharts', [['退回 ECharts']], { tags: ['distractor'] }),
  P('k11', KU, 'What CI system does lantern use now?', ['lantern-ci'], 'Woodpecker', [['Woodpecker']], { stale: ['GitHub Actions', 'Jenkins'], tags: ['cross-lingual'] }),
  P('k12', KU, 'tidepool 的数据库连接上限现在是多少？', ['pool-size'], '64', [['改成 64']], { stale: ['max_open_conns=40', '提到 80'], tags: ['alias', 'distractor'] }),
  P('k13', KU, '结算项目现在跑在哪个 Go 版本上？', ['go-version'], 'Go 1.24', [['Go 1.24']], { stale: ['go 1.22'], tags: ['alias'] }),

  // 跨会话汇总
  P('m01', MS, '今年线上出过哪几次事故？', ['incident-duplicate', 'incident-kafka', 'incident-cert'], '4 月重复结算、6 月 Kafka 积压、8 月证书过期', [['同一商户被结算了两次', '重复结算'], ['consumer lag', '4.2 million'], ['certificate expired', '证书过期']], { tags: ['cross-lingual'] }),
  P('m02', MS, '哪些服务迁到了 k3s？', ['k3s-lantern', 'k3s-quill', 'k3s-gateway'], 'lantern-api、quill-worker、tp-gateway', [['lantern-api'], ['quill-worker'], ['tp-gateway']]),
  P('m03', MS, 'NAS 的硬盘一共花了多少钱？', ['nas-first-disk', 'nas-second-disk'], '2798 元', [['1299'], ['1499']]),
  P('m04', MS, '学 Rust 累计花了多少小时？', ['rust-1', 'rust-2', 'rust-3'], '10 小时', [['3 小时'], ['5 小时'], ['2 小时']]),
  P('m05', MS, 'tidepool 的 PostgreSQL 都用了哪些扩展？', ['ext-trgm', 'ext-partman', 'ext-statements'], 'pg_trgm、pg_partman、pg_stat_statements', [['pg_trgm'], ['pg_partman'], ['pg_stat_statements']]),
  P('m06', MS, '今年有哪几次依赖升级被回滚了？', ['rollback-xnet', 'rollback-vite', 'rollback-pdfminer'], 'golang.org/x/net、vite、pdfminer', [['x/net'], ['vite 回滚', 'vite 大版本', '把 vite', 'vite 升级'], ['pdfminer']]),
  P('m07', MS, '今年的 P1 事故有几次？', ['incident-duplicate', 'incident-cert'], '2 次：重复结算和证书过期', [['标注为 P1'], ['Severity P1', 'Updated to P1', 'expired, P1']], { tags: ['cross-lingual'] }),
  P('m08', MS, '两轮压测的峰值 QPS 分别是多少？', ['load-june', 'load-september'], '6 月 2100，9 月 3400', [['2100 QPS'], ['3400 QPS']]),

  // 时间推理
  P('t01', TR, 'Kafka 积压和证书过期，哪个先发生？', ['incident-kafka', 'incident-cert'], 'Kafka 积压先发生，在 6 月', [['2026-06-08'], ['2026-08-03']], { tags: ['cross-lingual'] }),
  P('t02', TR, 'uPlot 上线后过了几天，告警页退回了 ECharts？', ['uplot-ship', 'alerts-rollback'], '8 天', [['2026-03-12'], ['2026-03-20']]),
  P('t03', TR, '最近一次线上事故是什么？', ['incident-cert'], '2026-08-03 的证书过期', [['certificate expired', '证书过期']], { tags: ['cross-lingual'] }),
  P('t04', TR, 'tidepool 升级之前用的是哪个 Go 版本？', ['go-version-before'], 'Go 1.22', [['go 1.22']], { stale: ['Go 1.24'] }),
  P('t05', TR, '9 月那轮压测的峰值 QPS 是多少？', ['load-september'], '3400', [['3400 QPS']], { stale: ['2100 QPS'], tags: ['distractor'] }),
  P('t06', TR, '结算 v2 离上线还有几天？', ['v2-launch'], '13 天', [['2026-11-12']]),
  P('t07', TR, '上个月 lantern 的 CI 换成什么了？', ['lantern-ci'], 'Woodpecker', [['Woodpecker']], { stale: ['GitHub Actions'] }),
  P('t08', TR, '6 月初压测时 max_open_conns 是多少？', ['pool-in-june'], '80', [['提到 80']], { stale: ['改成 64'], tags: ['distractor'] }),
  P('t09', TR, '连接池从 80 收紧到 64 隔了多久？', ['pool-in-june', 'pool-size'], '约三个月（6 月 2 日到 9 月 1 日）', [['提到 80'], ['改成 64']]),
  P('t10', TR, '3 月份 quillmark 定了什么技术方案？', ['ocr-engine'], '定了 PaddleOCR', [['PaddleOCR']]),
  P('t11', TR, '下个月最重要的上线是什么？', ['v2-launch'], '11 月 12 日结算 v2 上线', [['2026-11-12']]),
  P('t12', TR, '学 Rust 最开始看的是哪部分？', ['rust-1'], '所有权', [['所有权']]),

  // 拒答：话题相近但没有答案、张冠李戴、前提不成立、一次性噪声
  NONE('x01', 'tidepool 用的 Redis 集群有几个分片？', { absent: ['分片'], tags: ['near-topic'] }),
  NONE('x02', 'lantern 灰度发布的比例现在是多少？', { absent: ['灰度比例'], tags: ['near-topic'] }),
  NONE('x03', 'quillmark 的 GPU 是什么型号？', { absent: ['GPU', '显卡'], tags: ['near-topic'] }),
  NONE('x04', 'NAS 的 UPS 是什么牌子？', { absent: ['UPS'], tags: ['near-topic'] }),
  NONE('x05', '博客的评论系统用的哪家？', { absent: ['评论系统'], tags: ['near-topic'] }),
  NONE('x06', 'quillmark 的回调最多重试几次？', { tags: ['wrong-entity'] }),
  NONE('x07', 'tidepool 的 staging 端口是多少？', { tags: ['wrong-entity'] }),
  NONE('x08', 'Mina 的生日是哪天？', { absent: ['生日'], tags: ['near-topic'] }),
  NONE('x09', '我养的猫叫什么？', { absent: ['猫'], tags: ['unrelated'] }),
  NONE('x10', '唐工之前在哪家公司？', { absent: ['前公司'], tags: ['near-topic'] }),
  NONE('x11', 'ERR-TMP-7731 的修复方案是什么？', { expectFacts: ['tmp-build-error'], tags: ['ephemeral'] }),
  NONE('x12', '老周的手机号是多少？', { absent: ['老周的手机'], tags: ['near-topic'] }),
  NONE('x13', 'tidepool 什么时候迁到 MySQL 的？', { absent: ['MySQL'], tags: ['false-premise'] }),
  NONE('x14', 'lantern 的移动端 App 上架了吗？', { absent: ['移动端', 'App Store'], tags: ['false-premise'] }),
]
