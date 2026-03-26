// // ─────────────────────────────────────────────
// // File: src/flows/generateFakeProfile.js
// // ─────────────────────────────────────────────

// import { ai as aiFake } from '../ai/genkit.js';
// import { z as zFake } from 'genkit';

// export const GenerateFakeProfileInputSchema = zFake.object({
//   fields: zFake.array(zFake.record(zFake.any())).describe('Extracted form fields from the page.'),
//   page_url: zFake.string().describe('Current page URL.'),
// });

// export const GenerateFakeProfileOutputSchema = zFake.object({
//   userProfile: zFake.record(zFake.any()).describe('Generated realistic Indian applicant profile.'),
//   mappedFields: zFake.array(zFake.record(zFake.any())).describe('Field → value mapping for autofill.'),
// });

// export const generateFakeProfilePrompt = aiFake.definePrompt({
//   name: 'generateFakeProfilePrompt',
//   input: { schema: GenerateFakeProfileInputSchema },
//   output: { schema: GenerateFakeProfileOutputSchema },
//   prompt: `You are a form-understanding AI that generates realistic INDIAN applicant data and autofill mappings.

// Given:
// - Extracted form fields (with label, selector_id, selector_name, input_type, options, etc.)
// - Page URL: {{page_url}}

// Output TWO things in a single JSON object:
// 1) userProfile: a realistic Indian applicant profile suitable for this form.
// 2) mappedFields: array where each item:
//    - matches a form field
//    - includes label, suggested_value, selector_id/selector_name/selector_css, status (ready/empty), input_type, tag_name, options (if any).

// Rules:
// - Use Indian names like Ramesh Sharma, Mahesh Sharma, Sunita Sharma.
// - Use realistic Indian DOB, phone, email, address.
// - Use DD/MM/YYYY format for dates.
// - For dropdowns, suggested_value MUST match one of the available options.
// - status = "ready" when filled, "empty" if left blank on purpose.
// - Do NOT include explanations, only JSON matching the output schema.`,
// });

// export const generateFakeProfileFlow = aiFake.defineFlow(
//   {
//     name: 'generateFakeProfileFlow',
//     inputSchema: GenerateFakeProfileInputSchema,
//     outputSchema: GenerateFakeProfileOutputSchema,
//   },
//   async (input) => {
//     const { output } = await generateFakeProfilePrompt(input);
//     return output;
//   },
// );

// export async function generateFakeProfile(fields, page_url) {
//   return generateFakeProfileFlow({ fields, page_url });
// }


// ********************************* v2 **********************************





// ================================================================
// UPDATED generateFakeProfile.js - Better prompt to use ACTUAL fields
// The issue is the LLM is creating fake options instead of using real ones
// ================================================================

import { ai as aiFake } from '../ai/genkit.js';
import { z as zFake } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const GenerateFakeProfileInputSchema = zFake.object({
  fields: zFake.array(zFake.any()).describe('Extracted form fields from the page.'),
  page_url: zFake.string().describe('Current page URL.'),
});

export const GenerateFakeProfileOutputSchema = zFake.object({
  userProfile: zFake.record(zFake.any()).describe('Generated realistic Indian applicant profile.'),
  mappedFields: zFake.array(zFake.any()).describe('Field → value mapping for autofill.'),
});

export const generateFakeProfilePrompt = aiFake.definePrompt({
  name: 'generateFakeProfilePrompt',
  input: { schema: GenerateFakeProfileInputSchema },
  output: { schema: GenerateFakeProfileOutputSchema },
  prompt: `You are a form-understanding AI that generates realistic INDIAN applicant data.

## CRITICAL RULES:
1. Return EXACTLY the same number of fields as provided in input ({{fields.length}} fields)
2. DO NOT add any extra fields
3. DO NOT modify field labels, selector_id, selector_name, selector_css, input_type, tag_name
4. DO NOT modify the options array - keep it EXACTLY as provided
5. ONLY fill in suggested_value and status

## INPUT FIELDS:
{{#each fields}}
{{@index}}. label: "{{label}}" | type: {{input_type}} | selector: {{selector_id}}{{selector_name}}
{{#if description}}   description: "{{description}}"{{/if}}
{{#if validation.maxLength}}   maxLength: {{validation.maxLength}}{{else}}{{#if maxLength}}   maxLength: {{maxLength}}{{/if}}{{/if}}
{{#if options}}   options: {{#each options}}{{text}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}
{{/each}}

## YOUR TASK:
For each field above, generate a realistic INDIAN value:
- Names: Use Indian names like "Ramesh Kumar Sharma"
- DOB: Use DD/MM/YYYY or DD-MM-YYYY format based on placeholder
- Phone: 10 digit Indian mobile (9876543210)
- Email: realistic email
- Respect any maxLength constraints shown for the field. Make your answers concise if needed.
- Consider any description provided for context on what the field expects.
- For SELECT/RADIO fields: suggested_value MUST be one of the provided options EXACTLY
- For fields with no options provided, leave suggested_value empty

## OUTPUT FORMAT:
{
  "userProfile": {
    "fullName": "Ramesh Kumar Sharma",
    "fatherName": "Suresh Sharma",
    ...
  },
  "mappedFields": [
    {
      "label": "exact label from input",
      "suggested_value": "appropriate value",
      "selector_id": "exact from input",
      "selector_name": "exact from input", 
      "selector_css": "exact from input",
      "status": "ready",
      "input_type": "exact from input",
      "tag_name": "exact from input",
      "options": [exact array from input - DO NOT MODIFY]
    },
    ... (exactly {{fields.length}} items)
  ]
}
`
});

export const generateFakeProfileFlow = aiFake.defineFlow(
  {
    name: 'generateFakeProfileFlow',
    inputSchema: GenerateFakeProfileInputSchema,
    outputSchema: GenerateFakeProfileOutputSchema,
  },
  async (input) => {
    const response = await generateFakeProfilePrompt(input);
    const { output, usage } = response;
    
    // 🔥 CRITICAL: Merge LLM output with original fields to preserve options
    const mergedFields = input.fields.map((originalField, i) => {
      const llmField = output.mappedFields[i] || {};
      return {
        // Keep ALL original field properties
        ...originalField,
        // Only take suggested_value and status from LLM
        suggested_value: llmField.suggested_value || '',
        status: llmField.status || (llmField.suggested_value ? 'ready' : 'empty'),
      };
    });
    
    return attachProviderUsage({
      userProfile: output.userProfile,
      mappedFields: mergedFields,
    }, usage);
  }
);

export async function generateFakeProfile(fields, page_url) {
  console.log(`\n🔧 Generating fake profile for ${fields.length} fields`);
  const result = await generateFakeProfileFlow({ fields, page_url });
  console.log(`✅ Generated profile with ${result.mappedFields.length} mapped fields`);
  return result;
}
