import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
const ROOT = join(process.env.USERPROFILE, '.dsh', 'sessions');
const WS = '--C-Users-User-.dsh-profiles-desktop--';
const dir = join(ROOT, WS);
for (const s of readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())) {
  const sd = join(dir, s.name);
  let files = [];
  try { files = readdirSync(sd).filter(f => f.includes('jsonl')); } catch { continue; }
  for (const f of files) {
    let text = '';
    try { text = zstdDecompressSync(readFileSync(join(sd, f))).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const src = r?.data?.source;
      if (src?.kind !== 'plugin:meow-memory' || src?.form !== 'snapshot') continue;
      const sections = Array.isArray(src.sections) ? src.sections : [];
      const main = sections.find(x => x?.name && x.name !== '__meta__');
      if (main && Array.from(String(main.text)).length === 1153) {
        console.log('=== 会话 ' + s.name + ' 的完整注入 ===');
        console.log(String(main.text));
        process.exit(0);
      }
      break;
    }
  }
}
