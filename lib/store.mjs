// Disk cache. One JSON file per Steam profile, so the whole thing survives
// restarts and can be inspected with any editor.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLibrary, SteamError } from './steam.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = process.env.CACHE_DIR ? path.resolve(process.env.CACHE_DIR) : path.join(ROOT, 'data', 'cache');

const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

const inFlight = new Map();

const safeId = (steamID) => String(steamID).replace(/[^A-Za-z0-9_-]/g, '');

async function readFile(steamID) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${safeId(steamID)}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.games)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeFile(payload) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${safeId(payload.steamID)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, file);
}

/** Returns { games, fetchedAt, source, cached, stale, warning }. */
export async function getLibrary(steamID, { apiKey = '', force = false } = {}) {
  const cached = await readFile(steamID);
  const age = cached ? Date.now() - Number(cached.fetchedAt || 0) : Infinity;
  if (cached && !force && age < FRESH_MS) {
    return { ...cached, cached: true, stale: false };
  }

  const jobKey = `${steamID}:${apiKey ? 'user' : 'server'}`;
  if (inFlight.has(jobKey)) return inFlight.get(jobKey);

  const job = (async () => {
    try {
      const { games, source } = await fetchLibrary(steamID, { apiKey });
      const payload = {
        steamID,
        fetchedAt: Date.now(),
        source,
        gameCount: games.length,
        games,
      };
      await writeFile(payload);
      return { ...payload, cached: false, stale: false };
    } catch (error) {
      if (cached && age < STALE_MS) {
        return {
          ...cached,
          cached: true,
          stale: true,
          warning: `Steam 暂时取不到数据，这里是 ${new Date(Number(cached.fetchedAt)).toLocaleString('zh-CN')} 的缓存。`,
        };
      }
      throw error;
    } finally {
      inFlight.delete(jobKey);
    }
  })();

  inFlight.set(jobKey, job);
  return job;
}

export async function saveEntry(payload) {
  await writeFile(payload);
}

export async function readEntry(steamID) {
  return readFile(steamID);
}

export async function listEntries() {
  let names = [];
  try {
    names = await fs.readdir(CACHE_DIR);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(CACHE_DIR, name), 'utf8'));
      if (parsed?.steamID && Array.isArray(parsed.games)) entries.push(parsed);
    } catch {
      /* skip broken file */
    }
  }
  return entries;
}

export { CACHE_DIR, SteamError };
