# Subagent TUI 对比：常驻摘要、inline 卡片、live inspector 与独立 pane

核查日期：2026-10-03。仅调研，不修改实现；没有运行上游插件或观看演示视频。比较对象是两个真实 Pi 插件、宿主官方 subagent 示例，以及 OpenCode TUI。结论依据下面列出的一级源码/README，而非搜索摘要。

## 取证范围与访问限制

- 先用 `web_search` 分别搜索 Pi 插件、HazAT 的 UI、OpenCode 子会话导航；确认正确仓库名为 **nicobailon/pi-subagents**，不是 `nicobail/pi-subagents`。
- `fetch_content` 尝试读取 raw GitHub、GitHub 页面、OpenCode 官方站，均被 `198.18.0.0/15` fake-IP 的 SSRF 检查阻止。**没有修改安全/网络配置，没有配置认证。**随后通过匿名 `curl` 读取 GitHub 官方 API 的 commit/tree/contents，base64 解码后实际阅读 README 和源码；网站访问失败不等于仓库源码无法访问。
- API 固定提交：nicobailon `ad56bf92fe01a2a5abd962938c619eb2a22ca47d`；HazAT `c100577ebf7393a11d098ad9810ec6c269dcfc30`；OpenCode `108b988a08227df45417f27905a4d6b27ad49b6d`。下文链接固定到这些提交；不保证未来默认分支保持同样行为。
- 官方 Pi 示例来自本地 `@earendil-works/pi-coding-agent` **1.0.0**，package 元数据指向 `earendil-works/pi`。下文网上示例 URL 仅用于定位，未证明网上 main 与本地发布包一致。
- 当前项目基线只读 `pi-extension/subagents/ui.ts` 的工作区版本；它已有未提交改动，不能用旧 HEAD 代表本次基线。

## 一眼比较

| 方案 | 主界面 widget / 工具卡片 | 按需详情表面 | live / snapshot | 多任务噪声控制 |
|---|---|---|---|---|
| 当前插件 | 最多 3 个活跃预览；结果消息折叠 4 行正文 | 两级 select → editor；无自建分栏 dashboard | widget 读取任务记录；editor **snapshot**，重开刷新 | `+N more`；最多 5 个 attention 行；完成摘要 8 秒窗口 |
| nicobailon/pi-subagents | editor 下方 FleetView；另有 compact/expanded 工具结果 | **居中 overlay，左 roster / 右详情分栏** | inspector 定时刷新，含 transcript tail、自动跟随 | 非激活 FleetView 是一行摘要；激活时默认最多 6 个树行；overlay 打开隐藏 widget |
| HazAT/pi-interactive-subagents | editor 上方运行状态框；完成结果消息卡片 | **终端复用器真实 split pane**，每个 child 是独立 Pi 会话 | 状态快照持续更新；pane 是真实会话；完成卡片是结果展示 | 每个运行 agent 一行，未见行数上限；普通状态变化不唤醒 parent；结果折叠 5 行 |
| Pi 官方 subagent 示例 1.0.0 | **inline tool result card**；parallel 总状态 + 每 agent 小分区 | Ctrl+O 展开原工具结果；未见独立 dashboard/pane | 运行中流式更新；parallel 全量展开须所有任务停止运行 | 每 agent 最近 5 项，但仍逐个列出全部 agent，整体高度随数量增加 |
| OpenCode | parent 的 **inline Task 卡片**：描述 + 当前工具/重试/完成统计 | 点击卡片切换到 child session；小 actions dialog 只提供 Open | sync 状态驱动卡片；详情是 live 子会话，不是 editor 快照 | parent 不铺满 transcript，仅当前工具/统计；child footer 显示 sibling 序号 |

“split”需区分：nicobailon 是**一个 overlay 内的逻辑分栏**；HazAT 是**多个终端 pane**；OpenCode 是**会话路由切换**。不能将它们统称为全屏多代理 dashboard。

## 1. 当前插件：有界常驻摘要 + 明示快照

一级证据：[本地 ui.ts](../../pi-extension/subagents/ui.ts)（相对于本报告位置）。

- `TaskWidget.lines()`：活跃任务 `slice(0, 3)`，溢出 `+N more active`；未答问题与 shutdown 未确认独立构成 attention，`slice(0, 5)`。因此并非“最多只显示三行”，而是三条活跃预览**另加**有界 attention。
- `TaskWidget.result()`：8 秒 recent 窗口；无活跃任务时才汇总近期 completed/failed/cancelled，不把持久历史重新当新通知。
- `widget()`：TUI 自定义组件逐次 render 从 manager 读取记录、使用 theme 语义色并按宽度截断；RPC 退化为文本 widget。这里只能证明 render 读最新记录，不能仅凭此文件证明外部刷新频率。
- `taskMenu()`：`/subagents` 任务选择 → Details / Message / Answer question / Cancel / Continue。Details 使用 `ctx.ui.editor()`；`detail()` 明写 `Snapshot only · reopen to refresh · edits are not saved`，没有详情订阅、分栏或自定义按键处理。
- `resultRenderer()`：折叠标题截断、正文前 4 行，展开完整报告；这是结果消息渲染，不应与实时任务详情混淆。

**定位**：低复杂度、宿主原生 select/editor 的方案已适合少量后台任务；当前缺的不是颜色，而是“查看细节时不用反复关闭重开”的交互。

## 2. nicobailon/pi-subagents：最接近可借鉴的 live fleet inspector

一级来源与具体证据：

- [README：Background work / FleetView](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/README.md)：明确说 editor 下方常驻 FleetView，`/subagents-fleet` 打开 live inspector，支持浏览 child、读 transcript、steer、stop。
- [`src/tui/fleet-status.ts` L543–709](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/fleet-status.ts#L543-L709)：默认 `belowEditor`，刷新默认值为 500ms；注册自定义 widget，而非把任务列表反复追加到聊天里。
- [同文件 L785–848](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/fleet-status.ts#L785-L848)：未激活时输出一行 active/capacity/usage 摘要；激活时带选择提示、main 行、任务树。`MAX_AGENT_ROWS = 6`，可视窗口围绕选中项滑动，显示上下 `more`；这不是永远展开六条完整日志。
- [`src/tui/fleet.ts` L833–886](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/fleet.ts#L833-L886)：默认 750ms 定时 invalidate/requestRender，保留 selected key。L1339–1387 的 `render()` 将宽度分为 roster 与 detail，详情有 viewport/scroll，`detailAutoFollow` 时追随底部。
- [同文件 L1399–1465](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/fleet.ts#L1399-L1465)：`ctx.ui.custom(..., { overlay: true })`，居中、95% 宽、最大 85% 高；打开时清空常驻 fleet widget，避免重复占屏。不是外部 mux pane。
- [同文件 L27–52](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/fleet.ts#L27-L52)：`↑/↓` 或 `j/k` 选任务，`J/K` 滚详情，Enter/H inspect，`s` steer，**Shift+D** stop，`x/X/Ctrl+O` 工具开关，`r/R` refresh，Esc/Ctrl+C/q 关闭。不能把小写 `d` 写成停止键。
- [`src/runs/background/fleet-view.ts`](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/runs/background/fleet-view.ts)：transcript 读取 tail，并设行数、单行长度、字节预算；`fleet.ts` 默认 transcript 200 行、输出尾部 64KiB。**live 不等于无限日志或零延迟**。
- [`src/tui/render.ts` L3456 起](https://github.com/nicobailon/pi-subagents/blob/ad56bf92fe01a2a5abd962938c619eb2a22ca47d/src/tui/render.ts#L3456)：另有 compact/expanded `renderSubagentResult()`；parallel 标签 L1968 起计算 running 与 done/total。常驻 fleet、工具卡片、inspect 三个表面是不同职责，不能只看 README 的 fleet 名称就合并理解。

**可借鉴点**：任务列表与选中详情分离；保持选中对象；按需 live；日志限额与自动跟随；退出查看后恢复轻摘要。该仓库还包括 workflow/外部 job/Prompt Audit 等能力，本项目不需要整套搬入。

演示资产：[README 内嵌链接](https://github.com/user-attachments/assets/702554ec-faaf-4635-80aa-fb5d6e292fd1)。仅确认链接存在，**未打开或观看**，不据此评价动画/实际配色。

## 3. HazAT/pi-interactive-subagents：独立终端 pane，而非详情 overlay

一级来源与具体证据：

- [README](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md)：支持 cmux/tmux/zellij/WezTerm，每个 subagent 独立 pane；声明 cmux/tmux 创建不抢键盘焦点，`interactive` 控制 parent 通知而非焦点。
- [`pi-extension/subagents/cmux.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts)：包含 cmux `new-split`、焦点快照/恢复，以及 Zellij 安全 split 目标选择。它是真实终端布局集成；不能推断四个 backend 的所有焦点行为完全一致。
- [`pi-extension/subagents/index.ts` L599–648](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L599-L648)：`renderSubagentWidgetLines()` 用边框包住 `count running`，逐 agent 显示 elapsed/name/role/right status；`placement: aboveEditor`，无运行任务即移除。该循环遍历全部 agent，**此处未发现类似三条上限**。
- [`pi-extension/subagents/status.ts`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts) 与 README 的状态段：starting/active/waiting/stalled 来源于 child-written runtime snapshot；stalled 不能简单等同“耗时太久”，有效 long-running active/waiting 不因时间流逝自动判 stalled。
- [`index.ts` L838–881](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L838-L881)：只有 stalled/recovered transition 且非 interactive 才进入 parent 通知，并对通知行数限额；普通状态转换留在 widget。**减少 parent 被低价值状态消息唤醒**，与视觉日志去噪不同但同样重要。
- [`index.ts` L2007–2087](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L2007-L2087)：完成消息 `subagent_result` 使用 success/error 背景，折叠前 5 行和剩余行数；展开完整 summary + session 路径 + `pi --session` 恢复命令。README 给出 Ctrl+O；源码用宿主 `app.tools.expand` key hint，实际配置可能不同。
- README “Tools Widget” 明确子会话内 Ctrl+J 切换 available/denied tools。**这是每个 child 的工具权限 widget，不是 parent 任务列表展开键**；此次未继续定位该功能实现文件，只按第一方 README 确认设计声明。

**操作映射**：进入/切换 pane 依赖所选复用器的键位，不存在一个在全部 backend 上统一验证过的 pane 快捷键；父 agent 可调用工具管理 child。README 还说明 interrupt 向 child 发 Escape，取消当前 model turn、保留会话，这与彻底销毁任务不同。

**取舍**：完整交互会话可随时手工介入，适合长期 interactive child；代价是复用器依赖与 pane 管理负担。当前独立 RPC + snapshot 路线不能靠换一段 UI 渲染代码就变成这种架构。

演示资产：[README 内嵌链接](https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f)。**未观看**。

## 4. Pi 官方示例：inline parallel 卡片，值得保留的低成本模式

一级来源：本地宿主 **1.0.0** 的完整 `examples/extensions/subagent/README.md`，及 `index.ts` L945–1035。网上定位：[README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)、[index.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts)；不将 main 链接冒充本地固定版本证据。

本地路径：

```text
/home/spike/.local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/README.md
/home/spike/.local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts
```

- parallel 运行中标题是 `x/y done, n running`，每个 agent 有分区和 ⏳/✓/✗；`renderDisplayItems(displayItems, 5)` 只显示最近 5 条工具/文本。
- Ctrl+O 是宿主工具结果展开操作。源码严格为 **`expanded && !isRunning`** 才走全量 Container：完整 task、工具调用、final Markdown、每任务 usage 和总 usage。因此“Ctrl+O 可在 parallel 运行中看全部历史”不成立；运行中仍落入 compact 分支。
- 无独立 overlay/split pane/任务选择导航；它更像一张不断更新的批处理工具卡片。README 明确 parallel 最多 8 个任务、4 个并发。
- 噪声限制是**每个 agent 的尾部限额**，不是整个列表只显示前几个；同时显示大量 agent 时仍可能很高。
- README 说明 Ctrl+C 传播中止子进程；不是一组 per-agent steer/answer/cancel 交互键。

**可借鉴点**：让批次卡片有稳定总进度、每任务终态，并在结束后展开结构化结果与 usage；不必为此引入 dashboard。当前项目单任务消息与批次 workflow 结果可分开考虑，不能把“一个任务完成”误写成“整批完成”。

## 5. OpenCode：薄 Task 卡片 → 完整 child session

官方网站抓取失败，但读取到同项目官方文档源码与 UI 源码：

- [`packages/web/src/content/docs/agents.mdx` L131–136](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/web/src/content/docs/agents.mdx#L131-L136) 和 [`keybinds.mdx` L192–200](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/web/src/content/docs/keybinds.mdx#L192-L200)：parent 用 Leader+Down 进入首个 child；child 内 Right/Left 切 sibling，Up 返回 parent；默认 leader 为 Ctrl+X。源码 [`packages/tui/src/config/keybind.ts` L103–106](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/tui/src/config/keybind.ts#L103-L106) 与这份文档一致，不沿用搜索可能出现的旧版 leader+左右说明。
- [`packages/tui/src/routes/session/index.tsx` L2215–2320](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/tui/src/routes/session/index.tsx#L2215-L2320)：`Task()` 通过 metadata sessionId 同步 child messages，用 reactive memo 获取工具/状态；运行中只显示当前工具标题或 toolcall 数，retry 显示尝试次数与截断原因；完成显示调用数/耗时。`InlineTool` 点击 `navigate({ type: "session", sessionID })`，不是展开一份静态报告。
- [`dialog-subagent.tsx`](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/tui/src/routes/session/dialog-subagent.tsx)：Subagent Actions dialog 只有 Open 选项，选择后跳到子会话并关闭 dialog。不要把它描述成多操作 dashboard。
- [`subagent-footer.tsx`](https://github.com/anomalyco/opencode/blob/108b988a08227df45417f27905a4d6b27ad49b6d/packages/tui/src/routes/session/subagent-footer.tsx)：按共同 parentID 排序 siblings，显示 `index of total`、context tokens/百分比、cost，Parent/Prev/Next 同时有鼠标入口和真实 shortcut 标签。

**表面与噪声**：parent inline 卡片提供短状态，完整 transcript 放到单个 child session 中查看；未在这些路径发现常驻多任务 widget 或所有 child 同屏 pane。它的优势是复用完整 session UI、保留清晰返回路径，不是同时监控多条滚动日志。

本次未寻找/验证该固定版本的官方 TUI 截图，不用网页/app 截图替代终端证据。

## 对当前插件的建议：优先级与止步点（不实施）

1. **P0：维持“有界常驻摘要 / 按需详情 / 完成结果”的职责分离。**保留现有 3 条预览、attention 和 snapshot 标签；参考 OpenCode 只把当前工具或一句活动放 parent，不流式追加完整正文。任何新详情必须明示 live 或 snapshot，不能把现有 editor 改名为 live dashboard。
2. **P1：首先补轻量刷新体验，再决定是否做 overlay。**可讨论在详情外加“刷新/重新打开”入口；若实际频繁查看 live transcript 的需求成立，再采用 nicobailon 式 roster + selected detail overlay。止步点是一个可选入口，不同时引入 workflow 审计、外部 inspector、mux backend 等体系。
3. **P1：如果做 live，优先保证稳定与噪声预算。**保留 selected task ID；日志 tail 有行数/字节限额；用户手动上滚后暂停 auto-follow；离开详情才恢复简短 widget。这比额外边框或更多状态色优先。窄终端需要单栏退化，不能直接照搬 95% 分栏假设。
4. **P2：借鉴批次进度，而非复制所有 agent 日志。**workflow/parallel 的 inline 结果可有 `done/total · running · failed`，结束后展开完整报告；running 与 failed 不能被 done 单一成功色掩盖。官方示例的“每人 5 项”仍可能很高，当前全局上限值得保留。
5. **P2：把可操作项和状态语义放到用户能发现的地方。**参考 footer 显示真实绑定；优先暴露待回答问题与 shutdown 未确认，保留 Cancel 的确认以及“消息被接受不等于执行完成”。HazAT 的减少无价值状态唤醒原则可借鉴；但不直接引入它的 stale watchdog 或把 waiting 当故障。

## 未验证与风险边界

- 这是源码/文档比较，不是终端实测；没有验证终端尺寸、主题切换、滚动手感、闪烁、刷新资源消耗、任务几十个时的真实表现，也没有确认快捷键与宿主个人配置是否冲突。
- 第一方 README 的 pane 焦点和 Ctrl+J 声明不等于对每个 backend 的运行验证；OpenCode child 导航也未用正在运行的 session 测试。
- nicobailon inspector 的 tail/定时刷新说明它是 live 视图，但不证明能看到全部历史或与 child 完全同步；OpenCode sync-driven UI 同样不保证零延迟。
- 当前 `ui.ts` 已美化，建议针对其实际缺口，不重做颜色，不把已有 select/editor 当成全屏 live inspector。是否扩展为 overlay 属于下一步产品/接口决策，本报告不授权实施。
- 取证临时文件在 `/tmp/subagent-tui-research`；项目仅新增本报告。上游源码通过匿名 API 获取，未启动代理、安装插件或更改认证。
