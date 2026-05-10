import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const rootDir = "D:\\codex\\hui-music";
const inputPaths = [
  path.join(rootDir, "cache", "lx-source-benchmark.json"),
  path.join(rootDir, "cache", "lx-source-benchmark-20260510-fast.json")
];
const outputDir = path.join(rootDir, "outputs", "lx-source-report");
const outputPath = path.join(outputDir, "hui-radio-common-low-latency-across-two-tests.xlsx");
const previewPath = path.join(outputDir, "hui-radio-common-low-latency-across-two-tests-preview.png");

function readBenchmarkText(buffer) {
  const head = buffer.subarray(0, 8);
  if (head[0] === 0xff && head[1] === 0xfe) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  if (head[0] === 0xfe && head[1] === 0xff) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const nulCount = utf8.slice(0, 400).split("").filter((ch) => ch === "\u0000").length;
  if (nulCount > 12) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  return utf8;
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

function buildMap(benchmark) {
  return new Map(
    benchmark.working.map((item) => [
      item.sourceUrl,
      {
        ...item,
        sourceName: sourceName(item.sourceUrl),
        decodedUrl: decodeUrl(item.sourceUrl)
      }
    ])
  );
}

const [rawA, rawB] = await Promise.all(inputPaths.map((filePath) => fs.readFile(filePath)));
const benchmarkA = JSON.parse(readBenchmarkText(rawA));
const benchmarkB = JSON.parse(readBenchmarkText(rawB));
const mapA = buildMap(benchmarkA);
const mapB = buildMap(benchmarkB);

const common = [...mapB.values()]
  .filter((item) => mapA.has(item.sourceUrl))
  .map((item) => {
    const first = mapA.get(item.sourceUrl);
    const second = item;
    const latencyA = Number(first.latencyMs || 0);
    const latencyB = Number(second.latencyMs || 0);
    const score = Math.max(latencyA, latencyB);
    return {
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName,
      latencyA,
      latencyB,
      score,
      averageLatency: (latencyA + latencyB) / 2,
      totalA: Number(first.totalMs || 0),
      totalB: Number(second.totalMs || 0),
      originA: first.origin || "",
      originB: second.origin || "",
      testedTrackA: first.verified?.track || "",
      testedTrackB: second.verified?.track || "",
      qualityA: first.verified?.quality || "",
      qualityB: second.verified?.quality || "",
      resolvedUrlA: first.verified?.resolvedUrl || "",
      resolvedUrlB: second.verified?.resolvedUrl || ""
    };
  })
  .sort((a, b) => a.score - b.score || a.averageLatency - b.averageLatency || a.latencyA - b.latencyA || a.latencyB - b.latencyB);

await fs.mkdir(outputDir, { recursive: true });

const workbook = Workbook.create();

const summary = workbook.worksheets.add("摘要");
summary.showGridLines = false;
summary.getRange("A1:F1").merge();
summary.getRange("A1").values = [["两轮测试共同低延迟音源"]];
summary.getRange("A1").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center",
  verticalAlignment: "center"
};
summary.getRange("A1").format.rowHeightPx = 36;

summary.getRange("A2:I2").merge();
summary.getRange("A2").values = [[
  `测试1: ${benchmarkA.testedAt} | 测试2: ${benchmarkB.testedAt} | 共同可用: ${common.length} | 排序: 两轮延迟取较大值从低到高`
]];
summary.getRange("A2").format = {
  fill: "#EAF3F5",
  font: { color: "#153E4D" },
  horizontalAlignment: "center"
};

const summaryRows = [
  ["测试1可用", benchmarkA.working.length],
  ["测试2可用", benchmarkB.working.length],
  ["两轮共同可用", common.length],
  ["最佳共同音源", common[0]?.sourceName || ""],
  ["最佳共同延迟 ms", common[0]?.score || ""],
  ["最佳共同平均延迟 ms", common[0]?.averageLatency ? Number(common[0].averageLatency.toFixed(1)) : ""]
];

summary.getRange("A4:B9").values = summaryRows;
summary.getRange("A4:B4").format = { fill: "#153E4D", font: { bold: true, color: "#FFFFFF" } };
summary.getRange("A4:A9").format = { fill: "#F2FBF7", font: { bold: true, color: "#153E4D" } };
summary.getRange("B4:B9").format = { fill: "#FFFFFF" };
summary.getRange("A4:B9").format = { verticalAlignment: "center", wrapText: true };

summary.getRange("D4:I4").merge();
summary.getRange("D4").values = [["两轮都低的前 10 个音源"]];
summary.getRange("D4").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center"
};

const topTenHeaders = ["排名", "音源", "测试1 ms", "测试2 ms", "较慢 ms", "平均 ms"];
summary.getRange("D5:I5").values = [topTenHeaders];
summary.getRange("D5:I5").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" },
  verticalAlignment: "center"
};

const topTenRows = common.slice(0, 10).map((item, index) => [
  index + 1,
  item.sourceName,
  item.latencyA,
  item.latencyB,
  item.score,
  Number(item.averageLatency.toFixed(1))
]);
if (topTenRows.length) summary.getRangeByIndexes(4, 3, topTenRows.length, 6).values = topTenRows;

summary.freezePanes.freezeRows(3);
summary.getRange("A:A").format.columnWidthPx = 180;
summary.getRange("B:B").format.columnWidthPx = 160;
summary.getRange("C:C").format.columnWidthPx = 36;
summary.getRange("D:D").format.columnWidthPx = 44;
summary.getRange("E:E").format.columnWidthPx = 205;
summary.getRange("F:F").format.columnWidthPx = 78;
summary.getRange("G:G").format.columnWidthPx = 78;
summary.getRange("H:H").format.columnWidthPx = 78;
summary.getRange("I:I").format.columnWidthPx = 78;
summary.getRange("D5:I15").format = { wrapText: true };
summary.getRange("C:C").format.numberFormat = "0";
summary.getRange("D:F").format.numberFormat = "0.0";

const detail = workbook.worksheets.add("交集列表");
detail.showGridLines = false;

detail.getRange("A1:N1").merge();
detail.getRange("A1").values = [["两轮测试中都可用的低延迟音源"]];
detail.getRange("A1").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "center",
  verticalAlignment: "center"
};
detail.getRange("A1").format.rowHeightPx = 36;

detail.getRange("A2:N2").merge();
detail.getRange("A2").values = [[
  `测试1: ${benchmarkA.testedAt}    测试2: ${benchmarkB.testedAt}    共同可用: ${common.length}    排序: 较慢延迟 ms 从低到高`
]];
detail.getRange("A2").format = {
  fill: "#EAF3F5",
  font: { color: "#153E4D" },
  horizontalAlignment: "center"
};

const headers = [
  "排名",
  "音源名称",
  "测试1延迟 ms",
  "测试2延迟 ms",
  "较慢延迟 ms",
  "平均延迟 ms",
  "测试1总耗时 ms",
  "测试2总耗时 ms",
  "测试1来源",
  "测试2来源",
  "测试1曲目",
  "测试2曲目",
  "音源 URL",
  "解析后播放 URL"
];

detail.getRange("A4:N4").values = [headers];
detail.getRange("A4:N4").format = {
  fill: "#153E4D",
  font: { bold: true, color: "#FFFFFF" },
  verticalAlignment: "center"
};
detail.getRange("A4:N4").format.rowHeightPx = 30;

const rows = common.map((item, index) => [
  index + 1,
  item.sourceName,
  item.latencyA,
  item.latencyB,
  item.score,
  Number(item.averageLatency.toFixed(1)),
  item.totalA,
  item.totalB,
  item.originA,
  item.originB,
  `${item.testedTrackA} / ${item.qualityA}`,
  `${item.testedTrackB} / ${item.qualityB}`,
  item.sourceUrl,
  item.resolvedUrlA || item.resolvedUrlB || ""
]);

if (rows.length) {
  detail.getRangeByIndexes(4, 0, rows.length, headers.length).values = rows;
  detail.tables.add(`A4:N${rows.length + 4}`, true, "CommonLowLatencySources");
}

detail.freezePanes.freezeRows(4);
detail.getRange("A:A").format.columnWidthPx = 56;
detail.getRange("B:B").format.columnWidthPx = 240;
detail.getRange("C:F").format.columnWidthPx = 92;
detail.getRange("G:H").format.columnWidthPx = 104;
detail.getRange("I:J").format.columnWidthPx = 160;
detail.getRange("K:L").format.columnWidthPx = 120;
detail.getRange("M:M").format.columnWidthPx = 640;
detail.getRange("N:N").format.columnWidthPx = 640;
detail.getRange("B:N").format = { wrapText: true };
detail.getRange("C:H").format.numberFormat = "0";

if (rows.length) {
  detail.getRange(`A5:N${Math.min(rows.length + 4, 14)}`).format = { fill: "#F2FBF7" };
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan"
});
console.log(errors.ndjson);

const previewSummary = await workbook.render({ sheetName: "摘要", range: "A1:I15", scale: 1, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await previewSummary.arrayBuffer()));
const detailPreviewPath = path.join(outputDir, "hui-radio-common-low-latency-across-two-tests-detail-preview.png");
const previewDetail = await workbook.render({ sheetName: "交集列表", range: "A1:N18", scale: 1, format: "png" });
await fs.writeFile(detailPreviewPath, new Uint8Array(await previewDetail.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

console.log(JSON.stringify({
  outputPath,
  previewPath,
  detailPreviewPath,
  common: common.length,
  best: common[0] ? { sourceName: common[0].sourceName, latencyA: common[0].latencyA, latencyB: common[0].latencyB, score: common[0].score } : null
}, null, 2));
