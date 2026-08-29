# 📊 pi-usage — 查看各提供商用量与 Codex Fast 模式

查看 Pi 当前实际使用的提供商账号的额度与用量（Codex / Kimi For Coding / GitHub
Copilot / OpenRouter / OpenCode Zen / Z.AI / xAI），支持切换 Codex Fast 模式，
并安全赎回可用的 Codex 用量重置。

> 本包移植自 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage)
>（MIT，npm 包 `@narumitw/pi-usage`，参考版本 0.55.0）：行为、数据格式与移植说明对齐
> 参考实现（`/usage` 交互菜单、`/fast` 开关、`pi-usage.json` 设置、statusline、
> 各 provider 归一化适配器、Codex resets 赎回、`scripts/build-runtime.mjs` 及其测试）。
> 代码按本仓库约定移植 —— 直接以 `.ts` 源码加载（`pi.extensions` 指向 `./src/index.ts`）、
> 相对导入使用显式 `.ts` 后缀、node:test 测试（`test/vi.ts` 提供 vitest 兼容的
> `vi` 子集：`fn`/`spyOn`/`stubGlobal`/`unstubAllGlobals`，`t.after` 替代
> `t.onTestFinished`），测试基建 `test/support.ts`（`createMockPi`/
> `createMockContext`）从参考仓库根目录 `test/support.ts` 原样搬入。
> 未移植参考仓库的 `dist` 预构建发布物：本地由 Pi 直接加载 `src`，`npm run build`
> 仍可随时生成 `dist`。

## 快速开始

```bash
cd packages/pi-usage && npm install
# 作为 pi 包安装
pi install /path/to/packages/pi-usage
# 或临时运行一次
pi -e /path/to/packages/pi-usage
```

安装后 `/reload`，运行 `/usage` 查看当前 provider 的用量。

## /usage 命令

TUI / RPC 模式下，`/usage` 先查询当前模型 provider 并展示其状态，菜单动作：

```text
Refresh current usage        # 刷新当前用量
Settings                     # 编辑设置（Codex Fast / xAI usage）
Turn Fast mode on/off        # 仅当前 Codex 模型受支持时出现
Redeem usage limit reset…    # 仅当前 Codex OAuth 账号出现
View another configured provider…
View all configured providers…
Close
```

- 不接收参数（`/usage --refresh`、`/usage <provider>`、`/usage --all` 均被拒绝），
  跨 provider 查询必须先显式选择。
- print / json 模式拒绝 `/usage`；Esc 从 provider 选择返回并关闭根菜单。
- 刷新过程是扩展自有的可取消进度视图（支持 in-flight 中止）。

**Redeem usage limit reset…**（Codex）：先重新拉取已获得的重置详情，有详情时可选择
具体重置；确认前展示精确的重置内容，**No, go back** 是安全默认项。确认后不可从
进度视图取消（会话替换/关闭仍可中止）。传输失败提供 **Try again**，复用同一
redemption request ID 以便后端幂等重试。只有 Pi 当前 OAuth 凭证与存储登录精确匹配
时才可赎回；API-key 凭证、未选中的 Codex 账号、代理/自定义 origin 一律在变更前失败。

## /fast 命令

`/fast`（TUI / RPC 模式，不接受参数）为当前受支持的 Codex 模型切换 Fast 模式，
或在 `/usage` 菜单中通过 **Turn Fast mode on/off** 切换。Fast 约快 1.5×，
但消耗更多套餐额度；`codexFastMode` 默认 Off。

Fast 仅作用于官方 `openai-codex-responses` 请求中受支持的模型
（`gpt-5.4`、`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`）且 origin
为 `https://chatgpt.com`：开启时发送 `service_tier: "priority"`，否则显式发送
`service_tier: "default"`。不支持的模型与代理/自定义 origin 保持不变。
statusline 仅在生效时显示 `fast`（如 `codex fast 59% 5h`）。

## 设置

`~/.pi/agent/pi-usage.json`（`$PI_CODING_AGENT_DIR` 生效时替换 `~/.pi/agent`），
每次会话启动时重载，首次成功保存前不创建文件；未知字段保留、临时文件 + rename
原子写入、损坏/非法文件不被改写、保存失败回滚显示值与生效值：

| 字段 | 取值 | 默认 | 行为 |
| --- | --- | --- | --- |
| `codexFastMode` | boolean | `false` | Codex Fast 路由开关；切换从保存之后的请求生效 |
| `xaiUsage` | boolean | `true` | 是否启用 xAI 用量查询；关闭后不调度、不发布 xAI 数据到 statusline，并清空 xAI 缓存 |
| `newApiSystemToken` | 字符串（可打印 ASCII，≤128 字符） | 无 | New API 系统访问令牌（个人设置-安全设置-生成）；未配置时 New API 用量查询 fail-closed；可在 /usage Settings 中打码编辑（留空需二次确认后清除） |
| `newApiUserId` | 正整数（int32） | 无 | New API 用户数字 ID（面板个人设置页 User ID）；作为 `New-Api-User` 请求头发送——老版本网关强制要求该头与令牌用户匹配，新版本忽略它，配置后两者兼容；可在 /usage Settings 中编辑（仅接受正整数） |
| `usageStatusline` | boolean | `false` | 是否在 footer/statusline 发布用量数据（status key `usage`）；关闭时不做后台刷新也不显示，`/usage` 菜单仍可按需查询 |

## 支持的 provider

| Provider | ID | 语义 | 数据来源 | statusline 示例 |
| --- | --- | --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT 消费者订阅额度 | Codex usage / earned-reset 端点（Pi 运行时授权） | `codex 59% 5h 61% wk` |
| Kimi For Coding | `kimi-coding` | 计划请求窗口 + 独立的 booster wallet | `GET https://api.kimi.com/coding/v1/usages` | `kimi 99% 5h 96% wk` |
| GitHub Copilot | `github-copilot` | Copilot 套餐内额度（AI credits / premium requests / chat） | `GET /copilot_internal/user`（原始 GitHub OAuth token） | `copilot credits 1200/1500 80%` |
| OpenRouter | `openrouter` | API-key 消费与每 key 限额 | `GET /api/v1/key` | `openrouter $74.50 left` |
| OpenCode Zen | `opencode-go` | 滚动/每周/每月用量窗口 | `GET https://opencode.ai/zen/go/v1/usage` | `zen 0% r 4% w 2% m` |
| New API | `new-api` | 自托管网关账号额度（quota 按 500,000 单位 = $1 折算） | `GET {origin}/api/user/self` + `GET {origin}/api/data/self` | —（仅 `/usage` 菜单，不进 statusline） |
| xAI | `xai` | 消费者订阅额度与 credits（非 API 团队账单） | `cli-chat-proxy.grok.com` identity + billing 路由（默认开，仅显式 `/usage` 查询，不进 statusline） | — |
| Z.AI | `zai` / `zai-coding-cn` | GLM Coding Plan 5 小时/每周窗口 + 月度 MCP 额度 | `GET {origin}/api/monitor/usage/quota/limit` | `zai 87% 5h 76% wk` |

各 adapter 只向固定的官方端点发送凭证，且凭据必须与 Pi 当前运行时解析的账号精确
匹配：自定义/代理 origin、API-key 凭证（xAI 场景）、账号不匹配、重定向响应、
超大响应体一律 fail-closed；错误信息中的密钥与 transient 身份会被打码。

### New API（自托管网关）

New API 是自托管网关软件，没有单一官方 origin，因此这是唯一一个**有意偏离官方
origin 校验**的适配器：使用 Pi 中名为 `new-api` 的 provider，取数凭证只发送到
Pi 为该 provider/模型解析出的 http(s) base URL origin（与推理同一 origin），优先用模型
base URL，缺失时回退 provider 级 base URL。

**鉴权使用系统访问令牌**：new-api 的管理接口（`/api/user/self`、`/api/data/self`）
只认「个人设置-安全设置-系统访问令牌」（登录态或 Bearer 均可），**sk- 推理令牌不能
通过校验**（服务端只查 `users.access_token`）。因此本适配器不再复用 Pi 的推理
API key，而是读取 `pi-usage.json` 的 `newApiSystemToken` 字段作为
`Authorization: Bearer {token}` 发送；未配置该字段时 New API 查询直接 fail-closed
并提示配置路径。

**`New-Api-User` 请求头**：官方鉴权文档说明部分管理接口要求携带用户标识头
`New-Api-User: {user_id}`，其中 user_id 必须与令牌对应的用户匹配；部分部署版本
（尚未移除该校验的版本）对 `/api/user/self`、`/api/data/self` 强制要求，否则返回
`Unauthorized, New-Api-User header not provided`。在 `pi-usage.json` 配置
`newApiUserId`（面板「个人设置」页显示的 User ID 数字，即登录响应里的 `id`）后，
适配器会随请求发送该头；新版本网关已废弃该头并忽略它，因此配置后新旧版本都能用。
若未配置而网关要求该头，错误信息会提示具体配置项。请在 Pi 的模型配置中把网关命名
为 `new-api`，设置文件示例：

```json
{
  "newApiSystemToken": "abcdef0123456789...",
  "newApiUserId": 42
}
```

推理侧的 provider 配置保持原样（`sk-...` 令牌），与用量取数互相独立。

`/usage` 菜单的 **Settings** 面板（TUI 模式）内置 New API 配置编辑，无需手动改文件：

- **New API system token**：回车进入单行编辑器输入系统访问令牌；已有令牌只显示遮掩
  点（`•`），输入内容同样打码；字段留空回车会**二次确认**后才清除（Esc 可返回编辑）。
- **New API user ID**：预填当前值，仅接受正整数（int32）；非法输入就地提示、不会落盘。
- 两项保存失败时行内回滚显示值并弹出错误；保存成功会立即清空 New API 缓存与失败退避，
  下一次查询按新凭证重新鉴权。RPC / print 模式下 Settings 仍提示手动编辑文件路径。

- 账号端点：`GET {origin}/api/user/self`（剩余 quota、累计使用、请求数），
  统计端点：`GET {origin}/api/data/self?start_timestamp=…&end_timestamp=…`
  （最近 30 天、按小时×模型聚合的用量流水；服务端拒绝超过 1 个月的跨度）。
- 鉴权：系统访问令牌（`newApiSystemToken`）直接作为 Bearer 发送；取数不依赖 Pi
  运行时推理凭证（sk- 令牌会被管理接口拒绝）。
- 金额换算按 New API 发行版默认的 500,000 quota 单位 = $1 折算
  （`common.QuotaPerUnit`）；自行改编译常量的发行版数字会等比偏移。
- 统计端点响应可达数百 KB（每小时每模型一行），本适配器将该端点的成功响应体上限
  单独放宽到 1 MiB，其余端点仍为 64 KiB。
- 报告展示账号余额（剩余/累计/总额百分比）、请求数、30 天用量/请求/token，以及按模型降序的前 8 个 30 天消费项。
  New API 与 xAI 一样只在 `/usage` 菜单展示、不发布到 footer/statusline。

## 安全与设计要点

- 凭证候选只在内存中同步收集，不缓存、不落盘、不进日志、不进会话；只向校验过的
  官方 provider origin 发送所选 provider 的精确运行时匹配。
- 默认**不在 footer/statusline 发布用量数据**（`usageStatusline` 默认为 `false`，
  可在 /usage 的 Settings 里切换）：关闭时后台定时刷新也一并停止，`/usage`
  菜单查询不受影响；开启后 statusline 的 `usage` 项仅对会发布用量的 provider
  生效，每 5 分钟刷新一次，模型切换到不支持的 provider 时清空。xAI 与 New API 只出菜单、不调度。
- 用量缓存、statusline 数据按 “provider + 运行时账号” 隔离；运行时凭证变化后
  下次命令/轮次/定时刷新会重新解析授权，不能复用他人账号的缓存报告。
- Codex 重置赎回仅在 Codex 为当前 provider、且 Pi 新解析的 access token 与存储的
  OAuth 凭证或兼容凭证源精确匹配时可用；opaque credit/account ID 从不展示或持久化。
- 兼容 `oauth:credential-source:v1` 进程内协议：命名账号可由兼容的凭证所有者提供；
  缺失或不兼容时保留独立的 Pi `auth.json` 兜底行为。
- 参考实现还做了来源级重新校验（针对 Pi 与各 first-party 实现钉住的 commit），
  详见上游 README。

## 目录布局

```txt
packages/pi-usage/
├── scripts/
│   └── build-runtime.mjs  # 确定性运行时构建器 + 边界校验（npm run build 生成 dist/）
├── src/
│   ├── index.ts           # Pi 扩展入口 + helper 导出桶
│   ├── usage.ts           # /usage 菜单、缓存与生命周期编排
│   ├── usage-settings-ui.ts # Pi SettingsList 交互与保存回滚
│   ├── codex-fast.ts      # Fast 资格、请求 tier 与成本修正
│   ├── codex-fast-runtime.ts # /fast 命令、持久化生命周期与请求 hooks
│   ├── settings.ts        # 校验后的用户设置与原子持久化
│   ├── usage-helpers.ts   # 小型编排 helper
│   ├── query.ts           # 运行时授权解析与有界 provider 查询
│   ├── oauth-credential-source.ts # 进程内 OAuth 候选收集（v1 协议）
│   ├── codex-resets.ts    # Codex 重置授权、API 契约与归一化
│   ├── format.ts          # provider 感知的通知与 statusline 文本
│   ├── core.ts            # 缓存、并发、指纹与打码 helper
│   ├── providers/         # 各 provider 用量归一化适配器
│   └── types.ts           # 公共展示与适配器契约
├── test/
│   ├── *.test.ts          # node:test 测试（fixtures 见 test/fixtures/）
│   ├── support.ts         # createMockPi / createMockContext（搬自参考仓库根 test/）
│   └── vi.ts              # vitest 兼容 vi 子集
└── package.json / tsconfig.json / README.md / CHANGELOG.md / LICENSE
```

## 开发

```bash
npm test        # node --test test/*.test.ts
npm run typecheck
npm run build   # 可选：生成 dist/（本仓库正常加载 src/，无需构建）
```

## 关键词

用量、quota、Codex、ChatGPT 订阅额度、Kimi Coding、GitHub Copilot AI credits、
OpenRouter credits、xAI OAuth 用量、Grok、Z.AI、GLM Coding Plan、TypeScript pi 扩展。

## 许可证

MIT，见 [`LICENSE`](./LICENSE)。