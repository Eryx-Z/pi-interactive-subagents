# Coding-agent 写入并发：GitHub 源码核查

本次核查固定提交，不假设所有产品模式行为一致。未修改实现、未运行这些上游项目。后台研究代理因凭据缺失未启动，以下由主代理直接读取 GitHub 完成。

## Codex：内置多代理共享目录

提交：`b0659c53865dd48b0cd69c454368cea3980017cc`。

- 多代理指令明确声明所有 agent 共享容器、文件系统、cwd；修改立即相互可见。
  https://github.com/openai/codex/blob/b0659c53865dd48b0cd69c454368cea3980017cc/codex-rs/prompts/src/multi_agent_instructions.rs#L11-L17
- 子代理配置继承 turn.cwd。
  https://github.com/openai/codex/blob/b0659c53865dd48b0cd69c454368cea3980017cc/codex-rs/core/src/agent/child_config.rs#L170-L183
- 编排提示鼓励可行时并行运行多个步骤，并要求保留他人改动。
  https://github.com/openai/codex/blob/b0659c53865dd48b0cd69c454368cea3980017cc/codex-rs/core/templates/agents/orchestrator.md

结论：不能把 Codex 云端/app 的任务隔离等同于 CLI 内置子代理隔离。此次未证明其所有写入路径是否存在跨代理文件锁。

## OpenCode：edit 工具有按文件的进程内互斥

提交：`88c6c7abc7f320b6aabed2634ac0b2d6e6ecea67`。

- `edit.ts` 用规范化路径作为 Map key，每个路径一个单许可 Semaphore。
- `withPermits(1)` 包住读取当前文件、替换、权限询问、写入和格式化；不同路径使用不同 semaphore。
  https://github.com/anomalyco/opencode/blob/88c6c7abc7f320b6aabed2634ac0b2d6e6ecea67/packages/opencode/src/tool/edit.ts#L36-L46
  https://github.com/anomalyco/opencode/blob/88c6c7abc7f320b6aabed2634ac0b2d6e6ecea67/packages/opencode/src/tool/edit.ts#L89-L174
- 替换失败或匹配不唯一会报错，但不是对 agent 上次读取版本的完整校验。
  https://github.com/anomalyco/opencode/blob/88c6c7abc7f320b6aabed2634ac0b2d6e6ecea67/packages/opencode/src/tool/edit.ts#L682-L729
- `write.ts` 的读取、整文件写入路径没有调用上述 edit semaphore；不能据此宣称全工具或跨进程写入安全。
  https://github.com/anomalyco/opencode/blob/88c6c7abc7f320b6aabed2634ac0b2d6e6ecea67/packages/opencode/src/tool/write.ts#L38-L67

结论：用户提出的“编辑时加锁，其他 agent 等待”有现成实现参考，但该锁有明确适用边界。

## Claude Code：官方仓库记录可选 worktree 隔离

提交：`68ac8bbf0245b615b41517bf8f2b2f35af1ae31d`。

官方 CHANGELOG 记录子代理支持 `isolation: "worktree"`，agent 定义支持 `isolation: worktree`。
https://github.com/anthropics/claude-code/blob/68ac8bbf0245b615b41517bf8f2b2f35af1ae31d/CHANGELOG.md#L5109-L5131

仅据此确认该能力；未核实内部文件锁实现，不把 changelog 当成实现源码。

## 对本项目的启示

当前子代理是独立 RPC 进程。不能照搬进程内 Map 当成跨代理锁：需要父进程锁服务或跨进程协调。可以缩小锁粒度以允许 full 步骤并行，但需要先明确 edit/write/bash 的保护范围、取消释放与过期读取行为。权限与并发策略不应混为一谈。
