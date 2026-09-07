// kimi-usage-simplified —— 极简 Kimi 用量状态栏组件
//
// 设计稿还原说明（VS Code 状态栏能力边界内的近似）：
// - 状态点：VS Code 无法给状态栏文本局部着色，用 🟢/🟡/🔴 圆形 emoji 代替
//   设计稿中的 #5fb87a / #e8a13c / #e05555 色点。
// - 危险状态数值标红：状态栏同样无法局部标红，改用原生
//   statusBarItem.errorBackground 整体高亮（tooltip 内可真正标红，已实现）。
// - 圆角底衬 / hover 提亮：状态栏项自带 hover 高亮，无法再自定义底色。
// - tooltip：MarkdownString 表格实现两行 + 分隔线，右缘自动对齐、不截断。

const vscode = require('vscode');

/** @type {vscode.StatusBarItem} */
let item;
/** @type {NodeJS.Timeout | undefined} */
let timer;

// ---------------------------------------------------------------- 数据层
// 数据来源（readme 第四节）：
//   GET https://api.kimi.ai/coding/v1/usages
//   Authorization: Bearer <access_token>
// token 取自配置 kimi-usage.accessToken 或环境变量 KIMI_ACCESS_TOKEN；
// 未配置 token 时状态栏显示「⚪ API key missing」。
// 响应字段映射见 normalizeUsage()。

const https = require('https');

/**
 * @typedef {Object} UsageData
 * @property {number} fiveHourPct      5 小时窗口已用百分比 (0-100)
 * @property {number} weeklyPct        每周配额已用百分比 (0-100)
 * @property {Date}   fiveHourResetAt  5 小时窗口下次重置时间
 * @property {Date}   weeklyResetAt    每周配额下次重置时间
 */

const DEFAULT_USAGES_URL = 'https://api.kimi.ai/coding/v1/usages';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('kimi-usage');
  return {
    apiUrl: cfg.get('apiUrl', DEFAULT_USAGES_URL) || DEFAULT_USAGES_URL,
    accessToken: cfg.get('accessToken', '') || process.env.KIMI_ACCESS_TOKEN || '',
    refreshIntervalSeconds: cfg.get('refreshIntervalSeconds', 60),
  };
}

/** 将接口响应归一化为 UsageData。
 * 实际响应结构（2026-09 实测）：
 *   usage:  { limit, used, remaining, resetTime }              → 每周配额
 *   limits: [{ window:{duration:300,timeUnit:MINUTE}, detail:{limit,used,resetTime} }] → 5h 窗口
 * 数值字段是字符串；resetTime 为 ISO 8601。 */
function normalizeUsage(body) {
  // used 缺失时（如用量 0% 的窗口不返回 used 字段）用 limit - remaining 反推
  const toPct = (quota, label) => {
    const l = Number(quota && quota.limit);
    const u = quota && quota.used != null
      ? Number(quota.used)
      : Number(quota && quota.limit) - Number(quota && quota.remaining);
    if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) {
      throw new Error(`${label} 配额字段非法: used=${quota && quota.used}, remaining=${quota && quota.remaining}, limit=${quota && quota.limit}`);
    }
    return (u / l) * 100;
  };
  const toDate = (v, label) => {
    const d = new Date(v);
    if (v == null || isNaN(d.getTime())) throw new Error(`${label} 重置时间非法: ${v}`);
    return d;
  };

  if (!body || !body.usage) throw new Error('响应中缺少 usage 字段');
  const weekly = body.usage;

  // 5h 窗口：在 limits 数组里找 duration 300 分钟的条目；找不到则取窗口最短的一条
  const entries = Array.isArray(body.limits) ? body.limits : [];
  const fiveHourEntry =
    entries.find(e => e.window && e.window.duration === 300 && e.window.timeUnit === 'TIME_UNIT_MINUTE')
    || entries.slice().sort((a, b) => windowMinutes(a) - windowMinutes(b))[0];
  if (!fiveHourEntry || !fiveHourEntry.detail) throw new Error('响应 limits 中找不到 5 小时窗口配额');

  return {
    fiveHourPct: toPct(fiveHourEntry.detail, '5h'),
    weeklyPct: toPct(weekly, 'weekly'),
    fiveHourResetAt: toDate(fiveHourEntry.detail.resetTime, '5h'),
    weeklyResetAt: toDate(weekly.resetTime, 'weekly'),
  };
}

function windowMinutes(entry) {
  const w = entry && entry.window;
  if (!w) return Infinity;
  const d = Number(w.duration);
  if (!Number.isFinite(d)) return Infinity;
  switch (w.timeUnit) {
    case 'TIME_UNIT_MINUTE': return d;
    case 'TIME_UNIT_HOUR': return d * 60;
    case 'TIME_UNIT_DAY': return d * 24 * 60;
    default: return Infinity;
  }
}

/** 拉取接口原始文本（调试用） */
function fetchRaw(apiUrl, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 10_000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（10s）')));
    req.on('error', reject);
  });
}

/** @returns {Promise<UsageData>} */
async function fetchRemoteUsage(apiUrl, token) {
  const { status, body } = await fetchRaw(apiUrl, token);
  if (status === 401 || status === 403) {
    throw new Error(`鉴权失败（HTTP ${status}），请检查 kimi-usage.accessToken`);
  }
  if (status !== 200) {
    throw new Error(`接口返回 HTTP ${status}: ${body.slice(0, 200)}`);
  }
  return normalizeUsage(JSON.parse(body));
}

class MissingTokenError extends Error {}

/** @returns {Promise<UsageData>} */
async function fetchUsage() {
  const { apiUrl, accessToken } = getConfig();
  if (!accessToken) {
    throw new MissingTokenError('未配置 kimi-usage.accessToken（或环境变量 KIMI_ACCESS_TOKEN）');
  }
  return fetchRemoteUsage(apiUrl, accessToken);
}

// ---------------------------------------------------------------- 展示层

const THRESHOLD_WARNING = 60; // 60%–90% 警告
const THRESHOLD_DANGER = 90;  // > 90% 危险

/** @returns {'normal' | 'warning' | 'danger'} 取两者较高者（readme 第二节） */
function overallStatus(data) {
  const pct = Math.max(data.fiveHourPct, data.weeklyPct);
  if (pct > THRESHOLD_DANGER) return 'danger';
  if (pct >= THRESHOLD_WARNING) return 'warning';
  return 'normal';
}

const DOT = { normal: '🟢', warning: '🟡', danger: '🔴' };

/** 倒计时紧凑格式：最多两个单位，不显示秒（readme 第三节第 2 条） */
function formatCountdown(resetAt, now = Date.now()) {
  let mins = Math.max(0, Math.round((resetAt.getTime() - now) / 60_000));
  const d = Math.floor(mins / (24 * 60)); mins -= d * 24 * 60;
  const h = Math.floor(mins / 60);        mins -= h * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.slice(0, 2).join(' ');
}

function pctText(pct) {
  return `${Math.round(pct)}%`;
}

async function refresh() {
  try {
    const data = await fetchUsage();
    render(data);
  } catch (err) {
    if (err instanceof MissingTokenError) {
      item.text = '⚪ API key missing';
      item.tooltip = '未配置 access token\n\n执行命令 `Kimi Usage: 配置 API Key`，或设置环境变量 `KIMI_ACCESS_TOKEN`，然后点击刷新。';
    } else {
      item.text = '⚪ 5h --% · weekly --%';
      item.tooltip = `Kimi 用量获取失败：${err.message}\n\n点击重试`;
      console.error('[kimi-usage]', err);
    }
    item.backgroundColor = undefined;
  }
}

/** @param {UsageData} data */
function render(data) {
  const status = overallStatus(data);

  // 状态栏常驻文本：{状态点} 5h {x}% · weekly {y}%
  item.text = `${DOT[status]} 5h ${pctText(data.fiveHourPct)} · weekly ${pctText(data.weeklyPct)}`;

  // 危险状态：原生 error 底色高亮（等价于设计稿的数值标红）
  item.backgroundColor = status === 'danger'
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : undefined;

  // hover tooltip：两行 + 分隔线 + 重置倒计时，危险行数值标红
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  md.isTrusted = true;
  const row = (label, pct, resetAt) => {
    const value = pct > THRESHOLD_DANGER
      ? `<span style="color:#e05555"><b>${pctText(pct)}</b></span>`
      : `<b>${pctText(pct)}</b>`;
    return `| ${label} | ${value} | 重置于 **${formatCountdown(resetAt)}** 后 |`;
  };
  md.appendMarkdown('| | | |\n|---|---|---|\n');
  md.appendMarkdown(row('5h', data.fiveHourPct, data.fiveHourResetAt) + '\n');
  md.appendMarkdown(row('weekly', data.weeklyPct, data.weeklyResetAt) + '\n');
  item.tooltip = md;

  item.show();
}

// ---------------------------------------------------------------- 生命周期

function restartTimer() {
  if (timer) clearInterval(timer);
  const secs = getConfig().refreshIntervalSeconds;
  timer = setInterval(refresh, Math.max(5, secs) * 1000);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  // StatusBarAlignment.Right：priority 越大越靠左，越小越靠右。
  // 设计稿要求「状态栏最右侧、通知图标之前」，取极小值排到自定义项最右。
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1000);
  item.command = 'kimi-usage.refresh';
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand('kimi-usage.refresh', refresh),
    vscode.commands.registerCommand('kimi-usage.configureApiKey', async () => {
      const current = getConfig().accessToken;
      const value = await vscode.window.showInputBox({
        title: 'Kimi Usage: 配置 API Key',
        prompt: '请输入 Kimi access token（保存在用户设置 kimi-usage.accessToken）',
        value: current,
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return; // 用户取消
      await vscode.workspace.getConfiguration('kimi-usage')
        .update('accessToken', value.trim(), vscode.ConfigurationTarget.Global);
      refresh();
    }),
    vscode.commands.registerCommand('kimi-usage.showRawResponse', async () => {
      const { apiUrl, accessToken } = getConfig();
      if (!accessToken) {
        vscode.window.showWarningMessage('Kimi Usage: 未配置 kimi-usage.accessToken');
        return;
      }
      try {
        const { status, body } = await fetchRaw(apiUrl, accessToken);
        const doc = await vscode.workspace.openTextDocument({
          language: 'json',
          content: `// HTTP ${status} ${apiUrl}\n${body}`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Kimi Usage: ${err.message}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kimi-usage.refreshIntervalSeconds')) restartTimer();
      if (e.affectsConfiguration('kimi-usage')) refresh();
    }),
  );

  restartTimer();
  refresh();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate, _test: { normalizeUsage, windowMinutes, formatCountdown, overallStatus, fetchUsage, fetchRaw, MissingTokenError } };
