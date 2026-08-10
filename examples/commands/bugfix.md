---
description: 拉取最新源码，随机查找程序中的 bug 并谨慎修复（含集成测试与浏览器注册用户前端测试）
agent: build
---

执行「拉取最新源码 → 随机查找 bug → 谨慎修复 → 集成测试 → 浏览器前端测试」全流程：

1. **同步最新源码**：`git fetch origin`；本地落后上游 → 工作区有未提交改动 → **`git stash push -u` 安全暂存（修改完整保留，不覆盖不丢失）** → `git pull --rebase` → `git stash pop` 恢复；工作区干净 → 直接 `git pull --rebase`；rebase 或 stash pop 冲突 → **停止报告**（附冲突文件清单与关键 diff 供用户决策；可 `git rebase --abort` 回退）；**严禁 `git reset --hard` / `git checkout -- .` / `git restore .` 或丢弃 stash**
2. **随机选区**：用 explore/glob/grep 快速浏览仓库结构，随机挑选 1 个业务模块（优先 `Platform.ApiService/` 或 `Platform.Admin/src/` 的业务代码，避开基础设施/模板文件）；参考 `git log --oneline -10` 最近改动，尽量避开刚改过的区域
3. **查找 bug**：审查该模块，重点检查：
   - 错误处理缺失、异常被吞、`throw` 后无清理
   - 空引用与边界条件（null/空集合/0 长度/并发修改）
   - 违反 AGENTS.md 数据库查询限制（N+1、`foreach + CountAsync`、被禁的 EF 操作）
   - DTO 与 Entity 字段不一致、冗余字段（如 `createdByName`）
   - 新增错误码未按「后端常量+字典 → 前端 i18n」同步
   - 权限校验缺失（`[RequireMenu]`/`[RequireAction]`）
4. **谨慎修复**：
   - 仅修复**确认**的 bug；不确定的疑点 → 记入报告而不修改
   - 最小改动、不重构无关代码；修复 bug 而非改风格/格式
   - 保持行为不变优先；涉及公共基础设施/接口契约的变更 → 不做，报告由主调度决定
5. **验证-后端集成测试**：按 AGENTS.md「测试范围」只运行与修改相关的集成测试，**禁止全量测试**：
   - 修改某 Controller/Service/Entity → 根目录 `dotnet test Platform.ApiService.Tests -c Test --filter "FullyQualifiedName~XxxControllerTests"`（按修改的 Controller 定位测试类）；基础设施/过滤器 → `--filter "FullyQualifiedName~ApiResponseFormatTests"`；AppHost 模型 → `dotnet test Platform.AppHost.Tests -c Test`
   - **修改的模块若无对应测试类 → 先按仓库测试模板补写最小集成测试覆盖修复点**（继承 `ApiServiceTestBase`，覆盖 401 鉴权 / 正常 200 / 403 权限 / 多租户隔离），再运行
   - 后端构建用 `dotnet build -c Test`（产物隔离，不干扰运行中的 Aspire）；前端改动另跑 `Platform.Admin/` → `npm run lint`；**验证未通过 → 不提交**，修复后重跑
6. **验证-前端浏览器测试**（Playwright，修复涉及前端页面或需端到端确认时执行）：
   - **前置**：确认 Admin 已运行（`aspire start` 或 `Platform.Admin/` `npm run dev`），用 `playwright_browser_navigate` 打开 Admin 地址（可从 Aspire dashboard 资源端点或 `Platform.Admin` dev server 获取）
   - **自行注册测试用户**：登录页 → 进入注册（登录页「没有账号？立即注册」或 `/user/register`）→ 用明显标记的测试账号注册并登录（用户名/邮箱带 `bugfix_<时间戳>`，密码符合策略）；注册要求邮箱验证 → 按提示完成，或改用 `POST /apiservice/api/register-simple` API 注册后登录；登录若要求图形验证码 → 截图读取验证码输入
   - **功能验证**：导航到修复涉及的页面（路由见 `Platform.Admin/config/routes.ts`），执行与修复点对应的操作：正常路径（加载/CRUD/筛选）+ 边界输入（空值/非法输入）+ 错误提示；用 `playwright_browser_console_messages` 检查无 console error，必要时截图留证
   - **权限不足时**：注册用户无目标页面权限（403）→ 报告说明权限受限无法完整验证，**不得**擅自提升权限或改数据库
   - **不污染数据**：浏览器操作只产生带标记的测试数据；**浏览器验证失败 → 不提交**，修复后重跑
7. **提交源码**（验证全部通过后执行；无修复内容或全部为疑点 → 不提交，仅报告）：
   - **同步**：按第 1 步逻辑：有未提交改动先 `git stash push -u` → `git pull --rebase` → `git stash pop`；冲突 → 停止报告（不丢弃 stash）
   - **审查提交**：`git diff` 复查，**只提交本次修复自己修改的文件**（逐一手动 `git add <文件>`，禁止 `git add -A` / `git add .`）；提交信息 `fix(模块): 简体中文描述`；提交失败 → 修复后新建提交，不 amend
   - **收尾**：`git status` 无遗留未提交/未跟踪变更；**不自动 push**，报告时提示用户可自行推送
8. **报告**：总结修复内容（文件/问题/改动/提交 hash）、集成测试结果（测试类/用例/通过情况）、浏览器测试结果（注册测试账号/验证页面/console 错误/截图）与遗留疑点
