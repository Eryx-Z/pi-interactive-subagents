import { buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "./store.ts";

export type AgentMessage = ReturnType<typeof buildSessionContext>["messages"][number];
export type ContextMode = "none" | "partial" | "full";
export const COOPERATION = `You are a delegated child, not the parent orchestrator. Historical conversation is reference-only.
Only execute the assigned task. Do not delegate to other agents or launch agent CLIs.
Other agents share this working directory and may read and write concurrently. Modify only your assigned ownership scope.
Do not overwrite or revert others' changes. Ask the parent before changing shared interfaces or files outside your scope.
Ownership is a cooperation agreement, not a filesystem sandbox.
Use ask_question for decisions you cannot make; the tool blocks until the correlated answer arrives.
Finish with: completion status (complete/partial/blocked), changes, validation, and remaining issues. Stopping is not proof of correctness.`;

/** Called at tool preflight: the session is synchronized through the current assistant message. */
export function snapshotContext(sm: ExtensionContext["sessionManager"]): AgentMessage[] {
  return structuredClone(buildSessionContext(sm.getBranch(), sm.getLeafId()).messages);
}

/** A dispatch snapshot can contain pending parent tool calls. Close them in the copy only. */
export function closePendingCalls(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pending = new Map<string, string>();
  const flush = () => {
    for (const [id, name] of pending) result.push({
      role: "toolResult", toolCallId: id, toolName: name,
      content: [{ type: "text", text: "Parent tool was still pending at dispatch; no result is available in this frozen reference snapshot." }],
      isError: true, timestamp: Date.now(),
    });
    pending = new Map();
  };
  for (const message of structuredClone(messages)) {
    if (message.role !== "toolResult") flush();
    result.push(message);
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "toolCall") pending.set(block.id, block.name);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  flush();
  return result;
}
export function seedSession(path: string, cwd: string, mode: ContextMode, snapshot: AgentMessage[] = [], parentSession?: string): void {
  const now = new Date().toISOString();
  const lines: unknown[] = [{ type: "session", version: 3, id: randomUUID(), timestamp: now, cwd, ...(parentSession ? { parentSession } : {}) }];
  let parentId: string | null = null;
  for (const message of mode === "full" ? closePendingCalls(snapshot) : []) {
    const id = randomUUID().slice(0, 8);
    lines.push({ type: "message", id, parentId, timestamp: now, message });
    parentId = id;
  }
  atomicWrite(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}
export function taskPrompt(task: string, ownership: string, context: ContextMode, contextText?: string): string {
  if (!["none", "partial", "full"].includes(context)) throw new Error("Invalid context mode");
  if (context !== "partial" && contextText) throw new Error("contextText is only supported in partial mode");
  if (context === "partial" && !contextText?.trim()) throw new Error("partial context requires explicit contextText (use none for an independent task)");
  return `${COOPERATION}\n\nContext mode: ${context}\nOwnership: ${ownership}\n\n${context === "partial" ? `Selected parent context:\n${contextText}\n\n` : ""}Assigned task:\n${task}`;
}
