import { GoogleGenAI, Type } from "@google/genai";

const MAX_RETRIES = 2;
const RETRYABLE_STATUS = ['429', '500', '502', '503', '504'];
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const SERVER_ANALYZE_ENDPOINT = '/api/analyze';
const SERVER_NUTRITION_ENDPOINT = '/api/nutrition';

function getAiClient(): GoogleGenAI {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("CONFIG_ERROR: Falta VITE_GEMINI_API_KEY en el entorno.");
  }

  return new GoogleGenAI({ apiKey });
}

function getModelName(): string {
  const modelFromEnv = import.meta.env.VITE_GEMINI_MODEL;
  return modelFromEnv || DEFAULT_GEMINI_MODEL;
}

function canUseClientGemini(): boolean {
  return Boolean(import.meta.env.VITE_GEMINI_API_KEY);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGeminiError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit')) {
    return new Error(`QUOTA_EXCEEDED: ${message}`);
  }

  if (lower.includes('401') || lower.includes('403') || lower.includes('api key') || lower.includes('permission')) {
    return new Error(`AUTH_ERROR: ${message}`);
  }

  return new Error(fallback ? `${fallback} Detalle: ${message}` : message);
}

function shouldFallbackToClient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return lower.includes('api_unavailable')
    || lower.includes('failed to fetch')
    || lower.includes('networkerror')
    || lower.includes('invalid json');
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return RETRYABLE_STATUS.some((code) => message.includes(code)) || lower.includes('rate limit') || lower.includes('temporarily unavailable');
}

async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
): Promise<Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await ai.models.generateContent(params);
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < MAX_RETRIES && isRetryable(error);
      if (!shouldRetry) break;

      const waitMs = 800 * Math.pow(2, attempt);
      await delay(waitMs);
    }
  }

  throw lastError;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`API_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('API_UNAVAILABLE: Invalid JSON response from backend.');
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `HTTP_${response.status}`);
  }

  return data as T;
}

export interface Ingredient {
  nombre: string;
  peso_estimado_g: number;
  calorias: number;
  macros: {
    carbohidratos_g: number;
    proteinas_g: number;
    grasas_g: number;
  };
}

export interface NutritionResult {
  plato_identificado: string;
  calorias_totales: number;
  peso_total_estimado_g: number;
  macros_totales: {
    carbohidratos_g: number;
    proteinas_g: number;
    grasas_g: number;
  };
  ingredientes_detectados: Ingredient[];
  notas: string;
}

async function analyzeViaServer(base64Image: string, mimeType: string): Promise<NutritionResult> {
  return postJson<NutritionResult>(SERVER_ANALYZE_ENDPOINT, { base64Image, mimeType });
}

async function nutritionViaServer(ingredient: string, weight: number): Promise<Ingredient> {
  return postJson<Ingredient>(SERVER_NUTRITION_ENDPOINT, { ingredient, weight });
}

async function analyzeViaClient(base64Image: string, mimeType: string): Promise<NutritionResult> {
  const ai = getAiClient();
  const model = getModelName();
  
  const prompt = `Analiza esta imagen de comida. Identifica los ingredientes de forma individual, estima visualmente el peso en gramos de cada uno y calcula sus macronutrientes y calorías específicas. Finalmente, suma los totales del plato.
  Reglas:
  - Si no hay comida, devuelve error en 'notas' y valores numéricos en 0.
  - Estimación de peso basada en porciones estándar.
  - El desglose por ingrediente es fundamental.
  - Responde ÚNICAMENTE en JSON.`;

  let response;
  try {
    response = await generateContentWithRetry(ai, {
      model,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64Image.split(',')[1] || base64Image,
                mimeType
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
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
                grasas_g: { type: Type.NUMBER }
              },
              required: ["carbohidratos_g", "proteinas_g", "grasas_g"]
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
                      grasas_g: { type: Type.NUMBER }
                    },
                    required: ["carbohidratos_g", "proteinas_g", "grasas_g"]
                  }
                },
                required: ["nombre", "peso_estimado_g", "calorias", "macros"]
              }
            },
            notas: { type: Type.STRING }
          },
          required: ["plato_identificado", "calorias_totales", "peso_total_estimado_g", "macros_totales", "ingredientes_detectados", "notas"]
        }
      }
    });
  } catch (error) {
    throw normalizeGeminiError(error, "No se pudo analizar la imagen.");
  }

  try {
    return JSON.parse(response.text);
  } catch (error) {
    console.error("Error parsing Gemini response:", error);
    throw new Error("No se pudo procesar la respuesta del análisis.");
  }
}

async function nutritionViaClient(ingredient: string, weight: number): Promise<Ingredient> {
  const ai = getAiClient();
  const model = getModelName();
  
  const prompt = `Eres una base de datos nutricional ultra-precisa.
  Calcula las calorías y macronutrientes exactos para: "${ingredient}, ${weight}g".
  Reglas:
  - No des recetas ni consejos.
  - Responde ÚNICAMENTE en JSON.`;

  let response;
  try {
    response = await generateContentWithRetry(ai, {
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
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
                grasas_g: { type: Type.NUMBER }
              },
              required: ["carbohidratos_g", "proteinas_g", "grasas_g"]
            }
          },
          required: ["nombre_confirmado", "peso_g", "calorias", "macros"]
        }
      }
    });
  } catch (error) {
    throw normalizeGeminiError(error, "No se pudo obtener la información nutricional.");
  }

  try {
    const data = JSON.parse(response.text);
    return {
      nombre: data.nombre_confirmado,
      peso_estimado_g: data.peso_g,
      calorias: data.calorias,
      macros: data.macros
    };
  } catch (error) {
    console.error("Error parsing nutrition data:", error);
    throw new Error("No se pudo obtener la información nutricional.");
  }
}

export async function analyzeFoodImage(base64Image: string, mimeType: string): Promise<NutritionResult> {
  try {
    return await analyzeViaServer(base64Image, mimeType);
  } catch (serverError) {
    if (!canUseClientGemini() || !shouldFallbackToClient(serverError)) {
      throw serverError;
    }

    return analyzeViaClient(base64Image, mimeType);
  }
}

export async function getNutritionData(ingredient: string, weight: number): Promise<Ingredient> {
  try {
    return await nutritionViaServer(ingredient, weight);
  } catch (serverError) {
    if (!canUseClientGemini() || !shouldFallbackToClient(serverError)) {
      throw serverError;
    }

    return nutritionViaClient(ingredient, weight);
  }
}
