import express from 'express';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MOTOR_URL = 'https://script.google.com/macros/s/AKfycbw-Rlaum9liDV45GDkPNcetAGxhJnFzDGzR0Q8uhINeh_VxFXoU9dawKjpd3QEHb34vlw/exec';
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
Por cada caja:
  - Peso bruto en kg (sin redondear)
  - Dimensiones en cm: largo, ancho, alto
  - Valor de la mercancía en R$

Datos comunes del envío:
  - Tipo de mercancía: "personal" o "comercial"
  - Categorías del producto (ropa, perfume, electrónicos, etc.)
  - Ciudad de origen en Brasil

Si hay varias cajas, numerálas (Caja 1, Caja 2…) y recolectá los datos de cada una.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIMER MENSAJE (cuando el cliente saluda o abre el chat)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Respondé SIEMPRE con este mensaje exacto (traducido al idioma del usuario):

"¡Hola! Soy el cotizador de Praia Envíos 🇧🇷➡️🇻🇪

Para darte la cotización necesito los siguientes datos:

📦 *Por cada caja:*
• Peso bruto en kg
• Dimensiones en cm (largo × ancho × alto)
• Valor de la mercancía en R$

📋 *Del envío:*
• Tipo: personal o comercial
• Producto (ej: ropa, calzado, electrónicos, perfume...)
• Ciudad de origen en Brasil

Podés enviarlo todo en un solo mensaje, así:
_20 kg | 40×50×45 cm | R$4.500 | personal | ropa | São Paulo_

Si tenés varias cajas, enumerálas: Caja 1, Caja 2..."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS ESTRICTAS DE COMPORTAMIENTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- En el primer mensaje siempre mostrá el template de arriba.
- Cuando el usuario dé los datos en un solo mensaje, extraélos todos
  y llama a calcular_flete de inmediato sin hacer preguntas innecesarias.
- Si falta algún dato, pedí SOLO el que falta, en un mensaje corto.
- NUNCA hagas comentarios sobre la categoría del producto. No es tu decisión.
- NUNCA digas qué modalidad aplica o no aplica. No es tu decisión.
- NUNCA anticipes restricciones, advertencias ni explicaciones sobre
  perfumes, baterías, alcohol, ni ninguna categoría. No es tu decisión.
- NUNCA pidas confirmación de datos que el usuario ya dio claramente.
- Cuando tengas todos los datos de todas las cajas, llamá a calcular_flete inmediatamente y
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
        boxes: {
          type: 'array',
          description: 'Lista de cajas del envío (una o más)',
          items: {
            type: 'object',
            properties: {
              peso_bruto:      { type: 'number', description: 'Peso bruto en kg, sin redondear' },
              largo:           { type: 'number', description: 'Largo en cm' },
              ancho:           { type: 'number', description: 'Ancho en cm' },
              alto:            { type: 'number', description: 'Alto en cm' },
              valor_mercancia: { type: 'number', description: 'Valor de la mercancía de esta caja en R$' }
            },
            required: ['peso_bruto', 'largo', 'ancho', 'alto', 'valor_mercancia']
          }
        },
        tipo_mercancia:    { type: 'string', enum: ['personal', 'comercial'], description: '"personal" o "comercial"' },
        categorias:        { type: 'array', items: { type: 'string' }, description: 'Lista de categorías de los productos' },
        ciudad_origen:     { type: 'string', description: 'Ciudad de origen en Brasil' }
      },
      required: ['boxes', 'tipo_mercancia', 'categorias', 'ciudad_origen']
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

const BIENVENIDA_ES = `¡Hola! Soy el cotizador de Praia Envíos 🇧🇷➡️🇻🇪

Para darte la cotización necesito los siguientes datos:

📦 *Por cada caja:*
• Peso bruto en kg
• Dimensiones en cm (largo × ancho × alto)
• Valor de la mercancía en R$

📋 *Del envío:*
• Tipo: personal o comercial
• Producto (ej: ropa, calzado, electrónicos, perfume...)
• Ciudad de origen en Brasil

Podés enviarlo todo en un solo mensaje, así:
_20 kg | 40×50×45 cm | R$4.500 | personal | ropa | São Paulo_

Si tenés varias cajas, enumerálas: Caja 1, Caja 2...`;

const BIENVENIDA_PT = `Olá! Sou o cotador da Praia Envios 🇧🇷➡️🇻🇪

Para te dar a cotação preciso dos seguintes dados:

📦 *Por caixa:*
• Peso bruto em kg
• Dimensões em cm (comprimento × largura × altura)
• Valor da mercadoria em R$

📋 *Do envio:*
• Tipo: pessoal ou comercial
• Produto (ex: roupa, calçado, eletrônicos, perfume...)
• Cidade de origem no Brasil

Pode enviar tudo em uma única mensagem, assim:
_20 kg | 40×50×45 cm | R$4.500 | pessoal | roupa | São Paulo_

Se tiver várias caixas, enumere-as: Caixa 1, Caixa 2...`;

const SALUDOS = ['hola','ola','hi','hello','hey','bom dia','boa tarde','boa noite','buenos dias','buenas','buenas tardes','buenas noches','oi','oie'];

function esSaludo(msg) {
  return SALUDOS.includes(msg.toLowerCase().trim().replace(/[!¡.,]+/g,''));
}

app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: 'Faltan campos' });

  const esNueva = !sessions.has(sessionId);
  if (esNueva) {
    sessions.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const session = sessions.get(sessionId);

  // Primer mensaje de la sesión: devolver bienvenida directo sin llamar a OpenAI
  if (esNueva || (session.messages.length === 0 && esSaludo(message))) {
    const idiomaPt = /^(oi|olá|ola|bom|boa|oie)/i.test(message.trim());
    const bienvenida = idiomaPt ? BIENVENIDA_PT : BIENVENIDA_ES;
    session.messages.push({ role: 'assistant', content: bienvenida });
    session.lastAccess = Date.now();
    return res.json({ reply: bienvenida });
  }
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

// Endpoint para Whapify: recibe el JSON del motor extraído por el script [DATOS]
app.post('/cotizar', async (req, res) => {
  const { boxes, tipo_mercancia, categorias, ciudad_origen } = req.body;
  if (!boxes || !tipo_mercancia || !categorias || !ciudad_origen) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    console.log(`[cotizar] →`, JSON.stringify(req.body));
    const resultado = await llamarMotor(req.body);
    console.log(`[cotizar] resultado →`, JSON.stringify(resultado));
    res.json(resultado);
  } catch (err) {
    console.error('[cotizar error]', err.message);
    res.status(500).json({ error: 'Error al contactar el motor' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: 'v2-bienvenida' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chatbot en http://localhost:${PORT}`));
