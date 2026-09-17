import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RpcProcess, type RpcEvent, type RpcLaunch } from "./rpc.ts";
import { CHILD_EXTENSION, validateLoadout, applyAccess, accessMode, type AccessMode, type Loadout } from "./loadout.ts";
import { atomicWrite, addLog, bounded, uniqueName, TaskStore, type TaskRecord } from "./store.ts";
import { COOPERATION, seedSession, taskPrompt, type ContextMode } from "./context.ts";
import type { AgentMessage } from "./context.ts";
import { diagnoseFailure } from "./diagnostics.ts";

export interface NewTask {
  name?: string; task: string; access: AccessMode; context: ContextMode; contextText?: string;
  workflow?: { id: string; stepId: string };
  loadout: Loadout; snapshot?: AgentMessage[]; parentSession?: string;
}
interface LiveRun {
  rpc: RpcProcess; release: () => void; finishing?: Promise<void>; pendingMessages: number;
  startupPhase?: string;
  settled: boolean; lastStop?: string; lastError?: string; started: boolean; askToolCallId?: string;
  persistTimer?: ReturnType<typeof setTimeout>; settleChecking?: boolean; checkAgain?: boolean;
  finalTools: Map<string, boolean>; finalOutput: Map<string, string>; submission: number;
}
export function childLaunch(record: TaskRecord, dir: string, command: string, baseArgs: string[] = []): RpcLaunch {
  const l = validateLoadout(record.loadout);
  const loadoutPath = join(dir, `${record.id}.loadout.json`);
  const promptPath = join(dir, `${record.id}.prompt.md`);
  atomicWrite(loadoutPath, JSON.stringify(l));
  atomicWrite(promptPath, COOPERATION);
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
      "--append-system-prompt", promptPath,
      ...l.skills.flatMap(s => ["--skill", s.loadPath ?? s.filePath]),
      "-e", CHILD_EXTENSION, ...[...new Set([...(l.providerExtensions ?? []), ...l.extensions])].flatMap(p => ["-e", p])],
  };
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}
export class TaskManager {
  readonly records = new Map<string, TaskRecord>();
  private live = new Map<string, LiveRun>();
  private closed = false;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  isLive(id: string): boolean { return this.live.has(id); }
  hasCapacity(): boolean { return [...this.records.values()].filter(r => !r.stopped).length < (this.options.maxConcurrent ?? 8); }
  constructor(readonly store: TaskStore, private options: {
    command: string; baseArgs?: string[]; maxConcurrent?: number;
    createRpc?: (launch: RpcLaunch) => RpcProcess;
    changed?: () => void; notify?: (record: TaskRecord, kind: "result" | "question") => void;
  }) {
    if (!Number.isInteger(options.maxConcurrent ?? 8) || (options.maxConcurrent ?? 8) < 1) throw new Error("maxConcurrent must be a positive integer");
    for (const record of store.load()) this.records.set(record.id, record);
  }
  private save(record: TaskRecord): void {
    record.updatedAt = Date.now(); this.store.save(record); this.options.changed?.();
    for (const listener of this.listeners) listener();
  }
  get(id: string): TaskRecord {
    const record = this.records.get(id) ?? [...this.records.values()].find(r => r.name === id);
    if (!record) throw new Error(`Unknown task: ${id}`);
    return record;
  }
  async launch(input: NewTask): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!this.hasCapacity()) throw new Error("Global subagent concurrency limit reached; wait for a child to stop");
    if (!input.task.trim()) throw new Error("Task is required");
    const prompt = taskPrompt(input.task, input.access, input.context, input.contextText);
    validateLoadout(input.loadout);
    const id = randomUUID();
    const record: TaskRecord = {
      version: 2, id, name: uniqueName(input.name ?? input.context, [...this.records.values()].map(r => r.name)),
      task: input.task, access: input.access, context: input.context, loadout: applyAccess(input.loadout, input.access),
      availableLoadout: structuredClone(input.loadout), workflow: input.workflow,
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
  async continue(id: string, message: string, access?: AccessMode, workflowId?: string): Promise<TaskRecord> {
    if (this.closed) throw new Error("Parent session is shutting down");
    if (!message.trim()) throw new Error("Continuation message is required");
    const record = this.get(id);
    if (record.workflow && record.workflow.id !== workflowId) throw new Error("Use workflow_control retry for workflow steps");
    const selected = accessMode(access ?? record.access);
    const available = record.availableLoadout ?? record.loadout;
    const effective = applyAccess(available, selected);
    if (this.live.has(record.id)) throw new Error("Task is already running or stopping");
    this.store.validateForContinue(record);
    if (!this.hasCapacity()) throw new Error("Global subagent concurrency limit reached; wait for a child to stop");
    const release = this.store.lock(record.id);
    record.version = 2; record.access = selected; record.availableLoadout = structuredClone(available); record.loadout = effective;
    record.state = "running"; record.stopped = false; record.run++; record.error = undefined;
    record.questions = []; record.output = ""; record.startedAt = Date.now(); record.activity = "starting continuation";
    addLog(record, `Continuation ${record.run}: ${message}`);
    try { this.save(record); }
    catch (e) { release(); record.state = "failed"; record.stopped = true; throw e; }
    await this.start(record, `${COOPERATION}\nAccess: ${record.access}\nContinuation task:\n${message}`, release);
    return record;
  }
  private async start(record: TaskRecord, prompt: string, reserved?: () => void): Promise<void> {
    let release = reserved;
    let spawned = false;
    let phase = "launch";
    try {
      release ??= this.store.lock(record.id);
      const launch = childLaunch(record, this.store.dir, this.options.command, this.options.baseArgs);
      const rpc = (this.options.createRpc ?? (l => new RpcProcess(l)))(launch);
      const live: LiveRun = { rpc, release, startupPhase: phase, pendingMessages: 1, settled: false, started: false, finalTools: new Map(), finalOutput: new Map(), submission: 0 };
      this.live.set(record.id, live);
      spawned = true;
      rpc.on("event", event => {
        try { this.event(record, live, event); }
        catch (e) { void this.finish(record, "failed", String(e)); }
      });
      rpc.on("fault", error => { void this.finish(record, "failed", String(error)); });
      rpc.on("closed", detail => {
        if (!live.finishing) void this.finish(record, "failed", `Unexpected child exit: ${detail.code ?? detail.signal}\n${detail.stderr}`);
      });
      phase = live.startupPhase = "RPC readiness";
      await rpc.request("get_state"); // readiness, not a timed sleep
      await rpc.request("set_auto_retry", { enabled: false });
      phase = live.startupPhase = "loadout preflight";
      const commands = await rpc.request("get_commands");
      if (!commands?.commands?.some((c: { name: string }) => c.name === "rpc-subagent-preflight")) throw new Error("Child bridge did not load; refusing to send any model prompt");
      await rpc.request("prompt", { message: "/rpc-subagent-preflight" });
      if (live.finishing || this.closed) throw new Error("Child failed during preflight");
      phase = live.startupPhase = "initial prompt";
      await rpc.request("prompt", { message: prompt });
      live.startupPhase = undefined;
      live.pendingMessages--;
      addLog(record, "Initial task accepted by RPC (not a completion acknowledgement)");
      this.save(record); this.maybeComplete(record, live);
    } catch (e) {
      if (spawned) await this.finish(record, "failed", String(e));
      else {
        release?.(); record.state = "failed"; record.error = diagnoseFailure(String(e), record.loadout, phase); record.stopped = true; this.save(record);
      }
      throw new Error(diagnoseFailure(String(e), record.loadout, phase), { cause: e });
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
      live.finalTools = new Map((event.message.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => [b.id, false]));
      live.finalOutput.clear();
      addLog(record, `Assistant: ${record.output}`);
    }
    if (event.type === "tool_execution_start") {
      if (event.toolName === "ask_question") live.askToolCallId = event.toolCallId;
      record.activity = `${event.toolName}: ${bounded(JSON.stringify(event.args ?? {}), 200)}`;
      addLog(record, `Start ${event.toolCallId}: ${record.activity}`);
    }
    if (event.type === "tool_execution_update") record.activity = `${event.toolName}: ${bounded(text(event.partialResult), 200)}`;
    if (event.type === "tool_execution_end") {
      if (live.finalTools.has(event.toolCallId)) {
        const terminating = event.result?.terminate === true && event.isError === false;
        live.finalTools.set(event.toolCallId, terminating);
        if (terminating) live.finalOutput.set(event.toolCallId, bounded(text(event.result)));
      }
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
    if (event.type === "queue_update" && !live.started) this.maybeComplete(record, live);
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
    if ((live.started && !live.settled) || live.pendingMessages || record.questions.length || live.finishing) return;
    if (live.settleChecking) { live.checkAgain = true; return; }
    // A supplement can race an older run's agent_settled. Query after all prompt receipts,
    // then recheck local counters before closing a session that may now be running again.
    live.settleChecking = true;
    const submission = live.submission;
    void live.rpc.request("get_state").then(state => {
      if (submission !== live.submission) { live.checkAgain = true; return; }
      if (!live.finishing && (!live.started || live.settled) && live.pendingMessages === 0 && !record.questions.length &&
          state?.isStreaming === false && !state.isCompacting && !state.pendingMessageCount) {
        if (!live.started) {
          void this.finish(record, "failed", "RPC accepted the task but no agent run started and no work is queued (input may have been handled by an extension)");
          return;
        }
        const terminated = live.lastStop === "toolUse" && live.finalTools.size > 0 && [...live.finalTools.values()].every(Boolean);
        if (terminated) record.output = bounded([record.output, ...[...live.finalTools.keys()].map(id => live.finalOutput.get(id))].filter(Boolean).join("\n"));
        const final = live.lastStop === "aborted" ? "cancelled" : live.lastStop === "stop" || terminated ? "completed" : "failed";
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
    if (error) error = diagnoseFailure(error, record.loadout, live.startupPhase);
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
    // A settled run cannot prove that a new submission started. Input hooks may
    // consume it without emitting another agent_start/agent_settled pair.
    if (live.settled) live.started = false;
    live.submission++;
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
    if (!record.stopped) throw new Error(`Cancellation could not confirm shutdown; continuation disabled: ${record.error ?? "unknown stop failure"}`);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.keys()].map(id => this.finish(this.get(id), "cancelled", "Parent session closed/reloaded")));
  }
}
