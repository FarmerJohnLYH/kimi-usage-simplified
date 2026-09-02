# 项目名称：kimi-usage-simplified

实现一个极简的 Kimi 用量状态栏组件，目标平台为【VS Code 扩展 / 请按实际平台替换】。

## 一、状态栏显示（常驻）

在状态栏**最右侧**（其他信息项之后、通知图标之前）显示一个组件：

    ● 5h 23% · weekly 41%

格式规范：
1. 格式：`{状态点} 5h {5小时用量百分比} · weekly {每周用量百分比}`
2. 标签（5h、weekly）用弱色（灰），百分比数值用强调色（亮色、加粗），· 作为分隔符
3. 数字使用等宽数字（tabular-nums），刷新时宽度不跳动
4. 组件带浅色圆角底衬（如 rgba(255,255,255,.04)），与状态栏其他裸文本项区分

## 二、状态色点

组件最左侧的状态点根据用量取较高者变色，告警状态下对应数值本身也变红：

| 状态 | 条件       | 颜色                              |
|------|-----------|-----------------------------------|
| 正常 | 用量 &lt; 60% | 绿色 #5fb87a                      |
| 警告 | 60%–90%   | 黄色 #e8a13c                      |
| 危险 | &gt; 90%     | 红色 #e05555，同时该数值文本变红   |

## 三、Hover Tooltip（重置倒计时）

鼠标悬停在组件上时，向上弹出 tooltip，显示两个配额各自多久后重置：

    5h       23%    重置于 2h 14m 后
    weekly   41%    重置于 4d 6h 后

规范：
1. 两行结构，与状态栏一一对应，行间细分隔线
2. 倒计时紧凑格式：最多两个单位，如 47m / 2h 14m / 4d 6h，不显示秒
3. tooltip 右缘与组件右缘对齐，避免被屏幕边缘截断
4. hover 时组件底衬提亮（4% → 8%）作为可交互反馈
5. 危险状态下 tooltip 内对应数值同样标红


## 四、数据

- 5 小时窗口配额（5h）与每周配额（weekly）的已用百分比
- 两个配额各自的下次重置时间

### 数据来源

Kimi 用量接口（未公开文档，kimi-code CLI / console 自用）：

    GET https://api.kimi.ai/coding/v1/usages
    Authorization: Bearer <access_token>

- `access_token` 通过扩展配置 `kimi-usage.accessToken` 提供（或环境变量 `KIMI_ACCESS_TOKEN`，或执行命令 `Kimi Usage: 配置 API Key`）
- 未配置 token 时状态栏显示 `⚪ API key missing`

### 扩展配置（VS Code 设置）

| 配置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `kimi-usage.apiUrl` | `https://api.kimi.ai/coding/v1/usages` | 用量接口地址，可自定义 |
| `kimi-usage.accessToken` | （空） | API access token，留空则读环境变量 `KIMI_ACCESS_TOKEN` |
| `kimi-usage.refreshIntervalSeconds` | `60` | 自动刷新间隔（秒），最小 5 |

## 五、设计参考

整体风格：深色编辑器主题、低饱和度、状态栏高度 28px、字号 12px。
布局结构：左侧为 git/诊断/语言等常规项，右侧为编码格式、换行符、kimi-usage 组件、通知图标。