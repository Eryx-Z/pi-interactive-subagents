# pi-interactive-subagents — RPC v1

Lightweight parallel subagents for Pi, without tmux. Each task runs in a background Pi RPC process with its own conversation. All tasks use the shared working directory unless an explicit `cwd` is supplied. The parent session displays progress, receives results and questions, and controls children.

This is the **4.0.0 breaking redesign** of the earlier tmux implementation. Target: `@earendil-works/pi-coding-agent` **0.85.1–0.85.x**, Node **22+**. It uses `agent_settled`, current extension tool APIs, and blocking RPC UI input. Older `@mariozechner` Pi versions are not supported.

## Model of operation

- One task → one child process → one persistent session.
- The parent assigns file/module ownership. Reads and writes can run in parallel; workers must preserve each other's changes and ask before changing shared interfaces or working outside their scope.
- Ownership is a cooperation agreement, **not a filesystem sandbox or lock**. Shared ports, databases, build outputs and edits can still conflict. The parent validates the combined result.
- Children do not receive delegation tools. Only the parent launches subagents.
- No workflow engine, worktrees, auto-merge, task retries, CLI backends other than Pi, or background daemon.

## Three context modes

Context mode is independent of the role:

| Mode | Inherited parent conversation |
| --- | --- |
| `none` | None. Role instructions, task and ownership only. |
| `partial` (default) | Explicit `contextText` selected/written by the parent. Required; use `none` for an independent task. |
| `full` | Frozen snapshot of the parent's active conversation branch at dispatch, respecting compaction summaries and retained messages. Includes the current assistant tool-calling message, not abandoned branches or later sibling results. |

`full` copies effective stored conversation messages, not the parent's system prompt, tool permissions, runtime extension state, provider payload rewrites or context-hook transformations. Pending parent tool calls get explicit placeholder results in the child copy; no parent history is changed. None of the modes continuously synchronizes conversations.

Children disable automatic discovery of extensions, skills, prompt templates and context files (`AGENTS.md`/`CLAUDE.md`). Include necessary project rules in the role body or task/context. They inherit environment/config authentication, not the parent's in-memory provider registrations. Providers registered only by a parent extension need an explicit child backing extension.

## Roles

Bundled definitions live in `agents/`:

| Role | Responsibility | Tools |
| --- | --- | --- |
| `scout` | Read-only code investigation | read, grep, find, ls |
| `worker` | Scoped changes and verification | read, write, edit, bash, web_search, web_fetch |
| `researcher` | Web research | web_search, web_fetch, safe_bash |

All also receive `ask_question`. Bundled model defaults are `openrouter/z-ai/glm-5.3`; override `model` at launch or customize the profile. Web tools require separately installed backing extensions; missing tools fail preflight rather than silently degrading. `safe_bash` is a convenience command filter, not a security boundary.

Discovery precedence: trusted project `.pi/agents/` > global `~/.pi/agent/agents/` > bundled. `PI_CODING_AGENT_DIR` overrides the global location. Profiles are resolved by frontmatter name (not filename).

```markdown
---
name: local-worker
description: Implements an assigned module
tools: [read, write, edit, bash]
model: anthropic/claude-sonnet-4-6
thinking: medium
system-prompt: append
---
Read before editing. Preserve others' work. Verify your changes.
```

Supported fields: `name`, `description`, `tools` (CSV or YAML array), `model` (canonical `provider/model`), `thinking`, `system-prompt` (`append`/`replace`), `cwd`, `extensions` (CSV or array of extension file paths relative to the profile file). Role `cwd` and launch `cwd` resolve against the parent's cwd. Missing/empty tools grants only `ask_question`, never the default full toolset.

For custom tools, declare their extension paths in `extensions`. Built-in mappings look for `<agent-config>/extensions/<tool-name-with-hyphens>/index.ts`; `safe_bash` uses the bundled extension. The resolved absolute paths are saved with the task. Preflight validates actual tool availability and model selection before sending the task.

Nested `subagent_agents`, delegation tools, non-Pi `cli`, and automatic `skills` fields are rejected. Former `session-mode`, `auto-exit` and `interactive` fields no longer control execution; choose context per task, and RPC settlement controls completion. Remove obsolete fields when migrating custom profiles.

## Tools

### Launch: `subagent`

```json
{
  "agent": "worker",
  "name": "auth",
  "task": "Fix expired-token handling and add tests",
  "ownership": "src/auth/ and test/auth/; coordinate before changing shared types",
  "context": "partial",
  "contextText": "The API returns 401 for expired tokens. Preserve the existing refresh contract."
}
```

Required: `agent`, `task`, `ownership`. Optional: `name`, `model`, `cwd`, `context`, `contextText`. `contextText` is only accepted in `partial` mode. Explicit names and default names are both deduplicated.

The call waits for startup/preflight and RPC acceptance, **not task completion**. Results and questions arrive automatically as parent messages. After launching, the parent can do independent work or end its turn. Do not poll to wait for completion.

For an independent review use `context: "none"`; for a continuation of a complex discussion use `context: "full"`. Role/tool permissions stay the same in every mode.

### Discover: `subagents_list`

Lists roles and their tool sets; it does not launch anything.

### Manage: `subagent_control`

```json
{ "action": "list" }
{ "action": "inspect", "id": "auth" }
{ "action": "message", "id": "auth", "message": "Also cover an empty refresh token" }
{ "action": "answer", "id": "auth", "questionId": "<ID from question>", "message": "Keep the existing API shape" }
{ "action": "cancel", "id": "auth" }
{ "action": "continue", "id": "auth", "message": "Address the review finding in the same module" }
```

`id` accepts the stable UUID or unique task name. `message` only targets a running task; use `continue` explicitly for a finished task. RPC acceptance means accepted/queued, not proven executed. When a question is pending, use `answer` with its ID instead of an ordinary message. Duplicate and stale answers are rejected.

### Child questions

`ask_question({ question })` blocks inside the child's tool execution through the RPC UI protocol. It is a sequential tool, so later child tools do not proceed past the question until the matching answer arrives. The parent gets the task and question IDs. Multiple different children can wait independently. Cancellation stops the waiting child.

## User interface

The main session has a compact live widget (up to five rows), showing task name/ID, state, elapsed time and current tool activity. It does not invent completion percentages.

Use **`/subagents`** (or `/subagents <task ID>`) to select a task, then:

- **Details**: scrollable snapshot of task/ownership, latest assistant text, questions and recent tool activity. This is a snapshot, not a streaming terminal; reopen to refresh. Editing the displayed copy changes nothing.
- **Message**: send supplementary instructions.
- **Answer question**: select a pending question and reply.
- **Cancel**: confirm and stop the task.
- **Continue**: start another run using the saved child session/loadout.

Live updates remain in the main widget. Completion/question messages can be expanded with Pi's normal tool/message expansion shortcut. Headless clients can use the control tool or the same RPC dialog protocol. No standalone child terminal is created.

## State, persistence and shutdown

States: `running`, `waiting`, `completed`, `failed`, `cancelled`. `completed` means the child model settled normally, **not that its changes passed acceptance**. The child is instructed to report completion/partial/block status, changes, validation and remaining issues; the parent decides acceptance.

Task records, frozen loadouts, prompt files and child JSONL sessions are stored under:

```text
<parent-session-directory>/rpc-subagents/<parent-session-id>/
```

Progress previews retain the latest 12,000 characters of assistant output, up to 100 log entries with approximately 1,000 characters each; tool responses are additionally bounded. Complete model/tool history is in the child session file. There is no automatic artifact deletion.

A completed/stopped child can be continued after a parent restart, with its original absolute cwd, model, tools, role and extension paths. Files backing extensions are not content-pinned; changing an extension changes its future behavior. Keep them trusted.

Shutdown/reload/session replacement stops managed children and suppresses late parent notifications. Partial file changes are not rolled back. Continuation requires confirmed shutdown and an exclusive lock. After an abrupt parent crash, records/locks are deliberately not auto-adopted: inspect orphan processes manually and start a fresh task if uncertain. Do not delete a lock and reopen a session while its old writer might still be alive.

There is no automatic concurrency cap or total execution deadline in v1. Assign a small number of independent tasks and cancel unwanted work. RPC command acknowledgements have a 15-second timeout; unknown acceptance causes failure/cleanup, never blind re-submission. Cancellation uses stdin shutdown with signal escalation; arbitrary daemonized commands are outside this lifecycle guarantee. Linux/macOS process groups are supported; full Windows descendant cleanup is not yet validated.

## Development and isolated trial

```bash
npm ci
npm test
npm run typecheck
```

Tests use deterministic fake RPC children plus installed-Pi command-only smoke tests. The smoke tests isolate configuration, disable startup networking, and never submit a model task. They validate extension loading and preflight; they do **not** establish that a configured provider will authenticate or complete a real task.

To try the extension without changing your global installation, from the project directory you want children to work in:

```bash
pi --no-extensions -e /absolute/path/to/pi-interactive-subagents/pi-extension/subagents/index.ts
```

This intentionally disables the currently installed subagent extension for this trial process. Do not load both packages together: they register conflicting tool names. Start with a `scout`/`none` read-only task and a model available to the child. Trial tasks use real model quota. The extension requires a persistent parent session (not `--no-session`). Nothing in the source migration changes your current global settings or enables this package automatically.

## Source map

- `index.ts`: tools, session lifecycle, parent notifications
- `agents.ts`: YAML roles and validated resolved loadouts
- `context.ts`: none/partial/full snapshots and cooperation instructions
- `rpc.ts`: JSONL framing, request correlation and process cleanup
- `tasks.ts`: launch/control/question/completion lifecycle
- `store.ts`: durable records, bounded previews and session locks
- `child.ts`: blocking question tool and loadout preflight
- `ui.ts`: main widget, task menu and result rendering

The former tmux, Claude plugin and screen-polling implementation has been removed. Old tmux task registries are not migrated or automatically resumed.

## Acknowledgements

Based on the interactive-subagent work by HazAT and Amos Blomqvist. This fork replaces terminal multiplexing with Pi RPC while retaining configurable role profiles.

MIT; see [LICENSE](LICENSE).
