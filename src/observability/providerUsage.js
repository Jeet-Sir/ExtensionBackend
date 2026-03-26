function toSafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function normalizeProviderUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const usage = {
    inputTokens:
      toSafeNumber(rawUsage.inputTokens) ??
      toSafeNumber(rawUsage.promptTokenCount),
    outputTokens:
      toSafeNumber(rawUsage.outputTokens) ??
      toSafeNumber(rawUsage.candidatesTokenCount),
    totalTokens:
      toSafeNumber(rawUsage.totalTokens) ??
      toSafeNumber(rawUsage.totalTokenCount),
    inputImages: toSafeNumber(rawUsage.inputImages),
    outputImages: toSafeNumber(rawUsage.outputImages),
    thoughtsTokens: toSafeNumber(rawUsage.thoughtsTokens),
    cachedContentTokens: toSafeNumber(rawUsage.cachedContentTokens),
  };

  const hasUsage = Object.values(usage).some((value) => value !== undefined);
  return hasUsage ? usage : null;
}

export function extractProviderUsage(value) {
  if (!value || typeof value !== 'object') return null;

  return (
    normalizeProviderUsage(value.usage) ||
    normalizeProviderUsage(value.tokenUsage) ||
    normalizeProviderUsage(value.response?.usage) ||
    normalizeProviderUsage(value.response?.tokenUsage) ||
    normalizeProviderUsage(value.custom?.usage) ||
    null
  );
}

export function attachProviderUsage(target, rawUsage) {
  const usage = normalizeProviderUsage(rawUsage);
  if (!usage || !target || typeof target !== 'object') {
    return target;
  }

  Object.defineProperty(target, 'usage', {
    value: usage,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  return target;
}
