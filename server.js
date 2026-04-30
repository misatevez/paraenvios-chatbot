import express from 'express';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MOTOR_URL = 'https://script.google.com/macros/s/AKfycbxNaYIoNC8WUoQ5P0RucLBabdDBP26gqhXzmwwfrzaRRlNwYsLm3FYQeaLqrKYzKK8WaQ/exec';
const MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `Eres el asistente de cotizaciones de Praia Envíos, empresa especializada
en envíos Brasil → Venezuela.
Eres bilingüe: atiendes en español y en portugués según lo que elija el usuario.

IDIOMA: Detecta el idioma del usuario en su primer mensaje y úsalo en TODAS
tus respuestas sin excepción. No mezcles idiomas.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TU ÚNICO ROL: RECOLECTAR DATOS Y LLAMAR AL MOTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
No eres quien decide la modalidad. No eres quien calcula. No eres quien
filtra productos. Esas decisiones las toma exclusivamente el motor interno.
Tu trabajo termina cuando llamas a calcular_flete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DATOS A RECOLECTAR (todos obligatorios)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Peso bruto en kg (sin redondear)
2. Dimensiones de la caja en cm: largo, ancho, alto
3. Valor de la mercancía en R$
4. Tipo de mercancía: "personal" o "comercial"
5. Categorías del producto (ropa, perfume, electrónicos, etc.)
6. Ciudad de origen en Brasil

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS ESTRICTAS DE COMPORTAMIENTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Recolecta los datos de forma natural, no como formulario.
- Podés pedir varios datos en un mismo mensaje.
- Cuando el usuario dé los datos en un solo mensaje, extraélos todos
  y llama a calcular_flete de inmediato sin hacer preguntas innecesarias.
- NUNCA hagas comentarios sobre la categoría del producto. No es tu decisión.
- NUNCA digas qué modalidad aplica o no aplica. No es tu decisión.
- NUNCA anticipes restricciones, advertencias ni explicaciones sobre
  perfumes, baterías, alcohol, ni ninguna categoría. No es tu decisión.
- NUNCA pidas confirmación de datos que el usuario ya dio claramente.
- Cuando tengas los 6 datos, llamá a calcular_flete inmediatamente y
  en silencio, sin avisarle al usuario.
- Mostrá el campo "mensaje_formateado" de la respuesta exactamente como viene.
- Si el motor devuelve error, explicalo y pedí los datos correctos.`;

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
        ciudad_origen:     { type: 'string', description: 'Ciudad de origen en Brasil' }
      },
      required: ['peso_bruto', 'largo', 'ancho', 'alto', 'valor_mercancia', 'tipo_mercancia', 'categorias', 'ciudad_origen']
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
