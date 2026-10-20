import { z } from "zod";
import type { TaskProgress } from "./task.ts";

export const toolCallSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100),
  arguments: z.string().max(100_000) }).strict();
export const providerUsageSchema = z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(), thinking_tokens: z.number().int().nonnegative().optional() }).strict()
  .refine((usage) => Object.values(usage).some((value) => value !== undefined), "Se requiere algún contador informado.");
export const providerResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("final"), text: z.string().trim().min(1).max(10_000), usage: providerUsageSchema.optional(), provider_response_id: z.uuid().optional() }).strict(),
  z.object({ type: z.literal("tools"), calls: z.array(toolCallSchema).min(1).max(20), usage: providerUsageSchema.optional(), provider_response_id: z.uuid().optional() }).strict(),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[]; provider_response_id?: string }
  | { role: "tool"; content: string; tool_call_id: string; name: string };
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ProviderRequest = { sessionId: string; messages: Message[]; tools: ToolDefinition[]; maxOutputTokens: number; signal: AbortSignal;
  task?: TaskProgress };
export type Provider = { toolTransport?: "references"; send(request: ProviderRequest): Promise<unknown> };
