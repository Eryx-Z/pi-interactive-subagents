import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RpcProcess, type RpcEvent, type RpcLaunch } from "./rpc.ts";
import { CHILD_EXTENSION, validateLoadout, type Loadout } from "./agents.ts";
import { atomicWrite, addLog, bounded, terminal, uniqueName, TaskStore, type TaskRecord } from "./store.ts";
import { COOPERATION, seedSession, taskPrompt, type ContextMode } from "./context.ts";
import type { AgentMessage } from "./context.ts";

export interface NewTask {
  name?: string; task: string; ownership: string; context: ContextMode; contextText?: string;
  loadout: Loadout; snapshot?: AgentMessage[]; parentSession?: string;
}
interface LiveRun {
  rpc: RpcProcess; release: () => void; finishing?: Promise<void>; pendingMessages: number;
  settled: boolean; lastStop?: string; lastError?: string; started: boolean; askToolCallId?: string;
  persistTimer?: ReturnType<typeof setTimeout>; settleChecking?: boolean; checkAgain?: boolean;
}
export function childLaunch(record: TaskRecord, dir: string, command: string, baseArgs: string[] = []): RpcLaunch {
  const l = validateLoadout(record.loadout);
  const loadoutPath = join(dir, `${record.id}.loadout.json`);
  const promptPath = join(dir, `${record.id}.prompt.md`);
  atomicWrite(loadoutPath, JSON.stringify(l));
  atomicWrite(promptPath, `${l.prompt}\n\n${COOPERATION}`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_RPC_SUBAGENT_") || key === "PI_SESSION_FILE" || key === "PI_SESSION_ID") delete env[key];
  env.PI_RPC_SUBAGENT_LOADOUT = loadoutPath;
  env.PI_RPC_SUBAGENT_CHILD = "1";
  env.PI_CODING_AGENT_DIR = l.agentDir;
  return {
    command, cwd: l.cwd, env,
    args: [...baseArgs, "--mode", "rpc", "--session", record.sessionFile,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
      "--tools", l.tools.join(","), "--model", l.model, "--thinking", l.thinking,
      l.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath,
      ...l.extensions.flatMap(p => ["-e", p]), "-e", CHILD_EXTENSION],
  };
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}
export class TaskManager {
  readonly records = new Map<string, TaskRecord>();
  private live = new Map<string, LiveRun>();
  private closed = false;
  constructor(readonly store: TaskStore, private options: {
    command: string; baseArgs?: string[];
    createRpc?: (launch: RpcLaunch) => RpcProcess;
    changed?: () => void; notify?: (record: TaskRecord, kind: "result" | "question") => void;
  }) {
    for (const record of store.load()) this.records.set(record.id, record);
  }
  private save(record: TaskRecord): void {
    record.updatedAt = Date.now(); this.store.save(record); this.options.changed?.();
  }
  get(id: string): TaskRecord {
    const record = this.records.get(id) ?? [...this.records.values()].find(r => r.name === id);
    if (!record) throw new Error(`Unknown task: ${id}`);
    return record;
  }
  async launch(input: NewTask): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!input.task.trim() || !input.ownership.trim()) throw new Error("Task and ownership are required");
    const prompt = taskPrompt(input.task, input.ownership, input.context, input.contextText);
    validateLoadout(input.loadout);
    const id = randomUUID();
    const record: TaskRecord = {
      version: 1, id, name: uniqueName(input.name ?? input.loadout.agent, [...this.records.values()].map(r => r.name)),
      task: input.task, ownership: input.ownership, context: input.context, loadout: structuredClone(input.loadout),
      state: "running", startedAt: Date.now(), updatedAt: Date.now(), sessionFile: join(this.store.dir, `${id}.session.jsonl`),
      output: "", activity: "starting RPC", log: [], questions: [], stopped: false, run: 1,
    };
    // Reserve names and session ownership synchronously, before any startup awaits.
    this.records.set(id, record);
    try {
      seedSession(record.sessionFile, record.loadout.cwd, input.context, input.snapshot, input.parentSession);
      this.save(record);
    } catch (e) { this.records.delete(id); throw e; }
    await this.start(record, prompt);
    return record;
  }
  async continue(id: string, message: string): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!message.trim()) throw new Error("Continuation message is required");
    const record = this.get(id);
    if (this.live.has(record.id)) throw new Error("Task is already running or stopping");
    this.store.validateForContinue(record);
    const release = this.store.lock(record.id);
    record.state = "running"; record.stopped = false; record.run++; record.error = undefined;
    record.questions = []; record.output = ""; record.startedAt = Date.now(); record.activity = "starting continuation";
    addLog(record, `Continuation ${record.run}: ${message}`);
    try { this.save(record); }
    catch (e) { release(); record.state = "failed"; record.stopped = true; throw e; }
    await this.start(record, `${COOPERATION}\nOwnership: ${record.ownership}\nContinuation task:\n${message}`, release);
    return record;
  }
  private async start(record: TaskRecord, prompt: string, reserved?: () => void): Promise<void> {
    let release = reserved;
    try {
      release ??= this.store.lock(record.id);
      const launch = childLaunch(record, this.store.dir, this.options.command, this.options.baseArgs);
      const rpc = (this.options.createRpc ?? (l => new RpcProcess(l)))(launch);
      const live: LiveRun = { rpc, release, pendingMessages: 1, settled: false, started: false };
      this.live.set(record.id, live);
      rpc.on("event", event => {
        try { this.event(record, live, event); }
        catch (e) { void this.finish(record, "failed", String(e)); }
      });
      rpc.on("fault", error => { void this.finish(record, "failed", String(error)); });
      rpc.on("closed", detail => {
        if (!live.finishing) void this.finish(record, "failed", `Unexpected child exit: ${detail.code ?? detail.signal}\n${detail.stderr}`);
      });
      await rpc.request("get_state"); // readiness, not a timed sleep
      await rpc.request("set_auto_retry", { enabled: false });
      const commands = await rpc.request("get_commands");
      if (!commands?.commands?.some((c: { name: string }) => c.name === "rpc-subagent-preflight")) throw new Error("Child bridge did not load; refusing to send any model prompt");
      await rpc.request("prompt", { message: "/rpc-subagent-preflight" });
      if (live.finishing || this.closed) throw new Error("Child failed during preflight");
      await rpc.request("prompt", { message: prompt });
      live.pendingMessages--;
      addLog(record, "Initial task accepted by RPC (not a completion acknowledgement)");
      this.save(record); this.maybeComplete(record, live);
    } catch (e) {
      if (this.live.has(record.id)) await this.finish(record, "failed", String(e));
      else {
        release?.(); record.state = "failed"; record.error = String(e); record.stopped = true; this.save(record);
      }
      throw e;
    }
  }
  private event(record: TaskRecord, live: LiveRun, event: RpcEvent): void {
    if (live.finishing || this.closed) return;
    if (event.type === "extension_error") throw new Error(`Child extension error: ${event.error}`);
    if (event.type === "agent_start") { live.started = true; live.settled = false; record.activity = "model running"; }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      record.output = bounded(record.output + event.assistantMessageEvent.delta);
    }
    if (event.type === "message_start" && event.message?.role === "assistant") record.output = "";
    if (event.type === "message_end" && event.message?.role === "assistant") {
      record.output = bounded(text(event.message)); live.lastStop = event.message.stopReason; live.lastError = event.message.errorMessage;
      addLog(record, `Assistant: ${record.output}`);
    }
    if (event.type === "tool_execution_start") {
      if (event.toolName === "ask_question") live.askToolCallId = event.toolCallId;
      record.activity = `${event.toolName}: ${bounded(JSON.stringify(event.args ?? {}), 200)}`;
      addLog(record, `Start ${event.toolCallId}: ${record.activity}`);
    }
    if (event.type === "tool_execution_update") record.activity = `${event.toolName}: ${bounded(text(event.partialResult), 200)}`;
    if (event.type === "tool_execution_end") {
      if (event.toolName === "ask_question") live.askToolCallId = undefined;
      addLog(record, `${event.isError ? "Failed" : "Done"} ${event.toolName} (${event.toolCallId}): ${text(event.result)}`);
      if (event.toolName === "ask_question") record.questions = record.questions.filter(q => q.toolCallId !== event.toolCallId);
      record.state = record.questions.length ? "waiting" : "running";
      record.activity = record.questions.length ? "waiting for parent answer" : "model running";
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "input") {
        if (typeof event.id !== "string" || typeof event.title !== "string") throw new Error("Malformed question");
        if (!record.questions.some(q => q.id === event.id)) {
          if (!live.askToolCallId) throw new Error("Unsolicited child dialog; only ask_question input is supported");
          record.questions.push({ id: event.id, title: event.title, toolCallId: live.askToolCallId });
          record.state = "waiting"; record.activity = "waiting for parent answer";
          this.save(record); this.options.notify?.(record, "question");
        }
      } else if (["select", "confirm", "editor"].includes(event.method)) {
        live.rpc.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        throw new Error(`Unsupported child dialog ${event.method}; use ask_question`);
      }
      // Child widgets/notifications are not terminal components and do not own the parent's UI.
    }
    if (event.type === "agent_settled") { live.settled = true; this.maybeComplete(record, live); }
    if (!live.finishing) {
      if (event.type === "message_update" || event.type === "tool_execution_update") {
        if (!live.persistTimer) live.persistTimer = setTimeout(() => {
          live.persistTimer = undefined;
          try { if (!live.finishing) this.save(record); }
          catch (e) { void this.finish(record, "failed", String(e)); }
        }, 200);
      } else this.save(record);
    }
  }
  private maybeComplete(record: TaskRecord, live: LiveRun): void {
    if (!live.settled || !live.started || live.pendingMessages || record.questions.length || live.finishing) return;
    if (live.settleChecking) { live.checkAgain = true; return; }
    // A supplement can race an older run's agent_settled. Query after all prompt receipts,
    // then recheck local counters before closing a session that may now be running again.
    live.settleChecking = true;
    void live.rpc.request("get_state").then(state => {
      if (!live.finishing && live.settled && live.pendingMessages === 0 && !record.questions.length &&
          state?.isStreaming === false && !state.isCompacting && !state.pendingMessageCount) {
        const final = live.lastStop === "aborted" ? "cancelled" : live.lastStop === "stop" ? "completed" : "failed";
        void this.finish(record, final, final === "failed" ? live.lastError ?? `Run settled with stopReason=${live.lastStop ?? "missing"}` : undefined);
      }
    }).catch(e => { if (!live.finishing) void this.finish(record, "failed", String(e)); })
      .finally(() => {
        live.settleChecking = false;
        if (live.checkAgain) { live.checkAgain = false; this.maybeComplete(record, live); }
      });
  }
  private finish(record: TaskRecord, state: TaskRecord["state"], error?: string): Promise<void> {
    const live = this.live.get(record.id);
    if (!live) return Promise.resolve();
    if (live.finishing) return live.finishing;
    // Install promise before stopping: close/fault callbacks must never finalize twice.
    if (live.persistTimer) clearTimeout(live.persistTimer);
    live.finishing = Promise.resolve().then(async () => {
      record.state = state; record.error = error; record.questions = []; record.activity = "stopping process";
      try {
        await live.rpc.stop(); record.stopped = true; live.release();
      } catch (e) { record.state = "failed"; record.error = `${error ?? ""}\n${e}`; record.stopped = false; }
      this.live.delete(record.id); record.activity = record.state;
      this.save(record);
      if (!this.closed) this.options.notify?.(record, "result");
    }).catch(e => { record.state = "failed"; record.error = String(e); record.stopped = false; this.live.delete(record.id); });
    return live.finishing;
  }
  async message(id: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("Message is required");
    const record = this.get(id), live = this.live.get(record.id);
    if (!live || live.finishing) throw new Error("Task is not running; use continue explicitly");
    if (record.questions.length) throw new Error("Task is waiting for an answer; reply with its question ID");
    live.pendingMessages++; live.settled = false;
    try {
      await live.rpc.request("prompt", { message: `Supplementary parent instruction:\n${message}`, streamingBehavior: "steer" });
      addLog(record, `Supplement accepted/queued (not yet proven executed): ${message}`); this.save(record);
    } catch (e) {
      // Do not strand a formerly settled run after clearing its settled flag.
      // A failed control operation stops this writer rather than guessing whether to retry.
      await this.finish(record, "failed", `Supplement failed: ${String(e)}`);
      throw e;
    } finally { live.pendingMessages--; this.maybeComplete(record, live); }
  }
  answer(id: string, questionId: string, answer: string): void {
    if (!answer.trim()) throw new Error("Answer is required");
    const record = this.get(id), live = this.live.get(record.id);
    const q = record.questions.find(q => q.id === questionId);
    if (!live || live.finishing || !q || q.responseSent) throw new Error("Question is no longer pending");
    live.rpc.send({ type: "extension_ui_response", id: questionId, value: answer });
    q.responseSent = true; record.activity = "answer sent; waiting for tool acknowledgement";
    addLog(record, `Answer sent for ${questionId}: ${answer}`); this.save(record);
  }
  async cancel(id: string): Promise<void> {
    const record = this.get(id);
    if (!this.live.has(record.id)) throw new Error("Task is not running");
    await this.finish(record, "cancelled", "Cancelled by parent");
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.keys()].map(id => this.finish(this.get(id), "cancelled", "Parent session closed/reloaded")));
  }
}
