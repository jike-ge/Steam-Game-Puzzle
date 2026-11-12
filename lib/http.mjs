// 走本机代理发请求。
// Steam 的接口在国内大多连不通，很多机器上跑着 Clash / V2Ray（常见端口 7890）。
// 这里用 HTTP CONNECT 建隧道，再把 TLS 套上去，所以只需要一个 HTTP 代理地址。

import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';

let current = null; // { url: URL, source: string } | null
let resolved = false;

const TIMEOUT = 15_000;

function parseOff(value) {
  return /^(off|none|0|false|no|direct)$/i.test(String(value || '').trim());
}

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = '80';
    return url;
  } catch {
    return null;
  }
}

function fromEnv() {
  if (process.env.STEAM_PROXY !== undefined) {
    if (parseOff(process.env.STEAM_PROXY) || !process.env.STEAM_PROXY.trim()) {
      return { url: null, source: 'STEAM_PROXY 已关闭' };
    }
    return { url: normalizeProxyUrl(process.env.STEAM_PROXY), source: 'STEAM_PROXY' };
  }
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = (process.env[name] || '').trim();
    if (!value || parseOff(value)) continue;
    return { url: normalizeProxyUrl(value), source: name };
  }
  return null;
}

/** 端口开着就算有代理，用来兜底发现本机的 7890。 */
function portOpen(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 启动时调一次：环境变量优先，其次看看本机有没有常见代理端口。 */
export async function detectProxy() {
  if (resolved) return current;
  resolved = true;

  const env = fromEnv();
  if (env) {
    current = env.url ? env : null;
    return current;
  }

  for (const port of [7890, 7897, 1087, 10809, 8889, 1080]) {
    if (await portOpen('127.0.0.1', port)) {
      current = { url: new URL(`http://127.0.0.1:${port}`), source: `本机 127.0.0.1:${port}` };
      return current;
    }
  }
  current = null;
  return current;
}

export function proxyState() {
  if (!current) return { enabled: false, url: '', source: '直连' };
  return { enabled: true, url: current.url.origin, source: current.source };
}

function tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${port}`;
    const headers = { host: authority, 'proxy-connection': 'keep-alive' };
    if (proxy.username) {
      const token = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString('base64');
      headers['proxy-authorization'] = `Basic ${token}`;
    }
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: authority,
      headers,
      timeout: TIMEOUT,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝了 CONNECT（${response.statusCode}）`));
        return;
      }
      resolve(socket);
    });
    request.once('timeout', () => request.destroy(new Error('代理连接超时')));
    request.once('error', reject);
    request.end();
  });
}

async function proxyRequest(url, { method = 'GET', headers = {}, timeout = TIMEOUT } = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));
  const raw = await tunnel(current.url, target.hostname, port);

  let socket = raw;
  if (secure) {
    socket = await new Promise((resolve, reject) => {
      const secureSocket = tls.connect({ socket: raw, servername: target.hostname }, () => resolve(secureSocket));
      secureSocket.once('error', (error) => {
        raw.destroy();
        reject(error);
      });
    });
  }

  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const request = http.request(
      {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: { host: target.hostname, ...headers },
        agent,
        timeout,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          agent.destroy();
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            viaProxy: true,
          });
        });
      },
    );
    request.once('timeout', () => request.destroy(new Error('请求超时')));
    request.once('error', (error) => {
      agent.destroy();
      reject(error);
    });
    request.end();
  });
}

/**
 * 统一的取数入口：配了代理走隧道，没配就直接 fetch。
 * 返回 { status, headers, body: Buffer }。
 */
export async function httpGet(url, { headers = {}, timeout = TIMEOUT } = {}) {
  if (!resolved) await detectProxy();

  if (current) {
    return proxyRequest(url, { headers, timeout });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers), body, viaProxy: false };
  } finally {
    clearTimeout(timer);
  }
}

export const PROXY_TIMEOUT = TIMEOUT;
