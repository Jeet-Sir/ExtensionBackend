// ─────────────────────────────────────────────
// File: src/flows/processDocument.js
// ─────────────────────────────────────────────

import { ai as aiProc } from '../ai/genkit.js';
import { z as zProc } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const ProcessDocumentInputSchema = zProc.object({
  fileDataUri: zProc
    .string()
    .describe(
      "The document as a data URI. Format: 'data:<mimetype>;base64,<encoded_data>'.",
    ),
});

export const ProcessDocumentOutputSchema = zProc.object({
  extractedData: zProc
    .string()
    .describe('A JSON string of the extracted data from the document.'),
  documentType: zProc
    .string()
    .describe('Specific type of the document (e.g., "Aadhaar Card", "Resume").'),
  profileSection: zProc
    .string()
    .describe('Profile section (e.g., identity, career, education, financial, other).'),
  confidence: zProc.number().describe('Confidence score (0-1).'),
});

export const processDocumentPrompt = aiProc.definePrompt({
  name: 'processDocumentPrompt',
  input: { schema: ProcessDocumentInputSchema },
  output: { schema: ProcessDocumentOutputSchema },
  prompt: `You are an expert AI document processor.

Analyze the following document and:
1. Extract all relevant information and encode it as a JSON string for the 'extractedData' field.
2. Identify the specific document type (e.g., "Aadhaar Card", "Resume", "PAN Card", "Startup Pitch Deck", "Marksheet").
3. Decide the best profileSection: one of [identity, career, education, financial, other].
4. Return a confidence score between 0 and 1.

Document: {{media url=fileDataUri}}

Return a single JSON object matching the required schema.`,
});

export const processDocumentFlow = aiProc.defineFlow(
  {
    name: 'processDocumentFlow',
    inputSchema: ProcessDocumentInputSchema,
    outputSchema: ProcessDocumentOutputSchema,
  },
  async (input) => {
    console.log('[DEBUG] processDocumentFlow: Starting, URI length =', input.fileDataUri.length);
    const response = await processDocumentPrompt(input);
    const { output, usage } = response;
    console.log('[DEBUG] processDocumentFlow: Completed');
    return attachProviderUsage(output, usage);
  },
);

export async function processDocument(input) {
  const result = await processDocumentFlow(input);
  let extractedDataObj = {};
  try {
    extractedDataObj = JSON.parse(result.extractedData);
  } catch (e) {
    console.warn('[WARN] Failed to parse extractedData JSON. Returning empty object.', e);
  }

  return attachProviderUsage({
    extractedData: extractedDataObj,
    documentType: result.documentType,
    profileSection: result.profileSection,
    confidence: result.confidence,
  }, result.usage);
}
