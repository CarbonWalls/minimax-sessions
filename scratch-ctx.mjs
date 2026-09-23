// Print bounded context windows around a regex in a (minified) file.
import { readFileSync } from 'node:fs';
const [file, pat, pre = '120', post = '220', max = '40'] = process.argv.slice(2);
const re = new RegExp(pat, 'g');
const text = readFileSync(file, 'utf8');
let n = 0, m;
while ((m = re.exec(text)) && n < Number(max)) {
  const s = Math.max(0, m.index - Number(pre));
  const e = Math.min(text.length, m.index + m[0].length + Number(post));
  n++;
  console.log(`\n[#${n} @${m.index}] ...${text.slice(s, e)}...`);
}
console.log(`\ntotal matches: ${n}`);
