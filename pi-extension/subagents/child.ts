import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { validateLoadout } from "./agents.ts";

/** Only this bridge, plus explicitly configured tool extensions, is loaded in child RPC processes. */
export default function childBridge(pi: ExtensionAPI) {
  const path = process.env.PI_RPC_SUBAGENT_LOADOUT;
  if (!path) throw new Error("Child bridge requires a validated loadout file");
  const loadout = validateLoadout(JSON.parse(readFileSync(path, "utf8")));
  const allowed = new Set(loadout.tools);
  pi.registerTool({
    name: "ask_question", label: "Ask parent", description: "Ask the parent a decision question. This tool blocks until the matching answer arrives.",
    executionMode: "sequential",
    parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc") throw new Error("ask_question requires the RPC parent bridge");
      const answer = await ctx.ui.input(params.question, "Parent answer", { signal });
      if (answer === undefined || signal?.aborted) throw new Error("Question cancelled without an answer");
      return { content: [{ type: "text", text: answer }], details: {} };
    },
  });
  pi.registerCommand("rpc-subagent-preflight", {
    description: "Internal child loadout validation (no model call)",
    async handler(_args, ctx) {
      const known = new Set(pi.getAllTools().map(t => t.name));
      const missing = loadout.tools.filter(t => !known.has(t));
      if (missing.length) throw new Error(`Child is missing required tools: ${missing.join(", ")}`);
      pi.setActiveTools(loadout.tools);
      if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== loadout.model) throw new Error(`Requested model was not selected: ${loadout.model}`);
      const active = pi.getActiveTools();
      if (active.length !== allowed.size || active.some(t => !allowed.has(t))) throw new Error("Child tool allowlist was not applied");
    },
  });
  pi.on("tool_call", event => {
    if (!allowed.has(event.toolName)) return { block: true, reason: "Tool outside child loadout", terminate: true };
  });
}
