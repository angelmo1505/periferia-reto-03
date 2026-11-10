import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import { z } from "zod";
import { OrdenCompra, OrdenCompraSchema } from "../sap/adapter.js";
import { MockSapAdapter } from "../sap/mock.js";

export interface ToolContext {
  directory: string;
  sessionId: string;
}

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string(),
});

export type Solicitud = z.infer<typeof SolicitudSchema>;

export const CotizacionNormalizadaSchema = z.object({
  referencia: z.string().nullable().optional(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
});

export const AprobacionNormalizadaSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  asunto: z.string().optional(),
  fecha: z.string(),
  aprobado: z.boolean(),
  texto: z.string(),
});

export const FacturaNormalizadaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
});

export const PaqueteSchema = z.object({
  correo: z.object({
    id: z.string(),
    de: z.string(),
    asunto: z.string(),
    fecha: z.string(),
  }),
  solicitud: SolicitudSchema,
  cotizacion: CotizacionNormalizadaSchema.nullable(),
  aprobacion: AprobacionNormalizadaSchema.nullable(),
  factura: FacturaNormalizadaSchema.nullable(),
  adjuntos_faltantes: z.array(z.string()).optional(),
});

export type Paquete = z.infer<typeof PaqueteSchema>;

export interface ReglaResultado {
  codigo: string;
  regla: string;
  detalle: string;
  accion_sugerida: string;
}

export const DerivadosSchema = z.object({
  codigo_sap: z.string().optional(),
  proveedor_nit: z.string().optional(),
  proveedor_nombre: z.string().optional(),
  indicador_iva: z.string().optional(),
  indicador_iva_descripcion: z.string().optional(),
  condiciones_pago: z.string().optional(),
  condiciones_pago_descripcion: z.string().optional(),
  notas: z.array(z.string()).optional(),
});

export type Derivados = z.infer<typeof DerivadosSchema>;

export interface ResultadoValidacion {
  caso: string;
  solicitud_id: string;
  apta: boolean;
  bloqueos: ReglaResultado[];
  confirmaciones: ReglaResultado[];
  derivados: Derivados;
  retroactiva: boolean;
  controles: Array<{
    codigo: string;
    nombre: string;
    tipo: "BLOQUEO" | "CONFIRMACION" | "DERIVADO";
    estado: "OK" | "BLOQUEO" | "CONFIRMACION_REQUERIDA" | "DERIVADO_INFO";
    detalle: string;
  }>;
}

interface ProveedorMaestro {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

interface CentroCostoMaestro {
  centro_costo: string;
  nombre: string;
  subareas: string[];
  aprobadores: Array<{
    email: string;
    nombre: string;
    tope: number;
  }>;
}

interface IndicadorIvaMaestro {
  codigo: string;
  descripcion: string;
  tasa: number;
}

interface CondicionPagoMaestro {
  codigo: string;
  descripcion: string;
  dias: number;
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function limpiarNit(nit: string): string {
  return nit.replace(/[^0-9]/g, "").slice(0, 9);
}

function parseMontoTexto(raw: string): number {
  const limpio = raw.replace(/\./g, "").replace(/,/g, ".").replace(/[^0-9.]/g, "");
  return Number(limpio);
}

function parsearCotizacionTxt(texto: string): z.infer<typeof CotizacionNormalizadaSchema> {
  const refMatch = texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i);
  const fechaMatch = texto.match(/Fecha:\s*(\d{4}-\d{2}-\d{2})/i);
  const provMatch = texto.match(/Proveedor:\s*(.+)/i);
  const nitMatch = texto.match(/NIT:\s*([0-9.-]+)/i);
  const totalMatch = texto.match(/TOTAL(?:\s*\([^)]*\))?:\s*(COP|USD)\s*([0-9.,]+)/i);
  const validezDiasMatch = texto.match(/Validez de la oferta:\s*(\d+)\s*d[íi]as/i);

  let validez_hasta: string | null = null;
  if (fechaMatch && validezDiasMatch) {
    const baseDate = new Date(`${fechaMatch[1]}T00:00:00Z`);
    const dias = Number(validezDiasMatch[1]);
    if (!Number.isNaN(baseDate.getTime()) && !Number.isNaN(dias)) {
      baseDate.setUTCDate(baseDate.getUTCDate() + dias);
      validez_hasta = baseDate.toISOString().slice(0, 10);
    }
  }

  return {
    referencia: refMatch ? refMatch[1].trim() : null,
    proveedor: provMatch ? provMatch[1].trim() : "Desconocido",
    nit: nitMatch ? limpiarNit(nitMatch[1].trim()) : null,
    moneda: totalMatch ? totalMatch[1].toUpperCase() : "COP",
    total: totalMatch ? parseMontoTexto(totalMatch[2]) : 0,
    validez_hasta,
    texto: texto.trim(),
  };
}

function parsearFacturaTxt(texto: string): z.infer<typeof FacturaNormalizadaSchema> {
  const numMatch = texto.match(/No\.\s*([A-Z0-9-]+)/i);
  const fechaMatch = texto.match(/Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i);
  const totalMatch = texto.match(/TOTAL:\s*(?:COP|USD)?\s*([0-9.,]+)/i);

  return {
    numero: numMatch ? numMatch[1].trim() : "SIN-NUMERO",
    fecha: fechaMatch ? fechaMatch[1].trim() : "",
    total: totalMatch ? parseMontoTexto(totalMatch[1]) : 0,
  };
}

async function existeArchivo(ruta: string): Promise<boolean> {
  try {
    await fs.access(ruta);
    return true;
  } catch {
    return false;
  }
}

async function cargarMaestros(rootDir: string): Promise<{
  proveedores: ProveedorMaestro[];
  centrosCosto: CentroCostoMaestro[];
  indicadoresIva: IndicadorIvaMaestro[];
  condicionesPago: CondicionPagoMaestro[];
}> {
  const base = path.join(rootDir, "fixtures", "reto-03", "maestros");
  const [provRaw, ccRaw, ivaRaw, cpRaw] = await Promise.all([
    fs.readFile(path.join(base, "proveedores.json"), "utf-8"),
    fs.readFile(path.join(base, "centros-costo.json"), "utf-8"),
    fs.readFile(path.join(base, "indicadores-iva.json"), "utf-8"),
    fs.readFile(path.join(base, "condiciones-pago.json"), "utf-8"),
  ]);

  return {
    proveedores: JSON.parse(provRaw) as ProveedorMaestro[],
    centrosCosto: JSON.parse(ccRaw) as CentroCostoMaestro[],
    indicadoresIva: JSON.parse(ivaRaw) as IndicadorIvaMaestro[],
    condicionesPago: JSON.parse(cpRaw) as CondicionPagoMaestro[],
  };
}

function escaparCsv(valor: string): string {
  if (valor.includes(",") || valor.includes('"') || valor.includes("\n")) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

async function registrarEnControlCsv(
  rootDir: string,
  registro: {
    solicitud_id: string;
    resultado: string;
    numero_oc: string;
    retroactiva: boolean;
    bloqueos: string[];
    confirmaciones: string[];
  }
): Promise<void> {
  const controlPath = path.join(rootDir, "out", "control.csv");
  await fs.mkdir(path.dirname(controlPath), { recursive: true });

  const header = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n";
  let contenidoExistente = "";
  if (await existeArchivo(controlPath)) {
    contenidoExistente = await fs.readFile(controlPath, "utf-8");
  } else {
    await fs.writeFile(controlPath, header, "utf-8");
  }

  // Evitar duplicar exactamente el mismo estado de bloqueo/pendiente si ya se registró sin cambios
  if (
    (registro.resultado === "BLOQUEADA" || registro.resultado === "PENDIENTE_CONFIRMACION") &&
    contenidoExistente.includes(`${registro.solicitud_id},${registro.resultado},`)
  ) {
    return;
  }

  const fila = [
    escaparCsv(registro.solicitud_id),
    escaparCsv(registro.resultado),
    escaparCsv(registro.numero_oc),
    String(registro.retroactiva),
    escaparCsv(registro.bloqueos.join("; ")),
    escaparCsv(registro.confirmaciones.join("; ")),
    new Date().toISOString(),
  ].join(",");

  await fs.appendFile(controlPath, `${fila}\n`, "utf-8");
}

async function leerPaqueteInterno(caso: string, rootDir: string): Promise<Paquete> {
  const casoLimpio = path.basename(caso.trim());
  const dirCaso = path.join(rootDir, "fixtures", "reto-03", "solicitudes", casoLimpio);

  if (!(await existeArchivo(dirCaso))) {
    throw new Error(`No existe la carpeta del caso '${casoLimpio}' en fixtures/reto-03/solicitudes/`);
  }

  const correoPath = path.join(dirCaso, "correo.json");
  const solicitudPath = path.join(dirCaso, "solicitud.json");
  const cotizacionPath = path.join(dirCaso, "cotizacion.txt");
  const aprobacionPath = path.join(dirCaso, "aprobacion.json");
  const facturaPath = path.join(dirCaso, "factura.txt");

  if (!(await existeArchivo(correoPath))) {
    throw new Error(`Falta correo.json en el caso '${casoLimpio}'`);
  }
  if (!(await existeArchivo(solicitudPath))) {
    throw new Error(`Falta solicitud.json en el caso '${casoLimpio}'`);
  }

  const correoRaw = JSON.parse(await fs.readFile(correoPath, "utf-8")) as {
    id: string;
    de: string;
    asunto: string;
    fecha: string;
    adjuntos?: string[];
  };

  const solicitudRaw = JSON.parse(await fs.readFile(solicitudPath, "utf-8")) as unknown;
  const solicitud = SolicitudSchema.parse(solicitudRaw);

  const adjuntosFaltantes: string[] = [];

  let cotizacion: z.infer<typeof CotizacionNormalizadaSchema> | null = null;
  if (await existeArchivo(cotizacionPath)) {
    const cotTxt = await fs.readFile(cotizacionPath, "utf-8");
    cotizacion = parsearCotizacionTxt(cotTxt);
  } else {
    adjuntosFaltantes.push("cotizacion.txt");
  }

  let aprobacion: z.infer<typeof AprobacionNormalizadaSchema> | null = null;
  if (await existeArchivo(aprobacionPath)) {
    const aprRaw = JSON.parse(await fs.readFile(aprobacionPath, "utf-8")) as {
      de: string;
      para?: string;
      asunto?: string;
      fecha: string;
      cuerpo: string;
    };
    aprobacion = {
      de: aprRaw.de,
      para: aprRaw.para,
      asunto: aprRaw.asunto,
      fecha: aprRaw.fecha,
      aprobado: /\baprobado\b/i.test(aprRaw.cuerpo),
      texto: aprRaw.cuerpo,
    };
  } else {
    adjuntosFaltantes.push("aprobacion.json");
  }

  let factura: z.infer<typeof FacturaNormalizadaSchema> | null = null;
  if (await existeArchivo(facturaPath)) {
    const facTxt = await fs.readFile(facturaPath, "utf-8");
    factura = parsearFacturaTxt(facTxt);
  } else if (correoRaw.adjuntos?.some((a) => a.toLowerCase().includes("factura"))) {
    adjuntosFaltantes.push("factura.txt");
  }

  return {
    correo: {
      id: correoRaw.id,
      de: correoRaw.de,
      asunto: correoRaw.asunto,
      fecha: correoRaw.fecha,
    },
    solicitud,
    cotizacion,
    aprobacion,
    factura,
    adjuntos_faltantes: adjuntosFaltantes,
  };
}

async function validarPaqueteInterno(
  caso: string,
  paquete: Paquete,
  rootDir: string
): Promise<ResultadoValidacion> {
  const maestros = await cargarMaestros(rootDir);
  const { solicitud, cotizacion, aprobacion, factura } = paquete;

  const bloqueos: ReglaResultado[] = [];
  const confirmaciones: ReglaResultado[] = [];
  const derivados: Derivados = { notas: [] };
  const controles: ResultadoValidacion["controles"] = [];

  // RC1: Proveedor en proveedores.json (por NIT o por nombre normalizado) y activo
  let proveedorEncontrado: ProveedorMaestro | undefined;
  if (solicitud.proveedor_nit) {
    const nitBuscado = limpiarNit(solicitud.proveedor_nit);
    proveedorEncontrado = maestros.proveedores.find((p) => limpiarNit(p.nit) === nitBuscado);
  } else {
    const nombreBuscado = normalizarTexto(solicitud.proveedor_nombre);
    proveedorEncontrado = maestros.proveedores.find(
      (p) => normalizarTexto(p.nombre) === nombreBuscado
    );
    if (proveedorEncontrado) {
      derivados.proveedor_nit = proveedorEncontrado.nit;
      derivados.notas?.push(
        `NIT del proveedor (${proveedorEncontrado.nit}) derivado desde maestros/proveedores.json por coincidencia de razón social.`
      );
    }
  }

  if (!proveedorEncontrado) {
    const detalle = `El proveedor '${solicitud.proveedor_nombre}' (NIT: ${solicitud.proveedor_nit ?? "No informado"}) no existe en el maestro de proveedores de SAP.`;
    bloqueos.push({
      codigo: "RC1",
      regla: "Existencia y estado activo del proveedor en SAP",
      detalle,
      accion_sugerida:
        "Solicitar al área de Compras / Datos Maestros la creación y homologación del proveedor en SAP antes de procesar la solicitud.",
    });
    controles.push({
      codigo: "RC1",
      nombre: "Proveedor en maestro y activo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else if (!proveedorEncontrado.activo) {
    const detalle = `El proveedor '${proveedorEncontrado.nombre}' (SAP ${proveedorEncontrado.codigo_sap}) figura INACTIVO en el maestro.`;
    bloqueos.push({
      codigo: "RC1",
      regla: "Existencia y estado activo del proveedor en SAP",
      detalle,
      accion_sugerida:
        "Solicitar la reactivación y actualización de soportes del proveedor en el maestro de proveedores SAP.",
    });
    controles.push({
      codigo: "RC1",
      nombre: "Proveedor en maestro y activo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else {
    derivados.codigo_sap = proveedorEncontrado.codigo_sap;
    derivados.proveedor_nit = proveedorEncontrado.nit;
    derivados.proveedor_nombre = proveedorEncontrado.nombre;
    controles.push({
      codigo: "RC1",
      nombre: "Proveedor en maestro y activo",
      tipo: "BLOQUEO",
      estado: "OK",
      detalle: `Proveedor activo: ${proveedorEncontrado.nombre} (Código SAP: ${proveedorEncontrado.codigo_sap}, NIT: ${proveedorEncontrado.nit}).`,
    });
  }

  // Buscar centro de costo para RC2, RC3, RC4
  const centroMaestro = maestros.centrosCosto.find(
    (c) => c.centro_costo === solicitud.centro_costo
  );

  // RC2: Aprobación debe existir, contener "Aprobado" y venir de aprobador del centro_costo
  let aprobadorMaestro = centroMaestro?.aprobadores.find(
    (a) => a.email.toLowerCase() === aprobacion?.de.toLowerCase()
  );

  if (!aprobacion) {
    const detalle = "No se encontró el archivo/correo de aprobación del líder en el paquete.";
    bloqueos.push({
      codigo: "RC2",
      regla: "Aprobación válida por líder autorizado del centro de costo",
      detalle,
      accion_sugerida: "Solicitar al usuario el correo de aprobación firmado por el líder del centro de costo.",
    });
    controles.push({
      codigo: "RC2",
      nombre: "Aprobador autorizado para el centro de costo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else if (!aprobacion.aprobado) {
    const detalle = `El correo de ${aprobacion.de} no contiene la palabra explícita 'Aprobado'.`;
    bloqueos.push({
      codigo: "RC2",
      regla: "Aprobación válida por líder autorizado del centro de costo",
      detalle,
      accion_sugerida: "Solicitar confirmación explícita con la palabra 'Aprobado' por parte del líder.",
    });
    controles.push({
      codigo: "RC2",
      nombre: "Aprobador autorizado para el centro de costo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else if (!centroMaestro) {
    const detalle = `El centro de costo '${solicitud.centro_costo}' no existe en el maestro de centros de costo.`;
    bloqueos.push({
      codigo: "RC2",
      regla: "Aprobación válida por líder autorizado del centro de costo",
      detalle,
      accion_sugerida: "Verificar y corregir el código del centro de costo en la solicitud.",
    });
    controles.push({
      codigo: "RC2",
      nombre: "Aprobador autorizado para el centro de costo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else if (!aprobadorMaestro) {
    const aprobadoresPermitidos = centroMaestro.aprobadores
      .map((a) => `${a.nombre} <${a.email}> (tope: ${a.tope.toLocaleString("es-CO")})`)
      .join(", ");
    const detalle = `El aprobador '${aprobacion.de}' NO tiene autoridad sobre el centro de costo ${centroMaestro.centro_costo} (${centroMaestro.nombre}). Aprobadores autorizados para ${centroMaestro.centro_costo}: ${aprobadoresPermitidos}.`;
    bloqueos.push({
      codigo: "RC2",
      regla: "Aprobación válida por líder autorizado del centro de costo",
      detalle,
      accion_sugerida: `Reenviar la solicitud para aprobación de un líder autorizado del centro ${centroMaestro.centro_costo} (${aprobadoresPermitidos}) o corregir el centro de costo si el gasto pertenece al área del aprobador.`,
    });
    controles.push({
      codigo: "RC2",
      nombre: "Aprobador autorizado para el centro de costo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else {
    controles.push({
      codigo: "RC2",
      nombre: "Aprobador autorizado para el centro de costo",
      tipo: "BLOQUEO",
      estado: "OK",
      detalle: `Aprobado por ${aprobadorMaestro.nombre} <${aprobadorMaestro.email}>, líder autorizado de ${centroMaestro.centro_costo}.`,
    });
  }

  // RC3: valor_total <= tope del aprobador para ese centro
  if (aprobadorMaestro) {
    if (solicitud.valor_total > aprobadorMaestro.tope) {
      const detalle = `El valor total (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}) supera el tope de aprobación de ${aprobadorMaestro.email} (${solicitud.moneda} ${aprobadorMaestro.tope.toLocaleString("es-CO")}) en ${solicitud.centro_costo}.`;
      bloqueos.push({
        codigo: "RC3",
        regla: "Valor total dentro del tope del aprobador",
        detalle,
        accion_sugerida:
          "Escalar la solicitud a un aprobador de nivel superior con tope suficiente para el centro de costo.",
      });
      controles.push({
        codigo: "RC3",
        nombre: "Monto dentro del tope del aprobador",
        tipo: "BLOQUEO",
        estado: "BLOQUEO",
        detalle,
      });
    } else {
      controles.push({
        codigo: "RC3",
        nombre: "Monto dentro del tope del aprobador",
        tipo: "BLOQUEO",
        estado: "OK",
        detalle: `Valor ${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")} <= tope de ${aprobadorMaestro.email} (${solicitud.moneda} ${aprobadorMaestro.tope.toLocaleString("es-CO")}).`,
      });
    }
  } else if (centroMaestro) {
    const topeMaximoCentro = Math.max(...centroMaestro.aprobadores.map((a) => a.tope));
    if (solicitud.valor_total > topeMaximoCentro) {
      const detalle = `Además de no estar autorizado el aprobador (${aprobacion?.de ?? "N/A"}), el monto (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}) excede el tope máximo permitido en ${centroMaestro.centro_costo} (${solicitud.moneda} ${topeMaximoCentro.toLocaleString("es-CO")}).`;
      bloqueos.push({
        codigo: "RC3",
        regla: "Valor total dentro del tope del aprobador",
        detalle,
        accion_sugerida: `Requiere aprobación de un líder autorizado del centro de costo y escalamiento de monto (supera el tope de ${topeMaximoCentro.toLocaleString("es-CO")}).`,
      });
      controles.push({
        codigo: "RC3",
        nombre: "Monto dentro del tope del aprobador",
        tipo: "BLOQUEO",
        estado: "BLOQUEO",
        detalle,
      });
    } else {
      controles.push({
        codigo: "RC3",
        nombre: "Monto dentro del tope del aprobador",
        tipo: "BLOQUEO",
        estado: "BLOQUEO",
        detalle: `No se puede validar tope porque ${aprobacion?.de ?? "el remitente"} no es aprobador de ${centroMaestro.centro_costo}.`,
      });
    }
  }

  // RC4: subarea debe pertenecer al centro_costo
  if (!centroMaestro || !centroMaestro.subareas.includes(solicitud.subarea)) {
    const permitidas = centroMaestro ? centroMaestro.subareas.join(", ") : "Ninguna";
    const detalle = `La subárea '${solicitud.subarea}' no pertenece al centro de costo '${solicitud.centro_costo}'. Subáreas válidas: ${permitidas}.`;
    bloqueos.push({
      codigo: "RC4",
      regla: "Subárea pertenece al centro de costo",
      detalle,
      accion_sugerida: `Corregir la subárea en la solicitud a una de las habilitadas para ${solicitud.centro_costo}: ${permitidas}.`,
    });
    controles.push({
      codigo: "RC4",
      nombre: "Subárea pertenece al centro de costo",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else {
    controles.push({
      codigo: "RC4",
      nombre: "Subárea pertenece al centro de costo",
      tipo: "BLOQUEO",
      estado: "OK",
      detalle: `Subárea '${solicitud.subarea}' válida dentro de ${solicitud.centro_costo} (${centroMaestro.nombre}).`,
    });
  }

  // RC5: abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total <= 2%
  if (!cotizacion) {
    const detalle =
      "No se adjuntó cotización del proveedor en el paquete. Se requiere confirmación humana para continuar sin cotización.";
    confirmaciones.push({
      codigo: "RC5",
      regla: "Consistencia de monto entre cotización y solicitud (tolerancia ±2%)",
      detalle,
      accion_sugerida: "Confirmar si se autoriza crear la OC sin soporte de cotización o adjuntar la cotización.",
    });
    controles.push({
      codigo: "RC5",
      nombre: "Diferencia cotización vs solicitud <= 2%",
      tipo: "CONFIRMACION",
      estado: "CONFIRMACION_REQUERIDA",
      detalle,
    });
  } else {
    const diffAbs = Math.abs(cotizacion.total - solicitud.valor_total);
    const diffRatio = solicitud.valor_total > 0 ? diffAbs / solicitud.valor_total : 1;
    const diffPct = (diffRatio * 100).toFixed(2);
    if (diffRatio > 0.02) {
      const detalle = `El valor de la cotización (${cotizacion.moneda} ${cotizacion.total.toLocaleString("es-CO")}) difiere en ${diffPct}% respecto al valor de la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}), superando la tolerancia del 2% (diferencia: ${solicitud.moneda} ${diffAbs.toLocaleString("es-CO")}).`;
      confirmaciones.push({
        codigo: "RC5",
        regla: "Consistencia de monto entre cotización y solicitud (tolerancia ±2%)",
        detalle,
        accion_sugerida: `Confirmar explícitamente si se procede con el valor aprobado en la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}) pese a que la cotización indica ${cotizacion.moneda} ${cotizacion.total.toLocaleString("es-CO")}.`,
      });
      controles.push({
        codigo: "RC5",
        nombre: "Diferencia cotización vs solicitud <= 2%",
        tipo: "CONFIRMACION",
        estado: "CONFIRMACION_REQUERIDA",
        detalle,
      });
    } else {
      controles.push({
        codigo: "RC5",
        nombre: "Diferencia cotización vs solicitud <= 2%",
        tipo: "CONFIRMACION",
        estado: "OK",
        detalle: `Monto de cotización (${cotizacion.moneda} ${cotizacion.total.toLocaleString("es-CO")}) coincide con la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}, desvío ${diffPct}% <= 2%).`,
      });
    }
  }

  // RC6: indicador_iva ausente -> se deriva del proveedor (indicador_iva_default) y se pide confirmación
  const ivaCodigo = solicitud.indicador_iva ?? proveedorEncontrado?.indicador_iva_default;
  const ivaMaestro = maestros.indicadoresIva.find((i) => i.codigo === ivaCodigo);

  if (!solicitud.indicador_iva) {
    const codigoDerivado = proveedorEncontrado?.indicador_iva_default ?? "C1";
    const descIva =
      maestros.indicadoresIva.find((i) => i.codigo === codigoDerivado)?.descripcion ?? "IVA por defecto";
    derivados.indicador_iva = codigoDerivado;
    derivados.indicador_iva_descripcion = descIva;
    derivados.notas?.push(
      `Indicador de IVA ausente en solicitud; se derivó '${codigoDerivado}' (${descIva}) desde el maestro del proveedor.`
    );
    const detalle = `El campo 'indicador_iva' no fue informado en la solicitud. Se derivó el valor por defecto del proveedor: '${codigoDerivado}' (${descIva}). Requiere confirmación del analista.`;
    confirmaciones.push({
      codigo: "RC6",
      regla: "Indicador de IVA informado o derivado con confirmación",
      detalle,
      accion_sugerida: `Confirmar la aplicación del indicador de IVA derivado '${codigoDerivado}' (${descIva}).`,
    });
    controles.push({
      codigo: "RC6",
      nombre: "Indicador de IVA",
      tipo: "CONFIRMACION",
      estado: "CONFIRMACION_REQUERIDA",
      detalle,
    });
  } else {
    controles.push({
      codigo: "RC6",
      nombre: "Indicador de IVA",
      tipo: "CONFIRMACION",
      estado: "OK",
      detalle: `Indicador de IVA '${solicitud.indicador_iva}' (${ivaMaestro?.descripcion ?? "Válido"}) informado en la solicitud.`,
    });
  }

  // RC7: condiciones_pago ausente -> se deriva del proveedor. Solo se informa.
  if (!solicitud.condiciones_pago) {
    const cpDerivada = proveedorEncontrado?.condiciones_pago_default ?? "Z030";
    const descCp =
      maestros.condicionesPago.find((c) => c.codigo === cpDerivada)?.descripcion ??
      "Condición por defecto";
    derivados.condiciones_pago = cpDerivada;
    derivados.condiciones_pago_descripcion = descCp;
    derivados.notas?.push(
      `Condiciones de pago ausentes en solicitud; se derivó '${cpDerivada}' (${descCp}) desde el maestro del proveedor (solo informativo, RC7).`
    );
    controles.push({
      codigo: "RC7",
      nombre: "Condiciones de pago",
      tipo: "DERIVADO",
      estado: "DERIVADO_INFO",
      detalle: `Derivado automáticamente del proveedor: '${cpDerivada}' (${descCp}). No bloquea ni requiere confirmación.`,
    });
  } else {
    const descCp =
      maestros.condicionesPago.find((c) => c.codigo === solicitud.condiciones_pago)?.descripcion ??
      solicitud.condiciones_pago;
    controles.push({
      codigo: "RC7",
      nombre: "Condiciones de pago",
      tipo: "DERIVADO",
      estado: "OK",
      detalle: `Condición de pago '${solicitud.condiciones_pago}' (${descCp}) informada en la solicitud.`,
    });
  }

  // RC8: Existe factura con fecha < fecha_solicitud -> retroactiva = true. Confirmación.
  let retroactiva = false;
  if (factura && factura.fecha && factura.fecha < solicitud.fecha_solicitud) {
    retroactiva = true;
    const detalle = `Compra retroactiva detectada: existe la factura ${factura.numero} con fecha de emisión ${factura.fecha}, anterior a la fecha de la solicitud (${solicitud.fecha_solicitud}). Quedará marcada con retroactiva = true en el log de control.`;
    confirmaciones.push({
      codigo: "RC8",
      regla: "Detección de orden de compra retroactiva (factura anterior a solicitud)",
      detalle,
      accion_sugerida: `Confirmar si se autoriza la creación excepcional de la OC retroactiva para la factura ${factura.numero} (emitida el ${factura.fecha}).`,
    });
    controles.push({
      codigo: "RC8",
      nombre: "Control de OC retroactiva (factura previa)",
      tipo: "CONFIRMACION",
      estado: "CONFIRMACION_REQUERIDA",
      detalle,
    });
  } else {
    controles.push({
      codigo: "RC8",
      nombre: "Control de OC retroactiva (factura previa)",
      tipo: "CONFIRMACION",
      estado: "OK",
      detalle: "Sin factura previa a la fecha de solicitud (retroactiva = false).",
    });
  }

  // RC9: La fecha de aprobación debe ser >= fecha_solicitud. Si no: confirmación.
  if (aprobacion) {
    const fechaAprobDia = aprobacion.fecha.slice(0, 10);
    const fechaSolDia = solicitud.fecha_solicitud.slice(0, 10);
    if (fechaAprobDia < fechaSolDia) {
      const detalle = `La fecha de aprobación (${fechaAprobDia}) es anterior a la fecha de la solicitud (${fechaSolDia}).`;
      confirmaciones.push({
        codigo: "RC9",
        regla: "Secuencia cronológica de aprobación vs solicitud",
        detalle,
        accion_sugerida: "Confirmar si la fecha de aprobación anterior a la solicitud es válida.",
      });
      controles.push({
        codigo: "RC9",
        nombre: "Fecha aprobación >= Fecha solicitud",
        tipo: "CONFIRMACION",
        estado: "CONFIRMACION_REQUERIDA",
        detalle,
      });
    } else {
      controles.push({
        codigo: "RC9",
        nombre: "Fecha aprobación >= Fecha solicitud",
        tipo: "CONFIRMACION",
        estado: "OK",
        detalle: `Fecha de aprobación (${fechaAprobDia}) >= fecha de solicitud (${fechaSolDia}).`,
      });
    }
  }

  // RC10: cantidad * valor_unitario debe igualar valor_total (± 1 unidad monetaria). Si no: bloqueo.
  const calculado = solicitud.cantidad * solicitud.valor_unitario;
  if (Math.abs(calculado - solicitud.valor_total) > 1) {
    const detalle = `Inconsistencia aritmética: cantidad (${solicitud.cantidad}) × valor_unitario (${solicitud.valor_unitario}) = ${calculado}, que difiere de valor_total (${solicitud.valor_total}) en más de ±1 unidad monetaria.`;
    bloqueos.push({
      codigo: "RC10",
      regla: "Consistencia aritmética (cantidad × valor_unitario = valor_total ± 1)",
      detalle,
      accion_sugerida: "Solicitar corrección de los valores en la solicitud de compra.",
    });
    controles.push({
      codigo: "RC10",
      nombre: "Consistencia aritmética de totales",
      tipo: "BLOQUEO",
      estado: "BLOQUEO",
      detalle,
    });
  } else {
    controles.push({
      codigo: "RC10",
      nombre: "Consistencia aritmética de totales",
      tipo: "BLOQUEO",
      estado: "OK",
      detalle: `${solicitud.cantidad} × ${solicitud.valor_unitario.toLocaleString("es-CO")} = ${calculado.toLocaleString("es-CO")} (cuadra con ${solicitud.valor_total.toLocaleString("es-CO")}).`,
    });
  }

  const apta = bloqueos.length === 0;

  if (!apta) {
    await registrarEnControlCsv(rootDir, {
      solicitud_id: solicitud.solicitud_id,
      resultado: "BLOQUEADA",
      numero_oc: "",
      retroactiva,
      bloqueos: bloqueos.map((b) => `${b.codigo}: ${b.detalle}`),
      confirmaciones: confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`),
    });
  }

  return {
    caso: path.basename(caso.trim()),
    solicitud_id: solicitud.solicitud_id,
    apta,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
    controles,
  };
}

async function generarEvidenciaInterno(
  caso: string,
  rootDir: string
): Promise<{ ruta: string; ruta_pdf: string; sha256: string }> {
  const casoLimpio = path.basename(caso.trim());
  const dirCaso = path.join(rootDir, "fixtures", "reto-03", "solicitudes", casoLimpio);
  const aprobacionPath = path.join(dirCaso, "aprobacion.json");

  if (!(await existeArchivo(aprobacionPath))) {
    throw new Error(`No existe aprobacion.json para el caso '${casoLimpio}'`);
  }

  const apr = JSON.parse(await fs.readFile(aprobacionPath, "utf-8")) as {
    de: string;
    para?: string;
    cc?: string[];
    fecha: string;
    asunto?: string;
    cuerpo: string;
  };

  const cuerpoCanónico = [
    `De: ${apr.de}`,
    `Para: ${apr.para ?? "compras@periferia-ficticia.com"}`,
    ...(apr.cc && apr.cc.length > 0 ? [`CC: ${apr.cc.join(", ")}`] : []),
    `Fecha: ${apr.fecha}`,
    `Asunto: ${apr.asunto ?? ""}`,
    `----------------------------------------`,
    apr.cuerpo.trim(),
  ].join("\n");

  const sha256 = crypto.createHash("sha256").update(cuerpoCanónico, "utf-8").digest("hex");

  const contenidoTxt = `${cuerpoCanónico}\n\n----------------------------------------\nSHA-256: ${sha256}\n`;

  const outDir = path.join(rootDir, "out", casoLimpio);
  await fs.mkdir(outDir, { recursive: true });

  const txtRelPath = path.posix.join("out", casoLimpio, "aprobacion.txt");
  const pdfRelPath = path.posix.join("out", casoLimpio, "aprobacion.pdf");

  await fs.writeFile(path.join(rootDir, txtRelPath), contenidoTxt, "utf-8");

  // P1: Generar PDF de evidencia con pdf-lib
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 790;
  page.drawText("EVIDENCIA DE APROBACION - ORDEN DE COMPRA SAP", {
    x: 50,
    y,
    size: 13,
    font: fontBold,
    color: rgb(0.08, 0.25, 0.45),
  });
  y -= 28;

  const sanitizarWinAnsi = (str: string): string =>
    str.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

  for (const linea of contenidoTxt.split("\n")) {
    const esHeader = /^(De|Para|CC|Fecha|Asunto|SHA-256):/.test(linea);
    page.drawText(sanitizarWinAnsi(linea.slice(0, 95)), {
      x: 50,
      y,
      size: 10,
      font: esHeader ? fontBold : fontRegular,
      color: rgb(0.15, 0.15, 0.15),
    });
    y -= 16;
    if (y < 60) break;
  }

  const pdfBytes = await pdfDoc.save();
  await fs.writeFile(path.join(rootDir, pdfRelPath), pdfBytes);

  return {
    ruta: txtRelPath,
    ruta_pdf: pdfRelPath,
    sha256,
  };
}

function inferirUnidadSap(descripcion: string): "UN" | "H" | "MES" {
  const desc = descripcion.toLowerCase();
  if (/\b(hora|horas)\b/.test(desc)) {
    return "H";
  }
  if (/\b(mensual|meses de servicio)\b/.test(desc)) {
    return "MES";
  }
  return "UN";
}

async function construirPayloadInterno(
  caso: string,
  paqueteInput?: Paquete,
  derivadosInput?: Derivados,
  confirmadoPor: string | null = null,
  rootDir: string = process.cwd()
): Promise<{
  payload: OrdenCompra;
  ruta_trazabilidad: string;
  trazabilidad: Record<string, { valor: unknown; fuente: string }>;
}> {
  const casoLimpio = path.basename(caso.trim());
  const paquete = paqueteInput ?? (await leerPaqueteInterno(casoLimpio, rootDir));
  const validacion = await validarPaqueteInterno(casoLimpio, paquete, rootDir);
  const derivados: Derivados = {
    ...validacion.derivados,
    ...(derivadosInput ?? {}),
  };

  const maestros = await cargarMaestros(rootDir);
  const { solicitud, correo, cotizacion, aprobacion } = paquete;

  const nitFinal = solicitud.proveedor_nit
    ? limpiarNit(solicitud.proveedor_nit)
    : derivados.proveedor_nit ?? "";

  const proveedorMaestro =
    maestros.proveedores.find((p) => limpiarNit(p.nit) === nitFinal) ??
    maestros.proveedores.find(
      (p) => normalizarTexto(p.nombre) === normalizarTexto(solicitud.proveedor_nombre)
    );

  const evidencia = await generarEvidenciaInterno(casoLimpio, rootDir);

  const codigoSap = proveedorMaestro?.codigo_sap ?? derivados.codigo_sap ?? "000000";
  const nitProveedor = proveedorMaestro?.nit ?? (nitFinal || "000000000");
  const nombreProveedor = proveedorMaestro?.nombre ?? solicitud.proveedor_nombre;

  const condicionesPago =
    solicitud.condiciones_pago ??
    derivados.condiciones_pago ??
    proveedorMaestro?.condiciones_pago_default ??
    "Z030";

  const indicadorIva =
    solicitud.indicador_iva ??
    derivados.indicador_iva ??
    proveedorMaestro?.indicador_iva_default ??
    "C1";

  const descripcionCorta = solicitud.descripcion.slice(0, 40);
  const unidad = inferirUnidadSap(solicitud.descripcion);

  const cotizacionRef =
    cotizacion?.referencia ??
    cotizacion?.texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i)?.[1] ??
    null;

  const payload: OrdenCompra = {
    referencia: {
      solicitud_id: solicitud.solicitud_id,
      correo_id: correo.id,
      cotizacion_ref: cotizacionRef,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: codigoSap,
      nit: nitProveedor,
      nombre: nombreProveedor,
    },
    moneda: solicitud.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: aprobacion?.de ?? "sin-aprobador@periferia-ficticia.com",
      fecha_aprobacion: aprobacion?.fecha ?? new Date().toISOString(),
      evidencia_sha256: evidencia.sha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion: descripcionCorta,
        cantidad: solicitud.cantidad,
        unidad,
        precio_unitario: solicitud.valor_unitario,
        centro_costo: solicitud.centro_costo,
        subarea: solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({
      codigo: c.codigo,
      detalle: c.detalle,
      confirmado_por: confirmadoPor,
    })),
  };

  const payloadValidado = OrdenCompraSchema.parse(payload);

  const trazabilidad: Record<string, { valor: unknown; fuente: string }> = {
    "referencia.solicitud_id": { valor: payloadValidado.referencia.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: payloadValidado.referencia.correo_id, fuente: "solicitud (correo.json)" },
    "referencia.cotizacion_ref": {
      valor: payloadValidado.referencia.cotizacion_ref,
      fuente: cotizacion ? "cotizacion" : "derivado",
    },
    sociedad: { valor: payloadValidado.sociedad, fuente: "derivado (constante SAP 1000)" },
    organizacion_compras: {
      valor: payloadValidado.organizacion_compras,
      fuente: "derivado (constante SAP 1000)",
    },
    "proveedor.codigo_sap": {
      valor: payloadValidado.proveedor.codigo_sap,
      fuente: "maestro.proveedores",
    },
    "proveedor.nit": {
      valor: payloadValidado.proveedor.nit,
      fuente: solicitud.proveedor_nit ? "solicitud" : "maestro.proveedores",
    },
    "proveedor.nombre": {
      valor: payloadValidado.proveedor.nombre,
      fuente: "maestro.proveedores",
    },
    moneda: { valor: payloadValidado.moneda, fuente: "solicitud" },
    condiciones_pago: {
      valor: payloadValidado.condiciones_pago,
      fuente: solicitud.condiciones_pago ? "solicitud" : "derivado (maestro.proveedores)",
    },
    "aprobador.email": { valor: payloadValidado.aprobador.email, fuente: "solicitud (aprobacion.json)" },
    "aprobador.fecha_aprobacion": {
      valor: payloadValidado.aprobador.fecha_aprobacion,
      fuente: "solicitud (aprobacion.json)",
    },
    "aprobador.evidencia_sha256": {
      valor: payloadValidado.aprobador.evidencia_sha256,
      fuente: "derivado (sha256 evidencia aprobacion)",
    },
    "posiciones[0].numero": { valor: 10, fuente: "derivado (secuencia posición SAP)" },
    "posiciones[0].descripcion": {
      valor: payloadValidado.posiciones[0].descripcion,
      fuente: "solicitud (truncado a 40 chars SAP)",
    },
    "posiciones[0].cantidad": { valor: payloadValidado.posiciones[0].cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: payloadValidado.posiciones[0].unidad, fuente: "derivado" },
    "posiciones[0].precio_unitario": {
      valor: payloadValidado.posiciones[0].precio_unitario,
      fuente: "solicitud",
    },
    "posiciones[0].centro_costo": {
      valor: payloadValidado.posiciones[0].centro_costo,
      fuente: "solicitud",
    },
    "posiciones[0].subarea": { valor: payloadValidado.posiciones[0].subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": {
      valor: payloadValidado.posiciones[0].indicador_iva,
      fuente: solicitud.indicador_iva ? "solicitud" : "derivado (maestro.proveedores)",
    },
  };

  const outDir = path.join(rootDir, "out", casoLimpio);
  await fs.mkdir(outDir, { recursive: true });
  const rutaRelativa = path.posix.join("out", casoLimpio, "trazabilidad.json");
  await fs.writeFile(
    path.join(rootDir, rutaRelativa),
    JSON.stringify(trazabilidad, null, 2),
    "utf-8"
  );

  return {
    payload: payloadValidado,
    ruta_trazabilidad: rutaRelativa,
    trazabilidad,
  };
}

// ============================================================================
// HERRAMIENTAS EXPORTADAS (Contrato Sección 6.2: <archivo>_<export> -> oc_*)
// ============================================================================

export const leer_paquete = {
  description:
    "Lee y normaliza todos los documentos de una solicitud de compra (correo, solicitud, cotización, aprobación y factura opcional) desde fixtures/reto-03/solicitudes/<caso>.",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const data = await leerPaqueteInterno(args.caso, rootDir);
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const validar = {
  description:
    "Evalúa las 10 reglas de control (RC1 a RC10) contra los maestros de proveedores, centros de costo, indicadores de IVA y condiciones de pago, devolviendo aptitud, bloqueos, confirmaciones requeridas, campos derivados y si es retroactiva.",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'"),
    paquete: PaqueteSchema.optional().describe(
      "Paquete normalizado devuelto por oc_leer_paquete (opcional; si se omite se carga del caso)"
    ),
  },
  async execute(
    args: { caso: string; paquete?: Paquete },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const paquete = args.paquete ?? (await leerPaqueteInterno(args.caso, rootDir));
      const data = await validarPaqueteInterno(args.caso, paquete, rootDir);
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const construir_payload = {
  description:
    "Construye y valida con Zod el payload SAP de la Orden de Compra (OrdenCompra) y guarda su matriz de trazabilidad campo por campo en out/<caso>/trazabilidad.json.",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'"),
    paquete: PaqueteSchema.optional().describe(
      "Paquete normalizado devuelto por oc_leer_paquete (opcional)"
    ),
    derivados: DerivadosSchema.optional().describe(
      "Valores derivados devueltos por oc_validar (opcional)"
    ),
  },
  async execute(
    args: { caso: string; paquete?: Paquete; derivados?: Derivados },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const data = await construirPayloadInterno(
        args.caso,
        args.paquete,
        args.derivados,
        null,
        rootDir
      );
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const generar_evidencia = {
  description:
    "Genera el archivo de evidencia de aprobación en out/<caso>/aprobacion.txt y out/<caso>/aprobacion.pdf con los encabezados del correo, cuerpo y hash SHA-256.",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const data = await generarEvidenciaInterno(args.caso, rootDir);
      return JSON.stringify({ ok: true, data });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const crear = {
  description:
    "Crea la Orden de Compra en el adaptador SAP simulado (out/sap/ordenes.jsonl) y registra el resultado en out/control.csv. Solo procede si apta=true y no hay confirmaciones pendientes (o si confirmado=true).",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. 'sol-001'"),
    payload: OrdenCompraSchema.optional().describe(
      "Payload OrdenCompra construido por oc_construir_payload (opcional; se verifica contra las herramientas)"
    ),
    confirmado: z
      .boolean()
      .optional()
      .describe(
        "Debe ser true únicamente cuando la analista humana ya confirmó explícitamente las excepciones/confirmaciones en el chat"
      ),
  },
  async execute(
    args: { caso: string; payload?: OrdenCompra; confirmado?: boolean },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const paquete = await leerPaqueteInterno(args.caso, rootDir);
      const validacion = await validarPaqueteInterno(args.caso, paquete, rootDir);

      if (!validacion.apta) {
        const motivo = validacion.bloqueos.map((b) => `[${b.codigo}] ${b.detalle}`).join(" | ");
        await registrarEnControlCsv(rootDir, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "BLOQUEADA",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`),
          confirmaciones: validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`),
        });
        return JSON.stringify({
          ok: false,
          error: `No se puede crear la OC porque tiene bloqueos de control: ${motivo}`,
        });
      }

      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        const pendientes = validacion.confirmaciones
          .map((c) => `[${c.codigo}] ${c.detalle}`)
          .join(" | ");
        await registrarEnControlCsv(rootDir, {
          solicitud_id: paquete.solicitud.solicitud_id,
          resultado: "PENDIENTE_CONFIRMACION",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: [],
          confirmaciones: validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`),
        });
        return JSON.stringify({
          ok: false,
          error: `La solicitud requiere confirmación explícita del humano (confirmado=true) por las siguientes alertas: ${pendientes}`,
        });
      }

      const confirmadoPor =
        validacion.confirmaciones.length > 0 && args.confirmado === true
          ? "analista.compras@periferia-ficticia.com"
          : null;

      // Seguridad Sección 10: reconstruimos el payload desde las fuentes deterministas
      // para garantizar que el modelo no haya alterado montos ni centros de costo.
      const { payload: payloadSeguro, ruta_trazabilidad } = await construirPayloadInterno(
        args.caso,
        paquete,
        validacion.derivados,
        confirmadoPor,
        rootDir
      );
      const evidencia = await generarEvidenciaInterno(args.caso, rootDir);

      const sap = new MockSapAdapter(rootDir);
      const previa = await sap.buscarOrdenPorReferencia(payloadSeguro.referencia.solicitud_id);
      const creada = await sap.crearOrden(payloadSeguro);
      const idempotente = previa !== null;

      await registrarEnControlCsv(rootDir, {
        solicitud_id: paquete.solicitud.solicitud_id,
        resultado: idempotente ? "IDEMPOTENTE" : "CREADA",
        numero_oc: creada.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: [],
        confirmaciones: validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`),
      });

      return JSON.stringify({
        ok: true,
        data: {
          numero_oc: creada.numero_oc,
          fecha: creada.fecha,
          idempotente,
          retroactiva: validacion.retroactiva,
          evidencia_txt: evidencia.ruta,
          evidencia_pdf: evidencia.ruta_pdf,
          evidencia_sha256: evidencia.sha256,
          trazabilidad: ruta_trazabilidad,
        },
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

export const leer_excel = {
  description:
    "Lee un archivo Excel (.xlsx/.csv) o JSON equivalente dentro del proyecto y devuelve sus filas estructuradas.",
  args: {
    ruta: z
      .string()
      .describe("Ruta relativa del archivo dentro del proyecto, ej. 'fixtures/reto-03/solicitudes/sol-001/solicitud.xlsx'"),
  },
  async execute(args: { ruta: string }, ctx: ToolContext): Promise<string> {
    try {
      const rootDir = ctx?.directory || process.cwd();
      const targetPath = path.resolve(rootDir, args.ruta);
      if (!targetPath.startsWith(path.resolve(rootDir))) {
        return JSON.stringify({
          ok: false,
          error: "Acceso denegado fuera del directorio raíz del proyecto.",
        });
      }

      if (await existeArchivo(targetPath)) {
        if (targetPath.endsWith(".json")) {
          const raw = JSON.parse(await fs.readFile(targetPath, "utf-8")) as unknown;
          const filas = Array.isArray(raw) ? raw : [raw];
          return JSON.stringify({ ok: true, data: { filas } });
        }
        const buffer = await fs.readFile(targetPath);
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const filas = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        return JSON.stringify({ ok: true, data: { filas } });
      }

      // Fallback para fixtures donde solicitud.xlsx está normalizado como solicitud.json
      const fallbackJson = targetPath.replace(/\.xlsx$/i, ".json");
      if (fallbackJson !== targetPath && (await existeArchivo(fallbackJson))) {
        const raw = JSON.parse(await fs.readFile(fallbackJson, "utf-8")) as unknown;
        const filas = Array.isArray(raw) ? raw : [raw];
        return JSON.stringify({
          ok: true,
          data: { filas, nota: "Leído desde fixture normalizado .json equivalente" },
        });
      }

      return JSON.stringify({
        ok: false,
        error: `No se encontró el archivo '${args.ruta}'`,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
