import { afterEach, expect } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GenerateContentResponse, FinishReason, type GenerateContentParameters, type Content, type Part } from "@google/genai";
import { createSessionStore, type Session } from "../src/agent/session.ts";
import { executeTool, toolDefinitions } from "../src/agent/tool-executor.ts";
import { geminiDeclarations } from "../src/agent/gemini-schema.ts";
import { createGeminiProvider, type GeminiMetric } from "../src/agent/gemini-provider.ts";
import { createAgent } from "../src/agent/runner.ts";
import { createMockProvider } from "../src/agent/mock-provider.ts";
import { contextWindow } from "../src/agent/context-window.ts";
import type { Message, ProviderRequest } from "../src/agent/provider.ts";
import { integrationTests } from "./helpers/integration.ts";

const { test, waitForCompletion } = integrationTests();
const directories: string[] = [];
const root = fileURLToPath(new URL("../", import.meta.url));
const now = () => "2030-01-02T12:00:00.000Z";
const envelope = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }), z.object({ ok: z.literal(false), error: z.string() })]);
afterEach(async () => { await waitForCompletion(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); }, 60_000);
async function project() {
  const directory = await mkdtemp(join(tmpdir(), "periferia-optimization-")); directories.push(directory);
  await cp(join(root, "fixtures"), join(directory, "fixtures"), { recursive: true }); return directory;
}
function session() { const store = createSessionStore(); return store.get(store.create()); }
function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }) { if (!result.ok) throw new Error(result.error); return result.data; }
const call = (name: string, args: unknown) => ({ id: randomUUID(), name, arguments: JSON.stringify(args) });
async function invoke(directory: string, current: Session, name: string, args: unknown, allow = false) {
  const result = await executeTool(call(name, args), current, directory, now, allow, "references");
  return { ...result, full: envelope.parse(JSON.parse(result.serialized)), compact: envelope.parse(JSON.parse(result.providerSerialized)) };
}
const reference = (result: { compact: z.infer<typeof envelope> }) => z.uuid().parse(unwrap(result.compact).contrato_ref);
function data(request: ProviderRequest, name?: string) {
  const result = request.messages.filter((message) => message.role === "tool" && (!name || message.name === name)).at(-1);
  if (!result) throw new Error("Falta resultado."); return unwrap(envelope.parse(JSON.parse(result.content)));
}
function response(parts: Part[], tokens = 100) {
  const result = new GenerateContentResponse();
  result.candidates = [{ finishReason: FinishReason.STOP, content: { role: "model", parts } }];
  result.usageMetadata = { promptTokenCount: tokens - 10, candidatesTokenCount: 10, totalTokenCount: tokens, cachedContentTokenCount: 30 };
  return result;
}

test("Las cinco declaraciones compactas eliminan los objetos grandes; el contrato interno completo se conserva", () => {
  const original = JSON.stringify(geminiDeclarations(toolDefinitions())).length;
  const compact = geminiDeclarations(toolDefinitions("references"), "references");
  expect(compact.map((tool) => tool.name)).toEqual(toolDefinitions().map((tool) => tool.name));
  expect(JSON.stringify(compact).length).toBeLessThan(original / 3);
  const validation = z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) }).parse(compact[2]!.parametersJsonSchema);
  expect(validation.required).toEqual(["mensaje_id", "contrato_ref"]);
  expect(validation.properties).not.toHaveProperty("contrato");
  expect(JSON.stringify(toolDefinitions()[2])).toContain("normalizado");
});

test("msg-006 usa los originales del servidor y llega a revisión sin reconstruir evidencias", async () => {
  const directory = await project(), current = session();
  const extracted = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-006" });
  expect(extracted.providerSerialized.length).toBeLessThan(extracted.serialized.length);
  expect(extracted.providerSerialized).not.toContain('"extraido"');
  const full = unwrap(extracted.full);
  expect(full).toHaveProperty("campos.valor.normalizado", null);
  expect(full).toHaveProperty("valor_indeterminado.normalizado", true);
  expect(JSON.stringify(full)).toContain("evidencia");
  const validated = await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-006", contrato_ref: reference(extracted) });
  expect(validated.pending).toBe(true); expect(unwrap(validated.full).clasificacion).toBe("nuevo");
  expect(reference(validated)).not.toBe(reference(extracted));
  expect(validated.providerSerialized).not.toContain("maestro_hash");
  expect(await readFile(join(directory, "out/sharepoint/maestro-contratos.csv"), "utf8")).not.toContain("CM-2026-03");
});

test("Se rechazan referencias ajenas, inventadas, de otro mensaje/tipo y campos reconstruidos", async () => {
  const directory = await project(), current = session();
  const extracted = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-001" });
  const ref = reference(extracted);
  for (const [target, name, args] of [
    [session(), "contratos_validar", { mensaje_id: "msg-001", contrato_ref: ref }],
    [current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: randomUUID() }],
    [current, "contratos_validar", { mensaje_id: "msg-002", contrato_ref: ref }],
    [current, "contratos_registrar", { mensaje_id: "msg-001", contrato_ref: ref }],
    [current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: ref, contrato: unwrap(extracted.full) }],
  ] as const) {
    const result = await invoke(directory, target, name, args, true);
    expect(result.full.ok).toBe(false);
  }
  const stored = current.references.get(ref)!; stored.mensaje_id = "otro-mensaje";
  expect((await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: ref })).full.ok).toBe(false);
});

test("Una nueva extracción invalida referencias previas y la alteración de memoria no pasa su hash", async () => {
  const directory = await project(), current = session();
  const a = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-001" });
  const ticket = await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: reference(a) });
  const b = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-001" });
  expect((await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: reference(a) })).full.ok).toBe(false);
  expect((await invoke(directory, current, "contratos_registrar", { mensaje_id: "msg-001", contrato_ref: reference(ticket) }, true)).full.ok).toBe(false);
  const value = current.references.get(reference(b))!.value;
  if (!("campos" in value)) throw new Error("Falta extracción."); value.campos.valor.normalizado = 0;
  expect((await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: reference(b) })).full.ok).toBe(false);
});

test("Fuentes cambiadas bloquean la validación aunque la referencia siga existiendo", async () => {
  const directory = await project(), current = session();
  const extracted = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-001" });
  const path = join(directory, "fixtures/reto-02/buzon/msg-001/contrato.txt");
  const original = await readFile(path, "utf8"); const changed = original.replace("265.000.000", "266.000.000");
  expect(changed).not.toBe(original); await writeFile(path, changed);
  const result = await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: reference(extracted) });
  expect(result.full.ok).toBe(false);
});

test("Registro por referencia conserva idempotencia y bloquea un maestro cambiado", async () => {
  for (const changed of [false, true]) {
    const directory = await project(), current = session();
    const extraction = await invoke(directory, current, "contratos_extraer", { mensaje_id: "msg-001" });
    const ticket = await invoke(directory, current, "contratos_validar", { mensaje_id: "msg-001", contrato_ref: reference(extraction) });
    if (changed) {
      const path = join(directory, "out/sharepoint/maestro-contratos.csv");
      const original = await readFile(path, "utf8"), altered = original.replace("CT-2026-004", "CT-2026-777");
      expect(altered).not.toBe(original); await writeFile(path, altered);
    }
    const args = { mensaje_id: "msg-001", contrato_ref: reference(ticket) };
    const first = await invoke(directory, current, "contratos_registrar", args, true);
    if (changed) { expect(first.full.ok).toBe(false); continue; }
    expect(unwrap(first.full).accion).toBe("registrado");
    expect(unwrap((await invoke(directory, current, "contratos_registrar", args, true)).full).accion).toBe("ya_procesado");
    expect((await readFile(join(directory, "out/sharepoint/historial.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  }
});

test("Consultas finales explícitas usan una sola inferencia y preservan firmas en el siguiente turno", async () => {
  const directory = await project(); let calls = 0; const metrics: GeminiMetric[] = [];
  const provider = createGeminiProvider({ apiKey: "CLAVE_FICTICIA", model: "gemini-prueba", onMetric: (metric) => { metrics.push(metric); }, generate: async (params) => {
    calls++;
    if (calls === 1) return response([{ functionCall: { id: "wire-a", name: "contratos_leer_buzon", args: { finalizar_consulta: true } }, thoughtSignature: "firma-primera" }]);
    const contents = params.contents as Content[];
    expect(contents.flatMap((content) => content.parts ?? []).some((part) => part.thoughtSignature === "firma-primera")).toBe(true);
    expect(JSON.stringify(contents)).toContain('"functionResponse"');
    return response([{ functionCall: { name: "contratos_extraer", args: { mensaje_id: "msg-001", finalizar_consulta: true } } }]);
  } });
  const agent = await createAgent({ directory, provider, now }); const id = agent.createSession();
  const first = unwrap(await agent.send(id, "Consulta el buzón"));
  expect(first.status).toBe("final"); expect(first.reply).toContain("6 mensajes"); expect(calls).toBe(1);
  expect(first.turnTokens).toBe(100); expect(first.tokens).toBe(100); expect(first.tokenLimit).toBe(20000);
  const second = unwrap(await agent.send(id, "Extrae Delta"));
  expect(calls).toBe(2); expect(second.reply).toContain("265000000"); expect(second.tokens).toBe(200); expect(second.turnTokens).toBe(100);
  expect(metrics[0]!.cached_tokens).toBe(30); expect(metrics[0]!.tool_schema_characters).toBeLessThan(6000);
});

test("Cadena compacta llega a review_required y mantiene bloqueado «confirmo» con permiso local", async () => {
  const directory = await project(); let index = 0; let ref = "";
  const provider = Object.assign(createMockProvider([
    { type: "tools", calls: [call("contratos_extraer", { mensaje_id: "msg-006" })] },
    (request: ProviderRequest) => { ref = z.uuid().parse(data(request).contrato_ref); return { type: "tools", calls: [call("contratos_validar", { mensaje_id: "msg-006", contrato_ref: ref })] }; },
    (request: ProviderRequest) => ({ type: "tools", calls: [call("contratos_registrar", { mensaje_id: "msg-006", contrato_ref: data(request).contrato_ref, confirmado: true })] }),
    { type: "final", text: "No registrado." },
  ]), { toolTransport: "references" as const });
  const agent = await createAgent({ directory, provider: { ...provider, async send(request) { index++; return provider.send(request); } }, now });
  const id = agent.createSession(); const first = unwrap(await agent.send(id, "Revisa msg-006", { allowRegistration: true }));
  expect(first.status).toBe("review_required"); expect(first.toolErrors).toHaveLength(0); expect(index).toBe(2);
  const second = unwrap(await agent.send(id, "Confirmo, registra", { allowRegistration: true }));
  expect(second.status).toBe("tool_error"); expect(second.toolErrors[0]!.error).toContain("No hay aprobación humana externa");
  expect(await readFile(join(directory, "out/sharepoint/maestro-contratos.csv"), "utf8")).not.toContain("CM-2026-03");
});

test("El cierre anticipado espera todo el lote y no corta una cadena de validación pendiente", async () => {
  for (const complete of [false, true]) {
    const directory = await project(); let count = 0;
    const provider = createGeminiProvider({ apiKey: "CLAVE_FICTICIA", model: "gemini-prueba", generate: async (params) => {
      if (++count === 1) return response([
        { functionCall: { name: "contratos_leer_buzon", args: { finalizar_consulta: true } } },
        { functionCall: { name: "contratos_extraer", args: { mensaje_id: "msg-001", finalizar_consulta: complete } } },
      ]);
      if (count === 2) {
        const results = (params.contents as Content[]).flatMap((content) => content.parts ?? []).filter((part) => part.functionResponse?.name === "contratos_extraer");
        const extracted = unwrap(envelope.parse(results.at(-1)!.functionResponse!.response));
        return response([{ functionCall: { name: "contratos_validar", args: { mensaje_id: "msg-001", contrato_ref: extracted.contrato_ref } } }]);
      }
      return response([{ text: "Consulta completada" }]);
    } });
    const agent = await createAgent({ directory, provider, now });
    const turn = unwrap(await agent.send(agent.createSession(), complete ? "Consulta buzón y extrae" : "Consulta buzón y valida Delta"));
    expect(turn.status).toBe("final"); expect(count).toBe(complete ? 1 : 3);
    expect(turn.events.filter((event) => event.type === "tool")).toHaveLength(complete ? 2 : 3);
    if (!complete) expect(turn.reply).toContain("msg-001: nuevo");
  }
});

test("Fallo de herramienta no se presenta como final exitoso ni se confunde con error del proveedor", async () => {
  const directory = await project();
  const provider = Object.assign(createMockProvider([
    { type: "tools", calls: [call("contratos_alertas", { hoy: "2026-02-30", finalizar_consulta: true })] },
    { type: "final", text: "Todo correcto" }, { type: "final", text: "Continuamos" },
  ]), { toolTransport: "references" as const });
  const agent = await createAgent({ directory, provider, now }); const id = agent.createSession();
  const failed = unwrap(await agent.send(id, "Alertas"));
  expect(failed.status).toBe("tool_error"); expect(failed.toolErrors).toHaveLength(1); expect(failed.reply).not.toContain("Todo correcto");
  expect(unwrap(await agent.send(id, "Hola")).reply).toBe("Continuamos");
});

test("Presupuesto alcanzado después de una consulta conserva los hechos ya obtenidos", async () => {
  const directory = await project();
  const provider = Object.assign(createMockProvider([
    { type: "tools", calls: [call("contratos_leer_buzon", {})], usage: { input_tokens: 5, output_tokens: 1 } },
    { type: "final", text: "Texto", usage: { input_tokens: 5, output_tokens: 1 } },
  ]), { toolTransport: "references" as const });
  const agent = await createAgent({ directory, provider, limits: { maxTokens: 12 }, now });
  const turn = unwrap(await agent.send(agent.createSession(), "Buzón"));
  expect(turn.status).toBe("limit"); expect(turn.reply).toContain("6 mensajes"); expect(turn.reply).toContain("presupuesto"); expect(turn.tokens).toBe(12);
});

test("Ventana del proveedor limita cuatro turnos completos, conservando historial local y pares de llamadas", async () => {
  const directory = await project(); const seen: ProviderRequest[] = [];
  const provider = { toolTransport: "references" as const, async send(request: ProviderRequest) {
    seen.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
    return { type: "tools", calls: [call("contratos_extraer", { mensaje_id: "msg-001", finalizar_consulta: true })] };
  } };
  const agent = await createAgent({ directory, provider, now }); const id = agent.createSession();
  for (let index = 0; index < 6; index++) expect(unwrap(await agent.send(id, `Consulta ${index}`)).status).toBe("final");
  expect(seen.at(-1)!.messages.filter((message) => message.role === "user")).toHaveLength(4);
  expect(seen.at(-1)!.messages[1]!.content).toBe("Consulta 2");
  expect(unwrap(agent.getSession(id)).messages.filter((message) => message.role === "user")).toHaveLength(6);
  const window = contextWindow(unwrap(agent.getSession(id)).messages);
  const calls = new Set(window.flatMap((message) => message.role === "assistant" ? message.tool_calls?.map((call) => call.id) ?? [] : []));
  for (const message of window) if (message.role === "tool") expect(calls.has(message.tool_call_id)).toBe(true);
  expect(window[0]!.role).toBe("user");
});

test("Una autorización externa sigue ligada a sesión, revisor y valores en transporte compacto", async () => {
  const directory = await project(), folder = join(directory, "fixtures/reto-02/buzon/msg-sintetico");
  await mkdir(folder);
  await writeFile(join(folder, "correo.json"), JSON.stringify({ id: "msg-sintetico", de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: "SINTÉTICO", fecha: now(), cuerpo: "Prueba", adjuntos: ["contrato.txt"] }));
  await writeFile(join(folder, "contrato.txt"), "CONTRATO No. SYN-2030-REF\n\nEntre CLIENTE SINTÉTICO S.A., NIT 111.222.333-0, con domicilio en Colombia, y PERIFERIA IT GROUP S.A.S.\n\nPRIMERA. OBJETO. Servicio sintético.\n\nSEGUNDA. VALOR. Importe pendiente de aclaración.\n\nTERCERA. PLAZO. Desde 2030-01-01 hasta 2030-12-31.\n\nCUARTA. GARANTÍAS. No se requiere póliza.");
  let ticket = "";
  const registration = () => ({ type: "tools", calls: [call("contratos_registrar", { mensaje_id: "msg-sintetico", contrato_ref: ticket, confirmado: true })] });
  const provider = Object.assign(createMockProvider([
    { type: "tools", calls: [call("contratos_extraer", { mensaje_id: "msg-sintetico" })] },
    (request: ProviderRequest) => ({ type: "tools", calls: [call("contratos_validar", { mensaje_id: "msg-sintetico", contrato_ref: data(request).contrato_ref })] }),
    (request: ProviderRequest) => { ticket = z.uuid().parse(data(request).contrato_ref); return registration(); },
    { type: "final", text: "Registrado" }, registration, { type: "final", text: "No se reutilizó" },
  ]), { toolTransport: "references" as const });
  const agent = await createAgent({ directory, provider, now }); const id = agent.createSession(), other = agent.createSession();
  expect(unwrap(await agent.send(id, "Revisa")).status).toBe("review_required");
  const reviewer = { id: "analista-prueba", modo: "simulado_local" as const };
  const source = { justificacion: "Aclaración sintética", procedencia: "Acta de prueba" };
  const request = unwrap(await agent.prepareReview(id, { mensaje_id: "msg-sintetico", revisor: reviewer,
    correcciones: [{ campo: "valor", valor: 1500, ...source }, { campo: "moneda", valor: "USD", ...source }] }));
  const decision = { solicitud_id: request.solicitud_id, datos_hash: request.datos_hash, revisor: reviewer, accion: "aprobar" };
  expect((await agent.decideReview(other, decision)).ok).toBe(false);
  expect((await agent.decideReview(id, { ...decision, datos_hash: "0".repeat(64) })).ok).toBe(false);
  expect((await agent.decideReview(id, decision)).ok).toBe(true);
  expect(unwrap(await agent.send(id, "Ejecuta", { allowRegistration: true })).reply).toContain("registrado");
  expect(unwrap(await agent.send(id, "Repite", { allowRegistration: true })).status).toBe("tool_error");
  expect((await readFile(join(directory, "out/sharepoint/historial.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});
