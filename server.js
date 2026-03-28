// ─────────────────────────────────────────────
// File: src/server.js
// ─────────────────────────────────────────────

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';

import { agenticChat } from './src/flows/agenticChat.js';
import { processDocument } from './src/flows/processDocument.js';
import { generateFakeProfile } from './src/flows/generateFakeProfile.js';
import { intelligentFill } from './src/flows/intelligentFill.js';
import { createTrace, getTraceDurationMs } from './src/observability/traceContext.js';
import { runAgent } from './src/observability/runAgent.js';
import { smartConsoleAgent } from './src/observability/smartConsoleAgent.js';
import { logger } from './src/observability/logger.js';
import {
  buildCreditIndicator,
  configureTracking,
  createCreditEvent,
  createFormSession,
  getActivitySessionDetail,
  getActivitySummary,
  getTraceCreditsUsed,
  listActivitySessions,
  logTraceCreditEvents,
} from './src/activity/tracking.js';

const app = express();
const port = process.env.PORT || 4002;
const DEBUG_MODE =
  String(process.env.DEBUG_MODE || '').trim().toLowerCase() === 'true' ||
  process.env.DEBUG_MODE === '1';
if (DEBUG_MODE) {
  console.log('🔬 DEBUG_MODE is ON – Smart Debug Summary will run after each /api/chat');
}
const PROFILE_SOURCE_BASE_URL = (process.env.PROFILE_SOURCE_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PROFILE_SOURCE_ENDPOINT = process.env.PROFILE_SOURCE_ENDPOINT || '/profile';
const PROFILE_FETCH_TIMEOUT_MS = Number(process.env.PROFILE_FETCH_TIMEOUT_MS || 5000);

// Middleware
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────
// DETAILED REQUEST/RESPONSE LOGGING MIDDLEWARE
// ─────────────────────────────
let requestCounter = 0;

app.use((req, res, next) => {
  const reqId = ++requestCounter;
  const start = Date.now();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const hasAuth = !!req.headers.authorization;

  // Skip OPTIONS preflight noise
  if (method === 'OPTIONS') return next();

  // Incoming request log
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📥 [#${reqId}] ${ts}  ${method} ${path}`);
  console.log(`   🔑 Auth: ${hasAuth ? 'Bearer token present' : '❌ No token'}`);

  if (method === 'POST' && req.body) {
    const bodyKeys = Object.keys(req.body);
    console.log(`   📦 Body keys: [${bodyKeys.join(', ')}]`);
    if (req.body.message) console.log(`   💬 Message: "${String(req.body.message).slice(0, 80)}${String(req.body.message).length > 80 ? '...' : ''}"`);
    if (req.body.page_url) console.log(`   🌐 Page URL: ${req.body.page_url}`);
    if (req.body.pageUrl) console.log(`   🌐 Page URL: ${req.body.pageUrl}`);
    if (req.body.userId) console.log(`   👤 User ID: ${req.body.userId}`);
    if (req.body.fields) console.log(`   📋 Fields count: ${Array.isArray(req.body.fields) ? req.body.fields.length : 'N/A'}`);
    if (req.body.fieldsMinimal) console.log(`   📋 Fields minimal count: ${Array.isArray(req.body.fieldsMinimal) ? req.body.fieldsMinimal.length : 'N/A'}`);
  }

  // Capture response
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    const statusEmoji = statusCode < 400 ? '✅' : '❌';

    console.log(`📤 [#${reqId}] ${statusEmoji} ${statusCode} — ${duration}ms`);

    if (body) {
      if (body.aiResponse) console.log(`   🤖 AI Response: "${String(body.aiResponse).slice(0, 100)}${String(body.aiResponse).length > 100 ? '...' : ''}"`);
      if (body.suggestedFills) console.log(`   🎯 Suggested Fills: ${Array.isArray(body.suggestedFills) ? body.suggestedFills.length : 0} fields`);
      if (body.mappedFields) console.log(`   🗺️  Mapped Fields: ${Array.isArray(body.mappedFields) ? body.mappedFields.length : 0} fields`);
      if (body.usedRealData !== undefined) console.log(`   📊 Used Real Data: ${body.usedRealData}`);
      if (body.cached !== undefined) console.log(`   💾 From Cache: ${body.cached}`);
      if (body.duplicate !== undefined) console.log(`   ⚠️  Duplicate Doc: ${body.duplicate}`);
      if (body.error) console.log(`   🚨 Error: ${body.error}`);
    }

    console.log(`${'═'.repeat(70)}\n`);
    return originalJson(body);
  };

  next();
});

// MongoDB Setup
const MONGODB_URI = process.env.MONGODB_URI || 'your-mongodb-atlas-connection-string';
const DB_NAME = 'formAutofill';

let db;
let formMappingsCollection;
let userDocumentsCollection;
let userProfilesCollection;

function buildPageKey(pageUrl, pageSignature) {
  if (!pageUrl) return null;
  
  let cleanUrl = pageUrl;
  try {
    const urlObj = new URL(pageUrl);
    
    // For Google Forms, the query parameters (like ?pli=1, ?usp=sharing) 
    // don't change the form structure. We can safely ignore them for the cache key.
    if (urlObj.hostname.includes('docs.google.com') && urlObj.pathname.includes('/forms/')) {
        urlObj.search = ''; 
    }
    
    // For other domains, optionally strip tracking parameters like utm_*
    // urlObj.searchParams.delete('utm_source');
    
    cleanUrl = urlObj.toString();
  } catch (e) {
    // If it's not a valid URL (e.g. somehow just a path), use it as is
    cleanUrl = pageUrl;
  }

  return pageSignature ? `${cleanUrl}::${pageSignature}` : cleanUrl;
}

async function findCachedMapping(pageUrl, pageSignature) {
  const pageKey = buildPageKey(pageUrl, pageSignature);
  if (!pageKey) return { pageKey: null, cached: null };

  let cached = await formMappingsCollection.findOne({ page_key: pageKey });
  if (!cached && !pageSignature && pageUrl) {
    // If we're falling back to pageUrl check, we must clean it exactly as buildPageKey did
    let cleanUrl = pageUrl;
    try {
        const urlObj = new URL(pageUrl);
        if (urlObj.hostname.includes('docs.google.com') && urlObj.pathname.includes('/forms/')) {
            urlObj.search = ''; 
        }
        cleanUrl = urlObj.toString();
    } catch(e) {}
    
    // First try the cleaned URL
    let legacy = await formMappingsCollection.findOne({ page_url: cleanUrl });
    
    // If not found, try the exact original URL string just in case
    if (!legacy && cleanUrl !== pageUrl) {
         legacy = await formMappingsCollection.findOne({ page_url: pageUrl });
    }

    if (legacy && !legacy.page_key) {
      await formMappingsCollection.updateOne(
        { _id: legacy._id },
        { $set: { page_key: pageKey } }
      );
      legacy.page_key = pageKey;
    }
    cached = legacy;
  }

  return { pageKey, cached };
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim() || null;
}

function decodeJwtPayload(token) {
  if (!token || !token.includes('.')) return null;

  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function pickCanonicalUserId(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveCanonicalUserId({ req, explicitUserId = null, profile = null } = {}) {
  const tokenPayload = decodeJwtPayload(getBearerToken(req));

  return pickCanonicalUserId(
    tokenPayload?.userId,
    tokenPayload?.user_id,
    profile?.userId,
    profile?.id,
    profile?.user_id,
    profile?.user?.userId,
    profile?.user?.id,
    profile?.user?.user_id,
    explicitUserId,
    profile?.email,
    profile?.user?.email,
  );
}

function toAgentProfileContext(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object') return {};

  const profile = {};
  Object.entries(rawProfile).forEach(([key, value]) => {
    if (value === null || value === undefined) return;

    if (['string', 'number', 'boolean'].includes(typeof value)) {
      profile[key] = String(value);
      return;
    }

    if (Array.isArray(value)) {
      const primitiveValues = value.filter((v) => ['string', 'number', 'boolean'].includes(typeof v));
      if (primitiveValues.length > 0) {
        profile[key] = primitiveValues.join(', ');
      }
    }
  });

  return profile;
}

function normalizeDocumentType(docTypeKey) {
  if (!docTypeKey || typeof docTypeKey !== 'string') return null;
  
  const normalized = docTypeKey
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  
  // Common mappings
  const mappings = {
    'aadhaar_card': 'aadhaar',
    'aadhar_card': 'aadhaar',
    'pan_card': 'pan',
    'voter_id': 'voter_id',
    'passport_photo': 'passport',
    '10th_marksheet': '10th_marksheet',
    '12th_marksheet': '12th_marksheet',
    'degree_certificate': 'degree',
    'startup_pitch_deck': 'startup_pitch_deck',
  };
  
  return mappings[normalized] || normalized;
}

async function parseDocumentsFromWebsite(userId, websiteDocuments) {
  if (!websiteDocuments || typeof websiteDocuments !== 'object') return [];
  
  const parsedDocs = [];
  
  for (const [docKey, docData] of Object.entries(websiteDocuments)) {
    if (!docData || typeof docData !== 'object') continue;
    
    const normalizedType = normalizeDocumentType(docKey);
    if (!normalizedType) continue;
    
    // Skip if no extractedData or status is not verified
    if (!docData.extractedData || docData.status !== 'verified') {
      console.log(`⏭️ Skipping ${docKey}: missing extractedData or not verified`);
      continue;
    }
    
    const memDoc = {
      userId,
      name: docKey,
      documentType: normalizedType,
      extractedData: docData.extractedData,
      createdAt: docData.uploadedAt ? new Date(docData.uploadedAt) : new Date(),
      updatedAt: docData.processedAt ? new Date(docData.processedAt) : new Date(),
      source: 'website-backend',
    };
    
    parsedDocs.push(memDoc);
    console.log(`✅ Parsed document from website: ${docKey} → ${normalizedType}`);
  }
  
  return parsedDocs;
}

async function fetchProfileFromSource(req) {
  const token = getBearerToken(req);
  if (!token) {
    console.log(`   ⛔ [ProfileFetch] No Bearer token — skipping profile fetch`);
    return null;
  }

  const targetUrl = `${PROFILE_SOURCE_BASE_URL}${PROFILE_SOURCE_ENDPOINT}`;
  console.log(`   🔗 [ProfileFetch] → GET ${targetUrl}`);
  const fetchStart = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    const fetchDuration = Date.now() - fetchStart;

    if (!response.ok) {
      console.warn(`   ⚠️ [ProfileFetch] ← ${response.status} in ${fetchDuration}ms`);
      return null;
    }

    const data = await response.json();
    const user = data?.user;
    if (!user || typeof user !== 'object') {
      console.warn(`   ⚠️ [ProfileFetch] ← 200 but no 'user' object in response (${fetchDuration}ms)`);
      return null;
    }

    const resolvedUserId = user.userId || user.id || user.user_id || user.email || null;
    const profile = toAgentProfileContext(user);
    const docCount = user.documents ? Object.keys(user.documents).length : 0;

    console.log(`   ✅ [ProfileFetch] ← 200 in ${fetchDuration}ms | userId: ${resolvedUserId} | profileKeys: ${Object.keys(profile).length} | docs: ${docCount}`);
    
    let parsedDocuments = [];
    // Parse documents from website backend directly to memory
    if (resolvedUserId && user.documents && typeof user.documents === 'object') {
      try {
        console.log(`   📥 Parsing ${docCount} documents from website backend...`);
        parsedDocuments = await parseDocumentsFromWebsite(resolvedUserId, user.documents);
        console.log(`   ✅ Parsed ${parsedDocuments.length}/${docCount} verified documents`);
      } catch (err) {
        console.warn(`   ⚠️ Document parsing failed: ${err.message}`);
      }
    }
    
    return { profile, resolvedUserId, documents: parsedDocuments };
  } catch (err) {
    const fetchDuration = Date.now() - fetchStart;
    console.warn(`   ❌ [ProfileFetch] Failed in ${fetchDuration}ms: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connected to MongoDB Atlas');

    db = client.db(DB_NAME);
    formMappingsCollection = db.collection('formMappings');
    userDocumentsCollection = db.collection('userDocuments');
    userProfilesCollection = db.collection('userProfiles');
    await configureTracking(db);

    try {
      await formMappingsCollection.dropIndex('page_url_1');
      console.log('✅ Dropped legacy unique index: page_url_1');
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') {
        console.warn('⚠️ Could not drop legacy index page_url_1:', err.message);
      }
    }

    await formMappingsCollection.createIndex({ page_key: 1 }, { unique: true, sparse: true });
    await formMappingsCollection.createIndex({ page_url: 1 });
    await userDocumentsCollection.createIndex({ userId: 1, documentType: 1 });
    await userProfilesCollection.createIndex({ userId: 1 }, { unique: true });
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}

await connectToMongoDB();

async function resolveActivityUserId(req) {
  const explicitUserId = req.query.userId || req.body?.userId || null;
  if (explicitUserId && explicitUserId !== 'anonymous') {
    return explicitUserId;
  }

  const sourceProfile = await fetchProfileFromSource(req);
  return sourceProfile?.resolvedUserId || null;
}

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    time: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected',
  });
});

app.get('/api/activity/summary', async (req, res) => {
  try {
    const userId = await resolveActivityUserId(req);
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId or authorization token' });
    }

    const summary = await getActivitySummary(userId);
    return res.json(summary);
  } catch (error) {
    console.error('Activity summary error:', error);
    return res.status(500).json({ error: 'Failed to load activity summary' });
  }
});

app.get('/api/activity/sessions', async (req, res) => {
  try {
    const userId = await resolveActivityUserId(req);
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId or authorization token' });
    }

    const activity = await listActivitySessions(userId, {
      search: req.query.search,
      status: req.query.status,
      examCategory: req.query.examCategory,
      modelName: req.query.modelName,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    return res.json(activity);
  } catch (error) {
    console.error('Activity sessions error:', error);
    return res.status(500).json({ error: 'Failed to load activity sessions' });
  }
});

app.get('/api/activity/sessions/:sessionId', async (req, res) => {
  try {
    const userId = await resolveActivityUserId(req);
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId or authorization token' });
    }

    const detail = await getActivitySessionDetail(userId, req.params.sessionId);
    if (!detail) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json(detail);
  } catch (error) {
    console.error('Activity session detail error:', error);
    return res.status(500).json({ error: 'Failed to load activity session detail' });
  }
});

app.post('/api/activity/import-credit-event', async (req, res) => {
  try {
    const userId = await resolveActivityUserId(req);
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId or authorization token' });
    }

    const {
      eventType,
      agentName,
      modelName,
      inputTokens = 0,
      outputTokens = 0,
      totalTokens = null,
      creditsUsed = null,
      createdAt,
      metadata = {},
      sourceEventId = null,
      sourceSystem = 'website_backend',
    } = req.body || {};

    if (!eventType || !agentName || !modelName) {
      return res.status(400).json({ error: 'Missing eventType, agentName, or modelName' });
    }

    if (sourceEventId) {
      const existing = await db.collection('creditEvents').findOne({
        userId,
        'metadata.syncSource': sourceSystem,
        'metadata.sourceEventId': sourceEventId,
      });

      if (existing) {
        return res.json({
          duplicate: true,
          eventId: String(existing._id),
        });
      }
    }

    const event = await createCreditEvent({
      userId,
      eventType,
      agentName,
      modelName,
      inputTokens,
      outputTokens,
      totalTokens,
      creditsUsed,
      createdAt,
      metadata: {
        ...(metadata || {}),
        syncSource: sourceSystem,
        sourceEventId,
      },
    });

    return res.status(201).json({
      duplicate: false,
      eventId: String(event.id),
    });
  } catch (error) {
    console.error('Activity import error:', error);
    return res.status(500).json({ error: 'Failed to import credit event' });
  }
});

// ─────────────────────────────
// CHAT ENDPOINT (Genkit-based)
// ─────────────────────────────

app.post('/api/chat', async (req, res) => {
  try {
    const { message, pageUrl, pageTitle, pageSignature, fieldsMinimal, userId, userProfile: providedProfile } = req.body;
    console.log(`\n   ──── 🧠 CHAT PIPELINE START ────`);

    // Observability: create trace for this request (traceId, steps, errors)
    const trace = createTrace({ message });
    if (DEBUG_MODE) {
      logger.info({ event: 'request_start', traceId: trace.traceId, message, ts: new Date().toISOString() });
    }

    // 1. Fetch User Documents & Profile from DB with Retry
    let userDocuments = [];
    let userProfile = providedProfile || {};
    let effectiveUserId = resolveCanonicalUserId({ req, explicitUserId: userId, profile: providedProfile }) || 'anonymous';

    const fetchUserData = async () => {
        console.log(`   📡 [Step 1] Fetching user profile from website backend...`);
        const sourceProfile = await fetchProfileFromSource(req);

        if (sourceProfile?.resolvedUserId) {
            effectiveUserId = sourceProfile.resolvedUserId;
            userProfile = sourceProfile.profile || {};
            if (sourceProfile.documents && sourceProfile.documents.length > 0) {
                userDocuments = sourceProfile.documents;
                console.log(`📚 Using ${userDocuments.length} documents from website backend for user ${effectiveUserId}`);
            }
            console.log(`👤 Using profile source for user ${effectiveUserId} (Keys: ${Object.keys(userProfile).length})`);
            
            // Note: intentionally skipping writing profile to MongoDB as extension doesn't need to persist it.
        } else if (providedProfile && typeof providedProfile === 'object') {
            effectiveUserId = resolveCanonicalUserId({ req, explicitUserId: effectiveUserId, profile: providedProfile }) || effectiveUserId;
            userProfile = toAgentProfileContext(providedProfile);
            console.log(`👤 Using provided profile for user ${effectiveUserId} (Keys: ${Object.keys(userProfile).length})`);
        }

        if (effectiveUserId && effectiveUserId !== 'anonymous') {
            if (userDocuments.length === 0) {
                console.log(`   📡 [Step 2] Reading userDocuments from MongoDB (fallback) for userId: ${effectiveUserId}`);
                userDocuments = await userDocumentsCollection.find({ userId: effectiveUserId }).toArray();
                console.log(`   ✅ [Step 2] Found ${userDocuments.length} documents in MongoDB`);
            } else {
                console.log(`   ✅ [Step 2] Skipping MongoDB document fetch (using website backend data directly)`);
            }

            if (!userProfile || Object.keys(userProfile).length === 0) {
                const profileDoc = await userProfilesCollection.findOne({ userId: effectiveUserId });
                if (profileDoc && profileDoc.profile) {
                    userProfile = profileDoc.profile;
                    console.log(`👤 Using cached Mongo profile for user ${effectiveUserId}`);
                }
            }
        }
    };

    const retryOperation = async (fn, retries = 3, delay = 1000) => {
        try {
            await fn();
        } catch (err) {
            if (retries > 0) {
                console.warn(`⚠️ DB Fetch failed (${err.message}). Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                await retryOperation(fn, retries - 1, delay * 2);
            } else {
                throw err;
            }
        }
    };

    try {
        await retryOperation(fetchUserData);
    } catch (err) {
        console.error("❌ Critical Error fetching user data:", err);
        return res.status(503).json({ 
            error: "Temporary database connection issue. Please try again.",
            aiResponse: "I'm having trouble accessing your documents right now due to a connection issue. Please try again in a moment."
        });
    }

    // 1.5 Fetch Cached Form Fields (if available)
    let cachedFields = [];
    if (pageUrl) {
        try {
            console.log(`   📡 [Step 3] Checking formMappings cache for: ${pageUrl}`);
            const { pageKey, cached } = await findCachedMapping(pageUrl, pageSignature);
            if (cached && cached.mappedFields) {
                cachedFields = cached.mappedFields;
                console.log(`   ✅ [Step 3] Cache HIT — ${cachedFields.length} cached fields found`);
            } else {
                console.log(`   ⚠️ [Step 3] Cache MISS — no mapping for ${pageKey || pageUrl}`);
            }
        } catch (err) {
            console.error(`   ❌ [Step 3] Cache lookup failed:`, err.message);
        }
    }

    // 2. Call Agentic Chat Flow (wrapped for observability – no change to agent logic)
    console.log(`   📡 [Step 4] Running agenticChat AI pipeline...`);
    console.log(`   📊 [Context] userId: ${effectiveUserId} | docs: ${userDocuments.length} | profileKeys: ${Object.keys(userProfile).length} | formFields: ${(fieldsMinimal||[]).length} | cachedFields: ${cachedFields.length}`);

    const chatInput = {
      message,
      chatHistory: req.body.chatHistory || [],
      userId: effectiveUserId || 'anonymous',
      pageUrl,
      pageTitle,
      fieldsMinimal,
      cachedFields,
      userDocuments,
      userProfile,
      trace,
      deleteDocument: async (docId) => {
        if (!effectiveUserId || effectiveUserId === 'anonymous') throw new Error("Unauthorized");
        console.log(`   🗑️ [MongoDB] Deleting document ${docId} for user ${effectiveUserId}`);
        await userDocumentsCollection.deleteOne({ _id: new ObjectId(docId), userId: effectiveUserId });
        console.log(`   ✅ [MongoDB] Document deleted`);
      },
    };
    const agentStart = Date.now();
    const result = await runAgent({
      trace,
      agentName: 'agenticChat',
      input: chatInput,
      agentFunction: (input) => agenticChat(input),
      metadata: { aggregateOnly: true },
    });
    console.log(`   ✅ [Step 4] agenticChat completed in ${Date.now() - agentStart}ms`);
    console.log(`   ──── 🧠 CHAT PIPELINE END ────\n`);

    trace.finalAnswer = result?.aiResponse ?? null;
    trace.durationMs = getTraceDurationMs(trace);
    // Context for smart debug: what data was available (so it can detect "missing profile field" or missing documents)
    trace.profileKeys = Object.keys(userProfile || {});
    trace.numProfileKeys = trace.profileKeys.length;
    trace.documentTypes = (userDocuments || []).map((d) => d?.documentType).filter(Boolean);
    trace.numDocuments = trace.documentTypes.length;

    if (DEBUG_MODE) {
      await smartConsoleAgent(trace);
    }

    let sessionId = null;
    const hasSuggestedFills = Array.isArray(result.suggestedFills) && result.suggestedFills.length > 0;

    if (effectiveUserId && effectiveUserId !== 'anonymous') {
      if (hasSuggestedFills && pageUrl) {
        const session = await createFormSession({
          userId: effectiveUserId,
          pageUrl,
          pageTitle: pageTitle || pageUrl,
          status: 'submitted',
          modelName: 'googleai/gemini-2.5-flash',
          trace,
          mappedFields: result.suggestedFills,
          metadata: {
            message,
            source: 'extension_chat',
          },
        });
        sessionId = String(session.id);

        await logTraceCreditEvents({
          userId: effectiveUserId,
          trace,
          sessionId,
          fallbackEventType: 'form_fill_agent',
          baseMetadata: {
            pageUrl,
            pageTitle: pageTitle || null,
            source: 'extension_chat',
          },
        });

      } else {
        await logTraceCreditEvents({
          userId: effectiveUserId,
          trace,
          fallbackEventType: 'extension_chat_text',
          baseMetadata: {
            pageUrl: pageUrl || null,
            pageTitle: pageTitle || null,
            source: 'extension_chat',
            messagePreview: String(message || '').slice(0, 160),
          },
        });
      }
    }

    const creditsUsed = getTraceCreditsUsed(trace);
    const creditInfo =
      effectiveUserId && effectiveUserId !== 'anonymous'
        ? await buildCreditIndicator(effectiveUserId, creditsUsed)
        : {
            creditsUsed,
            creditsThisMonth: creditsUsed,
            remainingCredits: null,
            monthlyLimit: null,
            message: `${creditsUsed} credits used for this response`,
          };

    // 3. Save to formMappingsCollection if this was a successful autofill
    if (result.suggestedFills && result.suggestedFills.length > 0 && pageUrl && fieldsMinimal && fieldsMinimal.length > 0) {
        try {
            const pageKeyToSave = buildPageKey(pageUrl, pageSignature) || pageUrl;
            
            // Reconstruct the full mapping base: ALL fields, but with mapped values applied
            // This ensures we cache all 9 fields (for example) even if only 4 mapped successfully.
            const fullMappedFields = fieldsMinimal.map(f => {
                const filledMatch = result.suggestedFills.find(sf => 
                    (sf.label && sf.label === f.label) || 
                    (sf.selector_name && sf.selector_name === f.selector_name)
                );
                return filledMatch ? { ...f, suggested_value: filledMatch.suggested_value } : f;
            });
            
            // Check if we need to save. Save if we didn't have cachedFields, 
            // or if we have MORE/BETTER mapped fields now than before.
            const newFillsCount = fullMappedFields.filter(f => f.suggested_value).length;
            const oldFillsCount = (cachedFields || []).filter(cf => cf.suggested_value).length;

            if (!cachedFields || cachedFields.length === 0 || newFillsCount > oldFillsCount) {
                console.log(`   💾 [MongoDB] Saving new/updated mapping for: ${pageKeyToSave} (${fullMappedFields.length} total fields, ${newFillsCount} filled)`);
                
                await formMappingsCollection.updateOne(
                    { page_key: pageKeyToSave },
                    {
                        $set: {
                            page_key: pageKeyToSave,
                            page_url: pageUrl,
                            page_signature: pageSignature || null,
                            userProfile: userProfile, 
                            mappedFields: fullMappedFields,
                            updatedAt: new Date(),
                        },
                        $setOnInsert: {
                            createdAt: new Date()
                        }
                    },
                    { upsert: true }
                );
                console.log(`   ✅ [MongoDB] Form mapping cache saved successfully.`);
            }
        } catch (dbErr) {
            console.error(`   ❌ [MongoDB] Failed to save form mapping cache:`, dbErr.message);
        }
    }

    // 4. Return Response
    res.json({
      aiResponse: result.aiResponse,
      suggestedFills: result.suggestedFills,
      sessionId,
      creditInfo,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat processing failed' });
  }
});

// ─────────────────────────────────────
// DOCUMENT PROCESSING (Genkit Vision)
// ─────────────────────────────────────

app.post('/api/process-document', async (req, res) => {
  try {
    const { fileName, fileDataUri, userId } = req.body;
    const effectiveUserId = resolveCanonicalUserId({ req, explicitUserId: userId }) || userId;
    console.log(`\n   ──── 📄 DOCUMENT PROCESSING PIPELINE START ────`);
    console.log(`   📄 File: ${fileName} | userId: ${effectiveUserId}`);

    if (!fileDataUri || !effectiveUserId) {
      return res.status(400).json({ error: 'Missing fileDataUri or userId' });
    }

    // Run Genkit flow
    console.log(`   📡 [Step 1] Running Genkit document extraction...`);
    const docStart = Date.now();
    const trace = createTrace({ message: `process-document:${fileName}` });
    const docResult = await runAgent({
      trace,
      agentName: 'document_processor',
      input: { fileName, userId: effectiveUserId, fileDataUriLength: fileDataUri?.length || 0 },
      agentFunction: () => processDocument({ fileDataUri }),
      metadata: { fileName, source: 'extension_chat_upload' },
    });
    console.log(`   ✅ [Step 1] Extracted in ${Date.now() - docStart}ms | type: ${docResult.documentType} | section: ${docResult.profileSection}`);

    // Check for duplicates by userId + documentType
    const existingDoc = await userDocumentsCollection.findOne({
      userId: effectiveUserId,
      documentType: docResult.documentType,
    });

    const documentEvents = await logTraceCreditEvents({
      userId: effectiveUserId,
      trace,
      fallbackEventType: 'extension_chat_doc',
      baseMetadata: {
        documentName: fileName,
        documentType: docResult.documentType,
        profileSection: docResult.profileSection,
        source: 'extension_chat_upload',
      },
    });

    const creditsUsed = getTraceCreditsUsed(trace);
    const creditInfo = await buildCreditIndicator(effectiveUserId, creditsUsed);

    if (existingDoc) {
      return res.json({
        duplicate: true,
        documentType: docResult.documentType,
        creditInfo,
      });
    }

    const documentRecord = {
      userId: effectiveUserId,
      name: fileName,
      documentType: docResult.documentType,
      profileSection: docResult.profileSection,
      confidence: docResult.confidence,
      extractedData: docResult.extractedData,
      createdAt: new Date(),
      // fileDataUri,
    };

    await userDocumentsCollection.insertOne(documentRecord);
    await updateUserProfile(effectiveUserId, docResult.extractedData, docResult.profileSection);

    res.json({
      duplicate: false,
      ...documentRecord,
      creditInfo,
    });
  } catch (error) {
    console.error('Document processing error:', error);
    res.status(500).json({ error: 'Document processing failed' });
  }
});

// // ────────────────────────────────────────────────
// // INTELLIGENT FORM FILL (fake → real merge)
// // ────────────────────────────────────────────────

// app.post('/api/intelligent-fill', async (req, res) => {
//   try {
//     const { page_url, page_title, fields, userProfile, userDocuments } = req.body;

//     if (!page_url || !fields) {
//       return res.status(400).json({ error: "Missing 'page_url' or 'fields'" });
//     }

//     // 1) Check cache for fake profile + base mapping
//     let cached = await formMappingsCollection.findOne({ page_url });
//     let fakeProfile;
//     let baseMapping;

//     if (cached) {
//       fakeProfile = cached.userProfile;
//       baseMapping = cached.mappedFields;
//       console.log('✅ Using cached mapping for', page_url);
//     } else {
//       console.log('⚙️ Generating fake profile for', page_url);
//       const generated = await generateFakeProfile(fields, page_url);
//       fakeProfile = generated.userProfile;
//       baseMapping = generated.mappedFields;

//       await formMappingsCollection.updateOne(
//         { page_url },
//         {
//           $set: {
//             page_url,
//             page_title: page_title || null,
//             userProfile: fakeProfile,
//             mappedFields: baseMapping,
//             createdAt: new Date(),
//             updatedAt: new Date(),
//           },
//         },
//         { upsert: true },
//       );
//     }

//     const hasUserData = userProfile && Object.keys(userProfile).length > 0;

//     if (!hasUserData) {
//       // No real user data → return fake mapping
//       return res.json({
//         mappedFields: baseMapping,
//         usedRealData: false,
//       });
//     }

//     // 2) Use Genkit flow to merge real user data into mapping
//     const intelligentResult = await intelligentFill({
//       fields,
//       fakeProfile,
//       baseMapping,
//       realUserProfile: userProfile,
//       userDocuments: userDocuments || [],
//     });

//     res.json({
//       mappedFields: intelligentResult.mappedFields,
//       usedRealData: true,
//     });
//   } catch (error) {
//     console.error('Intelligent fill error:', error);
//     res.status(500).json({ error: 'Intelligent filling failed' });
//   }
// });


app.post('/api/intelligent-fill', async (req, res) => {
  try {
    const { page_url, page_signature, page_title, fields, userDocuments: providedDocs, userId } = req.body;
    console.log(`\n   ──── 🔀 INTELLIGENT-FILL PIPELINE START ────`);

    if (!page_url || !fields) {
      return res.status(400).json({ error: "Missing 'page_url' or 'fields'" });
    }

    console.log("\n\n===================== 🧠 INTELLIGENT-FILL REQUEST =====================");
    console.log("Page URL:", page_url);
    if (page_signature) {
      console.log("Page Signature:", page_signature);
    }
    console.log("Fields Count:", fields.length);
    console.log("User ID:", userId);

    // Fetch real user documents if userId is provided
    console.log(`   📡 [Step 1] Fetching user profile from website backend...`);
    let userDocuments = providedDocs || [];
    let realUserProfile = {};
    let effectiveUserId = resolveCanonicalUserId({ req, explicitUserId: userId }) || 'anonymous';

    const sourceProfile = await fetchProfileFromSource(req);
    if (sourceProfile?.resolvedUserId) {
        effectiveUserId = sourceProfile.resolvedUserId;
        realUserProfile = sourceProfile.profile || {};
        if (sourceProfile.documents && sourceProfile.documents.length > 0) {
            userDocuments = [...userDocuments, ...sourceProfile.documents];
            console.log(`📚 Found ${sourceProfile.documents.length} verified docs from website backend`);
        }
        console.log(`👤 Using profile source for user ${effectiveUserId} (Keys: ${Object.keys(realUserProfile).length})`);
    }

    if (!sourceProfile && effectiveUserId && effectiveUserId !== 'anonymous') {
        try {
            // Fetch docs from MongoDB (fallback)
            const dbDocs = await userDocumentsCollection.find({ userId: effectiveUserId }).toArray();
            if (dbDocs.length > 0) {
                userDocuments = [...userDocuments, ...dbDocs];
                console.log(`📚 Fetched ${dbDocs.length} documents from DB for user ${effectiveUserId}`);
            }

            // Fetch profile from MongoDB (fallback)
            const dbProfile = await userProfilesCollection.findOne({ userId: effectiveUserId });
            if (dbProfile && dbProfile.profile) {
                realUserProfile = dbProfile.profile;
                console.log(`👤 Fetched profile from DB for user ${effectiveUserId}`);
            }
        } catch (err) {
            console.error("Error fetching user data:", err);
        }
    }

    console.log("Real Docs Available:", userDocuments.length);
    console.log("Real Profile Keys:", Object.keys(realUserProfile).length);

    const trace = createTrace({ message: `intelligent-fill:${page_title || page_url}` });


    // 1) CHECK CACHE
    console.log(`   📡 [Step 2] Checking formMappings cache...`);
    const { pageKey, cached } = await findCachedMapping(page_url, page_signature);

    // -------------------------
    // CASE 1: CACHE EXISTS
    // -------------------------
    if (cached) {
      console.log(`   ✅ [Step 2] Cache HIT — fake profile + mapping found in DB`);
    }

    // -------------------------
    // CASE 2: NO CACHE → GENERATE
    // -------------------------
    let fakeProfile, baseMapping;

    if (!cached) {
      console.log(`   ⚠️ [Step 2] Cache MISS`);
      console.log(`   📡 [Step 3] Generating new fake profile via Genkit AI...`);

      const generated = await runAgent({
        trace,
        agentName: 'fake_profile_generator',
        input: { page_url, page_signature, page_title, fieldCount: fields.length },
        agentFunction: () => generateFakeProfile(fields, page_url),
        metadata: { source: 'intelligent_fill', cacheMiss: true },
      });
      fakeProfile = generated.userProfile;
      baseMapping = generated.mappedFields;

      await formMappingsCollection.updateOne(
        { page_key: pageKey },
        {
          $set: {
            page_key: pageKey,
            page_url,
            page_signature: page_signature || null,
            page_title: page_title || null,
            userProfile: fakeProfile,
            mappedFields: baseMapping,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
      console.log("💾 Saved NEW fake profile + mapping to DB");

    } else {
      fakeProfile = cached.userProfile;
      baseMapping = cached.mappedFields;
    }

    // -------------------------
    // NO REAL USER DATA → RETURN BASE FAKE MAP
    // -------------------------
    const hasRealData = userDocuments.length > 0 || Object.keys(realUserProfile).length > 0;

    if (!hasRealData) {
      console.log("\n⚠️ No real profile/documents found → USING FAKE MAPPING ONLY\n");
      return res.json({
        mappedFields: baseMapping,
        usedRealData: false,
      });
    }

    // -------------------------
    // MERGE REAL DATA (Genkit)
    // -------------------------
    console.log(`   � [Step 4] Running Genkit intelligent-fill to merge REAL data...`);
    console.log(`   📊 [Context] profileKeys: ${Object.keys(realUserProfile).length} | docs: ${userDocuments.length} | formFields: ${fields.length}`);

    const intelligentResult = await runAgent({
      trace,
      agentName: 'intelligent_fill_merger',
      input: {
        page_url,
        page_signature,
        page_title,
        fieldCount: fields.length,
        realProfileKeys: Object.keys(realUserProfile).length,
        documentCount: userDocuments.length,
      },
      agentFunction: () =>
        intelligentFill({
          fields,
          fakeProfile,
          baseMapping,
          realUserProfile: realUserProfile,
          userDocuments: userDocuments,
        }),
      metadata: { source: 'intelligent_fill', cacheHit: Boolean(cached) },
    });

    console.log(`   ✅ [Step 4] Merge completed`);
    console.log(`   ──── 🔀 INTELLIGENT-FILL PIPELINE END ────\n`);

    let sessionId = null;
    if (effectiveUserId && effectiveUserId !== 'anonymous') {
      const session = await createFormSession({
        userId: effectiveUserId,
        pageUrl: page_url,
        pageTitle: page_title || page_url,
        status: 'submitted',
        modelName: 'googleai/gemini-2.5-flash',
        trace,
        mappedFields: intelligentResult.mappedFields,
        metadata: {
          source: 'intelligent_fill',
          usedRealData: true,
          cacheHit: Boolean(cached),
        },
      });
      sessionId = String(session.id);

      await logTraceCreditEvents({
        userId: effectiveUserId,
        trace,
        sessionId,
        fallbackEventType: 'form_fill_agent',
        baseMetadata: {
          pageUrl: page_url,
          pageTitle: page_title || null,
          source: 'intelligent_fill',
        },
      });

    }

    const creditsUsed = getTraceCreditsUsed(trace);
    const creditInfo =
      effectiveUserId && effectiveUserId !== 'anonymous'
        ? await buildCreditIndicator(effectiveUserId, creditsUsed)
        : {
            creditsUsed,
            creditsThisMonth: creditsUsed,
            remainingCredits: null,
            monthlyLimit: null,
            message: `${creditsUsed} credits used for this response`,
          };

    res.json({
      mappedFields: intelligentResult.mappedFields,
      usedRealData: true,
      sessionId,
      creditInfo,
    });

  } catch (error) {
    console.error("❌ Intelligent fill error:", error);
    res.status(500).json({ error: "Intelligent filling failed" });
  }
});

// ─────────────────────────────
// ORIGINAL AUTO-MAP (FAKE ONLY)
// ─────────────────────────────
// new with debug logs
app.post('/api/auto-map', async (req, res) => {
  try {
    const { page_url, page_signature, fields } = req.body;

    if (!page_url || !fields) {
      return res.status(400).json({ error: "Missing 'page_url' or 'fields'" });
    }

    console.error("\n\n===================== 📦 AUTO-MAP REQUEST =====================");
    console.error("Page URL:", page_url);
    if (page_signature) {
      console.error("Page Signature:", page_signature);
    }
    console.error("Fields Count:", fields.length);

    const { pageKey, cached: cachedMapping } = await findCachedMapping(page_url, page_signature);

    if (cachedMapping) {
      console.error("📦 CACHE HIT → Returning existing fake mapping");

      console.log("\n📌 Fake Profile (first 6 keys):");
      Object.entries(cachedMapping.userProfile || {})
        .slice(0, 6)
        .forEach(([k, v]) => console.log(`   ${k}: ${v}`));

      console.log("\n📌 Fake Mapped Fields (first 5 rows):");
      cachedMapping.mappedFields.slice(0, 5).forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.label} → ${f.suggested_value}`);
      });

      return res.json({
        userProfile: cachedMapping.userProfile,
        mappedFields: cachedMapping.mappedFields,
        cached: true,
      });
    }

    // No cache → generate new fake mapping
    console.error("❌ No cache found → generating new fake profile + mapping");

    const generated = await generateFakeProfile(fields, page_url);

    const mappingDocument = {
      page_key: pageKey,
      page_url,
      page_signature: page_signature || null,
      userProfile: generated.userProfile,
      mappedFields: generated.mappedFields,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("\n✨ New Fake Profile (first 6 keys):");
    Object.entries(generated.userProfile)
      .slice(0, 6)
      .forEach(([k, v]) => console.log(`   ${k}: ${v}`));

    console.log("\n✨ New Fake Mapping (first 5 rows):");
    generated.mappedFields.slice(0, 5).forEach((f, i) => {
      console.log(`   ${i + 1}. ${f.label} → ${f.suggested_value}`);
    });

    await formMappingsCollection.updateOne(
      { page_key: pageKey },
      { $set: mappingDocument },
      { upsert: true }
    );

    return res.json({
      userProfile: generated.userProfile,
      mappedFields: generated.mappedFields,
      cached: false,
    });

  } catch (err) {
    console.error("❌ Error in auto-map:", err.message);
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
});


// old without debug logs *******************
// app.post('/api/auto-map', async (req, res) => {
//   try {
//     const { page_url, fields } = req.body;

//     if (!page_url || !fields) {
//       return res.status(400).json({ error: "Missing 'page_url' or 'fields'" });
//     }

//     const cachedMapping = await formMappingsCollection.findOne({ page_url });

//     if (cachedMapping) {
//       console.log('✅ Cached mapping found for:', page_url);
//       return res.json({
//         userProfile: cachedMapping.userProfile,
//         mappedFields: cachedMapping.mappedFields,
//         cached: true,
//       });
//     }

//     console.log('⚙️ Generating new mapping for:', page_url);
//     const generated = await generateFakeProfile(fields, page_url);

//     const mappingDocument = {
//       page_url,
//       userProfile: generated.userProfile,
//       mappedFields: generated.mappedFields,
//       createdAt: new Date(),
//       updatedAt: new Date(),
//     };

//     await formMappingsCollection.updateOne(
//       { page_url },
//       { $set: mappingDocument },
//       { upsert: true },
//     );

//     console.log('✅ Mapping saved to MongoDB for:', page_url);

//     return res.json({
//       userProfile: generated.userProfile,
//       mappedFields: generated.mappedFields,
//       cached: false,
//     });
//   } catch (err) {
//     console.error('❌ Error in auto-map:', err.message);
//     return res.status(500).json({ error: `Server error: ${err.message}` });
//   }
// });

// ─────────────────────────────
// USER DOCUMENTS ENDPOINTS
// ─────────────────────────────

app.get('/api/user/:userId/documents', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`   📡 [MongoDB] Reading userDocuments for userId: ${userId}`);
    const documents = await userDocumentsCollection.find({ userId }).toArray();
    console.log(`   ✅ [MongoDB] Found ${documents.length} documents`);
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

app.delete('/api/user/:userId/document/:documentId', async (req, res) => {
  try {
    const { userId, documentId } = req.params;
    console.log(`   🗑️ [MongoDB] Deleting document ${documentId} for userId: ${userId}`);
    await userDocumentsCollection.deleteOne({ userId, _id: new ObjectId(documentId) });
    console.log(`   ✅ [MongoDB] Document deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ─────────────────────────────
// USER PROFILE HELPER
// ─────────────────────────────

async function updateUserProfile(userId, extractedData, profileSection) {
  try {
    // 1. Fetch existing profile
    const existingDoc = await userProfilesCollection.findOne({ userId });
    const existingProfile = existingDoc?.profile || {};
    
    let updatedSectionData;

    // 2. Determine merge strategy based on section
    if (['education', 'career'].includes(profileSection)) {
      // --- ARRAY STRATEGY (Append) ---
      const currentSection = existingProfile[profileSection];
      
      if (Array.isArray(currentSection)) {
        // Already an array -> Append
        updatedSectionData = [...currentSection, extractedData];
      } else if (currentSection) {
        // Legacy: Single object -> Convert to Array
        updatedSectionData = [currentSection, extractedData];
      } else {
        // New -> Create Array
        updatedSectionData = [extractedData];
      }
      
      console.log(`[PROFILE UPDATE] Appending to ${profileSection} array for user ${userId}`);

    } else {
      // --- OBJECT STRATEGY (Merge) ---
      // identity, financial, other -> Merge fields
      const currentSection = existingProfile[profileSection] || {};
      updatedSectionData = { ...currentSection, ...extractedData };
      
      console.log(`[PROFILE UPDATE] Merging ${profileSection} object for user ${userId}`);
    }

    // 3. Update MongoDB
    const update = {};
    update[`profile.${profileSection}`] = updatedSectionData;

    await userProfilesCollection.updateOne(
      { userId },
      {
        $set: update,
        $currentDate: { lastUpdated: true },
      },
      { upsert: true },
    );
    
    console.log(`✅ User profile updated for ${userId} [${profileSection}]`);

  } catch (error) {
    console.error(`❌ Error updating user profile for ${userId}:`, error);
  }
}

// ─────────────────────────────
// START SERVER
// ─────────────────────────────

app.listen(port, () => {
  console.log(`🚀 Genkit FormFlow server running on http://localhost:${port}`);
  console.log('📝 Available endpoints:');
  console.log('   GET  /health');
  console.log('   POST /api/chat');
  console.log('   POST /api/process-document');
  console.log('   POST /api/intelligent-fill');
  console.log('   POST /api/auto-map');
  console.log('   GET  /api/user/:userId/documents');
  console.log('   DELETE /api/user/:userId/document/:documentId');
});









// ********************************  first one *****************************8


// import express from 'express';
// import { GoogleGenerativeAI } from '@google/generative-ai';
// import cors from 'cors';
// import { MongoClient } from 'mongodb';
// import multer from 'multer';
// import 'dotenv/config';

// const app = express();
// const port = 4000;

// // Middleware
// app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
// app.use(express.json({ limit: '50mb' })); // Increase limit for base64 files

// // Initialize Gemini AI
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
// const chatModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// // MongoDB Configuration
// const MONGODB_URI = process.env.MONGODB_URI || 'your-mongodb-atlas-connection-string';
// const DB_NAME = 'formAutofill';

// let db;
// let formMappingsCollection;
// let userDocumentsCollection;
// let userProfilesCollection;

// // Connect to MongoDB
// async function connectToMongoDB() {
//   try {
//     const client = new MongoClient(MONGODB_URI);
//     await client.connect();
//     console.log('✅ Connected to MongoDB Atlas');
    
//     db = client.db(DB_NAME);
//     formMappingsCollection = db.collection('formMappings');
//     userDocumentsCollection = db.collection('userDocuments');
//     userProfilesCollection = db.collection('userProfiles');
    
//     // Create indexes
//     await formMappingsCollection.createIndex({ page_url: 1 }, { unique: true });
//     await userDocumentsCollection.createIndex({ userId: 1, documentType: 1 });
//     await userProfilesCollection.createIndex({ userId: 1 }, { unique: true });
    
//   } catch (error) {
//     console.error('❌ MongoDB connection error:', error.message);
//     process.exit(1);
//   }
// }

// // Initialize MongoDB connection
// await connectToMongoDB();

// // Health endpoint
// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'ok', 
//     uptime: process.uptime(), 
//     time: new Date().toISOString(),
//     database: db ? 'connected' : 'disconnected'
//   });
// });

// // ============ CHAT ENDPOINT ============
// app.post('/api/chat', async (req, res) => {
//   try {
//     const { message, chatHistory, userProfile, documents } = req.body;
    
//     // Build conversation context
//     const context = {
//       userProfile: userProfile || {},
//       documents: documents || [],
//       chatHistory: chatHistory || []
//     };
    
//     const prompt = `
// You are FormFlow AI, a friendly and intelligent assistant helping users manage their documents and auto-fill forms.

// Current User Profile:
// ${JSON.stringify(context.userProfile, null, 2)}

// User's Uploaded Documents:
// ${JSON.stringify(context.documents.map(d => ({
//   type: d.documentType,
//   name: d.name,
//   extractedData: d.extractedData
// })), null, 2)}

// Conversation History:
// ${context.chatHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n')}

// User: ${message}

// Instructions:
// 1. If the user is greeting or making casual conversation, respond naturally and friendly.
// 2. If the user asks about their documents or profile, provide helpful information based on the data above.
// 3. If the user mentions updating their profile (like "I moved to Mumbai" or "My new phone is 9876543210"), extract and return the updated fields.
// 4. Be concise and helpful.

// Response format:
// {
//   "aiResponse": "Your natural language response here",
//   "updatedProfile": { 
//     // Only include if user wants to update profile
//     "identity": { "field": "value" }
//   }
// }
// `;

//     const result = await chatModel.generateContent(prompt);
//     const response = result.response.text();
    
//     // Parse AI response
//     let parsedResponse;
//     try {
//       // Try to extract JSON from response
//       const jsonMatch = response.match(/\{[\s\S]*\}/);
//       if (jsonMatch) {
//         parsedResponse = JSON.parse(jsonMatch[0]);
//       } else {
//         parsedResponse = { aiResponse: response };
//       }
//     } catch (e) {
//       parsedResponse = { aiResponse: response };
//     }
    
//     res.json(parsedResponse);
    
//   } catch (error) {
//     console.error('Chat error:', error);
//     res.status(500).json({ error: 'Chat processing failed' });
//   }
// });

// // ============ DOCUMENT PROCESSING ENDPOINT ============
// app.post('/api/process-document', async (req, res) => {
//   try {
//     const { fileName, fileDataUri, userId } = req.body;
    
//     if (!fileDataUri || !userId) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }
    
//     // Extract base64 data
//     const base64Data = fileDataUri.split(',')[1];
    
//     // Process with Gemini Vision
//     const prompt = `
// Analyze this document and extract all information. Identify the document type precisely.

// Tasks:
// 1. Identify the specific document type (e.g., "Aadhaar Card", "Resume", "PAN Card", "10th Marksheet", "12th Marksheet", "Degree Certificate")
// 2. Extract ALL text and data as key-value pairs
// 3. Categorize into profile section: identity, education, career, financial, or other
// 4. Provide confidence score (0-1)

// Return ONLY a JSON object with this structure:
// {
//   "documentType": "specific type",
//   "profileSection": "section name",
//   "confidence": 0.95,
//   "extractedData": {
//     "field1": "value1",
//     "field2": "value2"
//   }
// }`;

//     const image = {
//       inlineData: {
//         data: base64Data,
//         mimeType: fileDataUri.split(';')[0].split(':')[1]
//       }
//     };
    
//     const result = await model.generateContent([prompt, image]);
//     const response = result.response.text();
    
//     // Parse the response
//     let documentData;
//     try {
//       const jsonMatch = response.match(/\{[\s\S]*\}/);
//       documentData = JSON.parse(jsonMatch[0]);
//     } catch (e) {
//       console.error('Failed to parse Gemini response:', response);
//       throw new Error('Failed to parse document');
//     }
    
//     // Check for duplicates
//     const existingDoc = await userDocumentsCollection.findOne({
//       userId,
//       documentType: documentData.documentType
//     });
    
//     if (existingDoc) {
//       return res.json({
//         duplicate: true,
//         documentType: documentData.documentType
//       });
//     }
    
//     // Store in MongoDB
//     const documentRecord = {
//       userId,
//       name: fileName,
//       documentType: documentData.documentType,
//       profileSection: documentData.profileSection,
//       confidence: documentData.confidence,
//       extractedData: documentData.extractedData,
//       createdAt: new Date(),
//       fileDataUri: fileDataUri // Store the file data
//     };
    
//     await userDocumentsCollection.insertOne(documentRecord);
    
//     // Update user profile with extracted data
//     await updateUserProfile(userId, documentData.extractedData, documentData.profileSection);
    
//     res.json({
//       duplicate: false,
//       ...documentRecord
//     });
    
//   } catch (error) {
//     console.error('Document processing error:', error);
//     res.status(500).json({ error: 'Document processing failed' });
//   }
// });

// // ============ INTELLIGENT FORM FILLING ENDPOINT ============
// app.post('/api/intelligent-fill', async (req, res) => {
//   try {
//     const { page_url, fields, userProfile, userDocuments } = req.body;
    
//     // Check cache first
//     const cachedMapping = await formMappingsCollection.findOne({ page_url });
    
//     let fakeProfile = {};
//     let baseMapping = [];
    
//     if (cachedMapping) {
//       fakeProfile = cachedMapping.userProfile;
//       baseMapping = cachedMapping.mappedFields;
//     } else {
//       // Generate fake profile if not cached
//       const generated = await generateFakeProfile(fields, page_url);
//       fakeProfile = generated.userProfile;
//       baseMapping = generated.mappedFields;
      
//       // Cache it
//       await formMappingsCollection.updateOne(
//         { page_url },
//         { 
//           $set: {
//             page_url,
//             userProfile: fakeProfile,
//             mappedFields: baseMapping,
//             createdAt: new Date()
//           }
//         },
//         { upsert: true }
//       );
//     }
    
//     // Now use AI to replace fake values with real user data
//     const hasUserData = userProfile && Object.keys(userProfile).length > 0;
    
//     if (!hasUserData) {
//       // No user data, return fake profile
//       return res.json({
//         mappedFields: baseMapping,
//         usedRealData: false
//       });
//     }
    
//     // Use Gemini to intelligently replace fake values with real user values
//     const prompt = `
// You are an intelligent form filling assistant. Your task is to replace fake profile values with real user data.

// Form Fields to Fill:
// ${JSON.stringify(fields, null, 2)}

// Fake Profile (current mapping):
// ${JSON.stringify(fakeProfile, null, 2)}

// Real User Profile:
// ${JSON.stringify(userProfile, null, 2)}

// User's Documents Data:
// ${JSON.stringify(userDocuments.map(d => ({
//   type: d.documentType,
//   data: d.extractedData
// })), null, 2)}

// Current Field Mappings:
// ${JSON.stringify(baseMapping, null, 2)}

// Instructions:
// 1. For each field in the mapping, check if real user data exists
// 2. Replace fake values with real user values when available
// 3. Use document data to fill additional fields
// 4. Ensure dates are in correct format (DD/MM/YYYY or as required)
// 5. Keep fake values for fields where no real data exists
// 6. Return the updated mappings array

// Return ONLY a JSON object with structure:
// {
//   "mappedFields": [
//     {
//       "label": "field label",
//       "suggested_value": "real or fake value",
//       "selector_id": "...",
//       "selector_name": "...",
//       "selector_css": "...",
//       "status": "ready",
//       "input_type": "...",
//       "tag_name": "..."
//     }
//   ]
// }`;

//     const result = await chatModel.generateContent(prompt);
//     const response = result.response.text();
    
//     let intelligentMapping;
//     try {
//       const jsonMatch = response.match(/\{[\s\S]*\}/);
//       intelligentMapping = JSON.parse(jsonMatch[0]);
//     } catch (e) {
//       console.error('Failed to parse mapping response');
//       return res.json({
//         mappedFields: baseMapping,
//         usedRealData: false
//       });
//     }
    
//     res.json({
//       mappedFields: intelligentMapping.mappedFields,
//       usedRealData: true
//     });
    
//   } catch (error) {
//     console.error('Intelligent fill error:', error);
//     res.status(500).json({ error: 'Intelligent filling failed' });
//   }
// });

// // ============ HELPER FUNCTIONS ============
// async function generateFakeProfile(fields, page_url) {
//   const prompt = `
// You are a form-understanding AI that generates realistic Indian applicant data and a mapping for an autofill extension.

// Given:
// - The extracted form field JSON (each field has label, selector_id, selector_name, input_type, etc.)
// - The current page URL: ${page_url}

// Produce TWO things in JSON:
// 1️⃣ userProfile — a realistic, Indian-style applicant profile suitable for this form (names, DOB, email, mobile, etc.).
// 2️⃣ mappedFields — array of objects matching each field label to the correct value from userProfile. Each object must include:
//    - label
//    - suggested_value
//    - selector_id / selector_name / selector_css (copy from input JSON)
//    - status ("ready" if filled, "empty" otherwise)
//    - input_type, tag_name, options (if any)

// Rules:
// - All data must look authentically Indian.
// - Full names, father/mother names, etc. should be in Indian context.
// - Use "Ramesh Sharma", "Mahesh Sharma", "Sunita Sharma", "India", realistic mobile/email.
// - Use Indian date format DD/MM/YYYY or DD-MM-YYYY as needed.
// - Match dropdowns exactly (return option text that exists).
// - Do not output explanations — only the final JSON object.

// Example Output:
// {
//   "userProfile": {
//     "fullName": "Ramesh Sharma",
//     "dob": "15/08/1996",
//     "gender": "Male",
//     "fatherName": "Mahesh Sharma",
//     "motherName": "Sunita Sharma",
//     "email": "ramesh.sharma96@gmail.com",
//     "mobileNumber": "9876543210",
//     "password": "SecurePassword@2025",
//     "confirmPassword": "SecurePassword@2025"
//   },
//   "mappedFields": [
//     { "label": "Full Name", "suggested_value": "Ramesh Sharma" },
//     { "label": "Date of Birth", "suggested_value": "15/08/1996" },
//     { "label": "Gender", "suggested_value": "Male" }
//   ]
// }

// Now create the output for this form:
// ${JSON.stringify(fields, null, 2)}`;

//   const result = await chatModel.generateContent(prompt);
//   const response = result.response.text();
  
//   const jsonMatch = response.match(/\{[\s\S]*\}/);
//   return JSON.parse(jsonMatch[0]);
// }

// async function updateUserProfile(userId, extractedData, profileSection) {
//   const update = {};
//   update[`profile.${profileSection}`] = extractedData;
  
//   await userProfilesCollection.updateOne(
//     { userId },
//     { 
//       $set: update,
//       $currentDate: { lastUpdated: true }
//     },
//     { upsert: true }
//   );
// }

// // ============ USER DOCUMENTS ENDPOINTS ============
// app.get('/api/user/:userId/documents', async (req, res) => {
//   try {
//     const { userId } = req.params;
//     const documents = await userDocumentsCollection.find({ userId }).toArray();
//     res.json(documents);
//   } catch (error) {
//     console.error('Error fetching documents:', error);
//     res.status(500).json({ error: 'Failed to fetch documents' });
//   }
// });

// app.delete('/api/user/:userId/document/:documentId', async (req, res) => {
//   try {
//     const { userId, documentId } = req.params;
//     await userDocumentsCollection.deleteOne({ 
//       userId, 
//       _id: new ObjectId(documentId) 
//     });
//     res.json({ success: true });
//   } catch (error) {
//     console.error('Error deleting document:', error);
//     res.status(500).json({ error: 'Failed to delete document' });
//   }
// });

// // ============ ORIGINAL AUTO-MAP ENDPOINT (KEEP AS IS) ============
// app.post("/api/auto-map", async (req, res) => {
//   try {
//     const { page_url, fields } = req.body;

//     if (!page_url || !fields) {
//       return res.status(400).json({ error: "Missing 'page_url' or 'fields'" });
//     }

//     // Check cache first
//     const cachedMapping = await formMappingsCollection.findOne({ page_url });
    
//     if (cachedMapping) {
//       console.log("✅ Cached mapping found for:", page_url);
//       return res.json({ 
//         userProfile: cachedMapping.userProfile,
//         mappedFields: cachedMapping.mappedFields,
//         cached: true 
//       });
//     }

//     // Generate new mapping
//     console.log("⚙️ Generating new mapping for:", page_url);
//     const generated = await generateFakeProfile(fields, page_url);

//     // Store in MongoDB
//     const mappingDocument = {
//       page_url,
//       userProfile: generated.userProfile,
//       mappedFields: generated.mappedFields,
//       createdAt: new Date(),
//       updatedAt: new Date()
//     };

//     await formMappingsCollection.updateOne(
//       { page_url },
//       { $set: mappingDocument },
//       { upsert: true }
//     );

//     console.log("✅ Mapping saved to MongoDB for:", page_url);

//     return res.json({ 
//       userProfile: generated.userProfile,
//       mappedFields: generated.mappedFields,
//       cached: false 
//     });

//   } catch (err) {
//     console.error("❌ Error in auto-map:", err.message);
//     return res.status(500).json({ error: `Server error: ${err.message}` });
//   }
// });

// // Start server
// app.listen(port, () => {
//   console.log(`🚀 Enhanced FormFlow server running on http://localhost:${port}`);
//   console.log('📝 Available endpoints:');
//   console.log('   POST /api/chat - Chat with AI assistant');
//   console.log('   POST /api/process-document - Process and extract document data');
//   console.log('   POST /api/intelligent-fill - Fill forms with real user data');
//   console.log('   POST /api/auto-map - Generate fake profile (original)');
//   console.log('   GET  /api/user/:userId/documents - Get user documents');
// });
