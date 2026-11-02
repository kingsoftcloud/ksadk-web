# Vitest 本地工作树发现范围修正

2026-11-02，合并 `origin/main@86947f00` 后执行开发发布预检。

原 `npm test` 使用 `vitest run src`。这里的 `src` 是路径过滤条件，会匹配
`.worktrees/*/src`，并非将测试扫描限制在当前 checkout 的根 `src`。
本机有多个正常保留的旧 Git worktree，各自使用不同依赖和测试基线。

首次预检误扫描这些 checkout，产生 32 项旧组件依赖缺失的 suite 错误，及
1 项旧状态横幅断言失败。其 3101 项通过总数也包含旧 checkout，不能作为
当前源码的测试通过数。原始日志保留在本地
`output/main-sync-20261102/release-development-preflight.log`。

新增独立 `vitest.config.ts`，合并原 Vite 配置，保留 Vitest 默认排除规则，
仅追加 `**/.worktrees/**`。已有 ESLint 配置已经排除该目录，无需更改。
将新增配置纳入 Node TypeScript 检查；未修改产品代码、依赖或其他工作树。

修正后当前 checkout 的 **115 个测试文件、1340 项测试全部通过**；类型检查、
新增配置 ESLint 和 `git diff --check` 通过。后续完整发布预检另外记录，
不能将这次单独测试等同于完成浏览器、包消费者及正式版本发布验收。
