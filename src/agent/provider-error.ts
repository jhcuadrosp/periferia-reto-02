import { providerUsageSchema } from "./provider.ts";

const errors = {
  configuration: "Falta configurar Gemini: revisa GEMINI_API_KEY, GEMINI_MODEL y los límites.",
  authentication: "Gemini rechazó la credencial o sus permisos. Revisa tu API Key localmente.",
  model: "El modelo Gemini no existe o no está disponible para esta clave.",
  quota: "Gemini informó cuota agotada o demasiadas solicitudes (429). Inténtalo después.",
  temporary: "Gemini no está disponible temporalmente. No se reintentó la operación automáticamente.",
  timeout: "Se agotó el tiempo de espera de Gemini. No se ejecutarán herramientas de esa respuesta.",
  empty: "Gemini devolvió una respuesta vacía.",
  incomplete: "Gemini devolvió una respuesta incompleta; no se ejecutaron sus llamadas.",
  blocked: "Gemini bloqueó la respuesta por sus filtros de contenido.",
  invalid_call: "Gemini devolvió una llamada con formato inválido.",
  history: "El historial de Gemini no es consistente. Inicia una nueva sesión.",
  metrics: "No se pudieron registrar las métricas del proveedor; revisa la auditoría.",
  unexpected: "No se pudo completar la solicitud a Gemini.",
} as const;
export type ProviderErrorCode = keyof typeof errors;
export function providerError(code: ProviderErrorCode, usage?: unknown) {
  const parsed = providerUsageSchema.safeParse(usage);
  return Object.assign(new Error(errors[code]), { providerCode: code, ...(parsed.success ? { usage: parsed.data } : {}) });
}
export function providerErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "providerCode" in error && typeof error.providerCode === "string" && Object.hasOwn(errors, error.providerCode)) {
    return errors[error.providerCode as ProviderErrorCode];
  }
  return undefined;
}
export function providerErrorUsage(error: unknown) {
  if (!providerErrorMessage(error) || !error || typeof error !== "object" || !("usage" in error)) return undefined;
  const parsed = providerUsageSchema.safeParse(error.usage);
  return parsed.success ? parsed.data : undefined;
}
