
// ***************************************  last **************************************
// ================================================================
// FIXED: src/flows/intelligentFill.js  
// v2 - Properly preserves options from original baseMapping
// ================================================================

import { ai as aiFill } from '../ai/genkit.js';
import { z as zFill } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

// ================================================================
// SIMPLIFIED INPUT SCHEMA
// ================================================================
export const IntelligentFillInputSchema = zFill.object({
  baseMapping: zFill
    .array(zFill.any())
    .describe('Baseline mapping from labels → fake values.'),
  userDocuments: zFill
    .array(zFill.any())
    .describe('User documents with extractedData.'),
  // 🔥 NEW: include flattened real user profile (permanentAddress, gender, etc.)
  realUserProfile: zFill
    .record(zFill.any())
    .describe('Real user profile object with keys like permanentAddress, correspondenceAddress, gender, domicileState, pincode, country, etc.')
    .optional()
    .default({}),
});

// ================================================================
// SIMPLIFIED OUTPUT SCHEMA
// ================================================================
export const IntelligentFillOutputSchema = zFill.object({
  mappedFields: zFill
    .array(zFill.any())
    .describe('Array of field objects with updated suggested_value'),
});

// ================================================================
// PROMPT - Only asks for label, suggested_value, status
// ================================================================
export const intelligentFillPrompt = aiFill.definePrompt({
  name: 'intelligentFillPrompt',
  input: { schema: IntelligentFillInputSchema },
  output: { schema: IntelligentFillOutputSchema },
  prompt: `You are a form-filling AI. Replace FAKE placeholder values with REAL user data.

## REAL USER DATA (from uploaded documents):
{{#each userDocuments}}
### {{documentType}}:
{{#each extractedData}}
- {{@key}}: "{{this}}"
{{/each}}

{{/each}}

## REAL USER PROFILE (flat object):
{{#each (entries realUserProfile)}}
- {{this.key}}: "{{this.value}}"
{{/each}}

## FORM FIELDS TO UPDATE:
{{#each baseMapping}}
{{@index}}. label: "{{label}}" | fake_value: "{{suggested_value}}"
{{#if description}}   description: "{{description}}"{{/if}}
{{#if maxLength}}   maxLength: {{maxLength}}{{/if}}
{{/each}}

## FIELD MATCHING GUIDE:
| Form Label Contains | Look for in extractedData |
|---------------------|---------------------------|
| "Name", "Full Name" | "name", "studentName" |
| "First Name" | First word of name |
| "Last Name", "Surname" | Last word of name |
| "Father" | "fathersName", "fatherName" |
| "Mother" | "mothersName", "motherName" |
| "DOB", "Date of Birth" | "dateOfBirth", "dob" |
| "Mobile", "Phone" | "phone", "mobile" |
| "Email" | "email" |
| "Aadhaar" | "aadhaarNo", "aadhaarNumber" |
| "Roll Number" | "rollNo" |
| "Year of Passing" | extract year from "examinationMonthYear" |
| "Board" | "board" |
| "Permanent Address", "Correspondence Address", "Address" | "permanentAddress", "correspondenceAddress", "address", "fullAddress" |
| "Gender", "Sex" | "gender" |

For address-type fields, if the form label contains "address", "permanent address" or "correspondence address", use this EXACT format for suggested_value (comma-separated):

  AddressLine1, AddressLine2 (or blank), City, District/Region (or blank), State, Pincode, Country

Example: "hardaspur geriya, , khaga, fatehpur, Uttar Pradesh, 440027, India"

## RULES:
1. Return EXACTLY {{baseMapping.length}} items
2. For each item, return: label, suggested_value, status
3. Replace suggested_value with REAL data if found, otherwise keep original
4. Dates: DD/MM/YYYY format
5. For address fields, ALWAYS follow the comma-separated format described above, even if the source address is a single string; you may combine profile fields (permanentAddress, correspondenceAddress, domicileState, pincode, country, etc.).
6. Respect any maxLength constraints shown for the field. Make your answers concise if needed.
7. Consider any description provided for context on what the field expects.
8. status = "ready" for all

## OUTPUT FORMAT:
{
  "mappedFields": [
    {"label": "Field Name", "suggested_value": "REAL_OR_FAKE_VALUE", "status": "ready"},
    ...
  ]
}
`
});

// ================================================================
// FLOW
// ================================================================
export const intelligentFillFlow = aiFill.defineFlow(
  {
    name: 'intelligentFillFlow',
    inputSchema: IntelligentFillInputSchema,
    outputSchema: IntelligentFillOutputSchema,
  },
  async (input) => {
    const response = await intelligentFillPrompt(input);
    const { output, usage } = response;
    return attachProviderUsage(output, usage);
  }
);

// ================================================================
// MAIN FUNCTION
// ================================================================
export async function intelligentFill({ fields, fakeProfile, baseMapping, realUserProfile = {}, userDocuments }) {

  // Normalize documents - only keep simple fields
  const normalizedDocs = (userDocuments || []).map((d) => ({
    documentType: d.documentType,
    extractedData: d.extractedData || {},
  }));

  console.log("\n=================== 🔍 INTELLIGENT-FILL INPUT ===================");
  console.log("📌 Base Mapping fields:", baseMapping.length);
  console.log("📌 User Documents:", normalizedDocs.length);

  normalizedDocs.forEach((doc, i) => {
    console.log(`\n📄 Document ${i + 1}: ${doc.documentType}`);
    Object.entries(doc.extractedData).forEach(([key, value]) => {
      if (typeof value !== 'object') {
        console.log(`   ${key}: ${value}`);
      }
    });
  });
  console.log("=================================================================\n");

  // Clean extractedData - remove complex nested objects
  const cleanedDocs = normalizedDocs.map(doc => ({
    documentType: doc.documentType,
    extractedData: Object.fromEntries(
      Object.entries(doc.extractedData).filter(([key, value]) =>
        typeof value !== 'object' || value === null
      )
    )
  }));

  // Simplify baseMapping for LLM (only send what's needed)
  const simplifiedMapping = baseMapping.map(field => ({
    label: field.label,
    suggested_value: field.suggested_value || '',
    description: field.description || '',
    maxLength: field.validation?.maxLength || field.maxLength || '',
  }));

  const llmInput = {
    baseMapping: simplifiedMapping,
    userDocuments: cleanedDocs,
    realUserProfile: realUserProfile || {},
  };

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
    // Wrap flow call with retry logic
    const result = await retryWithBackoff(() => intelligentFillFlow(llmInput));

    // 🔥 CRITICAL: Merge LLM result back with ORIGINAL baseMapping
    // This preserves all the original properties (options, selectors, etc.)
    const mergedResult = baseMapping.map((originalField, i) => {
      const llmField = result.mappedFields[i] || {};

      return {
        // Keep ALL original properties
        ...originalField,
        // Only override suggested_value and status from LLM
        suggested_value: llmField.suggested_value !== undefined
          ? llmField.suggested_value
          : originalField.suggested_value,
        status: llmField.status || originalField.status || 'ready',
      };
    });

    // Log comparison
    console.log("\n=================== 🟢 INTELLIGENT-FILL OUTPUT ===================");
    let changedFields = [];
    mergedResult.forEach((field, i) => {
      const original = baseMapping[i];
      if (original && field.suggested_value !== original.suggested_value) {
        changedFields.push({
          label: field.label,
          fake: original.suggested_value,
          real: field.suggested_value
        });
      }
    });

    if (changedFields.length > 0) {
      console.log("✅ Fields replaced with REAL values:");
      changedFields.forEach(f => {
        console.log(`   ${f.label}: "${f.fake}" → "${f.real}"`);
      });
    } else {
      console.log("⚠️ No fields were changed!");
    }
    console.log("===================================================================\n");

    return attachProviderUsage({ mappedFields: mergedResult }, result.usage);

  } catch (error) {
    console.error("❌ LLM Error:", error.message);
    console.log("⚠️ Returning original baseMapping due to error");
    return { mappedFields: baseMapping };
  }
}
