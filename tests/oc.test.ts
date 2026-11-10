import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { AddressInfo } from "node:net";
import path from "node:path";
import { before, describe, it } from "node:test";
import * as moduloOcTools from "../modulo/tools/oc.js";
import { DeterministicAgentLlmAdapter } from "../src/llm/gemini.js";
import { createAppServer, ejecutarTurnoAgente } from "../src/server.js";
import * as srcOcTools from "../src/tools/oc.js";
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

const rootDir = process.cwd();
const ctx: ToolContext = { directory: rootDir, sessionId: "test-session" };

describe("Reto 03 · Herramientas Deterministas, Matriz RC1-RC10, Errores y API HTTP", () => {
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
    assert.equal(resVal.data.bloqueos.some((b) => b.codigo === "RC3"), true);
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
    ) as { ok: boolean; data: { sociedad: string; ruta_trazabilidad: string } };
    assert.equal(resPayload.ok, true);
    assert.equal(resPayload.data.sociedad, "1000");

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

  it("RC4, RC9, RC10 y proveedor inactivo: valida casos sintéticos de borde y manejo de errores HU-6", async () => {
    // 1. Caso inexistente nunca lanza excepción, devuelve { ok: false, error }
    const resNoExiste = JSON.parse(
      await leer_paquete.execute({ caso: "sol-999" }, ctx)
    ) as { ok: boolean; error: string };
    assert.equal(resNoExiste.ok, false);
    assert.equal(typeof resNoExiste.error, "string");

    // 2. Caso sintético con proveedor inactivo (901777888), subárea inválida (RC4), fecha aprobación previa (RC9) y error aritmético (RC10)
    const basePaquete = JSON.parse(
      await leer_paquete.execute({ caso: "sol-001" }, ctx)
    ) as { ok: boolean; data: Paquete };

    const paqueteBorde: Paquete = {
      ...basePaquete.data,
      solicitud: {
        ...basePaquete.data.solicitud,
        proveedor_nit: "901777888", // Consultores Ágiles S.A.S. (activo: false)
        subarea: "SubareaInexistente", // RC4
        cantidad: 10,
        valor_unitario: 100000,
        valor_total: 9999999, // RC10: 10 * 100000 != 9999999
        fecha_solicitud: "2026-08-25",
      },
      aprobacion: {
        de: "mlopez@periferia-ficticia.com",
        fecha: "2026-08-20T10:00:00-05:00", // RC9: fecha aprobación < fecha solicitud
        aprobado: true,
        texto: "Aprobado",
      },
    };

    const resBorde = JSON.parse(
      await validar.execute({ caso: "sol-001", paquete: paqueteBorde }, ctx)
    ) as { ok: boolean; data: ResultadoValidacion };

    assert.equal(resBorde.ok, true);
    assert.equal(resBorde.data.apta, false);
    assert.equal(resBorde.data.bloqueos.some((b) => b.codigo === "RC1"), true);
    assert.equal(resBorde.data.bloqueos.some((b) => b.codigo === "RC4"), true);
    assert.equal(resBorde.data.bloqueos.some((b) => b.codigo === "RC10"), true);
    assert.equal(resBorde.data.confirmaciones.some((c) => c.codigo === "RC9"), true);
  });

  it("Bonus §9.4: modulo/tools/oc.ts exporta exactamente las mismas referencias de función que src/tools/oc.ts", () => {
    assert.strictEqual(moduloOcTools.leer_paquete, srcOcTools.leer_paquete);
    assert.strictEqual(moduloOcTools.validar, srcOcTools.validar);
    assert.strictEqual(moduloOcTools.construir_payload, srcOcTools.construir_payload);
    assert.strictEqual(moduloOcTools.generar_evidencia, srcOcTools.generar_evidencia);
    assert.strictEqual(moduloOcTools.crear, srcOcTools.crear);
    assert.strictEqual(moduloOcTools.leer_excel, srcOcTools.leer_excel);
  });

  it("API HTTP End-to-End: GET /, GET /api/health, POST /api/chat y GET /api/sessions/:id", async () => {
    const server = createAppServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Health check
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { ok: boolean; provider: string };
      assert.equal(healthJson.ok, true);

      // 2. Frontend HTML
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.equal(htmlText.includes("Periferia IT Group"), true);

      // 3. POST /api/chat con prompt oficial de la Sección 11 (sol-004)
      const chatRes1 = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "e2e-http-session",
          message:
            'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
        }),
      });
      assert.equal(chatRes1.status, 200);
      const chatJson1 = (await chatRes1.json()) as {
        ok: boolean;
        needsConfirmation: boolean;
        toolCalls: Array<{ name: string }>;
      };
      assert.equal(chatJson1.ok, true);
      assert.equal(chatJson1.needsConfirmation, true);
      assert.equal(chatJson1.toolCalls.some((t) => t.name === "oc_validar"), true);
      assert.equal(chatJson1.toolCalls.some((t) => t.name === "oc_crear"), false);

      // 4. GET /api/sessions/e2e-http-session
      const sesRes = await fetch(`${baseUrl}/api/sessions/e2e-http-session`);
      assert.equal(sesRes.status, 200);
      const sesJson = (await sesRes.json()) as { turns: unknown[] };
      assert.equal(sesJson.turns.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
