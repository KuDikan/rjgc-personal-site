import { readFileSync } from 'node:fs';
for (const f of ['public/about/index.html', 'public/index.html']) {
  if (!existsSync(f)) continue;
  const h = readFileSync(f, 'utf8');
  const m = h.match(/<span[^>]*waline-pageview-count[^>]*>/);
  console.log(`${f}:`);
  console.log('  ' + (m ? m[0] : '(未找到)'));
  console.log('');
}
