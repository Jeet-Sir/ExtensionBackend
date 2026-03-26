// ─────────────────────────────────────────────
// File: src/flows/agenticChat.js
// ─────────────────────────────────────────────

import { ai } from '../ai/genkit.js';
import { z } from 'genkit';
import { agentRouterFlow } from './agentRouter.js';
import { agentExtractorFlow } from './agentExtractor.js';
import { agentResolverFlow } from './agentResolver.js';
import { runAgent } from '../observability/runAgent.js';
import fs from 'fs';

function logToFile(msg) {
    fs.appendFileSync('debug.log', msg + '\n');
}

const ROUTER_LABEL_LIMIT = 40;
const ROUTER_LABEL_HEAD = 24;
const ROUTER_LABEL_TAIL = 13;

function normalizeLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactRouterLabel(label) {
    const normalized = normalizeLabel(label);
    if (normalized.length <= ROUTER_LABEL_LIMIT) {
        return normalized;
    }

    return `${normalized.slice(0, ROUTER_LABEL_HEAD).trimEnd()}...${normalized.slice(-ROUTER_LABEL_TAIL).trimStart()}`;
}

function normalizeRouterLookupKey(value) {
    return normalizeLabel(value).toLowerCase();
}

function buildRouterQuestionEntries(targetFields, explicitKeys) {
    return targetFields
        .map((field, index) => {
            const fullKey = field.label || field.selector_name || `Field ${index + 1}`;
            const routerKey = `f${index + 1}:${compactRouterLabel(fullKey)}`;

            return { fullKey, routerKey };
        })
        .filter(({ fullKey }) => !explicitKeys.has(fullKey));
}

// Input Schema
export const AgenticChatInputSchema = z.object({
    message: z.string(),
    chatHistory: z.array(z.object({
        role: z.string(),
        content: z.string()
    })).optional(),
    userId: z.string(),
    pageUrl: z.string().optional(),
    pageTitle: z.string().optional(),
    fieldsMinimal: z.array(z.object({
        label: z.string(),
        input_type: z.string().nullable().optional(),
        options: z.array(z.string()).optional(),
        selector_css: z.string().nullable().optional(),
        selector_id: z.string().nullable().optional(),
        selector_name: z.string().nullable().optional(),
        validation: z.any().optional(),
    })).optional(),
    cachedFields: z.array(z.any()).optional(),
    userDocuments: z.array(z.any()).describe('Fetched from DB'),
    userDocuments: z.array(z.any()).describe('Fetched from DB'),
    userProfile: z.record(z.any()).describe('Fetched from DB'),
    deleteDocument: z.function().optional().describe('Function to delete a document by name or ID'),
    trace: z.any().optional(),
});

// Output Schema
export const AgenticChatOutputSchema = z.object({
    aiResponse: z.string(),
    suggestedFills: z.array(z.any()).optional(),
});


// Helper to check intent
const intentPrompt = ai.definePrompt({
    name: 'intentPrompt',
    input: { schema: z.object({ message: z.string() }) },
    output: { schema: z.object({ type: z.enum(['GREETING', 'QUESTION', 'AUTOFILL', 'ACTION']) }) },
    prompt: `Classify the user message.
Message: "{{message}}"

Types:
- GREETING: Hello, hi, how are you, etc.
- QUESTION: Asking for specific info (e.g. "What is my phone number?", "What is my graduation year?").
- QUESTION: Asking for specific info (e.g. "What is my phone number?", "how many docs do I have?", "how many fields in this form?").
- AUTOFILL: Asking to fill the form, fill fields, ask to fill particular fields  or "do it".
- ACTION: Asking to perform an action like DELETING a document (e.g., "delete my aadhaar", "remove the resume").

Return JSON.`,
});

// Helper to select specific fields based on user request
const fieldSelectorPrompt = ai.definePrompt({
    name: 'fieldSelectorPrompt',
    input: {
        schema: z.object({
            message: z.string(),
            availableFields: z.array(z.string())
        })
    },
    output: {
        schema: z.object({
            reasoning: z.string().describe("Explain why you think the user wants specific fields or all fields."),
            targetFields: z.array(z.string()).describe("List of exact field names to fill. Empty if filling all."),
            isTargeted: z.boolean().describe("True if user wants specific fields, False if user wants to fill the whole form."),
            explicitValues: z.array(z.object({
                field: z.string(),
                value: z.string().describe("The explicit value the user wants to fill.")
            })).optional().describe("List of fields where the user provided a specific value (e.g. 'fill name with John').")
        })
    },
    prompt: `You are a smart router for form filling. Your goal is to understand the user's intent regarding WHICH fields to fill.

User Message: "{{message}}"

Available Fields (from the form):
{{#each availableFields}}
- {{this}}
{{/each}}

Instructions:
1. Analyze the User Message to determine if they want to:
   - Fill ALL fields (e.g., "fill form", "fill all", "do it", "autofill").
   - Fill SPECIFIC fields (e.g., "fill name", "fill email", "fill this field: [text]").

2. If the user wants to fill ALL fields:
   - Set "isTargeted" to FALSE.
   - Set "targetFields" to [].
   - Set "explicitValues" to [].

3. If the user wants to fill SPECIFIC fields:
   - Set "isTargeted" to TRUE.
   - Match the user's request to the "Available Fields" list.
   - If the user pastes a long question/label (e.g., "Who writes code..."), find the field that best matches that text.
   - Set "targetFields" to the list of matched exact field names.

4. Check for EXPLICIT VALUES:
   - If the user says "fill [Field] with [Value]", "set [Field] to [Value]", or "answer [Field] is [Value]":
   - Extract the value.
   - Add it to "explicitValues" list: { field: "[Field Name]", value: "[Value]" }.

5. Provide "reasoning" for your decision.

Examples:
- Msg: "fill the form" -> isTargeted: false
- Msg: "fill only name" -> isTargeted: true, targetFields: ["Full Name"]
- Msg: "fill this: Who is the CEO?" -> isTargeted: true, targetFields: ["Who is the CEO?"]
- Msg: "fill email and phone" -> isTargeted: true, targetFields: ["Email", "Phone Number"]
- Msg: "fill Branch with IOT" -> isTargeted: true, targetFields: ["Branch"], explicitValues: [{ field: "Branch", value: "IOT" }]

Return JSON.`,
});

export const agenticChatFlow = ai.defineFlow(
    {
        name: 'agenticChatFlow',
        inputSchema: AgenticChatInputSchema,
        outputSchema: AgenticChatOutputSchema,
    },
    async (input) => {
        const { message, chatHistory, userDocuments, userProfile, fieldsMinimal, cachedFields } = input;
        const flowStart = Date.now();
        let geminiCallCount = 0;
        const observe = async (agentName, agentInput, agentFunction, metadata = {}) => {
            if (!input.trace) {
                return agentFunction(agentInput);
            }
            return runAgent({
                trace: input.trace,
                agentName,
                input: agentInput,
                agentFunction,
                metadata
            });
        };

        // Use cached fields if available (more context), otherwise fallback to minimal
        const fieldsToUse = (cachedFields && cachedFields.length > 0) ? cachedFields : (fieldsMinimal || []);

        console.log(`\n   ┌${'─'.repeat(65)}┐`);
        console.log(`   │  🧠 AGENTIC CHAT FLOW                                          │`);
        console.log(`   ├${'─'.repeat(65)}┤`);
        console.log(`   │  💬 Message: "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`);
        console.log(`   │  👤 User ID: ${input.userId}`);
        console.log(`   │  📄 Documents loaded: ${userDocuments.length}`);
        console.log(`   │  👤 Profile keys: ${Object.keys(userProfile).length}`);
        console.log(`   │  📋 Form fields: ${fieldsToUse.length} (Source: ${cachedFields && cachedFields.length > 0 ? 'DB Cache' : 'Frontend'})`);
        console.log(`   │  📚 Doc types: [${userDocuments.map(d => d.documentType).join(', ')}]`);
        console.log(`   ├${'─'.repeat(65)}┤`);
        logToFile(`\n🔍 [AgenticChat] Processing Message: "${message}"`);
        logToFile(`📋 [Context] Fields Available: ${fieldsToUse.length}`);

        // 1. Determine Intent
        console.log(`   │  STEP 1: INTENT CLASSIFICATION  (Gemini API call #${++geminiCallCount})`);
        console.log(`   │  ├─ Input: "${message}"`);
        const intentStart = Date.now();
        const intentResult = await observe(
            'intent_classifier',
            { message },
            (payload) => intentPrompt(payload),
            { intentType: 'chat' }
        );
        const intent = intentResult.output.type;
        console.log(`   │  ├─ Result: ${intent}`);
        console.log(`   │  └─ ⏱️ ${Date.now() - intentStart}ms`);

        if (intent === 'GREETING') {
            console.log(`   │`);
            console.log(`   │  ✅ RESULT: Greeting response (no further processing)`);
            console.log(`   │  ⏱️ Total: ${Date.now() - flowStart}ms | Gemini calls: ${geminiCallCount}`);
            console.log(`   └${'─'.repeat(65)}┘\n`);
            return { aiResponse: "Hello! How can I help you with your documents or form filling today?" };
        }

        // ---------------------------------------------------------
        // HANDLE ACTION (Delete doc, etc.)
        // ---------------------------------------------------------
        if (intent === 'ACTION') {
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 2: ACTION HANDLER`);
            console.log(`   │  ├─ User wants to perform an action: "${message}"`);

            // We need to identify WHICH document to delete.
            // Let's use a small extractor for this.
            const actionPrompt = ai.definePrompt({
                name: 'actionPrompt',
                input: { schema: z.object({ message: z.string(), documents: z.array(z.string()) }) },
                output: { schema: z.object({ action: z.enum(['DELETE', 'UNKNOWN']), target: z.string().nullable() }) },
                prompt: `User wants to perform an action. Identify the action and the target document.
                
                User Message: "{{message}}"
                Available Documents: {{documents}}
                
                If the user wants to delete a document, return action="DELETE" and target="<Actual Document Type from list>".
                Matches should be fuzzy but accurate (e.g. "aadhaar card" -> "aadhaar").
                If specific document is not found, set target to null.
                
                Return JSON.`
            });

            const actionResult = await observe(
                'action_router',
                {
                    message,
                    documents: userDocuments.map(d => d.documentType)
                },
                (payload) => actionPrompt(payload),
                { actionType: 'document_delete' }
            );

            if (actionResult.output.action === 'DELETE' && actionResult.output.target) {
                const docTypeToDelete = actionResult.output.target;
                const docToDelete = userDocuments.find(d => d.documentType === docTypeToDelete);

                if (docToDelete && input.deleteDocument) {
                    try {
                        console.log(`🗑️ Deleting document: ${docTypeToDelete} (ID: ${docToDelete._id})`);
                        await input.deleteDocument(docToDelete._id);
                        return { aiResponse: `I have successfully deleted your ${docTypeToDelete}.` };
                    } catch (err) {
                        console.error("❌ Deletion failed:", err);
                        return { aiResponse: "I tried to delete that document, but something went wrong on the server." };
                    }
                } else if (!docToDelete) {
                    return { aiResponse: `I couldn't find a document named "${docTypeToDelete}" to delete.` };
                }
            }

            return { aiResponse: "I'm not sure how to do that yet. I can only delete documents for now." };
        }

        // Prepare available doc types (include normalized variants for fuzzy matching)
        const availableDocTypes = [];
        const normalizeDocType = (type) => type?.toLowerCase().replace(/[^a-z0-9]/g, '');

        userDocuments.forEach(d => {
            if (d.documentType) {
                availableDocTypes.push(d.documentType);
                // Add normalized variant for fuzzy matching
                const normalized = normalizeDocType(d.documentType);
                if (normalized && normalized !== d.documentType.toLowerCase()) {
                    availableDocTypes.push(normalized);
                }
            }
        });

        // Add common aliases
        if (availableDocTypes.some(t => normalizeDocType(t).includes('aadhaar') || normalizeDocType(t).includes('aadhar'))) {
            availableDocTypes.push('aadhaar', 'aadhar');
        }

        if (Object.keys(userProfile).length > 0) availableDocTypes.push('profile');

        // ---------------------------------------------------------
        // HANDLE AUTOFILL (Fill many fields)
        // ---------------------------------------------------------
        if (intent === 'AUTOFILL') {
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 2: FIELD SELECTOR  (Gemini API call #${++geminiCallCount})`);
            console.log(`   │  ├─ Form has ${fieldsToUse.length} fields`);

            if (!fieldsToUse || fieldsToUse.length === 0) {
                console.warn("⚠️ [Autofill] No fields provided in request.");
                return { aiResponse: "I don't see any fields to fill on this page." };
            }

            // 1. Check for Targeted Autofill
            const availableLabels = fieldsToUse.map(f => f.label || f.selector_name || "Unknown");
            const selectorStart = Date.now();
            const selectorResult = await observe(
                'field_selector',
                {
                    message,
                    availableFields: availableLabels
                },
                (payload) => fieldSelectorPrompt(payload),
                { availableFields: availableLabels.length }
            );

            console.log(`   │  ├─ Is Targeted: ${selectorResult.output.isTargeted}`);
            if (selectorResult.output.isTargeted) {
                console.log(`   │  ├─ Target Fields: ${JSON.stringify(selectorResult.output.targetFields)}`);
            }
            console.log(`   │  └─ ⏱️ ${Date.now() - selectorStart}ms`);
            logToFile(`🔍[Selector] Is Targeted: ${selectorResult.output.isTargeted} `);
            logToFile(`🔍[Selector] Target Fields: ${JSON.stringify(selectorResult.output.targetFields)} `);

            let targetFields = fieldsToUse;
            if (selectorResult.output.isTargeted) {
                console.log(`   │`);
                console.log(`   │  ├─ 🎯 Filtering to specific fields: ${JSON.stringify(selectorResult.output.targetFields)}`);
                targetFields = fieldsToUse.filter(f => {
                    const label = (f.label || f.selector_name || "").toLowerCase();
                    const targets = selectorResult.output.targetFields.map(t => t.toLowerCase());
                    return targets.some(target => label.includes(target) || target.includes(label));
                });

                if (targetFields.length === 0) {
                    return { aiResponse: "I couldn't find those specific fields on this form." };
                }
            } else {
                console.log(`   │  ├─ 📝 Filling ALL ${targetFields.length} fields`);
            }

            const explicitValues = selectorResult.output.explicitValues || [];
            const answers = {};
            const explicitKeys = new Set();

            // Pre-fill answers with explicit values
            if (explicitValues.length > 0) {
                console.log(`⚡[Autofill] Found explicit values: `, JSON.stringify(explicitValues));
                explicitValues.forEach(ev => {
                    // Try to find the exact matching field from targetFields
                    const matchingField = targetFields.find(f => {
                        const label = (f.label || f.selector_name || "").toLowerCase();
                        return label.includes(ev.field.toLowerCase()) || ev.field.toLowerCase().includes(label);
                    });

                    const key = matchingField ? (matchingField.label || matchingField.selector_name) : ev.field;
                    answers[key] = ev.value;
                    explicitKeys.add(key);
                });
            }

            // Build compact router keys so long application questions do not bloat the router prompt.
            let routerQuestionEntries = buildRouterQuestionEntries(targetFields, explicitKeys);
            let questions = routerQuestionEntries.map(({ fullKey }) => fullKey);

            // FILTER SENSITIVE FIELDS
            // Note: 'pin' alone is intentionally NOT here — it matches 'Pin code' (postal code).
            // Only block truly sensitive pin variants (ATM/bank/UPI pin).
            const SENSITIVE_KEYWORDS = ['password', 'otp', 'captcha', 'verification code', 'security code', 'cvv', 'atm pin', 'bank pin', 'mpin', 'upi pin', 'transaction pin'];
            const sensitiveFields = [];
            routerQuestionEntries = routerQuestionEntries.filter(({ fullKey }) => {
                const lowerQ = fullKey.toLowerCase();
                const isSensitive = SENSITIVE_KEYWORDS.some(keyword => lowerQ.includes(keyword));
                if (isSensitive) {
                    sensitiveFields.push(fullKey);
                    return false;
                }
                return true;
            });
            questions = routerQuestionEntries.map(({ fullKey }) => fullKey);
            const routerQuestions = routerQuestionEntries.map(({ routerKey }) => routerKey);
            const routerKeyToFullKey = new Map(
                routerQuestionEntries.map(({ routerKey, fullKey }) => [normalizeRouterLookupKey(routerKey), fullKey])
            );

            if (sensitiveFields.length > 0) {
                console.log(`🛡️ [Safety] Skipped sensitive fields: ${JSON.stringify(sensitiveFields)}`);
            }

            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 3: AGENT ROUTER  (Gemini API call #${++geminiCallCount})`);
            console.log(`   │  ├─ Routing ${questions.length} fields against ${availableDocTypes.length} doc types`);

            // Log constraints for debugging (Requested by user)
            targetFields.forEach((f, idx) => {
                if (f.description || f.validation) {
                    let logStr = `   │  │  [${idx + 1}] Field: "${f.label || f.selector_name}"`;
                    if (f.description) logStr += ` | Desc: "${f.description.slice(0, 40)}..."`;
                    if (f.validation?.minLength) logStr += ` | Min: ${f.validation.minLength}`;
                    if (f.validation?.maxLength) logStr += ` | Max: ${f.validation.maxLength}`;
                    console.log(logStr);
                }
            });

            // Filter profile keys: only advertise keys that actually have data
            const validProfileKeys = Object.keys(userProfile).filter(key => {
                const val = userProfile[key];
                return val && typeof val === 'string' && val.trim().length > 0;
            });

            const routerStart = Date.now();
            const routingResult = await observe(
                'doc_router',
                {
                    questions: routerQuestions,
                    availableDocTypes,
                    profileKeys: validProfileKeys,
                    chatHistory: chatHistory || []
                },
                (payload) => agentRouterFlow(payload),
                { questionCount: questions.length, mode: 'autofill' }
            );
            const routing = routingResult.routing.map((route) => {
                const normalizedKey = normalizeRouterLookupKey(route.key);
                const fullKey = routerKeyToFullKey.get(normalizedKey);

                return {
                    ...route,
                    key: fullKey || route.key
                };
            });
            console.log(`   │  ├─ Routing result:`);
            routing.forEach(r => console.log(`   │  │   "${r.key.slice(0, 40)}" → 📄 ${r.doc}`));
            console.log(`   │  └─ ⏱️ ${Date.now() - routerStart}ms`);

            // Group by Doc
            const docGroups = {};
            routing.forEach(r => {
                if (!docGroups[r.doc]) docGroups[r.doc] = [];
                docGroups[r.doc].push(r.key);
            });

            // B. EXTRACTOR (Parallel per doc group)
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 4: AGENT EXTRACTOR  (Gemini API calls — one per doc group)`);
            console.log(`   │  ├─ Doc groups: ${Object.keys(docGroups).join(', ')}`);
            const extractorStart = Date.now();

            // Helper: embed description into the question string so the LLM uses it as instructions
            const buildEnrichedQuestions = (keys) => {
                return keys.map(k => {
                    const field = targetFields.find(f => (f.label || f.selector_name) === k);
                    const desc = field?.description?.trim();
                    // Only append if description is meaningful (not just a counter like "0 / 400")
                    if (desc && desc.length > 10 && !/^\d+\s*\/\s*\d+$/.test(desc)) {
                        return `${k} [Instructions: ${desc}]`;
                    }
                    return k;
                });
            };

            const promises = Object.entries(docGroups).map(async ([docType, keys]) => {
                const normalizeExtractedData = (raw) => {
                    if (!raw) return {};
                    if (Array.isArray(raw)) {
                        return { items: raw };
                    }
                    if (typeof raw === 'object') {
                        return raw;
                    }
                    return { value: raw };
                };
                if (docType === 'current_form') {
                    const fieldSpecs = targetFields.filter(f => keys.includes(f.label || f.selector_name));
                    const extracted = await observe(
                        'current_form_extractor',
                        {
                            documentType: 'Current Web Page Form',
                            extractedData: normalizeExtractedData(fieldsMinimal),
                            questions: buildEnrichedQuestions(keys),
                            fieldSpecs,
                            chatContext: message
                        },
                        (payload) => agentExtractorFlow(payload),
                        { source: 'current_form', questionCount: keys.length }
                    );
                    geminiCallCount++;
                    console.log(`   │  ├─ 🌐 Current Form → extracted ${Object.keys(extracted).length} answers`);
                    Object.assign(answers, extracted);
                } else if (docType === 'profile') {
                    // Simple lookup in profile
                    keys.forEach(k => {
                        // REMOVED: answers[k] = JSON.stringify(userProfile); preventing raw JSON dump
                    });
                    // Actually, let's run extractor on profile data too
                    const fieldSpecs = targetFields.filter(f => keys.includes(f.label || f.selector_name));
                    const extracted = await observe(
                        'profile_extractor',
                        {
                            documentType: 'User Profile',
                            extractedData: normalizeExtractedData(userProfile),
                            questions: buildEnrichedQuestions(keys),
                            fieldSpecs,
                            chatContext: message
                        },
                        (payload) => agentExtractorFlow(payload),
                        { source: 'profile', questionCount: keys.length }
                    );
                    geminiCallCount++;
                    console.log(`   │  ├─ 👤 Profile → extracted ${Object.keys(extracted).length} answers`);
                    Object.assign(answers, extracted);
                } else {
                    // Fuzzy match document type (handles "aadhaar" vs "aadhar" etc.)
                    const normalizeDocType = (type) => type?.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const routeNormalized = normalizeDocType(docType);

                    let doc = userDocuments.find(d => {
                        const docNormalized = normalizeDocType(d.documentType);
                        return docNormalized === routeNormalized ||
                            docNormalized.includes(routeNormalized) ||
                            routeNormalized.includes(docNormalized);
                    });

                    // Fallback: exact match
                    if (!doc) {
                        doc = userDocuments.find(d => d.documentType === docType);
                    }

                    if (doc) {
                        const fieldSpecs = targetFields.filter(f => keys.includes(f.label || f.selector_name));
                        const extracted = await observe(
                            'document_extractor',
                            {
                                documentType: docType,
                                extractedData: normalizeExtractedData(doc.extractedData),
                                questions: buildEnrichedQuestions(keys),
                                fieldSpecs,
                                chatContext: message
                            },
                            (payload) => agentExtractorFlow(payload),
                            { source: doc.documentType, questionCount: keys.length }
                        );
                        geminiCallCount++;
                        console.log(`   │  ├─ 📄 ${doc.documentType} → extracted ${Object.keys(extracted).length} answers`);
                        Object.entries(extracted).forEach(([k, v]) => {
                            if (v && v !== 'null' && v !== '') console.log(`   │  │     "${k.slice(0, 35)}" = "${String(v).slice(0, 40)}"`);
                        });
                        Object.assign(answers, extracted);
                    } else {
                        console.warn(`⚠️ [Autofill] Document not found for route: ${docType}`);
                    }
                }
            });

            await Promise.all(promises);
            console.log(`   │  └─ ⏱️ ${Date.now() - extractorStart}ms (${Object.keys(answers).length} answers total)`);

            // C. RESOLVER & MAPPING
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 5: RESOLVER, VALIDATION & MAPPING`);
            const docTypeDataMap = {};
            userDocuments.forEach(d => {
                if (d && d.documentType) {
                    docTypeDataMap[d.documentType] = d.extractedData;
                }
            });
            const optionFieldCount = targetFields.filter(field => Array.isArray(field.options) && field.options.length > 0).length;
            if (optionFieldCount > 1) {
                console.log(`   │  ├─ Parallel option resolution for ${optionFieldCount} fields`);
            }
            const suggestedFills = (
                await Promise.all(targetFields.map(async (field) => {
                const key = field.label || field.selector_name;
                let value = answers[key];

                // If no exact match, try fuzzy match
                if (!value) {
                    const normalizeStr = (str) => String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
                    const normKey = normalizeStr(key);

                    const fuzzyKey = Object.keys(answers).find(k => {
                        const normK = normalizeStr(k);
                        if (!normK) return false;

                        // Exact match after removing punctuation/spaces
                        if (normKey === normK) return true;

                        // High-confidence substring match
                        return normKey.includes(normK) || normK.includes(normKey);
                    });
                    if (fuzzyKey) {
                        value = answers[fuzzyKey];
                        console.log(`🧩[Resolver] Fuzzy matched "${key}" to "${fuzzyKey}"`);
                    }
                }

                // Special fallback: startup stage fields often route to a "stages" reference doc
                if ((!value || String(value).trim() === '') && /stage/i.test(key)) {
                    // Prefer explicit stage from profile if present
                    const profileStageKey = Object.keys(userProfile || {}).find(k => /stage/i.test(k));
                    if (profileStageKey && userProfile[profileStageKey]) {
                        value = userProfile[profileStageKey];
                    } else {
                        // Otherwise, fall back to first stage option from reference doc if available
                        const stageDoc = docTypeDataMap['Startup Development Stages'];
                        if (Array.isArray(stageDoc)) {
                            const stageNames = stageDoc.map(s => s && s.stage).filter(Boolean);
                            if (stageNames.length) {
                                value = stageNames[0];
                            }
                        }
                    }
                }

                // 🔥 HARD TRUNCATION TO PREVENT FRONTEND ERRORS
                if (value && typeof value === 'string') {
                    let maxLength = field.validation?.maxLength;
                    if (!maxLength) {
                        const labelStr = String(key).toLowerCase();
                        // Matches tags like "[Limit: Limit: 500 characters]" or "Maximum 750 characters"
                        const maxCharRegex = /(?:maximum|max|limit)[: \[]*(?:limit:\s*)?(\d+)/i;
                        const match = labelStr.match(maxCharRegex);
                        if (match) {
                            maxLength = parseInt(match[1], 10);
                        }
                    }
                    // Fallback: parse from field description (e.g. "0 / 400" MUI counter text)
                    if (!maxLength && field.description) {
                        const counterMatch = String(field.description).match(/(\d+)\s*\/\s*(\d+)/);
                        if (counterMatch) maxLength = parseInt(counterMatch[2], 10);
                    }

                    if (maxLength && value.length > maxLength) {
                        console.log(`✂️ [Hard Truncation] Slicing exact characters for "${key}" from ${value.length} to ${maxLength}`);
                        value = value.slice(0, maxLength);
                    }
                }

                if (value &&
                    typeof value === 'string' &&
                    value.trim() !== '' &&
                    !['not found', 'null', 'undefined', 'n/a', 'unknown', 'none'].includes(value.trim().toLowerCase())
                ) {
                    // Resolve options if needed
                    if (field.options && field.options.length > 0) {
                        // Normalize options: ensure they are strings.
                        // If they are objects { text, value }, use the value or text.
                        const normalizedOptions = field.options.map(opt => {
                            if (typeof opt === 'object' && opt !== null) {
                                return opt.value || opt.text || JSON.stringify(opt);
                            }
                            return String(opt);
                        });

                        const resolverStart = Date.now();

                        try {
                            geminiCallCount++;
                            const resolved = await observe(
                                'option_resolver',
                                {
                                    fieldLabel: key,
                                    extractedValue: value,
                                    options: normalizedOptions
                                },
                                (payload) => agentResolverFlow(payload),
                                { optionCount: normalizedOptions.length, fieldLabel: key }
                            );
                            console.log(`   │  ├─ 🔀 Resolved "${key.slice(0, 25)}" → "${resolved.selectedOption}" (from ${normalizedOptions.length} options, ${Date.now() - resolverStart}ms)`);
                            value = resolved.selectedOption;
                        } catch (error) {
                            console.warn(`⚠️ [Resolver] Failed for "${key}". Using extracted value instead.`, error?.message || error);
                        }
                    }

                    return {
                        ...field,
                        suggested_value: value
                    };
                }

                return null;
            }))
            ).filter(Boolean);

            console.log(`   │  └─ Mapped ${suggestedFills.length} fields successfully`);
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  ✅ RESULT: ${suggestedFills.length} fields mapped for autofill`);
            console.log(`   │  ⏱️ Total: ${Date.now() - flowStart}ms | Gemini API calls: ${geminiCallCount}`);
            console.log(`   └${'─'.repeat(65)}┘\n`);

            return {
                aiResponse: `I've mapped ${suggestedFills.length} fields for you.`,
                suggestedFills
            };
        }

        // ---------------------------------------------------------
        // HANDLE QUESTION (Ask specific info)
        // ---------------------------------------------------------
        if (intent === 'QUESTION') {
            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  STEP 2: AGENT ROUTER  (Gemini API call #${++geminiCallCount})`);
            console.log(`   │  ├─ Question: "${message.slice(0, 50)}"`);
            console.log(`   │  ├─ Available doc types: ${userDocuments.length + (Object.keys(userProfile).length > 0 ? 1 : 0)}`);

            const validProfileKeys = Object.keys(userProfile).filter(key => {
                const val = userProfile[key];
                return val && typeof val === 'string' && val.trim().length > 0;
            });

            const questionAvailableDocTypes = [];
            const normalizeDocType = (type) => type?.toLowerCase().replace(/[^a-z0-9]/g, '');

            userDocuments.forEach(d => {
                if (d.documentType) {
                    questionAvailableDocTypes.push(d.documentType);
                    const normalized = normalizeDocType(d.documentType);
                    if (normalized && normalized !== d.documentType.toLowerCase()) {
                        questionAvailableDocTypes.push(normalized);
                    }
                }
            });

            if (questionAvailableDocTypes.some(t => normalizeDocType(t).includes('aadhaar') || normalizeDocType(t).includes('aadhar'))) {
                questionAvailableDocTypes.push('aadhaar', 'aadhar');
            }

            if (Object.keys(userProfile).length > 0) questionAvailableDocTypes.push('profile');

            const routerStart = Date.now();
            const routingResult = await observe(
                'doc_router',
                {
                    questions: [message],
                    availableDocTypes: questionAvailableDocTypes,
                    profileKeys: validProfileKeys,
                    chatHistory: chatHistory || []
                },
                (payload) => agentRouterFlow(payload),
                { questionCount: 1, mode: 'question' }
            );
            const route = routingResult.routing[0];
            console.log(`   │  ├─ Router decision: "${message.slice(0, 35)}" → 📄 ${route?.doc || 'NONE'}`);
            console.log(`   │  └─ ⏱️ ${Date.now() - routerStart}ms`);

            if (!route) {
                console.log(`   │  ❌ No route found — cannot answer`);
                console.log(`   └${'─'.repeat(65)}┘\n`);
                return { aiResponse: "I'm not sure where to find that information." };
            }

            console.log(`   ├${'─'.repeat(65)}┤`);

            console.log(`📍 [Question] Routing to: ${route.doc}`);

            // -------------------------
            // 3a. INFO ABOUT CURRENT FORM
            // -------------------------
            if (route.doc === 'current_form') {
                console.log(`   │  STEP 3: DOCUMENT LOOKUP`);
                console.log(`   │  ├─ Source: Current Website Form (${fieldsToUse.length} fields)`);
                console.log(`   │  STEP 4: AGENT EXTRACTOR  (Gemini API call #${++geminiCallCount})`);
                const formContext = {
                    page_url: input.pageUrl || "Unknown URL",
                    total_fields: fieldsToUse.length,
                    fields_list: fieldsToUse.map(f => f.label || f.selector_name || "Unknown").slice(0, 50), // Limit to avoid token overflow
                    summary: `This is a form at ${input.pageUrl}. It has ${fieldsToUse.length} fields.`
                };

                const fieldSpecs = fieldsToUse.filter(f => message.toLowerCase().includes((f.label || f.selector_name || '').toLowerCase()));
                const extractorStart = Date.now();
                const extracted = await observe(
                    'current_form_extractor',
                    {
                        documentType: 'Current Website Form',
                        extractedData: formContext,
                        questions: [message],
                        fieldSpecs,
                        chatContext: message
                    },
                    (payload) => agentExtractorFlow(payload),
                    { source: 'current_form', questionCount: 1 }
                );
                const answer = Object.values(extracted).join('\n') || "I couldn't find an answer about the form.";
                console.log(`   │  ├─ Answer: "${answer.slice(0, 60)}${answer.length > 60 ? '...' : ''}"`);
                console.log(`   │  └─ ⏱️ ${Date.now() - extractorStart}ms`);
                console.log(`   ├${'─'.repeat(65)}┤`);
                console.log(`   │  ✅ RESULT: Answer from current form`);
                console.log(`   │  ⏱️ Total: ${Date.now() - flowStart}ms | Gemini API calls: ${geminiCallCount}`);
                console.log(`   └${'─'.repeat(65)}┘\n`);
                return { aiResponse: answer };
            }

            // -------------------------
            // 3b. INFO ABOUT PROFILE / SYSTEM
            // -------------------------
            let answer = "Not found.";

            if (route.doc === 'profile') {
                console.log(`   │  STEP 3: DOCUMENT LOOKUP`);
                console.log(`   │  ├─ Source: User Profile (${Object.keys(userProfile).length} keys)`);
                console.log(`   │  ├─ Profile includes: ${Object.keys(userProfile).slice(0, 8).join(', ')}${Object.keys(userProfile).length > 8 ? '...' : ''}`);
                console.log(`   ├${'─'.repeat(65)}┤`);
                console.log(`   │  STEP 4: AGENT EXTRACTOR  (Gemini API call #${++geminiCallCount})`);
                console.log(`   │  ├─ Extracting from: User Profile & System Context`);

                const profileContext = {
                    ...userProfile,
                    __system_info: {
                        total_documents: userDocuments.length,
                        document_list: userDocuments.map(d => `${d.documentType} (${d.name})`).join(", "),
                        documents_metadata: userDocuments.map(d => ({
                            type: d.documentType,
                            name: d.name,
                            date: d.createdAt,
                            summary: d.extractedData ? JSON.stringify(d.extractedData).substring(0, 100) + "..." : "No data"
                        }))
                    }
                };

                const extractorStart = Date.now();
                const extracted = await observe(
                    'profile_extractor',
                    {
                        documentType: 'User Profile & System Context',
                        extractedData: profileContext,
                        questions: [message],
                        fieldSpecs: fieldsToUse,
                        chatContext: message
                    },
                    (payload) => agentExtractorFlow(payload),
                    { source: 'profile', questionCount: 1 }
                );
                answer = Object.values(extracted).join('\n');
                console.log(`   │  ├─ Answer: "${answer.slice(0, 60)}${answer.length > 60 ? '...' : ''}"`);
                console.log(`   │  └─ ⏱️ ${Date.now() - extractorStart}ms`);
            } else {
                // Document lookup
                console.log(`   │  STEP 3: DOCUMENT LOOKUP`);
                const normalizeDocType = (type) => type?.toLowerCase().replace(/[^a-z0-9]/g, '');
                const routeNormalized = normalizeDocType(route.doc);

                let doc = userDocuments.find(d => {
                    const docNormalized = normalizeDocType(d.documentType);
                    return docNormalized === routeNormalized ||
                        docNormalized.includes(routeNormalized) ||
                        routeNormalized.includes(docNormalized);
                });

                if (!doc) {
                    doc = userDocuments.find(d => d.documentType === route.doc);
                }

                if (doc) {
                    console.log(`   │  ├─ 🔍 Searching for "${route.doc}" in ${userDocuments.length} documents...`);
                    console.log(`   │  ├─ ✅ FOUND: ${doc.documentType} (name: ${doc.name || 'N/A'})`);
                    const dataKeys = doc.extractedData ? Object.keys(doc.extractedData) : [];
                    console.log(`   │  ├─ 📋 Document has ${dataKeys.length} data fields: [${dataKeys.slice(0, 6).join(', ')}${dataKeys.length > 6 ? '...' : ''}]`);
                    console.log(`   ├${'─'.repeat(65)}┤`);
                    console.log(`   │  STEP 4: AGENT EXTRACTOR  (Gemini API call #${++geminiCallCount})`);
                    console.log(`   │  ├─ Extracting from: ${doc.documentType} data`);
                    console.log(`   │  ├─ Question: "${message}"`);
                    const extractorStart = Date.now();
                    const extracted = await observe(
                        'document_extractor',
                        {
                            documentType: route.doc,
                            extractedData: doc.extractedData,
                            questions: [message],
                            fieldSpecs: fieldsToUse,
                            chatContext: message
                        },
                        (payload) => agentExtractorFlow(payload),
                        { source: doc.documentType, questionCount: 1 }
                    );
                    answer = Object.values(extracted).join('\n');
                    console.log(`   │  ├─ ✅ Answer: "${answer.slice(0, 60)}${answer.length > 60 ? '...' : ''}"`);
                    console.log(`   │  └─ ⏱️ ${Date.now() - extractorStart}ms`);
                } else {
                    console.log(`   │  ├─ ❌ Document "${route.doc}" NOT FOUND in user's documents`);
                    console.log(`   │  ├─ Available: [${userDocuments.map(d => d.documentType).join(', ')}]`);
                    console.log(`   └${'─'.repeat(65)}┘\n`);
                    const availableTypes = userDocuments.map(d => d.documentType).join(', ');
                    return { aiResponse: `I thought I could find that in your ${route.doc}, but I don't see that document uploaded. Available documents: ${availableTypes || 'none'}` };
                }
            }

            console.log(`   ├${'─'.repeat(65)}┤`);
            console.log(`   │  ✅ FINAL ANSWER: "${(answer || '').slice(0, 55)}${(answer || '').length > 55 ? '...' : ''}"`);
            console.log(`   │  ⏱️ Total: ${Date.now() - flowStart}ms | Gemini API calls: ${geminiCallCount}`);
            console.log(`   └${'─'.repeat(65)}┘\n`);

            return { aiResponse: answer || "I couldn't find a specific answer in your documents." };
        }

        console.log(`   │  ❓ Unrecognized intent: ${intent}`);
        console.log(`   └${'─'.repeat(65)}┘\n`);
        return { aiResponse: "I didn't understand that." };
    }
);

// Helper wrapper for Express route
export async function agenticChat(input) {
    const retryWithBackoff = async (fn, retries = 5, delay = 5000) => {
        try {
            return await fn();
        } catch (error) {
            if (retries > 0 && (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('UNAVAILABLE') || error.status === 'UNAVAILABLE')) {
                console.warn(`⚠️ API Error (${error.status || 'Unknown'}). Retrying in ${delay}ms... (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return retryWithBackoff(fn, retries - 1, delay * 2);
            }
            throw error;
        }
    };

    try {
        const result = await retryWithBackoff(() => agenticChatFlow(input));
        return result;
    } catch (error) {
        console.error("❌ Agentic Chat Flow Error:", error.message);
        throw error;
    }
}
