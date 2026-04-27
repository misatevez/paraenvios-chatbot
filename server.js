import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const MOTOR_URL = 'https://script.google.com/macros/s/AKfycbzTqb5It7FlqLOIlUut1CXJPEMTTzUDFqGduOtNSOxQXtcwr0SuBrr99991JA6jQR3Ypw/exec';

const SYSTEM_PROMPT = `Eres el asistente de cotizaciones de ParaEnvios, empresa especializada en envíos Brasil → Venezuela.
Tu trabajo es ayudar a calcular el costo de flete de manera conversacional y amigable.

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
- Si hay error en el cálculo, explícalo y pide los datos correctos.
- Responde siempre en español.`;

const HERRAMIENTA_MOTOR = {
  functionDeclarations: [{
    name: 'calcular_flete',
    description: 'Calcula el costo de flete Brasil → Venezuela. Llámala cuando tengas todos los datos del usuario.',
    parameters: {
      type: 'OBJECT',
      properties: {
        modalidad:            { type: 'STRING', description: 'Modalidad: express | peligroso | aereo_pac | aereo_sedex' },
        largo_cm:             { type: 'NUMBER', description: 'Largo de la caja en cm' },
        ancho_cm:             { type: 'NUMBER', description: 'Ancho de la caja en cm' },
        alto_cm:              { type: 'NUMBER', description: 'Alto de la caja en cm' },
        peso_bruto_kg:        { type: 'NUMBER', description: 'Peso bruto en kg' },
        valor_productos_brl:  { type: 'NUMBER', description: 'Valor de los productos en R$' },
        ciudad_destino:       { type: 'STRING', description: 'Ciudad destino en Venezuela' },
        tiene_trecho:         { type: 'BOOLEAN', description: 'true si la mercancía sale fuera de Curitiba' },
        taxa_adicional:       { type: 'NUMBER', description: 'Cargos adicionales en R$ (default 0)' },
      },
      required: ['modalidad', 'largo_cm', 'ancho_cm', 'alto_cm', 'peso_bruto_kg', 'valor_productos_brl', 'ciudad_destino', 'tiene_trecho']
    }
  }]
};

const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
  systemInstruction: SYSTEM_PROMPT,
  tools: [HERRAMIENTA_MOTOR]
});

async function generateWithRetry(contents, retries = 3, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.generateContent({ contents });
    } catch (err) {
      const isRetryable = err.message?.includes('503') || err.message?.includes('529') || err.message?.includes('overloaded');
      if (isRetryable && i < retries - 1) {
        console.log(`[retry ${i + 1}] modelo ocupado, reintentando en ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

// Sesiones en memoria: sessionId → { messages: [], lastAccess: timestamp }
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

  // Agrega el mensaje del usuario al historial
  session.messages.push({ role: 'user', parts: [{ text: message }] });

  try {
    let result = await generateWithRetry(session.messages);
    let response = result.response;

    // Agentic loop: ejecuta herramientas hasta obtener respuesta de texto
    while (response.functionCalls()?.length > 0) {
      const calls = response.functionCalls();

      // Guarda la respuesta del modelo (con function calls) en el historial
      session.messages.push({ role: 'model', parts: calls.map(c => ({ functionCall: c })) });

      // Ejecuta cada tool call y recoge los resultados
      const funcionResults = await Promise.all(
        calls.map(async call => {
          console.log(`[tool] ${call.name} →`, JSON.stringify(call.args));
          const resultado = await llamarMotor(call.args);
          console.log(`[tool] resultado →`, JSON.stringify(resultado));
          return { functionResponse: { name: call.name, response: resultado } };
        })
      );

      session.messages.push({ role: 'user', parts: funcionResults });

      result = await generateWithRetry(session.messages);
      response = result.response;
    }

    const texto = response.text();
    session.messages.push({ role: 'model', parts: [{ text: texto }] });

    res.json({ reply: texto });

  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chatbot en http://localhost:${PORT}`));
