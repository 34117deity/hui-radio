import fs from "node:fs/promises";
import { config } from "../config.js";

const AUTO_MEMORY_START = "<!-- AUTO_MEMORY_START -->";
const AUTO_MEMORY_END = "<!-- AUTO_MEMORY_END -->";
const DEFAULT_AUTO_MEMORY = "- No durable listener preferences learned yet.";

function buildAgentsTemplate(autoMemory = DEFAULT_AUTO_MEMORY) {
  return [
    "# Hui Radio Memory",
    "",
    "This file stores long-term listener preferences distilled from prior conversations.",
    "Only the auto memory section is rewritten by the app. You can edit Manual Notes freely.",
    "",
    "## Auto Memory",
    AUTO_MEMORY_START,
    autoMemory.trim() || DEFAULT_AUTO_MEMORY,
    AUTO_MEMORY_END,
    "",
    "## Manual Notes",
    "- Add any hand-written permanent notes here."
  ].join("\n");
}

function extractSection(content: string) {
  const match = content.match(new RegExp(`${AUTO_MEMORY_START}[\\r\\n]+([\\s\\S]*?)[\\r\\n]+${AUTO_MEMORY_END}`));
  return match?.[1]?.trim() || "";
}

export async function ensureAgentsMemoryFile() {
  try {
    await fs.access(config.agentsMemoryPath);
  } catch {
    await fs.writeFile(config.agentsMemoryPath, buildAgentsTemplate(), "utf8");
  }
}

export async function readAgentsMemoryFile() {
  await ensureAgentsMemoryFile();
  return fs.readFile(config.agentsMemoryPath, "utf8");
}

export async function readAutoMemory() {
  const content = await readAgentsMemoryFile();
  return extractSection(content) || DEFAULT_AUTO_MEMORY;
}

export async function writeAutoMemory(autoMemory: string) {
  await ensureAgentsMemoryFile();
  const current = await readAgentsMemoryFile();
  const nextBlock = `${AUTO_MEMORY_START}\n${(autoMemory.trim() || DEFAULT_AUTO_MEMORY).trim()}\n${AUTO_MEMORY_END}`;

  if (current.includes(AUTO_MEMORY_START) && current.includes(AUTO_MEMORY_END)) {
    const updated = current.replace(new RegExp(`${AUTO_MEMORY_START}[\\s\\S]*?${AUTO_MEMORY_END}`), nextBlock);
    await fs.writeFile(config.agentsMemoryPath, updated, "utf8");
    return;
  }

  await fs.writeFile(config.agentsMemoryPath, buildAgentsTemplate(autoMemory), "utf8");
}

export { DEFAULT_AUTO_MEMORY };
