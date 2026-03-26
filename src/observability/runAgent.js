// ─────────────────────────────────────────────
// Generic agent execution wrapper – transparent observability
// Does not modify agent logic; only wraps execution and records trace.
// ─────────────────────────────────────────────

import { logger } from './logger.js';
import { getTraceDurationMs } from './traceContext.js';
import { extractProviderUsage } from './providerUsage.js';

function estimateTokensFromBytes(sizeBytes) {
  if (!sizeBytes || sizeBytes <= 0) return 0;
  return Math.max(1, Math.ceil(sizeBytes / 4));
}

/**
 * @param {object} options
 * @param {object} options.trace - Trace object (traceId, steps, errors)
 * @param {string} options.agentName - Name of the agent stage
 * @param {any} options.input - Input passed to the agent
 * @param {function(options.input): Promise<any>} options.agentFunction - The agent function to run
 * @param {string} [options.modelName] - Model name used by the agent
 * @param {object} [options.metadata] - Extra metadata to attach to the trace step
 * @returns {Promise<any>} - Whatever the agent returns
 */
export async function runAgent({ trace, agentName, input, agentFunction, modelName = 'googleai/gemini-2.5-flash', metadata = {} }) {
  const stepStart = Date.now();
  const traceId = trace.traceId;

  const payloadSize = (obj) => {
    try {
      return Buffer.byteLength(JSON.stringify(obj), 'utf8');
    } catch {
      return 0;
    }
  };

  const inputSize = payloadSize(input);
  const inputTokens = estimateTokensFromBytes(inputSize);
  const isDebugMode =
    String(process.env.DEBUG_MODE || '').trim().toLowerCase() === 'true' || process.env.DEBUG_MODE === '1';
  const logLevel = isDebugMode ? 'info' : 'debug';

  logger[logLevel]({
    event: 'agent_start',
    traceId,
    agentName,
    inputSizeBytes: inputSize,
    ts: new Date().toISOString(),
  });

  try {
    const output = await agentFunction(input);
    const durationMs = Date.now() - stepStart;
    const outputSize = payloadSize(output);
    const estimatedOutputTokens = estimateTokensFromBytes(outputSize);
    const providerUsage = extractProviderUsage(output);

    // Debug log for provider token counts
    if (providerUsage) {
      console.log(`Provider usage for ${agentName}: inputTokens=${providerUsage.inputTokens}, outputTokens=${providerUsage.outputTokens}, totalTokens=${providerUsage.totalTokens}`);
    }

    const resolvedInputTokens = providerUsage?.inputTokens ?? inputTokens;
    const resolvedOutputTokens = providerUsage?.outputTokens ?? estimatedOutputTokens;
    const tokensUsed =
      providerUsage?.totalTokens ??
      output?.tokensUsed ??
      output?.tokenUsage?.totalTokens ??
      null;
    const totalTokens = tokensUsed ?? resolvedInputTokens + resolvedOutputTokens;

    const step = {
      agentName,
      modelName,
      startTime: stepStart,
      endTime: Date.now(),
      durationMs,
      inputSizeBytes: inputSize,
      outputSizeBytes: outputSize,
      inputTokens: resolvedInputTokens,
      outputTokens: resolvedOutputTokens,
      totalTokens,
      tokensUsed: totalTokens,
      success: true,
      error: null,
      metadata: {
        ...metadata,
        usageSource: providerUsage ? 'provider' : 'estimated',
        providerUsage: providerUsage || null,
      },
    };

    trace.steps.push(step);

    logger[logLevel]({
      event: 'agent_end',
      traceId,
      agentName,
      durationMs,
      outputSizeBytes: outputSize,
      tokensUsed: totalTokens,
      ts: new Date().toISOString(),
    });

    return output;
  } catch (err) {
    const durationMs = Date.now() - stepStart;
    const errorRecord = {
      agentName,
      message: err?.message ?? String(err),
      stack: err?.stack ?? null,
      ts: new Date().toISOString(),
    };

    trace.errors.push(errorRecord);
    trace.steps.push({
      agentName,
      modelName,
      startTime: stepStart,
      endTime: Date.now(),
      durationMs,
      inputSizeBytes: inputSize,
      outputSizeBytes: null,
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
      tokensUsed: inputTokens,
      success: false,
      error: errorRecord.message,
      metadata,
    });

    logger.error({
      event: 'agent_error',
      traceId,
      agentName,
      durationMs,
      error: errorRecord.message,
      ts: new Date().toISOString(),
    });

    throw err;
  }
}
