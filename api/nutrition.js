import { Type } from '@google/genai';
import { generateWithRetry, getAiClient, getServerModelName, parseJsonBody, toHttpError } from './_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  try {
    const body = parseJsonBody(req);
    const ingredient = body?.ingredient;
    const weight = Number(body?.weight);

    if (!ingredient || Number.isNaN(weight) || weight <= 0) {
      res.status(400).json({ error: 'INVALID_REQUEST: ingredient and positive weight are required.' });
      return;
    }

    const ai = getAiClient();
    const model = getServerModelName();

    const prompt = `Eres una base de datos nutricional ultra-precisa.
Calcula las calorías y macronutrientes exactos para: "${ingredient}, ${weight}g".
Reglas:
- No des recetas ni consejos.
- Responde ÚNICAMENTE en JSON.`;

    const response = await generateWithRetry(ai, {
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            nombre_confirmado: { type: Type.STRING },
            peso_g: { type: Type.NUMBER },
            calorias: { type: Type.NUMBER },
            macros: {
              type: Type.OBJECT,
              properties: {
                carbohidratos_g: { type: Type.NUMBER },
                proteinas_g: { type: Type.NUMBER },
                grasas_g: { type: Type.NUMBER },
              },
              required: ['carbohidratos_g', 'proteinas_g', 'grasas_g'],
            },
          },
          required: ['nombre_confirmado', 'peso_g', 'calorias', 'macros'],
        },
      },
    });

    const data = JSON.parse(response.text);
    res.status(200).json({
      nombre: data.nombre_confirmado,
      peso_estimado_g: data.peso_g,
      calorias: data.calorias,
      macros: data.macros,
    });
  } catch (error) {
    const httpError = toHttpError(error, 'No se pudo obtener la información nutricional.');
    res.status(httpError.status).json({ error: httpError.error });
  }
}
