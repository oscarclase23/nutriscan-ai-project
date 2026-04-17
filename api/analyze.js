import { Type } from '@google/genai';
import { generateWithRetry, getAiClient, getServerModelName, parseJsonBody, toHttpError } from './_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  try {
    const body = parseJsonBody(req);
    const base64Image = body?.base64Image;
    const mimeType = body?.mimeType;

    if (!base64Image || !mimeType) {
      res.status(400).json({ error: 'INVALID_REQUEST: base64Image and mimeType are required.' });
      return;
    }

    const ai = getAiClient();
    const model = getServerModelName();

    const prompt = `Analiza esta imagen de comida. Identifica los ingredientes de forma individual, estima visualmente el peso en gramos de cada uno y calcula sus macronutrientes y calorías específicas. Finalmente, suma los totales del plato.
Reglas:
- Si no hay comida, devuelve error en 'notas' y valores numéricos en 0.
- Estimación de peso basada en porciones estándar.
- El desglose por ingrediente es fundamental.
- Responde ÚNICAMENTE en JSON.`;

    const imageData = String(base64Image).split(',')[1] || String(base64Image);

    const response = await generateWithRetry(ai, {
      model,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: imageData,
                mimeType,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            plato_identificado: { type: Type.STRING },
            calorias_totales: { type: Type.NUMBER },
            peso_total_estimado_g: { type: Type.NUMBER },
            macros_totales: {
              type: Type.OBJECT,
              properties: {
                carbohidratos_g: { type: Type.NUMBER },
                proteinas_g: { type: Type.NUMBER },
                grasas_g: { type: Type.NUMBER },
              },
              required: ['carbohidratos_g', 'proteinas_g', 'grasas_g'],
            },
            ingredientes_detectados: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  nombre: { type: Type.STRING },
                  peso_estimado_g: { type: Type.NUMBER },
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
                required: ['nombre', 'peso_estimado_g', 'calorias', 'macros'],
              },
            },
            notas: { type: Type.STRING },
          },
          required: [
            'plato_identificado',
            'calorias_totales',
            'peso_total_estimado_g',
            'macros_totales',
            'ingredientes_detectados',
            'notas',
          ],
        },
      },
    });

    const parsed = JSON.parse(response.text);
    res.status(200).json(parsed);
  } catch (error) {
    const httpError = toHttpError(error, 'No se pudo analizar la imagen.');
    res.status(httpError.status).json({ error: httpError.error });
  }
}
