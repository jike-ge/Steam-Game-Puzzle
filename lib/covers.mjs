// 封面本地缓存。
// 新游戏（2024 年后）的封面在带哈希的子目录里：
//   store_item_assets/steam/apps/<id>/<hash>/header.jpg
// 哈希只能从 AppInfo 读，所以默认先去查它，拿不到再退回老路径。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './http.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COVER_DIR = process.env.COVER_DIR ? path.resolve(process.env.COVER_DIR) : path.join(ROOT, 'data', 'covers');
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const ASSET_HOST = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';
const APPINFO_API = 'https://api.steamcmd.net/v1/info';
const MAX_BYTES = 400 * 1024;
// 真封面一般 25–70 KB；Steam 对还没上线的游戏会给一张 1–2 KB 的纯灰占位图
const MIN_REAL_BYTES = 4000;
// auto（默认）：先取老路径，快；不行再查哈希路径
// hashed：老路径和哈希路径并发，哈希优先，最稳但每张冷图多 ~1.5s
// legacy：只用老路径，最快，个别游戏会拿到灰图或没图
const SOURCE = (() => {
  const value = (process.env.COVER_SOURCE || '').toLowerCase();
  return ['auto', 'hashed', 'legacy'].includes(value) ? value : 'auto';
})();

const inFlight = new Map();
const missing = new Map(); // appid -> 记录时间，10 分钟后重试
const assetUrls = new Map(); // appid -> 哈希路径（查不到记 null）
let metaDownUntil = 0;
let metaFailStreak = 0;
const queue = [];
let active = 0;
const MAX_PARALLEL = 6;
const MISSING_TTL = 10 * 60 * 1000;

const coverPath = (appid) => path.join(COVER_DIR, `${appid}.jpg`);

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    active += 1;
    job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function enqueue(task) {
  return new Promise((resolve) => {
    queue.push(async () => resolve(await task()));
    pump();
  });
}

/** 查这个 app 的封面真实地址（带哈希）。查不到 / 服务挂了返回 null。 */
async function hashedHeaderUrl(appid) {
  if (assetUrls.has(appid)) return assetUrls.get(appid);
  if (Date.now() < metaDownUntil) return null;

  try {
    const { status, body } = await httpGet(`${APPINFO_API}/${appid}`, { timeout: 6000 });
    if (status !== 200) throw new Error(`appinfo ${status}`);
    const common = JSON.parse(body.toString('utf8'))?.data?.[String(appid)]?.common || {};
    const pick = (obj) => ['english', 'schinese', 'sc_schinese', 'japanese', 'koreana']
      .map((key) => obj?.[key])
      .find((value) => typeof value === 'string' && value.length > 0);
    const rel = pick(common.header_image) || pick(common.small_capsule) || null;
    const url = rel ? `${ASSET_HOST}/${appid}/${rel}` : null;
    assetUrls.set(appid, url);
    metaFailStreak = 0;
    return url;
  } catch {
    // 连续失败就先别查了，5 分钟内全部走老路径，免得每张图都等超时
    metaFailStreak += 1;
    if (metaFailStreak >= 3) metaDownUntil = Date.now() + 5 * 60 * 1000;
    return null;
  }
}

async function fetchBytes(url) {
  try {
    const { status, body } = await httpGet(url, {
      headers: { 'user-agent': 'steam-game-puzzle/1.0' },
      timeout: 12_000,
    });
    if (status < 200 || status >= 300) return null;
    if (!body?.length || body.length > MAX_BYTES) return null;
    return body;
  } catch {
    return null;
  }
}

async function persist(appid, buffer) {
  await fs.mkdir(COVER_DIR, { recursive: true });
  await fs.writeFile(coverPath(appid), buffer);
  missing.delete(appid);
  return buffer;
}

/** 谁先拿到「像样的图」就用谁，其余的在后台跑完就算了。 */
function firstGood(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) return resolve(null);
    for (const promise of promises) {
      promise
        .then((value) => {
          if (value) resolve(value);
          else if (--pending === 0) resolve(null);
        })
        .catch(() => {
          if (--pending === 0) resolve(null);
        });
    }
  });
}

async function download(appid) {
  let fallback = null; // 只有占位图时留个底，总比空白强

  const consider = (buffer) => {
    if (!buffer) return false;
    if (buffer.length >= MIN_REAL_BYTES) return true;
    if (!fallback || buffer.length > fallback.length) fallback = buffer;
    return false;
  };

  const legacyHeader = fetchBytes(`${CDN}/${appid}/header.jpg`).then((buffer) => (consider(buffer) ? buffer : null));
  const hashedHeader = hashedHeaderUrl(appid)
    .then((url) => (url ? fetchBytes(url) : null))
    .then((buffer) => (consider(buffer) ? buffer : null));

  let chosen = null;
  if (SOURCE === 'hashed') {
    // 哈希优先：等它，等不到再用老路径（老路径已经在并发跑了）
    chosen = await hashedHeader;
    if (!chosen) chosen = await legacyHeader;
  } else if (SOURCE === 'legacy') {
    chosen = await legacyHeader;
  } else {
    // auto：谁先给出像样的图就用谁
    chosen = await firstGood([legacyHeader, hashedHeader]);
  }

  if (!chosen) {
    const capsule = await fetchBytes(`${CDN}/${appid}/capsule_231x87.jpg`);
    if (consider(capsule)) chosen = capsule;
  }

  if (chosen) return persist(appid, chosen);
  if (fallback) return persist(appid, fallback);

  missing.set(appid, Date.now());
  return null;
}

/** 有就返回 Buffer，没有就去 Steam 取一张存下来。取不到返回 null。 */
export async function getCover(appid) {
  const id = Number(appid);
  if (!Number.isInteger(id) || id <= 0) return null;

  const cached = await fs.readFile(coverPath(id)).catch(() => null);
  if (cached?.length) return cached;

  const failedAt = missing.get(id);
  if (failedAt && Date.now() - failedAt < MISSING_TTL) return null;

  if (inFlight.has(id)) return inFlight.get(id);
  const job = enqueue(() => download(id));
  inFlight.set(id, job);
  const buffer = await job;
  inFlight.delete(id);
  return buffer;
}

/** 后台预热，不阻塞任何请求。 */
export function warmCovers(appids) {
  const list = [...new Set(appids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  for (const appid of list) {
    getCover(appid).catch(() => {});
  }
  return list.length;
}

export async function coverStats() {
  try {
    const files = await fs.readdir(COVER_DIR);
    return files.filter((name) => name.endsWith('.jpg')).length;
  } catch {
    return 0;
  }
}

export { COVER_DIR, SOURCE as COVER_SOURCE };
