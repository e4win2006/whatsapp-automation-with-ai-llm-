import dotenv from 'dotenv';
dotenv.config();

import { GroqProvider } from '../server/ai/groqProvider';
import { GeminiProvider } from '../server/ai/geminiProvider';
import { FailoverAiProvider } from '../server/ai/failoverProvider';
import { db } from '../server/database/database';
import { config } from '../server/core/config';

async function checkAllApiConnections() {
  console.log('================================================================');
  console.log('🔍 JARVIS API CONNECTIONS & HEALTH CHECK');
  console.log('================================================================\n');

  // 1. Check Groq API Connection
  console.log('--- 1. Testing Groq API Connection ---');
  const groqStartTime = Date.now();
  try {
    const groq = new GroqProvider();
    const resGroq = await groq.generateResponse({
      contactName: 'API Diagnostic',
      contactId: 'diagnostic@c.us',
      messages: ['Ping JARVIS for API health test.'],
      triggerType: 'wake_phrase'
    });
    console.log(`✅ [GROQ API CONNECTED]`);
    console.log(`   Model: ${resGroq.model}`);
    console.log(`   Latency: ${resGroq.latencyMs} ms`);
    console.log(`   Sample Reply: "${resGroq.reply}"`);
  } catch (err: any) {
    console.error(`❌ [GROQ API FAILED]: ${err.message}`);
  }

  console.log('\n--- 2. Testing Gemini API Connection ---');
  try {
    const gemini = new GeminiProvider();
    const resGemini = await gemini.generateResponse({
      contactName: 'API Diagnostic',
      contactId: 'diagnostic@c.us',
      messages: ['Ping JARVIS for API health test.'],
      triggerType: 'wake_phrase'
    });
    console.log(`✅ [GEMINI API CONNECTED]`);
    console.log(`   Model: ${resGemini.model}`);
    console.log(`   Latency: ${resGemini.latencyMs} ms`);
    console.log(`   Sample Reply: "${resGemini.reply}"`);
  } catch (err: any) {
    console.error(`❌ [GEMINI API FAILED]: ${err.message}`);
  }

  console.log('\n--- 3. Testing Failover AI Orchestrator ---');
  try {
    const failover = new FailoverAiProvider();
    const resFailover = await failover.generateResponse({
      contactName: 'API Diagnostic',
      contactId: 'diagnostic@c.us',
      messages: ['Are all systems functional?'],
      triggerType: 'normal_message'
    });
    console.log(`✅ [FAILOVER ORCHESTRATOR OPERATIONAL]`);
    console.log(`   Provider Active: ${resFailover.provider}`);
    console.log(`   Latency: ${resFailover.latencyMs} ms`);
    console.log(`   Sample Reply: "${resFailover.reply}"`);
  } catch (err: any) {
    console.error(`❌ [FAILOVER ORCHESTRATOR FAILED]: ${err.message}`);
  }

  console.log('\n--- 4. Testing SQLite Database & Settings Connection ---');
  try {
    const masterSwitch = db.getSetting('automation_master_switch');
    const aiProviderSetting = db.getSetting('ai_provider');
    const contactsCount = db.getAllContacts().length;
    console.log(`✅ [SQLITE DATABASE CONNECTED]`);
    console.log(`   Database Path: ${config.DATABASE_PATH}`);
    console.log(`   Master Automation Switch: ${masterSwitch !== null ? masterSwitch : '1 (default)'}`);
    console.log(`   Configured AI Provider: ${aiProviderSetting || 'failover'}`);
    console.log(`   Total Managed Contacts in DB: ${contactsCount}`);
  } catch (err: any) {
    console.error(`❌ [SQLITE DATABASE FAILED]: ${err.message}`);
  }

  console.log('\n================================================================');
  console.log('📊 API HEALTH CHECK COMPLETE');
  console.log('================================================================');
}

checkAllApiConnections().catch((err) => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
