import express from 'express';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MOTOR_URL = 'https://script.google.com/macros/s/AKfycbyba859-5_Q1sUBeK7MYNYzUY4QikrKzE7lYU0gQtdi6bye37f1xAMO4E355xgLobpVhA/exec';
const MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `Eres el asistente de cotizaciones de Praia Envíos, empresa especializada en envíos Brasil → Venezuela.
Eres bilíngüe: atiendes en español y en portugués según lo que elija el usuario.

IDIOMA: El usuario ya eligió su idioma al inicio de la conversación. Detecta cuál fue y úsalo en TODAS tus respuestas sin excepción. No mezcles idiomas.

Para calcular una cotización necesitas recolectar exactamente estos datos:

1. Peso bruto en kg (sin redondear)

2. Dimensiones de la caja en centímetros: largo, ancho, alto

3. Valor de la mercancía en Reales brasileños (R$)

4. Tipo de mercancía:
   - "personal": artículos de uso personal (ropa, calzado, etc.)
   - "comercial": productos para reventa o uso empresarial

5. Categorías de los productos (ej: ropa, electrónicos, medicamentos, perfumes, etc.)
   — pregunta siempre, afecta la modalidad disponible

6. Ciudad de origen en Brasil (ej: Curitiba, São Paulo, etc.)
   — determina si hay un costo de trecho adicional

7. ¿Se solicita servicio de pickup (recolección a domicilio)?

Instrucciones:
- Recolecta los datos de forma natural, no como un formulario.
- Puedes pedir varios datos en un mismo mensaje.
- NUNCA menciones ni anticipes la modalidad (Express, Terrestre, Aéreo) antes de llamar a calcular_flete. El sistema la determina automáticamente; tú solo recolectas los datos.
- Cuando tengas todos los datos, llama a calcular_flete sin avisarle al usuario.
- Presenta el campo "mensaje_formateado" de la respuesta tal como viene.
- Si hay error en el cálculo, explícalo y pide los datos correctos.`;

const HERRAMIENTA_MOTOR = {
  type: 'function',
  function: {
    name: 'calcular_flete',
    description: 'Calcula la cotización de envío Brasil → Venezuela. Llámala cuando tengas todos los datos del usuario. La modalidad se determina automáticamente.',
    parameters: {
      type: 'object',
      properties: {
        peso_bruto:        { type: 'number', description: 'Peso bruto en kg, sin redondear' },
        largo:             { type: 'number', description: 'Largo de la caja en cm' },
        ancho:             { type: 'number', description: 'Ancho de la caja en cm' },
        alto:              { type: 'number', description: 'Alto de la caja en cm' },
        valor_mercancia:   { type: 'number', description: 'Valor de la mercancía en R$' },
        tipo_mercancia:    { type: 'string', enum: ['personal', 'comercial'], description: '"personal" o "comercial"' },
        categorias:        { type: 'array', items: { type: 'string' }, description: 'Lista de categorías de los productos' },
        ciudad_origen:     { type: 'string', description: 'Ciudad de origen en Brasil' },
        pickup_solicitado: { type: 'boolean', description: 'true si el cliente solicita recolección a domicilio' }
      },
      required: ['peso_bruto', 'largo', 'ancho', 'alto', 'valor_mercancia', 'tipo_mercancia', 'categorias', 'ciudad_origen', 'pickup_solicitado']
    }
  }
};

// Sesiones en memoria
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastAccess < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

async function llamarMotor(args) {
  const res = await fetch(MOTOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    redirect: 'follow'
  });
  return res.json();
}

app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: 'Faltan campos' });

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const session = sessions.get(sessionId);
  session.lastAccess = Date.now();
  session.messages.push({ role: 'user', content: message });

  try {
    let response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages],
      tools: [HERRAMIENTA_MOTOR]
    });

    // Agentic loop
    while (response.choices[0].finish_reason === 'tool_calls') {
      const assistantMsg = response.choices[0].message;
      session.messages.push(assistantMsg);

      let mensajeDirecto = null;

      const toolResults = await Promise.all(
        assistantMsg.tool_calls.map(async call => {
          const args = JSON.parse(call.function.arguments);
          console.log(`[tool] calcular_flete →`, JSON.stringify(args));
          const resultado = await llamarMotor(args);
          console.log(`[tool] resultado →`, JSON.stringify(resultado));

          if (resultado.mensaje_formateado) {
            mensajeDirecto = resultado.mensaje_formateado;
          }

          return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(resultado)
          };
        })
      );

      session.messages.push(...toolResults);

      // Motor calculó OK → devolver resultado directo, sin que el LLM lo razone
      if (mensajeDirecto) {
        session.messages.push({ role: 'assistant', content: mensajeDirecto });
        return res.json({ reply: mensajeDirecto });
      }

      response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages],
        tools: [HERRAMIENTA_MOTOR]
      });
    }

    const texto = response.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: texto });

    res.json({ reply: texto });

  } catch (err) {
    console.error('[error]', err.message);
    const isQuota = err.status === 429 || err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('Rate limit');
    if (isQuota) {
      res.status(429).json({ quota: true });
    } else {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chatbot en http://localhost:${PORT}`));
