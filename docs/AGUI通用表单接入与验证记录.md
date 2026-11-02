# AG-UI 通用表单接入与验证记录

实施分支：`codex/agui-a2ui-implementation-20261020`。本记录覆盖通用表单的前端实现，不代表完整 A2UI、本地 M1 或云端已验收。

## 本批实现

- 提交链路使用 `JsonValue`，不把 false、0、空字符串、数组和 null 强制转换为对象。
- 以 Runtime 保存的 `request_schema` 校验答案；A2UI 展示消息不能替换该 Schema。
- 新通用表单覆盖基础标量、enum、嵌套对象、nullable，以及数组、引用、组合 Schema 的 JSON 输入降级。JSON 草稿非法时阻止提交先前的有效旧值。
- 表单控件按交互身份/revision 隔离；终态不可再次操作。Teams 既有对象表单及其冻结合同继续使用原组件。
- AG-UI 请求保留 `responseSchema` 和原始答案；发出恢复请求不再提前把交互标为完成。同一公开等待仍存在时允许修改；到达下一次等待才结束前一项；结果不明继续等待确认。
- AG-UI 单项提交不会给其他并行等待项伪造答案。全局运行终态在恢复确认之后处理，避免先把待确认卡片错误过期。
- 根 null 按正式 AG-UI 1.0 限制在发出请求前拒绝，应走 Interaction/v1；对象内部 null 保留。没有使用私有包装或 sentinel 绕过协议。[官方 Schema](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/spec/1.0/schema.mdx)

## 验证范围

前后端使用字节一致的 16 组 JSON Schema 样本，涵盖 draft 4/6/7/2019/2020、本地引用、组合、日期、嵌套和 JSON 基础值。

样本 SHA256：`80340123e1c4131de570e8017c4fea8f5752b36e1276ee74138a2346a52a5b78`。

本批已执行：

- TypeScript 检查和全项目 ESLint 通过。
- Vitest 当前源码 1031 passed；Node 测试 128 passed。
- SDK shared Schema 样本 16 passed；原生图、AG-UI 与 null 持久化另有实际执行记录。
- `build:all` 的 KSADK、Hosted、Demo 和库构建通过；未发布 npm 包。
- 真实 Chrome 表单控件专项 2 passed：混合嵌套值、错误 JSON 草稿、标量根答案。页面没有拦截 Runtime API，也没有实际启动 Agent，因此只属于控件回归，不计作真实 Agent E2E。

原始日志保存在当前任务的 `implementation-20261020/` 证据目录。单测中的 fetch/SSE fixture 用于 UI 回归，不能代替真实后端验收。

## 尚未完成

- SDK 本地公共控制入口、直接 AG-UI 的统一持久化恢复和故障对账仍在实现；阶段 1、2 尚未共同签收。
- 当前仍是原有 A2UI renderer；官方 renderer、目录资产、增量生命周期属于阶段 3。
- 真实 FastAPI + LangGraph + SQLite + 产品页面的独立 E2E、真实模型、候选 wheel 与 tarball 尚未交付。
- Server、Gateway、Hosted 部署、双实例和预发尚未验收。

以上为阶段 2 当时状态；后续实际进度见下节及 SDK 的实施记录。

## 阶段 3 的正式 A2UI 集成

- 已迁入正式 React/core renderer，依赖固定为 0.13.0，Markdown 0.2.1；JS AG-UI 包为 1.0.2。renderer 在浏览器懒加载，避免 HTMLElement/DOMPurify 破坏 SSR 导入。
- 与 SDK 共用字节一致的官方目录、common-types、兼容目录和 manifest。完整官方目录的 JCS 摘要为 `34eefcf32a13860465c71e340dd8c6c2f5f328865db140fa31ab83e30cbf42b1`。构建校验上游字节与依赖，产物输出 `a2ui/` 原文件用于 wheel 对账。
- 每个 surface 使用持久 processor，增量不重置输入。删除重建后旧实例回调失效，终态禁止 action；实时、历史及重放的同一批次归并展示。原七组件经独立兼容目录验证和渲染。
- 活跃交互只在输入区提供一份可操作卡片，历史副本保持只读。非法/未知展示降级至 Runtime 保存的 Schema，展示内容不能提供另一份业务 Schema。
- 服务端只有在具备实际事件重放能力时才宣告 `SessionEventReplay`，前端据此选择可恢复的 AG-UI；旧 peer 的 Responses 选择规则保留。
- 旧编号选择、多选及自定义回答已保留在 JsonValue 通用表单中；不再因控件替换丢失 Codex 输入能力。
- 最近完成：1041 Vitest、128 Node、typecheck/lint、四类构建；旧浏览器运行归属 6、重连 5、交互/审批 20 通过。另有真实 SDK 后端、LangGraph、SQLite、产品构建与 Chrome 的 4 项 E2E，以及真实模型生成卡片的 1 项 E2E，通过；两类测试均未拦截 API/SSE。后续最终报告以 SDK 实施记录为准。
- 仍需完成兼容传输组合、候选包/干净安装和云端链路；本地 M1 尚未签收。Mock 浏览器回归仍只作为 UI 回归证据。

## 前台兼容与候选包准备

- 可恢复的 AG-UI 请求保留模型选择、reasoning 和工具权限选项；前台附件按既有 RunAgent 上传流程进入同一交互账本。后台或旧 Responses 未宣告 A2UI 的能力保持原范围。
- 真后端/真浏览器最终本地集合扩为 5 项，包含实际上传附件；全部通过。三类真实模型生成又分别执行通过。浏览器报告携带 checkpoint 前后、公开提交身份与实际工具计数，输出可用 `KSADK_TEST_OUTPUT_DIR` 分次保留。
- `KSADK_TEST_RUNTIME_PYTHON`、`KSADK_TEST_RUNTIME_APP_DIR`、`KSADK_TEST_A2UI_WEB` 可让同一套 E2E 针对干净安装 wheel 和包内静态页运行；不会改成 API/SSE mock。
- 本地联调继续使用标准 `npm pack`，由原有 `prepack` 构建库和页面；测试归档保留在本地忽略目录，不使用专用候选标记或新的打包入口。SDK 正式构建消费固定的已发布 npm 版本，本地测试通过不表示 Web 已发布。
- 本批 Web 单测为 1042 passed；候选包安装后的结果及 M1 签收另记。

## SDK Studio 消费者兼容检查

SDK 原固定的未发布 Web 包含有当前 main 未保留的宿主展示扩展。已按其类型声明补回可选的 `showAgentHeader`、`renderProcessingBlock`、思考来源及 contextActivity 类型；没有整文件覆盖当前源码。宿主可在原 block 位置定制展示，返回 undefined 保持默认展示，null 明确隐藏。默认内置页面行为保留，新增实际渲染测试验证顺序和降级。

明确标为 public_summary/provider_reasoning 的来源经过 canonical 与历史转换保留，不把未标记内容推断为公开摘要。最近类型/lint、四构建和 **1043 项单测**通过。SDK 消费者的投递回执四项失败已在旧固定包上同样复现，属于测试间未隔离 localStorage；SDK 正在修正 fixture 并重新跑实际消费者验证。候选包须据此重新生成，之前 2c00a25 的 tarball 不作为最终交付。

## 统一交互游标与输出隔离

- AG-UI CUSTOM 中的 `ksadk.session_event` 仅接收当前会话的 Interaction/v1 公共 envelope，转入既有 SessionEvent 通路，保留物理 seq 和原逻辑 Run。
- 正式 interrupt 标注为 Interaction/v1 时不再创建另一张 legacy 审批卡，避免 wire attempt ID 覆盖原运行身份。
- canonical 展示层同时遵循 `visibility` 和既有 `conversation_visibility`，隐藏内部上下文；普通业务 JSON 与工具输出保留。
- 实测 1033 Vitest、128 Node 测试、typecheck、lint 和四类构建通过。证据为 `web-kernel-agui.json/log`、`web-kernel-build.log`。
- 本批测试不能代替真实后端与产品 Chromium 联合验收；当前产品仍未迁入正式 A2UI renderer。

## Hosted 消费者追加验证（2026-10-20）

真实 Runtime 浏览器 harness 支持可选的入口路径，默认本地五项行为不变。使用 `/hosted-ui/chat/` 和 Hosted 消费者实际构建的 bundle，资源、行程、工单三类卡片实时显示、纠错、原生恢复与刷新去重 **3 passed**，没有拦截 Runtime API 或 SSE。产物仍绑定已经审查的 Web 源提交 `7b6c8fc16fdd8260da36e1d312bf46932479aa2e`；本次仅调整测试入口，不重新声明另一份产品 tarball。

这属于本机消费者集成验证；鉴权预发、TUI/workspace 的真实业务动作和云端多实例验收另列，不能据此签收 M2/M3。

## MCP 与实际 Runtime 镜像验证

测试 harness 通过 `KSADK_TEST_A2UI_MCP=1` 调用 SDK 的本地 stdio MCP fixture，实际执行 initialize/call_tool，三类业务的提交、工具更新与刷新去重 **3 passed**。`KSADK_TEST_A2UI_SUBGRAPH=1` 可将暂停点放入真实子图；三类源码浏览器场景 **3 passed**。

`KSADK_TEST_RUNTIME_DOCKER_IMAGE` 可选择已构建的 Host 镜像，`KSADK_TEST_RUNTIME_APP_DIR` 指向独立 fixture 目录；项目目录作为持久卷挂载，实际使用 Linux 镜像中安装的 wheel 和静态页。原五项 E2E 在首个候选镜像上 **5 passed**，包含后端容器重启。新源码对应的新镜像结果必须另行核对，不沿用旧包结果。

启动失败和测试结束都清理本测试创建的进程/容器。追加这些测试能力后，默认真实后端五项 **5 passed**（`runtime-harness-final.log`）；没有拦截 Runtime API/SSE，也没有修改选定的产品 Web tarball。MCP fixture 只证明协议接入，不替代客户私有 MCP 服务验收。
