import { createMosaic } from './mosaic.js';
import { $, fetchJSON, toast, copyText, humanHours, humanInt, percent } from './ui.js';

const identifier = document.body.dataset.identifier || decodeURIComponent(location.pathname.slice(1));
// 这几种错误都是「没有可用密钥」，直接在错误页给一个输入框
const KEY_ERROR_CODES = new Set(['login_required', 'no_key', 'bad_key']);
const wallEl = $('#wall');
const skeleton = $('#skeleton');
const skeletonGrid = $('#skeleton-grid');
const mainEl = $('#main');
const nameEl = $('#who-name');
const metaEl = $('#who-meta');
const barEl = document.querySelector('.profile-bar');
const downloadBtn = $('#download');
const downloadText = downloadBtn.querySelector('.btn__text');
const copyBtn = $('#copy-link');
const listToggle = $('#list-toggle');
const listView = $('#list-view');
const listTable = $('#list-table');
const listNote = $('#list-note');
const placard = $('#placard');
const placardName = $('#placard-name');
const placardHours = $('#placard-hours');
const placardShare = $('#placard-share');
const placardRecent = $('#placard-recent');
const placardBar = $('#placard-bar');

const apiKey = (() => {
  try {
    return localStorage.getItem('steam_api_key') || '';
  } catch {
    return '';
  }
})();
const currentKey = apiKey;
const wantsRefresh = new URLSearchParams(location.search).get('refresh') === '1';

let displayName = identifier;
let topMinutes = 1;
let lastResult = null;

// 导出展签的勾选项，存在本地
const EXPORT_STORE = 'panorama_export_options';
const exportOptions = (() => {
  const fallback = { name: true, count: true, hours: true };
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_STORE) || 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      name: saved.name !== false,
      count: saved.count !== false,
      hours: saved.hours !== false,
    };
  } catch {
    return fallback;
  }
})();

function saveExportOptions() {
  try {
    localStorage.setItem(EXPORT_STORE, JSON.stringify(exportOptions));
  } catch {
    /* 隐身模式 */
  }
}

/** 按勾选项拼出展签：名字 + 「110 款游戏，24,425 小时」 */
function buildCaption() {
  if (!lastResult) return null;
  const stats = [];
  if (exportOptions.count) stats.push(`${humanInt(lastResult.games.length)} 款游戏`);
  if (exportOptions.hours) stats.push(humanHours(lastResult.totalHours));
  return {
    name: exportOptions.name ? displayName : '',
    stats: stats.join('，'),
  };
}

// 骨架：先给一面假墙，避免白屏
(() => {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 54; i += 1) {
    const cell = document.createElement('i');
    const size = i < 4 ? 4 : i < 12 ? 2 : 1 + ((i * 7) % 2);
    cell.style.setProperty('--c', String(size));
    fragment.append(cell);
  }
  skeletonGrid.append(fragment);
})();

const mosaic = createMosaic(wallEl, {
  fitHeight: () => window.innerHeight - (barEl?.offsetHeight || 64) - 2,
  onActive: showPlacard,
  onIdle: hidePlacard,
});

wallEl.addEventListener(
  'mosaic:ready',
  () => {
    skeleton?.remove();
  },
  { once: true },
);

function showPlacard(game, index) {
  placardName.textContent = game.name || `App ${game.appid}`;
  placardHours.textContent = humanHours(game.hours);
  placardShare.textContent = `占全部 ${percent(game.minutes, mosaic.getTotalMinutes())}`;
  placardRecent.textContent = game.recent > 0 ? `近两周 ${humanHours(game.recent / 60)}` : '';
  const relative = Math.max(4, Math.round((game.minutes / topMinutes) * 100));
  placardBar.style.setProperty('--w', `${relative}%`);
  placard.dataset.open = '';
  placard.dataset.index = String(index);
}

function hidePlacard() {
  delete placard.dataset.open;
}

function setMeta(result) {
  const top = result.games[0];
  const fragment = document.createDocumentFragment();
  fragment.append(`${humanInt(result.games.length)} 款游戏，`);
  const hours = document.createElement('b');
  hours.textContent = humanHours(result.totalHours);
  fragment.append(hours);
  if (top?.name) {
    fragment.append('，最常玩 ');
    const topEl = document.createElement('b');
    topEl.textContent = top.name;
    fragment.append(topEl);
  }
  if (result.hiddenCount > 0) {
    fragment.append(`（只画了前 ${result.games.length} 款）`);
  }
  metaEl.replaceChildren(fragment);
}

function buildList(result) {
  const total = result.totalMinutes || 1;
  const fragment = document.createDocumentFragment();
  result.games.forEach((game, index) => {
    const row = document.createElement('tr');

    const rank = document.createElement('td');
    rank.className = 'rank';
    rank.textContent = String(index + 1);

    const name = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'player';
    link.href = `https://store.steampowered.com/app/${game.appid}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = game.name || `App ${game.appid}`;
    name.append(link);

    const hours = document.createElement('td');
    hours.className = 'figure';
    const strong = document.createElement('b');
    strong.textContent = humanHours(game.hours);
    hours.append(strong);

    const share = document.createElement('td');
    share.className = 'figure';
    share.textContent = percent(game.minutes, total);

    const recent = document.createElement('td');
    recent.className = 'figure top-game';
    recent.textContent = game.recent > 0 ? humanHours(game.recent / 60) : '—';

    row.append(rank, name, hours, share, recent);
    fragment.append(row);
  });
  listTable.tBodies[0].replaceChildren(fragment);
  listNote.textContent = `${humanInt(result.games.length)} 款，按时长从多到少排列`;
}

function applyPayload(payload) {
  const games = Array.isArray(payload.games) ? payload.games : [];
  if (!games.length) {
    renderError({
      code: 'empty',
      message: '这个库里没有带时长的游戏。',
      hint: '完全没玩过的游戏不会出现在墙上。',
    });
    return;
  }

  displayName = payload.displayName || payload.resolvedFrom || payload.steamID || identifier;
  nameEl.textContent = displayName;
  document.title = `${displayName} · Steam Game Puzzle`;
  document.querySelectorAll('.who .badge').forEach((node) => node.remove());
  if (payload.demo) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = payload.demoFallback ? '示例数据 · 待同步' : '示例数据';
    if (payload.demoFallback) {
      badge.title = `还没有同步 ${payload.demoSteamID || ''} 的真实游戏库`;
    }
    nameEl.after(badge);
  }

  const result = mosaic.setGames(games);
  lastResult = result;
  topMinutes = Math.max(1, result.games[0]?.minutes || 1);
  setMeta(result);
  buildList(result);

  downloadBtn.disabled = false;
  listToggle.disabled = false;

  if (payload.demoFallback) {
    toast(
      `${payload.demoSteamID || '这个账号'} 的真实游戏库还没同步：${payload.demoReason || '需要 Steam API 密钥'}。`,
      6500,
    );
  }
  if (result.hiddenCount > 0) {
    toast(`游戏太多，墙上只画了时长最高的 ${result.games.length} 款。`, 4200);
  }
  if (payload.warning) toast(payload.warning, 5200);
}

function errorCopy(error) {
  const code = error?.code || 'unknown';  const map = {
    not_found: {
      title: '没找到这个玩家',
      body: `Steam 上没有叫「${identifier}」的玩家。`,
      hint: '检查一下拼写，或者直接用 17 位数字 ID。',
      actions: [
        { label: '去 steamid.io 查 ID', href: 'https://steamid.io/lookup', external: true },
        { label: '换一个试试', href: '/' },
      ],
    },
    bad_identifier: {
      title: '这个 ID 看起来不对',
      body: 'Steam 昵称只能是字母、数字、下划线和点；数字 ID 必须是 17 位。',
      actions: [{ label: '重新输入', href: '/' }],
    },
    missing_identifier: {
      title: '还没输入 Steam ID',
      body: '回首页填一个昵称或 17 位数字 ID 就可以生成。',
      actions: [{ label: '回首页', href: '/' }],
    },
    private: {
      title: '这个库是私密的',
      body: '玩家没有把游戏详情公开，所以读不到时长。',
      hint: '如果这是你自己：编辑个人资料 → 我的隐私设置 → 游戏详情改成公开，并取消勾选「始终将我的游戏总时长保持私密」。',
      actions: [
        { label: '打开 Steam 隐私设置', href: 'https://steamcommunity.com/my/edit/settings', external: true },
        { label: '看看示例档案', href: '/demo' },
      ],
    },
    login_required: {
      title: '这个站还没配置密钥',
      body: 'Steam 现在要求登录才能看游戏列表，免登录那条路已经不通了。',
      hint: '去 steamcommunity.com/dev/apikey 免费申请一个，填在下面；想让所有访客都不用填，就写进服务器的 .env。',
      actions: [
        { label: '重试', href: '?' },
        { label: '先看示例档案', href: '/demo' },
      ],
    },
    no_key: {
      title: '昵称没法解析成 ID',
      body: '没配置密钥时，昵称只能走 Steam 公开页面解析，这次没走通。',
      hint: '直接用 17 位数字 ID 最稳；也可以把密钥填在下面，以后昵称和游戏库都走官方接口。',
      actions: [{ label: '重试', href: '?' }],
    },
    bad_key: {
      title: '这个 API 密钥被拒绝了',
      body: error.message || 'Steam 不认这个密钥。',
      hint: '确认它是从 steamcommunity.com/dev/apikey 复制来的，注意别带上空格。',
      actions: [{ label: '重试', href: '?' }],
    },
    rate_limited: {
      title: '被 Steam 限流了',
      body: '短时间内请求太多，Steam 让我们等一会儿。',
      hint: '一分钟后重试，或者换一个自己的密钥。',
      actions: [{ label: '重试', href: '?' }],
    },
    unreachable: {
      title: '连不上 Steam',
      body: '这台服务器发不出请求，Steam 的接口没有回应。',
      hint: '在中国大陆直连 api.steampowered.com 和 steamcommunity.com 通常是不通的。用 STEAM_API_BASE 指向可用代理，或者把服务跑在能直连的机器上。',
      actions: [
        { label: '重试', href: '?' },
        { label: '看示例档案', href: '/demo' },
      ],
    },
    empty: {
      title: '这个库里没有时长',
      body: error.message || '没有任何游戏的时长大于零。',
      hint: error.hint || '要么是新号，要么游戏详情没有公开。',
      actions: [{ label: '回首页', href: '/' }],
    },
  };
  return map[code] || {
    title: '没能生成拼图',
    body: error?.message || '未知错误。',
    hint: error?.hint || '',
    actions: [{ label: '重试', href: '?' }],
  };
}

function renderError(error) {
  const config = errorCopy(error);
  document.title = '出错了 · Steam Game Puzzle';
  nameEl.textContent = identifier;
  metaEl.textContent = '';

  const section = document.createElement('section');
  section.className = 'state';

  const title = document.createElement('h2');
  title.textContent = config.title;
  section.append(title);

  const body = document.createElement('p');
  body.textContent = config.body;
  section.append(body);

  if (config.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = config.hint;
    section.append(hint);
  }

  const actions = document.createElement('div');
  actions.className = 'state-actions';
  for (const action of config.actions) {
    const link = document.createElement('a');
    link.className = action.external ? 'btn' : 'btn';
    link.href = action.href;
    link.textContent = action.label;
    if (action.external) {
      link.target = '_blank';
      link.rel = 'noreferrer';
    }
    actions.append(link);
  }
  section.append(actions);

  // 缺密钥是最常见的失败，直接把输入框放在这儿，省得再跑回首页
  if (KEY_ERROR_CODES.has(error.code)) {
    const form = document.createElement('form');
    form.className = 'key-form';
    form.autocomplete = 'off';

    const input = document.createElement('input');
    input.type = 'password';
    input.name = 'api-key';
    input.placeholder = '粘贴 Steam Web API 密钥';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Steam Web API 密钥');

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn--primary';
    submit.textContent = '保存并重试';

    const note = document.createElement('p');
    note.className = 'key-note';
    note.textContent = '密钥只存在这台浏览器里。想让所有访客都不用填，写进服务器的 .env（STEAM_API_KEY=…）后重启。';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      try {
        localStorage.setItem('steam_api_key', value);
      } catch {
        /* 隐身模式 */
      }
      location.reload();
    });

    const row = document.createElement('div');
    row.className = 'key-row';
    row.append(input, submit);
    form.append(row, note);
    section.append(form);
  }

  mainEl.replaceChildren(section);
  downloadBtn.disabled = true;
  listToggle.disabled = true;
}

downloadBtn.addEventListener('click', async () => {
  if (downloadBtn.disabled) return;
  downloadBtn.classList.add('btn--busy');
  downloadBtn.disabled = true;
  closeExportPanel();
  const original = downloadText.textContent;
  downloadText.textContent = '导出中';
  try {
    const { blob, drawn } = await mosaic.exportPNG({
      scale: 2,
      caption: buildCaption(),
      onProgress: (value) => {
        downloadText.textContent = `导出中 ${value}%`;
      },
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safe = String(displayName).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'steam-game-puzzle';
    link.href = url;
    link.download = `${safe}-panorama.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    toast(`已导出 ${humanInt(drawn)} 格`);
  } catch (error) {
    toast(error.message || '导出失败', 4200);
  } finally {
    downloadText.textContent = original;
    downloadBtn.classList.remove('btn--busy');
    downloadBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  const ok = await copyText(`${location.origin}${location.pathname}`);
  toast(ok ? '链接已复制' : '复制失败，手动复制地址栏吧');
});

/* ---------------------------------------------------------------- 导出选项 */

const exportBtn = $('#export-options');
const exportPanel = $('#export-panel');
const optionInputs = {
  name: $('#opt-name'),
  count: $('#opt-count'),
  hours: $('#opt-hours'),
};

function syncExportInputs() {
  for (const [key, input] of Object.entries(optionInputs)) {
    if (input) input.checked = exportOptions[key];
  }
}

function openExportPanel() {
  if (!exportPanel) return;
  syncExportInputs();
  exportPanel.hidden = false;
  exportBtn?.setAttribute('aria-expanded', 'true');
}

function closeExportPanel() {
  if (!exportPanel || exportPanel.hidden) return;
  exportPanel.hidden = true;
  exportBtn?.setAttribute('aria-expanded', 'false');
}

exportBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (exportPanel?.hidden === false) closeExportPanel();
  else openExportPanel();
});

for (const [key, input] of Object.entries(optionInputs)) {
  input?.addEventListener('change', () => {
    exportOptions[key] = input.checked;
    saveExportOptions();
  });
}

document.addEventListener('click', (event) => {
  if (!exportPanel || exportPanel.hidden) return;
  if (event.target.closest('.export-wrap')) return;
  closeExportPanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeExportPanel();
});

syncExportInputs();

listToggle.addEventListener('click', () => {
  const willOpen = listView.hidden;
  listView.hidden = !willOpen;
  listToggle.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) listView.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

async function loadLibrary({ key = currentKey, refresh = wantsRefresh } = {}) {
  const query = refresh ? '?refresh=1' : '';
  const response = await fetchJSON(`/api/library/${encodeURIComponent(identifier)}${query}`, {
    headers: key ? { 'x-steam-api-key': key } : {},
  });
  applyPayload(response);
  return response;
}

(async () => {
  try {
    await loadLibrary();
  } catch (error) {
    renderError(error);
  }
})();
