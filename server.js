import express from 'express';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MOTOR_URL = 'https://script.google.com/macros/s/AKfycbzTqb5It7FlqLOIlUut1CXJPEMTTzUDFqGduOtNSOxQXtcwr0SuBrr99991JA6jQR3Ypw/exec';
const MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `Eres el asistente de cotizaciones de ParaEnvios, empresa especializada en envíos Brasil → Venezuela.
Eres bilíngüe: atiendes en español y en portugués según lo que elija el usuario.

IDIOMA: El usuario ya eligió su idioma al inicio de la conversación. Detecta cuál fue y úsalo en TODAS tus respuestas sin excepción. No mezcles idiomas.

Para calcular una cotización necesitas recolectar exactamente estos datos:

1. Modalidad de envío (explica las opciones si el usuario no sabe):
   - "express": LATAM Cargo — aéreo, tránsito ~30 días (la más usada)
   - "aereo_pac": Correios PAC — aéreo económico, ~25 días
   - "aereo_sedex": Correios SEDEX — aéreo rápido, ~16 días
   - "peligroso": terrestre — solo para mercancía peligrosa, ~30 días

2. Dimensiones de la caja en centímetros: largo, ancho, alto

3. Peso bruto en kg

4. Valor de los productos en Reales brasileños (R$)

5. Ciudad destino en Venezuela (Caracas, Maracaibo, Valencia, etc.)

6. ¿Está en Curitiba? — pregunta si la mercancía sale DESDE Curitiba o desde otra ciudad.
   Si es desde FUERA de Curitiba → tiene_trecho = true
   Si es desde Curitiba → tiene_trecho = false

Instrucciones:
- Recolecta los datos de forma natural, no como un formulario.
- Puedes pedir varios datos en un mismo mensaje.
- Cuando tengas todos los datos, llama a calcular_flete sin avisarle al usuario.
- Presenta el campo "mensaje_formateado" de la respuesta tal como viene.
- Si hay error en el cálculo, explícalo y pide los datos correctos.`;

const HERRAMIENTA_MOTOR = {
  type: 'function',
  function: {
    name: 'calcular_flete',
    description: 'Calcula el costo de flete Brasil → Venezuela. Llámala cuando tengas todos los datos del usuario.',
    parameters: {
      type: 'object',
      properties: {
        modalidad:            { type: 'string', enum: ['express', 'peligroso', 'aereo_pac', 'aereo_sedex'] },
        largo_cm:             { type: 'number' },
        ancho_cm:             { type: 'number' },
        alto_cm:              { type: 'number' },
        peso_bruto_kg:        { type: 'number' },
        valor_productos_brl:  { type: 'number' },
        ciudad_destino:       { type: 'string' },
        tiene_trecho:         { type: 'boolean' },
        taxa_adicional:       { type: 'number' }
      },
      required: ['modalidad', 'largo_cm', 'ancho_cm', 'alto_cm', 'peso_bruto_kg', 'valor_productos_brl', 'ciudad_destino', 'tiene_trecho']
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

      const toolResults = await Promise.all(
        assistantMsg.tool_calls.map(async call => {
          const args = JSON.parse(call.function.arguments);
          console.log(`[tool] calcular_flete →`, JSON.stringify(args));
          const resultado = await llamarMotor(args);
          console.log(`[tool] resultado →`, JSON.stringify(resultado));
          return {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(resultado)
          };
        })
      );

      session.messages.push(...toolResults);

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
