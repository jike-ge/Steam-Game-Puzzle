// 把 data/demo-library.json 里已经烘焙的中文名按同一套规则清洗一遍
// （去掉「英文名 + 后缀」这种冗余，纯英文的丢掉）。不需要联网。
import fs from 'node:fs/promises';
import { cleanChineseName } from '../lib/names.mjs';

const FILE = 'data/demo-library.json';
const lib = JSON.parse(await fs.readFile(FILE, 'utf8'));

let kept = 0;
let dropped = 0;
for (const game of lib.games) {
  if (!game.name_zh) continue;
  const cleaned = cleanChineseName(game.name, game.name_zh);
  if (cleaned) {
    game.name_zh = cleaned;
    kept += 1;
  } else {
    delete game.name_zh;
    dropped += 1;
  }
}

await fs.writeFile(FILE, JSON.stringify(lib, null, 1) + '\n');
console.log(`保留 ${kept} 条中文名，清掉 ${dropped} 条`);
