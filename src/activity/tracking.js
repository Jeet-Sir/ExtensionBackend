import { ObjectId } from 'mongodb';

const DEFAULT_MODEL = 'googleai/gemini-2.5-flash';
const DEFAULT_MONTHLY_CREDIT_LIMIT = Number(process.env.MONTHLY_CREDIT_LIMIT || 100);

const MODEL_CREDIT_RATES = {
  'googleai/gemini-2.5-flash': 0.18,
  'gpt-4o-mini': 0.24,
  'gpt-4o': 0.42,
  'claude-3-5-sonnet': 0.48,
  'claude-3.5-sonnet': 0.48,
};

let creditEventsCollection = null;
let formSessionsCollection = null;

function getCollection(name, collection) {
  if (!collection) {
    throw new Error(`${name} collection is not configured`);
  }
  return collection;
}

function safeRound(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

export function estimateTokenCount(value) {
  if (value == null) return 0;

  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }

  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function calculateCredits(totalTokens = 0, modelName = DEFAULT_MODEL) {
  const rate = MODEL_CREDIT_RATES[modelName] ?? 0.2;
  return safeRound((Math.max(0, totalTokens) / 1000) * rate);
}

export function getBillingPeriod(dateValue = new Date()) {
  const date = new Date(dateValue);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export function inferWebsiteName(pageUrl = '') {
  if (!pageUrl) return 'Unknown Website';
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return pageUrl;
  }
}

export function inferExamCategory({ pageUrl = '', pageTitle = '', websiteName = '' } = {}) {
  const haystack = `${pageUrl} ${pageTitle} ${websiteName}`.toLowerCase();

  if (/(ibps|sbi|bank|banking)/.test(haystack)) return 'Banking';
  if (/(rrb|railway|railways)/.test(haystack)) return 'Railways';
  if (/(ssc|upsc|state psc|government|govt)/.test(haystack)) return 'Government';
  if (/(nta|jee|neet|testing agency|exam)/.test(haystack)) return 'Testing Agency';
  if (/(y combinator|yc |techstars|500 global|accelerator|incubator|startup india|f6s|gust)/.test(haystack)) {
    return 'Startup / Accelerator';
  }
  if (/(google forms|docs.google.com\/forms|microsoft forms|typeform|jotform|fillout)/.test(haystack)) {
    return 'Form Platform';
  }

  return 'General';
}

export async function configureTracking(db) {
  creditEventsCollection = db.collection('creditEvents');
  formSessionsCollection = db.collection('formSessions');

  await Promise.all([
    creditEventsCollection.createIndex({ userId: 1, createdAt: -1 }),
    creditEventsCollection.createIndex({ sessionId: 1, createdAt: -1 }),
    creditEventsCollection.createIndex({ billingPeriod: 1, userId: 1 }),
    formSessionsCollection.createIndex({ userId: 1, updatedAt: -1 }),
    formSessionsCollection.createIndex({ status: 1, userId: 1 }),
  ]);
}

function normalizeTraceStep(step = {}, fallbackModel = DEFAULT_MODEL) {
  const inputTokens = Math.max(0, step.inputTokens ?? estimateTokenCount({ bytes: step.inputSizeBytes }));
  const outputTokens = Math.max(0, step.outputTokens ?? estimateTokenCount({ bytes: step.outputSizeBytes }));
  const totalTokens = Math.max(0, step.totalTokens ?? step.tokensUsed ?? inputTokens + outputTokens);
  const modelName = step.modelName || fallbackModel;

  return {
    agentName: step.agentName || 'unknown_agent',
    modelName,
    inputTokens,
    outputTokens,
    totalTokens,
    creditsUsed: safeRound(step.creditsUsed ?? calculateCredits(totalTokens, modelName)),
    durationMs: step.durationMs ?? null,
    success: step.success !== false,
    error: step.error || null,
    createdAt: step.endTime ? new Date(step.endTime).toISOString() : new Date().toISOString(),
    metadata: step.metadata || {},
  };
}

function shouldCountStep(step = {}) {
  return !step?.metadata?.aggregateOnly;
}

export function getTraceCreditsUsed(trace, fallbackModel = DEFAULT_MODEL) {
  return safeRound(
    (trace?.steps || [])
      .filter(shouldCountStep)
      .reduce((sum, step) => {
        const normalized = normalizeTraceStep(step, fallbackModel);
        return sum + normalized.creditsUsed;
      }, 0)
  );
}

export async function createCreditEvent({
  userId,
  sessionId = null,
  eventType,
  agentName,
  modelName = DEFAULT_MODEL,
  inputTokens = 0,
  outputTokens = 0,
  totalTokens = null,
  creditsUsed = null,
  metadata = {},
  createdAt = new Date().toISOString(),
}) {
  const collection = getCollection('creditEvents', creditEventsCollection);
  const normalizedTotalTokens = Math.max(0, totalTokens ?? inputTokens + outputTokens);
  const doc = {
    userId,
    sessionId,
    eventType,
    agentName,
    modelName,
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: normalizedTotalTokens,
    creditsUsed: safeRound(creditsUsed ?? calculateCredits(normalizedTotalTokens, modelName)),
    billingPeriod: getBillingPeriod(createdAt),
    createdAt: new Date(createdAt),
    metadata,
  };

  const { insertedId } = await collection.insertOne(doc);
  return { id: insertedId, ...doc };
}

export async function logTraceCreditEvents({
  userId,
  trace,
  sessionId = null,
  fallbackEventType = 'extension_chat_text',
  fallbackModel = DEFAULT_MODEL,
  baseMetadata = {},
}) {
  if (!trace?.steps || trace.steps.length === 0) return [];

  const events = [];
  for (const step of trace.steps.filter(shouldCountStep)) {
    const normalized = normalizeTraceStep(step, fallbackModel);
    const event = await createCreditEvent({
      userId,
      sessionId,
      eventType: fallbackEventType,
      agentName: normalized.agentName,
      modelName: normalized.modelName,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      totalTokens: normalized.totalTokens,
      creditsUsed: normalized.creditsUsed,
      metadata: {
        durationMs: normalized.durationMs,
        success: normalized.success,
        error: normalized.error,
        ...baseMetadata,
        ...(normalized.metadata || {}),
      },
      createdAt: normalized.createdAt,
    });
    events.push(event);
  }

  return events;
}

export async function createFormSession({
  userId,
  pageUrl,
  pageTitle,
  status = 'submitted',
  modelName = DEFAULT_MODEL,
  trace,
  mappedFields = [],
  documents = [],
  metadata = {},
}) {
  const collection = getCollection('formSessions', formSessionsCollection);
  const normalizedTraceSteps = (trace?.steps || []).filter(shouldCountStep).map((step) => normalizeTraceStep(step, modelName));
  const totalTokens = normalizedTraceSteps.reduce((sum, step) => sum + step.totalTokens, 0);
  const creditsUsed = safeRound(normalizedTraceSteps.reduce((sum, step) => sum + step.creditsUsed, 0));
  const websiteName = inferWebsiteName(pageUrl);
  const examCategory = inferExamCategory({ pageUrl, pageTitle, websiteName });
  const now = new Date();

  const sessionDoc = {
    userId,
    formTitle: pageTitle || websiteName || 'Untitled Form',
    websiteName,
    formUrl: pageUrl,
    examCategory,
    status,
    modelName,
    startedAt: trace?.startTime ? new Date(trace.startTime) : now,
    submittedAt: status === 'submitted' ? now : null,
    updatedAt: now,
    creditsUsed,
    totalTokens,
    agentCount: normalizedTraceSteps.length,
    agentLogs: normalizedTraceSteps.map((step) => ({
      agentName: step.agentName,
      modelName: step.modelName,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      totalTokens: step.totalTokens,
      creditsUsed: step.creditsUsed,
      durationMs: step.durationMs,
      success: step.success,
      error: step.error,
      createdAt: new Date(step.createdAt),
      metadata: step.metadata || {},
    })),
    documents,
    metadata,
  };

  const { insertedId } = await collection.insertOne(sessionDoc);
  return { id: insertedId, ...sessionDoc };
}

export async function getUserMonthlyCredits(userId, billingPeriod = getBillingPeriod()) {
  const collection = getCollection('creditEvents', creditEventsCollection);
  const aggregation = await collection
    .aggregate([
      { $match: { userId, billingPeriod } },
      { $group: { _id: null, total: { $sum: '$creditsUsed' } } },
    ])
    .toArray();

  return safeRound(aggregation[0]?.total || 0);
}

export async function buildCreditIndicator(userId, creditsUsed, billingPeriod = getBillingPeriod()) {
  const monthCredits = await getUserMonthlyCredits(userId, billingPeriod);
  const remaining = Math.max(0, safeRound(DEFAULT_MONTHLY_CREDIT_LIMIT - monthCredits));

  return {
    creditsUsed: safeRound(creditsUsed),
    creditsThisMonth: monthCredits,
    remainingCredits: remaining,
    monthlyLimit: DEFAULT_MONTHLY_CREDIT_LIMIT,
    message: `${safeRound(creditsUsed)} credits used for this response | ${remaining} remaining this month`,
  };
}

export async function getActivitySummary(userId) {
  const sessions = getCollection('formSessions', formSessionsCollection);
  const creditEvents = getCollection('creditEvents', creditEventsCollection);
  const billingPeriod = getBillingPeriod();

  const [submittedAgg, creditAgg, docsAgg, monthlyAgg] = await Promise.all([
    sessions.aggregate([{ $match: { userId, status: 'submitted' } }, { $count: 'count' }]).toArray(),
    creditEvents.aggregate([{ $match: { userId } }, { $group: { _id: null, total: { $sum: '$creditsUsed' } } }]).toArray(),
    creditEvents.aggregate([
      { $match: { userId, eventType: { $in: ['extension_chat_doc', 'doc_upload_extract'] } } },
      { $group: { _id: '$metadata.documentName' } },
      { $count: 'count' },
    ]).toArray(),
    creditEvents.aggregate([
      { $match: { userId, billingPeriod } },
      { $group: { _id: null, total: { $sum: '$creditsUsed' } } },
    ]).toArray(),
  ]);

  return {
    totalFormsFilled: submittedAgg[0]?.count || 0,
    totalCreditsUsed: safeRound(creditAgg[0]?.total || 0),
    docsUploaded: docsAgg[0]?.count || 0,
    creditsThisMonth: safeRound(monthlyAgg[0]?.total || 0),
  };
}

function buildSessionMatch(userId, filters = {}) {
  const match = { userId };

  if (filters.status) match.status = filters.status;
  if (filters.examCategory) match.examCategory = filters.examCategory;
  if (filters.modelName) match.modelName = filters.modelName;

  if (filters.dateFrom || filters.dateTo) {
    match.updatedAt = {};
    if (filters.dateFrom) match.updatedAt.$gte = new Date(`${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) match.updatedAt.$lte = new Date(`${filters.dateTo}T23:59:59.999Z`);
  }

  if (filters.search) {
    match.$or = [
      { formTitle: { $regex: filters.search, $options: 'i' } },
      { formUrl: { $regex: filters.search, $options: 'i' } },
      { websiteName: { $regex: filters.search, $options: 'i' } },
    ];
  }

  return match;
}

function toPlainSession(sessionDoc) {
  if (!sessionDoc) return null;
  return {
    id: String(sessionDoc._id),
    userId: sessionDoc.userId,
    formTitle: sessionDoc.formTitle,
    websiteName: sessionDoc.websiteName,
    formUrl: sessionDoc.formUrl,
    examCategory: sessionDoc.examCategory,
    status: sessionDoc.status,
    modelName: sessionDoc.modelName,
    startedAt: sessionDoc.startedAt?.toISOString?.() || sessionDoc.startedAt,
    submittedAt: sessionDoc.submittedAt?.toISOString?.() || sessionDoc.submittedAt || null,
    updatedAt: sessionDoc.updatedAt?.toISOString?.() || sessionDoc.updatedAt,
    creditsUsed: safeRound(sessionDoc.creditsUsed),
    totalTokens: sessionDoc.totalTokens || 0,
    agentCount: sessionDoc.agentCount || 0,
    agentLogs: (sessionDoc.agentLogs || []).map((log, index) => ({
      id: `${sessionDoc._id}-agent-${index}`,
      agentName: log.agentName,
      modelName: log.modelName,
      inputTokens: log.inputTokens || 0,
      outputTokens: log.outputTokens || 0,
      totalTokens: log.totalTokens || 0,
      creditsUsed: safeRound(log.creditsUsed),
      createdAt: log.createdAt?.toISOString?.() || log.createdAt,
      metadata: log.metadata || {},
      durationMs: log.durationMs ?? null,
      success: log.success !== false,
      error: log.error || null,
    })),
    documents: sessionDoc.documents || [],
    metadata: sessionDoc.metadata || {},
  };
}

export async function listActivitySessions(userId, filters = {}) {
  const sessions = getCollection('formSessions', formSessionsCollection);
  const match = buildSessionMatch(userId, filters);
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20));
  const skip = (page - 1) * pageSize;

  const [items, total, allValues, summary] = await Promise.all([
    sessions.find(match).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).toArray(),
    sessions.countDocuments(match),
    sessions.find({ userId }).project({ examCategory: 1, modelName: 1 }).toArray(),
    getActivitySummary(userId),
  ]);

  return {
    summary,
    sessions: items.map(toPlainSession),
    total,
    page,
    pageSize,
    hasMore: skip + pageSize < total,
    availableCategories: [...new Set(allValues.map((item) => item.examCategory).filter(Boolean))].sort(),
    availableModels: [...new Set(allValues.map((item) => item.modelName).filter(Boolean))].sort(),
  };
}

export async function getActivitySessionDetail(userId, sessionId) {
  const sessions = getCollection('formSessions', formSessionsCollection);
  const creditEvents = getCollection('creditEvents', creditEventsCollection);
  if (!ObjectId.isValid(sessionId)) return null;

  const sessionDoc = await sessions.findOne({ _id: new ObjectId(sessionId), userId });
  if (!sessionDoc) return null;

  const events = await creditEvents.find({ userId, sessionId }).sort({ createdAt: -1 }).toArray();

  return {
    session: toPlainSession(sessionDoc),
    creditEvents: events.map((event) => ({
      id: String(event._id),
      userId: event.userId,
      sessionId: event.sessionId,
      eventType: event.eventType,
      agentName: event.agentName,
      modelName: event.modelName,
      inputTokens: event.inputTokens || 0,
      outputTokens: event.outputTokens || 0,
      totalTokens: event.totalTokens || 0,
      creditsUsed: safeRound(event.creditsUsed),
      billingPeriod: event.billingPeriod,
      createdAt: event.createdAt?.toISOString?.() || event.createdAt,
      metadata: event.metadata || {},
    })),
  };
}
