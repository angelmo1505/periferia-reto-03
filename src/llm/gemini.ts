import {
  AgentMessage,
  LlmAdapter,
  LlmResponse,
  ToolCallRequest,
  ToolDefinitionSchema,
} from "./adapter.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);

export class GeminiLlmAdapter implements LlmAdapter {
  readonly provider = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model = "gemini-2.5-flash", timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async enviar(
    mensajes: AgentMessage[],
    herramientas: ToolDefinitionSchema[]
  ): Promise<LlmResponse> {
    const systemMsg = mensajes.find((m) => m.role === "system")?.content ?? "";
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of mensajes) {
      if (msg.role === "system") continue;
      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
      } else if (msg.role === "tool") {
        let parsedResponse: unknown = { result: msg.content };
        try {
          parsedResponse = JSON.parse(msg.content);
        } catch {
          parsedResponse = { result: msg.content };
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolName ?? "tool",
                response:
                  typeof parsedResponse === "object" && parsedResponse !== null
                    ? parsedResponse
                    : { result: parsedResponse },
              },
            },
          ],
        });
      }
    }

    const functionDeclarations = herramientas.map((h) => ({
      name: h.name,
      description: h.description,
      parameters: h.parameters,
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        ...(systemMsg
          ? { systemInstruction: { parts: [{ text: systemMsg }] } }
          : {}),
        contents,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        generationConfig: {
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Error del proveedor Gemini (HTTP ${response.status}): ${errText.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const part of parts) {
      if (part.text) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    return {
      content: textParts.join("\n").trim(),
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }
}

export class OpenAiCompatibleLlmAdapter implements LlmAdapter {
  readonly provider: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    model = "gpt-4o-mini",
    baseUrl = "https://api.openai.com/v1",
    providerName = "openai",
    timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.provider = providerName;
    this.timeoutMs = timeoutMs;
  }

  async enviar(
    mensajes: AgentMessage[],
    herramientas: ToolDefinitionSchema[]
  ): Promise<LlmResponse> {
    const formattedMessages = mensajes.map((m) => {
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId ?? "call_0",
          content: m.content,
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

    const tools = herramientas.map((h) => ({
      type: "function",
      function: {
        name: h.name,
        description: h.description,
        parameters: h.parameters,
      },
    }));

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: formattedMessages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Error del proveedor ${this.provider} (HTTP ${response.status}): ${errText.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
    }));

    return {
      content: msg?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }
}

export class AnthropicLlmAdapter implements LlmAdapter {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    model = "claude-3-5-haiku-latest",
    timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async enviar(
    mensajes: AgentMessage[],
    herramientas: ToolDefinitionSchema[]
  ): Promise<LlmResponse> {
    const systemMsg = mensajes.find((m) => m.role === "system")?.content ?? "";
    const anthropicMessages: Array<Record<string, unknown>> = [];

    for (const m of mensajes) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        anthropicMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (m.content) {
          contentBlocks.push({ type: "text", text: m.content });
        }
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        anthropicMessages.push({ role: "assistant", content: contentBlocks });
      } else if (m.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId ?? "call_0",
              content: m.content,
            },
          ],
        });
      }
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemMsg,
        messages: anthropicMessages,
        tools: herramientas.map((h) => ({
          name: h.name,
          description: h.description,
          input_schema: h.parameters,
        })),
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Error del proveedor Anthropic (HTTP ${response.status}): ${errText.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textParts: string[] = [];
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content ?? []) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          id: block.id ?? `call_${Date.now()}`,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }

    const inTok = data.usage?.input_tokens ?? 0;
    const outTok = data.usage?.output_tokens ?? 0;
    return {
      content: textParts.join("\n").trim(),
      toolCalls,
      usage: {
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: inTok + outTok,
      },
    };
  }
}

/**
 * Orquestador determinista de respaldo que ejecuta el mismo ciclo de herramientas
 * reales (`oc_leer_paquete` -> `oc_validar` -> `oc_construir_payload` -> `oc_generar_evidencia` -> `oc_crear`)
 * cuando aún no se ha configurado una API Key externa o cuando se selecciona LLM_PROVIDER=deterministic.
 */
export class DeterministicAgentLlmAdapter implements LlmAdapter {
  readonly provider = "periferia-deterministic-engine";
  readonly model = "oc-rule-orchestrator-v2";

  async enviar(mensajes: AgentMessage[]): Promise<LlmResponse> {
    // Encontrar el último mensaje del usuario
    let lastUserIdx = -1;
    for (let i = mensajes.length - 1; i >= 0; i--) {
      if (mensajes[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const lastUserText = lastUserIdx >= 0 ? mensajes[lastUserIdx].content : "";
    const turnToolMessages = mensajes.slice(lastUserIdx + 1).filter((m) => m.role === "tool");

    // Detectar qué caso (sol-001 a sol-006) está en la conversación
    let casoDetectado: string | null = null;
    for (let i = mensajes.length - 1; i >= 0; i--) {
      const match = mensajes[i].content.match(/\b(sol-00[1-6])\b/i);
      if (match) {
        casoDetectado = match[1].toLowerCase();
        break;
      }
    }

    const esConfirmacionUsuario =
      /\b(confirmo|confirmar|autorizo|procede|proceder|si\b|sí\b|creala|créala|crear|adelante|apruebo)\b/i.test(
        lastUserText
      ) && !/\bno\s+(la\s+)?(crees|confirm|proced)/i.test(lastUserText);

    const pidioNoCrearAun = /\bno\s+la\s+crees\s+hasta\s+que\s+yo\s+lo\s+confirme\b/i.test(
      lastUserText
    );

    if (!casoDetectado) {
      return {
        content:
          "Hola, soy el **Agente de Órdenes de Compra SAP** de Periferia IT Group. Indícame qué solicitud deseas procesar (por ejemplo: `Procesa la solicitud sol-001` o `Procesa la solicitud sol-004 y muéstrame cómo quedaría en SAP`).\n\nCasos disponibles en `fixtures/reto-03/solicitudes/`:\n- `sol-001` (Flujo normal - Antivirus)\n- `sol-002` (Proveedor no registrado)\n- `sol-003` (Aprobador sin autoridad en centro de costo)\n- `sol-004` (Diferencia cotización vs solicitud > 2%)\n- `sol-005` (Factura previa - OC retroactiva)\n- `sol-006` (IVA y condiciones de pago derivados del maestro)",
        toolCalls: [],
        usage: { inputTokens: 120, outputTokens: 95, totalTokens: 215 },
      };
    }

    // Si el usuario acaba de confirmar en un turno posterior, ejecutar oc_crear con confirmado=true
    if (
      esConfirmacionUsuario &&
      !lastUserText.toLowerCase().includes("procesa") &&
      turnToolMessages.length === 0
    ) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_crear_${Date.now()}`,
            name: "oc_crear",
            arguments: { caso: casoDetectado, confirmado: true },
          },
        ],
        usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
      };
    }

    // Paso 1: Si aún no hemos llamado oc_leer_paquete en este turno
    const msgPaquete = turnToolMessages.find((m) => m.toolName === "oc_leer_paquete");
    if (!msgPaquete && !turnToolMessages.some((m) => m.toolName === "oc_crear")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_leer_${Date.now()}`,
            name: "oc_leer_paquete",
            arguments: { caso: casoDetectado },
          },
        ],
        usage: { inputTokens: 140, outputTokens: 35, totalTokens: 175 },
      };
    }

    // Paso 2: Llamar oc_validar
    const msgValidar = turnToolMessages.find((m) => m.toolName === "oc_validar");
    if (!msgValidar && !turnToolMessages.some((m) => m.toolName === "oc_crear")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_val_${Date.now()}`,
            name: "oc_validar",
            arguments: { caso: casoDetectado },
          },
        ],
        usage: { inputTokens: 220, outputTokens: 35, totalTokens: 255 },
      };
    }

    // Analizar resultado de validación si ya existe
    if (msgValidar) {
      const valParsed = JSON.parse(msgValidar.content) as {
        ok: boolean;
        data?: {
          apta: boolean;
          solicitud_id: string;
          retroactiva: boolean;
          bloqueos: Array<{ codigo: string; regla: string; detalle: string; accion_sugerida: string }>;
          confirmaciones: Array<{ codigo: string; regla: string; detalle: string; accion_sugerida: string }>;
          derivados: { notas?: string[] };
          controles: Array<{ codigo: string; nombre: string; estado: string; detalle: string }>;
        };
      };

      const val = valParsed.data;
      if (!val) {
        return {
          content: `No fue posible validar el caso \`${casoDetectado}\`.`,
          toolCalls: [],
        };
      }

      // Si NO es apta (tiene bloqueos), no construye ni crea la OC
      if (!val.apta) {
        const tablaControles = val.controles
          .map(
            (c) =>
              `| **${c.codigo}** | ${c.nombre} | ${c.estado === "OK" ? "✅ OK" : "❌ BLOQUEO"} | ${c.detalle} |`
          )
          .join("\n");

        const detalleBloqueos = val.bloqueos
          .map(
            (b) =>
              `- ❌ **[${b.codigo}] ${b.regla}:** ${b.detalle}\n  - **Acción sugerida:** ${b.accion_sugerida}`
          )
          .join("\n");

        return {
          content: `### ❌ Solicitud \`${val.solicitud_id}\` (\`${casoDetectado}\`) — BLOQUEADA POR CONTROLES\n\nLa solicitud **no cumple** con los controles obligatorios y **no se ha creado la Orden de Compra en SAP**.\n\n#### Matriz de Controles Evaluada\n| Regla | Control | Estado | Detalle |\n|---|---|---|---|\n${tablaControles}\n\n#### Bloqueos Detectados y Acción Recomendada\n${detalleBloqueos}`,
          toolCalls: [],
          usage: { inputTokens: 350, outputTokens: 220, totalTokens: 570 },
        };
      }

      // Si es apta, asegurar oc_construir_payload y oc_generar_evidencia
      const msgPayload = turnToolMessages.find((m) => m.toolName === "oc_construir_payload");
      if (!msgPayload) {
        return {
          content: "",
          toolCalls: [
            {
              id: `call_pay_${Date.now()}`,
              name: "oc_construir_payload",
              arguments: { caso: casoDetectado },
            },
            {
              id: `call_evi_${Date.now()}`,
              name: "oc_generar_evidencia",
              arguments: { caso: casoDetectado },
            },
          ],
          usage: { inputTokens: 280, outputTokens: 55, totalTokens: 335 },
        };
      }

      const msgCrear = turnToolMessages.find((m) => m.toolName === "oc_crear");

      // Si no tiene confirmaciones pendientes y no pidió detenerse antes de confirmar -> crear automáticamente
      if (val.confirmaciones.length === 0 && !pidioNoCrearAun && !msgCrear) {
        return {
          content: "",
          toolCalls: [
            {
              id: `call_crear_auto_${Date.now()}`,
              name: "oc_crear",
              arguments: { caso: casoDetectado, confirmado: false },
            },
          ],
          usage: { inputTokens: 310, outputTokens: 40, totalTokens: 350 },
        };
      }

      const payloadParsed = JSON.parse(msgPayload.content) as {
        ok: boolean;
        data?: { payload: Record<string, unknown>; ruta_trazabilidad: string };
      };
      const p = payloadParsed.data?.payload as {
        referencia: { solicitud_id: string; cotizacion_ref: string | null };
        sociedad: string;
        organizacion_compras: string;
        proveedor: { codigo_sap: string; nit: string; nombre: string };
        moneda: string;
        condiciones_pago: string;
        aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string };
        posiciones: Array<{
          numero: number;
          descripcion: string;
          cantidad: number;
          unidad: string;
          precio_unitario: number;
          centro_costo: string;
          subarea: string;
          indicador_iva: string;
        }>;
      };
      const pos = p.posiciones[0];

      const tablaPayload = [
        `| Campo SAP | Valor en Payload |`,
        `|---|---|`,
        `| **Solicitud / Cotización** | \`${p.referencia.solicitud_id}\` / \`${p.referencia.cotizacion_ref ?? "N/A"}\` |`,
        `| **Sociedad / Org. Compras** | \`${p.sociedad}\` / \`${p.organizacion_compras}\` |`,
        `| **Proveedor SAP** | \`${p.proveedor.codigo_sap}\` — ${p.proveedor.nombre} (NIT \`${p.proveedor.nit}\`) |`,
        `| **Posición 10 (Texto breve ≤40c)** | \`${pos.descripcion}\` |`,
        `| **Cantidad × Precio Unitario** | ${pos.cantidad} ${pos.unidad} × ${p.moneda} ${pos.precio_unitario.toLocaleString("es-CO")} = **${p.moneda} ${(pos.cantidad * pos.precio_unitario).toLocaleString("es-CO")}** |`,
        `| **Imputación (CC / Subárea)** | \`${pos.centro_costo}\` / \`${pos.subarea}\` |`,
        `| **Indicador IVA / Cond. Pago** | \`${pos.indicador_iva}\` / \`${p.condiciones_pago}\` |`,
        `| **Aprobador / SHA-256** | \`${p.aprobador.email}\` (\`${p.aprobador.evidencia_sha256.slice(0, 16)}...\`) |`,
      ].join("\n");

      const tablaControles = val.controles
        .map((c) => {
          const badge =
            c.estado === "OK"
              ? "✅ OK"
              : c.estado === "DERIVADO_INFO"
                ? "ℹ️ DERIVADO"
                : "⚠️ CONFIRMACIÓN";
          return `| **${c.codigo}** | ${c.nombre} | ${badge} | ${c.detalle} |`;
        })
        .join("\n");

      // Si ya se creó la OC en este turno (ej. sol-001 automático)
      if (msgCrear) {
        const crearParsed = JSON.parse(msgCrear.content) as {
          ok: boolean;
          data?: {
            numero_oc: string;
            fecha: string;
            idempotente: boolean;
            retroactiva: boolean;
            evidencia_txt: string;
            evidencia_pdf: string;
            trazabilidad: string;
          };
        };
        const cData = crearParsed.data;
        return {
          content: `### ✅ Orden de Compra Creada Exitosamente en SAP: **#${cData?.numero_oc}**\n\nLa solicitud **\`${val.solicitud_id}\` (\`${casoDetectado}\`)** superó todos los controles sin excepciones.\n\n#### Resumen del Payload SAP Creado\n${tablaPayload}\n\n#### Matriz de Controles (RC1–RC10)\n| Regla | Control | Estado | Detalle |\n|---|---|---|---|\n${tablaControles}\n\n#### Artefactos de Auditoría Generados\n- **Número OC SAP:** \`${cData?.numero_oc}\` (${cData?.idempotente ? "Registro idempotente recuperado" : "Nueva orden creada"})\n- **Evidencia TXT:** \`${cData?.evidencia_txt}\`\n- **Evidencia PDF:** \`${cData?.evidencia_pdf}\`\n- **Trazabilidad:** \`${cData?.trazabilidad}\``,
          toolCalls: [],
          usage: { inputTokens: 420, outputTokens: 260, totalTokens: 680 },
        };
      }

      // Si requiere confirmación humana (sol-004, sol-005, sol-006 o petición explícita)
      const listaConfirmaciones = val.confirmaciones
        .map(
          (c) =>
            `- ⚠️ **[${c.codigo}] ${c.regla}:** ${c.detalle}\n  - *Recomendación:* ${c.accion_sugerida}`
        )
        .join("\n");

      const notasDerivados =
        val.derivados.notas && val.derivados.notas.length > 0
          ? `\n#### ℹ️ Valores Derivados desde Maestros\n${val.derivados.notas.map((n) => `- ${n}`).join("\n")}\n`
          : "";

      return {
        content: `### ⚠️ Previsualización de OC para \`${val.solicitud_id}\` (\`${casoDetectado}\`) — Confirmación Requerida\n\nLa solicitud no presenta bloqueos duros (\`apta = true\`), pero requiere tu **confirmación explícita** antes de registrarla en SAP${val.retroactiva ? " (**⚠️ Compra Retroactiva Detectada: `retroactiva = true`**)" : ""}.\n\n#### Vista Previa del Payload SAP\n${tablaPayload}\n${notasDerivados}\n#### Matriz de Controles Evaluada\n| Regla | Control | Estado | Detalle |\n|---|---|---|---|\n${tablaControles}\n\n#### Excepciones que Requieren tu Confirmación\n${listaConfirmaciones}\n\n---\n**¿Confirmas la creación de la Orden de Compra en SAP para \`${casoDetectado}\` bajo estas condiciones?** *(Responde "Confirmo" o usa el botón de confirmación para proceder)*`,
        toolCalls: [],
        usage: { inputTokens: 410, outputTokens: 280, totalTokens: 690 },
      };
    }

    // Si este turno fue directamente la ejecución de oc_crear tras confirmación
    const msgCrearDirecto = turnToolMessages.find((m) => m.toolName === "oc_crear");
    if (msgCrearDirecto) {
      const crearParsed = JSON.parse(msgCrearDirecto.content) as {
        ok: boolean;
        data?: {
          numero_oc: string;
          fecha: string;
          idempotente: boolean;
          retroactiva: boolean;
          evidencia_txt: string;
          evidencia_pdf: string;
          evidencia_sha256: string;
          trazabilidad: string;
        };
        error?: string;
      };
      if (!crearParsed.ok || !crearParsed.data) {
        return {
          content: `❌ No se pudo crear la Orden de Compra: ${crearParsed.error}`,
          toolCalls: [],
        };
      }
      const d = crearParsed.data;
      return {
        content: `### ✅ Confirmación Recibida — Orden de Compra **#${d.numero_oc}** Creada en SAP\n\nSe ha registrado la Orden de Compra para el caso **\`${casoDetectado}\`** tras tu confirmación explícita.\n\n| Atributo | Valor Registrado |\n|---|---|\n| **Número de OC SAP** | **\`${d.numero_oc}\`** |\n| **Fecha de Creación** | \`${d.fecha}\` |\n| **Idempotente** | \`${d.idempotente}\` |\n| **Marcada como Retroactiva** | \`${d.retroactiva}\` |\n| **Evidencia Aprobación (TXT)** | \`${d.evidencia_txt}\` |\n| **Evidencia Aprobación (PDF)** | \`${d.evidencia_pdf}\` |\n| **Hash SHA-256 Evidencia** | \`${d.evidencia_sha256}\` |\n| **Matriz de Trazabilidad** | \`${d.trazabilidad}\` |`,
        toolCalls: [],
        usage: { inputTokens: 210, outputTokens: 160, totalTokens: 370 },
      };
    }

    return {
      content: `Procesamiento finalizado para \`${casoDetectado}\`.`,
      toolCalls: [],
    };
  }
}

export function createLlmAdapter(): LlmAdapter {
  const providerPref = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase().trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (
    providerPref === "gemini" &&
    geminiKey &&
    geminiKey !== "tu_api_key_aqui"
  ) {
    return new GeminiLlmAdapter(
      geminiKey,
      process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    );
  }

  if (providerPref === "openai" && openaiKey) {
    return new OpenAiCompatibleLlmAdapter(
      openaiKey,
      process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      "openai"
    );
  }

  if (providerPref === "anthropic" && anthropicKey) {
    return new AnthropicLlmAdapter(
      anthropicKey,
      process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest"
    );
  }

  // Auto-detectar cualquier clave válida disponible en entorno
  if (geminiKey && geminiKey !== "tu_api_key_aqui") {
    return new GeminiLlmAdapter(
      geminiKey,
      process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    );
  }
  if (openaiKey) {
    return new OpenAiCompatibleLlmAdapter(
      openaiKey,
      process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini"
    );
  }
  if (anthropicKey) {
    return new AnthropicLlmAdapter(
      anthropicKey,
      process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest"
    );
  }

  return new DeterministicAgentLlmAdapter();
}
