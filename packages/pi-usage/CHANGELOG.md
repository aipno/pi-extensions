# pi-usage

## Unreleased

### Minor Changes

- `/usage` 的 Settings 面板新增 New API 配置编辑（TUI 模式）：
  - **New API system token**：单行文本编辑器，输入全程遮掩（`•`）；已有令牌时字段
    留空回车需再次回车确认才清除，Esc 可返回编辑；控制字符与超长值就地拒绝。
  - **New API user ID**：预填当前值，仅接受正整数（int32），非法输入不落盘。
  - 两行分别只提交经过校验的原始值：令牌值永不进入设置列表状态，仅落盘；
    保存失败回滚行内显示值并通知错误。
  - 保存/清除成功后立即失效 New API 的用量缓存与失败退避，下一次查询按新凭证
    重新鉴权（`onApplied` 回调调用 `invalidateProviderState("new-api")`）。
  - `update()` 的补丁类型新增 `UsageSettingsPatch`：对两个 New API 键接受空字符串
    表示显式清除（纯空白跳过以免误清凭证），`undefined` 删除键；新增
    `newApiSystemTokenIssue` / `newApiUserIdIssue` 客户端校验导出。
  - 新增 8 个 Settings UI 编辑器测试与 1 个缓存失效集成测试（共 172 项测试通过）。

## 0.2.0

### Minor Changes

- 新增 New API（自托管网关）provider 支持：
  - `GET {origin}/api/user/self` 账号额度（剩余 quota / 累计使用 / 请求数，
    quota 按发行版默认 500,000 单位 = $1 折算为美元展示）。
  - `GET {origin}/api/data/self` 最近 30 天按小时×模型的用量流水，聚合出
    30 天用量/请求/token 与按模型降序的前 8 个消费项；统计端点响应体上限
    单独放宽到 1 MiB。
  - 自托管网关无官方 origin：适配器把凭证只发送到 Pi 为 `new-api` provider/模型
    解析的 http(s) base URL origin（模型缺失 base URL 时回退 provider 级），
    这是对官网 origin 校验的唯一有意偏离，已在 README 说明。
  - 鉴权使用新设置 `newApiSystemToken`（个人设置-安全设置-系统访问令牌）：
    new-api 管理接口只接受系统访问令牌，`sk-` 推理令牌无法通过校验，因此
    取数不再复用 Pi 运行时推理凭证；未配置令牌时 fail-closed 并提示配置路径。
  - 新增 `newApiUserId` 设置并按官方鉴权文档发送 `New-Api-User: {user_id}`
    请求头（老版本网关强制要求且必须与令牌用户匹配，新版本已废弃并忽略）：
    未配置时若网关拒绝请求，错误信息会直接提示配置项与获取方式（面板个人设置页
    User ID）。
  - 新增 `usageStatusline` 设置（默认 `false`）：取消 footer/statusline 上的用量
    发布与后台定时刷新；`/usage` 菜单按需查询不受影响，可在 Settings 中开关。
  - New API 与 xAI 一样只在 `/usage` 菜单展示、不发布到 footer/statusline（报告含
    账号、科目明细与模型分解）。
  - 新增 13 个单元/传输/鉴权/设置测试与 1 个 `/usage` 集成测试。

## 0.1.0

### 首个移植版本

- 移植参考 [narumiruna/pi-extensions 的 pi-usage](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage)
  （`@narumitw/pi-usage` 0.55.0，MIT），行为对齐参考实现：
  - 支持 OpenAI Codex（用量窗口、credits、earned resets 安全赎回、Fast 模式）、
    Kimi For Coding（计划窗口 + booster wallet）、GitHub Copilot（AI credits /
    premium requests / chat）、OpenRouter（per-key 限额与消费）、OpenCode Zen
    （滚动/每周/每月窗口）、xAI（消费者订阅额度，默认开）、Z.AI（5 小时/每周 +
    月度 MCP 额度）。
  - `/usage` 交互菜单（refresh / settings / fast toggle / reset redeem /
    查看其它或全部 provider）、`/fast` 命令、`pi-usage.json` 原子持久化、
    statusline `usage` 项（每 5 分钟刷新，按 provider + 账号隔离）。
- 按本仓库约定移植：
  - `pi.extensions` 指向 `./src/index.ts`，由 Pi 直接加载源码，无需 dist 预构建。
  - 相对导入改为显式 `.ts` 后缀；测试从 vitest 迁移到 node:test
    （`test/vi.ts` 提供 `vi.fn`/`vi.spyOn`/`vi.stubGlobal`/`vi.unstubAllGlobals`
    子集，`t.after` 替代 `t.onTestFinished`）。
  - 测试基建 `test/support.ts`（`createMockPi`/`createMockContext`）从参考仓库
    根目录原样搬入；`generated-entry.test.ts` 改为在包内临时目录构建后加载。
  - 保留 `scripts/build-runtime.mjs` 及其确定性构建、边界校验测试与
    `npm run build`。
- 本地化改动：`RequestRedirect` 在无 DOM lib 的 tsconfig 下改为显式字面量联合；
  `codex-fast.ts` 适配本地 `noUncheckedIndexedAccess` 严格选项。