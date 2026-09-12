# Agent Teams 共享协议与组件

Teams 是独立入口，原有单会话 `conversation.ksadk.io/v1` 协议不变。前端不调度 Agent；群消息、路由、预算、任务验收和执行权威由宿主的 Teams domain 提供。

```tsx
import { HttpTeamsClient } from '@kingsoftcloud/ksadk-web/teams';
import { TeamWorkspace, useTeamChat } from '@kingsoftcloud/ksadk-web/teams/components';
import '@kingsoftcloud/ksadk-web/teams/styles';

// client 必须是稳定实例。authenticatedFetch 由宿主注入。
const client = new HttpTeamsClient({ fetch: authenticatedFetch });

function GroupPage({ groupId, authorityRef }) {
  const chat = useTeamChat({ client, groupId, authorityRef });
  return <TeamWorkspace
    snapshot={chat.snapshot}
    loading={chat.loading}
    error={chat.error}
    connection={chat.connection}
    draft={chat.draft}
    onDraftChange={chat.setDraft}
    onSend={chat.send}
    onRetry={chat.reconnect}
  />;
}
```

这个示例只装配群聊与观察。宿主按真实权限提供 `onControl`、`onTaskAction`、`onAcceptRun`、`onRespondInteraction`、`onOpenArtifact` 等动作。未注入的动作不显示操作入口；服务端仍须重新检查权限，前端隐藏不是授权。

`initialSelection` 与 `onSelectionChange` 用于持久化 URL 中的 group/round/task。`draft` 和 `onDraftChange` 可连接宿主自己的、按 authority/group 分区的草稿存储。默认草稿只保存在当前已挂载组件中，不宣称刷新后保存。浏览器断线只更新 connection，不改变任务或 Run 状态。

## 群事件

`GroupSnapshot` 包含 group、members、messages、teamRuns、tasks、deliveries、interactions 和 watermark。先读取快照，再从 watermark 后订阅事件。GroupEvent 使用 `eventId`、`groupId`、`groupSeq`；已应用的序号是幂等重放，序号缺口必须重新读取快照。较旧快照或实体 revision 不能覆盖新状态。

事件对应完整实体 upsert：

| type | payload |
|---|---|
| group.updated | `{group}` |
| member.updated | `{member}` |
| message.created / message.updated | `{message}` |
| team_run.updated | `{teamRun}` |
| task.updated | `{task}` |
| delivery.updated | `{delivery}` |
| interaction.updated | `{interaction}` |

未知事件推进游标，不运行 payload 中的脚本或加载组件。文本相同但 ID 不同的消息不合并。完成消息更新原 messageId/revision，不能在完成时再次创建同一答案。

`HttpTeamsClient` 使用 `/api/v1/groups`，支持 list、create、snapshot、update、send、start、taskAction、control、acceptRun、interaction、execution、markRead、watch。宿主可注入带认证和统一错误处理的 fetch，不读取页面“当前 Agent”或 cookie 选择器。

## 成员观察与审批

`createChatScope(MemberStreamRef)` 创建独立 MemberChatScope，拥有自己的 reducer、草稿、请求和生命周期；没有 send/delete/new-session 方法。`observe` 只接入已有运行的历史与增量事件。关闭 scope 只断开观察，不取消执行。

`createHttpMemberTransport` 提供可选 GET 适配：

- `/groups/{group}/members/{member}/conversation?sessionId&runId&bindingRef` 返回 `{ref,items,cursor}`。
- `/groups/{group}/members/{member}/conversation/events?sessionId&runId&bindingRef&after` 返回 SSE `{ref,item,cursor}`。

宿主也可注入既有、受授权的 read/subscribe adapter。原 ConversationItem 的 itemId/sessionId/runId/sourceEventIds 不变，每个成员的归并器独立。

MemberInspector 默认为只读。向成员输入内容仍通过 `client.send(groupId,{intent:'directed',mentions:[memberId],...})`；不能挂载旧的单聊 controller 直接发起 Run。

审批提交必须携带完整 InteractionRef：authorityRef/groupId/memberId/bindingRef/providerRef/sessionId/runId/interactionId。相同 interactionId 在不同成员中是不同的审批。HTTP accepted 只显示“等待执行端确认”，真正终态由群事件确认。

## 样式与测试

样式限于 `.ksadk-teams`，可覆盖 `--team-bg`、`--team-ink`、`--team-muted`、`--team-accent` 等变量。默认浅色中性布局；没有任务时不画图，图仅在用户展开时懒加载。窄屏用详情替换聊天并保留草稿，支持键盘返回和 reduced-motion。

`npm test` 包含协议、回放、作用域、审批与静态组件测试。`npm run test:e2e:teams` 使用带明显模拟标记的 UI fixture，覆盖发送意图、创建群、同名跨成员审批、图与聊天往返、390/768/1024px 布局。模拟测试不代表后端调度、真实模型或插件安装闭环已经通过。

展开执行工作台时，宿主可传 `onLoadExecution(teamRunId, signal)` 获取经 `decodeExecutionSnapshot` 校验的真实 task/run/child_invocation 节点与依赖/调用边。`执行调用` 视图区分计划和实际执行；选择有 source 的执行节点，通过 `renderMember` 第三个参数继续只读观察原始执行，关闭面板仅 abort 请求。宿主需保持 authorityRef 和 groupId 验证，并限制交付物到受权威保护的下载端点。
