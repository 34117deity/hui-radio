import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_PROXY_URL: z.string().optional(),
  OPENAI_TEXT_MODEL: z.string().default("claude-haiku-4-5"),
  OPENAI_TTS_MODEL: z.string().default("IndexTeam/IndexTTS-2"),
  OPENAI_TTS_VOICE: z.string().default("IndexTeam/IndexTTS-2:alex"),
  SILICONFLOW_API_KEY: z.string().optional(),
  SILICONFLOW_BASE_URL: z.string().default("https://api.siliconflow.com/v1"),
  LX_SOURCE_TEXT_BASE64: z.string().optional(),
  LX_SOURCE_FALLBACK_URLS: z.string().optional(),
  LX_SOURCE_URL: z.string().min(1).default("https://raw.githubusercontent.com/2061360308/-LX-luoxue_yinyuan/refs/heads/master/ikun%E5%85%AC%E7%9B%8A%E9%9F%B3%E6%BA%90.js"),
  LX_SOURCE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  LX_SOURCE_FETCH_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  LX_BAD_SOURCE_TTL_MS: z.coerce.number().int().positive().default(300000),
  PORT: z.coerce.number().default(3000)
});

export const config = {
  ...envSchema.parse(process.env),
  rootDir,
  dataDir: path.join(rootDir, "data"),
  cacheDir: path.join(rootDir, "cache"),
  ttsCacheDir: path.join(rootDir, "cache", "tts"),
  distDir: path.join(rootDir, "dist"),
  agentsMemoryPath: path.join(rootDir, "AGENTS.md")
};
