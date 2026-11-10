# Reto Técnico 03 — Agente Conversacional "Órdenes de Compra SAP" (Periferia IT Group)

Agente conversacional de extremo a extremo en **TypeScript (Node 20+ / Bun)** para automatizar la lectura, auditoría de controles (`RC1`–`RC10`), generación de evidencia criptográfica (`TXT` y `PDF` con `SHA-256`), previsualización de payload y creación idempotente de Órdenes de Compra en SAP.

- 🌐 **Enlace Público en Vivo (Producción - Render):** **[https://periferia-reto-03.onrender.com](https://periferia-reto-03.onrender.com)** *(Acceso público, no requiere contraseña)*
- 📦 **Repositorio GitHub:** **[https://github.com/angelmo1505/periferia-reto-03](https://github.com/angelmo1505/periferia-reto-03)**

---

## 🚀 1. Cómo levantar en local (Un solo comando)

### Requisitos previos
- **Node.js 20+** (probado en `v22.22.3`) o **Bun 1.1+**.

### Instalación y Arranque
```bash
# 1. Instalar dependencias
npm install

# 2. (Opcional) Configurar clave de modelo LLM
cp .env.example .env
# Edita .env y agrega tu GEMINI_API_KEY, OPENAI_API_KEY o ANTHROPIC_API_KEY.
# Nota: Si no configuras una API Key externa, el servidor funciona igualmente
# usando el orquestador determinista local integrado sobre las herramientas reales.

# 3. Levantar Frontend + Backend en un solo comando
npm run dev
```

Abre en tu navegador: **[http://localhost:3000](http://localhost:3000)**

---

## 🧪 2. Cómo ejecutar `demo.ts` (Verificación Determinista sin LLM)

El script `demo.ts` limpia la carpeta `out/` y procesa los 6 casos de prueba (`sol-001` a `sol-006`) invocando directamente las herramientas de `src/tools/oc.ts` sin requerir clave de ningún proveedor LLM. Además demuestra la **idempotencia** ejecutando `sol-001` dos veces y la **confirmación explícita** en `sol-004`, `sol-005` y `sol-006`:

```bash
npm run demo
# o con Bun:
bun run demo.ts
```

Para correr la suite de pruebas automatizadas (`node:test`):
```bash
npm test
```

---

## ⚙️ 3. Variables de Entorno (`.env.example`)

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `LLM_PROVIDER` | Proveedor a usar: `gemini`, `openai`, `anthropic` o `deterministic` | `gemini` |
| `GEMINI_API_KEY` | Clave de API de Google Gemini (solo backend, nunca expuesta) | - |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-2.5-flash` |
| `OPENAI_API_KEY` | Clave de API de OpenAI (si `LLM_PROVIDER=openai`) | - |
| `ANTHROPIC_API_KEY` | Clave de API de Anthropic (si `LLM_PROVIDER=anthropic`) | - |
| `PORT` | Puerto HTTP del servidor unificado (API + Web) | `3000` |
| `MAX_ITERATIONS_PER_TURN` | Tope de iteraciones herramienta → modelo por turno (Regla CA1) | `25` |
| `MAX_TOKENS_PER_SESSION` | Tope máximo de tokens por sesión para control de costos | `100000` |
| `LLM_TIMEOUT_MS` | Timeout máximo por llamada al proveedor LLM (ms) | `30000` |

---

## 🔌 4. API del Servidor (`src/server.ts`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Interfaz web conversacional con inspector de herramientas y confirmación HITL |
| `POST` | `/api/chat` | Recibe `{ sessionId, message }` y devuelve `{ ok, reply, toolCalls[], needsConfirmation, tokensUsed, maxTokens }` |
| `GET` | `/api/sessions/:id` | Devuelve el historial completo de turnos, mensajes y consumo de tokens de la sesión |
| `GET` | `/api/health` | Devuelve `{ ok: true, provider, model }` sin exponer credenciales |
| `GET` | `/api/audit` | Devuelve las órdenes creadas en `out/sap/ordenes.jsonl` y el log `out/control.csv` |

---

## 📁 5. Estructura del Repositorio y Bonus (`modulo/`)

```text
periferia-reto-03/
├── agent/
│   └── prompt.md                        # System prompt del agente (Comportamiento)
├── src/
│   ├── server.ts                        # Servidor HTTP, API y ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts                   # Interfaz desacoplada LlmAdapter
│   │   └── gemini.ts                    # Implementaciones Gemini, OpenAI, Anthropic y Determinista
│   ├── tools/
│   │   └── oc.ts                        # Herramientas tipadas con Zod (oc_*)
│   ├── sap/
│   │   ├── adapter.ts                   # Interfaz SapAdapter y esquema OrdenCompra
│   │   └── mock.ts                      # Adaptador SAP simulado con idempotencia
│   └── knowledge/
│       └── ordenes-compra.md            # Conocimiento del proceso y reglas RC1-RC10
├── modulo/                              # BONUS (+10 pts): Módulo reutilizable sin divergencia
│   ├── agent.md                         # System prompt con frontmatter de permisos
│   ├── tools/oc.ts                      # Re-exportación canónica de src/tools/oc.ts
│   └── skill/ordenes-compra/SKILL.md    # Skill reutilizable del proceso
├── web/
│   └── index.html                       # Frontend de chat e inspector de herramientas
├── tests/
│   └── oc.test.ts                       # Pruebas automatizadas de herramientas y ciclo del agente
├── fixtures/                            # Casos de prueba (sol-001 a sol-006) y maestros
├── demo.ts                              # Script de verificación determinista sin LLM
├── SOLUCION.md                          # Documentación técnica y de proceso completa
└── README.md
```
