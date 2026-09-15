// Scripted real-Pi lifecycle regressions: no network or model quota.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const finalTool = {
  name: "final_output", label: "Final output", description: "Fixture terminating output", parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text" as const, text: "Finished through tool" }], details: {}, terminate: true }; },
};
export default function lifecycleTools(pi: ExtensionAPI) {
  let slowShutdown = false;
  pi.registerTool(finalTool);
  const gate = async (cwd: string) => {
    slowShutdown = true;
    writeFileSync(join(cwd, "preflight-entered"), "");
    while (!existsSync(join(cwd, "release-preflight"))) await new Promise(resolve => setTimeout(resolve, 10));
    writeFileSync(join(cwd, "preflight-released"), "");
  };
  pi.on("input", async (event, ctx) => {
    if (event.text.includes("Assigned task:\nHANDLED")) return { action: "handled" };
    if (event.text.includes("GATED_INPUT_BASH")) await gate(ctx.cwd);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt.includes("GATED_BEFORE_BASH")) await gate(ctx.cwd);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (slowShutdown) {
      writeFileSync(join(ctx.cwd, "shutdown-started"), "");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  });
  pi.registerProvider("lifecycle-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? JSON.stringify(last.content) : "";
      const content: AssistantMessage["content"] = [];
      if (input.includes("BASH")) {
        slowShutdown = true;
        content.push({ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "touch started; sleep 3; touch marker" } });
      } else if (input.includes("TERMINATE")) {
        content.push({ type: "toolCall", id: "final-call", name: "final_output", arguments: {} });
      } else content.push({ type: "text", text: "Unexpected follow-up model request" });
      const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      setImmediate(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
