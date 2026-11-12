#!/usr/bin/env node
// Steam Game Puzzle — 本地版
// 零依赖：node server.mjs 就能跑起来。

import './lib/env.mjs'; // 必须第一个：后面几个模块在 import 时就会读环境变量

import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  endpoints,
  fetchLibrary,
  fetchPersonaName,
  hasServerKey,
  normalizeIdentifier,
  resolveIdentifier,
  SteamError,
} from './lib/steam.mjs';
import { getLibrary, listEntries, readEntry, saveEntry, CACHE_DIR } from './lib/store.mjs';
import { COVER_DIR, COVER_SOURCE, coverStats, getCover, warmCovers } from './lib/covers.mjs';
import { enrichNames, nameStats, setOverride, warmNames } from './lib/names.mjs';
import { detectProxy, proxyState } from './lib/http.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// 封面 ETag 缓存：appid -> 内容指纹，避免每次请求都重算 sha1
const coverEtags = new Map();

// 部署后用它确认线上跑的是哪一版：curl /api/health | grep version
const VERSION = await fs
  .readFile(path.join(ROOT, 'package.json'), 'utf8')
  .then((raw) => JSON.parse(raw.replace(/^\uFEFF/, '')).version || '0.0.0')
  .catch(() => '0.0.0');

/**
 * 把 server.mjs / lib / public 全部算一个短哈希。
 * 页面上的版本号、/api/health 里的 build 都指向它——
 * 只要有一个文件没更新，这个哈希就对不上，不用再猜。
 */
const BUILD = await (async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  try {
    await walk(PUBLIC_DIR);
    await walk(path.join(ROOT, 'lib'));
    files.push(path.join(ROOT, 'server.mjs'));
  } catch {
    return 'unknown';
  }
  files.sort();
  const hash = crypto.createHash('sha1');
  for (const file of files) {
    hash.update(path.relative(ROOT, file).split(path.sep).join('/'));
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex').slice(0, 8);
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const demoLibraryPath = path.join(DATA_DIR, 'demo-library.json');
let demoPromise = null;
async function loadDemo() {
  if (!demoPromise) {
    demoPromise = fs
      .readFile(demoLibraryPath, 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
  }
  return demoPromise;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

// 不带 / 的保留路径，不当成玩家昵称（带扩展名的文件由静态分支处理）
const RESERVED_PATHS = new Set(['leaderboard', 'api', 'assets', 'cover']);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const fail = (res, error) => {
  const steam = error instanceof SteamError;
  const status = steam ? error.status : 500;
  if (!steam) console.error(error);
  json(res, status, {
    error: {
      code: steam ? error.code : 'internal',
      message: steam ? error.message : '服务器内部错误。',
      hint: steam ? error.hint : '',
    },
  });
};

const insidePublic = (target) =>
  target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + path.sep);

async function readPublic(relative) {
  const target = path.resolve(PUBLIC_DIR, '.' + relative);
  if (!insidePublic(target)) return null;
  try {
    return { target, content: await fs.readFile(target) };
  } catch {
    return null;
  }
}

/** Serves an HTML page with {{TOKENS}} replaced. */
async function servePage(res, file, tokens = {}, status = 200) {
  const asset = await readPublic(file);
  if (!asset) return json(res, 404, { error: { code: 'not_found', message: '页面不存在。' } });
  let html = asset.content.toString('utf8');
  for (const [token, value] of Object.entries(tokens)) {
    html = html.split(`{{${token}}}`).join(value);
  }
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(html);
}

function statics(req, res, pathname) {
  const target = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(pathname));
  if (!insidePublic(target)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const ext = path.extname(target);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    // 自建小站，更新比省那几 KB 重要：每次都回源验证，改完刷新就生效
    'cache-control': 'no-cache',
  });
  createReadStream(target)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    })
    .pipe(res);
}

/** 封面：本地有就直接给，没有就去 Steam 取一张存下来。 */
async function serveCover(req, res, appid) {
  const buffer = await getCover(appid);
  if (!buffer) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('cover not found');
    return;
  }

  // 内容指纹做 ETag：同一个 appid 的图换了，浏览器才会重新下载
  let etag = coverEtags.get(appid);
  if (!etag) {
    etag = `"${buffer.length.toString(16)}-${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12)}"`;
    coverEtags.set(appid, etag);
  }

  const cacheHeaders = {
    'content-type': 'image/jpeg',
    etag,
    'cache-control': 'public, max-age=604800',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, cacheHeaders);
    return res.end();
  }

  res.writeHead(200, { ...cacheHeaders, 'content-length': buffer.length });
  if (req.method === 'HEAD') return res.end();
  res.end(buffer);
}

// /demo 用哪个账号：填了就现场取一次存进缓存，没填就用仓库里自带的示例墙
const DEMO_STEAM_ID = (process.env.DEMO_STEAM_ID || '').trim();

const readApiKey = (req, url) =>
  (url.searchParams.get('api_key') || '').trim() ||
  String(req.headers['x-steam-api-key'] || '').trim();

// 允许在页面上手填中文名（默认关，公开站点建议保持关闭）
const CAN_EDIT_NAMES = /^(1|on|true|yes)$/i.test(process.env.NAME_EDIT || '');

/** 读一个小的 JSON 请求体。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleDemo(req, res, url) {
  const apiKey = readApiKey(req, url);
  const force = url.searchParams.get('refresh') === '1';
  const cached = DEMO_STEAM_ID ? await readEntry(DEMO_STEAM_ID) : null;

  if (cached?.games?.length && !force) {
    warmCovers(cached.games.map((game) => game.appid));
    const names = await enrichNames(cached.games);
    if (names.missing.length) warmNames(names.missing.slice(0, 400));
    return json(res, 200, {
      ...cached,
      steamID: DEMO_STEAM_ID,
      demo: true,
      cached: true,
      stale: false,
      namesPending: names.pending,
      canEditNames: CAN_EDIT_NAMES,
      profile: { steamID: DEMO_STEAM_ID, name: cached.displayName || '示例档案', demo: true },
    });
  }

  let fetchError = null;
  if (DEMO_STEAM_ID && (apiKey || hasServerKey())) {
    try {
      const library = await getLibrary(DEMO_STEAM_ID, { apiKey, force });
      const persona = await fetchPersonaName(DEMO_STEAM_ID, { apiKey });
      const entry = {
        ...library,
        steamID: DEMO_STEAM_ID,
        displayName: persona || cached?.displayName || '示例档案',
        demo: true,
      };
      await saveEntry(entry);
      warmCovers(library.games.map((game) => game.appid));
      const names = await enrichNames(entry.games);
      if (names.missing.length) warmNames(names.missing.slice(0, 400));
      return json(res, 200, {
        ...entry,
        demo: true,
        cached: false,
        stale: false,
        namesPending: names.pending,
        canEditNames: CAN_EDIT_NAMES,
        profile: { steamID: DEMO_STEAM_ID, name: entry.displayName, demo: true },
      });
    } catch (error) {
      fetchError = error;
      console.warn('示例档案取数失败：', error.message);
    }
  }

  // 还没有密钥 / 取不到：退回打包在仓库里的示例，并在页面上标出来
  const fallback = await loadDemo();
  if (!fallback) return json(res, 500, { error: { code: 'demo_missing', message: '示例数据缺失。' } });

  warmCovers(fallback.games.map((game) => game.appid));
  const fallbackNames = await enrichNames(fallback.games);
  if (fallbackNames.missing.length) warmNames(fallbackNames.missing.slice(0, 400));

  return json(res, 200, {
    ...fallback,
    namesPending: fallbackNames.pending,
    canEditNames: CAN_EDIT_NAMES,
    steamID: DEMO_STEAM_ID || 'demo',
    demo: true,
    demoFallback: Boolean(DEMO_STEAM_ID),
    demoSteamID: DEMO_STEAM_ID || undefined,
    demoReason: !DEMO_STEAM_ID
      ? '还没指定示例账号（DEMO_STEAM_ID），这里用的是仓库自带的示例数据。'
      : fetchError
        ? fetchError.message
        : '服务器没有配置 Steam API 密钥，读不到这个账号的游戏库。',
    cached: true,
    stale: false,
    profile: { steamID: DEMO_STEAM_ID || 'demo', name: fallback.displayName, demo: true },
  });
}

async function handleLibrary(res, url, identifier) {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) {
    throw new SteamError('missing_identifier', '请输入 Steam 昵称或 17 位数字 ID。', { status: 400 });
  }
  if (normalized === 'demo') return handleDemo(res.req, res, url);
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(normalized)) {
    throw new SteamError('bad_identifier', '这不是有效的 Steam 昵称或 ID。', { status: 400 });
  }

  const apiKey = readApiKey(res.req, url);

  const { steamID, resolvedFrom } = await resolveIdentifier(normalized, { apiKey });
  const library = await getLibrary(steamID, { apiKey, force: url.searchParams.get('refresh') === '1' });

  // 顺手把封面取回来，等浏览器开始要的时候大多已经在本机了
  if (!library.stale) warmCovers(library.games.slice(0, 200).map((game) => game.appid));

  // 中文名：先用手上有的，缺的后台补齐
  const names = await enrichNames(library.games);
  if (names.missing.length) warmNames(names.missing.slice(0, 400));

  // 显示名尽量用 Steam 昵称，别只给一串数字 ID
  let displayName = library.displayName || '';
  if (!displayName) {
    const persona = await fetchPersonaName(steamID, { apiKey });
    if (persona) {
      displayName = persona;
      saveEntry({ ...library, steamID, displayName, gameCount: library.games.length }).catch(() => {});
    }
  }

  return json(res, 200, {
    ...library,
    steamID,
    displayName,
    resolvedFrom,
    namesPending: names.pending,
    canEditNames: CAN_EDIT_NAMES,
    keySource: apiKey ? 'user' : hasServerKey() ? 'server' : 'none',
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  res.req = req;

  try {
    const coverMatch = pathname.match(/^\/cover\/(\d{1,10})\.jpg$/);
    if (coverMatch) return await serveCover(req, res, coverMatch[1]);

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/library/demo') return handleDemo(req, res, url);
      if (pathname === '/api/health') {
        const entries = await listEntries();
        const wanted = new Set();
        for (const entry of entries) {
          for (const game of entry.games || []) {
            if (game?.playtime_forever > 0) wanted.add(Number(game.appid));
          }
        }
        const missingCovers = [];
        for (const appid of wanted) {
          if (missingCovers.length >= 60) break;
          try {
            await fs.access(path.join(COVER_DIR, `${appid}.jpg`));
          } catch {
            missingCovers.push(appid);
          }
        }
        return json(res, 200, {
          ok: true,
          version: VERSION,
          build: BUILD,
          configured: hasServerKey(),
          endpoints,
          proxy: proxyState(),
          demoSteamID: DEMO_STEAM_ID,
          cacheDir: CACHE_DIR,
          coverDir: COVER_DIR,
          covers: await coverStats(),
          names: await nameStats(),
          coverSource: COVER_SOURCE,
          trackedGames: wanted.size,
          missingCovers,
          cachedProfiles: entries.length,
          demo: Boolean(await loadDemo()),
        });
      }
      if (pathname === '/api/names' && req.method === 'POST') {
        if (!CAN_EDIT_NAMES) {
          return json(res, 403, {
            error: { code: 'name_edit_off', message: '名字编辑没开启。启动时加 NAME_EDIT=1。' },
          });
        }
        const raw = await readBody(req).catch(() => '');
        let body = null;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = null;
        }
        const appid = Number(body?.appid);
        if (!Number.isInteger(appid) || appid <= 0) {
          return json(res, 400, { error: { code: 'bad_appid', message: 'appid 不对。' } });
        }
        const zh = await setOverride(appid, body?.zh);
        return json(res, 200, { ok: true, appid, name_zh: zh, canEditNames: true });
      }
      if (pathname.startsWith('/api/library/')) {
        const identifier = decodeURIComponent(pathname.slice('/api/library/'.length));
        return await handleLibrary(res, url, identifier);
      }
      return json(res, 404, { error: { code: 'not_found', message: '接口不存在。' } });
    }

    if (pathname === '/' || pathname === '/index.html') {
      return servePage(res, '/index.html', { VERSION, BUILD });
    }

    // 带扩展名的先当静态文件找，找不到就当不存在（别把 miss.jpg 当成玩家昵称）
    if (path.extname(pathname)) {
      if (pathname.endsWith('.html')) return servePage(res, '/404.html', { VERSION, BUILD }, 404);
      const asset = await readPublic(pathname);
      if (asset) return statics(req, res, pathname);
      if (/\.(css|m?js|jpe?g|png|gif|svg|ico|webp|woff2?|map|txt|json)$/i.test(pathname)) {
        return servePage(res, '/404.html', { VERSION, BUILD }, 404);
      }
    }

    // 没有扩展名的保留路径：这些不是 Steam ID，直接当不存在
    if (RESERVED_PATHS.has(pathname.slice(1).toLowerCase())) {
      return servePage(res, '/404.html', { VERSION, BUILD }, 404);
    }

    const identifier = normalizeIdentifier(pathname.slice(1));
    if (!identifier) return servePage(res, '/index.html', { VERSION, BUILD });
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(identifier)) {
      const demo = identifier === 'demo' ? await loadDemo() : null;
      const title = demo ? `${demo.displayName} · Steam Game Puzzle` : `${identifier} · Steam Game Puzzle`;
      return servePage(res, '/profile.html', {
        IDENTIFIER: escapeHtml(identifier),
        TITLE: escapeHtml(title),
        VERSION,
        BUILD,
      });
    }

    return servePage(res, '/404.html', { VERSION, BUILD }, 404);
  } catch (error) {
    if (res.headersSent) return res.end();
    return fail(res, error);
  }
});

// 先把代理探测完再开始收请求，免得头几个请求走了直连
const proxy = await detectProxy();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  // 第一行就是版本号，方便 docker logs 一眼确认
  console.log(`  Steam Game Puzzle v${VERSION}+${BUILD}`);
  console.log(`  ${url}`);
  console.log(
    `  Steam 代理：${proxy ? `${proxy.url.origin}（${proxy.source}）` : '直连（没检测到代理，可用 STEAM_PROXY 指定）'}`,
  );
  console.log(`  Steam API 密钥：${hasServerKey() ? '已从环境变量读取' : '未配置（可在页面里填自己的）'}`);
  console.log(`  示例档案：${DEMO_STEAM_ID || '仓库自带的示例数据'}`);
  console.log('');
});
