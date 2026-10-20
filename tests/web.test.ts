import { afterEach, expect } from "bun:test";
import { Window } from "happy-dom";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHttpServer, type ServerOptions } from "../src/server.ts";
import { createMockProvider } from "../src/agent/mock-provider.ts";
import { createApi } from "../web/api.ts";
import { startApp } from "../web/app.ts";
import { renderMessages, renderReviews, renderTools } from "../web/render.ts";
import { integrationTests } from "./helpers/integration.ts";

const { test, waitForCompletion } = integrationTests();
type Server = Awaited<ReturnType<typeof startHttpServer>>;
const servers: Server[] = [], windows: Window[] = [], apps: ReturnType<typeof startApp>[] = [];
const final = (text = "Consulta simulada.") => ({ type: "final", text });
const env = { AGENT_PROVIDER: "mock", PORT: "0", AGENT_MAX_TOKENS: "60000" };
async function start(options: ServerOptions = {}) { const server = await startHttpServer({ env, ...options }); servers.push(server); return server; }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("La interfaz no alcanzó el estado esperado."); await Bun.sleep(10); }
}
// Transporte de pruebas: simula únicamente la cookie y el Origin que añade un navegador.
// La aplicación y su cliente HTTP se ejecutan sin cambios contra Bun.serve real.
function transport(server: Server) {
  const cookies = new Map<string, string>(), requests: { path: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    const headers = new Headers(init?.headers);
    headers.set("Origin", server.origin);
    const id = /^\/api\/sessions\/([^/]+)\//.exec(path)?.[1];
    if (id && cookies.has(id)) headers.set("Cookie", cookies.get(id)!);
    const response = await fetch(server.url + path, { ...init, headers });
    const cookie = response.headers.get("set-cookie");
    const owner = cookie && /Path=\/api\/sessions\/([^;]+)/.exec(cookie)?.[1];
    if (owner && cookie) cookies.set(owner, cookie.split(";")[0]!);
    return response;
  }) as typeof fetch;
  return { fetcher, requests };
}
async function mount(server: Server, fetcher = transport(server).fetcher) {
  const window = new Window({ url: server.url }); windows.push(window);
  window.document.body.innerHTML = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  Reflect.set(globalThis, "document", window.document);
  const app = startApp(window.document as unknown as Document, createApi(fetcher)); apps.push(app);
  await app.initialized;
  const get = (id: string) => window.document.getElementById(id)! as unknown as HTMLElement;
  const text = (id: string) => get(id).textContent ?? "";
  const input = window.document.getElementById("message") as unknown as HTMLTextAreaElement;
  function type(value: string) { input.value = value; input.dispatchEvent(new window.Event("input") as unknown as Event); }
  async function send(value: string) {
    type(value); get("chat-form").dispatchEvent(new window.Event("submit", { cancelable: true }) as unknown as Event);
    await until(() => get("chat-form").getAttribute("aria-busy") === "false");
  }
  return { window, get, text, input, type, send };
}
afterEach(async () => {
  await waitForCompletion();
  for (const app of apps.splice(0)) app.dispose();
  for (const window of windows.splice(0)) await window.happyDOM.close();
  Reflect.deleteProperty(globalThis, "document");
  for (const server of servers.splice(0)) {
    await server.stop();
    const directory = resolve(server.directory);
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("periferia-http-")) throw new Error("Temporal fuera del área de pruebas.");
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("Web HTML y recursos compilados con CSP, sin claves ni rutas arbitrarias", async () => {
  const secret = "FAKE_SERVER_KEY_NOT_FOR_BROWSER_123456";
  const server = await start({ env: { ...env, GEMINI_API_KEY: secret } });
  for (const [path, type] of [["/", "text/html"], ["/assets/styles.css", "text/css"], ["/assets/app.js", "text/javascript"]]) {
    const response = await fetch(server.url + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type!);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain("GoogleGenAI");
    expect(body).not.toContain(server.directory);
  }
  const html = await (await fetch(server.url)).text();
  expect(html).toContain('src="/assets/app.js"');
  expect(html).not.toContain('src="/web/app.ts"');
  expect((await fetch(server.url + "/assets/app.js.map")).status).toBe(404);
  expect((await fetch(server.url + "/web/api.ts")).status).toBe(404);
  expect((await fetch(server.url + "/.env")).status).toBe(404);
  expect((await fetch(server.url + "/assets/styles.css", { method: "HEAD" })).status).toBe(200);
});

test("Web crea sesión, mantiene CSRF en memoria y no envía al elegir sugerencia", async () => {
  const server = await start(), network = transport(server), ui = await mount(server, network.fetcher);
  expect(ui.text("connection-text")).toBe("Servicio disponible");
  expect(ui.text("session-label")).toContain("Conversación");
  expect(ui.get("mode-note").hidden).toBe(false);
  (ui.window.document.querySelector("[data-prompt]")! as unknown as HTMLButtonElement).click();
  expect(ui.input.value).toBe("¿Qué correos tenemos pendientes de procesar?");
  expect(network.requests.filter((request) => request.path.endsWith("/messages"))).toHaveLength(0);
  expect(ui.window.document.cookie).toBe("");
  expect(ui.window.localStorage.length).toBe(0);
  expect(ui.window.sessionStorage.length).toBe(0);
  await ui.send(ui.input.value);
  expect(ui.text("messages")).toContain("6 mensajes pendientes");
  expect(ui.text("tools")).toContain("contratos_leer_buzon");
  expect(ui.text("tool-count")).toBe("1");
  const post = network.requests.find((request) => request.path.endsWith("/messages"))!;
  expect(post.init?.credentials).toBe("same-origin");
  expect(new Headers(post.init?.headers).get("x-csrf-token")).toBeTruthy();
});

test("Web revisión real y bloqueo de registro visibles en guion MockProvider", async () => {
  const server = await start(), ui = await mount(server);
  await ui.send("Consulta el buzón");
  await ui.send("Revisa msg-006 e indica qué campos faltan");
  expect(ui.text("messages")).toContain("Pendiente de revisión");
  expect(ui.text("tool-count")).toBe("3");
  expect(ui.text("reviews")).toContain("CM-2026-03");
  expect(ui.text("reviews")).toContain("fecha_fin");
  expect(ui.text("reviews")).toContain("El plazo depende de la firma");
  expect(ui.get("reviews").querySelectorAll("details")).toHaveLength(1);
  expect(ui.get("reviews").querySelectorAll("button")).toHaveLength(0);
  await ui.send("Confirmo, registra msg-006");
  expect(ui.text("messages")).toContain("no habilitó registros");
  expect(ui.text("tools")).toContain("contratos_registrar");
  expect(ui.text("reviews")).not.toContain("maestro_hash");
  expect(ui.text("tools")).not.toContain("entrada_hash");
  expect(await readFile(resolve(server.directory, "out/sharepoint/historial.jsonl"), "utf8")).toBe("");
});

test("Web Enter envía; Shift+Enter permite salto de línea; consultas vacías no consumen proveedor", async () => {
  const server = await start({ provider: createMockProvider([final()]) }), network = transport(server), ui = await mount(server, network.fetcher);
  await ui.send("   ");
  expect(network.requests.filter((request) => request.path.endsWith("/messages"))).toHaveLength(0);
  ui.type("Prueba de teclado");
  const shift = new ui.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
  ui.input.dispatchEvent(shift as unknown as KeyboardEvent);
  expect(shift.defaultPrevented).toBe(false);
  const enter = new ui.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
  ui.input.dispatchEvent(enter as unknown as KeyboardEvent);
  expect(enter.defaultPrevented).toBe(true);
  await until(() => ui.text("messages").includes("Consulta simulada"));
  expect(network.requests.filter((request) => request.path.endsWith("/messages"))).toHaveLength(1);
});

test("Web deshabilita duplicados, nueva sesión y sugerencias durante el procesamiento", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const server = await start({ provider: { async send() { calls++; await gate; return final(); } } }), ui = await mount(server);
  ui.type("Larga");
  ui.get("chat-form").dispatchEvent(new ui.window.Event("submit", { cancelable: true }) as unknown as Event);
  ui.get("chat-form").dispatchEvent(new ui.window.Event("submit", { cancelable: true }) as unknown as Event);
  try {
    await until(() => calls === 1);
    expect(ui.input.disabled).toBe(true);
    expect(ui.get("new-session").hasAttribute("disabled")).toBe(true);
    expect(ui.get("processing").hidden).toBe(false);
    expect(ui.text("connection-text")).toBe("Procesando");
  } finally { release(); }
  await until(() => ui.text("messages").includes("Consulta simulada"));
  expect(calls).toBe(1);
});

test("Web actualizar conserva historial real y nueva conversación aísla todos los paneles", async () => {
  const server = await start(), ui = await mount(server);
  await ui.send("Uno");
  ui.get("refresh").click();
  await until(() => ui.get("chat-form").getAttribute("aria-busy") === "false");
  expect(ui.text("messages")).toContain("Uno");
  expect(ui.text("tools")).toContain("contratos_leer_buzon");
  const old = ui.text("session-label");
  ui.get("new-session").click();
  await until(() => ui.text("session-label") !== old);
  expect(ui.text("messages")).toBe("");
  expect(ui.text("tool-count")).toBe("0");
  expect(ui.text("review-count")).toBe("0");
  await ui.send("Dos");
  expect(ui.text("messages")).toContain("Dos");
  expect(ui.text("messages")).not.toContain("Uno");
});

test("Web sesión caducada conserva historial y requiere nueva conversación", async () => {
  let now = Date.now();
  const server = await start({ now: () => now, httpLimits: { sessionTtlMs: 1000 } }), ui = await mount(server);
  await ui.send("Uno"); now += 1100;
  await ui.send("Otra consulta");
  expect(ui.text("notice")).toContain("La sesión caducó");
  expect(ui.text("messages")).toContain("Uno");
  expect(ui.input.disabled).toBe(true);
  expect(ui.get("new-session").hasAttribute("disabled")).toBe(false);
});

test("Web límites HTTP comprensibles y error del proveedor visible como turno", async () => {
  const server = await start({ provider: createMockProvider([() => { throw new Error("stack privado"); }]),
    httpLimits: { sessionMessagesPerMinute: 1 } }), ui = await mount(server);
  await ui.send("Falla");
  expect(ui.text("messages")).toContain("El proveedor no respondió correctamente");
  expect(ui.text("messages")).not.toContain("stack privado");
  await ui.send("Otro intento");
  expect(ui.text("notice")).toContain("límite de solicitudes");
});

test("Web renderiza HTML no confiable como texto en chat, herramientas y revisiones", async () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  const server = await start({ provider: createMockProvider([final(payload)]) }), ui = await mount(server);
  await ui.send(payload);
  expect(ui.text("messages")).toContain(payload);
  expect(ui.get("messages").querySelectorAll("img,script")).toHaveLength(0);
  const tool = { type: "tool" as const, id: "x", name: payload, arguments: { mensaje_id: payload },
    result: { ok: true, summary: payload, data: { mensaje_id: "msg-006", id_contrato: payload, motivos: [payload] } } };
  renderTools(ui.get("tools") as unknown as HTMLElement, [tool]);
  renderReviews(ui.get("reviews") as unknown as HTMLElement, [{ mensaje_id: "msg-006", fields: [payload], status: "pending", channel: "trusted_local", canApprove: false }], [tool]);
  expect(ui.get("tools").querySelectorAll("img,script")).toHaveLength(0);
  expect(ui.get("reviews").querySelectorAll("img,script")).toHaveLength(0);
  expect(ui.text("tools")).toContain(payload);
});

test("Web etiqueta validación, rechazo y aplicación únicamente a partir de estados recibidos", async () => {
  const server = await start(), ui = await mount(server);
  renderTools(ui.get("tools") as unknown as HTMLElement, [
    { type: "tool", id: "v", name: "contratos_validar", arguments: {}, result: { ok: true, data: { estado_validacion: "validado" } } },
    { type: "tool", id: "r", name: "contratos_validar", arguments: {}, result: { ok: true, data: { clasificacion: "rechazado" } } },
    { type: "tool", id: "a", name: "contratos_registrar", arguments: {}, result: { ok: true, data: { accion: "registrado" } } },
  ]);
  expect(ui.text("tools")).toContain("Validado");
  expect(ui.text("tools")).toContain("Rechazado");
  expect(ui.text("tools")).toContain("Aplicado");
  renderMessages(ui.get("messages") as unknown as HTMLElement, [{ role: "assistant", content: "Incompleto", status: "incomplete" }]);
  expect(ui.text("messages")).toContain("Tarea incompleta");
});

test("Web error de red no reenvía automáticamente ni expone datos privados", async () => {
  const server = await start(), network = transport(server);
  let sends = 0;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/messages") && init?.method === "POST") { sends++; throw new Error("detalle privado de red"); }
    return network.fetcher(input, init);
  }) as typeof fetch;
  const ui = await mount(server, flaky);
  await ui.send("Hola");
  expect(sends).toBe(1);
  expect(ui.text("notice")).toContain("actualiza el historial antes de reenviar");
  expect(ui.text("notice")).not.toContain("detalle privado");
  expect(ui.input.disabled).toBe(false);
});
