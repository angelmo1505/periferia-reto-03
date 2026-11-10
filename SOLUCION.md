# SOLUCION.md — Reto Técnico 03: Agente Conversacional "Órdenes de Compra SAP"

> **Proceso de Selección · Equipo Perxia 2.0 · Periferia IT Group**

---

## 1. Problema en una frase y a quién le duele
La analista administrativa de compras invierte tiempo operativo crítico y asume riesgo de error contable al digitar manualmente en SAP cada solicitud de compra, validando de memoria topes de aprobación, centros de costo, impuestos y cotizaciones, mientras Contabilidad y Dirección carecen de trazabilidad sistemática sobre las órdenes de compra creadas de forma retroactiva (después de emitida la factura).

---

## 2. Arquitectura de la Solución

### 2.1 Diagrama de Componentes y Flujo de Datos

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND WEB (web/index.html)                       │
│  • Consola Conversacional + Selector de Casos (sol-001 a sol-006)          │
│  • Inspector en Tiempo Real de Tool Calls (argumentos + JSON Zod)          │
│  • Banner Interactivo HITL (Confirmación Humana - Regla CA3)               │
│  • Monitor en Vivo de Auditoría (out/sap/ordenes.jsonl y out/control.csv)  │
└──────────────────────┬──────────────────────────────────────▲──────────────┘
                       │ POST /api/chat                       │ JSON
                       │ GET  /api/sessions/:id               │ { reply, toolCalls[],
                       ▼ GET  /api/health & /api/audit        │   needsConfirmation }
┌─────────────────────────────────────────────────────────────┴──────────────┐
│                      BACKEND & CICLO DEL AGENTE (src/server.ts)            │
│  • Ensambla Comportamiento (agent/prompt.md) + Conocimiento (src/knowledge)│
│  • Bucle Agéntico con Tope de Iteraciones (CA1: máx 25/turno)              │
│  • Tope de Tokens por Sesión (100,000 tokens) y Timeout LLM (30s)          │
│  • Guardrail Determinista de Confirmación Humana (CA3)                     │
│  • Validación Pre-ejecución de Argumentos con Zod                          │
└──────┬───────────────────────────────┬─────────────────────────────┬───────┘
       │ Interfaz LlmAdapter           │ Ejecución Determinista      │ Logs
       ▼ (src/llm/adapter.ts)          ▼ (src/tools/oc.ts)           ▼
┌──────────────────────┐    ┌──────────────────────────────┐  ┌──────────────┐
│ Proveedores LLM      │    │ Herramientas oc_* (Zod)      │  │ Auditoría    │
│ • Gemini 2.5 Flash   │    │ • oc_leer_paquete            │  │ • log.jsonl  │
│ • OpenAI GPT-4o-mini │    │ • oc_validar (RC1–RC10)      │  │ • control.csv│
│ • Anthropic Haiku    │    │ • oc_construir_payload       │  │ • aprobacion │
│ • Motor Determinista │    │ • oc_generar_evidencia (PDF) │  │   .txt / .pdf│
└──────────────────────┘    │ • oc_crear (Idempotente)     │  │ • trazabilid.│
                            │ • oc_leer_excel (P1)         │  └──────────────┘
                            └──────┬───────────────┬───────┘
                                   │               │
                                   ▼               ▼
                      ┌──────────────────┐  ┌─────────────────────────┐
                      │ fixtures/reto-03 │  │ Adaptador SAP Simulado  │
                      │ (Solo lectura)   │  │ (src/sap/mock.ts)       │
                      │ • maestros/*.json│  │ • out/sap/ordenes.jsonl │
                      │ • solicitudes/*  │  │ • Secuencia 4500000001+ │
                      └──────────────────┘  └─────────────────────────┘
```

### 2.2 Separación de Responsabilidades (Comportamiento, Conocimiento y Ejecución)
1. **Comportamiento (`agent/prompt.md` y `modulo/agent.md`)**: Define exclusivamente la identidad del agente, la secuencia de razonamiento, el protocolo de confirmación humana (CA3) y la prohibición estricta de alucinar datos fuera de las herramientas (CA2).
2. **Conocimiento (`src/knowledge/ordenes-compra.md` y `modulo/skill/ordenes-compra/SKILL.md`)**: Documenta las reglas de negocio (`RC1`–`RC10`), la estructura de los maestros y las restricciones técnicas de SAP (sociedad `1000`, texto breve de 40 caracteres, numeración de posiciones).
3. **Ejecución (`src/tools/oc.ts` y re-exportación canónica en `modulo/tools/oc.ts`)**: Contiene el 100% de la lógica determinista de lectura, validación de reglas, generación de evidencia criptográfica (`SHA-256` en `.txt` y `.pdf`) y creación idempotente en SAP. Ningún cambio en una regla de negocio requiere tocar `src/server.ts`.

---

## 3. Ciclo del Agente
El ciclo agéntico en `src/server.ts` (`ejecutarTurnoAgente`) opera bajo un bucle controlado `while (iteraciones < MAX_ITERATIONS_PER_TURN)`:
1. **Inyección de Contexto**: Combina `agent/prompt.md` + `src/knowledge/ordenes-compra.md` como mensaje `system`, seguido del historial de mensajes de la sesión.
2. **Invocación desacoplada al LLM**: Llama a `adapter.enviar(mensajes, herramientas)` con `AbortSignal.timeout(30000)`.
3. **Validación Zod y Ejecución**: Por cada `toolCall` solicitada por el modelo, el servidor valida los argumentos contra el esquema `zod` de la herramienta antes de invocar `execute(args, ctx)`. Si falla la validación de esquema, devuelve `{ ok: false, error }` al modelo sin abortar el proceso.
4. **Doble Guardrail de Confirmación Humana (CA3)**:
   - **En la herramienta (`oc_crear`)**: Re-ejecuta internamente `validarPaqueteInterno`. Si `confirmaciones.length > 0` y `confirmado !== true`, rechaza la creación y registra `PENDIENTE_CONFIRMACION` en `out/control.csv`.
   - **En el servidor (`src/server.ts`)**: Verifica si el mensaje actual de la usuaria es una confirmación explícita en un turno posterior a la advertencia. Si el modelo intentara enviar `confirmado: true` prematuramente en el primer turno (o cuando la usuaria pidió *"no la crees hasta que yo lo confirme"*), el servidor fuerza `confirmado = false` o retiene la ejecución y activa `needsConfirmation = true` para resaltar la tarjeta de confirmación en el frontend.
5. **Trazabilidad Completa (CA4)**: Cada invocación de herramienta se persiste en `out/log.jsonl` con `sessionId`, argumentos, resultado y latencia en milisegundos.

---

## 4. Elección del Modelo y Análisis de Costos
- **Proveedor principal configurado**: **Google Gemini (`gemini-2.5-flash`)**, con soporte nativo intercambiable por variable de entorno para **OpenAI (`gpt-4o-mini`)**, **Anthropic (`claude-3-5-haiku-latest`)** y un **Orquestador Determinista Local** de respaldo.
- **Justificación técnica**:
  - `gemini-2.5-flash` y `gpt-4o-mini` ofrecen latencias sub-segundo en *Function Calling* estructurado, adherencia sobresaliente a esquemas JSON/Zod y temperatura baja (`0.1`), ideal para flujos transaccionales donde toda la lógica numérica reside en herramientas deterministas.
- **Estimación de costo por caso procesado**:
  - Promedio por solicitud completa (3 a 4 iteraciones de herramientas + confirmación): ~`3,200` tokens de entrada y ~`750` tokens de salida.
  - Con `gemini-2.5-flash` ($0.15 / 1M input tokens, $0.60 / 1M output tokens):
    $$\text{Costo por OC} \approx (3,200 \times 0.00000015) + (750 \times 0.00000060) \approx \$0.00093\text{ USD} \ (\sim 0.09\text{ centavos de dólar})$$
  - Procesar **1,000 órdenes de compra al mes** cuesta menos de **\$1.00 USD/mes**.

---

## 5. Matriz de Controles Implementada (RC1 – RC10)

| Regla | Tipo | Implementación en `src/tools/oc.ts` | Caso que la activa |
|---|---|---|---|
| **RC1** | **Bloqueo** | Cruza `proveedor_nit` (limpiando guiones/puntos y dígito de verificación) contra `proveedores.json`. Si falta NIT en la solicitud (`sol-006`), busca por razón social normalizada (NFD, sin tildes ni puntuación) y deriva el NIT. Verifica `activo === true`. | `sol-002` (Bloqueo: NIT `901999000` no existe) y `sol-006` (Deriva NIT `900555111`) |
| **RC2** | **Bloqueo** | Verifica existencia de `aprobacion.json`, presencia de regex `/\baprobado\b/i` en el cuerpo y que `aprobacion.de` exista en `centros-costo.json -> aprobadores[]` del `centro_costo` solicitado. | `sol-003` (Bloqueo: `fvargas` aprueba en `CC-3030`, no en `CC-2020`) |
| **RC3** | **Bloqueo** | Verifica que `solicitud.valor_total <= aprobador.tope` en el centro de costo correspondiente (y reporta si excede el tope máximo del centro cuando el aprobador no pertenece al centro). | `sol-003` (`$74,000,000` > tope `$30,000,000` de `CC-2020`) |
| **RC4** | **Bloqueo** | Verifica que `solicitud.subarea` esté incluida en `centroCosto.subareas`. | Todas válidas en fixtures (`Infraestructura`, `Desarrollo`, etc.) |
| **RC5** | **Confirmación** | Calcula `abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total`. Si `> 0.02` (2%) o si `cotizacion === null`, agrega confirmación detallando ambos montos y el porcentaje exacto. | `sol-004` (`$26,500,000` vs `$25,000,000` → desviación `6.00% > 2%`) |
| **RC6** | **Confirmación + Derivado** | Si `solicitud.indicador_iva` es `undefined`, toma `proveedor.indicador_iva_default` (`C1`), lo registra en `derivados.indicador_iva` y agrega confirmación obligatoria. | `sol-006` (Deriva `C1` - IVA 19% y pide confirmación) |
| **RC7** | **Derivado** | Si `solicitud.condiciones_pago` es `undefined`, toma `proveedor.condiciones_pago_default` (`Z030`) y lo documenta en `derivados.condiciones_pago` sin bloquear ni pedir confirmación. | `sol-006` (Deriva `Z030` - 30 días fecha factura) |
| **RC8** | **Confirmación** | Si existe `factura.txt` y `factura.fecha < solicitud.fecha_solicitud`, marca `retroactiva = true`, solicita confirmación humana y lo persiste en `out/control.csv`. | `sol-005` (Factura `FC-88231` del `2026-08-10` < solicitud `2026-08-27`) |
| **RC9** | **Confirmación** | Compara fecha calendario `aprobacion.fecha.slice(0,10) >= solicitud.fecha_solicitud.slice(0,10)`. | Todas cumplen en fixtures |
| **RC10** | **Bloqueo** | Verifica `Math.abs(cantidad * valor_unitario - valor_total) <= 1`. | Todas cumplen en fixtures |

**¿Cuál fue la más retadora?**
La combinación **RC1 + RC6 + RC7 en `sol-006`** junto con **RC5 en `sol-004`**: en `sol-006` la solicitud omite simultáneamente `proveedor_nit`, `indicador_iva` y `condiciones_pago`, mientras que la cotización trae el NIT con formato puntuado y dígito de verificación (`900.555.111-2`). Resolver el proveedor por nombre normalizado sin tildes, derivar su NIT y separar con precisión qué campo derivado exige confirmación (`RC6` - IVA) vs cuál es puramente informativo (`RC7` - Condiciones de pago) requirió un diseño limpio del objeto `derivados` y de la matriz de trazabilidad.

---

## 6. Diseño del Adaptador SAP Real para Producción (Sección 7.5)

### 6.1 Elección de Integración
Dado que la viabilidad de conectarse a SAP en el corto plazo no está confirmada, propongo una **arquitectura en 2 fases basada en el patrón Adapter (`SapAdapter` en `src/sap/adapter.ts`)**:
- **Opción Principal (SAP S/4HANA o ECC con SAP Gateway habilitado)**: Servicio OData estándar **`API_PURCHASEORDER_PROCESS_SRV`** a través de **SAP Integration Suite (Cloud Integration / BTP)** o API Management.
  - *Por qué*: Expone endpoints REST/JSON nativos con soporte de tokens CSRF e idempotencia HTTP, evitando compilar binarios nativos de `node-rfc` (SAP NetWeaver RFC SDK) en contenedores serverless/Linux.
- **Alternativa si es SAP ECC clásico sin OData**: Wrapper microservicio interno que invoque la BAPI **`BAPI_PO_CREATE1`** + `BAPI_TRANSACTION_COMMIT` vía RFC, exponiendo un endpoint REST interno al backend del agente.

### 6.2 Mapeo del Payload (`OrdenCompra` → SAP OData / `BAPI_PO_CREATE1`)

| Campo en `OrdenCompra` (Sección 7.4) | Campo OData `A_PurchaseOrder` | Campo BAPI (`POHEADER` / `POITEM` / `POACCOUNT`) |
|---|---|---|
| `sociedad` (`"1000"`) | `CompanyCode` | `POHEADER-COMP_CODE` |
| `organizacion_compras` (`"1000"`) | `PurchasingOrganization` | `POHEADER-PURCH_ORG` |
| `proveedor.codigo_sap` | `Supplier` | `POHEADER-VENDOR` |
| `moneda` (`"COP"` / `"USD"`) | `DocumentCurrency` | `POHEADER-CURRENCY` |
| `condiciones_pago` (`"Z030"`) | `PaymentTerms` | `POHEADER-PMNTTRMS` |
| `referencia.solicitud_id` | `CorrespncExternalReference` | `POHEADER-OUR_REF` (Clave de idempotencia) |
| `referencia.cotizacion_ref` | `CorrespncInternalReference` | `POHEADER-YOUR_REF` |
| `posiciones[i].numero` (`10`) | `to_PurchaseOrderItem.PurchaseOrderItem` | `POITEM-PO_ITEM` |
| `posiciones[i].descripcion` (≤40c) | `PurchaseOrderItemText` | `POITEM-SHORT_TEXT` |
| `posiciones[i].cantidad` | `OrderQuantity` | `POITEM-QUANTITY` |
| `posiciones[i].unidad` | `PurchaseOrderQuantityUnit` | `POITEM-PO_UNIT` |
| `posiciones[i].precio_unitario` | `NetPriceAmount` | `POITEM-NET_PRICE` |
| `posiciones[i].indicador_iva` | `TaxCode` | `POITEM-TAX_CODE` |
| `posiciones[i].centro_costo` | `to_AccountAssignment.CostCenter` | `POACCOUNT-COSTCENTER` |
| `aprobacion.pdf` + `evidencia_sha256` | `API_CV_ATTACHMENT_SRV` (DMS/GOS) | `BDS_BUSINESSDOCUMENT_CREATEF` |

### 6.3 Autenticación y Custodia de Credenciales
- Las credenciales de SAP **nunca** residen en el código, ni en el prompt del agente, ni viajan al frontend.
- El backend se autentica contra SAP BTP / Gateway mediante **OAuth 2.0 Client Credentials (mTLS / Principal Propagation)** leyendo secretos inyectados en tiempo de ejecución desde **Azure Key Vault / AWS Secrets Manager / GCP Secret Manager**.

### 6.4 Idempotencia y Manejo de Errores Parciales
1. **Idempotencia ante reintentos**: Antes de ejecutar `POST /A_PurchaseOrder`, `buscarOrdenPorReferencia(solicitud_id)` consulta `$filter=CorrespncExternalReference eq '<solicitud_id>'`. Además, se envía cabecera `Idempotency-Key: <solicitud_id>`.
2. **Errores parciales (ej. OC creada pero falla adjunto PDF de evidencia)**:
   - Si se usa OData `$batch` (ChangeSet), la creación de cabecera + posiciones es atómica.
   - Si la OC se crea (`450000xxxx`) pero falla la subida del PDF al servicio GOS (`API_CV_ATTACHMENT_SRV`), el adaptador registra el `numero_oc` como creado y encola la subida del adjunto en una cola de reintentos con estado `EVIDENCIA_PENDIENTE_SYNC`, evitando re-ejecutar `crearOrden` y duplicar el gasto en SAP.

### 6.5 Plan B si la Conexión Directa a SAP no es Viable en Fase 1
El agente mantiene el **90% del ahorro operativo y el 100% del control de auditoría** generando automáticamente en `out/<caso>/`:
1. **Plantilla de Carga Masiva LSMW / LTMC / BAPI Excel (`.xlsx` / `.tsv`)** pre-validada con códigos SAP exactos, lista para importar en SAP GUI en 2 clics sin digitar un solo campo.
2. **Modo "Copy-Paste Guiado SAP ME21N"** en el frontend junto con el archivo `aprobacion.pdf` ya firmado con hash `SHA-256` listo para arrastrar a SAP.

---

## 7. Lectura del Proceso: Análisis Crítico de las OC Retroactivas (`sol-005`)
En `sol-005`, el proveedor emitió la factura electrónica `FC-88231` el **10 de agosto de 2026**, pero la solicitud de compra recién se radicó el **27 de agosto** y la líder aprobó el **28 de agosto** diciendo *"Ya llegó la factura, por favor crear la OC para poder radicarla"*.

**Mensaje para la Dirección y Contabilidad:**
1. **Riesgo Financiero, Fiscal y de Control Interno**: Cuando una OC se crea después de emitida la factura electrónica ante la DIAN, la Orden de Compra deja de ser un control preventivo de gasto y se convierte en un trámite burocrático ("*rubber-stamping*") para destrabar el pago en SAP. Esto compromete a la compañía legalmente sin validación previa de presupuesto, anula el poder de negociación de Compras y distorsiona el corte contable de provisiones mensuales.
2. **Propuesta de Cambio de Proceso (3 Pilares)**:
   - **Medición y Visibilidad Ejecutiva (Implementado hoy)**: El agente marca automáticamente `retroactiva = true` en `out/control.csv` cada vez que `factura.fecha < solicitud.fecha_solicitud`, exponiendo un KPI semanal de *"% de Compras Retroactivas por Centro de Costo y Líder"*.
   - **Flujo de Excepción con Doble Aprobación**: A partir del mes 2, toda OC con `retroactiva = true` que supere 1 SMMLV requerirá no solo la confirmación de la analista, sino un código de justificación tipificado (`URGENCIA_OPERATIVA`, `RENOVACION_AUTOMATICA`, `OMISION_PROCESO`) y aprobación de Contraloría/Finanzas.
   - **Contratos Marco / Pedidos Abiertos en SAP (`Blanket PO`) para Recurrentes**: Casos como papelería y tóner trimestral (`sol-005`) o nubes (`sol-004`) no deberían tramitarse como compras puntuales tardías, sino bajo un Pedido Abierto anual con liberaciones parciales automáticas.

---

## 8. Decisiones de Diseño y Trade-offs

1. **Reconstrucción Determinista del Payload dentro de `oc_crear` vs Confiar en el Payload enviado por el LLM**
   - *Decisión*: Aunque `oc_crear` acepta `payload` en sus argumentos según el contrato, internamente vuelve a ejecutar `construirPayloadInterno` desde los archivos fuente antes de invocar al adaptador SAP.
   - *Alternativa descartada*: Pasar directamente al adaptador SAP el JSON que el LLM envíe por argumento.
   - *Por qué*: Mitiga al 100% el riesgo de la Sección 10 (*"que el modelo arregle un monto para que cuadre con la cotización"*). El LLM jamás puede alterar un monto, NIT o centro de costo en SAP.
2. **Doble Guardrail de Confirmación Humana (Servidor + Herramienta) vs Solo Prompting**
   - *Decisión*: Además de instruir en `agent/prompt.md` que pida confirmación, `src/server.ts` verifica que exista un turno previo con `pendingConfirmationCase` antes de permitir `confirmado = true`.
   - *Alternativa descartada*: Confiar únicamente en que el LLM respete el prompt.
   - *Por qué*: En sistemas financieros/SAP, la seguridad determinista en código garantiza que ninguna alucinación del modelo salte la confirmación humana (CA3).
3. **Arquitectura Unificada Node HTTP + Frontend Reactivo Ligero (`web/index.html`) vs Monorepo Pesado Separado**
   - *Decisión*: Un único servidor TypeScript (`src/server.ts`) sirve tanto la API REST (`/api/chat`, `/api/sessions/:id`, `/api/health`, `/api/audit`) como la interfaz web en el mismo puerto (`3000`).
   - *Alternativa descartada*: Dos servidores separados con compilaciones independientes de Webpack/Vite.
   - *Por qué*: Cumple estrictamente el requisito no funcional de arrancar en segundos con un solo comando (`npm run dev` o `bun run dev`), elimina problemas de CORS en despliegue y facilita el deploy instantáneo en Render/Railway/Fly.io.

---

## 9. Supuestos Tomados
1. **Normalización de NITs**: En Colombia los NITs suelen incluir puntos y dígito de verificación en documentos de texto (`900.555.111-2` en `cotizacion.txt`), mientras que el maestro `proveedores.json` almacena los 9 dígitos base (`900555111`). Se normalizan los primeros 9 dígitos numéricos para garantizar cruces exactos.
2. **Tolerancia en `RC5`**: La regla indica `<= 2%`. Una desviación exactamente igual o menor a `0.02` pasa sin confirmación; cualquier valor mayor (`> 0.02`, como el `6.00%` de `sol-004`) exige confirmación humana.
3. **Valor del Payload en `sol-004`**: En `sol-004`, el aprobador (`Diego García`) aprobó explícitamente *"por 25 millones según la solicitud"*. Cuando la analista confirma proceder pese a la diferencia con la cotización, el payload se construye respetando el monto aprobado en la solicitud (`$25,000,000`) y dejando constancia auditada de la excepción `RC5` en `payload.excepciones[]`.

---

## 10. Cobertura de Historias de Usuario y Estado para Producción

| Historia / Requisito | Prioridad | Estado | Detalle de Implementación y Qué Falta para Producción |
|---|---|---|---|
| **HU-1 · `oc_leer_paquete`** | P0 | **Hecho (100%)** | Normaliza correo, solicitud, cotización, aprobación y factura; reporta faltantes sin lanzar excepción. |
| **HU-2 · `oc_validar` (RC1–RC10)** | P0 | **Hecho (100%)** | Evalúa las 10 reglas, separa bloqueos, confirmaciones y derivados. En producción: consultar maestros en tiempo real vía caché Redis + SAP OData. |
| **HU-3 · `oc_construir_payload`** | P0 | **Hecho (100%)** | Valida con `OrdenCompraSchema` (Zod) y genera `out/<caso>/trazabilidad.json`. |
| **HU-4 · `oc_generar_evidencia`** | P0 (.txt) + P1 (.pdf) | **Hecho (100% P0+P1)** | Genera tanto `aprobacion.txt` como `aprobacion.pdf` (`pdf-lib`) con hash `SHA-256`. |
| **HU-5 · `oc_crear` + Idempotencia** | P0 | **Hecho (100%)** | Secuencia desde `4500000001` en `out/sap/ordenes.jsonl`, idempotente por `solicitud_id`, audita en `out/control.csv`. |
| **HU-6 · Manejo de errores** | P0 | **Hecho (100%)** | Todas las herramientas devuelven `{ ok: false, error }` tipado sin romper la sesión. |
| **P1 Opcional · `oc_leer_excel`** | P1 | **Hecho (100%)** | Implementada con `xlsx` y fallback a JSON normalizado. |
| **Bonus 9.4 · `modulo/` reutilizable** | Bonus (+10) | **Hecho (100%)** | Entregado en `modulo/agent.md`, `modulo/tools/oc.ts` y `modulo/skill/ordenes-compra/SKILL.md` sin divergencia de código. |

---

## 11. Declaración de Uso de IA
- **Asistente utilizado**: **Google Antigravity (Gemini)** como copiloto de ingeniería de software (AI-First Pair Programming).
- **Para qué tareas se utilizó**:
  1. Análisis comparativo de los requerimientos del `PRD.md` e inspección rápida de los 6 casos de prueba (`sol-001` a `sol-006`).
  2. Generación de esquemas `Zod` estrictos (`OrdenCompraSchema`, `PaqueteSchema`) y scaffolding de las herramientas en `src/tools/oc.ts`.
  3. Construcción de la suite de pruebas automatizadas (`tests/oc.test.ts`) y maquetación de la interfaz web con Tailwind CSS.
- **Qué propuestas de la IA se descartaron y por qué**:
  - Se descartó usar un framework frontend pesado con compilación separada (Next.js/Vite en carpeta aparte con segundo puerto) porque añadía complejidad innecesaria al arranque y podía fallar el requisito de levantar todo en un único comando limpio.
  - Se descartó delegar el cálculo del porcentaje de desviación (`RC5`) o la comparación de fechas (`RC8`/`RC9`) al razonamiento del LLM; se forzó que el 100% de las comparaciones aritméticas y cronológicas ocurran dentro de `oc_validar` en TypeScript puro.

---

## 12. Riesgos de Llevar a Producción y Mitigación

| Riesgo en Producción | Impacto | Estrategia de Mitigación |
|---|---|---|
| **1. Suplantación de correo de aprobación (Spoofing en `.eml`)** | Alto (Fraude financiero) | Validar cabeceras criptográficas `DKIM` / `SPF` / `DMARC` del archivo `.eml` original o consumir la aprobación directamente desde Microsoft Graph API del buzón corporativo. |
| **2. Condiciones de carrera (Race Conditions) al crear OCs concurrentes** | Medio (Duplicación de OC) | Reemplazar el archivo plano `ordenes.jsonl` por bloqueo distribuido (Redis / PostgreSQL `UNIQUE(solicitud_id)`) + clave de idempotencia en SAP OData. |
| **3. Cambios de formato en PDFs de cotizaciones de proveedores** | Medio (Error de extracción) | Incorporar un paso de extracción estructurada multimodal (Document AI / Gemini Vision con esquema Zod + *Confidence Score*) que active confirmación humana cuando la confianza de lectura sea `< 95%`. |
| **4. Indisponibilidad temporal de SAP o del proveedor LLM** | Bajo/Medio (Pausa operativa) | Timeout estricto de 30s, Circuit Breaker con reintentos exponenciales y activación automática del Plan B (generación de archivo de carga SAP pre-validado). |
