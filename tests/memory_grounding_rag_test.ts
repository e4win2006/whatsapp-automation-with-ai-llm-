import { JarvisDatabase, DEFAULT_CONTACT_PERMISSIONS } from '../server/database/database';
import { RagManager, MemoryEvidence } from '../server/ai/ragManager';
import { MemoryGuard } from '../server/whatsapp/memoryGuard';
import { PrivacyGuard } from '../server/whatsapp/privacyGuard';
import fs from 'fs';
import path from 'path';

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, details?: any) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    if (details) {
      console.error('     Details:', JSON.stringify(details, null, 2));
    }
  }
}

async function runMemoryGroundingRagTests() {
  console.log('===============================================================');
  console.log('🚀 RUNNING SELF-REFLECTIVE RAG & MEMORY GROUNDING TEST SUITE');
  console.log('===============================================================\n');

  const testDbPath = path.join(__dirname, 'test_memory_grounding.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const db = new JarvisDatabase(testDbPath);
  const rag = new RagManager(db);

  const contactA = '919876543210@c.us';
  const contactB = '919123456789@c.us';

  db.upsertContact({
    id: contactA,
    name: 'Rahul',
    is_approved: true,
    ai_enabled: true,
    rag_enabled: true,
    memory_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });

  db.upsertContact({
    id: contactB,
    name: 'Anjali',
    is_approved: true,
    ai_enabled: true,
    rag_enabled: true,
    memory_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // -------------------------------------------------------------
  // TEST 1: Intent Classification & Temporal Reference Extraction
  // -------------------------------------------------------------
  console.log('👉 TEST 1: Memory Intent & Temporal Reference Classification');
  const recallQueries = [
    'Innale namal antha karyam paranjarun',
    'yesterday what did we discuss?',
    'last week what was that thing you told me?',
    'munpe paranjarunna project details onnu para',
    'what did I say earlier today?'
  ];

  for (const q of recallQueries) {
    const classification = rag.classifyMemoryIntent(q);
    assert(
      classification.isMemoryRecall === true,
      `Detected recall intent for: "${q}"`
    );
  }

  const normalQuery = 'Hi da, how are you doing?';
  const normalClassification = rag.classifyMemoryIntent(normalQuery);
  assert(
    normalClassification.isMemoryRecall === false,
    `Normal chit-chat correctly flagged as non-recall: "${normalQuery}"`
  );

  // -------------------------------------------------------------
  // TEST 2: Memory Exists (Yesterday Discussion)
  // -------------------------------------------------------------
  console.log('\n👉 TEST 2: Memory Exists -> Retrieval Confirmed & Grounded');
  rag.indexMessage(contactA, 'msg_001', 'incoming', 'Tomorrow let us discuss the final year college project submission', oneDayAgo);
  rag.indexMessage(contactA, 'msg_002', 'outgoing', 'Sure da, we will review the project report tomorrow', oneDayAgo);

  const recallResult = rag.retrieveContext(contactA, 'Innale namal antha karyam paranjarun', 8);

  assert(
    recallResult.memoryEvidence.status === 'CONFIRMED',
    'Memory evidence status is CONFIRMED when relevant topic exists'
  );
  assert(
    recallResult.memoryEvidence.relevantResultCount > 0,
    `Relevant results count > 0 (found ${recallResult.memoryEvidence.relevantResultCount})`
  );
  assert(
    recallResult.memoryEvidence.confidence >= 0.7,
    `Evidence confidence is high (confidence: ${recallResult.memoryEvidence.confidence})`
  );
  assert(
    recallResult.formattedContext.includes('college project submission'),
    'Injected RAG context includes specific topic details'
  );

  // Guard check when evidence exists
  const aiSupportedResponse = 'Aah, college project karyam alle paranje? Report submission ready aayo?';
  const guardSupported = MemoryGuard.validatePostAiMemoryClaims(
    aiSupportedResponse,
    recallResult.memoryEvidence,
    'Innale namal antha karyam paranjarun'
  );
  assert(
    guardSupported.action === 'ALLOW',
    'MemoryGuard allows claim when memory evidence is CONFIRMED'
  );

  // -------------------------------------------------------------
  // TEST 3: Memory Does NOT Exist (Unrelated Chit-Chat Only)
  // -------------------------------------------------------------
  console.log('\n👉 TEST 3: resultCount ≠ relevantResultCount (Chit-Chat Rejection & UNKNOWN Status)');
  // Contact C only had chit-chat
  const contactC = '919999988888@c.us';
  db.upsertContact({
    id: contactC,
    name: 'Suresh',
    is_approved: true,
    ai_enabled: true,
    rag_enabled: true,
    memory_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });

  rag.indexMessage(contactC, 'msg_c1', 'incoming', 'Good night da', oneDayAgo);
  rag.indexMessage(contactC, 'msg_c2', 'outgoing', 'Good night, sleep well', oneDayAgo);

  const missingResult = rag.retrieveContext(contactC, 'Innale namal antha karyam paranjarun', 8);

  assert(
    missingResult.memoryEvidence.status === 'UNKNOWN',
    'Memory evidence status is UNKNOWN when only irrelevant chit-chat exists'
  );
  assert(
    missingResult.memoryEvidence.relevantResultCount === 0,
    'relevantResultCount is strictly 0 even if DB matched candidate tokens'
  );

  // Test Guard intercepting hallucinated memory
  const aiHallucinatedResponse = 'Sure bro, innale discuss cheytha karyam aanu. Njan orkunnu!';
  const guardBlocked = MemoryGuard.validatePostAiMemoryClaims(
    aiHallucinatedResponse,
    missingResult.memoryEvidence,
    'Innale namal antha karyam paranjarun'
  );

  assert(
    guardBlocked.action === 'BLOCK_AND_REGENERATE',
    'MemoryGuard intercepts unsupported memory claims when status is UNKNOWN'
  );
  assert(
    guardBlocked.filteredReply.includes('eth karyama') || guardBlocked.filteredReply.includes('clarify') || guardBlocked.filteredReply.includes('orma'),
    `Safely falls back to clarification: "${guardBlocked.filteredReply}"`
  );

  // -------------------------------------------------------------
  // TEST 4: Contact Namespace Isolation
  // -------------------------------------------------------------
  console.log('\n👉 TEST 4: Contact Namespace Isolation');
  // Contact B discussed movies yesterday
  rag.indexMessage(contactB, 'msg_b1', 'incoming', 'Innale movie ticket book cheytho?', oneDayAgo);
  rag.indexMessage(contactB, 'msg_b2', 'outgoing', 'Aah book cheythu', oneDayAgo);

  // Query Contact B for yesterday's conversation
  const contactBResult = rag.retrieveContext(contactB, 'Innale namal antha karyam paranjarun', 8);

  assert(
    contactBResult.formattedContext.includes('movie ticket'),
    'Contact B retrieval contains Contact B\'s movie discussion'
  );
  assert(
    !contactBResult.formattedContext.includes('college project'),
    'Contact B retrieval strictly isolates Contact A\'s college project memory'
  );

  // -------------------------------------------------------------
  // TEST 5: RAG Disabled Safety Gating
  // -------------------------------------------------------------
  console.log('\n👉 TEST 5: RAG Disabled Safety Gating');
  const disabledEvidence: MemoryEvidence = {
    available: false,
    relevant: false,
    status: 'UNKNOWN',
    confidence: 0,
    resultCount: 0,
    relevantResultCount: 0,
    bestSimilarity: 0,
    generationPolicy: 'DO_NOT_CLAIM_MEMORY',
    contextIds: []
  };

  const riskyReply = 'Yes, yesterday we talked about your car repair.';
  const disabledGuard = MemoryGuard.validatePostAiMemoryClaims(
    riskyReply,
    disabledEvidence,
    'Did we talk yesterday?'
  );

  assert(
    disabledGuard.action === 'BLOCK_AND_REGENERATE',
    'MemoryGuard blocks false memory claim even when RAG is disabled'
  );

  // Clean up
  db.close();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  console.log('\n===============================================================');
  console.log(`📊 RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('===============================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runMemoryGroundingRagTests().catch((err) => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
