import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgent } from "./src/agent/runner.ts";
import { createMockProvider } from "./src/agent/mock-provider.ts";
import type { ProviderRequest } from "./src/agent/provider.ts";

const directory = await mkdtemp(join(tmpdir(), "periferia-agente-mock-"));
await cp(fileURLToPath(new URL("./fixtures", import.meta.url)), join(directory, "fixtures"), { recursive: true });
const tools = (id: string, name: string, args: unknown) => ({ type: "tools", calls: [{ id, name, arguments: JSON.stringify(args) }] });
function lastData(request: ProviderRequest) {
  const message = request.messages.filter((entry) => entry.role === "tool").at(-1);
  if (!message) throw new Error("Falta resultado en la simulación.");
  return z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).parse(JSON.parse(message.content)).data;
}
const agent = await createAgent({ directory, now: () => "2026-09-03T12:00:00.000Z", provider: createMockProvider([
  { type: "final", text: "Hola. Puedo consultar el buzón y mostrar contratos que necesitan revisión." },
  tools("mail", "contratos_leer_buzon", {}), tools("extract", "contratos_extraer", { mensaje_id: "msg-006" }),
  (request: ProviderRequest) => tools("validate", "contratos_validar", { mensaje_id: "msg-006", contrato: lastData(request) }),
  (request: ProviderRequest) => tools("register", "contratos_registrar", { mensaje_id: "msg-006", contrato: lastData(request).contrato, confirmado: true }),
  { type: "final", text: "El resultado de la herramienta determina si se aplicó la operación." },
]) });
const id = agent.createSession();
console.log(`Agente simulado sin LLM. Directorio aislado: ${directory}`);
console.log(`Sesión: ${id}. El guion es fijo; no interpreta lenguaje natural.`);
for (const text of ["Hola", "Consulta el buzón y revisa el contrato marco", "confirmo"]) {
  console.log(`\nUsuario: ${text}`);
  const response = await agent.send(id, text, { allowRegistration: true });
  if (!response.ok) { console.log(`Error: ${response.error}`); process.exitCode = 1; break; }
  for (const event of response.data.events) {
    if (event.type === "tool") {
      const result = z.object({ ok: z.boolean() }).parse(JSON.parse(event.result));
      console.log(`Herramienta: ${event.name} → ${result.ok ? "resultado disponible" : "operación bloqueada"}`);
    }
    if (event.type === "review_required") console.log(`Revisión humana: ${event.mensaje_id}: ${event.fields.join(", ")}`);
  }
  console.log(`Agente [${response.data.status}]: ${response.data.reply}`);
}
console.log(`\nAuditoría: ${join(directory, "out/log.jsonl")}`);
const csv = await readFile(join(directory, "out/sharepoint/maestro-contratos.csv"), "utf8");
if (csv.includes("CM-2026-03")) { console.error("FALLO: msg-006 apareció en el maestro sin autorización."); process.exitCode = 1; }
else console.log("El texto «confirmo» no autentica ni aprueba una solicitud. Verificado: msg-006 no está registrado.");
