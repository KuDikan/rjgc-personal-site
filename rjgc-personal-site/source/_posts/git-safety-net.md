---
title: 用 Git 记录 Agent 的改动
date: 2026-10-07 21:30:00
tags:
  - Git
  - Agent
categories:
  - 技术
description: Agent 会改很多文件，也会改错。Git 是安全绳，但前提是你真的用它。
---

Agent 能一次性改几十个文件，也能一次改错几十个地方。
Git 是这件事的安全绳。

## 没有 Git 的时候

```text
网站-最终版/
网站-最终版2/
网站-真的最终版/
网站-这次真的能用/
```

这几乎每个人都干过，包括我。

## Agent 改动时的三条纪律

**一、提交前先看 diff。**

```bash
git diff
git status
```

不是"看一眼"，是逐文件确认。Agent 说"我改好了"的时候，
你要知道它到底改了什么。

**二、commit message 要能解释意图。**

```text
feat: scaffold hexo 7 + shokax site
fix: pin hexo to7.3.0 to match theme dependency
```

`update` 和 `fix stuff` 这种信息量为零。一年后你看 `git log`，
只有能读懂的消息才有用。

**三、一次提交只做一件事。**

脚手架、内容、脚本、部署配置——分开提交。
这样出问题时 `git bisect` 或 `git revert` 能精确到单个变更。

## 关键提醒：不要替用户 push

这是我在 `AGENTS.md` 里给自己写的硬约束：

```text
1. 在提交前展示 git diff 和将被提交的文件；
2. 不要替我执行 git push；
3. 不要修改我的全局 Git 配置。
```

第2 条尤其重要。`git push` 是不可逆的外部动作，
而 commit 是本地的、可撤销的。把这两类操作区分开，是协作的基本边界。

## 回滚为什么比"再改一次"可靠

假设线上部署坏了。你有两个选择：

- **方案A**：让 Agent 再改一遍，然后重新部署
- **方案B**：`git revert` 掉那个 commit，然后重新部署

方案 B 的结果是可以预测的——它精确回到上一个已知良好状态。
方案 A 的结果取决于 Agent 这次能不能猜对问题在哪。

当问题原因不确定时，能回到确定的状态比"再试一次"值钱得多。

相关阅读：[[与Agent 协作的第一步是把需求写清楚]]