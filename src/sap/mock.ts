import fs from "node:fs/promises";
import path from "node:path";
import { OrdenCompra, OrdenCompraSchema, SapAdapter } from "./adapter.js";

interface ProveedorMaestro {
  codigo_sap: string;
  nit: string;
  nombre: string;
  condiciones_pago_default: string;
  indicador_iva_default: string;
  activo: boolean;
}

export interface OrdenSapRegistrada {
  numero_oc: string;
  fecha: string;
  orden: OrdenCompra;
}

const BASE_OC_NUMBER = 4500000000n;

function limpiarNit(nit: string): string {
  return nit.replace(/[^0-9]/g, "").slice(0, 9);
}

export class MockSapAdapter implements SapAdapter {
  private readonly rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = rootDir;
  }

  private get ordenesFilePath(): string {
    return path.join(this.rootDir, "out", "sap", "ordenes.jsonl");
  }

  private get proveedoresFilePath(): string {
    return path.join(this.rootDir, "fixtures", "reto-03", "maestros", "proveedores.json");
  }

  private async leerOrdenesRegistradas(): Promise<OrdenSapRegistrada[]> {
    try {
      const raw = await fs.readFile(this.ordenesFilePath, "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as OrdenSapRegistrada);
    } catch {
      return [];
    }
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    try {
      const raw = await fs.readFile(this.proveedoresFilePath, "utf-8");
      const proveedores = JSON.parse(raw) as ProveedorMaestro[];
      const nitLimpio = limpiarNit(nit);
      const encontrado = proveedores.find((p) => limpiarNit(p.nit) === nitLimpio);
      if (!encontrado) {
        return null;
      }
      return {
        codigo_sap: encontrado.codigo_sap,
        activo: encontrado.activo,
      };
    } catch {
      return null;
    }
  }

  async buscarOrdenPorReferencia(
    solicitud_id: string
  ): Promise<{ numero_oc: string; fecha: string } | null> {
    const ordenes = await this.leerOrdenesRegistradas();
    const existente = ordenes.find((o) => o.orden.referencia.solicitud_id === solicitud_id);
    if (!existente) {
      return null;
    }
    return {
      numero_oc: existente.numero_oc,
      fecha: existente.fecha,
    };
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const validada = OrdenCompraSchema.parse(orden);

    const existente = await this.buscarOrdenPorReferencia(validada.referencia.solicitud_id);
    if (existente) {
      return existente;
    }

    const ordenes = await this.leerOrdenesRegistradas();
    const siguienteSecuencia = BASE_OC_NUMBER + BigInt(ordenes.length + 1);
    const numero_oc = siguienteSecuencia.toString();
    const fecha = new Date().toISOString();

    const registro: OrdenSapRegistrada = {
      numero_oc,
      fecha,
      orden: validada,
    };

    await fs.mkdir(path.dirname(this.ordenesFilePath), { recursive: true });
    await fs.appendFile(this.ordenesFilePath, `${JSON.stringify(registro)}\n`, "utf-8");

    return { numero_oc, fecha };
  }
}
