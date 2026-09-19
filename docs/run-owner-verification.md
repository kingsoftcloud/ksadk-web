# 会话并发归属验证

## 行为

Studio 在首次调用运行时之前，使用稳定的本地会话 ID 区分各个草稿。
每个会话保留自己的运行引擎、排队消息、提交时的 Agent/模型配置、调用 ID 和续订游标。
原生会话创建结果即使反序返回，也只绑定到提交它的草稿。
切换页面后，后台状态和审批继续更新；输出不会写进当前会话正文。
创建会话失败时显示错误，不构造临时原生 ID 继续执行。

输入框在生成过程中按 Enter 将消息加入当前会话队列；停止按钮仍停止当前运行。
中文输入法确认候选词、Shift+Enter 和空白 Enter 不触发取消。
会话列表刷新第一页时保留当前选择，避免分页中较旧的会话被误判为不存在。

## 可复现检查

```bash
npm test
npm run test:node
npx tsc -p tsconfig.app.json --noEmit
STUDIO_BROWSER_CHANNEL=chrome npm run test:e2e:run-owners
npm run build:lib
```

`tsconfig.app.json` 执行完整类型检查。库的声明生成配置包含 `noCheck`，不能代替此检查。

浏览器测试先生成生产构建，挂载实际 `useAgentChat`、Composer 和 Timeline。
仅 API 传输为可控的合成实现，覆盖：

- 前台一个、后台三个运行；四个创建结果反序返回。
- A 的排队消息在切到 D 后，仍发送到 A 的原生会话。
- 停止 D 只取消 D 的调用，保留未发送输入。
- Agent 切换后的迟到创建与输出，不接管新 Agent 的草稿。
- 创建失败没有后续执行请求。
- 中文输入法确认、空白 Enter 和生成时排队。
- 连续三个排队请求的回答按各自问题排序；规范快照重复更新不吞掉后续排队输入。

已提交草稿还会写入 owner-scoped `OutboxStore`：账本保存请求 ID、会话/Agent、正文、执行模式和附件元数据，状态可为 `pending`、`sending`、`unknown`、`failed`、`cancelled` 或 `completed`。文件字节不进入 localStorage；未知结果不会被存储层自动重放。

未知投递的操作只查询原任务。SessionId、AgentId（接口提供时）及 InvocationId 必须与账本匹配，才能采用服务端终态；查询失败或身份不匹配继续保留未知状态。确认失败后需要单独点击重试，附件字节不可恢复时禁用发送。请求 ID 用于关联账本，不代表服务端提供幂等保证。当前队列持有的请求不进入恢复入口，同一请求的并发查询或重试会合并。

流读取错误必须透传；已输出部分文本、但断线或 EOF 前没有执行终态，不能标成完成。InvocationId 在异步会话创建后生成时写入账本。

运行 `npm run verify:e2e:outbox` 验证生产构建中的断线、查询失败、其他任务终态、确认失败和显式重试。报告、截图及 trace 在 `output/playwright/outbox-recovery/`。该验证使用确定性传输，不替代真实模型及云端验收。

报告位于 `output/playwright/run-owners-report.json`，包含源码 SHA-256。
结果目录包含请求归属审计；失败保留截图及浏览器 trace。
单元测试另覆盖各运行续订游标隔离、后台审批保留、后台停止不覆盖前台状态。
Outbox 单测覆盖重启恢复、请求 ID 去重和有界淘汰。

## 验证范围

这些检查证明浏览器端归属和交互，不能替代真实 Codex/ksadk 运行时、网络故障恢复、云端权限或全页面视觉验收。
离线联网策略、跨工作区缓存清理和完整重连状态核对仍需各自验证。
