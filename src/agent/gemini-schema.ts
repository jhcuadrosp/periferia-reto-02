import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { toolDefinitions } from "./tool-executor.ts";
import type { ToolDefinition } from "./provider.ts";
import { providerError } from "./provider-error.ts";

function compatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compatibleSchema);
  if (!value || typeof value !== "object") return value;
  const schema = z.record(z.string(), z.unknown()).parse(value);
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key !== "$schema" && key !== "propertyNames") copy[key] = compatibleSchema(child);
  }
  // Zod record(enum, schema): representar los nombres permitidos como propiedades
  // concretas, sin perder el tipo del valor ni la prohibición de claves ajenas.
  if (schema.propertyNames) {
    const names = z.object({ type: z.literal("string"), enum: z.array(z.string()) }).strict().parse(schema.propertyNames);
    if (!schema.additionalProperties || typeof schema.additionalProperties !== "object") throw providerError("configuration");
    copy.properties = Object.fromEntries(names.enum.map((name) => [name, compatibleSchema(schema.additionalProperties)]));
    copy.additionalProperties = false;
  }
  if (typeof schema.exclusiveMinimum === "number" && schema.type === "integer") {
    copy.minimum = Math.max(typeof schema.minimum === "number" ? schema.minimum : -Infinity, Math.floor(schema.exclusiveMinimum) + 1);
    delete copy.exclusiveMinimum;
  }
  return copy;
}

export function geminiDeclarations(supplied: ToolDefinition[], transport?: "references"): FunctionDeclaration[] {
  const originals = toolDefinitions(transport);
  // Las declaraciones proceden del registro real, no de texto o esquemas propuestos por el modelo.
  if (supplied.length !== originals.length || originals.some((original) => !supplied.some((tool) => tool.name === original.name))) {
    throw providerError("configuration");
  }
  return originals.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: compatibleSchema(tool.parameters) }));
}
