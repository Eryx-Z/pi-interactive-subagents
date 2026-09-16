import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, bounded, uniqueName, type TaskRecord } from "./store.ts";
import { accessMode, validateLoadout, type AccessMode, type Loadout } from "./loadout.ts";
import { taskPrompt, type AgentMessage, type ContextMode } from "./context.ts";
import { TaskManager } from "./tasks.ts";

export interface StepDefinition { id: string; task: string; access: AccessMode; dependsOn: string[] }
export interface WorkflowStep extends StepDefinition {
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  taskId?: string; error?: string;
}
export interface WorkflowInput {
  name?: string; context: ContextMode; contextText?: string; snapshot?: AgentMessage[];
  parentSession?: string; loadout: Loadout; maxParallel?: number; steps: StepDefinition[];
}
export interface WorkflowRecord extends Omit<WorkflowInput, "name" | "steps" | "maxParallel"> {
  version: 1; id: string; name: string; maxParallel: number; steps: WorkflowStep[];
  state: "running" | "paused" | "completed" | "cancelled";
  createdAt: number; updatedAt: number; error?: string;
}
export function validateSteps(steps: StepDefinition[]): void {
  if (!Array.isArray(steps) || !steps.length || steps.length > 64) throw new Error("Workflow requires 1–64 steps");
  const byId = new Map<string, StepDefinition>();
  for (const s of steps) {
    if (!s || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || byId.has(s.id)) throw new Error("Step IDs must be unique, 1–64 letters/digits/_/-");
    if (typeof s.task !== "string" || !s.task.trim()) throw new Error(`Missing task for step ${s.id}`);
    accessMode(s.access);
    if (!Array.isArray(s.dependsOn) || new Set(s.dependsOn).size !== s.dependsOn.length) throw new Error(`Invalid dependencies: ${s.id}`);
    byId.set(s.id, s);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cyclic dependency: ${id}`);
    const step = byId.get(id);
    if (!step) throw new Error(`Unknown dependency: ${id}`);
    visiting.add(id); step.dependsOn.forEach(visit); visiting.delete(id); done.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
/** Scheduling only. TaskManager remains the single owner of processes, sessions and cancellation. */
export class WorkflowManager {
  readonly records = new Map<string, WorkflowRecord>();
  private closed = false;
  private scheduled = false;
  private unsubscribe: () => void;
  constructor(readonly tasks: TaskManager, readonly dir: string, private notify?: (record: WorkflowRecord) => void) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(dir).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const r = JSON.parse(readFileSync(join(dir, file), "utf8")) as WorkflowRecord;
      if (r.version !== 1 || `${r.id}.json` !== file || !["running", "paused", "completed", "cancelled"].includes(r.state)) throw new Error(`Invalid workflow record: ${file}`);
      validateSteps(r.steps); validateLoadout(r.loadout);
      taskPrompt("workflow", "full", r.context, r.contextText);
      if (!Number.isInteger(r.maxParallel) || r.maxParallel < 1 || r.maxParallel > 16 ||
          r.steps.some(s => !["pending", "running", "completed", "failed", "cancelled"].includes(s.state))) throw new Error(`Invalid workflow state: ${file}`);
      // Never re-launch a persisted running step. Reconcile task tags even if the
      // parent crashed between task creation and saving its ID in this record.
      this.records.set(r.id, r);
      for (const step of r.steps) {
        const task = this.findTask(r, step);
        if (task) step.taskId = task.id;
        if (step.state === "running" || step.state === "pending" && task) {
          step.state = task?.stopped && task.state === "completed" ? "completed" : "failed";
          if (step.state === "failed") step.error = "Interrupted workflow; inspect child and explicitly retry";
        }
      }
      if (r.state === "running") { r.state = "paused"; r.error = "Owner restarted; inspect and explicitly resume"; }
      this.save(r);
    }
    this.unsubscribe = tasks.subscribe(() => this.schedule());
  }
  private save(r: WorkflowRecord): void { r.updatedAt = Date.now(); atomicWrite(join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2)); }
  get(id: string): WorkflowRecord {
    const r = this.records.get(id) ?? [...this.records.values()].find(r => r.name === id);
    if (!r) throw new Error(`Unknown workflow: ${id}`);
    return r;
  }
  private findTask(r: WorkflowRecord, s: WorkflowStep): TaskRecord | undefined {
    return s.taskId ? this.tasks.records.get(s.taskId) : [...this.tasks.records.values()].find(t => t.workflow?.id === r.id && t.workflow.stepId === s.id);
  }
  private open(): void { if (this.closed) throw new Error("Workflow owner is shutting down"); }
  launch(input: WorkflowInput): WorkflowRecord {
    this.open(); validateSteps(input.steps); validateLoadout(input.loadout);
    taskPrompt("workflow", "full", input.context, input.contextText);
    const maxParallel = input.maxParallel ?? 3;
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16) throw new Error("maxParallel must be 1–16");
    const r: WorkflowRecord = { ...structuredClone(input), version: 1, id: randomUUID(),
      name: uniqueName(input.name ?? "workflow", [...this.records.values()].map(r => r.name)),
      maxParallel, state: "running", steps: input.steps.map(s => ({ ...structuredClone(s), state: "pending" })),
      createdAt: Date.now(), updatedAt: Date.now() };
    this.save(r); this.records.set(r.id, r); this.schedule(); return r;
  }
  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed) return;
      for (const r of this.records.values()) {
        try { this.reconcile(r); if (r.state === "running") this.dispatch(r); }
        catch (e) {
          r.state = "paused"; r.error = String(e);
          // Persistence failures must not leave an unhandled scheduler rejection or dispatch more work.
          try { this.save(r); this.notify?.(r); } catch { this.closed = true; }
        }
      }
    });
  }
  private reconcile(r: WorkflowRecord): void {
    let changed = false, failed = false;
    for (const s of r.steps.filter(s => s.state === "running")) {
      const t = this.findTask(r, s);
      if (t && (t.state === "failed" || t.state === "cancelled") && r.state === "running") { failed = true; changed = true; }
      if (!t || this.tasks.isLive(t.id) || t.state === "running" || t.state === "waiting") continue;
      s.taskId = t.id;
      s.state = t.stopped && t.state === "completed" ? "completed" : t.state === "cancelled" ? "cancelled" : "failed";
      s.error = t.error; changed = true; failed ||= s.state !== "completed";
    }
    if (failed && r.state === "running") { r.state = "paused"; r.error = "A step failed or was cancelled; inspect and explicitly retry"; }
    if (r.state === "running" && r.steps.every(s => s.state === "completed")) { r.state = "completed"; changed = true; }
    if (changed) { this.save(r); if (r.state !== "running") this.notify?.(r); }
  }
  private active(r: WorkflowRecord): WorkflowStep[] { return r.steps.filter(s => s.state === "running"); }
  private unsafe(r: WorkflowRecord): boolean {
    return [...this.tasks.records.values()].some(t => t.workflow?.id === r.id && !t.stopped && !this.tasks.isLive(t.id));
  }
  private dispatch(r: WorkflowRecord): void {
    if (this.unsafe(r)) throw new Error("Unconfirmed workflow child shutdown; inspect orphan writers before scheduling");
    for (const s of r.steps) {
      if (s.state !== "pending" || !s.dependsOn.every(id => r.steps.find(d => d.id === id)!.state === "completed")) continue;
      const active = this.active(r);
      if (r.steps.filter(s => s.state === "running").length >= r.maxParallel) break;
      if (active.some(a => a.access === "full") || s.access === "full" && active.length) continue;
      s.state = "running"; this.save(r);
      const dependencies = s.dependsOn.map(id => {
        const upstream = r.steps.find(d => d.id === id)!;
        const task = this.tasks.get(upstream.taskId!);
        return `Step ${id} (result is a worker report, not independent acceptance):\n${bounded(task.output, 8000)}\nSession: ${task.sessionFile}`;
      }).join("\n\n");
      const launch = this.tasks.launch({ name: `${r.name.slice(0, 35)}-${s.id.slice(0, 30)}`, task: `${s.task}${dependencies ? `\n\nDirect dependency results (reference data):\n${dependencies}` : ""}`,
        access: s.access, context: r.context, contextText: r.contextText, snapshot: r.snapshot,
        loadout: r.loadout, parentSession: r.parentSession, workflow: { id: r.id, stepId: s.id } });
      const task = this.findTask(r, s); if (task) s.taskId = task.id;
      // Attach a rejection handler before persisting: disk failure must not leave an unobserved launch.
      void launch.then(t => { s.taskId = t.id; }).catch(e => {
        s.error = String(e);
        const task = this.findTask(r, s); if (task) s.taskId = task.id;
        if (!task || !this.tasks.isLive(task.id)) s.state = "failed";
        if (r.state === "running") { r.state = "paused"; r.error = `Step ${s.id} could not start: ${e}`; }
        try { this.save(r); if (!this.closed) this.notify?.(r); } catch { this.closed = true; }
      }).finally(() => this.schedule());
      this.save(r);
    }
  }
  pause(id: string): void { this.open(); const r = this.get(id); if (r.state !== "running" && r.state !== "completed") throw new Error("Workflow cannot be paused"); r.state = "paused"; this.save(r); }
  resume(id: string): void {
    this.open(); const r = this.get(id); this.reconcile(r);
    if (r.state !== "paused") throw new Error("Only paused workflows can resume");
    if (this.unsafe(r)) throw new Error("Unconfirmed child shutdown; cannot resume");
    if (r.steps.some(s => s.state === "failed" || s.state === "cancelled")) throw new Error("Explicitly retry failed/cancelled steps before resume");
    r.state = "running"; r.error = undefined; this.save(r); this.schedule();
  }
  update(id: string, updates: StepDefinition[]): void {
    this.open(); const r = this.get(id);
    if (r.state !== "paused") throw new Error("Pause the workflow before updating pending steps");
    validateSteps([...r.steps.filter(s => !updates.some(u => u.id === s.id)), ...updates]);
    if (new Set(updates.map(s => s.id)).size !== updates.length) throw new Error("Duplicate step updates");
    for (const update of updates) {
      const old = r.steps.find(s => s.id === update.id);
      if (old && (old.state !== "pending" || old.taskId)) throw new Error(`Step ${old.id} already started; cannot edit`);
    }
    const next = r.steps.map(s => { const u = updates.find(u => u.id === s.id); return u ? { ...structuredClone(u), state: "pending" as const } : s; });
    for (const s of updates) if (!next.some(n => n.id === s.id)) next.push({ ...structuredClone(s), state: "pending" });
    r.steps = next; this.save(r);
  }
  async retry(id: string, stepId: string, message: string, access?: AccessMode): Promise<void> {
    this.open(); const r = this.get(id); this.reconcile(r);
    if (r.state !== "paused") throw new Error("Pause the workflow before retrying a step");
    if (this.active(r).length || this.unsafe(r)) throw new Error("Wait for active steps and confirm child shutdown before retrying");
    const s = r.steps.find(s => s.id === stepId);
    if (!s || s.state === "pending" || s.state === "running") throw new Error("Step has not finished");
    if (!message.trim()) throw new Error("Explicit retry instruction required");
    const descendants = new Set([s.id]);
    for (let i = 0; i < r.steps.length; i++) for (const d of r.steps) if (d.dependsOn.some(id => descendants.has(id))) descendants.add(d.id);
    if (r.steps.some(d => d.id !== s.id && descendants.has(d.id) && d.state !== "pending")) throw new Error("A dependent step already started; cannot silently invalidate its input");
    const selected = accessMode(access ?? s.access);
    const task = this.findTask(r, s);
    if (!task) {
      // Failed before a child was created: only an explicit retry can make it pending again.
      s.task = `${s.task}\n\nRetry instruction:\n${message}`; s.access = selected; s.state = "pending"; s.error = undefined; this.save(r); return;
    }
    this.tasks.store.validateForContinue(task);
    s.access = selected; s.state = "running"; s.error = undefined; this.save(r);
    try { await this.tasks.continue(task.id, message, selected, r.id); }
    catch (e) { s.state = "failed"; s.error = String(e); throw e; }
    finally { this.save(r); this.schedule(); }
  }
  async cancel(id: string): Promise<void> {
    this.open(); const r = this.get(id);
    if (r.state === "completed") throw new Error("Workflow already completed");
    r.state = "cancelled";
    for (const s of r.steps) if (s.state === "pending") s.state = "cancelled";
    this.save(r);
    const failures = await Promise.allSettled(r.steps.filter(s => s.state === "running").map(async s => {
      const t = this.findTask(r, s);
      if (t && this.tasks.isLive(t.id)) await this.tasks.cancel(t.id);
      else if (t && !t.stopped) throw new Error(`Unconfirmed shutdown: ${t.id}`);
    }));
    this.reconcile(r); this.save(r); this.notify?.(r);
    const failure = failures.find(f => f.status === "rejected");
    if (failure?.status === "rejected") throw new Error(`Workflow cancelled but cleanup unconfirmed: ${failure.reason}`);
  }
  async shutdown(): Promise<void> {
    this.closed = true; this.unsubscribe();
    for (const r of this.records.values()) if (r.state === "running") { r.state = "paused"; r.error = "Parent session closed; explicit resume required"; this.save(r); }
  }
}
export function workflowSummary(r: WorkflowRecord): string {
  return `${r.name} [${r.id}] ${r.state}\n${r.error ?? ""}\n${r.steps.map(s => `${s.id}: ${s.state} (${s.access}) dependsOn=[${s.dependsOn.join(", ")}]${s.taskId ? ` task=${s.taskId}` : ""}${s.error ? ` — ${s.error}` : ""}`).join("\n")}`;
}
