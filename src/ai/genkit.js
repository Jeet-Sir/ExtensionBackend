// ─────────────────────────────────────────────
// File: src/ai/genkit.js
// ─────────────────────────────────────────────

import { genkit } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';

// Central Genkit AI client
// Uses your existing GEMINI_API_KEY from .env
export const ai = genkit({
  plugins: [
    googleAI({
      apiKey: process.env.GEMINI_API_KEY,
    }),
  ],
  // Default model for text flows
  model: 'googleai/gemini-2.5-flash',
});