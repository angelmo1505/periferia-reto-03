export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinitionSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Interfaz obligatoria del Adaptador LLM (Sección 6.1 PRD):
 * cambiar de proveedor no toca el ciclo del agente.
 */
export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(
    mensajes: AgentMessage[],
    herramientas: ToolDefinitionSchema[]
  ): Promise<LlmResponse>;
}
