# Teams 端云前端与 Gateway 本地验证记录

日期：2026-09-19。对应协议摘要：`sha256:8294eb7aa3be040bbcc6c25e8b2657e3ef7df5c4f6fbc6c7d6c2c80648c367ec`。

## 验证结论与边界

浏览器已通过真实 PostgreSQL、Server 领域事务、HTTP、SSE 和 IndexedDB 的本地集成验证。测试没有用静态成功响应代替业务接口。执行端目录使用受控测试实现，没有调用模型、云上 Agent 或 KS3；此记录不构成真实端云执行验收。生产 lifecycle 的功能开关继续由 Server 决定，前端不会凭本地缓存或测试数据开放生产写能力。

Gateway 的 owner/Node 凭据隔离、请求限制和流式转发已独立测试。真实 IAM 上游可信身份链路、TLS Ingress、Gateway → Server → Node/Cloud Host → KS3 全链路仍需环境验收。

## 可复现启动

仓库按同级目录放置 `ksadk-web`、`ksadk-python`、`agentengine-server`。安装各仓现有开发依赖；Server 测试环境需要 `pgserver`，前端需要 Playwright Chromium。没有为本轮验证修改版本、发布 npm 包或部署环境。

在 Web 仓库运行：

```sh
npx playwright test --config playwright.live-teams.config.mjs
```

配置会启动绑定 `127.0.0.1` 的 Server fixture（52400）和 Vite（4189）。非 CI 情况可复用已启动的同一测试服务；服务重启后种子 ID 会变化，浏览器通过 metadata 取得本次真实身份和任务 ID。

手动浏览时，分别启动以下两个进程：

```sh
# agentengine-server 仓库
.venv/bin/python tests/teams/live_workspace_server.py --port 52400
```

```sh
# ksadk-web 仓库
npx vite --config vite.live-teams.config.mjs
```

浏览器打开 `http://127.0.0.1:4189/e2e/fixtures/live-cloud-teams.html`。页头明确展示“本地集成验证”和执行端受控范围。停止时先确认进程属于本 fixture，再正常终止；不要抢占或杀死未知端口进程。

## Fixture 的可信边界

- Server 新入口为 `tests/teams/live_workspace_server.py`，只监听 loopback，使用临时 PostgreSQL、独立运行角色、实际 registry/authority schema、bridge 和领域服务。
- 测试身份仅由 fixture 的同源别名适配注入，要求 loopback 和 `X-Teams-Live-Fixture: local-pg-only` 标记；不改变生产鉴权实现。
- `ControlledCatalog` 只提供受控执行端与绑定信息。测试启用 product 写入口仅用于真实领域读写，未启动模型执行。
- 浏览器页面中的故障开关仅丢弃或延迟实际网络结果，包括丢失已提交回执、丢弃一条 SSE 和延迟分页；不构造成功 DTO。
- `/__fixture__/inspect` 读取真实持久状态，验证创建次数；不以 UI 文本代替服务端去重证据。

## 测试结果

| 范围 | 命令/入口 | 结果 |
| --- | --- | --- |
| Web 云合同、产品客户端、outbox、workspace | `npx vitest run src/__tests__/teams-cloud-contracts.test.ts src/__tests__/teams-cloud-product.test.tsx src/__tests__/teams-operation-outbox.test.ts src/__tests__/teams-workspace.test.ts` | 135 通过 |
| Web 受控组件交互（含真实目录 DTO 形状） | `npx playwright test --config playwright.cloud-teams.config.mjs` | 17 通过 |
| Web 真实 HTTP / PG 浏览器集成 | `npx playwright test --config playwright.live-teams.config.mjs` | 9 通过 |
| Web 导出包及声明构建 | `npm run build:lib` | 通过 |
| Studio 云页面及原 Teams 入口 | `npx vitest run src/pages/TeamsPage.test.tsx src/pages/StudioCloudTeamsPage.test.tsx src/pages/TeamsAvailability.test.tsx` | 25 通过 |
| Studio 完整构建 | `npm run build -- --outDir /tmp/teams-studio-ui-build --emptyOutDir` | 通过 |
| Gateway 完整回归 | `.venv/bin/pytest -q tests` | 367 通过 |
| 新改 Web 组件/合同/浏览器测试 ESLint；Gateway 对应 Ruff；Git 空白检查 | 定向检查 | 通过 |

Studio 构建使用 Web 当前 `dist-lib` 的本地安装副本，React peer 解析回 Studio 自身。机器原有依赖目录缺少已声明的 `qrcode`，仅在临时依赖目录安装并连接到忽略的 `node_modules`，未改变 Studio manifest/lock。构建存在原有 `chatProtocol.ts` 动静态导入提示，不影响构建完成。

### 九项真实浏览器验收

1. 首屏是最新 50 条消息；向前加载历史保持升序、固定快照与当前 run 隔离。
2. Server 已提交但浏览器丢失回执：刷新后先 lookup，真实 DB 只有一个新目标，刷新页没有第二次 send。
3. 两标签同时提交相同未决意图：IndexedDB lease/CAS 只发出一次，真实 DB 只有一个目标。
4. 浏览器丢弃一条真实 SSE：序列缺口触发新快照，恢复随后已提交消息。
5. 切换任务后旧任务分页响应才到：旧响应不会覆盖当前任务。
6. 进入/切回任务默认定位最新消息；加载旧历史保持阅读锚点；阅读旧消息时新 SSE 不强行滚到底部。
7. 真实副作用核查决定提交成功后丢失 HTTP 回执：刷新经通用 lookup 恢复，PG 只保留一条决议审计，原 outcome 不被伪造。
8. 另一标签提交新决定，真实 SSE 更新证据：第一标签未提交说明保留，旧 CAS 被禁用。
9. 核查只读门禁与切换 run：旧任务证据不会混入新任务，返回后仍为只读。

真实集成曾发现 Server `recentMessages` 取最早窗口导致最新消息不可见，现已改为尾部窗口、向前分页。Chrome 检查又发现消息默认停在窗口开头，现已增加滚动锚点处理及上述第 6 项回归。

### 目录候选补充回归

真实 CloudCatalog 在 preflight 前返回六项 capability 全为 false、availability=unchecked。创建对话框允许该候选进入服务端验证的草稿，并明确标注“创建时验证”；不修改其 capability。已验证 ready 但 leader=false 的成员仍不可选 Leader，原 local 模式的 enqueue 门禁不变。四项新交互用例覆盖上述分支、备用候选及服务端拒绝后保留草稿；这些是受控 UI 测试，不能当作同发布备用已实现。

## 用户 Chrome 视觉检查

使用用户已连接的 Chrome 独立标签，以原有视口检查了消息、成员、新任务和返回任务路径；未调整浏览器缩放，未使用截图模拟交互。页面正常显示实际 PG 数据、节点类型与状态、固定输入区和任务切换。新任务未被误提交。检查后保留本地预览标签。另在同一用户 Chrome 原始视口检查了真实 PG 执行核查列表、表单与待核对状态；局部表单限制阅读宽度，使用现有样式变量，未提交额外用户操作。

这次视觉检查针对真实 HTTP fixture 挂载的云工作区；完整 Studio shell 的本地/云切换另有组件回归，不能把这次检查扩展描述为所有产品页面或所有响应式断点已验收。

### 执行核查 fixture

`?effects=1` 使用独立受控团队的真实 Node relay / ExecutionContext / prepared+unknown 证据。冻结 counter 工具策略只在临时 PG 中构建，不开放生产 feature。该组浏览器测试会消费两条待核查记录；再次完整运行时应正常停止并重启本 fixture，使用新临时数据库。CI 自动新建服务。`?effects=1&readonly=1` 可查看只读状态。

独立副作用组件验证见 Server `docs/agent-teams/执行副作用与Leader接管实施细化.md` §12：K SQLite/原生 PG 27 项，S 权威 ledger/通用 outcome 原子性 13 项。上述浏览器测试进一步经过实际 owner HTTP 路由与 PG，但执行端与外部计数器仍为受控测试条件。

## 日志与后续门禁

本机记录：

- `/tmp/teams-cloud-ui-e2e-20260919.log`
- `/tmp/teams-live-e2e-20260919.log`
- `/tmp/teams-web-core-20260919.log`
- `/tmp/teams-web-build-lib-20260919.log`
- `/tmp/teams-web-lint-20260919.log`
- `/tmp/teams-studio-tests-20260919.log`
- `/tmp/teams-studio-ui-build-20260919.log`
- `/tmp/teams-gateway-all-tests-20260919.log`

后续必须使用真实可信 IAM 身份和各执行端完成审批、材料、产物下载、离线恢复、grant 屏障、副作用核查和 Leader 接管演练。Gateway 默认关闭；独立 ingress secret 与 Server hop secret 均需配置。控制面 `features` 只能在对应能力真正完成验收后开放。
