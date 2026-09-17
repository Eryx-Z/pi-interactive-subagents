import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TaskManager } from "./tasks.ts";
import type { TaskRecord } from "./store.ts";

export function clean(text: string): string { return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); }
export function taskSummary(r: TaskRecord): string {
  return `${r.name} [${r.id}] ${r.state} · ${Math.floor(((r.state === "running" || r.state === "waiting" ? Date.now() : r.updatedAt) - r.startedAt) / 1000)}s · ${r.activity}`;
}
// Session-local attention state: persisted history never starts a new display window.
export class TaskWidget {
  private recent = new Map<string, TaskRecord["state"]>();
  private expiresAt = 0;
  result(record: TaskRecord, now = Date.now()): void {
    if (now >= this.expiresAt) this.recent.clear();
    this.recent.set(record.id, record.state);
    this.expiresAt = now + 8000;
  }
  lines(records: TaskRecord[], now = Date.now()): string[] | undefined {
    if (now >= this.expiresAt) this.recent.clear();
    const active = records.filter(r => r.state === "running" || r.state === "waiting");
    const pending = active.filter(r => r.questions.some(q => !q.responseSent));
    const unsafe = records.filter(r => !r.stopped && r.state !== "running" && r.state !== "waiting");
    const counts: string[] = [];
    if (active.length - pending.length) counts.push(`${active.length - pending.length} running`);
    if (pending.length) counts.push(`${pending.length} awaiting answer`);
    if (unsafe.length) counts.push(`${unsafe.length} shutdown unconfirmed`);
    if (!active.length) {
      for (const state of ["completed", "failed", "cancelled"] as const) {
        const count = [...this.recent.values()].filter(s => s === state).length;
        if (count) counts.push(`${count} ${state}`);
      }
    }
    if (!counts.length) return undefined;
    const attention = [
      ...unsafe.map(r => `! ${r.name} · shutdown unconfirmed — inspect before continuing`),
      ...pending.map(r => `? ${r.name} · ${r.questions.filter(q => !q.responseSent).map(q => q.title).join("; ")}`),
    ];
    return [
      `Subagents · ${counts.join(" · ")} · /subagents`,
      ...attention.slice(0, 5).map(line => clean(line).replace(/\s+/g, " ").slice(0, 150)),
      ...(attention.length > 5 ? [`+${attention.length - 5} need attention · /subagents`] : []),
    ];
  }
}
export function widget(manager: TaskManager, ctx: ExtensionContext, display: TaskWidget): void {
  if (ctx.hasUI) ctx.ui.setWidget("rpc-subagents", display.lines([...manager.records.values()]));
}
export function detail(r: TaskRecord): string {
  return clean(`${taskSummary(r)}\nContext: ${r.context} · Run: ${r.run}\nAccess: ${r.access ?? "legacy — choose access before continuation"}${r.workflow ? `\nWorkflow: ${r.workflow.id}, step ${r.workflow.stepId}` : ""}\nCwd: ${r.loadout.cwd}\nSession: ${r.sessionFile}\nTask: ${r.task}\n${r.error ?? ""}\n\nQuestions:\n${r.questions.map(q => `${q.id}: ${q.title}${q.responseSent ? " (answer sent)" : ""}`).join("\n")}\n\nLatest assistant text (bounded):\n${r.output}\n\nRecent activity (bounded):\n${r.log.join("\n")}`);
}
export async function taskMenu(manager: TaskManager, ctx: ExtensionContext, taskId?: string): Promise<void> {
  if (!ctx.hasUI) throw new Error("Use subagent_control in headless mode");
  const items = [...manager.records.values()];
  if (!items.length) { ctx.ui.notify("No subagent tasks yet", "info"); return; }
  const selected = taskId || await ctx.ui.select("Subagent tasks", items.map(r => `${r.id} ${clean(r.name)} — ${r.state}`));
  if (!selected) return;
  const record = manager.get(taskId ?? selected.split(" ")[0]);
  const action = await ctx.ui.select(clean(taskSummary(record)), ["Details", "Message", "Answer question", "Cancel", "Continue"]);
  if (action === "Details") {
    // An editor provides a scrollable copy of the snapshot, not an editable task record.
    await ctx.ui.editor("Task details (snapshot; edits are not saved)", detail(record));
  } else if (action === "Message" || action === "Continue") {
    const message = await ctx.ui.editor(`${action}: ${clean(record.name)}`, "");
    if (!message?.trim()) return;
    if (action === "Message") { await manager.message(record.id, message); ctx.ui.notify("Instruction accepted/queued, not yet proven executed", "info"); }
    else {
      const access = await ctx.ui.select("Continuation access", ["read-only", "full"]);
      if (access !== "read-only" && access !== "full") return;
      await manager.continue(record.id, message, access); ctx.ui.notify("Continuation accepted", "info");
    }
  } else if (action === "Answer question") {
    const questions = record.questions.filter(q => !q.responseSent);
    if (!questions.length) { ctx.ui.notify("No unanswered questions", "info"); return; }
    const choice = await ctx.ui.select("Pending question", questions.map(q => `${q.id} ${clean(q.title)}`));
    if (!choice) return;
    const id = choice.split(" ")[0];
    const answer = await ctx.ui.editor("Answer", "");
    if (answer?.trim()) manager.answer(record.id, id, answer);
  } else if (action === "Cancel" && await ctx.ui.confirm("Cancel task?", clean(record.name))) await manager.cancel(record.id);
}
export function resultRenderer(message: { content: unknown }, options: { expanded: boolean; outputPad?: number }): Text {
  const text = clean(String(message.content));
  return new Text(options.expanded ? text : text.split("\n").slice(0, 5).join("\n") + "\n/subagents for details", options.outputPad ?? 0, 0);
}
