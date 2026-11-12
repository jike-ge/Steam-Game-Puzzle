import fs from 'node:fs/promises';

const FILE = 'data/demo-library.json';
const STORE = 'https://store.steampowered.com/api/appdetails';

const lib = JSON.parse(await fs.readFile(FILE, 'utf8'));
const queue = lib.games.filter((g) => !g.name_zh);
const total = queue.length;
let done = 0;
let hit = 0;

async function lookup(appid) {
  const url = `${STORE}?appids=${appid}&l=schinese&cc=cn&filters=basic`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return '';
    const payload = await res.json();
    const name = payload?.[String(appid)]?.data?.name;
    return typeof name === 'string' ? name.trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function worker() {
  while (queue.length) {
    const game = queue.shift();
    const zh = await lookup(game.appid);
    if (zh && zh !== game.name) {
      game.name_zh = zh;
      hit += 1;
    } else {
      game.name_zh = '';
    }
    done += 1;
    if (done % 20 === 0) console.log(`  ${done}/${total} …`);
  }
}

await Promise.all(Array.from({ length: 5 }, worker));
// 去掉空字符串，保持文件干净
for (const game of lib.games) {
  if (!game.name_zh) delete game.name_zh;
}
await fs.writeFile(FILE, JSON.stringify(lib, null, 1) + '\n');
console.log(`完成：${total} 款查询，${hit} 款有中文名`);
