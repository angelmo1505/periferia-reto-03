/**
 * Re-exportación canónica de las herramientas del agente (Sección 9.4 PRD).
 * Garantiza una única fuente de verdad entre src/tools/oc.ts y modulo/tools/oc.ts.
 */
export {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
  leer_excel,
  SolicitudSchema,
  PaqueteSchema,
  DerivadosSchema,
} from "../../src/tools/oc.js";

export type {
  ToolContext,
  Solicitud,
  Paquete,
  Derivados,
  ReglaResultado,
  ResultadoValidacion,
} from "../../src/tools/oc.js";
