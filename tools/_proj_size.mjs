import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.dsh/profiles/desktop/.dsh-meow/memory.db', { readOnly: true });
const rows = db.prepare("SELECT project, count(*) n, sum(length(content)) c FROM project WHERE status='active' GROUP BY project ORDER BY c DESC").all();
let t = 0;
for (const r of rows) { t += r.c; console.log((r.project || '-') + '  ' + r.n + '条  ' + r.c + '字'); }
console.log('project 表 active 合计: ' + t + ' 字');
