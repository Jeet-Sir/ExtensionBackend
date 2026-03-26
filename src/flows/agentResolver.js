// ─────────────────────────────────────────────
// File: src/flows/agentResolver.js
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const AgentResolverInputSchema = z.object({
    fieldLabel: z.string(),
    extractedValue: z.string().describe('The value we found from documents/profile.'),
    options: z.array(z.string()).describe('List of available options in the form (dropdown/radio).'),
});

export const AgentResolverOutputSchema = z.object({
    selectedOption: z.string().describe('The option that best matches the extracted value.'),
});

export const agentResolverPrompt = ai.definePrompt({
    name: 'agentResolverPrompt',
    input: { schema: AgentResolverInputSchema },
    output: { schema: AgentResolverOutputSchema },
    prompt: `You are an Option Resolver Agent.
Your job is to pick the best matching option from a list, given a value.

Field: {{fieldLabel}}
Value we have: "{{extractedValue}}"

Available Options:
{{#each options}}
- {{this}}
{{/each}}

Rules:
1. Return the EXACT string from "Available Options" that matches "Value we have".
2. Handle synonyms (e.g. "Male" -> "Man", "BLR" -> "Bangalore").
3. If no match is found, return the closest one or the original value if allowed (but prefer options).
`,
});

export const agentResolverFlow = ai.defineFlow(
    {
        name: 'agentResolverFlow',
        inputSchema: AgentResolverInputSchema,
        outputSchema: AgentResolverOutputSchema,
    },
    async (input) => {
        console.log(`\n🧩 [Resolver] Resolving "${input.fieldLabel}" (Value: "${input.extractedValue}") against ${input.options.length} options...`);
        const response = await agentResolverPrompt(input);
        const { output, usage } = response;
        console.log(`🧩 [Resolver] Selected: "${output.selectedOption}"`);
        return attachProviderUsage(output, usage);
    }
);
