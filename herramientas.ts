import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { leer_buzon, extraer, validar, registrar, alertas, type ToolContext } from "./src/tools/contratos.ts";

const directory = await mkdtemp(join(tmpdir(), "periferia-herramientas-"));
await cp(fileURLToPath(new URL("./fixtures", import.meta.url)), join(directory, "fixtures"), { recursive: true });
const ctx: ToolContext = { directory, sessionId: "muestra-local", now: () => "2026-09-03T12:00:00.000Z" };
const responseSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.string() })]);
function result(serialized: string) {
  const response = responseSchema.parse(JSON.parse(serialized));
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

console.log(`Herramientas sin LLM, proyecto temporal: ${directory}`);
const mailbox = result(await leer_buzon.execute({}, ctx));
console.log(JSON.stringify({ pendientes: mailbox.mensajes }, null, 2));

// Muestra breve de una escritura y una revisión bloqueada; no es la demo integral de Fase 6.2.
for (const id of ["msg-003", "msg-006"]) {
  const extraction = result(await extraer.execute({ mensaje_id: id }, ctx));
  const validation = result(await validar.execute({ mensaje_id: id, contrato: extraction }, ctx));
  const registration = result(await registrar.execute({ mensaje_id: id, contrato: validation.contrato }, ctx));
  console.log(JSON.stringify({ mensaje: id, clasificacion: validation.clasificacion, revision: validation.requiere_revision,
    resultado: registration }, null, 2));
}
const report = result(await alertas.execute({ hoy: "2026-09-03" }, ctx));
console.log(JSON.stringify({ alertas: report, archivo: join(directory, "out/alertas.md") }, null, 2));
