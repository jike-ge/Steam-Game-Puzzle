// 页面之间共用的零碎：选择器、请求、提示条。

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
    error.code = payload?.error?.code || 'http_error';
    error.hint = payload?.error?.hint || '';
    error.status = response.status;
    throw error;
  }
  return payload;
}

let toastEl = null;
let toastTimer = 0;

export function toast(message, duration = 2600) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.dataset.open = '';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    delete toastEl.dataset.open;
  }, duration);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  }
}

/** 把一段长时间换算成「5,547 小时」或「12.5 小时」，列表和墙标签共用。 */
export function humanHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0 小时';
  if (hours < 10) return `${(Math.round(hours * 10) / 10).toFixed(1)} 小时`;
  return `${Math.round(hours).toLocaleString('zh-CN')} 小时`;
}

export function humanInt(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

export function percent(part, total) {
  if (!total) return '0%';
  const value = (part / total) * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
}
