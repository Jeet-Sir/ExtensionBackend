// ─────────────────────────────────────────────
// Smart Debug Agent – analyzes structured trace JSON and prints a summary.
// Only run when DEBUG_MODE === "true". Uses existing Genkit AI (Gemini).
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';

const smartDebugPrompt = ai.definePrompt({
  name: 'smartDebugPrompt',
  input: { schema: z.object({ traceJson: z.string() }) },
  output: {
    schema: z.object({
      rootCause: z.string().describe('One-line root cause if any failure, else "None"'),
      failureStage: z.string().describe('Agent or stage where failure occurred, or "None"'),
      why: z.string().describe('Brief explanation of what went wrong or "OK"'),
      suggestedFix: z.string().describe('Concrete suggested fix or "N/A"'),
    }),
  },
  prompt: `You are a senior debug analyst for an agentic chat pipeline (intent -> router -> extractor -> resolver).

You receive a JSON trace object with (at least) these fields:
- traceId: string
- message: string (the user question, e.g. "What is my religion?", "What is my CGPA in every semester?")
- finalAnswer: string | null (the AI's reply returned to the user)
- durationMs: number (total request duration)
- profileKeys: string[] (keys present in the user profile)
- numProfileKeys: number
- documentTypes: string[] (uploaded document types, e.g. ["aadhaar", "degree_certificate"])
- numDocuments: number
- steps: Array<{ agentName, durationMs, inputSizeBytes, outputSizeBytes, tokensUsed, success, error }>
- errors: Array<{ agentName, message, stack }>

YOUR JOB: Explain, in structured form, why the pipeline did or did not produce a good answer.

IMPORTANT – HANDLE THREE THINGS:

A) HARD FAILURE (exceptions)
- If errors[] is non-empty OR any step has success=false:
  - Root cause: short description using the error message (e.g. "GenAI API UNAVAILABLE", "Mongo connection failed").
  - Failure stage: the step.agentName where success=false or the first error.agentName you see.
  - Why: 1–2 sentence explanation.
  - Suggested fix: concrete action (e.g. "Retry with backoff", "Check API key", "Fix Mongo credentials").

B) SOFT FAILURE (unhelpful answer, like CGPA / religion cases)
- No exception, but the user clearly asked for specific personal or document-based info (e.g. CGPA, marks, religion, phone) AND finalAnswer is not actually giving that value.
- Treat finalAnswer as UNHELPFUL if:
  - It contains phrases like "I couldn't find", "Not found", "I don't see", "I'm not sure where", "I didn't find", "couldn't find a specific answer", "I don't have enough information", OR
  - It is very generic and does not mention the specific thing asked for in message (e.g. user asked for "CGPA", answer never mentions "CGPA" or a number).
- In that case:
  1) Infer the main field or concept from message (examples):
     - "What is my religion?" -> field = "religion"
     - "What is my marital status?" -> field = "maritalStatus"
     - "What is my CGPA in every semester?" -> concept = "CGPA per semester" (grade/marks across semesters)
  2) Check profileKeys:
     - If the field (or a close variant) is NOT present in profileKeys, and the question is about personal info (religion, marital, phone, DOB, etc.):
       * rootCause = "Missing profile field: <field>"
       * failureStage = "profile lookup / agentExtractorFlow (QUESTION path)"
       * why = "User asked for <field> but profileKeys does not contain it; extractor had no data to return."
       * suggestedFix = "Store <field> in the user profile (profile API / DB) so the agent can answer it."
  3) Check documentTypes:
     - If the question is clearly about academic performance (CGPA, semester marks, grade cards, marksheets) and NONE of the documentTypes look like academic docs (e.g. no type containing "marksheet", "transcript", "degree", "semester"):
       * rootCause = "Missing academic document for CGPA/marks question"
       * failureStage = "document routing / agentRouterFlow"
       * why = "User asked for CGPA/marks per semester but documentTypes does not include any academic marksheet/transcript documents."
       * suggestedFix = "Upload a semester-wise marksheet/transcript document and map it into the vault so the extractor can read CGPA."
     - If documentTypes has some academic-looking docs but the finalAnswer is still unhelpful, assume the extractor failed to map the data:
       * rootCause = "Extractor could not find requested field in academic documents"
       * failureStage = "agentExtractorFlow (QUESTION path)"
       * why = "Relevant academic documents exist but the requested field (e.g. CGPA per semester) is not clearly present in extractedData."
       * suggestedFix = "Improve document extraction/mapping for CGPA/marks fields in those document types."

C) LARGE PAYLOAD / PERFORMANCE
- Inspect steps[*].inputSizeBytes and outputSizeBytes:
  - If any inputSizeBytes > 50_000 or outputSizeBytes > 50_000, mention large payload as part of root cause or why (e.g. "Very large context passed to agenticChat; may hit token limits").

OUTPUT FORMAT (STRICT):
- Always fill all four fields:
  - rootCause: If everything is actually fine and answer is good, use "None".
  - failureStage: e.g. "agenticChat", "agentRouterFlow", "agentExtractorFlow (QUESTION path)", "profile lookup", or "None".
  - why: 1–3 short sentences, very concrete.
  - suggestedFix: concrete next step; if no issue, use "N/A".

Now analyze this trace JSON and respond with exactly: rootCause, failureStage, why, suggestedFix.

Trace JSON:
{{traceJson}}`,
});

/**
 * Build a quick heuristic summary from trace (no AI). Always runs so user always sees something.
 */
function buildHeuristicSummary(trace) {
  const msg = (trace.message || '').toLowerCase();
  const answer = (trace.finalAnswer || '').toLowerCase();
  const unhelpful =
    answer.includes("couldn't find") ||
    answer.includes('not found') ||
    answer.includes("don't see") ||
    answer.includes("i'm not sure") ||
    answer.includes('couldn\'t find a specific answer') ||
    !answer.trim();

  let rootCause = 'None';
  let failureStage = 'None';
  let why = 'OK';
  let suggestedFix = 'N/A';

  if (trace.errors && trace.errors.length > 0) {
    rootCause = trace.errors[0].message || 'Exception in pipeline';
    failureStage = trace.errors[0].agentName || 'agenticChat';
    why = 'Pipeline threw an error. See errors[] in trace.';
    suggestedFix = 'Check logs and fix the failing step (e.g. API key, DB, Genkit).';
    return { rootCause, failureStage, why, suggestedFix };
  }

  if (unhelpful && msg) {
    const profileKeys = trace.profileKeys || [];
    const docTypes = (trace.documentTypes || []).map((t) => (t || '').toLowerCase());

    if (/\b(account number|bank account|account no|ac number)\b/.test(msg)) {
      const hasBankDoc = docTypes.some((t) => /bank|passbook|account/.test(t));
      const hasAccountInProfile = profileKeys.some((k) => /account|bank/.test((k || '').toLowerCase()));
      if (!hasAccountInProfile && !hasBankDoc) {
        rootCause = 'Missing bank/passbook document or profile field for account number';
        failureStage = 'document routing / agentRouterFlow';
        why = 'User asked for bank account number but no bank-type document in documentTypes and no account field in profile. Router may have sent question to profile only.';
        suggestedFix = 'Upload a bank passbook (or add custom doc type with account number) and ensure router routes "account number" to that document.';
      } else if (hasBankDoc && !hasAccountInProfile) {
        rootCause = 'Extractor could not find account number in bank document';
        failureStage = 'agentExtractorFlow (QUESTION path)';
        why = 'Bank/passbook document exists but extractor returned empty for account number. Router may have routed to profile instead of the bank doc.';
        suggestedFix = 'Fix router to route "bank account number" to the bank/passbook document type; ensure extractedData has account number field.';
      } else {
        rootCause = 'Answer empty or unhelpful for account number question';
        failureStage = 'agentExtractorFlow or agentRouterFlow';
        why = 'Profile or documents may not expose account number clearly.';
        suggestedFix = 'Add account number to profile or ensure bank doc extractedData includes it and router routes to that doc.';
      }
    } else if (/\b(religion|marital|cgpa|marks|semester)\b/.test(msg)) {
      const field = msg.includes('religion') ? 'religion' : msg.includes('marital') ? 'maritalStatus' : 'CGPA/marks';
      if (!profileKeys.some((k) => (k || '').toLowerCase().includes(field.replace(/status/i, '')) && field !== 'CGPA/marks')) {
        if (field === 'CGPA/marks') {
          rootCause = 'Missing academic document or extractor mapping for CGPA/marks';
          failureStage = 'agentRouterFlow or agentExtractorFlow';
          why = 'User asked for CGPA/marks but no academic doc or extractor did not find the field.';
          suggestedFix = 'Upload marksheet/transcript and ensure router + extractor map CGPA/semester fields.';
        } else {
          rootCause = `Missing profile field: ${field}`;
          failureStage = 'profile lookup / agentExtractorFlow (QUESTION path)';
          why = `User asked for ${field} but it is not in profileKeys.`;
          suggestedFix = `Add ${field} to user profile (profile API / DB).`;
        }
      }
    } else if (unhelpful) {
      rootCause = 'Answer was generic or empty for the question';
      failureStage = 'agentExtractorFlow (QUESTION path) or agentRouterFlow';
      why = `finalAnswer is unhelpful ("${(trace.finalAnswer || '').slice(0, 60)}..."). Check documentTypes and profileKeys for the asked field.`;
      suggestedFix = 'Ensure the asked field exists in profile or in one of the uploaded documents and router routes to it.';
    }
  }

  return { rootCause, failureStage, why, suggestedFix };
}

/**
 * Runs the smart debug agent on a trace and prints a formatted summary to the terminal.
 * 1) Always prints a heuristic summary first (sync, so it always appears).
 * 2) Then tries AI summary; on failure, heuristic is already shown.
 *
 * @param {object} trace - Full trace object (traceId, message, steps, errors, finalAnswer, startTime)
 * @returns {Promise<string>} - Text summary (also printed to console)
 */
export async function smartConsoleAgent(trace) {
  const lines = [
    '',
    '========= SMART DEBUG SUMMARY =========',
  ];

  const heuristic = buildHeuristicSummary(trace);
  lines.push(`Root Cause: ${heuristic.rootCause}`);
  lines.push(`Failure Stage: ${heuristic.failureStage}`);
  lines.push(`Why: ${heuristic.why}`);
  lines.push(`Suggested Fix: ${heuristic.suggestedFix}`);
  lines.push('======================================');
  lines.push('');
  console.log(lines.join('\n'));

  let summary = lines.join('\n');

  try {
    const traceJson = JSON.stringify(trace, null, 0);
    const { output } = await smartDebugPrompt({ traceJson });
    const aiLines = [
      '',
      '--- (AI) SMART DEBUG SUMMARY ---',
      `Root Cause: ${output.rootCause ?? 'N/A'}`,
      `Failure Stage: ${output.failureStage ?? 'N/A'}`,
      `Why: ${output.why ?? 'N/A'}`,
      `Suggested Fix: ${output.suggestedFix ?? 'N/A'}`,
      '======================================',
      '',
    ];
    console.log(aiLines.join('\n'));
    summary += '\n' + aiLines.join('\n');
  } catch (err) {
    console.error('\n[Smart Debug] AI summary failed:', err?.message ?? err, '\n');
    summary += `\n[Smart Debug] AI summary failed: ${err?.message ?? err}`;
  }

  return summary;
}
