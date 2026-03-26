// ─────────────────────────────────────────────
// File: src/flows/chatBasedProfileUpdate.js
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

// Types & Schemas
export const ChatBasedProfileUpdateInputSchema = z.object({
  message: z.string().describe('The user message to interpret for profile updates.'),
  userProfile: z.record(z.any()).describe('The current user profile data.'),
  chatHistory: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .optional()
    .describe('Previous chat history.'),
  documents: z
    .array(z.record(z.any()))
    .optional()
    .describe('A list of documents the user has uploaded, including extracted data.'),
  pageContext: z
    .object({
      pageUrl: z.string().optional(),
      pageTitle: z.string().optional(),
      fields: z.array(z.record(z.any())).optional(),
    })
    .optional()
    .describe('Context about the current web page the user is viewing.'),
});

export const ChatBasedProfileUpdateOutputSchema = z.object({
  aiResponse: z.string().describe('The AI response to the user message.'),
  // JSON string of updated fields so the flow is robust to LLM mistakes
  // JSON string of updated fields so the flow is robust to LLM mistakes
  updatedFields: z.string().optional().describe('A JSON string payload of updated profile fields, if any.'),
  suggestedFills: z
    .array(
      z.object({
        label: z.string(),
        suggested_value: z.string(),
        selector_css: z.string().optional(),
        selector_id: z.string().optional(),
        selector_name: z.string().optional(),
      }),
    )
    .optional()
    .describe('List of fields to autofill on the current page based on user request.'),
});

// Prompt definition
export const chatBasedProfileUpdatePrompt = ai.definePrompt({
  name: 'chatBasedProfileUpdatePrompt',
  input: { schema: ChatBasedProfileUpdateInputSchema },
  output: { schema: ChatBasedProfileUpdateOutputSchema },
  prompt: `You are FormFlow AI, a friendly and context-aware AI assistant. Your primary roles are:
1. **Conversational Partner**: If the user's message is a simple greeting or casual chat, respond naturally. Do NOT talk about profiles or documents unless they explicitly ask.
2. **Profile Manager**: When the user mentions life changes (new city, new phone, new job, etc.), extract only the changed fields and return them in \
"updatedFields\" as a JSON string.
3. **Document Expert**: When they ask about documents or their personal details, YOU MUST use the provided extracted document data.

Current Profile Data (JSON):
{{userProfile}}

Uploaded Documents (JSON):
Uploaded Documents (JSON):
{{#each documents}}
- Document Type: {{this.documentType}}
  Extracted Data: {{json this.extractedData}}
{{/each}}

Current Page Context:
- URL: {{pageContext.pageUrl}}
- Title: {{pageContext.pageTitle}}
- Form Fields ({{pageContext.fields.length}}):
{{#each pageContext.fields}}
  - {{this.label}} ({{this.input_type}})
{{/each}}

Conversation History:
{{#each chatHistory}}
- {{this.role}}: {{this.content}}
{{/each}}

User Message: {{message}}

Behavior:
- If it's a greeting / small talk: just chat. Do NOT update profile.
- If it's a question about the user (e.g., "what is my name?", "what is my address?"):
  - First check "Current Profile Data".
  - If the answer is NOT in the profile, YOU MUST SEARCH "Uploaded Documents" (extractedData).
  - If found in documents, answer the user's question using that data.
- If it's a profile update: confirm conversationally AND put only the changed fields into \
"updatedFields\" as a JSON string.
- If the user asks to "fill" or "autofill" the form (e.g., "fill my name", "fill all fields"):
  - Look at "Current Page Context" for available fields.
  - Map the user's "Current Profile Data" or "Uploaded Documents" to these fields.
  - Return the mapped fields in "suggestedFills".
  - "suggested_value" MUST be the real value from the user's data.
  - "selector_css", "selector_id", "selector_name" MUST match the field definition from "Current Page Context".
- Never invent data. If you are unsure, do not update that field.
- Output MUST follow the output schema exactly.
`,
});

export const chatBasedProfileUpdateFlow = ai.defineFlow(
  {
    name: 'chatBasedProfileUpdateFlow',
    inputSchema: ChatBasedProfileUpdateInputSchema,
    outputSchema: ChatBasedProfileUpdateOutputSchema,
  },
  async (input) => {
    console.log('[DEBUG] chatBasedProfileUpdateFlow input:', JSON.stringify(input, null, 2));
    const response = await chatBasedProfileUpdatePrompt(input);
    const { output, usage } = response;
    console.log('[DEBUG] chatBasedProfileUpdateFlow output OK');
    return attachProviderUsage(output, usage);
  },
);

// Helper wrapper for Express route to match your current frontend contract
export async function chatBasedProfileUpdate(input) {

  // Retry utility with exponential backoff
  const retryWithBackoff = async (fn, retries = 3, delay = 2000) => {
    try {
      return await fn();
    } catch (error) {
      if (retries > 0 && error.message.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`⚠️ Quota exceeded. Retrying in ${delay}ms... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return retryWithBackoff(fn, retries - 1, delay * 2);
      }
      throw error;
    }
  };

  try {
    const result = await retryWithBackoff(() => chatBasedProfileUpdateFlow(input));

    let updatedFieldsObj;
    if (result.updatedFields) {
      try {
        updatedFieldsObj = JSON.parse(result.updatedFields);
      } catch (e) {
        console.warn('[WARN] Failed to parse updatedFields JSON from AI, ignoring.', e);
      }
    }

    return attachProviderUsage({
      aiResponse: result.aiResponse,
      // This key name matches what sidepanel.js expects (updatedProfile)
      updatedProfile: updatedFieldsObj,
      suggestedFills: result.suggestedFills,
    }, result.usage);

  } catch (error) {
    console.error("❌ Chat Flow Error:", error.message);
    throw error; // Re-throw so the frontend gets the error if retries fail
  }
}
