// 中文名缓存。
// Steam 的 GetOwnedGames 只给英文名，中文名要单独查：
//   1. 商店接口 appdetails?l=schinese（准确，一次一个 appid）
//   2. steamcmd.net 的 name_localized（商店不通时的后备）
// 结果写进 data/names.json，一个 appid 只查一次。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './http.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAMES_FILE = process.env.NAMES_FILE
  ? path.resolve(process.env.NAMES_FILE)
  : path.join(ROOT, 'data', 'names.json');

const STORE = 'https://store.steampowered.com/api/appdetails';
const APPINFO = 'https://api.steamcmd.net/v1/info';
const MAX_PARALLEL = 6;
const TIMEOUT_STORE = 9000;
const TIMEOUT_APPINFO = 12000;

let cache = null;
let saveTimer = 0;
const inFlight = new Set();
const recentFailures = new Map(); // appid -> 时间，失败后 10 分钟内不再试
let consecutiveFailures = 0;
let pausedUntil = 0;

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(NAMES_FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(path.dirname(NAMES_FILE), { recursive: true });
      await fs.writeFile(NAMES_FILE, JSON.stringify(cache));
    } catch {
      /* 写不进缓存不影响页面 */
    }
  }, 600);
}

async function fromStore(appid) {
  const url = `${STORE}?appids=${appid}&l=schinese&cc=cn&filters=basic`;
  const { status, body } = await httpGet(url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    timeout: TIMEOUT_STORE,
  });
  if (status !== 200) throw new Error(`store ${status}`);
  const payload = JSON.parse(body.toString('utf8'));
  const entry = payload?.[String(appid)];
  const name = entry?.success ? entry.data?.name : '';
  return typeof name === 'string' ? name.trim() : '';
}

async function fromAppInfo(appid) {
  const { status, body } = await httpGet(`${APPINFO}/${appid}`, { timeout: TIMEOUT_APPINFO });
  if (status !== 200) throw new Error(`appinfo ${status}`);
  const common = JSON.parse(body.toString('utf8'))?.data?.[String(appid)]?.common || {};
  const localized = common.name_localized || {};
  return (localized.schinese || localized.sc_schinese || '').trim();
}

async function resolve(appid) {
  try {
    let zh = await fromStore(appid).catch(() => '');
    if (!zh) zh = await fromAppInfo(appid).catch(() => '');
    consecutiveFailures = 0;
    cache[appid] = { zh, at: Date.now() };
    scheduleSave();
  } catch {
    consecutiveFailures += 1;
    if (consecutiveFailures >= 4) pausedUntil = Date.now() + 5 * 60 * 1000;
    recentFailures.set(appid, Date.now());
  } finally {
    inFlight.delete(appid);
  }
}

/** 后台补齐，不阻塞任何请求。 */
export function warmNames(appids) {
  const list = [...new Set((appids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  let started = 0;
  for (const appid of list) {
    if (inFlight.has(appid) || cache?.[appid]) continue;
    const failedAt = recentFailures.get(appid);
    if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) continue;
    if (Date.now() < pausedUntil) break;
    if (inFlight.size >= MAX_PARALLEL) break;
    inFlight.add(appid);
    resolve(appid);
    started += 1;
  }
  return started;
}

/**
 * 给游戏补上 name_zh（查过但确实没有中文的，保持空串）。
 * 返回还差多少个、以及缺哪些 appid，调用方据此决定要不要后台预热。
 */
export async function enrichNames(games) {
  const map = await loadCache();
  const missing = [];
  for (const game of games || []) {
    const appid = Number(game?.appid);
    if (!Number.isInteger(appid)) continue;
    if (typeof game.name_zh === 'string' && game.name_zh) continue; // 自带数据里已经烘焙过
    const hit = map[appid];
    if (hit) {
      if (hit.zh && hit.zh !== game.name) game.name_zh = hit.zh;
      else game.name_zh = '';
    } else {
      missing.push(appid);
    }
  }
  return { pending: missing.length, missing };
}

export async function nameStats() {
  const map = await loadCache();
  const ids = Object.keys(map);
  return { cached: ids.length, withZh: ids.filter((id) => map[id]?.zh).length };
}

export { NAMES_FILE };
