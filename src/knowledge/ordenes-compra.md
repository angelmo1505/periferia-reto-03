# Conocimiento del Proceso: Órdenes de Compra SAP (Periferia IT Group)

## 1. Flujo Operativo de una Solicitud de Compra
Cada compra corporativa ingresa al área de Administración mediante una carpeta de caso (`sol-001` a `sol-006`) ubicada en `fixtures/reto-03/solicitudes/<caso>/`, compuesta por:
1. **`correo.json`**: Metadatos del correo del solicitante (`id`, `de`, `asunto`, `fecha`, `adjuntos[]`).
2. **`solicitud.json`**: Formulario estructurado con proveedor, descripción, centro de costo, subárea, cantidad, valor unitario, valor total, moneda, e indicadores opcionales (`proveedor_nit`, `indicador_iva`, `condiciones_pago`).
3. **`cotizacion.txt`**: Propuesta económica emitida por el proveedor.
4. **`aprobacion.json`**: Correo del líder aprobador autorizando el gasto.
5. **`factura.txt`** *(opcional)*: Presente cuando el proveedor ya emitió factura antes o durante la solicitud (caso de compra retroactiva).

---

## 2. Matriz de Controles Obligatorios (RC1 – RC10)

| Código | Regla de Negocio | Clasificación | Efecto en el Flujo |
|---|---|---|---|
| **RC1** | El proveedor debe existir en `proveedores.json` (por NIT o por nombre normalizado si falta NIT) y estar `activo = true`. | **Bloqueo** | Impide crear la OC. Se informa razón y se sugiere solicitar alta/activación en Datos Maestros SAP. |
| **RC2** | Debe existir `aprobacion.json`, su cuerpo debe incluir `"Aprobado"` y el remitente (`de`) debe pertenecer a la lista de aprobadores del `centro_costo`. | **Bloqueo** | Impide crear la OC. Se informa quiénes son los aprobadores válidos del centro de costo. |
| **RC3** | `solicitud.valor_total` ≤ `tope` del aprobador autorizado para ese `centro_costo`. | **Bloqueo** | Impide crear la OC. Requiere escalar a un aprobador con tope suficiente. |
| **RC4** | `solicitud.subarea` debe estar incluida dentro de `subareas[]` del `centro_costo`. | **Bloqueo** | Impide crear la OC. Requiere corregir la subárea o el centro de costo. |
| **RC5** | `abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total <= 2%`. Si supera el 2% o no hay cotización, se solicita confirmación mostrando ambos valores. | **Confirmación** | Pausa la creación hasta que la analista confirme explícitamente. |
| **RC6** | Si `indicador_iva` está ausente en `solicitud.json`, se deriva de `proveedores.json` (`indicador_iva_default`) y se solicita confirmación. | **Confirmación + Derivado** | Completa el campo en `derivados` y pausa hasta confirmación humana. |
| **RC7** | Si `condiciones_pago` está ausente en `solicitud.json`, se deriva de `proveedores.json` (`condiciones_pago_default`). Solo se informa. | **Derivado** | No bloquea ni requiere confirmación; se reporta a la analista como dato derivado. |
| **RC8** | Si existe `factura.txt` con `fecha < solicitud.fecha_solicitud`, se marca `retroactiva = true`, se pide confirmación y se registra en `out/control.csv`. | **Confirmación** | Pausa la creación hasta confirmación humana; mide el desvío de proceso. |
| **RC9** | La fecha de aprobación debe ser `>= fecha_solicitud`. Si es anterior, requiere confirmación. | **Confirmación** | Pausa la creación hasta confirmación humana. |
| **RC10** | `cantidad × valor_unitario` debe ser igual a `valor_total` (±1 unidad monetaria). | **Bloqueo** | Impide crear la OC por inconsistencia aritmética. |

---

## 3. Reglas de Construcción del Payload SAP y Evidencia
- **Sociedad y Organización de Compras**: Fijas en `"1000"`.
- **Texto breve de posición (`descripcion`)**: Truncado estrictamente a máximo **40 caracteres** (límite técnico SAP ME21N / BAPI).
- **Posiciones**: Numeradas de 10 en 10 (`10, 20, 30...`).
- **Trazabilidad**: Cada atributo del payload se documenta en `out/<caso>/trazabilidad.json` indicando su fuente (`solicitud`, `cotizacion`, `maestro.proveedores` o `derivado`).
- **Evidencia de aprobación**: Se genera en `out/<caso>/aprobacion.txt` y `out/<caso>/aprobacion.pdf` incluyendo el hash criptográfico `SHA-256` que se vincula en `aprobador.evidencia_sha256`.
- **Idempotencia**: El adaptador SAP asigna números secuenciales desde `4500000001` en `out/sap/ordenes.jsonl`. Si se intenta crear nuevamente un mismo `solicitud_id`, devuelve la OC existente sin duplicarla.
