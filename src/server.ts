import "dotenv/config";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  AgentMessage,
  LlmAdapter,
  ToolDefinitionSchema,
} from "./llm/adapter.js";
import { createLlmAdapter, DeterministicAgentLlmAdapter } from "./llm/gemini.js";
import * as ocTools from "./tools/oc.js";

const ROOT_DIR = process.cwd();
const PORT = Number(process.env.PORT ?? 3000);
const MAX_ITERATIONS_PER_TURN = Number(process.env.MAX_ITERATIONS_PER_TURN ?? 25);
const MAX_TOKENS_PER_SESSION = Number(process.env.MAX_TOKENS_PER_SESSION ?? 100000);

interface ToolDefinitionInternal {
  name: string;
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute: (args: Record<string, unknown>, ctx: ocTools.ToolContext) => Promise<string>;
}

interface ExecutedToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  timestamp: string;
}

interface ConversationTurn {
  userMessage: string;
  reply: string;
  toolCalls: ExecutedToolCallRecord[];
  needsConfirmation: boolean;
  timestamp: string;
}

interface SessionState {
  sessionId: string;
  messages: AgentMessage[];
  turns: ConversationTurn[];
  tokensUsed: number;
  pendingConfirmationCase: string | null;
}

const sessions = new Map<string, SessionState>();

function buildToolRegistry(): Map<string, ToolDefinitionInternal> {
  const registry = new Map<string, ToolDefinitionInternal>();
  const rawExports = ocTools as Record<string, unknown>;

  for (const [exportName, toolCandidate] of Object.entries(rawExports)) {
    if (
      typeof toolCandidate === "object" &&
      toolCandidate !== null &&
      "description" in toolCandidate &&
      "args" in toolCandidate &&
      "execute" in toolCandidate
    ) {
      const canonicalName = `oc_${exportName}`;
      const typedTool = toolCandidate as {
        description: string;
        args: Record<string, z.ZodTypeAny>;
        execute: (args: Record<string, unknown>, ctx: ocTools.ToolContext) => Promise<string>;
      };
      registry.set(canonicalName, {
        name: canonicalName,
        description: typedTool.description,
        args: typedTool.args,
        execute: typedTool.execute,
      });
    }
  }
  return registry;
}

const toolRegistry = buildToolRegistry();

function buildToolSchemasForLlm(): ToolDefinitionSchema[] {
  const schemas: ToolDefinitionSchema[] = [];

  for (const tool of toolRegistry.values()) {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const [key, zodSchema] of Object.entries(tool.args)) {
      const isOptional = zodSchema.isOptional();
      if (!isOptional) {
        required.push(key);
      }
      let fieldType = "string";
      if (key === "confirmado") {
        fieldType = "boolean";
      } else if (key === "paquete" || key === "derivados" || key === "payload") {
        fieldType = "object";
      }
      properties[key] = {
        type: fieldType,
        description: zodSchema.description ?? `Parámetro ${key}`,
      };
    }

    schemas.push({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    });
  }

  return schemas;
}

async function cargarSystemPrompt(): Promise<string> {
  const promptPath = path.join(ROOT_DIR, "agent", "prompt.md");
  const knowledgePath = path.join(ROOT_DIR, "src", "knowledge", "ordenes-compra.md");
  const [promptMd, knowledgeMd] = await Promise.all([
    fs.readFile(promptPath, "utf-8"),
    fs.readFile(knowledgePath, "utf-8"),
  ]);

  // Garantizar sincronización automática con modulo/ (Sección 9.4 PRD: cero divergencia)
  const moduloAgentHeader = [
    "---",
    "description: Agente Especialista en Auditoría, Validación de Controles (RC1-RC10) y Creación de Órdenes de Compra en SAP para Periferia IT Group.",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
  ].join("\n");
  const moduloSkillHeader = [
    "---",
    "name: ordenes-compra",
    "description: Reglas de negocio, matriz de controles (RC1-RC10), estructura de payload SAP y políticas de auditoría para Órdenes de Compra en Periferia IT Group.",
    "---",
    "",
  ].join("\n");

  await Promise.all([
    fs
      .writeFile(
        path.join(ROOT_DIR, "modulo", "agent.md"),
        `${moduloAgentHeader}${promptMd.trim()}\n`,
        "utf-8"
      )
      .catch(() => undefined),
    fs
      .writeFile(
        path.join(ROOT_DIR, "modulo", "skill", "ordenes-compra", "SKILL.md"),
        `${moduloSkillHeader}${knowledgeMd.trim()}\n`,
        "utf-8"
      )
      .catch(() => undefined),
  ]);

  return `${promptMd.trim()}\n\n---\n\n${knowledgeMd.trim()}`;
}

async function registrarLogJsonl(entry: Record<string, unknown>): Promise<void> {
  const logPath = path.join(ROOT_DIR, "out", "log.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function esMensajeConfirmacionExplicita(mensaje: string): boolean {
  const limpio = mensaje.trim();
  const tieneVerboConfirmar =
    /\b(confirmo|confirmar|autorizo|procede|proceder|si\b|sí\b|creala|créala|crear\s+oc|adelante|apruebo)\b/i.test(
      limpio
    );
  const pideNoCrear = /\bno\s+(la\s+)?(crees|confirm|proced)/i.test(limpio);
  const esNuevaSolicitudInicial = /\bprocesa\s+la\s+solicitud\b/i.test(limpio);
  return tieneVerboConfirmar && !pideNoCrear && !esNuevaSolicitudInicial;
}

export async function ejecutarTurnoAgente(
  sessionId: string,
  userMessage: string,
  customAdapter?: LlmAdapter
): Promise<{
  ok: boolean;
  reply: string;
  toolCalls: ExecutedToolCallRecord[];
  needsConfirmation: boolean;
  tokensUsed: number;
  maxTokens: number;
  error?: string;
}> {
  const adapter = customAdapter ?? createLlmAdapter();
  const systemPrompt = await cargarSystemPrompt();

  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      messages: [{ role: "system", content: systemPrompt }],
      turns: [],
      tokensUsed: 0,
      pendingConfirmationCase: null,
    };
    sessions.set(sessionId, session);
  } else {
    session.messages[0] = { role: "system", content: systemPrompt };
  }

  if (session.tokensUsed >= MAX_TOKENS_PER_SESSION) {
    return {
      ok: false,
      reply: "",
      toolCalls: [],
      needsConfirmation: false,
      tokensUsed: session.tokensUsed,
      maxTokens: MAX_TOKENS_PER_SESSION,
      error: `Se alcanzó el tope de tokens por sesión (${MAX_TOKENS_PER_SESSION} tokens). Inicia una nueva sesión para continuar.`,
    };
  }

  const usuarioConfirmoEnEsteTurno =
    session.pendingConfirmationCase !== null && esMensajeConfirmacionExplicita(userMessage);
  const usuarioPidioNoCrearHastaConfirmar =
    /\bno\s+la\s+crees\s+hasta\s+que\s+yo\s+lo\s+confirme\b/i.test(userMessage);

  // Si hay un caso pendiente de confirmación y el usuario sólo dice "confirmo",
  // inyectamos el contexto del caso pendiente para que el LLM sepa cuál caso confirmar.
  const mensajeConContexto =
    usuarioConfirmoEnEsteTurno &&
    session.pendingConfirmationCase &&
    !userMessage.toLowerCase().includes(session.pendingConfirmationCase)
      ? `${userMessage} (Confirmación humana explícita para crear la OC del caso ${session.pendingConfirmationCase} con confirmado=true)`
      : userMessage;

  session.messages.push({ role: "user", content: mensajeConContexto });

  const toolSchemas = buildToolSchemasForLlm();
  const executedToolCalls: ExecutedToolCallRecord[] = [];
  let iteraciones = 0;
  let finalReply = "";
  let needsConfirmation = false;
  let casoEnTurno: string | null = session.pendingConfirmationCase;

  while (iteraciones < MAX_ITERATIONS_PER_TURN) {
    iteraciones++;

    let llmRes;
    try {
      llmRes = await adapter.enviar(session.messages, toolSchemas);
    } catch (err) {
      // CA5: Si falla el proveedor externo (ej. timeout o cuota), intentar con el motor determinista e informar claramente
      const fallback = new DeterministicAgentLlmAdapter();
      try {
        llmRes = await fallback.enviar(session.messages);
      } catch {
        const msgError =
          err instanceof Error ? err.message : "Error de comunicación con el proveedor LLM";
        return {
          ok: true,
          reply: `⚠️ **Aviso del proveedor LLM:** No fue posible obtener respuesta del modelo (${msgError}). La sesión sigue activa; puedes reintentar tu mensaje.`,
          toolCalls: executedToolCalls,
          needsConfirmation: false,
          tokensUsed: session.tokensUsed,
          maxTokens: MAX_TOKENS_PER_SESSION,
        };
      }
    }

    if (llmRes.usage?.totalTokens) {
      session.tokensUsed += llmRes.usage.totalTokens;
    }

    if (!llmRes.toolCalls || llmRes.toolCalls.length === 0) {
      finalReply = llmRes.content;
      session.messages.push({ role: "assistant", content: finalReply });
      break;
    }

    session.messages.push({
      role: "assistant",
      content: llmRes.content,
      toolCalls: llmRes.toolCalls,
    });

    for (const tc of llmRes.toolCalls) {
      const startMs = Date.now();
      const toolDef = toolRegistry.get(tc.name);

      let resultJson: string;

      if (!toolDef) {
        resultJson = JSON.stringify({
          ok: false,
          error: `La herramienta '${tc.name}' no existe. Herramientas válidas: ${Array.from(
            toolRegistry.keys()
          ).join(", ")}`,
        });
      } else {
        // Validar argumentos con Zod antes de ejecutar (Sección 6.2 PRD)
        const zodObjectSchema = z.object(toolDef.args);
        const parsedArgs = zodObjectSchema.safeParse(tc.arguments);

        if (!parsedArgs.success) {
          resultJson = JSON.stringify({
            ok: false,
            error: `Argumentos inválidos para ${tc.name}: ${parsedArgs.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          });
        } else {
          const validArgs = { ...parsedArgs.data };
          if (typeof validArgs.caso === "string") {
            casoEnTurno = validArgs.caso;
          }

          // Guardrail CA3: Si el usuario pidió explícitamente NO crear hasta confirmar,
          // o si el modelo intenta pasar confirmado=true sin que el usuario haya confirmado en este turno
          if (tc.name === "oc_crear") {
            if (usuarioPidioNoCrearHastaConfirmar && !usuarioConfirmoEnEsteTurno) {
              resultJson = JSON.stringify({
                ok: false,
                error:
                  "Acción retenida por guardrail CA3: La usuaria solicitó explícitamente ver la previsualización y NO crear la OC hasta que ella lo confirme.",
              });
              needsConfirmation = true;
            } else {
              if (!usuarioConfirmoEnEsteTurno) {
                validArgs.confirmado = false;
              } else {
                validArgs.confirmado = true;
              }
              resultJson = await toolDef.execute(validArgs, {
                directory: ROOT_DIR,
                sessionId,
              });
            }
          } else {
            resultJson = await toolDef.execute(validArgs, {
              directory: ROOT_DIR,
              sessionId,
            });
          }
        }
      }

      const durationMs = Date.now() - startMs;
      const callRecord: ExecutedToolCallRecord = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        result: resultJson,
        durationMs,
        timestamp: new Date().toISOString(),
      };
      executedToolCalls.push(callRecord);

      // CA4: Registrar toda llamada a herramienta en out/log.jsonl
      await registrarLogJsonl({
        sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        arguments: tc.arguments,
        result: JSON.parse(resultJson),
        durationMs,
        timestamp: callRecord.timestamp,
      });

      // Detectar si oc_validar arrojó confirmaciones requeridas (y apta=true)
      if (tc.name === "oc_validar") {
        try {
          const parsedVal = JSON.parse(resultJson) as {
            ok: boolean;
            data?: { apta: boolean; confirmaciones?: unknown[]; caso?: string };
          };
          if (
            parsedVal.ok &&
            parsedVal.data?.apta &&
            ((parsedVal.data.confirmaciones?.length ?? 0) > 0 ||
              usuarioPidioNoCrearHastaConfirmar)
          ) {
            needsConfirmation = true;
            session.pendingConfirmationCase =
              parsedVal.data.caso ?? casoEnTurno ?? session.pendingConfirmationCase;
          }
        } catch {
          // ignore
        }
      }

      // Si oc_crear tuvo éxito, limpiar estado de confirmación pendiente
      if (tc.name === "oc_crear") {
        try {
          const parsedCrear = JSON.parse(resultJson) as { ok: boolean };
          if (parsedCrear.ok) {
            needsConfirmation = false;
            session.pendingConfirmationCase = null;
          } else {
            needsConfirmation = true;
          }
        } catch {
          // ignore
        }
      }

      session.messages.push({
        role: "tool",
        toolCallId: tc.id,
        toolName: tc.name,
        content: resultJson,
      });
    }
  }

  // CA1: Si se alcanzó el tope de iteraciones por turno (25)
  if (iteraciones >= MAX_ITERATIONS_PER_TURN && !finalReply) {
    finalReply = `⚠️ Se alcanzó el tope máximo de iteraciones por turno (${MAX_ITERATIONS_PER_TURN}). Herramientas ejecutadas hasta el momento: ${executedToolCalls
      .map((t) => t.name)
      .join(", ")}. Por favor continúa en el siguiente mensaje.`;
    session.messages.push({ role: "assistant", content: finalReply });
  }

  if (usuarioPidioNoCrearHastaConfirmar && casoEnTurno) {
    needsConfirmation = true;
    session.pendingConfirmationCase = casoEnTurno;
  }

  session.turns.push({
    userMessage,
    reply: finalReply,
    toolCalls: executedToolCalls,
    needsConfirmation,
    timestamp: new Date().toISOString(),
  });

  return {
    ok: true,
    reply: finalReply,
    toolCalls: executedToolCalls,
    needsConfirmation,
    tokensUsed: session.tokensUsed,
    maxTokens: MAX_TOKENS_PER_SESSION,
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

export function createAppServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // GET /api/health (Sección 6.4 PRD)
      if (method === "GET" && url.pathname === "/api/health") {
        const adapter = createLlmAdapter();
        sendJson(res, 200, {
          ok: true,
          provider: adapter.provider,
          model: adapter.model,
        });
        return;
      }

      // GET /api/sessions/:id (Sección 6.4 PRD)
      if (method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 200, {
            sessionId,
            turns: [],
            messages: [],
            tokensUsed: 0,
            maxTokens: MAX_TOKENS_PER_SESSION,
          });
          return;
        }
        sendJson(res, 200, {
          sessionId: session.sessionId,
          turns: session.turns,
          messages: session.messages.filter((m) => m.role !== "system"),
          tokensUsed: session.tokensUsed,
          maxTokens: MAX_TOKENS_PER_SESSION,
          pendingConfirmationCase: session.pendingConfirmationCase,
        });
        return;
      }

      // GET /api/audit (Para visualización en vivo de out/sap/ordenes.jsonl y out/control.csv)
      if (method === "GET" && url.pathname === "/api/audit") {
        let ordenes: unknown[] = [];
        let controlCsv = "";
        try {
          const rawOrd = await fs.readFile(
            path.join(ROOT_DIR, "out", "sap", "ordenes.jsonl"),
            "utf-8"
          );
          ordenes = rawOrd
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as unknown);
        } catch {
          ordenes = [];
        }
        try {
          controlCsv = await fs.readFile(path.join(ROOT_DIR, "out", "control.csv"), "utf-8");
        } catch {
          controlCsv = "";
        }
        sendJson(res, 200, { ok: true, ordenes, controlCsv });
        return;
      }

      // POST /api/chat (Sección 6.4 PRD)
      if (method === "POST" && url.pathname === "/api/chat") {
        const bodyRaw = await readBody(req);
        let parsedBody: { sessionId?: string; message?: string };
        try {
          parsedBody = JSON.parse(bodyRaw) as { sessionId?: string; message?: string };
        } catch {
          sendJson(res, 400, { ok: false, error: "JSON malformado en el cuerpo de la petición." });
          return;
        }

        const sessionId = parsedBody.sessionId?.trim() || "default-session";
        const message = parsedBody.message?.trim() || "";

        if (!message) {
          sendJson(res, 400, { ok: false, error: "El campo 'message' es obligatorio." });
          return;
        }

        const resultado = await ejecutarTurnoAgente(sessionId, message);
        sendJson(res, 200, resultado);
        return;
      }

      // Servir Frontend Web (GET /)
      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const htmlPath = path.join(ROOT_DIR, "web", "index.html");
        const html = await fs.readFile(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Ruta no encontrada: ${url.pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : "Error interno del servidor",
      });
    }
  });
}

// Iniciar servidor si se ejecuta directamente
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(ROOT_DIR, "src", "server.ts").toLowerCase();

if (isMain) {
  const server = createAppServer();
  server.listen(PORT, () => {
    const adapter = createLlmAdapter();
    console.log("==================================================================");
    console.log(`🚀 Servidor Agente SAP Órdenes de Compra activo en http://localhost:${PORT}`);
    console.log(`🤖 Proveedor LLM : ${adapter.provider} (${adapter.model})`);
    console.log(`🛡️  Tope Iter/Turn: ${MAX_ITERATIONS_PER_TURN} | Tope Tokens/Sesión: ${MAX_TOKENS_PER_SESSION}`);
    console.log("==================================================================");
  });
}
