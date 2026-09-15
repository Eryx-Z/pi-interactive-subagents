import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveLoadout } from "../../pi-extension/subagents/loadout.ts";

export function readInfo(cwd: string) {
  return { ...createReadToolDefinition(cwd), sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary" as const, origin: "top-level" as const } };
}
export function loadout(cwd: string, model = "fake/test") {
  return resolveLoadout({ getActiveTools: () => ["read"], getAllTools: () => [readInfo(cwd)] }, [], cwd, model, "off", cwd);
}
