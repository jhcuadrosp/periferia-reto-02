import { afterEach, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startHttpServer, type ServerOptions } from "../src/server.ts";
import { createMockProvider } from "../src/agent/mock-provider.ts";
import { providerError } from "../src/agent/provider-error.ts";
import type { ProviderRequest } from "../src/agent/provider.ts";
import { hashBytes } from "../src/storage/audit.ts";
import { integrationTests } from "./helpers/integration.ts";

const { test, waitForCompletion } = integrationTests();
type Server = Awaited<ReturnType<typeof startHttpServer>>;
type Client = { id: string; csrf: string; cookie: string };
const servers: Server[] = [];
const root = fileURLToPath(new URL("../", import.meta.url));
const env = { AGENT_PROVIDER: "mock", PORT: "0", AGENT_MAX_TOKENS: "60000" };
const envelope = z.object({ ok: z.boolean(), data: z.record(z.string(), z.unknown()).optional(), code: z.string().optional(), error: z.string().optional() });
const final = (text = "Respuesta simulada.") => ({ type: "final", text });
const call = (id: string, name: string, args: unknown) => ({ type: "tools", calls: [{ id, name, arguments: JSON.stringify(args) }] });
const decode = async (response: Response) => envelope.parse(await response.json());
function data(result: z.infer<typeof envelope>) { if (!result.data) throw new Error("Sin datos HTTP."); return result.data; }
async function start(options: ServerOptions = {}) { const server = await startHttpServer({ env, ...options }); servers.push(server); return server; }
function request(server: Server, path: string, method = "GET", body?: unknown, client?: Client, extra: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, { method, headers: { Origin: server.origin, "Content-Type": "application/json",
    ...(client ? { Cookie: client.cookie, "X-CSRF-Token": client.csrf } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function create(server: Server) {
  const response = await request(server, "/api/sessions", "POST", {});
  expect(response.status).toBe(201);
  const result = z.object({ sessionId: z.uuid(), csrfToken: z.string().length(43), expiresAt: z.iso.datetime() }).parse(data(await decode(response)));
  return { id: result.sessionId, csrf: result.csrfToken, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}
const send = (server: Server, client: Client, text: string) => request(server, `/api/sessions/${client.id}/messages`, "POST", { message: text }, client);
afterEach(async () => {
  await waitForCompletion();
  for (const server of servers.splice(0)) {
    await server.stop();
    const directory = resolve(server.directory);
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("periferia-http-")) throw new Error("Temporal fuera de la carpeta de pruebas.");
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("HTTP health sin credenciales ni rutas; cookie opaca, HttpOnly y SameSite", async () => {
  const server = await start();
  const health = await request(server, "/api/health");
  expect(health.status).toBe(200);
  expect(data(await decode(health))).toEqual({ status: "ok", provider: "mock", model: null, registrationEnabled: false });
  const response = await request(server, "/api/sessions", "POST", {});
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict");
  expect(cookie).toContain("Path=/api/sessions/");
  expect(cookie).not.toContain("Secure");
  const text = await response.text();
  expect(text).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
  expect(text).not.toContain(server.directory);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("HTTP mensaje, herramientas, eventos e historial reutilizan el runner", async () => {
  const server = await start(), client = await create(server);
  const response = await send(server, client, "Lee el buzón.");
  expect(response.status).toBe(200);
  const turn = data(await decode(response));
  expect(turn.status).toBe("final");
  expect(turn.tools).toEqual(["contratos_leer_buzon"]);
  expect(turn.reply).toContain("6 mensajes pendientes");
  const history = data(await decode(await request(server, `/api/sessions/${client.id}/messages`, "GET", undefined, client)));
  expect(z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).parse(history.messages)).toHaveLength(2);
  const events = data(await decode(await request(server, `/api/sessions/${client.id}/events`, "GET", undefined, client)));
  expect(z.array(z.object({ name: z.string() })).parse(events.events)[0]!.name).toBe("contratos_leer_buzon");
  expect(data(await decode(await request(server, `/api/sessions/${client.id}/reviews`, "GET", undefined, client))).reviews).toEqual([]);
  expect(await readFile(join(server.directory, "out/log.jsonl"), "utf8")).toContain("http_turno_finalizado");
});

test("HTTP sesiones independientes y credencial ajena rechazada en todos los recursos", async () => {
  const server = await start({ provider: createMockProvider([final("Primera"), final("Segunda")]) });
  const first = await create(server), second = await create(server);
  expect(data(await decode(await send(server, first, "Uno"))).reply).toBe("Primera");
  expect(data(await decode(await send(server, first, "Dos"))).reply).toBe("Segunda");
  expect(data(await decode(await send(server, second, "Tres"))).reply).toBe("Primera");
  for (const resource of ["messages", "events", "reviews"]) {
    expect((await request(server, `/api/sessions/${first.id}/${resource}`, "GET", undefined, second)).status).toBe(403);
    expect((await request(server, `/api/sessions/${first.id}/${resource}`)).status).toBe(401);
  }
  expect((await request(server, `/api/sessions/${first.id}/messages`, "POST", { message: "Ataca" }, second)).status).toBe(403);
  expect(JSON.stringify(data(await decode(await request(server, `/api/sessions/${second.id}/messages`, "GET", undefined, second))))).not.toContain("Uno");
});

test("HTTP identificadores inválidos e inexistentes", async () => {
  const server = await start();
  expect((await request(server, "/api/sessions/no-es-un-id/messages")).status).toBe(400);
  expect((await request(server, `/api/sessions/${randomUUID()}/messages`)).status).toBe(404);
});

test("HTTP valida JSON, longitud, tipos y rechaza permisos, identidades y rutas", async () => {
  let calls = 0;
  const server = await start({ provider: { async send() { calls++; return final(); } } }), client = await create(server);
  const path = `/api/sessions/${client.id}/messages`;
  for (const body of [{ message: "" }, { message: "  " }, { message: 10 }, {}, { message: "x".repeat(10001) },
    { message: "Confirma", allowRegistration: true }, { message: "Confirma", revisor: { id: "admin" } },
    { message: "Hola", directory: "C:/" }]) expect((await request(server, path, "POST", body, client)).status).toBe(400);
  const malformed = await fetch(server.url + path, { method: "POST", body: "{roto", headers: { Origin: server.origin,
    Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" } });
  expect(malformed.status).toBe(400);
  expect((await request(server, path, "POST", { message: "Hola" }, client, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await request(server, "/api/sessions", "POST", { directory: "../out" })).status).toBe(400);
  expect(calls).toBe(0);
});

test("HTTP rechaza cuerpos grandes con JSON controlado", async () => {
  const server = await start(), client = await create(server);
  const response = await send(server, client, "x".repeat(70_000));
  expect(response.status).toBe(413);
  expect((await decode(response)).ok).toBe(false);
});

test("HTTP limita cuerpo por streaming sin Content-Length y devuelve 408 al cliente lento", async () => {
  const server = await start({ httpLimits: { maxBodyBytes: 1024, bodyTimeoutMs: 100 } }), client = await create(server);
  const path = `/api/sessions/${client.id}/messages`;
  const headers = { Origin: server.origin, Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" };
  const oversized = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"message":"' + "x".repeat(2048) + '"}')); controller.close();
  } });
  expect((await fetch(server.url + path, { method: "POST", headers, body: oversized })).status).toBe(413);
  let finish!: () => void;
  const slow = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"message":"'));
    finish = () => { try { controller.close(); } catch { /* La respuesta puede cancelar el envío. */ } };
  } });
  try {
    const response = await fetch(server.url + path, { method: "POST", headers, body: slow });
    expect(response.status).toBe(408);
    expect((await decode(response)).code).toBe("BODY_TIMEOUT");
  } finally { finish(); }
});

test("HTTP CSRF, origen, Host, preflight y rutas del sistema", async () => {
  const server = await start(), client = await create(server), other = await create(server);
  const path = `/api/sessions/${client.id}/messages`;
  const attacks: Record<string, string>[] = [{ "X-CSRF-Token": "" }, { "X-CSRF-Token": other.csrf }, { Origin: "https://ajeno.example" },
    { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }, { Host: "ajeno.example" }];
  for (const extra of attacks)
    expect((await request(server, path, "POST", { message: "Hola" }, client, extra)).status).toBe(403);
  expect((await request(server, "/api/sessions", "POST", {}, undefined, { Origin: "https://ajeno.example" })).status).toBe(403);
  expect((await request(server, "/api/sessions", "OPTIONS")).status).toBe(405);
  for (const route of ["/.env", "/PRD.md", "/out/log.jsonl", "/fixtures/reto-02/maestro-contratos.csv", "/api/%2e%2e/.env",
    `/api/sessions/${client.id}/approve`, `/api/sessions/${client.id}/reviews/approve`]) {
    const response = await request(server, route, "GET", undefined, client);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
  expect((await request(server, `${path}?directory=../out`, "GET", undefined, client)).status).toBe(400);
  expect((await request(server, `/api/sessions/${client.id}/reviews`, "POST", {}, client)).status).toBe(405);
});

test("HTTP cookie Secure depende del origen HTTPS confiable", async () => {
  const server = await start({ env: { ...env, PUBLIC_ORIGIN: "https://contratos.example" } });
  const response = await request(server, "/api/sessions", "POST", {}, undefined, { Host: "contratos.example" });
  expect(response.status).toBe(201);
  expect(response.headers.get("set-cookie")).toContain("; Secure");
});

test("HTTP limita solicitudes por cliente y no confía en X-Forwarded-For", async () => {
  const server = await start({ httpLimits: { clientRequestsPerMinute: 2 } });
  expect((await request(server, "/api/health")).status).toBe(200);
  expect((await request(server, "/api/health")).status).toBe(200);
  const limited = await request(server, "/api/health", "GET", undefined, undefined, { "X-Forwarded-For": "8.8.8.8" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
});

test("HTTP limita creaciones y mensajes por sesión", async () => {
  const server = await start({ httpLimits: { creationsPerMinute: 1, sessionMessagesPerMinute: 1 } });
  const client = await create(server);
  expect((await request(server, "/api/sessions", "POST", {})).status).toBe(429);
  expect((await send(server, client, "Hola")).status).toBe(200);
  expect((await send(server, client, "Hola otra vez")).status).toBe(429);
});

test("HTTP caduca sesiones, libera proveedor y limita capacidad", async () => {
  let time = Date.now();
  const released: string[] = [];
  const server = await start({ httpLimits: { maxSessions: 1, sessionTtlMs: 1000 }, now: () => time,
    provider: { async send() { return final(); }, releaseSession(id) { released.push(id); } } });
  const client = await create(server);
  expect((await request(server, "/api/sessions", "POST", {})).status).toBe(503);
  time += 1001;
  expect((await request(server, `/api/sessions/${client.id}/messages`, "GET", undefined, client)).status).toBe(404);
  expect(released).toEqual([client.id]);
  expect((await create(server)).id).not.toBe(client.id);
});

test("HTTP creación simultánea respeta el cupo de sesiones", async () => {
  const server = await start({ httpLimits: { maxSessions: 1 } });
  const responses = await Promise.all([request(server, "/api/sessions", "POST", {}), request(server, "/api/sessions", "POST", {})]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 503]);
});

test("HTTP revalida caducidad después de recibir el cuerpo antes de consumir modelo", async () => {
  let time = Date.now(), calls = 0;
  const server = await start({ now: () => time, httpLimits: { sessionTtlMs: 1000 },
    provider: { async send() { calls++; return final(); } } });
  const client = await create(server);
  // La solicitud comienza a enviarse antes de caducar; el cuerpo termina de llegar después.
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"message":'));
    setTimeout(() => { time += 1001; controller.enqueue(new TextEncoder().encode('"Hola"}')); controller.close(); }, 20);
  } });
  const response = await fetch(`${server.url}/api/sessions/${client.id}/messages`, { method: "POST", body,
    headers: { Origin: server.origin, Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" } });
  expect(response.status).toBe(404);
  expect(calls).toBe(0);
});

test("HTTP preserva presupuesto de tokens y llamadas del runner", async () => {
  let calls = 0;
  const server = await start({ env: { ...env, AGENT_MAX_TOKENS: "5" }, provider: { async send() {
    calls++; return { ...final(), usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
  } } });
  const client = await create(server);
  expect(data(await decode(await send(server, client, "Hola"))).status).toBe("limit");
  expect(data(await decode(await send(server, client, "Repite"))).status).toBe("limit");
  expect(calls).toBe(1);
});

test("HTTP falla cerrado si no puede auditar el inicio; no consume proveedor", async () => {
  let calls = 0;
  const server = await start({ provider: { async send() { calls++; return final(); } } }), client = await create(server);
  // Sabotaje acotado al temporal propio: un directorio no puede usarse como archivo log.
  await rm(join(server.directory, "out/log.jsonl"));
  await mkdir(join(server.directory, "out/log.jsonl"));
  const response = await send(server, client, "Hola");
  expect(response.status).toBe(503);
  expect((await decode(response)).code).toBe("AUDIT_UNAVAILABLE");
  expect(calls).toBe(0);
});

test("HTTP concurrencia por sesión y global sin duplicar inferencias", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const server = await start({ httpLimits: { maxConcurrentTurns: 1 }, provider: { async send() { calls++; entered(); await gate; return final(); } } });
  const first = await create(server), second = await create(server);
  const pending = send(server, first, "Turno largo");
  await started;
  try {
    expect((await send(server, first, "Repite")).status).toBe(409);
    expect((await send(server, second, "Otro")).status).toBe(429);
    expect((await request(server, "/api/health")).status).toBe(200);
    expect(calls).toBe(1);
  } finally { release(); await pending; }
  expect((await send(server, second, "Ahora sí")).status).toBe(200);
});

test("HTTP timeout aborta respuesta tardía y permite otro turno", async () => {
  let calls = 0, signal: AbortSignal | undefined;
  let late!: (value: unknown) => void;
  const server = await start({ env: { ...env, AGENT_PROVIDER_TIMEOUT_MS: "30" }, provider: { async send(request) {
    if (++calls === 1) { signal = request.signal; return new Promise((resolve) => { late = resolve; }); }
    return final("Recuperado");
  } } });
  const client = await create(server);
  const response = await send(server, client, "Espera");
  expect(response.status).toBe(504);
  expect(data(await decode(response)).status).toBe("error");
  expect(signal?.aborted).toBe(true);
  late(call("tardio", "contratos_registrar", {}));
  const second = data(await decode(await send(server, client, "Continúa")));
  expect(second.reply).toBe("Recuperado");
  expect(second.tools).toEqual([]);
  expect(await readFile(join(server.directory, "out/sharepoint/historial.jsonl"), "utf8")).toBe("");
});

test("HTTP error de Gemini controlado sin clave ni traza y sesión recuperable", async () => {
  const server = await start({ provider: createMockProvider([() => { throw providerError("authentication"); }, final("Recuperado")]) });
  const client = await create(server), response = await send(server, client, "Hola");
  expect(response.status).toBe(502);
  expect(data(await decode(response)).reply).toContain("Gemini rechazó");
  expect(data(await decode(await send(server, client, "Reintenta"))).reply).toBe("Recuperado");
});

test("HTTP configuración Gemini inválida falla antes de escuchar, sin inferencia", async () => {
  await expect(startHttpServer({ env: { PORT: "0", AGENT_PROVIDER: "gemini" } })).rejects.toThrow("Falta configurar Gemini");
  for (const invalid of [{ PORT: "99999" }, { AGENT_PROVIDER: "desconocido" }, { PUBLIC_ORIGIN: "https://example.com/ruta" },
    { PUBLIC_ORIGIN: "https://usuario:secreto@example.com" }, { HOST: "0.0.0.0" }])
    await expect(startHttpServer({ env: { ...env, ...invalid } })).rejects.toThrow();
});

test("HTTP elimina secretos, rutas y metadatos privados de respuestas e historial", async () => {
  const secret = "FAKE_KEY_FOR_HTTP_TESTS_ONLY_123456";
  const server = await start({ env: { ...env, GEMINI_API_KEY: secret }, provider: createMockProvider([
    { ...final(`Texto ${secret} C:\\Users\\Privado\\.env`), provider_response_id: randomUUID() },
    () => { throw new Error(`stack ${secret} C:\\Users\\Privado\\.env`); },
  ]) });
  const client = await create(server);
  for (const response of [await send(server, client, "Hola"), await send(server, client, "Falla"),
    await request(server, `/api/sessions/${client.id}/messages`, "GET", undefined, client)]) {
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("C:\\\\Users");
    expect(text).not.toContain("provider_response_id");
    expect(text).not.toContain("stack");
  }
});

function lastData(request: ProviderRequest, name: string): Record<string, unknown> {
  const message = request.messages.filter((entry) => entry.role === "tool" && entry.name === name).at(-1);
  if (!message) throw new Error("Resultado ausente.");
  return z.object({ data: z.record(z.string(), z.unknown()) }).parse(JSON.parse(message.content)).data;
}
function plan(id: string) {
  return [call("extract", "contratos_extraer", { mensaje_id: id }),
    (request: ProviderRequest) => call("validate", "contratos_validar", { mensaje_id: id, contrato: lastData(request, "contratos_extraer") }),
    (request: ProviderRequest) => call("write", "contratos_registrar", { mensaje_id: id,
      contrato: lastData(request, "contratos_validar").contrato, confirmado: true }), final()];
}

test("HTTP revisión msg-006 visible con evidencias y sin tickets; confirmar por chat no autoriza", async () => {
  const server = await start({ provider: createMockProvider(plan("msg-006")) }), client = await create(server);
  const turn = data(await decode(await send(server, client, "Revisa msg-006 y dime qué falta para registrarlo")));
  expect(turn.status).toBe("review_required");
  expect(turn.tools).toEqual(["contratos_extraer", "contratos_validar"]);
  const reviews = data(await decode(await request(server, `/api/sessions/${client.id}/reviews`, "GET", undefined, client)));
  expect(z.array(z.object({ mensaje_id: z.literal("msg-006"), fields: z.array(z.string()), canApprove: z.literal(false) })).parse(reviews.reviews)[0]!.fields).toContain("valor");
  const events = await (await request(server, `/api/sessions/${client.id}/events`, "GET", undefined, client)).text();
  expect(events).toContain("evidencias");
  for (const hidden of ["maestro_hash", "entrada_hash", "datos_hash", "provider_response_id", '"contrato":']) expect(events).not.toContain(hidden);
  const forbidden = data(await decode(await send(server, client, "Confirmo, registra msg-006")));
  expect(forbidden.status).toBe("tool_error");
  expect(JSON.stringify(forbidden.errors)).toContain("no habilitó registros");
  expect(await readFile(join(server.directory, "out/sharepoint/historial.jsonl"), "utf8")).toBe("");
  expect(await readFile(join(server.directory, "out/procesados.json"), "utf8")).toBe("{}\n");
});

test("HTTP ni siquiera contrato limpio habilita registros; argumentos malformados son visibles sin fallar API", async () => {
  const steps = plan("msg-001");
  steps.splice(3, 0, { type: "tools", calls: [{ id: "bad-json", name: "contratos_leer_buzon", arguments: "{roto" }] });
  const server = await start({ provider: createMockProvider(steps) }), client = await create(server);
  const before = hashBytes(await readFile(join(server.directory, "out/sharepoint/maestro-contratos.csv")));
  const turn = data(await decode(await send(server, client, "Procesa")));
  expect(turn.status).toBe("tool_error");
  expect(JSON.stringify(turn)).toContain("no habilitó registros");
  expect(JSON.stringify(turn)).toContain("JSON válido");
  expect(hashBytes(await readFile(join(server.directory, "out/sharepoint/maestro-contratos.csv")))).toBe(before);
});

async function filesSnapshot(path: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file); else snapshot[file] = hashBytes(await readFile(file));
    }
  }
  for (const name of ["PRD.md", "AGENTS.md", "demo.ts", "bun.lock", ".env"]) {
    try { snapshot[name] = hashBytes(await readFile(join(path, name))); } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await walk(join(path, "fixtures"));
  try { await walk(join(path, "out")); } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return snapshot;
}

test("HTTP conserva PRD, AGENTS, fixtures, demo, lockfile, .env y out operativo", async () => {
  const before = await filesSnapshot(root);
  const server = await start({ provider: createMockProvider([call("alertas", "contratos_alertas", { hoy: "2026-09-03" }), final()]) });
  const client = await create(server);
  expect((await send(server, client, "Genera alertas")).status).toBe(200);
  expect(await readFile(join(server.directory, "out/alertas.md"), "utf8")).toContain("CT-2026-004");
  expect(await filesSnapshot(root)).toEqual(before);
});
