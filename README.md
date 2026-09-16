# pi-interactive-subagents — context-based RPC

Lightweight parallel subagents for Pi, without tmux. Each task runs in a background Pi RPC process with its own conversation. All tasks use the shared working directory unless an explicit `cwd` is supplied. The parent session displays progress, receives results and questions, and controls children.

This is the **4.0.0 breaking redesign** of the earlier tmux implementation. Target: `@earendil-works/pi-coding-agent` **0.84.2–0.85.x**, Node **22+**. It uses `agent_settled`, current extension tool APIs, and blocking RPC UI input. Older `@mariozechner` Pi versions are not supported.

## Model of operation

- One task → one child process → one persistent session.
- The parent assigns file/module ownership. Reads and writes can run in parallel; workers must preserve each other's changes and ask before changing shared interfaces or working outside their scope.
- Ownership is a cooperation agreement, **not a filesystem sandbox or lock**. Shared ports, databases, build outputs and edits can still conflict. The parent validates the combined result.
- Children do not receive delegation tools. Only the parent launches subagents.
- No workflow engine, worktrees, auto-merge, task retries, CLI backends other than Pi, or background daemon.

## Three context modes

Context is the only child classification. There are no role definitions, profiles, or agent discovery:

| Mode | Inherited parent conversation |
| --- | --- |
| `none` | None. Task, ownership and cooperation guidance only. |
| `partial` (default) | Explicit `contextText` selected/written by the parent. Required; use `none` for an independent task. |
| `full` | Frozen snapshot of the parent's active conversation branch at dispatch, respecting compaction summaries and retained messages. Includes the current assistant tool-calling message, not abandoned branches or later sibling results. |

`full` copies effective stored conversation messages, not the parent's system prompt, runtime extension state, provider payload rewrites or context-hook transformations. Tool and skill inheritance is the same in all three modes. Pending parent tool calls get explicit placeholder results in the child copy; no parent history is changed. None of the modes continuously synchronizes conversations.

## Runtime inheritance

Every new child receives a frozen snapshot of the parent's **active nondelegation tools** and **all loaded skills**, plus the reserved blocking `ask_question` bridge. No profile or ambient-config tool/skill discovery is used:

- Tool names, JSON schemas, descriptions, guidelines and canonical source paths come from Pi's live `getActiveTools()` / `getAllTools()` APIs at launch. Inactive tools are not granted; an empty parent tool set grants only `ask_question`.
- Skills come from the actual `before_agent_start.systemPromptOptions.skills` inventory, including package/CLI/extension-contributed skills and `disable-model-invocation` skills. Hidden skills retain their explicit-only behavior. Children load those exact skill files with `--skill`, not a fresh directory scan.
- Builtins are reconstructed by Pi. File-backed extension tools (including builtin overrides and tools registered at startup) reload from their canonical runtime provider files. Child preflight compares each tool's schema/metadata and canonical builtin/extension provenance, plus the complete skill inventory/metadata, **before sending the task to a model**. Builtin substitution, missing tools/skills, changed metadata and extra contributed skills fail explicitly. Tool-call guards also check for later tool replacement.
- The model defaults to the parent's current `provider/model` ID and thinking level. `model` explicitly overrides that ID; thinking is clamped by Pi to the selected model. The selected model must be available in the child; it never silently falls back to another model.

**Reconstruction boundary:** Pi exposes tool metadata, not executable closures. Extension memory, interactive setup, runtime flags, parent-only hooks, in-memory authentication/provider registrations and SDK tool implementations are not copied. SDK/inline tools, virtual/missing skill files, providers that fail to reload, and dynamically configured tools that cannot recreate matching definitions are refused rather than silently dropped. File-backed providers must support fresh RPC startup; they may fail if they require interactive setup or other extensions not backing an inherited active tool. Provider-only extensions are not automatically inherited; use a model available through the child's config or inherited tool providers. Authentication comes from environment/config, not parent-only in-memory credentials.

Automatic extension, skill, prompt-template and context-file (`AGENTS.md`/`CLAUDE.md`) discovery is disabled in children. Required project instructions belong in task/context. Pi's normal system-prompt configuration may still apply, with child cooperation guidance appended; the parent system prompt is not copied. Files backing skills/extensions are not content-pinned: continuation revalidates inventories and metadata, but implementation/body changes with unchanged metadata can change behavior.

**No nested delegation:** this package's creation/management tools, legacy `subagent*` tools and conventional `spawn_agent`/`manage_agents`/`delegate_task` names are excluded. The CLI allowlist prevents providers from enabling extra tools, and the child entrypoint never registers parent controls. Pi has no semantic capability tags: arbitrary custom aliases and general shell tools are not a security sandbox. Do not expose disguised delegation tools; children are instructed not to delegate or launch agent CLIs. All inherited extension code and skills must remain trusted.

## Tools

### Launch: `subagent`

```json
{
  "name": "auth",
  "task": "Fix expired-token handling and add tests",
  "ownership": "src/auth/ and test/auth/; coordinate before changing shared types",
  "context": "partial",
  "contextText": "The API returns 401 for expired tokens. Preserve the existing refresh contract."
}
```

Required: `task`, `ownership`. Optional: `name`, `model`, `cwd`, `context`, `contextText`. `contextText` is only accepted in `partial` mode. Names default to the context mode (`none`, `partial`, `full`); all names are deduplicated.

The call waits for startup/preflight and RPC acceptance, **not task completion**. Results and questions arrive automatically as parent messages. After launching, the parent can do independent work or end its turn. Do not poll to wait for completion.

For an independent review use `context: "none"`; for a continuation of a complex discussion use `context: "full"`. Tool and skill inheritance stays the same in every mode.

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

States: `running`, `waiting`, `completed`, `failed`, `cancelled`. `completed` means the child settled normally (including a successful terminating tool batch), **not that its changes passed acceptance**. The child is instructed to report completion/partial/block status, changes, validation and remaining issues; the parent decides acceptance.

Task records, frozen loadouts, prompt files and child JSONL sessions are stored under:

```text
<parent-session-directory>/rpc-subagents/<parent-session-id>/
```

Progress previews retain the latest 12,000 characters of assistant output, up to 100 log entries with approximately 1,000 characters each; tool responses are additionally bounded. Complete model/tool history is in the child session file. There is no automatic artifact deletion.

A completed/stopped child can be continued after a parent restart, with its original absolute cwd, model, tools, skills and extension paths. It uses its saved loadout, not the current parent inventory. Metadata is revalidated before continuation.

Shutdown/reload/session replacement stops managed children and suppresses late parent notifications. Partial file changes are not rolled back. Continuation requires confirmed shutdown and an exclusive lock. After an abrupt parent crash, records/locks are deliberately not auto-adopted: inspect orphan processes manually and start a fresh task if uncertain. Do not delete a lock and reopen a session while its old writer might still be alive.

There is no automatic concurrency cap or total execution deadline in v1. Assign a small number of independent tasks and cancel unwanted work. RPC command acknowledgements have a 15-second timeout; unknown acceptance causes failure/cleanup, never blind re-submission. Cancellation first waits a bounded time for outstanding prompt preflight receipts, including late receipts after caller timeout, then clears queued work and waits for an abort/idle acknowledgement before stdin shutdown, with bounded signal escalation. Pi 0.84.2 does not expose `clear_queue` over RPC, so the compatibility path aborts and then requires `get_state` to prove that the queue is empty; otherwise shutdown remains unconfirmed and retains the lock. New submissions are rejected while stopping; an idle abort alone cannot confirm cleanup while a prompt hook remains unresolved. If agent/tool cleanup or process exit cannot be confirmed, cancellation reports failure and retains the lock; root-process exit alone is not confirmation. An accepted prompt consumed by an input hook without starting or queueing work fails explicitly instead of remaining live. Arbitrary daemonized commands are outside this lifecycle guarantee. Linux/macOS process groups are supported; full Windows descendant cleanup is not yet validated.

## Development and isolated trial

```bash
npm ci
npm test
npm run typecheck
```

Tests use deterministic fake RPC children, installed-Pi command-only preflight tests, and real parent/child RPC sessions with a local scripted provider. They exercise custom tool execution, builtin overrides, startup tools, skills, all context modes, model selection and questions without external provider calls or model quota. They do **not** establish that your configured provider will authenticate or complete a real task.

To try the extension without changing your global installation, from the project directory you want children to work in:

```bash
pi --no-extensions -e /absolute/path/to/pi-interactive-subagents/pi-extension/subagents/index.ts
```

This intentionally disables the currently installed subagent extension for this trial process. Do not load both packages together: they register conflicting tool names. Start with a `none` investigation task, explicit read-only ownership and a model available to the child. Remember: read-only ownership is an instruction, not a tool restriction; restrict the parent active tool set if needed. Trial tasks use real model quota. The extension requires a persistent parent session (not `--no-session`). Nothing in the source migration changes your current global settings or enables this package automatically.

## Source map

- `index.ts`: tools, session lifecycle, parent notifications
- `loadout.ts`: live runtime snapshots, canonical sources and inherited-loadout verification
- `context.ts`: none/partial/full snapshots and cooperation instructions
- `rpc.ts`: JSONL framing, request correlation and process cleanup
- `tasks.ts`: launch/control/question/completion lifecycle
- `store.ts`: durable records, bounded previews and session locks
- `child.ts`: blocking question tool and loadout preflight
- `ui.ts`: main widget, task menu and result rendering

Role profiles, `agents/`, the `agent` launch argument, `subagents_list` and bundled profile-only `safe_bash` are removed. Existing profile directories are ignored, not modified. Legacy v1 profile loadouts remain inspectable but cannot be continued; launch a new context-based task instead. The former tmux/Claude plugin registries are not migrated or automatically resumed.

## Acknowledgements

Based on the interactive-subagent work by HazAT and Amos Blomqvist. This fork replaces terminal multiplexing with Pi RPC with context-based children and source-backed runtime inheritance.

MIT; see [LICENSE](LICENSE).
