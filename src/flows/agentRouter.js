// ─────────────────────────────────────────────
// File: src/flows/agentRouter.js
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const AgentRouterInputSchema = z.object({
    questions: z.array(z.string()).describe('List of questions or field labels to find answers for.'),
    availableDocTypes: z.array(z.string()).describe('List of available document types for the user (e.g. "resume", "aadhaar").'),
    profileKeys: z.array(z.string()).optional().describe('List of keys/fields present in the user profile (e.g. "firstName", "dob").'),
    chatHistory: z.array(z.object({
        role: z.string(),
        content: z.string()
    })).optional().describe('Previous messages in conversation to resolve context (e.g. "those 4 fields").'),
});

export const AgentRouterOutputSchema = z.object({
    routing: z.array(z.object({
        key: z.string(),
        doc: z.string().describe('The document type to look in. Use "profile" for general info/docs list, or "current_form" for questions about the active web page.'),
    })),
});

export const agentRouterPrompt = ai.definePrompt({
    name: 'agentRouterPrompt',
    input: { schema: AgentRouterInputSchema },
    output: { schema: AgentRouterOutputSchema },
    prompt: `You are a Document Router Agent.
Your job is to decide WHICH document contains the answer for each question.

Conversation History:
{{#each chatHistory}}
- {{role}}: {{content}}
{{/each}}

Available Document Types:
{{#each availableDocTypes}}
- {{this}}
{{/each}}

Available Profile Data (These fields exist in the User Profile):
{{#each profileKeys}}
- {{this}}
{{/each}}

Questions:
{{#each questions}}
- {{this}}
{{/each}}

Rules:
1. Return a mapping of { key: "Question", doc: "DocType" }.
2. **CONTEXT AWARENESS**: Look at the "Conversation History". If the user refers to "this form", "those fields", "the page", or asks a follow-up about the previous turn's topic (e.g., form analysis), route to "current_form".
   - Example History: User: "How many fields?", AI: "4 fields." -> Current Question: "What are they?" -> Route to "current_form".
3. **FORM FILLING vs FORM METADATA**: 
   - If the questions are **FIELD LABELS** (e.g., "Company Name", "Address", "Phone", "Do you have revenue?") meant for AUTOFILL, route them to the **User Profile** or **Uploaded Documents** (e.g. "startup_pitch_deck", "aadhaar", "resume"). **DO NOT** route these to "current_form".
   - Only route to "current_form" if the question is about the **webpage itself** (e.g., "How many fields?", "What is the URL?", "What is the title?", "List the fields").
4. **PRIORITY CHECK**: If a Question matches (or is very similar to) a key in "Available Profile Data", route to "profile".
   - Example: Question "What is my first name?", Profile Data includes "firstName" -> Route to "profile".
5. **FALLBACK**: If the Question is NOT in Profile Data, choose the BEST document type.
   - "Aadhar", "Aadhaar", "Aadhar Number", "Aadhaar Number", "Aadhar Card", "Aadhaar Card" -> "aadhaar"
   - "Full Name", "DOB", "Date of Birth", "Address" -> usually "aadhaar" or "passport" or "driving_license".
   - "Phone", "Email", "Skills", "Projects" -> usually "resume".
   - "Degree", "Graduation Year", "CGPA" -> usually "degree" or "transcript".
   - "PAN Number", "PAN" -> "pan_card".
6. **FUZZY MATCHING**: Match document types flexibly:
   - "Aadhar" or "Aadhaar" (any spelling) -> "aadhaar"
   - Check availableDocTypes list and match even if spelling differs slightly
7. If a question could be in multiple (e.g. Name), pick the most authoritative one (Identity docs > Resume).
8. If the question is about UPLOADED DOCUMENTS (e.g. "how many documents?", "list my docs", "delete my resume"), route to "profile" (since profile contains system info).
9. If no document fits, or it's general info, use "profile".
10. Do NOT output values. ONLY routing.
11. CRITICAL: NEVER include trailing spaces, newlines (\\n), or tabs in the "key" or "doc" strings. Trim all output purely to the exact field label.,
`,
});

export const agentRouterFlow = ai.defineFlow(
    {
        name: 'agentRouterFlow',
        inputSchema: AgentRouterInputSchema,
        outputSchema: AgentRouterOutputSchema,
    },
    async (input) => {
        console.log(`\n🚦 [Router] Routing ${input.questions.length} questions against ${input.availableDocTypes.length} doc types...`);
        const response = await agentRouterPrompt(input);
        const { output, usage } = response;
        console.log(`🚦 [Router] Output: ${JSON.stringify(output.routing)}`);
        return attachProviderUsage(output, usage);
    }
);
