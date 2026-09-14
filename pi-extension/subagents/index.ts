import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, nonempty, resolveLoadout } from "./agents.ts";
import { snapshotContext, type ContextMode } from "./context.ts";
import { TaskStore, bounded } from "./store.ts";
import { TaskManager } from "./tasks.ts";
import { detail, resultRenderer, taskMenu, taskSummary, widget } from "./ui.ts";
import type { AgentMessage } from "./context.ts";

const result = (text: string) => ({ content: [{ type: "text" as const, text: bounded(text, 16000) }], details: {} });
export default function subagentsExtension(pi: ExtensionAPI) {
  // Defense in depth when this entrypoint is explicitly loaded into a child by another extension.
  if (process.env.PI_RPC_SUBAGENT_CHILD === "1") return;
  let manager: TaskManager | undefined;
  let ctxForWidget: ExtensionContext | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const snapshots = new Map<string, AgentMessage[]>();
  function current(): TaskManager {
    if (!manager) throw new Error("Subagents require an active persistent parent session");
    return manager;
  }
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.sessionManager.getSessionFile()) return;
    ctxForWidget = ctx;
    // Use the same installed Pi package as the host, not an unrelated executable on PATH.
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
    manager = new TaskManager(new TaskStore(join(ctx.sessionManager.getSessionDir(), "rpc-subagents", ctx.sessionManager.getSessionId())), {
      command: process.execPath, baseArgs: [cli],
      notify(record, kind) {
        const content = kind === "question"
          ? `Subagent ${record.name} (${record.id}) needs an answer:\n${record.questions.filter(q => !q.responseSent).map(q => `${q.id}: ${q.title}`).join("\n")}\nUse subagent_control action=answer with id, questionId, message.`
          : `Subagent ${record.name} (${record.id}) ${record.state}.\n${record.error ?? ""}\n${bounded(record.output)}\nSession: ${record.sessionFile}\nStopping is not acceptance: review its validation and shared-workspace changes.`;
        pi.sendMessage({ customType: `rpc_subagent_${kind}`, content, display: true, details: { id: record.id, state: record.state } }, { deliverAs: "steer", triggerTurn: true });
      },
    });
    interval = setInterval(() => { if (manager && ctxForWidget) widget(manager, ctxForWidget); }, 500);
    widget(manager, ctx);
  });
  pi.on("session_shutdown", async () => {
    if (interval) clearInterval(interval);
    interval = undefined;
    snapshots.clear();
    const old = manager; manager = undefined; ctxForWidget = undefined;
    await old?.shutdown();
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "subagent" && event.input?.context === "full") snapshots.set(event.toolCallId, snapshotContext(ctx.sessionManager));
  });
  pi.on("tool_execution_end", event => { snapshots.delete(event.toolCallId); });
  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Launch an asynchronous RPC subagent in the shared working directory. Context modes: none, partial (default; explicit contextText required), full (active branch snapshot). Results/questions arrive automatically. Specify ownership; other agents may write concurrently. No nested delegation. Use subagents_list for roles and subagent_control for inspection/interaction.",
    promptSnippet: "Delegate an owned task with none, partial or full context",
    promptGuidelines: [
      "Assign disjoint file/module ownership when using subagent for parallel writes. Coordinate shared interfaces before dispatch.",
      "After subagent launch, continue independent work or end the turn; results arrive automatically. Do not poll or invent completion.",
    ],
    parameters: Type.Object({
      agent: Type.String(), task: Type.String({ minLength: 1 }), ownership: Type.String({ minLength: 1, description: "Responsible files/modules; say read-only for investigations" }),
      context: Type.Optional(StringEnum(["none", "partial", "full"] as const)), contextText: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()), model: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
    }),
    async execute(id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const m = current();
      const agent = discoverAgents(ctx.cwd, ctx.isProjectTrusted()).find(a => a.name === params.agent);
      if (!agent) throw new Error(`Unknown role ${params.agent}; use subagents_list`);
      const requested = params.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
      const slash = requested.indexOf("/");
      if (slash < 1) throw new Error("Use a canonical provider/model ID");
      const model = ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1));
      if (!model) throw new Error(`Model not found: ${requested}`);
      const loadout = resolveLoadout(agent, resolve(ctx.cwd, params.cwd ?? agent.cwd ?? "."), `${model.provider}/${model.id}`, agent.thinking ?? ctx.thinkingLevel ?? "medium");
      const mode = params.context ?? "partial";
      const snapshot = mode === "full" ? snapshots.get(id) ?? snapshotContext(ctx.sessionManager) : undefined;
      snapshots.delete(id);
      const record = await m.launch({
        name: params.name, task: params.task, ownership: params.ownership, context: mode, contextText: params.contextText,
        loadout, snapshot, parentSession: ctx.sessionManager.getSessionFile(),
      });
      // Tool cancellation during startup must not leave an unacknowledged writer behind.
      if (signal?.aborted) { await m.cancel(record.id); signal.throwIfAborted(); }
      return result(`Task accepted (not completed): ${taskSummary(record)}\nSession: ${record.sessionFile}`);
    },
  });
  pi.registerTool({
    name: "subagents_list", label: "Subagent roles", description: "List available role profiles. Context modes are independent of roles.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      return result(discoverAgents(ctx.cwd, ctx.isProjectTrusted()).map(a => `${a.name}: ${a.description}\nTools: ${a.tools.join(", ") || "none"}`).join("\n\n"));
    },
  });
  pi.registerTool({
    name: "subagent_control", label: "Subagent control",
    description: "Inspect tasks, message a running task, answer a specific question, cancel, or explicitly continue a stopped persisted session. Message/answer receipt does not prove execution. Log/output previews are bounded; full transcript is in sessionFile. Never use list repeatedly to wait for completion.",
    parameters: Type.Object({
      action: StringEnum(["list", "inspect", "message", "answer", "cancel", "continue"] as const),
      id: Type.Optional(Type.String({ description: "Stable task ID or unique name" })),
      message: Type.Optional(Type.String()), questionId: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      const m = current();
      if (p.action === "list") return result([...m.records.values()].map(taskSummary).join("\n") || "No tasks");
      const id = nonempty(p.id, "id");
      if (p.action === "inspect") return result(detail(m.get(id)));
      if (p.action === "cancel") { await m.cancel(id); return result("Task process stopped/cancelled; inspect any partial file changes."); }
      const message = nonempty(p.message, "message");
      if (p.action === "message") await m.message(id, message);
      else if (p.action === "answer") m.answer(id, nonempty(p.questionId, "questionId"), message);
      else await m.continue(id, message);
      return result("Accepted/sent, not yet proven executed. Task events will report progress and completion.");
    },
  });
  pi.registerCommand("subagents", {
    description: "Task list/details; send instructions, answer, cancel or continue: /subagents [task ID]",
    async handler(args, ctx) {
      try { await taskMenu(current(), ctx, args.trim() || undefined); }
      catch (e) { ctx.ui.notify(String(e), "error"); }
    },
  });
  pi.registerMessageRenderer("rpc_subagent_result", resultRenderer);
  pi.registerMessageRenderer("rpc_subagent_question", resultRenderer);
}
