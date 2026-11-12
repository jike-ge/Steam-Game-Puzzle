// Steam Web API client.
//
// 两个域名在国内大多直连不通，所以所有请求都走 lib/http.mjs：
// 配了 STEAM_PROXY（或检测到本机代理）就走隧道，否则直连。

import { httpGet } from './http.mjs';

const API_BASE = (process.env.STEAM_API_BASE || 'https://api.steampowered.com').replace(/\/+$/, '');
const COMMUNITY_BASE = (process.env.STEAM_COMMUNITY_BASE || 'https://steamcommunity.com').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const STEAM_ID64 = /^\d{17}$/;

export class SteamError extends Error {
  constructor(code, message, { status = 502, hint = '' } = {}) {
    super(message);
    this.name = 'SteamError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

const keyPool = (() => {
  const csv = process.env.STEAM_API_KEYS || process.env.STEAM_API_KEY || '';
  return csv
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
})();

let keyCursor = 0;
function serverKey() {
  if (!keyPool.length) return '';
  const key = keyPool[keyCursor % keyPool.length];
  keyCursor = (keyCursor + 1) % keyPool.length;
  return key;
}

export const hasServerKey = () => keyPool.length > 0;

async function request(url, { key = '' } = {}) {
  const headers = { 'user-agent': USER_AGENT, accept: 'application/json, text/xml, */*' };
  const host = new URL(url).host;
  try {
    const { status, body, viaProxy } = await httpGet(url, { headers });
    const text = body.toString('utf8');
    return {
      ok: status >= 200 && status < 300,
      status,
      viaProxy,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  } catch (error) {
    const cause = error?.cause?.code || error?.code || error?.name || '';
    if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
      throw new SteamError('unreachable', `无法解析 Steam 域名（${host}）。`, {
        status: 503,
        hint: '检查 DNS，或者给服务器配一个代理：STEAM_PROXY=http://127.0.0.1:7890',
      });
    }
    throw new SteamError('unreachable', `连不上 Steam（${host}）。`, {
      status: 503,
      hint: '国内直连 api.steampowered.com / steamcommunity.com 通常不通。开一个本地代理（Clash 默认 7890），启动时设置 STEAM_PROXY=http://127.0.0.1:7890 即可。',
    });
  }
}

/** Accepts a vanity name, steamID64, steamID3/U:1:x, or any steamcommunity URL. */
export function normalizeIdentifier(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (!value) return '';
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }

  const urlMatch = value.match(/steamcommunity\.com\/(?:id|profiles)\/([^/?#]+)/i);
  if (urlMatch) value = urlMatch[1];

  const shortMatch = value.match(/s\.team\/p\/([^/?#]+)/i);
  if (shortMatch) value = shortMatch[1];

  const steam3 = value.match(/^\[?U:1:(\d{1,10})\]?$/i);
  if (steam3) return String(76561197960265728n + BigInt(steam3[1]));

  value = value.replace(/^\/+/, '').replace(/\/+$/, '');
  return value;
}

export const isSteamId64 = (value) => STEAM_ID64.test(String(value || ''));

function parseXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

/** Keyless vanity lookup through the public profile XML endpoint. */
async function resolveVanityKeyless(vanity) {
  const response = await request(`${COMMUNITY_BASE}/id/${encodeURIComponent(vanity)}/?xml=1`);
  if (response.status === 404) return '';
  if (!response.ok) return '';
  const xml = await response.text();

  if (/<error>/i.test(xml) || /The specified profile could not be found/i.test(xml)) {
    const message = parseXmlTag(xml, 'error');
    if (/could not be found/i.test(message)) {
      throw new SteamError('not_found', 'Steam 上没有这个昵称。', { status: 404 });
    }
    throw new SteamError('community_error', message || 'Steam 社区接口返回错误。', { status: 502 });
  }

  const steamID = parseXmlTag(xml, 'steamID64');
  if (STEAM_ID64.test(steamID)) return steamID;
  return '';
}

async function resolveVanityKeyed(vanity, key) {
  const url = `${API_BASE}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(vanity)}`;
  const response = await request(url, { key });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SteamError('bad_key', 'Steam API 密钥无效。', { status: 401 });
    }
    throw new SteamError('api_error', `Steam API 返回 ${response.status}。`, { status: 502 });
  }
  const payload = await response.json().catch(() => null);
  const body = payload?.response ?? {};
  if (body.success === 1 && isSteamId64(body.steamid)) return body.steamid;
  if (body.success === 42) {
    throw new SteamError('not_found', 'Steam 上没有这个昵称。', { status: 404 });
  }
  return '';
}

export async function resolveIdentifier(rawInput, { apiKey = '' } = {}) {
  const identifier = normalizeIdentifier(rawInput);
  if (!identifier) {
    throw new SteamError('missing_identifier', '请输入 Steam 昵称或 17 位数字 ID。', { status: 400 });
  }
  if (isSteamId64(identifier)) {
    return { steamID: identifier, resolvedFrom: '' };
  }
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(identifier)) {
    throw new SteamError('bad_identifier', '这不是有效的 Steam 昵称或 ID。', { status: 400 });
  }

  const key = apiKey || serverKey();
  if (key) {
    const steamID = await resolveVanityKeyed(identifier, key);
    if (steamID) return { steamID, resolvedFrom: identifier };
  }

  // No key, or the keyed call came back empty: try the public XML endpoint.
  const steamID = await resolveVanityKeyless(identifier);
  if (steamID) return { steamID, resolvedFrom: identifier };

  if (!key) {
    throw new SteamError('no_key', '没有配置 Steam API 密钥，无法把昵称解析成 ID。', {
      status: 503,
      hint: '直接使用 17 位 steamID64，或在首页填入自己的 Steam API 密钥。',
    });
  }
  throw new SteamError('not_found', 'Steam 上没有这个昵称。', { status: 404 });
}

function toGame(entry) {
  const appid = Number(entry.appid ?? entry.appID ?? entry.app_id ?? 0);
  if (!Number.isInteger(appid) || appid <= 0) return null;
  const minutes = Number(entry.playtime_forever ?? entry.minutes ?? 0) || 0;
  const recent = Number(entry.playtime_2weeks ?? entry.hoursLast2Weeks ?? 0) || 0;
  return {
    appid,
    name: typeof entry.name === 'string' ? entry.name : '',
    playtime_forever: Math.max(0, Math.round(minutes)),
    playtime_2weeks: Math.max(0, Math.round(recent)),
  };
}

async function fetchOwnedGamesKeyed(steamID, key) {
  const params = new URLSearchParams({
    key,
    steamid: steamID,
    include_appinfo: '1',
    include_played_free_games: '1',
    format: 'json',
  });
  const response = await request(`${API_BASE}/IPlayerService/GetOwnedGames/v1/?${params}`, { key });

  if (response.status === 401 || response.status === 403) {
    throw new SteamError('bad_key', 'Steam API 密钥被拒绝。', {
      status: 401,
      hint: '确认密钥来自 steamcommunity.com/dev/apikey，并且没有多余空格。',
    });
  }
  if (response.status === 429) {
    throw new SteamError('rate_limited', 'Steam API 触发了限流。', {
      status: 429,
      hint: '等一分钟再试，或换一个密钥。',
    });
  }
  if (!response.ok) {
    throw new SteamError('api_error', `Steam API 返回 ${response.status}。`, { status: 502 });
  }

  const payload = await response.json().catch(() => null);
  const body = payload?.response ?? {};
  const games = Array.isArray(body.games) ? body.games.map(toGame).filter(Boolean) : [];
  if (!games.length) {
    throw new SteamError('private', '这个资料没有公开的游戏记录。', {
      status: 403,
      hint: '把「游戏详情」设为公开，并取消勾选「始终将我的游戏总时长保持私密」。',
    });
  }
  return games;
}

/** Reads the public games page: prefers the embedded rgGames JSON, then XML. */
async function fetchOwnedGamesKeyless(steamID) {
  const response = await request(`${COMMUNITY_BASE}/profiles/${steamID}/games?tab=all&xml=1`);
  if (!response.ok) {
    throw new SteamError('api_error', `Steam 社区返回 ${response.status}。`, { status: 502 });
  }
  const text = await response.text();

  // 2024 年之后，未登录访问 /games 一律跳登录页，这条路基本只剩理论上可用
  const loginWall = /<title>\s*Sign In\s*<\/title>|id="login_form"|global_header.*login/i.test(text);
  if (loginWall) {
    throw new SteamError('login_required', 'Steam 现在要求登录才给看游戏列表。', {
      status: 401,
      hint: '配置 STEAM_API_KEY（或在前端填入自己的密钥），走官方接口才能读到时长。',
    });
  }

  const privateHit = /profile is private|游戏详情.*私密|this profile is private/i.test(text);

  const jsonMatch = text.match(/(?:var|let|const)\s+(?:g_)?rgGames\s*=\s*(\[[\s\S]*?\]);/);
  if (jsonMatch) {
    try {
      const list = JSON.parse(jsonMatch[1]);
      const games = list.map(toGame).filter(Boolean);
      if (games.length) return games;
    } catch {
      /* fall through to XML */
    }
  }

  const xmlGames = [...text.matchAll(/<game>([\s\S]*?)<\/game>/gi)].map(([, block]) => {
    const hours = Number(parseXmlTag(block, 'hoursOnRecord').replace(/,/g, '') || 0) || 0;
    const recent = Number(parseXmlTag(block, 'hoursLast2Weeks').replace(/,/g, '') || 0) || 0;
    return {
      appid: Number(parseXmlTag(block, 'appID')) || 0,
      name: parseXmlTag(block, 'name'),
      playtime_forever: Math.round(hours * 60),
      playtime_2weeks: Math.round(recent * 60),
    };
  });
  if (xmlGames.length) return xmlGames.map(toGame).filter(Boolean);

  throw new SteamError('private', privateHit ? '这个资料的游戏详情是私密的。' : '没有拿到任何游戏记录。', {
    status: 403,
    hint: '把「游戏详情」设为公开，并取消勾选「始终将我的游戏总时长保持私密」。',
  });
}

export async function fetchLibrary(steamID, { apiKey = '' } = {}) {
  const key = apiKey || serverKey();
  if (key) {
    try {
      return { games: await fetchOwnedGamesKeyed(steamID, key), source: 'web-api' };
    } catch (error) {
      // A private profile is a real answer; anything else is worth retrying keylessly.
      if (error.code === 'private' || error.code === 'bad_key') throw error;
      if (!apiKey) {
        const games = await fetchOwnedGamesKeyless(steamID).catch(() => null);
        if (games?.length) return { games, source: 'community' };
      }
      throw error;
    }
  }
  return { games: await fetchOwnedGamesKeyless(steamID), source: 'community' };
}

/** 昵称（个人资料里显示的名字），取不到就返回空串。 */
export async function fetchPersonaName(steamID, { apiKey = '' } = {}) {
  const key = apiKey || serverKey();
  if (!key) return '';
  try {
    const url = `${API_BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamID)}`;
    const response = await request(url, { key });
    if (!response.ok) return '';
    const payload = await response.json().catch(() => null);
    return payload?.response?.players?.[0]?.personaname || '';
  } catch {
    return '';
  }
}

export async function pingSteam() {  const started = Date.now();
  try {
    const response = await request(`${API_BASE}/ISteamWebAPIUtil/GetServerInfo/v1/`);
    return { reachable: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { reachable: false, status: 0, ms: Date.now() - started, error: error.message };
  }
}

export const endpoints = {
  api: API_BASE,
  community: COMMUNITY_BASE,
  headerUrl: (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
  storeUrl: (appid) => `https://store.steampowered.com/app/${appid}/`,
};
