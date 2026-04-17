/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { Camera, Upload, Loader2, ChevronRight, PieChart, Info, AlertCircle, RefreshCcw, Save, Trash2, Plus, Edit2, Check, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { analyzeFoodImage, getNutritionData, NutritionResult, Ingredient } from './services/gemini';
import { cn } from './lib/utils';

interface SavedMeal extends NutritionResult {
  id: string;
  timestamp: number;
  customTitle: string;
  image: string;
}

interface DailyGoals {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}

interface UserProfile {
  age: number;
  gender: 'male' | 'female';
  weight: number;
  height: number;
  activity: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal: 'lose' | 'maintain' | 'gain';
  pace: 'slow' | 'moderate' | 'fast';
  proteinPreference: 'balanced' | 'high';
  carbPreference: 'balanced' | 'low';
  mealsPerDay: number;
  sleepHours: number;
}

const DEFAULT_PROFILE: UserProfile = {
  age: 30,
  gender: 'male',
  weight: 75,
  height: 175,
  activity: 'moderate',
  goal: 'maintain',
  pace: 'moderate',
  proteinPreference: 'balanced',
  carbPreference: 'balanced',
  mealsPerDay: 4,
  sleepHours: 7
};

const DEFAULT_GOALS: DailyGoals = {
  calories: 2000,
  carbs: 250,
  protein: 150,
  fat: 70
};

const ANALYSIS_CACHE_KEY = 'nutriscan_analysis_cache_v1';
const ANALYSIS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ITEMS = 30;

interface AnalysisCacheEntry {
  result: NutritionResult;
  savedAt: number;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

function isQuotaError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('quota_exceeded') || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit');
}

function isConfigError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('config_error') || msg.includes('vite_gemini_api_key');
}

function isAuthError(err: unknown): boolean {
  const msg = getErrorMessage(err).toLowerCase();
  return msg.includes('auth_error') || msg.includes('401') || msg.includes('403') || msg.includes('api key');
}

function getAnalysisErrorText(err: unknown): string {
  if (isQuotaError(err)) {
    return 'Límite de uso alcanzado. Espera un minuto e intenta de nuevo.';
  }

  if (isConfigError(err)) {
    return 'Falta configurar VITE_GEMINI_API_KEY en el entorno local.';
  }

  if (isAuthError(err)) {
    return 'La API key no es válida o no tiene permisos para el modelo.';
  }

  return 'Ocurrió un error al analizar la imagen. Por favor, intenta de nuevo.';
}

function getIngredientErrorText(err: unknown, mode: 'add' | 'edit'): string {
  if (isQuotaError(err)) {
    return 'Límite de uso alcanzado. Espera un minuto para continuar.';
  }

  if (isConfigError(err)) {
    return 'Falta configurar VITE_GEMINI_API_KEY en el entorno local.';
  }

  if (isAuthError(err)) {
    return 'La API key no es válida o no tiene permisos para el modelo.';
  }

  return mode === 'add'
    ? 'No se pudo obtener información para ese ingrediente.'
    : 'No se pudo actualizar la información del ingrediente.';
}

function loadAnalysisCache(): Record<string, AnalysisCacheEntry> {
  try {
    const raw = localStorage.getItem(ANALYSIS_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveAnalysisCache(cache: Record<string, AnalysisCacheEntry>) {
  localStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify(cache));
}

function getCachedAnalysis(cacheKey: string): NutritionResult | null {
  const cache = loadAnalysisCache();
  const entry = cache[cacheKey];
  if (!entry) return null;

  const isExpired = Date.now() - entry.savedAt > ANALYSIS_CACHE_TTL_MS;
  if (isExpired) {
    delete cache[cacheKey];
    saveAnalysisCache(cache);
    return null;
  }

  return entry.result;
}

function setCachedAnalysis(cacheKey: string, result: NutritionResult) {
  const cache = loadAnalysisCache();
  cache[cacheKey] = { result, savedAt: Date.now() };

  const entries = Object.entries(cache)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, ANALYSIS_CACHE_MAX_ITEMS);

  saveAnalysisCache(Object.fromEntries(entries));
}

async function buildImageCacheKey(base64: string, mimeType: string): Promise<string> {
  const payload = `${mimeType}:${base64}`;
  const buffer = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sanitizeProfile(raw: Partial<UserProfile>): UserProfile {
  return {
    ...DEFAULT_PROFILE,
    ...raw,
    age: clamp(Number(raw.age ?? DEFAULT_PROFILE.age), 12, 100),
    weight: clamp(Number(raw.weight ?? DEFAULT_PROFILE.weight), 30, 300),
    height: clamp(Number(raw.height ?? DEFAULT_PROFILE.height), 120, 230),
    mealsPerDay: clamp(Number(raw.mealsPerDay ?? DEFAULT_PROFILE.mealsPerDay), 2, 8),
    sleepHours: clamp(Number(raw.sleepHours ?? DEFAULT_PROFILE.sleepHours), 4, 12),
  };
}

export default function App() {
  const [view, setView] = useState<'tracker' | 'profile'>('tracker');
  const [image, setImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [currentResult, setCurrentResult] = useState<NutritionResult | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [meals, setMeals] = useState<SavedMeal[]>([]);
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  
  const [profile, setProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('nutriscan_profile');
    if (!saved) return DEFAULT_PROFILE;

    try {
      return sanitizeProfile(JSON.parse(saved));
    } catch {
      return DEFAULT_PROFILE;
    }
  });

  const [goals, setGoals] = useState<DailyGoals>(() => {
    const saved = localStorage.getItem('nutriscan_goals');
    return saved ? JSON.parse(saved) : DEFAULT_GOALS;
  });
  
  // Manual ingredient states
  const [newIngName, setNewIngName] = useState('');
  const [newIngWeight, setNewIngWeight] = useState('100');
  const [isAddingIng, setIsAddingIng] = useState(false);
  const [editingIngIndex, setEditingIngIndex] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load meals from localStorage on mount and cleanup old ones
  useEffect(() => {
    const saved = localStorage.getItem('nutriscan_meals');
    if (saved) {
      try {
        const allMeals: SavedMeal[] = JSON.parse(saved);
        // Keep only meals from the last 24 hours to save space
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        const recentMeals = allMeals.filter(m => m.timestamp > oneDayAgo);
        setMeals(recentMeals);
      } catch (e) {
        console.error("Error loading meals", e);
      }
    }
  }, []);

  // Save data to localStorage
  useEffect(() => {
    localStorage.setItem('nutriscan_meals', JSON.stringify(meals));
  }, [meals]);

  useEffect(() => {
    localStorage.setItem('nutriscan_profile', JSON.stringify(profile));
    calculateGoals();
  }, [profile]);

  useEffect(() => {
    localStorage.setItem('nutriscan_goals', JSON.stringify(goals));
  }, [goals]);

  const calculateGoals = () => {
    // Mifflin-St Jeor Equation
    let bmr = (10 * profile.weight) + (6.25 * profile.height) - (5 * profile.age);
    bmr = profile.gender === 'male' ? bmr + 5 : bmr - 161;

    const activityMultipliers = {
      sedentary: 1.2,
      light: 1.375,
      moderate: 1.55,
      active: 1.725,
      very_active: 1.9
    };

    const tdee = bmr * activityMultipliers[profile.activity];

    // Adjust based on goal + preferred pace
    let targetCalories = tdee;
    const loseAdjustments = { slow: -300, moderate: -500, fast: -700 };
    const gainAdjustments = { slow: 250, moderate: 400, fast: 550 };

    if (profile.goal === 'lose') {
      targetCalories += loseAdjustments[profile.pace];
    } else if (profile.goal === 'gain') {
      targetCalories += gainAdjustments[profile.pace];
    }

    // Personalize macros by goal and nutrition preferences.
    const baseProteinPerKg = profile.goal === 'lose' ? 2.0 : profile.goal === 'gain' ? 1.8 : 1.6;
    const proteinPerKg = baseProteinPerKg + (profile.proteinPreference === 'high' ? 0.2 : 0);

    const baseFatPerKg = profile.goal === 'gain' ? 1.0 : 0.9;
    const fatPerKg = baseFatPerKg + (profile.carbPreference === 'low' ? 0.2 : 0);

    let proteinGr = Math.round(profile.weight * proteinPerKg);
    let fatGr = Math.round(profile.weight * fatPerKg);
    let carbsGr = Math.round((targetCalories - (proteinGr * 4) - (fatGr * 9)) / 4);

    if (carbsGr < 80) {
      const minCarbs = 80;
      const missingCarbCalories = (minCarbs - carbsGr) * 4;
      const fatReduction = Math.ceil(missingCarbCalories / 9);
      fatGr = Math.max(Math.round(profile.weight * 0.6), fatGr - fatReduction);
      carbsGr = minCarbs;
      proteinGr = Math.max(80, proteinGr);
    }

    setGoals({
      calories: Math.round(targetCalories),
      protein: proteinGr,
      carbs: carbsGr,
      fat: fatGr
    });
  };

  const setProfileNumber = (key: 'age' | 'weight' | 'height' | 'mealsPerDay' | 'sleepHours', value: string) => {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) return;

    setProfile((prev) => sanitizeProfile({ ...prev, [key]: numericValue }));
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
        setCurrentResult(null);
        setCustomTitle('');
        setError(null);
        processImage(reader.result as string, file.type);
      };
      reader.readAsDataURL(file);
    }
  };

  const processImage = async (base64: string, mimeType: string) => {
    setIsAnalyzing(true);
    setError(null);
    try {
      const cacheKey = await buildImageCacheKey(base64, mimeType);
      const cached = getCachedAnalysis(cacheKey);
      if (cached) {
        setCurrentResult(cached);
        setCustomTitle(`Comida ${meals.length + 1}`);
        return;
      }

      const analysis = await analyzeFoodImage(base64, mimeType);
      setCurrentResult(analysis);
      setCachedAnalysis(cacheKey, analysis);
      setCustomTitle(`Comida ${meals.length + 1}`);
    } catch (err: unknown) {
      setError(getAnalysisErrorText(err));
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateMealTotals = (ingredients: Ingredient[]) => {
    if (!currentResult) return;
    
    const macros = ingredients.reduce((acc, ing) => ({
      carbohidratos_g: acc.carbohidratos_g + ing.macros.carbohidratos_g,
      proteinas_g: acc.proteinas_g + ing.macros.proteinas_g,
      grasas_g: acc.grasas_g + ing.macros.grasas_g
    }), { carbohidratos_g: 0, proteinas_g: 0, grasas_g: 0 });

    const calories = ingredients.reduce((acc, ing) => acc + ing.calorias, 0);
    const weight = ingredients.reduce((acc, ing) => acc + ing.peso_estimado_g, 0);

    setCurrentResult({
      ...currentResult,
      ingredientes_detectados: ingredients,
      macros_totales: macros,
      calorias_totales: Math.round(calories),
      peso_total_estimado_g: Math.round(weight)
    });
  };

  const handleAddIngredient = async () => {
    if (!newIngName || !newIngWeight || !currentResult) return;
    
    setIsUpdating(true);
    try {
      const data = await getNutritionData(newIngName, parseInt(newIngWeight));
      const updatedIngs = [...currentResult.ingredientes_detectados, data];
      updateMealTotals(updatedIngs);
      setNewIngName('');
      setIsAddingIng(false);
    } catch (err: unknown) {
      setError(getIngredientErrorText(err, 'add'));
    } finally {
      setIsUpdating(false);
    }
  };

  const handleEditIngredient = async (index: number) => {
    if (!newIngName || !newIngWeight || !currentResult) return;
    
    setIsUpdating(true);
    try {
      const data = await getNutritionData(newIngName, parseInt(newIngWeight));
      const updatedIngs = [...currentResult.ingredientes_detectados];
      updatedIngs[index] = data;
      updateMealTotals(updatedIngs);
      setNewIngName('');
      setEditingIngIndex(null);
    } catch (err: unknown) {
      setError(getIngredientErrorText(err, 'edit'));
    } finally {
      setIsUpdating(false);
    }
  };

  const startEditing = (index: number) => {
    const ing = currentResult?.ingredientes_detectados[index];
    if (ing) {
      setNewIngName(ing.nombre);
      setNewIngWeight(ing.peso_estimado_g.toString());
      setEditingIngIndex(index);
    }
  };

  const removeIngredient = (index: number) => {
    if (!currentResult) return;
    const updatedIngs = currentResult.ingredientes_detectados.filter((_, i) => i !== index);
    updateMealTotals(updatedIngs);
  };

  const saveMeal = () => {
    if (!currentResult) return;
    
    if (editingMealId) {
      setMeals(meals.map(m => m.id === editingMealId ? {
        ...currentResult,
        id: m.id,
        timestamp: m.timestamp,
        customTitle: customTitle || currentResult.plato_identificado,
        image: image || m.image
      } : m));
    } else {
      const newMeal: SavedMeal = {
        ...currentResult,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        customTitle: customTitle || currentResult.plato_identificado,
        image: image || ''
      };
      setMeals([newMeal, ...meals]);
    }
    
    reset();
  };

  const editSavedMeal = (meal: SavedMeal) => {
    setImage(meal.image);
    setCurrentResult(meal);
    setCustomTitle(meal.customTitle);
    setEditingMealId(meal.id);
    setError(null);
  };

  const cancelMealEdit = () => {
    reset();
  };

  const deleteMeal = (id: string) => {
    setMeals(meals.filter(m => m.id !== id));
  };

  const reset = () => {
    setImage(null);
    setCurrentResult(null);
    setCustomTitle('');
    setError(null);
    setIsAddingIng(false);
    setEditingMealId(null);
  };

  const totals = meals.reduce((acc, meal) => ({
    calories: acc.calories + meal.calorias_totales,
    carbs: acc.carbs + meal.macros_totales.carbohidratos_g,
    protein: acc.protein + meal.macros_totales.proteinas_g,
    fat: acc.fat + meal.macros_totales.grasas_g
  }), { calories: 0, carbs: 0, protein: 0, fat: 0 });

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans pb-24">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-gray-100 px-6 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <button 
            onClick={() => setView('tracker')}
            className="flex items-center gap-2 text-left"
          >
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
              <PieChart className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-xl tracking-tight">NutriScan AI</h1>
          </button>
          <div className="flex items-center gap-2">
            {image && view === 'tracker' && (
              <button 
                onClick={reset}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <RefreshCcw className="w-5 h-5 text-gray-400" />
              </button>
            )}
            <button 
              onClick={() => setView(view === 'tracker' ? 'profile' : 'tracker')}
              className={cn(
                "p-2 rounded-full transition-colors",
                view === 'profile' ? "bg-emerald-100 text-emerald-600" : "hover:bg-gray-100 text-gray-400"
              )}
            >
              <Edit2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 pt-6 space-y-8">
        {view === 'profile' ? (
          <motion.section 
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-6"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center text-emerald-600">
                <Edit2 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-black text-xl">Tu Perfil</h2>
                <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Configura tus objetivos</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Edad</label>
                <input 
                  type="number" 
                  value={profile.age}
                  onChange={(e) => setProfileNumber('age', e.target.value)}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Género</label>
                <select 
                  value={profile.gender}
                  onChange={(e) => setProfile({...profile, gender: e.target.value as any})}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none appearance-none"
                >
                  <option value="male">Hombre</option>
                  <option value="female">Mujer</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Peso (kg)</label>
                <input 
                  type="number" 
                  value={profile.weight}
                  onChange={(e) => setProfileNumber('weight', e.target.value)}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Altura (cm)</label>
                <input 
                  type="number" 
                  value={profile.height}
                  onChange={(e) => setProfileNumber('height', e.target.value)}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Actividad Física</label>
              <select 
                value={profile.activity}
                onChange={(e) => setProfile({...profile, activity: e.target.value as any})}
                className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none appearance-none"
              >
                <option value="sedentary">Sedentario (Poco ejercicio)</option>
                <option value="light">Ligero (1-3 días/semana)</option>
                <option value="moderate">Moderado (3-5 días/semana)</option>
                <option value="active">Activo (6-7 días/semana)</option>
                <option value="very_active">Muy Activo (Atleta)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Objetivo</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'lose', label: 'Definir', icon: '🔥' },
                  { id: 'maintain', label: 'Mantener', icon: '⚖️' },
                  { id: 'gain', label: 'Volumen', icon: '💪' }
                ].map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setProfile({...profile, goal: g.id as any})}
                    className={cn(
                      "flex flex-col items-center gap-1 p-3 rounded-2xl border-2 transition-all",
                      profile.goal === g.id 
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700" 
                        : "border-gray-100 bg-white text-gray-400 hover:border-gray-200"
                    )}
                  >
                    <span className="text-xl">{g.icon}</span>
                    <span className="text-[10px] font-bold uppercase">{g.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Ritmo del objetivo</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'slow', label: 'Suave' },
                  { id: 'moderate', label: 'Medio' },
                  { id: 'fast', label: 'Rápido' }
                ].map((pace) => (
                  <button
                    key={pace.id}
                    onClick={() => setProfile({ ...profile, pace: pace.id as UserProfile['pace'] })}
                    className={cn(
                      "p-3 rounded-2xl border-2 text-xs font-bold uppercase transition-all",
                      profile.pace === pace.id
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                        : "border-gray-100 text-gray-500 hover:border-gray-200"
                    )}
                  >
                    {pace.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Preferencia de proteínas</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'balanced', label: 'Balanceado' },
                  { id: 'high', label: 'Alta proteína' }
                ].map((pref) => (
                  <button
                    key={pref.id}
                    onClick={() => setProfile({ ...profile, proteinPreference: pref.id as UserProfile['proteinPreference'] })}
                    className={cn(
                      "p-3 rounded-2xl border-2 text-xs font-bold uppercase transition-all",
                      profile.proteinPreference === pref.id
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                        : "border-gray-100 text-gray-500 hover:border-gray-200"
                    )}
                  >
                    {pref.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Preferencia de carbohidratos</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'balanced', label: 'Balanceado' },
                  { id: 'low', label: 'Bajo en carbos' }
                ].map((pref) => (
                  <button
                    key={pref.id}
                    onClick={() => setProfile({ ...profile, carbPreference: pref.id as UserProfile['carbPreference'] })}
                    className={cn(
                      "p-3 rounded-2xl border-2 text-xs font-bold uppercase transition-all",
                      profile.carbPreference === pref.id
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                        : "border-gray-100 text-gray-500 hover:border-gray-200"
                    )}
                  >
                    {pref.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Comidas al día</label>
                <input
                  type="number"
                  min={2}
                  max={8}
                  value={profile.mealsPerDay}
                  onChange={(e) => setProfileNumber('mealsPerDay', e.target.value)}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-gray-400 uppercase ml-1">Sueño promedio (h)</label>
                <input
                  type="number"
                  min={4}
                  max={12}
                  value={profile.sleepHours}
                  onChange={(e) => setProfileNumber('sleepHours', e.target.value)}
                  className="w-full bg-gray-50 border-none rounded-2xl px-4 py-3 font-bold focus:ring-2 focus:ring-emerald-500 outline-none"
                />
              </div>
            </div>

            <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
              <p className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider mb-2">Plan personalizado</p>
              <p className="text-sm text-emerald-900 font-semibold leading-snug">
                {goals.calories} kcal · {goals.protein}g proteína · {goals.carbs}g carbos · {goals.fat}g grasas
              </p>
              <p className="text-xs text-emerald-700 mt-2">
                Reparto sugerido: aprox. {Math.round(goals.calories / profile.mealsPerDay)} kcal por comida en {profile.mealsPerDay} tomas.
              </p>
            </div>

            <button 
              onClick={() => setView('tracker')}
              className="w-full bg-emerald-500 text-white font-bold py-4 rounded-2xl shadow-lg shadow-emerald-100 active:scale-[0.98] transition-all"
            >
              Guardar y Continuar
            </button>
          </motion.section>
        ) : (
          <>
            {/* Daily Summary */}
            <section className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-6">
          <div className="flex justify-between items-end">
            <div>
              <h3 className="text-gray-400 text-xs font-bold uppercase tracking-widest mb-1">Resumen Diario</h3>
              <p className="text-3xl font-black text-emerald-600">{totals.calories} <span className="text-lg font-bold text-gray-400">/ {goals.calories} kcal</span></p>
            </div>
          </div>

          <div className="space-y-4">
            <ProgressBar label="Carbohidratos" current={totals.carbs} goal={goals.carbs} color="bg-blue-500" unit="g" />
            <ProgressBar label="Proteínas" current={totals.protein} goal={goals.protein} color="bg-red-500" unit="g" />
            <ProgressBar label="Grasas" current={totals.fat} goal={goals.fat} color="bg-amber-500" unit="g" />
          </div>
        </section>

        <AnimatePresence mode="wait">
          {!image ? (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-6"
            >
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full group relative overflow-hidden bg-emerald-500 text-white rounded-3xl p-8 flex flex-col items-center justify-center gap-4 transition-all hover:bg-emerald-600 active:scale-[0.98] shadow-lg shadow-emerald-200"
              >
                <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center">
                  <Plus className="w-8 h-8 text-white" />
                </div>
                <div className="text-center">
                  <span className="block font-bold text-xl">Añadir Comida</span>
                  <span className="text-sm text-white/70">Escanea tu plato ahora</span>
                </div>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImageUpload}
                accept="image/*"
                className="hidden"
              />

              {/* History List */}
              {meals.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-gray-400 text-xs font-bold uppercase tracking-widest px-2">Historial de Hoy</h3>
                  <div className="space-y-3">
                    {meals.map((meal) => (
                      <motion.div 
                        layout
                        key={meal.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="bg-white rounded-2xl p-4 flex items-center justify-between shadow-sm border border-gray-100"
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-emerald-600 font-bold">
                            {meal.calorias_totales}
                          </div>
                          <div>
                            <h4 className="font-bold text-gray-900">{meal.customTitle}</h4>
                            <p className="text-xs text-gray-400">{new Date(meal.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {meal.plato_identificado}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => editSavedMeal(meal)}
                            className="p-2 text-gray-300 hover:text-emerald-500 transition-colors"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => deleteMeal(meal.id)}
                            className="p-2 text-gray-300 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              {/* Image Preview */}
              <div className="relative aspect-square rounded-3xl overflow-hidden shadow-xl shadow-emerald-900/5">
                <img 
                  src={image} 
                  alt="Comida a analizar" 
                  className="w-full h-full object-cover"
                />
                {(isAnalyzing || isUpdating) && (
                  <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 text-center">
                    <Loader2 className="w-10 h-10 animate-spin mb-4" />
                    <p className="font-bold text-lg">{isAnalyzing ? 'Analizando tu plato...' : 'Actualizando datos...'}</p>
                    <p className="text-sm opacity-80 mt-2">
                      {isAnalyzing ? 'Identificando ingredientes y calculando macros' : 'Consultando base de datos nutricional'}
                    </p>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex gap-3 items-start text-red-800">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}

              {currentResult && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-6"
                >
                  {/* Naming and Saving */}
                  <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 space-y-4">
                    <div>
                      <label className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2 block">Título de la comida</label>
                      <input 
                        type="text"
                        value={customTitle}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        placeholder="Ej. Desayuno Saludable"
                        className="w-full bg-gray-50 border-none rounded-xl px-4 py-3 font-bold text-lg focus:ring-2 focus:ring-emerald-500 outline-none"
                      />
                    </div>

                    <div className="flex gap-3">
                      <div className="flex-1 bg-emerald-50 rounded-2xl p-4">
                        <span className="block text-emerald-800 font-black text-3xl">{currentResult.calorias_totales}</span>
                        <span className="text-emerald-600 text-xs font-bold uppercase">Calorías Totales</span>
                      </div>
                      <div className="flex-1 space-y-2">
                        <button
                          onClick={saveMeal}
                          className="w-full bg-emerald-500 text-white rounded-2xl p-4 font-bold flex flex-col items-center justify-center gap-1 active:scale-[0.98] transition-transform shadow-lg shadow-emerald-100"
                        >
                          <Save className="w-6 h-6" />
                          <span className="text-xs uppercase">{editingMealId ? 'Actualizar' : 'Guardar'}</span>
                        </button>
                        {editingMealId && (
                          <button
                            onClick={cancelMealEdit}
                            className="w-full bg-gray-100 text-gray-700 rounded-2xl py-2 text-xs font-bold uppercase tracking-wide hover:bg-gray-200 transition-colors"
                          >
                            Cancelar edición
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="bg-gray-50 rounded-2xl p-4">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-gray-400 text-[10px] font-bold uppercase">Peso Total Estimado</span>
                        <span className="text-gray-900 font-bold">{currentResult.peso_total_estimado_g}g</span>
                      </div>
                      <p className="text-[11px] text-gray-500 leading-tight italic">"{currentResult.notas}"</p>
                    </div>
                  </div>

                  {/* Macros */}
                  <div className="grid grid-cols-3 gap-3">
                    <MacroCard label="Carbs" value={currentResult.macros_totales.carbohidratos_g} color="bg-blue-500" />
                    <MacroCard label="Proteína" value={currentResult.macros_totales.proteinas_g} color="bg-red-500" />
                    <MacroCard label="Grasas" value={currentResult.macros_totales.grasas_g} color="bg-amber-500" />
                  </div>

                  {/* Ingredients Breakdown */}
                  <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-gray-400 text-sm font-bold uppercase tracking-wider">Desglose por Ingrediente</h3>
                      <button 
                        onClick={() => setIsAddingIng(!isAddingIng)}
                        className="p-2 bg-emerald-50 text-emerald-600 rounded-full hover:bg-emerald-100 transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>

                    <AnimatePresence>
                      {isAddingIng && (
                        <motion.div 
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden mb-6"
                        >
                          <div className="bg-gray-50 rounded-2xl p-4 space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              <input 
                                type="text"
                                placeholder="Nombre (ej. Hummus)"
                                value={newIngName}
                                onChange={(e) => setNewIngName(e.target.value)}
                                className="bg-white border-none rounded-xl px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                              <input 
                                type="number"
                                placeholder="Gramos"
                                value={newIngWeight}
                                onChange={(e) => setNewIngWeight(e.target.value)}
                                className="bg-white border-none rounded-xl px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                              />
                            </div>
                            <div className="flex gap-2">
                              <button 
                                onClick={handleAddIngredient}
                                disabled={!newIngName || isUpdating}
                                className="flex-1 bg-emerald-500 text-white py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                              >
                                {isUpdating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Añadir
                              </button>
                              <button 
                                onClick={() => setIsAddingIng(false)}
                                className="px-4 py-2 bg-gray-200 text-gray-600 rounded-xl text-xs font-bold"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="space-y-4">
                      {currentResult.ingredientes_detectados.map((ing, i) => (
                        <div key={i} className="border-b border-gray-50 pb-4 last:border-0 last:pb-0">
                          {editingIngIndex === i ? (
                            <div className="bg-gray-50 rounded-2xl p-4 space-y-3">
                              <div className="grid grid-cols-2 gap-3">
                                <input 
                                  type="text"
                                  value={newIngName}
                                  onChange={(e) => setNewIngName(e.target.value)}
                                  className="bg-white border-none rounded-xl px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                                />
                                <input 
                                  type="number"
                                  value={newIngWeight}
                                  onChange={(e) => setNewIngWeight(e.target.value)}
                                  className="bg-white border-none rounded-xl px-3 py-2 text-sm font-medium outline-none focus:ring-1 focus:ring-emerald-500"
                                />
                              </div>
                              <div className="flex gap-2">
                                <button 
                                  onClick={() => handleEditIngredient(i)}
                                  disabled={!newIngName || isUpdating}
                                  className="flex-1 bg-emerald-500 text-white py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                                >
                                  {isUpdating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  Actualizar
                                </button>
                                <button 
                                  onClick={() => setEditingIngIndex(null)}
                                  className="px-4 py-2 bg-gray-200 text-gray-600 rounded-xl text-xs font-bold"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex justify-between items-start mb-2">
                                <div>
                                  <h4 className="font-bold text-gray-900">{ing.nombre}</h4>
                                  <span className="text-xs text-gray-400">{ing.peso_estimado_g}g • {ing.calorias} kcal</span>
                                </div>
                                <div className="flex gap-1">
                                  <button 
                                    onClick={() => startEditing(i)}
                                    className="p-1 text-gray-300 hover:text-emerald-500 transition-colors"
                                  >
                                    <Edit2 className="w-3 h-3" />
                                  </button>
                                  <button 
                                    onClick={() => removeIngredient(i)}
                                    className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                              <div className="flex gap-4">
                                <MiniMacro label="C" value={ing.macros.carbohidratos_g} color="text-blue-500" />
                                <MiniMacro label="P" value={ing.macros.proteinas_g} color="text-red-500" />
                                <MiniMacro label="G" value={ing.macros.grasas_g} color="text-amber-500" />
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
          </>
        )}
      </main>
    </div>
  );
}

function MiniMacro({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className={cn("text-[10px] font-black", color)}>{label}</span>
      <span className="text-[10px] font-bold text-gray-600">{value}g</span>
    </div>
  );
}

function ProgressBar({ label, current, goal, color, unit }: { label: string; current: number; goal: number; color: string; unit: string }) {
  const percentage = Math.min((current / goal) * 100, 100);
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider">
        <span className="text-gray-500">{label}</span>
        <span className="text-gray-900">{current}{unit} <span className="text-gray-300">/ {goal}{unit}</span></span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          className={cn("h-full rounded-full transition-all duration-500", color)}
        />
      </div>
    </div>
  );
}

function MacroCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex flex-col items-center text-center">
      <div className={cn("w-2 h-2 rounded-full mb-2", color)} />
      <span className="block font-black text-xl">{value}g</span>
      <span className="text-gray-400 text-[10px] font-bold uppercase">{label}</span>
    </div>
  );
}
