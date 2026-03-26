// ─────────────────────────────────────────────
// File: src/flows/agentExtractor.js
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const AgentExtractorInputSchema = z.object({
  documentType: z.string(),
  extractedData: z.record(z.any()).describe('The raw extracted data from the document.'),
  questions: z.array(z.string()).describe('List of questions/keys to answer using this document.'),
  fieldSpecs: z.array(z.any()).optional().describe('Detailed field specifications including validation limits and descriptions.'),
  chatContext: z.string().optional().describe('Optional context from the user chat message (e.g. specific answers provided by user).'),
});

export const AgentExtractorOutputSchema = z.record(z.string()).describe('Key-value pairs of answers. THE JSON KEY MUST BE THE EXACT STRINGS from the "Questions to Answer" list, including all spaces and punctuation. DO NOT use camelCase.');

export const agentExtractorPrompt = ai.definePrompt({
  name: 'agentExtractorPrompt',
  input: { schema: AgentExtractorInputSchema },
  output: { schema: AgentExtractorOutputSchema },
  prompt: `You are a Document Extraction Agent.
Your job is to answer specific questions using ONLY the provided document data.

Document Type: {{documentType}}

User Chat Context (High Priority):
{{chatContext}}

Extracted Data:
{{json extractedData}}

Questions to Answer:
{{#each questions}}
- {{this}}
{{/each}}

{{#if fieldSpecs}}
Detailed Field Specifications (Respect these strict limits during generation!):
{{#each fieldSpecs}}
- Question: "{{this.label}}" (or "{{this.selector_name}}")
  {{#if this.description}}Description/Instructions: "{{this.description}}"{{/if}}
  {{#if this.validation}}
  Limits:
    {{#if this.validation.minLength}}Min Length: {{this.validation.minLength}}{{/if}}
    {{#if this.validation.maxLength}}Max Length: {{this.validation.maxLength}}{{/if}}
    {{#if this.validation.required}}Required: {{this.validation.required}}{{/if}}
  {{/if}}
{{/each}}
{{/if}}

Rules:
1. Return a JSON object where keys are the EXACT STRINGS from the "Questions to Answer" list (do NOT change them to camelCase or remove any spaces/punctuation) and values are the answers.
2. **PERSPECTIVE & FORMATTING**:
   - For **Short Factual Fields** (Name, Email, Phone, Address, Dates, IDs, Gender, URLs): Return **ONLY** the value. Do NOT use full sentences like "My name is...".
     - Valid: "John Doe", "1234567890", "Male".
     - Invalid: "My name is John Doe", "I am Male".
   - For **Long Descriptive Fields** (Bio, Personal Statement, Experience, "About Me", "Why apply?"): Answer in the **First Person** ("I", "My").
     - Example: "I have 5 years of experience..." instead of "John has...".
3. If the answer is found in the User Chat Context, use that. It takes priority over Extracted Data.
4. Use ONLY the Extracted Data or Chat Context. Do NOT invent information.
5. If the answer is not in the data, return null or empty string for that key.
6. Format the answer cleanly.
7. If asked for a list (e.g. "what are they?"), provide the COMPLETE list from the data, not just a count.
8. **STRICT CHARACTER/WORD LIMITS** (HIGHEST PRIORITY RULE):
   - If a question has a "Max Length" specified above, your answer **MUST have FEWER characters than that number**. Count carefully.
   - For example, if Max Length is 400, your answer must be 399 characters or fewer.
   - If your first draft is too long, SHORTEN it before returning (summarize, cut details).
   - **NEVER return an answer that exceeds the Max Length.** This is a hard rule, not a suggestion.
   - If a Min Length is specified, your answer must be at least that many characters, so provide enough detail.
`,
});

export const agentExtractorFlow = ai.defineFlow(
  {
    name: 'agentExtractorFlow',
    inputSchema: AgentExtractorInputSchema,
    outputSchema: AgentExtractorOutputSchema,
  },
  async (input) => {
    console.log(`\n⛏️ [Extractor] Extracting ${input.questions.length} answers from ${input.documentType}...`);
    // console.log(`⛏️ [Extractor] Data Preview: ${JSON.stringify(input.extractedData).substring(0, 100)}...`);
    const response = await agentExtractorPrompt(input);
    const { output, usage } = response;
    console.log(`⛏️ [Extractor] Output: ${JSON.stringify(output)}`);
    return attachProviderUsage(output, usage);
  }
);
