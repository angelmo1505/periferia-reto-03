import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_excel,
  leer_paquete,
  Paquete,
  ResultadoValidacion,
  ToolContext,
  validar,
} from "../src/tools/oc.js";
import { DeterministicAgentLlmAdapter } from "../src/llm/gemini.js";
import { ejecutarTurnoAgente } from "../src/server.js";

const rootDir = process.cwd();
const ctx: ToolContext = { directory: rootDir, sessionId: "test-session" };

describe("Reto 03 · Herramientas Deterministas y Matriz de Controles (RC1-RC10)", () => {
  before(async () => {
    await fs.rm(path.join(rootDir, "out"), { recursive: true, force: true });
  });

  it("sol-001: flujo normal aprueba todos los controles, crea OC 4500000001 y garantiza idempotencia", async () => {
    const resPaquete = JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, ctx)) as {
      ok: boolean;
      data: Paquete;
    };
    assert.equal(resPaquete.ok, true);
    assert.equal(resPaquete.data.solicitud.solicitud_id, "SOL-2026-001");

    const resVal = JSON.parse(
      await validar.execute({ caso: "sol-001", paquete: resPaquete.data }, ctx)
    ) as { ok: boolean; data: ResultadoValidacion };
    assert.equal(resVal.ok, true);
    assert.equal(resVal.data.apta, true);
    assert.equal(resVal.data.bloqueos.length, 0);
    assert.equal(resVal.data.confirmaciones.length, 0);
    assert.equal(resVal.data.retroactiva, false);

    const resCrear1 = JSON.parse(
      await crear.execute({ caso: "sol-001", confirmado: false }, ctx)
    ) as { ok: boolean; data: { numero_oc: string; idempotente: boolean } };
    assert.equal(resCrear1.ok, true);
    assert.equal(resCrear1.data.numero_oc, "4500000001");
    assert.equal(resCrear1.data.idempotente, false);

    // Segunda ejecución: debe devolver exactamente la misma OC (idempotencia)
    const resCrear2 = JSON.parse(
      await crear.execute({ caso: "sol-001", confirmado: false }, ctx)
    ) as { ok: boolean; data: { numero_oc: string; idempotente: boolean } };
    assert.equal(resCrear2.ok, true);
    assert.equal(resCrear2.data.numero_oc, "4500000001");
    assert.equal(resCrear2.data.idempotente, true);
  });

  it("sol-002: bloquea por RC1 (proveedor inexistente) e impide crear OC", async () => {
    const resVal = JSON.parse(await validar.execute({ caso: "sol-002" }, ctx)) as {
      ok: boolean;
      data: ResultadoValidacion;
    };
    assert.equal(resVal.data.apta, false);
    assert.equal(resVal.data.bloqueos.some((b) => b.codigo === "RC1"), true);

    const resCrear = JSON.parse(
      await crear.execute({ caso: "sol-002", confirmado: true }, ctx)
    ) as { ok: boolean; error: string };
    assert.equal(resCrear.ok, false);
  });

  it("sol-003: bloquea por RC2/RC3 (aprobador sin autoridad en CC-2020 y monto > tope)", async () => {
    const resVal = JSON.parse(await validar.execute({ caso: "sol-003" }, ctx)) as {
      ok: boolean;
      data: ResultadoValidacion;
    };
    assert.equal(resVal.data.apta, false);
    assert.equal(resVal.data.bloqueos.some((b) => b.codigo === "RC2"), true);
  });

  it("sol-004: detecta RC5 (diferencia cotización vs solicitud > 2%), bloquea sin confirmación y crea con confirmación", async () => {
    const resVal = JSON.parse(await validar.execute({ caso: "sol-004" }, ctx)) as {
      ok: boolean;
      data: ResultadoValidacion;
    };
    assert.equal(resVal.data.apta, true);
    assert.equal(resVal.data.confirmaciones.some((c) => c.codigo === "RC5"), true);

    const resSinConfirmar = JSON.parse(
      await crear.execute({ caso: "sol-004", confirmado: false }, ctx)
    ) as { ok: boolean };
    assert.equal(resSinConfirmar.ok, false);

    const resConfirmado = JSON.parse(
      await crear.execute({ caso: "sol-004", confirmado: true }, ctx)
    ) as { ok: boolean; data: { numero_oc: string } };
    assert.equal(resConfirmado.ok, true);
    assert.equal(resConfirmado.data.numero_oc, "4500000002");
  });

  it("sol-005: detecta RC8 (factura previa -> retroactiva = true) y registra en control.csv", async () => {
    const resVal = JSON.parse(await validar.execute({ caso: "sol-005" }, ctx)) as {
      ok: boolean;
      data: ResultadoValidacion;
    };
    assert.equal(resVal.data.apta, true);
    assert.equal(resVal.data.retroactiva, true);
    assert.equal(resVal.data.confirmaciones.some((c) => c.codigo === "RC8"), true);

    const resConfirmado = JSON.parse(
      await crear.execute({ caso: "sol-005", confirmado: true }, ctx)
    ) as { ok: boolean; data: { numero_oc: string; retroactiva: boolean } };
    assert.equal(resConfirmado.ok, true);
    assert.equal(resConfirmado.data.retroactiva, true);
  });

  it("sol-006: deriva NIT (RC1), IVA C1 con confirmación (RC6) y condiciones Z030 informativo (RC7)", async () => {
    const resVal = JSON.parse(await validar.execute({ caso: "sol-006" }, ctx)) as {
      ok: boolean;
      data: ResultadoValidacion;
    };
    assert.equal(resVal.data.apta, true);
    assert.equal(resVal.data.derivados.proveedor_nit, "900555111");
    assert.equal(resVal.data.derivados.indicador_iva, "C1");
    assert.equal(resVal.data.derivados.condiciones_pago, "Z030");
    assert.equal(resVal.data.confirmaciones.some((c) => c.codigo === "RC6"), true);

    const resPayload = JSON.parse(
      await construir_payload.execute({ caso: "sol-006" }, ctx)
    ) as { ok: boolean; data: { ruta_trazabilidad: string } };
    assert.equal(resPayload.ok, true);

    const resEvidencia = JSON.parse(
      await generar_evidencia.execute({ caso: "sol-006" }, ctx)
    ) as { ok: boolean; data: { ruta: string; ruta_pdf: string; sha256: string } };
    assert.equal(resEvidencia.ok, true);
    assert.equal(resEvidencia.data.sha256.length, 64);

    const resExcel = JSON.parse(
      await leer_excel.execute(
        { ruta: "fixtures/reto-03/solicitudes/sol-006/solicitud.xlsx" },
        ctx
      )
    ) as { ok: boolean; data: { filas: unknown[] } };
    assert.equal(resExcel.ok, true);
    assert.equal(resExcel.data.filas.length, 1);
  });

  it("Ciclo conversacional del agente: detiene sol-004 pidiendo confirmación y la crea al confirmar", async () => {
    const adapter = new DeterministicAgentLlmAdapter();
    const turno1 = await ejecutarTurnoAgente(
      "test-chat-sol-004",
      'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
      adapter
    );
    assert.equal(turno1.ok, true);
    assert.equal(turno1.needsConfirmation, true);
    assert.equal(turno1.toolCalls.some((t) => t.name === "oc_validar"), true);
    assert.equal(turno1.toolCalls.some((t) => t.name === "oc_crear"), false);

    const turno2 = await ejecutarTurnoAgente(
      "test-chat-sol-004",
      "Confirmo",
      adapter
    );
    assert.equal(turno2.ok, true);
    assert.equal(turno2.needsConfirmation, false);
    assert.equal(turno2.toolCalls.some((t) => t.name === "oc_crear"), true);
  });
});
