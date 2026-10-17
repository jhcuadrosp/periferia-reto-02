import { extractionSchema, type Extraction } from "./schemas.ts";
import { normalizeAmount, normalizeCurrency, normalizeDate, normalizeTaxId } from "./normalization.ts";

function field<T>(extraido: string | null, normalizado: T | null, confianza = 0.98, evidencia = extraido) {
  return { extraido, normalizado, confianza: extraido === null ? 0 : confianza, evidencia };
}

function emptyFields(): Extraction["campos"] {
  return {
    id_contrato: field(null, null), cliente: field(null, null), nit_cliente: field(null, null),
    pais: field(null, null), objeto: field(null, null), valor: field(null, null), moneda: field(null, null),
    fecha_inicio: field(null, null), fecha_fin: field(null, null), requiere_poliza: field(null, null),
    tipo_poliza: field(null, null), estado_poliza: field(null, null), comercial: field(null, null),
    ruta_sharepoint: field(null, null), fecha_registro: field(null, null), fuente: field(null, null),
  };
}

function extractParty(text: string, result: Extraction) {
  const match = text.match(/Entre\s+(?:los suscritos,\s*)?(.+?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC)\s+([\d.-]+)/i);
  if (!match) return;
  const [, client, identifierKind, identifier] = match;
  result.campos.cliente = field(client!.trim(), client!.trim(), 0.98, match[0]);
  const kind = identifierKind!.toUpperCase() as "NIT" | "RUC";
  const normalizedId = normalizeTaxId(identifier!, kind);
  result.campos.nit_cliente = field(identifier!, normalizedId, normalizedId ? 0.98 : 0.4, match[0]);
  // Se limita a la primera parte: el domicilio colombiano del contratista no define el país del cliente.
  const remainder = text.slice(match.index);
  const party = remainder.split(/,?\s+y\s+PERIFERIA|\r?\n\s*\r?\n/i)[0] ?? match[0];
  const countries = [["Ecuador", "EC"], ["Perú", "PE"], ["Panamá", "PA"], ["Honduras", "HN"], ["Colombia", "CO"]] as const;
  const mentions = [...party.matchAll(/\b(Ecuador|Perú|Panamá|Honduras|Colombia)(?!\p{L})/giu)];
  const distinctCountries = new Set(mentions.map((mention) => mention[1]!.toLowerCase()));
  // Sin país explícito e inequívoco del cliente no se aplica ninguna inferencia tributaria.
  if (distinctCountries.size === 1) {
    const mention = mentions[0]!;
    const country = countries.find(([name]) => name.toLowerCase() === mention[1]!.toLowerCase())!;
    result.campos.pais = field(mention[1]!, country[1], 0.98, party);
  }
}

function extractObject(text: string, paragraphs: string[], result: Extraction) {
  const paragraph = paragraphs.find((part) => /\bOBJETO\./i.test(part));
  const value = paragraph?.split(/\bOBJETO\.\s*/i)[1]?.trim()
    ?? text.match(/^Descripción:\s*(.+)$/im)?.[1]?.trim();
  if (!value) return;
  // La longitud del maestro se controla posteriormente; la extracción conserva todo el texto.
  result.campos.objeto = field(value, value, 0.98, paragraph ?? value);
}

function extractAmount(paragraph: string | undefined, result: Extraction) {
  if (!paragraph) return;
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(paragraph)) {
    result.valor_indeterminado = field(paragraph, true);
    // El cero del maestro es una futura convención de persistencia, no un valor documental.
    result.campos.valor = field(paragraph, null, 0.6);
    result.advertencias.push({ campo: "valor", tipo: "VALOR_INDETERMINADO",
      descripcion: "No hay un monto fijo. Se conserva null y la condición de valor indeterminado para revisión." });
    return;
  }
  const matches = [...paragraph.matchAll(/\b([A-Z]{3})\s*\$?\s*([\d][\d.,]*)\b/g)];
  const match = matches[0];
  if (!match) {
    result.campos.valor = field(paragraph, null, 0.4);
    result.advertencias.push({ campo: "valor", tipo: "IMPORTE_NO_INTERPRETADO", descripcion: "La cláusula de valor no contiene un importe numérico soportado." });
    return;
  }
  const currency = normalizeCurrency(match[1]!);
  const amount = normalizeAmount(match[2]!);
  if (new Set(matches.map((item) => `${item[1]}:${item[2]}`)).size > 1) {
    result.campos.valor = field(paragraph, null, 0.4);
    const oneCurrency = new Set(matches.map((item) => item[1])).size === 1;
    result.campos.moneda = field(paragraph, oneCurrency ? currency : null, oneCurrency && currency ? 0.98 : 0.4);
    result.advertencias.push({ campo: "valor", tipo: "IMPORTES_MULTIPLES", descripcion: "La cláusula contiene varios importes o monedas; no se elige uno automáticamente." });
    return;
  }
  const estimated = /estimad[oa]/i.test(paragraph);
  result.campos.moneda = field(match[1]!, currency, currency ? 0.98 : 0.4, paragraph);
  result.campos.valor = field(match[2]!, amount, amount === null ? 0.4 : estimated ? 0.65 : 0.98, paragraph);
  if (!currency) result.advertencias.push({ campo: "moneda", tipo: "MONEDA_DESCONOCIDA", descripcion: "El código de moneda no está contemplado por el PRD." });
  if (amount === null) result.advertencias.push({ campo: "valor", tipo: "IMPORTE_AMBIGUO", descripcion: "Los separadores o la precisión del importe no se pueden interpretar con seguridad." });
  if (estimated) result.advertencias.push({ campo: "valor", tipo: "VALOR_ESTIMADO", descripcion: "El importe está expresado como estimación de una oferta, no como valor contractual definitivo." });
}

function extractDates(paragraph: string | undefined, text: string, result: Extraction) {
  if (!paragraph) return;
  const start = paragraph.match(/desde\s+(?:el\s+)?(.+?)\s+hasta/i)?.[1]?.trim();
  const end = paragraph.match(/hasta\s+(?:el\s+)?([^\n".]+)/i)?.[1]?.trim();
  if (start) {
    const date = normalizeDate(start);
    result.campos.fecha_inicio = field(start, date, date ? 0.98 : 0.4, paragraph);
  }
  if (end) {
    const date = normalizeDate(end);
    result.campos.fecha_fin = field(end, date, date ? 0.98 : 0.4, paragraph);
  }
  const months = paragraph.match(/(?:\((\d+)\)|\b(\d+))\s+meses/i);
  if (months) {
    const count = Number(months[1] ?? months[2]);
    if (Number.isSafeInteger(count) && count > 0) result.plazo_meses = field(months[0], count, 0.98, paragraph);
  }
  if (/a partir de la fecha de su firma/i.test(paragraph) && !start) {
    const signature = text.match(/^Se firma[^\n]+/im)?.[0] ?? paragraph;
    result.campos.fecha_inicio = field(signature, null, 0.3);
    result.campos.fecha_fin = field(paragraph, null, 0.3);
    result.advertencias.push({ campo: "fecha_inicio", tipo: "FIRMA_SIN_FECHA_EXACTA",
      descripcion: "El plazo depende de la firma. No se calcula una fecha exacta ni se usa la fecha del correo." });
  }
}

function extractPolicy(paragraph: string | undefined, result: Extraction) {
  if (!paragraph) return;
  result.condicion_poliza = field(paragraph, paragraph);
  const negative = /no (?:se )?(?:requiere|exige|exigirá|requerirá)|sin obligación de/i.test(paragraph);
  const conditional = /para cada orden|cuyo valor|siempre que|si el valor|cuando el valor/i.test(paragraph);
  const explicit = /(?:constituirá|deberá constituir|se exige|se requiere)[\s\S]*póliza/i.test(paragraph);
  if (negative) {
    result.campos.requiere_poliza = field(paragraph, false);
    result.campos.tipo_poliza = field(paragraph, "");
    return;
  }
  const types = [
    ["cumplimiento", "cumplimiento"], ["responsabilidad civil", "responsabilidad_civil"],
    ["calidad", "calidad"], ["salarios", "salarios_prestaciones"],
  ].filter(([term]) => paragraph.toLowerCase().includes(term!)).map(([, type]) => type!);
  if (types.length) result.campos.tipo_poliza = field(paragraph, types.join(";"));
  if (conditional) {
    result.campos.requiere_poliza = field(paragraph, null, 0.4);
    result.advertencias.push({ campo: "requiere_poliza", tipo: "POLIZA_CONDICIONAL", descripcion: "La obligación depende de una condición; no se convierte automáticamente en sí o no." });
  } else if (explicit) result.campos.requiere_poliza = field(paragraph, true);
}

export function extractContract(text: string): Extraction {
  const header = text.trimStart().split(/\r?\n/)[0] ?? "";
  const tipo = /^OTROS[IÍ]/i.test(header) ? "otrosi" : /^COTIZACI[OÓ]N/i.test(header)
    ? "cotizacion" : /^CONTRATO\b/i.test(header) ? "contrato" : "desconocido";
  const result: Extraction = { tipo_documento: tipo, id_documento: field(null, null), campos: emptyFields(),
    valor_indeterminado: field(null, null), plazo_meses: field(null, null), condicion_poliza: field(null, null),
    campos_modificados: [], requiere_revision: [], advertencias: [] };
  if (!text.trim() || tipo === "desconocido") {
    result.advertencias.push({ campo: "$", tipo: text.trim() ? "TEXTO_NO_RECONOCIDO" : "TEXTO_VACIO",
      descripcion: "No se reconoce una estructura documental soportada; no se completan campos." });
    return extractionSchema.parse(result);
  }
  const paragraphs = text.split(/\r?\n\s*\r?\n/);
  const contractId = header.match(/CONTRATO[^\n]*?No\.\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/i)?.[1];
  if (contractId) result.campos.id_contrato = field(contractId, contractId, 0.98, header);
  const documentId = tipo === "otrosi" ? header.match(/^OTROS[IÍ]\s+No\.\s*(\d+)/i)?.[1]
    : tipo === "cotizacion" ? header.match(/No\.\s*(\S+)/i)?.[1] : contractId;
  if (documentId) result.id_documento = field(documentId, documentId, 0.98, header);

  if (tipo !== "otrosi") {
    extractParty(text, result);
    if (tipo === "cotizacion") {
      const client = text.match(/^Cliente:\s*(.+)$/im)?.[1]?.trim();
      if (client) result.campos.cliente = field(client, client);
    }
    extractObject(text, paragraphs, result);
  }
  // En un otrosí solo se leen las cláusulas que dicen expresamente Modificar.
  const value = tipo === "cotizacion" ? text.match(/^Valor total[^\n]+/im)?.[0]
    : paragraphs.find((part) => /\bVALOR[.:)]/i.test(part) && (tipo !== "otrosi" || /Modificar/i.test(part)));
  const duration = paragraphs.find((part) => /\bPLAZO[.:)]/i.test(part) && (tipo !== "otrosi" || /Modificar/i.test(part)));
  extractAmount(value, result);
  extractDates(duration, text, result);
  if (tipo !== "otrosi") extractPolicy(paragraphs.find((part) => /\bGARANT[IÍ]AS\b|\bP[OÓ]LIZAS?\b/i.test(part)), result);
  else {
    for (const key of ["valor", "moneda", "fecha_fin"] as const) {
      if (result.campos[key].extraido !== null) result.campos_modificados.push(key);
    }
    const guarantees = paragraphs.find((part) => /garantías/i.test(part) && /ampliarse/i.test(part));
    if (guarantees) result.condicion_poliza = field(guarantees, guarantees);
  }
  if (tipo === "contrato" && !result.condicion_poliza.extraido) {
    result.advertencias.push({ campo: "requiere_poliza", tipo: "SIN_EVIDENCIA_POLIZA",
      descripcion: "El TXT no declara una obligación de póliza ni su ausencia. No se deduce un false por falta de cláusula." });
  }
  const relevant = tipo === "otrosi" ? ["id_contrato", ...result.campos_modificados]
    : tipo === "contrato" ? ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]
    : ["cliente", "objeto", "valor", "moneda"];
  result.requiere_revision = relevant.filter((key) => {
    const data = result.campos[key as keyof Extraction["campos"]];
    return data.normalizado === null || data.confianza < 0.8;
  });
  return extractionSchema.parse(result);
}
