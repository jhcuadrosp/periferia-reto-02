import { z } from "zod";
import * as contracts from "../tools/contratos.ts";
import { digest } from "../domain/confirmation.ts";
import { registrationTicketSchema, recordToolEvent } from "../storage/persistence.ts";
import type { Binding, Session } from "./session.ts";
import type { ToolCall, ToolDefinition } from "./provider.ts";

const tools = { contratos_leer_buzon: contracts.leer_buzon, contratos_extraer: contracts.extraer,
  contratos_validar: contracts.validar, contratos_registrar: contracts.registrar, contratos_alertas: contracts.alertas };
export function toolDefinitions(): ToolDefinition[] {
  return Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description,
    parameters: z.toJSONSchema(z.object(tool.args).strict(), { unrepresentable: "any" }) }));
}
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()), error_auditoria: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string(), error_auditoria: z.string().optional() }),
]);
export async function executeTool(call: ToolCall, session: Session, directory: string, now: () => string, allowRegistration = false) {
  let result: z.infer<typeof resultSchema>;
  let args: unknown;
  let binding: Binding | undefined;
  try {
    if (!Object.hasOwn(tools, call.name)) throw new Error("Herramienta no permitida.");
    if (call.name === "contratos_registrar" && !allowRegistration) throw new Error("El canal local no habilitó registros para este turno.");
    try { args = JSON.parse(call.arguments); } catch { throw new Error("Los argumentos no son JSON válido."); }
    const tool = tools[call.name as keyof typeof tools];
    const parsed = z.object(tool.args).strict().safeParse(args);
    if (!parsed.success) throw new Error("Argumentos inválidos según el contrato Zod de la herramienta.");
    const context: contracts.ToolContext = { directory, sessionId: session.id, now };
    if (call.name === "contratos_registrar") {
      const input = z.object(contracts.registrar.args).strict().parse(args);
      const ticket = session.tickets.get(input.mensaje_id);
      if (!ticket || digest(ticket) !== digest(input.contrato)) throw new Error("Se necesita el ticket validado en esta sesión, sin alteraciones.");
      if (input.confirmado === true) {
        const entry = [...session.approvals].find(([, approval]) => approval.state === "aprobada" && digest(approval.ticket) === digest(ticket));
        if (!entry) throw new Error("No hay aprobación humana externa para esta sesión y estos valores.");
        binding = entry[1];
        context.autorizacion = { solicitud_id: entry[0], datos_hash: binding.datos_hash, revisor: binding.reviewer };
      }
    }
    const raw = resultSchema.parse(JSON.parse(await tool.execute(args, context)));
    // Los errores técnicos originales quedan en la auditoría de la herramienta, no en el chat.
    result = raw.ok ? raw : { ok: false, error: "La herramienta no pudo completar la operación; revisa los datos o solicita una nueva evaluación." };
    if (raw.error_auditoria) result = { ...result, error_auditoria: "No se pudo completar la auditoría de la llamada." };
    if (result.ok && call.name === "contratos_validar") {
      const ticket = registrationTicketSchema.parse(result.data.contrato);
      session.tickets.set(ticket.mensaje_id, ticket);
    }
    if (result.ok && binding && ["registrado", "actualizado"].includes(String(result.data.accion))) binding.state = "utilizada";
  } catch (error) {
    const expected = error instanceof Error && ["Herramienta no permitida.", "Los argumentos no son JSON válido.",
      "Argumentos inválidos según el contrato Zod de la herramienta.", "Se necesita el ticket validado en esta sesión, sin alteraciones.",
      "No hay aprobación humana externa para esta sesión y estos valores.", "El canal local no habilitó registros para este turno."].includes(error.message);
    result = { ok: false, error: expected ? (error as Error).message : "No se pudo ejecutar la herramienta." };
    try {
      await recordToolEvent(directory, { ts: now(), herramienta: "agente_herramienta_rechazada", session_id: session.id,
        mensaje_id: null, ok: false, resumen: result.error, nombre: call.name });
    } catch { result = { ...result, error_auditoria: "No se pudo auditar la llamada rechazada." }; }
  }
  const serialized = JSON.stringify(result);
  session.events.push({ type: "tool", id: call.id, name: call.name, arguments: call.arguments, result: serialized });
  const fields = result.ok ? z.array(z.string()).safeParse(result.data.requiere_revision) : null;
  const pending = result.ok && (result.data.estado_validacion === "pendiente_revision" || result.data.estado === "requiere_revision");
  if (pending && fields?.success) {
    const input = z.object({ mensaje_id: z.string() }).parse(args);
    session.events.push({ type: "review_required", mensaje_id: input.mensaje_id, fields: fields.data });
  }
  return { serialized, pending, auditFailed: Boolean(result.error_auditoria) };
}
