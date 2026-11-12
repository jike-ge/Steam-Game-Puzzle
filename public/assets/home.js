import { createMosaic, formatHours, formatInt } from './mosaic.js';
import { $, fetchJSON } from './ui.js';

const wallEl = $('#preview-wall');
const captionLeft = $('#caption-left');
const captionRight = $('#caption-right');
const form = $('#lookup');
const input = $('#identifier');
const keyInput = $('#api-key');
const keybox = $('#keybox');
const KEY_STORE = 'steam_api_key';

let totals = { games: 0, hours: 0 };

const mosaic = createMosaic(wallEl, {
  fitHeight: () => wallEl.clientHeight || window.innerHeight,
  onActive: (game) => {
    captionLeft.textContent = game.name || `App ${game.appid}`;
    captionRight.textContent = formatHours(game.hours);
  },
  onIdle: () => {
    captionLeft.textContent = '示例档案';
    captionRight.textContent = totals.games ? `${formatInt(totals.games)} 款，${formatHours(totals.hours)}` : '';
  },
});

try {
  const saved = localStorage.getItem(KEY_STORE) || '';
  if (saved) {
    keyInput.value = saved;
    keybox.open = true;
  }
} catch {
  /* 隐身模式下 localStorage 可能不可用 */
}

/** 与服务器保持一致的输入清洗：整条个人资料链接也能贴进来。 */
function normalize(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 保留原样 */
  }
  const profile = value.match(/steamcommunity\.com\/(?:id|profiles)\/([^/?#]+)/i);
  if (profile) value = profile[1];
  const short = value.match(/s\.team\/p\/([^/?#]+)/i);
  if (short) value = short[1];
  const steam3 = value.match(/^\[?U:1:(\d{1,10})\]?$/i);
  if (steam3) return String(76561197960265728n + BigInt(steam3[1]));
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = normalize(input.value);
  if (!target) {
    input.focus();
    return;
  }
  const key = keyInput.value.trim();
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* 忽略 */
  }
  location.assign(`/${encodeURIComponent(target)}`);
});

(async () => {
  try {
    const key = keyInput.value.trim();
    const demo = await fetchJSON('/api/library/demo', {
      headers: key ? { 'x-steam-api-key': key } : {},
    });
    const result = mosaic.setGames(demo.games);
    totals = { games: result.games.length, hours: result.totalHours };
    captionLeft.textContent = demo.demoFallback ? '示例数据 · 待同步' : '示例档案';
    captionRight.textContent = `${formatInt(totals.games)} 款，${formatHours(totals.hours)}`;
  } catch {
    captionRight.textContent = '示例数据没加载出来';
  }
})();
