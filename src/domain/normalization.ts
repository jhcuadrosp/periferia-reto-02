import { dateSchema } from "./schemas.ts";

// Un separador único con tres cifras finales es ambiguo: no se adivina su escala.
export function normalizeAmount(text: string): number | null {
  const value = text.trim();
  let normalized: string;
  if (/^\d+$/.test(value)) normalized = value;
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(value)) normalized = value.replaceAll(",", "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(value)) normalized = value.replaceAll(".", "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3}){2,}$/.test(value)) normalized = value.replaceAll(".", "");
  else if (/^\d{1,3}(,\d{3}){2,}$/.test(value)) normalized = value.replaceAll(",", "");
  else if (/^\d+[.,]\d{1,2}$/.test(value)) normalized = value.replace(",", ".");
  else return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount * 100)) ? amount : null;
}

export function normalizeCurrency(text: string): "COP" | "USD" | "PEN" | "PAB" | "HNL" | null {
  const code = text.trim().toUpperCase();
  switch (code) {
    case "COP": case "USD": case "PEN": case "PAB": case "HNL": return code;
    default: return null;
  }
}

const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const days = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis",
  "veintisiete", "veintiocho", "veintinueve", "treinta", "treinta y uno"];

function writtenDay(text: string): number | null {
  const value = text.replaceAll(/\s+/g, " ");
  if (value === "primero") return 1;
  const index = days.indexOf(value);
  return index < 0 ? null : index + 1;
}

export function normalizeDate(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/^el\s+/, "");
  if (dateSchema.safeParse(value).success) return value;
  const match = value.match(/^(.+?)\s+de\s+([a-z]+)\s+de\s+(\d{4})$/u);
  if (!match) return null;
  const [, dayText, month, year] = match;
  const paired = dayText!.match(/^(.+?)\s+\((\d{1,2})\)$/);
  const day = paired ? Number(paired[2]) : /^\d{1,2}$/.test(dayText!) ? Number(dayText) : writtenDay(dayText!);
  if (day === null || (paired && writtenDay(paired[1]!) !== day)) return null;
  const monthIndex = months.indexOf(month!);
  if (monthIndex < 0) return null;
  const normalized = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return dateSchema.safeParse(normalized).success ? normalized : null;
}

export function normalizeTaxId(text: string, kind: "NIT" | "RUC"): string | null {
  const value = text.trim();
  if (kind === "NIT" && /^\d[\d.]*-\d$/.test(value)) return value.split("-")[0]!.replaceAll(".", "");
  return /^\d+$/.test(value) ? value : null;
}
