import { ApiError, createApi, type ChatMessage, type PublicEvent, type Review } from "./api.ts";
import { renderMessages, renderReviews, renderTools } from "./render.ts";

export function startApp(root: Document = document, api = createApi()) {
  function element<T extends HTMLElement>(id: string) { const result = root.getElementById(id); if (!result) throw new Error(`Falta el elemento ${id}.`); return result as T; }
  const input = element<HTMLTextAreaElement>("message"), send = element<HTMLButtonElement>("send"), form = element<HTMLFormElement>("chat-form");
  const newButton = element<HTMLButtonElement>("new-session"), refresh = element<HTMLButtonElement>("refresh");
  const notice = element("notice"), connection = element("connection"), connectionText = element("connection-text"), scroll = element("chat-scroll");
  let messages: ChatMessage[] = [], events: PublicEvent[] = [], reviews: Review[] = [];
  let ready = false, busy = false, expiresAt = 0, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const suggestions = [...root.querySelectorAll<HTMLButtonElement>("[data-prompt]")];
  function controls() {
    input.disabled = !ready || busy;
    send.disabled = !ready || busy || !input.value.trim() || input.value.trim().length > 10_000;
    newButton.disabled = busy;
    refresh.disabled = !ready || busy;
    suggestions.forEach((button) => { button.disabled = !ready || busy; });
    element("processing").hidden = !busy;
    form.setAttribute("aria-busy", String(busy));
    element("character-count").textContent = `${input.value.length} / 10000`;
  }
  function status(text: string, state: "ready" | "processing" | "error" = "ready") { connectionText.textContent = text; connection.dataset.state = state; }
  function inform(text: string) { notice.textContent = text; notice.hidden = !text; }
  function expired() { ready = false; status("Sesión caducada", "error"); inform("La sesión caducó. Inicia una nueva conversación para continuar; el historial visible se conserva hasta entonces."); controls(); }
  function draw() {
    renderMessages(element("messages"), messages);
    const count = renderTools(element("tools"), events);
    renderReviews(element("reviews"), reviews, events);
    element("tool-count").textContent = element("tools-badge").textContent = String(count);
    element("review-count").textContent = element("reviews-badge").textContent = String(reviews.length);
    element("welcome").hidden = messages.length > 0;
    scroll.scrollTop = messages.length ? scroll.scrollHeight : 0;
  }
  function failure(error: unknown) {
    if (error instanceof ApiError && error.sessionLost) { expired(); return; }
    inform(error instanceof ApiError ? error.message : "No se pudo completar la operación. Actualiza el historial para comprobar su resultado.");
    status("Error de conexión", "error");
  }
  async function newConversation() {
    if (busy) return;
    busy = true; inform(""); status("Conectando…", "processing"); controls();
    try {
      const health = await api.health();
      element("provider-label").textContent = health.provider === "gemini" ? "Google Gemini" : "Proveedor simulado";
      const mode = element("mode-note"); mode.hidden = health.provider !== "mock";
      mode.textContent = "Modo simulado · Guion fijo por conversación: 1. buzón; 2. revisión de msg-006; 3. intento de registro bloqueado. No interpreta el texto de las preguntas.";
      const session = await api.newSession();
      messages = []; events = []; reviews = []; ready = true; input.value = "";
      expiresAt = Date.parse(session.expiresAt);
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(expired, Math.max(0, expiresAt - Date.now()));
      element("session-label").textContent = `Conversación ${session.sessionId.slice(0, 8)} · sesión temporal`;
      status("Servicio disponible"); draw();
    } catch (error) { failure(error); }
    finally { busy = false; controls(); if (ready) input.focus({ preventScroll: true }); }
  }
  async function synchronize() {
    if (busy || !ready) return;
    busy = true; inform(""); status("Actualizando…", "processing"); controls();
    try {
      const snapshot = await api.snapshot();
      messages = snapshot.messages; events = snapshot.events; reviews = snapshot.reviews;
      draw(); status("Servicio disponible");
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  async function submit() {
    if (busy || !ready) return;
    if (Date.now() >= expiresAt) { expired(); return; }
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 10_000) { inform("La consulta no puede superar los 10000 caracteres."); return; }
    busy = true; inform(""); input.value = ""; messages.push({ role: "user", content: text });
    status("Procesando", "processing"); draw(); controls(); scroll.scrollTop = scroll.scrollHeight;
    try {
      const turn = await api.send(text);
      messages.push({ role: "assistant", content: turn.reply, status: turn.status });
      events.push(...turn.events); reviews = turn.reviews; draw();
      status(turn.status === "error" ? "Error del servicio" : "Servicio disponible", turn.status === "error" ? "error" : "ready");
      if (turn.status === "limit") inform("Se alcanzó un límite del agente. Revisa los resultados y abre una nueva conversación si necesitas continuar.");
    } catch (error) { failure(error); }
    finally { busy = false; if (Date.now() >= expiresAt) expired(); controls(); if (ready) input.focus({ preventScroll: true }); }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
  input.addEventListener("input", controls);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  newButton.addEventListener("click", () => { void newConversation(); });
  refresh.addEventListener("click", () => { void synchronize(); });
  suggestions.forEach((button) => button.addEventListener("click", () => {
    if (!ready || busy) return;
    input.value = button.dataset.prompt ?? ""; controls(); input.focus({ preventScroll: true });
  }));
  const initialized = newConversation();
  return { initialized, dispose() { if (expiryTimer) clearTimeout(expiryTimer); } };
}

if (typeof document !== "undefined" && document.getElementById("chat-form")) startApp();
