import type { Content, FunctionCall, Part } from "@google/genai";
import { z } from "zod";
import type { Message, ToolCall } from "./provider.ts";
import { providerError } from "./provider-error.ts";

export type SavedResponse = { content: Content; calls: ToolCall[]; wireCalls: Map<string, FunctionCall> };
export function geminiHistory(messages: Message[], saved: Map<string, SavedResponse>) {
  const system = messages[0];
  if (system?.role !== "system" || messages.slice(1).some((message) => message.role === "system")) throw providerError("history");
  const contents: Content[] = [];
  const pending = new Map<string, FunctionCall>();
  for (const message of messages.slice(1)) {
    if (message.role === "tool") {
      const call = pending.get(message.tool_call_id);
      if (!call || call.name !== message.name) throw providerError("history");
      let response: Record<string, unknown>;
      try { response = z.record(z.string(), z.unknown()).parse(JSON.parse(message.content)); }
      catch { throw providerError("history"); }
      const part: Part = { functionResponse: { name: call.name, response, ...(call.id ? { id: call.id } : {}) } };
      const previous = contents.at(-1);
      if (previous?.role === "user" && previous.parts?.every((item) => item.functionResponse)) previous.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      pending.delete(message.tool_call_id);
      continue;
    }
    if (pending.size) throw providerError("history");
    if (message.role === "assistant") {
      if (message.provider_response_id) {
        const original = saved.get(message.provider_response_id);
        if (!original || JSON.stringify(message.tool_calls ?? []) !== JSON.stringify(original.calls)) throw providerError("history");
        contents.push(structuredClone(original.content));
        for (const [id, call] of original.wireCalls) pending.set(id, call);
      } else {
        if (message.tool_calls?.length) throw providerError("history");
        contents.push({ role: "model", parts: [{ text: message.content }] });
      }
    } else if (message.role === "user") contents.push({ role: "user", parts: [{ text: message.content }] });
  }
  if (pending.size) throw providerError("history");
  return { systemInstruction: system.content, contents };
}
