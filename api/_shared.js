import { GoogleGenAI } from '@google/genai';

const MAX_RETRIES = 2;
const RETRYABLE_STATUS = ['429', '500', '502', '503', '504'];
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

export function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

export function getServerModelName() {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

export function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('CONFIG_ERROR: Missing GEMINI_API_KEY server environment variable.');
  }

  return new GoogleGenAI({ apiKey });
}

export function normalizeGeminiError(error, fallback) {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit')) {
    return new Error(`QUOTA_EXCEEDED: ${message}`);
  }

  if (lower.includes('401') || lower.includes('403') || lower.includes('api key') || lower.includes('permission')) {
    return new Error(`AUTH_ERROR: ${message}`);
  }

  return new Error(`${fallback} Detalle: ${message}`);
}

function isRetryable(error) {
  const message = getErrorMessage(error);
  const lower = message.toLowerCase();

  return RETRYABLE_STATUS.some((statusCode) => message.includes(statusCode))
    || lower.includes('rate limit')
    || lower.includes('temporarily unavailable');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateWithRetry(ai, params) {
  let lastError;

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

export function toHttpError(error, fallbackMessage) {
  const normalized = normalizeGeminiError(error, fallbackMessage);
  const message = getErrorMessage(normalized);

  if (message.includes('QUOTA_EXCEEDED')) {
    return { status: 429, error: message };
  }

  if (message.includes('AUTH_ERROR')) {
    return { status: 401, error: message };
  }

  if (message.includes('CONFIG_ERROR')) {
    return { status: 500, error: message };
  }

  return { status: 500, error: message };
}
