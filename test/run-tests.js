// 无人值守测试：node test/run-tests.js
// 通过 stub 'vscode' 模块直接加载 extension.js，覆盖：
//   1. normalizeUsage 解析真实接口 fixture
//   2. normalizeUsage 异常输入
//   3. formatCountdown 紧凑倒计时格式
//   4. overallStatus 阈值（<60 绿 / 60-90 黄 / >90 红）
//   5. 无 token 时抛 MissingTokenError（状态栏显示 API key missing）
//   6. 真实接口集成测试（需环境变量 KIMI_TEST_TOKEN）

const Module = require('module');
const path = require('path');
const assert = require('assert');

// ---- vscode stub（仅实现 extension.js 用到的部分） --------------------
const configStore = { apiUrl: '', accessToken: '', refreshIntervalSeconds: 60 };
const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  MarkdownString: class MarkdownString {
    constructor() { this.value = ''; }
    appendMarkdown(s) { this.value += s; }
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => configStore[k] !== undefined && configStore[k] !== '' ? configStore[k] : d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  window: {
    createStatusBarItem: () => ({ show() {}, text: '', tooltip: undefined, backgroundColor: undefined }),
    showTextDocument: async () => ({}),
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    showInputBox: async () => undefined,
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));
const { normalizeUsage, formatCountdown, overallStatus, fetchUsage, MissingTokenError } = ext._test;

// ---- 真实接口响应 fixture（2026-09-02 实测，隐去用户字段） -------------
const fixture = {
  usage: { limit: '100', used: '27', remaining: '73', resetTime: '2026-09-09T09:12:15.396746Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '36', remaining: '64', resetTime: '2026-09-02T19:12:15.396746Z' },
    },
  ],
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('normalizeUsage:');
test('解析真实响应：5h=36%, weekly=27%', () => {
  const u = normalizeUsage(fixture);
  assert.strictEqual(Math.round(u.fiveHourPct), 36);
  assert.strictEqual(Math.round(u.weeklyPct), 27);
  assert.strictEqual(u.fiveHourResetAt.toISOString(), '2026-09-02T19:12:15.396Z');
  assert.strictEqual(u.weeklyResetAt.toISOString(), '2026-09-09T09:12:15.396Z');
});
test('limits 乱序时仍选中 300 分钟窗口', () => {
  const other = { window: { duration: 1440, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '90', resetTime: '2026-09-03T00:00:00Z' } };
  const u = normalizeUsage({ ...fixture, limits: [other, ...fixture.limits] });
  assert.strictEqual(Math.round(u.fiveHourPct), 36);
});
test('缺 usage 字段抛错', () => assert.throws(() => normalizeUsage({}), /usage/));
test('limits 为空抛错', () => assert.throws(() => normalizeUsage({ usage: fixture.usage }), /limits/));
test('used/limit 非法抛错', () =>
  assert.throws(() => normalizeUsage({ usage: fixture.usage, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '0', used: 'x', resetTime: '2026-09-02T19:12:15Z' } }] }), /非法/));

console.log('formatCountdown（紧凑格式，最多两个单位，无秒）:');
const now = Date.now();
const inMin = (m) => new Date(now + m * 60_000);
test('47m', () => assert.strictEqual(formatCountdown(inMin(47)), '47m'));
test('2h 14m', () => assert.strictEqual(formatCountdown(inMin(134)), '2h 14m'));
test('4d 6h', () => assert.strictEqual(formatCountdown(inMin(4 * 1440 + 360)), '4d 6h'));
test('1d 0h 30m → 1d（最多两个单位）', () => assert.strictEqual(formatCountdown(inMin(1440)), '1d'));
test('过去时间归零 → 0m', () => assert.strictEqual(formatCountdown(inMin(-5)), '0m'));

console.log('overallStatus（取两者较高者）:');
const st = (a, b) => overallStatus({ fiveHourPct: a, weeklyPct: b });
test('23/41 → normal', () => assert.strictEqual(st(23, 41), 'normal'));
test('59.9 → normal', () => assert.strictEqual(st(59.9, 10), 'normal'));
test('60 → warning（含边界）', () => assert.strictEqual(st(60, 10), 'warning'));
test('78/52 → warning', () => assert.strictEqual(st(78, 52), 'warning'));
test('90 → warning（readme: >90 才是危险）', () => assert.strictEqual(st(90, 10), 'warning'));
test('91 → danger', () => assert.strictEqual(st(91, 10), 'danger'));
test('96/88 → danger（取高者）', () => assert.strictEqual(st(96, 88), 'danger'));

console.log('fetchUsage:');
test('无 token 抛 MissingTokenError', async () => {
  configStore.accessToken = '';
  delete process.env.KIMI_ACCESS_TOKEN;
  try {
    await fetchUsage();
    assert.fail('应抛出 MissingTokenError');
  } catch (e) {
    assert.ok(e instanceof MissingTokenError, `实际: ${e}`);
  }
});

(async () => {
  const token = process.env.KIMI_TEST_TOKEN;
  if (token) {
    console.log('真实接口集成测试:');
    configStore.accessToken = token;
    try {
      const u = await fetchUsage();
      assert.ok(u.fiveHourPct >= 0 && u.fiveHourPct <= 100, '5h 百分比越界');
      assert.ok(u.weeklyPct >= 0 && u.weeklyPct <= 100, 'weekly 百分比越界');
      assert.ok(u.fiveHourResetAt > new Date(), '5h 重置时间应在未来');
      assert.ok(u.weeklyResetAt > new Date(), 'weekly 重置时间应在未来');
      console.log(`  ✓ 5h=${u.fiveHourPct.toFixed(0)}% (重置 ${formatCountdown(u.fiveHourResetAt)} 后), weekly=${u.weeklyPct.toFixed(0)}% (重置 ${formatCountdown(u.weeklyResetAt)} 后)`);
      passed++;
    } catch (e) {
      console.error(`  ✗ 集成测试失败: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('（跳过集成测试：未设置 KIMI_TEST_TOKEN）');
  }
  console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
})();
