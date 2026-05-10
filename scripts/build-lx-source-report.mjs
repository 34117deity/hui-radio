import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const rootDir = "D:\\codex\\hui-music";
const inputPath = path.join(rootDir, "cache", "lx-source-benchmark.json");
const outputDir = path.join(rootDir, "outputs", "lx-source-report");
const outputPath = path.join(outputDir, "hui-radio-lx-source-latency-report.xlsx");
const previewPath = path.join(outputDir, "hui-radio-lx-source-latency-report-preview.png");

function decodeMaybeUtf16(buffer) {
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

function decodeUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function sourceName(url) {
  const decoded = decodeUrl(url);
  const last = decoded.split("/").filter(Boolean).at(-1) || decoded;
  return last.replace(/\.js$/i, "");
}

function safeValue(value) {
  return value === undefined || value === null ? "" : value;
}

function findCurrent(results) {
  return results.filter((item) => String(item.origin || "").startsWith("current-config"));
}

const raw = await fs.readFile(inputPath);
const benchmark = JSON.parse(decodeMaybeUtf16(raw));
const working = [...benchmark.working].sort((a, b) => a.latencyMs - b.latencyMs || a.totalMs - b.totalMs);
const current = findCurrent(benchmark.results);
const best = working[0];

await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const summary = workbook.worksheets.add("摘要");
const details = workbook.worksheets.add("可用音源");

summary.showGridLines = false;
details.showGridLines = false;

summary.getRange("A1:F1").merge();
summary.getRange("A1").values = [["Hui Radio 音源可用性与延迟测试"]];
summary.getRange("A1").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center",
  verticalAlignment: "center"
};
summary.getRange("A1").format.rowHeightPx = 36;

summary.getRange("A3:B9").values = [
  ["测试时间", benchmark.testedAt],
  ["候选音源总数", benchmark.total],
  ["可用音源数量", working.length],
  ["当前主配置", decodeUrl(process.env.LX_SOURCE_URL || "")],
  ["当前备用配置", decodeUrl(process.env.LX_SOURCE_FALLBACK_URLS || "")],
  ["推荐音源", best ? sourceName(best.sourceUrl) : "无可用音源"],
  ["推荐延迟", best ? `${best.latencyMs} ms` : "N/A"]
];
summary.getRange("A3:A9").format = {
  fill: "#EAF3F5",
  font: { bold: true, color: "#153E4D" }
};
summary.getRange("B3:B9").format = { wrapText: true };

summary.getRange("A11:F11").values = [["当前配置检测", "来源", "可用", "延迟 ms", "总耗时 ms", "URL"]];
summary.getRange("A11:F11").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" }
};
const currentRows = current.map((item, index) => [
  index + 1,
  item.origin,
  item.ok ? "可用" : "不可用",
  safeValue(item.latencyMs),
  safeValue(item.totalMs),
  decodeUrl(item.sourceUrl)
]);
if (currentRows.length) {
  summary.getRangeByIndexes(11, 0, currentRows.length, 6).values = currentRows;
  summary.getRangeByIndexes(11, 5, currentRows.length, 1).format = { wrapText: true };
}

summary.getRange("A3:A20").format.columnWidthPx = 120;
summary.getRange("B3:B20").format.columnWidthPx = 460;
summary.getRange("C3:E20").format.columnWidthPx = 90;
summary.getRange("F3:F20").format.columnWidthPx = 520;

const headers = [
  "排名",
  "音源名称",
  "延迟 ms",
  "总耗时 ms",
  "下载 ms",
  "解析 ms",
  "首包 ms",
  "测试曲目",
  "音质",
  "HTTP",
  "Content-Type",
  "来源仓库",
  "音源 URL"
];
details.getRange("A1:M1").values = [headers];
details.getRange("A1:M1").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" },
  verticalAlignment: "center"
};
details.getRange("A1:M1").format.rowHeightPx = 28;

const rows = working.map((item, index) => [
  index + 1,
  sourceName(item.sourceUrl),
  item.latencyMs,
  item.totalMs,
  item.downloadMs,
  item.resolveMs,
  item.streamMs,
  safeValue(item.verified?.track),
  safeValue(item.verified?.quality),
  safeValue(item.verified?.status),
  safeValue(item.verified?.contentType),
  item.origin,
  decodeUrl(item.sourceUrl)
]);

if (rows.length) {
  details.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows;
  details.tables.add(`A1:M${rows.length + 1}`, true, "WorkingSources");
}

details.freezePanes.freezeRows(1);
details.getRange("A:A").format.columnWidthPx = 55;
details.getRange("B:B").format.columnWidthPx = 230;
details.getRange("C:G").format.columnWidthPx = 86;
details.getRange("H:H").format.columnWidthPx = 130;
details.getRange("I:J").format.columnWidthPx = 72;
details.getRange("K:K").format.columnWidthPx = 170;
details.getRange("L:L").format.columnWidthPx = 210;
details.getRange("M:M").format.columnWidthPx = 620;
details.getRange("B:M").format = { wrapText: true };
details.getRange("C:G").format.numberFormat = "0";

const topCount = Math.min(10, rows.length);
if (topCount > 0) {
  details.getRange(`A2:M${topCount + 1}`).format = { fill: "#F2FBF7" };
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan"
});
console.log(errors.ndjson);

const preview = await workbook.render({ sheetName: "可用音源", range: "A1:M18", scale: 1, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

console.log(JSON.stringify({ outputPath, previewPath, working: working.length, best: best ? { latencyMs: best.latencyMs, sourceUrl: best.sourceUrl } : null }, null, 2));
