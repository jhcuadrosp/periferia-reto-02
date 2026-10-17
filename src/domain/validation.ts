import {
  extractionSchema, proposedContractSchema, validationSchema,
  type Commercial, type Extraction, type Mail, type MasterRecord, type ProposedContract, type Validation,
} from "./schemas.ts";

const threshold = 0.8;
type Field = keyof ProposedContract;
type Trace = Validation["evidencias"][Field];
type Work = { datos: ProposedContract; evidencias: Validation["evidencias"];
  revisiones: Map<string, string>; advertencias: Validation["advertencias"] };

const businessFields: Field[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza"];

function setField<K extends Field>(work: Work, key: K, value: ProposedContract[K], trace: Trace) {
  work.datos[key] = value;
  work.evidencias[key] = trace;
}

function review(work: Work, field: string, reason: string) {
  const previous = work.revisiones.get(field);
  work.revisiones.set(field, previous ? `${previous} ${reason}` : reason);
}

function warn(work: Work, campo: string, tipo: string, descripcion: string) {
  work.advertencias.push({ campo, tipo, descripcion });
}

function normalizeText(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// RN2 no fija métrica. Jaccard compara conjuntos de palabras normalizadas, entre 0 y 1.
export function objectSimilarity(left: string, right: string): number {
  const a = new Set(normalizeText(left).split(" ").filter(Boolean));
  const b = new Set(normalizeText(right).split(" ").filter(Boolean));
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter((word) => b.has(word)).length / union.size : 0;
}

function findMatches(extraction: Extraction, master: MasterRecord[]) {
  const fields = extraction.campos;
  const byId = master.filter((row) => fields.id_contrato.normalizado !== null && row.id_contrato === fields.id_contrato.normalizado);
  if (byId.length) return { rows: byId, rule: "identificador" };
  const byContent = fields.nit_cliente.confianza >= threshold && fields.objeto.confianza >= threshold
    ? master.filter((row) => row.nit_cliente === fields.nit_cliente.normalizado &&
      fields.objeto.normalizado !== null && objectSimilarity(row.objeto, fields.objeto.normalizado) >= 0.9) : [];
  return { rows: byContent, rule: "nit_cliente + similitud de objeto >= 0.9 (Jaccard)" };
}

function inheritMaster(work: Work, base: MasterRecord) {
  work.datos = { ...base };
  for (const key of Object.keys(base) as Field[]) work.evidencias[key] = {
    origen: "maestro", confianza: 1, evidencia: `${base.id_contrato}.${key} = ${String(base[key])}`,
    regla: "RN2: conservar campos existentes salvo modificación documentada",
  };
}

function applyDocument(work: Work, extraction: Extraction, keys: Field[]) {
  for (const key of keys) {
    const field = extraction.campos[key];
    if (field.extraido === null) {
      if (extraction.tipo_documento === "otrosi") review(work, key, "El cambio declarado no tiene evidencia documental extraída.");
      continue;
    }
    if (field.confianza < threshold || field.normalizado === null) review(work, key, "Dato documental ambiguo o de confianza inferior a 0.8.");
    // Un cambio no interpretable nunca borra el dato original de un otrosí.
    if (field.normalizado !== null) setField(work, key, field.normalizado, {
      origen: "documento", confianza: field.confianza, evidencia: field.evidencia, regla: "RN2: cambio documental explícito",
    });
  }
}

function enrichCountry(work: Work, extraction: Extraction, master: MasterRecord[]) {
  if (extraction.campos.nit_cliente.confianza < threshold || !work.datos.nit_cliente) return;
  const rows = master.filter((row) => row.nit_cliente === work.datos.nit_cliente);
  const countries = new Set(rows.map((row) => row.pais));
  if (!rows.length) return;
  if (work.datos.pais === null && countries.size === 1 && extraction.campos.pais.extraido === null) {
    setField(work, "pais", rows[0]!.pais, { origen: "maestro", confianza: 1,
      evidencia: `Cliente ${work.datos.nit_cliente}; contratos ${rows.map((row) => row.id_contrato).join(", ")}; país ${rows[0]!.pais}`,
      regla: "PRD 7.2: complementar país por identidad tributaria coincidente y país uniforme en el maestro; no por el prefijo NIT" });
  } else if (countries.size > 1 || (work.datos.pais !== null && !countries.has(work.datos.pais))) {
    review(work, "pais", "El país del cliente entra en conflicto con el maestro o no es uniforme entre sus registros.");
  }
}

function enrichPolicy(work: Work, extraction: Extraction, mail: Mail, isNew: boolean) {
  // El correo solo complementa una ausencia, nunca elimina una condición o contradicción documental.
  const negative = /\bno\s+(?:pide|requiere|exige)\s+(?:una\s+)?póliza\b/i.test(mail.cuerpo);
  const positiveText = mail.cuerpo.replace(/\bno\s+(?:pide|requiere|exige)\s+(?:una\s+)?póliza\b/gi, "");
  const positive = /\b(?:pide|requiere|exige)\s+(?:una\s+)?póliza\b/i.test(positiveText);
  const conditional = /\b(?:si|cuando)\b|por orden|para cada|supere/i.test(mail.cuerpo);
  const asserted = !conditional && positive !== negative ? positive : null;
  const documentPolicy = extraction.campos.requiere_poliza;
  if ((positive && negative) || (asserted !== null && documentPolicy.normalizado !== null && asserted !== documentPolicy.normalizado)) {
    review(work, "requiere_poliza", "El correo contradice la obligación documental o contiene afirmaciones incompatibles.");
  }
  if (documentPolicy.extraido === null && work.datos.requiere_poliza === null && asserted !== null) {
    setField(work, "requiere_poliza", asserted, { origen: "correo", confianza: 0.9,
      evidencia: mail.cuerpo, regla: "PRD 7.2: declaración explícita de póliza en el correo, sin condición" });
  }
  if (work.datos.requiere_poliza === false && work.datos.tipo_poliza === null) {
    setField(work, "tipo_poliza", "", { origen: "regla", confianza: 1,
      evidencia: "requiere_poliza = false", regla: "PRD 7.2: tipo vacío cuando no requiere póliza" });
  }
  if (isNew && work.datos.requiere_poliza !== null) {
    setField(work, "estado_poliza", work.datos.requiere_poliza ? "pendiente" : "no_aplica", {
      origen: "regla", confianza: 1, evidencia: `requiere_poliza = ${work.datos.requiere_poliza}`,
      regla: "PRD 7.2: póliza de nuevo contrato pendiente; sin póliza no aplica",
    });
  }
}

function checkRequired(work: Work, extraction: Extraction) {
  const required: Field[] = ["cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"];
  if (extraction.campos.id_contrato.extraido !== null) required.push("id_contrato");
  if (work.datos.requiere_poliza === true) required.push("tipo_poliza");
  for (const key of required) {
    const value = work.datos[key];
    if (value === null || (typeof value === "string" && !value.trim())) review(work, key, "Falta información esencial para el registro.");
    else if (work.evidencias[key].confianza < threshold) review(work, key, "Confianza inferior a 0.8.");
  }
  if (work.datos.objeto && work.datos.objeto.length > 200) review(work, "objeto", "El objeto íntegro excede 200 caracteres; adaptar al maestro requiere revisión sin perder el original.");
  if (work.datos.fecha_inicio && work.datos.fecha_fin && work.datos.fecha_fin < work.datos.fecha_inicio) {
    review(work, "fecha_fin", "La fecha final es anterior a la inicial.");
  }
  if (work.datos.requiere_poliza === false && work.datos.tipo_poliza) review(work, "tipo_poliza", "Hay tipo de póliza aunque no se requiere.");
  if (work.datos.requiere_poliza === (work.datos.estado_poliza === "no_aplica")) review(work, "estado_poliza", "Estado de póliza incoherente con su obligación.");
}

export function validateContract(extracted: Extraction | null, mail: Mail, master: MasterRecord[], commercials: Commercial[]): Validation {
  const extraction = extracted === null ? null : extractionSchema.parse(extracted);
  const fields = extraction?.campos;
  const keys = Object.keys(proposedContractSchema.shape) as Field[];
  const work: Work = {
    datos: proposedContractSchema.parse(Object.fromEntries(keys.map((key) => [key, fields?.[key].normalizado ?? null]))),
    evidencias: Object.fromEntries(keys.map((key) => [key, {
      origen: fields?.[key].extraido != null ? "documento" : "pendiente",
      confianza: fields?.[key].confianza ?? 0, evidencia: fields?.[key].evidencia ?? null, regla: null,
    }])) as Validation["evidencias"],
    revisiones: new Map(), advertencias: [...(extraction?.advertencias ?? [])],
  };
  const sender = commercials.filter((row) => row.email.toLowerCase() === mail.de.toLowerCase());
  const commercial = sender.length === 1 ? sender[0]!.nombre : null;
  if (!sender.length) warn(work, "comercial", "REMITENTE_DESCONOCIDO", `El remitente ${mail.de} no está en el catálogo; no bloquea por sí solo (HU-3).`);
  if (sender.length > 1) review(work, "comercial", "El catálogo contiene más de una coincidencia para el remitente.");
  let operation: Validation["tipo_operacion"] = "nuevo";
  let base: MasterRecord | undefined;
  const reasons: string[] = [];

  if (!mail.adjuntos.length || !extraction || extraction.tipo_documento === "cotizacion" || extraction.tipo_documento === "desconocido" ||
    (extraction.tipo_documento === "contrato" && !fields?.cliente.normalizado && !fields?.objeto.normalizado)) {
    operation = "rechazado";
    reasons.push(extraction?.tipo_documento === "cotizacion" ? "RN4: el adjunto es una cotización, no un contrato."
      : "RN4: no hay adjunto contractual interpretable con partes u objeto identificables.");
  } else {
    const matches = findMatches(extraction, master);
    if (matches.rows.length > 1) {
      operation = "actualizacion";
      review(work, "contrato_base", `Coincidencia ambigua: ${matches.rows.map((row) => row.id_contrato).join(", ")}. No se selecciona una fila.`);
      reasons.push(`RN2: posibles coincidencias por ${matches.rule}; requiere identificar la base.`);
    } else {
      base = matches.rows[0];
      // RN1 tiene precedencia para contratos ordinarios. Otrosí explícito aplica RN2.
      const duplicate = base && extraction.tipo_documento !== "otrosi" && base.id_contrato === fields?.id_contrato.normalizado &&
        (["valor", "fecha_inicio", "fecha_fin"] as const).every((key) => fields?.[key].normalizado !== null && fields?.[key].normalizado === base![key]);
      if (duplicate) {
        operation = "duplicado";
        reasons.push("RN1: mismo identificador, valor, fecha inicial y fecha final; no se propone ninguna modificación.");
        for (const key of ["cliente", "nit_cliente", "moneda", "pais", "requiere_poliza", "tipo_poliza"] as const) {
          const value = fields![key].normalizado;
          const equivalent = key === "cliente" && typeof value === "string" && normalizeText(value) === normalizeText(base!.cliente);
          if (value !== null && value !== base![key] && !equivalent) {
            review(work, key, "RN1 coincide, pero hay contradicción con el maestro en este campo.");
            warn(work, key, "CONFLICTO_DUPLICADO", `RN1 se conserva: ${key} en maestro=${String(base![key])}; documento=${String(value)}. No se propone modificación.`);
          }
        }
        for (const key of ["id_contrato", "valor", "fecha_inicio", "fecha_fin"] as const) {
          if (fields![key].confianza < threshold) review(work, key, "La coincidencia RN1 contiene un campo de confianza inferior a 0.8.");
        }
      } else if (base) {
        operation = "actualizacion";
        reasons.push(`RN2: contrato existente identificado por ${matches.rule}${extraction.tipo_documento === "otrosi" ? "; otrosí explícito" : "; datos distintos"}.`);
        inheritMaster(work, base);
        const modified: Field[] = extraction.tipo_documento === "otrosi" ? extraction.campos_modificados : businessFields;
        applyDocument(work, extraction, modified);
        if (fields!.id_contrato.confianza < threshold && fields!.id_contrato.extraido !== null) review(work, "id_contrato", "La referencia contractual tiene baja confianza.");
        if (fields!.id_contrato.normalizado !== null && fields!.id_contrato.normalizado !== base.id_contrato) review(work, "id_contrato", "Coincide el NIT y el objeto, pero el identificador documental difiere. No se renombra la fila.");
        if (fields!.nit_cliente.normalizado !== null && fields!.nit_cliente.normalizado !== base.nit_cliente) review(work, "nit_cliente", "El identificador contractual apunta a un cliente tributario diferente.");
        if (extraction.tipo_documento === "otrosi" && !extraction.campos_modificados.length) review(work, "campos_modificados", "No se han podido identificar cambios expresos soportados del otrosí.");
        if (extraction.condicion_poliza.normalizado && /ampliarse/i.test(extraction.condicion_poliza.normalizado)) warn(work, "estado_poliza", "AMPLIAR_GARANTIAS", "El otrosí exige ampliar garantías; el estado vigente existente no acredita esa ampliación y se conserva sin inventar un estado nuevo.");
      } else if (extraction.tipo_documento === "otrosi") {
        operation = "actualizacion";
        review(work, "contrato_base", "El otrosí requiere localizar el contrato original antes de proponer una actualización válida.");
        reasons.push("RN2: otrosí con contrato base no localizado; actualización bloqueada.");
      } else reasons.push("RN3: documento contractual sin coincidencia de ID ni de NIT y objeto en el maestro.");
    }

    if (operation === "nuevo" || operation === "actualizacion") {
      if (operation === "nuevo") {
        if (commercial) setField(work, "comercial", commercial, { origen: "catalogo", confianza: 1,
          evidencia: `${mail.de} -> ${commercial}`, regla: "HU-3: resolver comercial por correo del remitente" });
        setField(work, "fuente", "buzon", { origen: "regla", confianza: 1,
          evidencia: `Correo ${mail.id}`, regla: "PRD 7.2: canal de recepción buzón" });
      }
      enrichCountry(work, extraction, master);
      enrichPolicy(work, extraction, mail, operation === "nuevo");
      checkRequired(work, extraction);
      if (extraction.valor_indeterminado.normalizado === true) review(work, "valor", "El valor es indeterminado; la conversión a 0 del maestro pertenece a persistencia y requiere revisión previa.");
    }
  }

  const canPropose = operation === "nuevo" || operation === "actualizacion";
  const differences: Validation["diferencias"] = [];
  if (operation === "actualizacion" && base) {
    for (const key of businessFields) {
      if (base[key] !== work.datos[key]) differences.push({ campo: key, anterior: base[key], propuesto: work.datos[key] });
    }
  }
  return validationSchema.parse({
    mensaje_id: mail.id, id_contrato: base?.id_contrato ?? work.datos.id_contrato,
    id_contrato_existente: base?.id_contrato ?? null, tipo_operacion: operation,
    estado_validacion: work.revisiones.size ? "pendiente_revision" : canPropose ? "validado" : "no_aplica",
    elegible_registro: canPropose && work.revisiones.size === 0,
    requiere_revision: [...work.revisiones.keys()], motivos: [...reasons, ...[...work.revisiones].map(([field, reason]) => `${field}: ${reason}`)],
    campos_pendientes: canPropose ? keys.filter((key) => work.datos[key] === null) : [],
    datos_propuestos: canPropose ? work.datos : null, diferencias: differences,
    valor_indeterminado: extraction?.valor_indeterminado.normalizado ?? null,
    comercial_remitente: commercial, advertencias: work.advertencias, evidencias: work.evidencias,
  });
}
