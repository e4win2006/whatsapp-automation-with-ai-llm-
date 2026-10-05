import { orchestrator } from './core/orchestrator';
import { db } from './database/database';
import { MockWhatsAppAdapter } from './whatsapp/adapters/mockAdapter';

async function main() {
  try {
    await orchestrator.start();

    console.log('[JARVIS] System initialized. Access web command center at http://localhost:3000');

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[JARVIS] Received ${signal}. Gracefully shutting down...`);
      await orchestrator.stop();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('[FATAL] Failed to start JARVIS:', error);
    process.exit(1);
  }
}

main();
