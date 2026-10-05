import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // WhatsApp Adapter Configuration
  WHATSAPP_ADAPTER: z.enum(['mock', 'web']).default('web'),
  WHATSAPP_SESSION_PATH: z.string().default(path.resolve(process.cwd(), 'data/whatsapp-session')),
  WHATSAPP_HEADLESS: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),

  // Database
  DATABASE_PATH: z.string().default(path.resolve(process.cwd(), 'data/jarvis.db')),

  // Automation Settings
  AUTOMATION_MASTER_SWITCH: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  DEFAULT_RESPONSE_DELAY_SECONDS: z.coerce.number().default(180),
  MAX_RESPONSE_DELAY_SECONDS: z.coerce.number().default(3600),
  WAKE_PHRASES: z.string().default('Hey Jarvis,Hi Jarvis,Hello Jarvis,Jarvis,OK Jarvis,Okay Jarvis,Ji Jarvis').transform((str) =>
    str.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  ),

  // AI Engine
  AI_PROVIDER: z.enum(['mock', 'groq', 'gemini', 'failover', 'lmstudio', 'ollama', 'disabled']).default('failover'),
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  LMSTUDIO_URL: z.string().default('http://localhost:1234/v1'),
  LMSTUDIO_MODEL: z.string().default('local-model'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3'),
  AI_TIMEOUT_MS: z.coerce.number().default(15000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let parsedConfig: AppConfig;
try {
  parsedConfig = ConfigSchema.parse(process.env);
} catch (error) {
  console.error('[CONFIG ERROR] Invalid environment configuration:', error);
  parsedConfig = ConfigSchema.parse({});
}

export const config = parsedConfig;
