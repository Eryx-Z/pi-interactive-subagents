// Local deterministic provider and file-backed tools. No network or real model quota.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function inheritedTools(pi: ExtensionAPI) {
  const tool = (name: string) => ({
    name, label: name, description: `Fixture ${name}`, parameters: Type.Object({ value: Type.String() }),
    async execute(_id: string, p: {value: string}) {
      return { content: [{ type: "text" as const, text: `${name}: ${p.value}` }], details: {} };
    },
  });
  pi.registerTool(tool("read")); // Must never silently fall back to builtin read.
  pi.registerTool(tool("custom_search"));
  pi.registerTool(tool("inactive_tool"));
  pi.registerTool(tool("spawn_agent"));
  pi.registerTool(tool("ask_question")); // Child bridge must take precedence.
  pi.on("session_start", () => { pi.registerTool(tool("startup_tool")); });
  pi.registerProvider("inherited-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: ["default", "override"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 })),
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const input = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(b => b.type === "text").map(b => b.text).join("\n")) : "";
      const content: AssistantMessage["content"] = [];
      if (input.startsWith("DISPATCH ")) {
        content.push({ type: "toolCall", id: "dispatch", name: "subagent", arguments: JSON.parse(input.slice(9)) });
      } else if (input.startsWith("CONTROL ")) {
        content.push({ type: "toolCall", id: "control", name: "subagent_control", arguments: JSON.parse(input.slice(8)) });
      } else if (process.env.PI_RPC_SUBAGENT_CHILD === "1" && input.includes("Assigned task:\nEXERCISE")) {
        for (const name of ["custom_search", "startup_tool", "read"]) content.push({ type: "toolCall", id: name, name, arguments: { value: "inherited execution" } });
      } else if (process.env.PI_RPC_SUBAGENT_CHILD === "1" && input.includes("Assigned task:\nASK")) {
        content.push({ type: "toolCall", id: "question", name: "ask_question", arguments: { question: "Which implementation?" } });
      } else {
        content.push({ type: "text", text: JSON.stringify({ tools: context.tools?.map(t => t.name), systemPrompt: context.systemPrompt, last }) });
      }
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
