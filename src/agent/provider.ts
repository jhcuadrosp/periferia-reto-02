import { z } from "zod";

export const toolCallSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100),
  arguments: z.string().max(100_000) }).strict();
const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict();
export const providerResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("final"), text: z.string().trim().min(1).max(10_000), usage: usage.optional() }).strict(),
  z.object({ type: z.literal("tools"), calls: z.array(toolCallSchema).min(1).max(20), usage: usage.optional() }).strict(),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ProviderRequest = { sessionId: string; messages: Message[]; tools: ToolDefinition[]; maxOutputTokens: number; signal: AbortSignal };
export type Provider = { send(request: ProviderRequest): Promise<unknown> };
