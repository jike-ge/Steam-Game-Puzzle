// 拼图引擎：把一份游戏列表铺成一面墙。
//
// 每格封面的边长来自时长：span = round(sqrt(1 + (h/max)^1.35 * (S²-1)))。
// 网格用 grid-auto-flow: dense 自动补洞，单个方格里 s×s 的面积正好等于
// s 列 × s 行 —— 因为行高按封面 460:215 的比例从列宽推出来。

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
export const HEADER_ASPECT = 460 / 215;
export const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;

// 封面 URL 带上构建指纹：换版本就换地址，浏览器不会一直用旧的灰图。
// 服务器给封面设了长缓存，靠这个参数失效。
const BUILD_TAG = (document.querySelector('meta[name="app-build"]')?.content || '').trim();
export const headerUrl = (appid) =>
  `/cover/${appid}.jpg${BUILD_TAG && BUILD_TAG !== '{{BUILD}}' ? `?v=${encodeURIComponent(BUILD_TAG)}` : ''}`;
export const remoteHeaderUrl = (appid) => `${STEAM_CDN}/${appid}/header.jpg`;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function formatHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0 小时';
  if (hours < 10) return `${(Math.round(hours * 10) / 10).toFixed(1)} 小时`;
  return `${Math.round(hours).toLocaleString('zh-CN')} 小时`;
}

export function formatInt(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

export function initials(name, appid) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return String(appid);
  if (/[\u3400-\u9fff]/.test(trimmed)) return trimmed.slice(0, 2);
  const words = trimmed.split(/[\s:—-]+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3);
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

/** 把接口返回的游戏整理成渲染用的形状，按时长降序。 */
export function normalizeGames(rawGames, { maxTiles = 900 } = {}) {
  const list = (Array.isArray(rawGames) ? rawGames : [])
    .filter((game) => game && Number.isFinite(Number(game.appid)) && Number(game.playtime_forever) > 0)
    .map((game) => ({
      appid: Number(game.appid),
      name: typeof game.name === 'string' ? game.name : '',
      minutes: Math.max(0, Math.round(Number(game.playtime_forever) || 0)),
      recent: Math.max(0, Math.round(Number(game.playtime_2weeks) || 0)),
    }))
    .map((game) => ({ ...game, hours: game.minutes / 60 }))
    .sort((a, b) => b.minutes - a.minutes || a.appid - b.appid);

  const trimmed = list.slice(0, maxTiles);
  const totalMinutes = trimmed.reduce((sum, game) => sum + game.minutes, 0);
  return {
    games: trimmed,
    hiddenCount: list.length - trimmed.length,
    totalMinutes,
    totalHours: totalMinutes / 60,
  };
}

function buildSpans(weights, maxWeight, columns) {
  const spans = new Uint8Array(weights.length);
  const maxSpan = clamp(Math.floor(columns / 6) + 3, 4, Math.min(columns, 12));
  for (let i = 0; i < weights.length; i += 1) {
    const ratio = weights[i] / maxWeight;
    const area = 1 + Math.pow(ratio, 1.35) * (maxSpan * maxSpan - 1);
    spans[i] = clamp(Math.round(Math.sqrt(area)), 1, maxSpan);
  }
  if (weights.length && maxSpan > 1) {
    spans[0] = maxSpan;
    const limit = Math.min(3, weights.length);
    for (let i = 1; i < limit; i += 1) {
      const ratio = weights[i] / maxWeight;
      if (ratio < 0.5) continue;
      const target = Math.round(1 + ratio * (maxSpan - 1));
      spans[i] = clamp(target, spans[i], maxSpan - i);
    }
  }
  return spans;
}

function wallHeight(spans, columns, width, gap) {
  let area = 0;
  for (let i = 0; i < spans.length; i += 1) area += spans[i] * spans[i];
  const columnWidth = Math.max((width - gap * (columns - 1)) / columns, 1);
  const rowHeight = Math.max(columnWidth / HEADER_ASPECT, 6);
  // 网格要占整数行，按向下取整的密度估算会低估，这里直接向上取整
  const rows = Math.max(1, Math.ceil(area / columns));
  return { height: rows * (rowHeight + gap) - gap, rowHeight, columnWidth, rows };
}

/** 选列数：在能塞进可用高度的前提下，尽量让每一格更大。 */
function solveLayout(items, width, fitHeight, gap) {
  const count = items.length;
  const weights = new Float64Array(count);
  let maxWeight = 1e-4;
  for (let i = 0; i < count; i += 1) {
    const weight = Math.pow(Math.max(items[i].hours, 0) + 0.1, 0.62);
    weights[i] = weight;
    if (weight > maxWeight) maxWeight = weight;
  }

  const minColumns = Math.max(4, Math.ceil(width / 240));
  const maxColumns = Math.max(minColumns, Math.min(72, count));
  const available = Math.max(fitHeight || 0, 320);

  const evaluate = (columns) => {
    const spans = buildSpans(weights, maxWeight, columns);
    const geometry = wallHeight(spans, columns, width, gap);
    return { columns, spans, ...geometry };
  };

  // 二分：最小可行列数（列数越多，墙越矮）
  let best = null;
  let low = minColumns;
  let high = maxColumns;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = evaluate(mid);
    if (candidate.height <= available * 1.005) {
      best = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (!best) return evaluate(maxColumns);

  // 已经能塞下，就继续减少列数，直到下一档塞不下为止 —— 格子更大更好看
  let columns = best.columns;
  while (columns > minColumns) {
    const candidate = evaluate(columns - 1);
    if (candidate.height > available * 1.005) break;
    best = candidate;
    columns -= 1;
  }

  // 最后一档常常会空出一条边：把行高按剩余高度补齐，避免底部留黑边
  const rowCount = Math.max(1, best.rows);
  const targetRow = (available + gap) / rowCount - gap;
  const factor = targetRow / best.rowHeight;
  if (Number.isFinite(factor) && factor > 1.002 && factor < 1.22) {
    best.height = rowCount * (targetRow + gap) - gap;
    best.rowHeight = targetRow;
  }

  return best;
}

/**
 * @param {HTMLElement} container
 * @param {{ onActive?: (game: any, index: number) => void, onIdle?: () => void,
 *           fitHeight?: () => number, maxTiles?: number, reveal?: boolean }} options
 */
export function createMosaic(container, options = {}) {
  const { onActive, onIdle, fitHeight, maxTiles = 900, reveal = true } = options;

  let games = [];
  let totalMinutes = 0;
  let tiles = [];
  let activeIndex = -1;
  let frame = 0;
  let revealed = false;
  let lastKey = '';

  const observer = new ResizeObserver(() => schedule(false));
  observer.observe(container);

  function measure() {
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const width = Math.max(1, Math.floor(rect.width));
    const available =
      typeof fitHeight === 'function' ? Math.max(320, Math.floor(fitHeight())) : Math.max(320, Math.floor(rect.height));
    return { width, available, gap };
  }

  function paint(layout, { rebuild }) {
    const { columns, rowHeight, spans } = layout;
    container.style.setProperty('--columns', String(columns));
    container.style.setProperty('--row', `${Math.round(rowHeight * 100) / 100}px`);

    if (rebuild) {
      const fragment = document.createDocumentFragment();
      tiles = games.map((game, index) => {
        const tile = document.createElement('a');
        tile.className = 'tile';
        tile.href = storeUrl(game.appid);
        tile.target = '_blank';
        tile.rel = 'noopener noreferrer';
        tile.dataset.index = String(index);
        tile.tabIndex = -1;
        // 未加载出来的格子先垫一层暗色，不让墙出现黑洞
        tile.style.setProperty('--h', String((game.appid * 37) % 360));
        tile.setAttribute('aria-label', `${game.name || `App ${game.appid}`}，${formatHours(game.hours)}`);
        if (reveal) tile.style.setProperty('--d', `${Math.min(index * 6, 460)}ms`);

        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.loading = index < 32 ? 'eager' : 'lazy';
        if (index < 10) image.fetchPriority = 'high';
        image.src = headerUrl(game.appid);
        const markLoaded = () => image.classList.add('is-loaded');
        if (image.complete && image.naturalWidth) markLoaded();
        image.addEventListener('load', markLoaded, { once: true });
        // 服务器偶尔会取封面失败（超时之类），隔一会儿再要一次
        let retried = false;
        image.addEventListener('error', () => {
          if (!retried) {
            retried = true;
            setTimeout(() => {
              const base = headerUrl(game.appid);
              image.src = `${base}${base.includes('?') ? '&' : '?'}retry=${Date.now()}`;
            }, 1600);
            return;
          }
          tile.classList.add('is-missing');
          tile.dataset.initial = initials(game.name, game.appid);
          tile.title = game.name || `App ${game.appid}`;
        });
        tile.append(image);
        fragment.append(tile);
        return tile;
      });
      container.replaceChildren(fragment);
      revealed = true;
    }

    for (let i = 0; i < tiles.length; i += 1) {
      const span = spans[i] || 1;
      const tile = tiles[i];
      tile.style.gridColumn = `span ${span}`;
      tile.style.gridRow = `span ${span}`;
    }
  }

  function layout({ force = false } = {}) {
    if (!games.length) {
      container.replaceChildren();
      tiles = [];
      return;
    }
    const { width, available, gap } = measure();
    const key = `${width}:${available}:${games.length}`;
    if (!force && key === lastKey) return;
    lastKey = key;

    const solved = solveLayout(games, width, available, gap);
    const rebuild = tiles.length !== games.length;
    paint(solved, { rebuild });

    // 校准：按真实行数把行高对齐到可用高度，底部不留黑边、也不多出一行
    const pitch = solved.rowHeight + gap;
    const scrollable = container.scrollHeight > container.clientHeight + 1;
    const contentHeight = scrollable
      ? container.scrollHeight
      : solved.rows * pitch - gap;
    const rows = Math.max(1, Math.round((contentHeight + gap) / pitch));
    const fitted = (available + gap) / rows - gap;
    const factor = fitted / solved.rowHeight;
    if (
      Number.isFinite(factor) &&
      factor > 0.9 &&
      factor < 1.3 &&
      Math.abs(contentHeight - available) > 1.5
    ) {
      container.style.setProperty('--row', `${Math.round(fitted * 100) / 100}px`);
    }

    if (rebuild) container.dispatchEvent(new CustomEvent('mosaic:ready', { detail: { columns: solved.columns } }));
  }

  function schedule(force = false) {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => layout({ force }));
  }

  function setActive(tile) {
    if (activeIndex >= 0 && tiles[activeIndex]) tiles[activeIndex].removeAttribute('data-active');
    if (!tile) {
      activeIndex = -1;
      container.removeAttribute('data-hover');
      onIdle?.();
      return;
    }
    const index = Number(tile.dataset.index);
    activeIndex = index;
    tile.setAttribute('data-active', '');
    container.setAttribute('data-hover', '');
    onActive?.(games[index], index);
  }

  container.addEventListener('pointerover', (event) => {
    const tile = event.target.closest?.('.tile');
    if (tile && tile.dataset.index !== String(activeIndex)) setActive(tile);
  });
  container.addEventListener('pointerleave', () => setActive(null));

  async function exportPNG({ scale: requestedScale = 2, onProgress, caption = null } = {}) {
    if (!tiles.length) throw new Error('还没有可导出的拼图。');
    const containerRect = container.getBoundingClientRect();
    const width = Math.round(containerRect.width);
    const height = Math.round(containerRect.height);
    if (width <= 0 || height <= 0) throw new Error('拼图还没有排好。');

    // 底部展签：有内容才占高度
    const captionName = (caption?.name || '').trim();
    const captionStats = (caption?.stats || '').trim();
    const hasCaption = Boolean(captionName || captionStats);
    const bandHeight = hasCaption ? Math.round(Math.max(56, Math.min(110, width * 0.055))) : 0;

    const maxDimension = 8192;
    const totalHeight = height + bandHeight;
    const scale = Math.max(
      1,
      Math.min(requestedScale, maxDimension / width, maxDimension / totalHeight),
    );

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(totalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('这个浏览器不支持 Canvas。');
    context.fillStyle = '#0c0a09';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';

    const rects = tiles.map((tile) => {
      const rect = tile.getBoundingClientRect();
      return {
        image: tile.querySelector('img'),
        x: (rect.left - containerRect.left) * scale,
        y: (rect.top - containerRect.top) * scale,
        w: rect.width * scale,
        h: rect.height * scale,
      };
    });

    let drawn = 0;
    for (let i = 0; i < rects.length; i += 1) {
      const { image, x, y, w, h } = rects[i];
      if (!image) continue;
      try {
        // 懒加载的图可能还没请求过，decode() 会把它拉下来
        if (image.decode) await image.decode().catch(() => {});
        if (!image.naturalWidth) continue;
        // cover crop: 保持封面比例，居中裁切
        const srcAspect = image.naturalWidth / image.naturalHeight;
        const dstAspect = w / h;
        let sx = 0;
        let sy = 0;
        let sw = image.naturalWidth;
        let sh = image.naturalHeight;
        if (srcAspect > dstAspect) {
          sw = sh * dstAspect;
          sx = (image.naturalWidth - sw) / 2;
        } else {
          sh = sw / dstAspect;
          sy = (image.naturalHeight - sh) / 2;
        }
        context.drawImage(image, sx, sy, sw, sh, x, y, w, h);
        drawn += 1;
      } catch {
        /* skip broken tile */
      }
      if (i % 12 === 0) onProgress?.(Math.round((i / rects.length) * 100));
    }

    if (!drawn) throw new Error('没有图片导出成功，检查一下网络。');

    // 底部展签：一条细线，左边名字，右边款数/时长
    if (hasCaption) {
      const bandTop = height * scale;
      const bandPx = bandHeight * scale;
      const pad = Math.round(bandHeight * 0.62 * scale);
      const mid = bandTop + bandPx / 2;

      context.fillStyle = '#141110';
      context.fillRect(0, bandTop, canvas.width, bandPx);
      context.fillStyle = 'rgba(240,233,223,0.16)';
      context.fillRect(0, bandTop, canvas.width, Math.max(1, Math.round(scale)));

      const serif = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", serif';
      const sans = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      context.textBaseline = 'middle';

      // 先量右边，给左边留出空间
      let statsWidth = 0;
      if (captionStats) {
        context.font = `400 ${Math.round(bandHeight * 0.26 * scale)}px ${sans}`;
        statsWidth = context.measureText(captionStats).width;
      }
      const gap = Math.round(bandHeight * 0.5 * scale);
      const maxNameWidth = canvas.width - pad * 2 - (statsWidth ? statsWidth + gap : 0);

      if (captionName) {
        const fontSize = Math.round(bandHeight * 0.40 * scale);
        context.font = `600 ${fontSize}px ${serif}`;
        let text = captionName;
        if (context.measureText(text).width > maxNameWidth) {
          while (text.length > 1 && context.measureText(`${text}…`).width > maxNameWidth) {
            text = text.slice(0, -1);
          }
          text = `${text}…`;
        }
        context.textAlign = 'left';
        context.fillStyle = '#f0e9df';
        context.fillText(text, pad, mid);
      }

      if (captionStats) {
        context.font = `400 ${Math.round(bandHeight * 0.26 * scale)}px ${sans}`;
        context.textAlign = 'right';
        context.fillStyle = 'rgba(240,233,223,0.72)';
        context.fillText(captionStats, canvas.width - pad, mid);
      }
    }

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('导出失败。'))), 'image/png');
    });
    onProgress?.(100);
    return { blob, width: canvas.width, height: canvas.height, drawn };
  }

  return {
    setGames(rawGames) {
      const normalized = normalizeGames(rawGames, { maxTiles });
      games = normalized.games;
      totalMinutes = normalized.totalMinutes;
      tiles = [];
      lastKey = '';
      layout({ force: true });
      return { ...normalized, revealed };
    },
    relayout: () => schedule(true),
    getGames: () => games,
    getTotalMinutes: () => totalMinutes,
    exportPNG,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

export { clamp, solveLayout, buildSpans };
