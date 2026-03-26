// ─────────────────────────────────────────────
// File: src/flows/documentDataExtraction.js
// ─────────────────────────────────────────────

import { ai as aiDoc } from '../ai/genkit.js';
import { z as zDoc } from 'genkit';
import { attachProviderUsage } from '../observability/providerUsage.js';

export const DocumentDataExtractionInputSchema = zDoc.object({
  fileDataUri: zDoc
    .string()
    .describe(
      "The document as a data URI. Format: 'data:<mimetype>;base64,<encoded_data>'.",
    ),
});

export const DocumentDataExtractionOutputSchema = zDoc
  .record(zDoc.string(), zDoc.any())
  .describe('The extracted data from the document as key-value pairs.');

export const documentDataExtractionPrompt = aiDoc.definePrompt({
  name: 'documentDataExtractionPrompt',
  input: { schema: DocumentDataExtractionInputSchema },
  output: { schema: DocumentDataExtractionOutputSchema },
  prompt: `You are an expert AI document processor. Extract structured data from the provided document.

Document: {{media url=fileDataUri}}

Return ONLY a single JSON object: key-value pairs of all extracted fields. Do not include explanations or extra text.`,
});

export const documentDataExtractionFlow = aiDoc.defineFlow(
  {
    name: 'documentDataExtractionFlow',
    inputSchema: DocumentDataExtractionInputSchema,
    outputSchema: DocumentDataExtractionOutputSchema,
  },
  async (input) => {
    const response = await documentDataExtractionPrompt(input);
    const { output, usage } = response;
    return attachProviderUsage(output, usage);
  },
);

export async function documentDataExtraction(input) {
  return documentDataExtractionFlow(input);
}
