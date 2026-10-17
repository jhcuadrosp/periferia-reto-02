import { extname } from "node:path";
import { masterColumns, masterRecordSchema, type MasterRecord, type Validation } from "./schemas.ts";

export function safeSegment(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new Error("Identificador no seguro para un nombre de archivo.");
  }
  return value;
}

function clientSlug(value: string): string {
  return safeSegment(value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
}

function automaticId(year: string, master: MasterRecord[]) {
  const prefix = `AUTO-${year}-`;
  const numbers = master.map((row) => row.id_contrato.startsWith(prefix) ? row.id_contrato.slice(prefix.length) : "")
    .filter((value) => /^\d+$/.test(value)).map(Number);
  const next = Math.max(0, ...numbers) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Secuencia AUTO fuera de rango.");
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export function rawRecord(record: MasterRecord): Record<string, string> {
  return Object.fromEntries(masterColumns.map((key) => [key, String(record[key as keyof MasterRecord])]));
}

export function prepareRegistration(validation: Validation, master: MasterRecord[], attachment: string, date: string, sender: string,
  valueTreatment?: "indeterminado_como_cero") {
  if (!validation.elegible_registro || validation.estado_validacion !== "validado" ||
    validation.requiere_revision.length || !validation.datos_propuestos ||
    !["nuevo", "actualizacion"].includes(validation.tipo_operacion)) throw new Error("La operación no es elegible para registro.");
  // Esto prepara una representación; la autorización de escritura se comprueba aparte en persistencia.
  if (validation.valor_indeterminado === true && (valueTreatment !== "indeterminado_como_cero" || validation.datos_propuestos.valor !== 0)) {
    throw new Error("Valor indeterminado: requiere tratamiento humano explícito y autorización controlada.");
  }
  const proposed = { ...validation.datos_propuestos };
  const original = master.find((row) => row.id_contrato === validation.id_contrato_existente);
  const extension = extname(attachment).toLowerCase();
  if (extension !== ".txt") throw new Error("Solo se archivan adjuntos TXT verificados en esta fase.");
  if (!proposed.fecha_inicio || !proposed.cliente) throw new Error("Falta inicio o cliente para preparar el archivo.");
  const id = validation.tipo_operacion === "nuevo" ? proposed.id_contrato ?? automaticId(proposed.fecha_inicio.slice(0, 4), master)
    : original?.id_contrato;
  if (!id) throw new Error("El contrato original ya no existe.");
  safeSegment(id);
  safeSegment(validation.mensaje_id);
  const folder = `Contratos/${proposed.fecha_inicio.slice(0, 4)}/${clientSlug(proposed.cliente)}`;
  const archive = validation.tipo_operacion === "nuevo" ? `${folder}/${id}${extension}`
    : `${folder}/otrosies/${validation.mensaje_id}/${id}${extension}`;
  let final: Record<string, unknown>;
  if (validation.tipo_operacion === "nuevo") {
    if (master.some((row) => row.id_contrato === id)) throw new Error("El identificador ya existe; se debe volver a validar.");
    final = { ...proposed, id_contrato: id, fecha_registro: date, ruta_sharepoint: archive,
      // HU-3: remitente desconocido no bloquea. Se conserva su email verificable, sin inventar un nombre.
      comercial: proposed.comercial ?? sender };
  } else {
    if (!original) throw new Error("Contrato base inexistente.");
    final = { ...original };
    for (const difference of validation.diferencias) {
      if (["id_contrato", "ruta_sharepoint", "fecha_registro", "fuente", "comercial"].includes(difference.campo)) {
        throw new Error("La actualización intenta cambiar una propiedad no autorizada.");
      }
      if (original[difference.campo] !== difference.anterior || difference.propuesto === null) {
        throw new Error("La diferencia no coincide con el contrato original.");
      }
      final[difference.campo] = difference.propuesto;
    }
  }
  for (const key of masterColumns) if (final[key] === null || final[key] === undefined) throw new Error(`Campo obligatorio pendiente: ${key}.`);
  const record = masterRecordSchema.parse(Object.fromEntries(masterColumns.map((key) => [key, String(final[key])])));
  return { record, archive, original: original ?? null,
    derivados: validation.tipo_operacion === "nuevo" ? {
      id_contrato: record.id_contrato, fecha_registro: record.fecha_registro, ruta_sharepoint: record.ruta_sharepoint,
      comercial: record.comercial, comercial_catalogado: validation.comercial_remitente !== null,
      comercial_origen: proposed.comercial !== null ? validation.evidencias.comercial.origen : "correo",
      comercial_evidencia: proposed.comercial !== null ? validation.evidencias.comercial.evidencia : sender,
      regla_comercial: "HU-3: catálogo, corrección humana documentada o email verificable del remitente; no se inventa un nombre",
    } : null };
}
