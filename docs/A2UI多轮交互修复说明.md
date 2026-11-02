# A2UI 多轮交互与提交反馈修复

## 问题与原因

本次候选新增的 AG-UI 1.0 接入漏掉了一个状态同步环节。表单通过统一的 SubmitInteraction 入口恢复 Agent，结束事实从 SessionEvent 返回；官方 HttpAgent 的 pendingInterrupts 却只随它自己的 resume/run 更新。因此后端已完成、卡片已结束，同一页面的下一轮仍在浏览器中被拒绝，提示 pending interrupt(s) not addressed by resume。这是候选前端的接入问题，不要求 Agent 修改 checkpoint 或重建会话。

之前真实浏览器验证覆盖单轮、原中断恢复、刷新去重，但每个场景独立会话，未覆盖不刷新时继续下一轮。旧验证不能证明多轮行为。

## 最小修复

- 发起后续 AG-UI 调用前，将共享 Interaction 账本的终态同步到 HttpAgent 的公开 pendingInterrupts 和适配器缓存。必须同时匹配 session、interaction、run 和 revision，并且属于 canonical Interaction/v1。未消费、仅受理、校验失败、其他会话以及旧审批不能据此清除。
- 提交开始显示“正在发送”，收到持久 Inbox 回执后显示“已提交，等待 Agent 处理”，附带等待指示。答案被消费前仍保持 resolving 和按钮禁用；不提前宣称完成。纠正重试先清除上次受理提示。
- 没有修改 Python Runtime、LangGraph checkpoint、业务工具或服务器请求协议。

## 本次验证

- 4 个相关 Vitest 文件：122 passed。覆盖官方 HttpAgent 复现、三个 canonical 终态、尚未消费及并行等待、身份与 revision 隔离、旧 resume、提交回执与纠正重试、组件提示和 RunEngine 接线。
- TypeScript 检查和修改文件 ESLint：通过。
- 生产页面构建：通过。
- 真 FastAPI、LangGraph、SQLite 和 Chromium：同一 session 连续三轮生成、提交、恢复和更新卡片，中间不刷新；初始化与业务工具各三次。最终刷新不重复执行，不泄露测试内部上下文。使用真实 A2UI renderer；未拦截或伪造 Runtime API/SSE。
- 测试工具有一秒固定等待，仅用于观察受理提示，不模拟 Runtime 响应或 Agent 消费事实。

最终 wheel 的真实模型验收和摘要记录在 SDK 对应修复报告。本轮不跑全仓，也不把本地证据作为云端验收。
