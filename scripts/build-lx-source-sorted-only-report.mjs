import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const rootDir = "D:\\codex\\hui-music";
const inputPath = path.join(rootDir, "cache", "lx-source-benchmark.json");
const outputDir = path.join(rootDir, "outputs", "lx-source-report");
const outputPath = path.join(outputDir, "hui-radio-available-sources-by-latency.xlsx");
const previewPath = path.join(outputDir, "hui-radio-available-sources-by-latency-preview.png");

function readBenchmarkText(buffer) {
  return (buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8")).replace(/^\uFEFF/, "");
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

function valueOrBlank(value) {
  return value === undefined || value === null ? "" : value;
}

const raw = await fs.readFile(inputPath);
const benchmark = JSON.parse(readBenchmarkText(raw));
const working = [...benchmark.working].sort((a, b) => a.latencyMs - b.latencyMs || a.totalMs - b.totalMs);

await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("可用音源延迟排序");
sheet.showGridLines = false;

sheet.getRange("A1:N1").merge();
sheet.getRange("A1").values = [["本轮测试可用音源延迟排序"]];
sheet.getRange("A1").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center",
  verticalAlignment: "center"
};
sheet.getRange("A1").format.rowHeightPx = 36;

sheet.getRange("A2:N2").merge();
sheet.getRange("A2").values = [[`测试时间: ${benchmark.testedAt}    候选音源: ${benchmark.total}    可用音源: ${working.length}    排序: 延迟 ms 从低到高`]];
sheet.getRange("A2").format = {
  fill: "#EAF3F5",
  font: { color: "#153E4D" },
  horizontalAlignment: "center"
};

const headers = [
  "排名",
  "音源名称",
  "延迟 ms",
  "总耗时 ms",
  "下载脚本 ms",
  "解析 URL ms",
  "音频首包 ms",
  "测试曲目",
  "音质",
  "HTTP 状态",
  "Content-Type",
  "来源",
  "音源 URL",
  "解析出的播放 URL"
];

sheet.getRange("A4:N4").values = [headers];
sheet.getRange("A4:N4").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" },
  verticalAlignment: "center"
};
sheet.getRange("A4:N4").format.rowHeightPx = 30;

const rows = working.map((item, index) => [
  index + 1,
  sourceName(item.sourceUrl),
  valueOrBlank(item.latencyMs),
  valueOrBlank(item.totalMs),
  valueOrBlank(item.downloadMs),
  valueOrBlank(item.resolveMs),
  valueOrBlank(item.streamMs),
  valueOrBlank(item.verified?.track),
  valueOrBlank(item.verified?.quality),
  valueOrBlank(item.verified?.status),
  valueOrBlank(item.verified?.contentType),
  valueOrBlank(item.origin),
  decodeUrl(item.sourceUrl),
  valueOrBlank(item.verified?.resolvedUrl)
]);

if (rows.length) {
  sheet.getRangeByIndexes(4, 0, rows.length, headers.length).values = rows;
  const table = sheet.tables.add(`A4:N${rows.length + 4}`, true, "AvailableSourcesByLatency");
  table.showFilterButton = true;
}

sheet.freezePanes.freezeRows(4);
sheet.getRange("A:A").format.columnWidthPx = 56;
sheet.getRange("B:B").format.columnWidthPx = 240;
sheet.getRange("C:G").format.columnWidthPx = 92;
sheet.getRange("H:H").format.columnWidthPx = 135;
sheet.getRange("I:J").format.columnWidthPx = 78;
sheet.getRange("K:K").format.columnWidthPx = 170;
sheet.getRange("L:L").format.columnWidthPx = 210;
sheet.getRange("M:M").format.columnWidthPx = 620;
sheet.getRange("N:N").format.columnWidthPx = 620;
sheet.getRange("B:N").format = { wrapText: true };
sheet.getRange("C:G").format.numberFormat = "0";

if (rows.length) {
  sheet.getRange(`A5:N${Math.min(rows.length + 4, 14)}`).format = { fill: "#F2FBF7" };
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan"
});
console.log(errors.ndjson);

const preview = await workbook.render({ sheetName: "可用音源延迟排序", range: "A1:N18", scale: 1, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

console.log(JSON.stringify({ outputPath, previewPath, working: working.length, best: working[0] }, null, 2));
