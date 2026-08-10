---
description: 推送代码与标签（含安全同步检查）
agent: build
---

1. **检查状态**：`git status -sb` 与 `git ls-remote --tags origin`；本地无领先提交且本地 tag 已全部同步 → 提示"没有可推送的内容"并终止
2. **同步上游**：`git fetch origin`；若本地落后（`git rev-list --count HEAD..@{upstream}` > 0）：
   - 工作区有改动 → 先 `git stash push -u`，再 `git pull --rebase`，成功后 `git stash pop`
   - 任何冲突 → 停止并报告，不强行解决
3. **推送代码**：存在上游 → `git push`；无上游 → `git push -u origin HEAD`（首次推送）
4. **推送标签**：`git push --tags`（仓库使用轻量标签，`--follow-tags` 不生效，勿替换）
5. **验证**：`git status -sb` 显示 up-to-date；`git ls-remote --tags origin` 确认本地 tag 全部同步；推送失败（non-fast-forward 等）→ 报告错误，**禁止** `--force` 强推
