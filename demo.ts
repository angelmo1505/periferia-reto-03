import fs from "node:fs/promises";
import path from "node:path";
import {
  construir_payload as oc_construir_payload,
  crear as oc_crear,
  generar_evidencia as oc_generar_evidencia,
  leer_paquete as oc_leer_paquete,
  Paquete,
  ResultadoValidacion,
  ToolContext,
  validar as oc_validar,
} from "./src/tools/oc.js";
import { OrdenCompra } from "./src/sap/adapter.js";

interface ToolResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function parseToolResult<T>(raw: string): ToolResponse<T> {
  return JSON.parse(raw) as ToolResponse<T>;
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const outDir = path.join(rootDir, "out");

  // Requisito 8 (Determinismo): Limpiar out/ al inicio de cada ejecución
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  console.log("================================================================================");
  console.log("  DEMO DETERMINISTA SIN MODELO LLM — RETO 03: ÓRDENES DE COMPRA SAP (PERIFERIA)");
  console.log("================================================================================\n");

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
  const ctx: ToolContext = {
    directory: rootDir,
    sessionId: "demo-determinista-cli",
  };

  for (const caso of casos) {
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`▶ PROCESANDO CASO: ${caso.toUpperCase()}`);
    console.log(`--------------------------------------------------------------------------------`);

    // 1. Leer paquete
    const resPaquete = parseToolResult<Paquete>(
      await oc_leer_paquete.execute({ caso }, ctx)
    );
    if (!resPaquete.ok || !resPaquete.data) {
      console.log(`  ❌ Error leyendo paquete: ${resPaquete.error}\n`);
      continue;
    }
    const paquete = resPaquete.data;
    console.log(
      `  • Solicitud ID : ${paquete.solicitud.solicitud_id} (${paquete.solicitud.descripcion})`
    );
    console.log(
      `  • Proveedor    : ${paquete.solicitud.proveedor_nombre} (NIT: ${paquete.solicitud.proveedor_nit ?? "No informado en solicitud"})`
    );
    console.log(
      `  • Imputación   : ${paquete.solicitud.centro_costo} / ${paquete.solicitud.subarea}`
    );
    console.log(
      `  • Valor Total  : ${paquete.solicitud.moneda} ${paquete.solicitud.valor_total.toLocaleString("es-CO")}`
    );

    // 2. Validar contra maestros y controles (RC1-RC10)
    const resVal = parseToolResult<ResultadoValidacion>(
      await oc_validar.execute({ caso, paquete }, ctx)
    );
    if (!resVal.ok || !resVal.data) {
      console.log(`  ❌ Error en validación: ${resVal.error}\n`);
      continue;
    }
    const val = resVal.data;

    console.log(`  • ¿Apta?       : ${val.apta ? "SÍ (Sin bloqueos)" : "NO (Bloqueada)"}`);
    console.log(`  • ¿Retroactiva?: ${val.retroactiva ? "SÍ (Factura previa a solicitud)" : "NO"}`);

    if (val.derivados.notas && val.derivados.notas.length > 0) {
      console.log(`  • Derivados    :`);
      for (const nota of val.derivados.notas) {
        console.log(`      ℹ️  ${nota}`);
      }
    }

    if (val.bloqueos.length > 0) {
      console.log(`  • Bloqueos (${val.bloqueos.length}):`);
      for (const b of val.bloqueos) {
        console.log(`      ❌ [${b.codigo}] ${b.detalle}`);
        console.log(`         ↳ Acción sugerida: ${b.accion_sugerida}`);
      }
      console.log(`  • Resultado OC : NO CREADA (Bloqueo de control preventivo)\n`);
      continue;
    }

    if (val.confirmaciones.length > 0) {
      console.log(`  • Confirmaciones requeridas (${val.confirmaciones.length}):`);
      for (const c of val.confirmaciones) {
        console.log(`      ⚠️  [${c.codigo}] ${c.detalle}`);
        console.log(`         ↳ Acción sugerida: ${c.accion_sugerida}`);
      }
    } else {
      console.log(`  • Confirmaciones: Ninguna (0)`);
    }

    // 3. Construir Payload SAP y Trazabilidad
    const resPayload = parseToolResult<{
      payload: OrdenCompra;
      ruta_trazabilidad: string;
    }>(
      await oc_construir_payload.execute(
        { caso, paquete, derivados: val.derivados },
        ctx
      )
    );
    if (!resPayload.ok || !resPayload.data) {
      console.log(`  ❌ Error construyendo payload: ${resPayload.error}\n`);
      continue;
    }

    // 4. Generar evidencia de aprobación (TXT + PDF con SHA-256)
    const resEvidencia = parseToolResult<{
      ruta: string;
      ruta_pdf: string;
      sha256: string;
    }>(await oc_generar_evidencia.execute({ caso }, ctx));

    if (resEvidencia.ok && resEvidencia.data) {
      console.log(
        `  • Evidencia    : ${resEvidencia.data.ruta} | ${resEvidencia.data.ruta_pdf} (SHA-256: ${resEvidencia.data.sha256.slice(0, 16)}...)`
      );
    }
    console.log(`  • Trazabilidad : ${resPayload.data.ruta_trazabilidad}`);

    // 5. Creación en SAP simulado
    if (val.confirmaciones.length === 0) {
      const resCrear1 = parseToolResult<{
        numero_oc: string;
        fecha: string;
        idempotente: boolean;
      }>(
        await oc_crear.execute(
          { caso, payload: resPayload.data.payload, confirmado: false },
          ctx
        )
      );

      if (resCrear1.ok && resCrear1.data) {
        console.log(
          `  • Resultado OC : ✅ OC CREADA #${resCrear1.data.numero_oc} (idempotente=${resCrear1.data.idempotente})`
        );
      }

      // Demostración obligatoria de idempotencia ejecutando sol-001 dos veces (Sección 6.6)
      if (caso === "sol-001") {
        const resCrear2 = parseToolResult<{
          numero_oc: string;
          fecha: string;
          idempotente: boolean;
        }>(
          await oc_crear.execute(
            { caso, payload: resPayload.data.payload, confirmado: false },
            ctx
          )
        );
        if (resCrear2.ok && resCrear2.data) {
          console.log(
            `  • Re-ejecución : 🔁 IDEMPOTENCIA VERIFICADA en ${caso} → devuelve misma OC #${resCrear2.data.numero_oc} (idempotente=${resCrear2.data.idempotente})`
          );
        }
      }
    } else {
      // Intento sin confirmación primero (demuestra guardrail de confirmación humana)
      const resSinConfirmar = parseToolResult<{
        numero_oc: string;
        fecha: string;
        idempotente: boolean;
      }>(
        await oc_crear.execute(
          { caso, payload: resPayload.data.payload, confirmado: false },
          ctx
        )
      );
      console.log(
        `  • Intento sin confirmación: ⏸️  Detenido correctamente (${resSinConfirmar.error?.slice(0, 95)}...)`
      );

      // Confirmación humana explícita (Sección 6.6: sol-004, sol-005 retroactiva, sol-006 IVA derivado)
      const resConfirmado = parseToolResult<{
        numero_oc: string;
        fecha: string;
        idempotente: boolean;
        retroactiva: boolean;
      }>(
        await oc_crear.execute(
          { caso, payload: resPayload.data.payload, confirmado: true },
          ctx
        )
      );
      if (resConfirmado.ok && resConfirmado.data) {
        console.log(
          `  • Tras confirmar (confirmado=true): ✅ OC CREADA #${resConfirmado.data.numero_oc} (retroactiva=${resConfirmado.data.retroactiva})`
        );
      }
    }
    console.log("");
  }

  console.log("================================================================================");
  console.log("  CONTENIDO GENERADO EN out/control.csv (LOG DE AUDITORÍA Y CONTROL)");
  console.log("================================================================================");
  const controlCsv = await fs.readFile(path.join(outDir, "control.csv"), "utf-8");
  console.log(controlCsv.trim());
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Error fatal en demo.ts:", err);
  process.exit(1);
});
