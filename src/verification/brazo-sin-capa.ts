import type { SavingsRequest } from "../contracts/types.js";
import { topeDeSalida } from "../contracts/tope-de-salida.js";
import type { ProviderRequest } from "../providers/types.js";

// LA PETICIÓN QUE EL CLIENTE MANDARÍA SIN LA CAPA (D7): el brazo B0 del banco
// (`construirBrazoNaive`), con UNA diferencia intencionada.
//
//   · el modelo PEDIDO (`request.model`), nunca el barato de la cascada;
//   · todos los mensajes y TODAS las herramientas;
//   · `structuredData` en línea, como un mensaje `user` con JSON compacto;
//   · el contrato (`schema`), el tope, `temperature` y `seed` de la petición;
//   · sin marcas de caché, sin `deferrable`, sin `constraintBackend`.
//
// La diferencia con el banco: los mensajes se copian ENTEROS (`toolCallId`,
// `toolCalls`, `name`). B0 se queda con `{role, content}`, y con eso cualquier
// conversación con ciclo de herramientas daría 400 en la copia. Se construye
// SÍNCRONA en el momento de decidir: el patrón habitual
// `messages.push(respuesta)` justo después del `await` no puede alterarla.
export function construirPeticionSinCapa(request: SavingsRequest): ProviderRequest {
  const messages = request.messages.map((m) => ({ ...m }));
  if (request.structuredData !== undefined) {
    messages.push({ role: "user", content: JSON.stringify(request.structuredData) });
  }
  return {
    model: request.model,
    messages,
    ...(request.tools && request.tools.length > 0 ? { tools: [...request.tools] } : {}),
    ...(request.response?.schema ? { schema: request.response.schema } : {}),
    ...(topeDeSalida(request) != null ? { maxOutputTokens: topeDeSalida(request)! } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}
