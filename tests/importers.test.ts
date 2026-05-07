import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { parseLxImport } from "../server/importers/lx.js";
import { extractQqPlaylistId } from "../server/importers/qq.js";

describe("QQ playlist parsing", () => {
  it("extracts playlist ids from common links", () => {
    expect(extractQqPlaylistId("https://y.qq.com/n/ryqq/playlist/123456789")).toBe("123456789");
    expect(extractQqPlaylistId("https://i.y.qq.com/n2/m/share/details/taoge.html?id=998877")).toBe("998877");
    expect(extractQqPlaylistId("https://example.com/?disstid=445566")).toBe("445566");
  });
});

describe("LX import parsing", () => {
  it("normalizes nested LX style tracks", () => {
    const result = parseLxImport({
      name: "我的 LX",
      list: [
        {
          name: "晚风",
          singer: "歌手",
          source: "tx",
          songmid: "abc",
          albumName: "专辑"
        }
      ]
    });
    expect(result.name).toBe("我的 LX");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ title: "晚风", artist: "歌手", source: "tx", songmid: "abc" });
  });

  it("imports gzip lxmc payloads", () => {
    const payload = JSON.stringify({
      type: "playListPart_v2",
      data: {
        name: "love",
        list: [{ id: "wy_1", name: "一次就好", singer: "范丞丞", source: "wy", meta: { songId: 1, albumName: "现场" } }]
      }
    });
    const result = parseLxImport({ fileName: "love.lxmc", base64: zlib.gzipSync(payload).toString("base64") });
    expect(result.tracks[0]).toMatchObject({ title: "一次就好", artist: "范丞丞", source: "wy", album: "现场" });
  });

  it("imports LX csv exports", () => {
    const csv = "歌曲名,艺术家,专辑名\n我不是你的宋冬野,刘大壮,我不是你的宋冬野";
    const result = parseLxImport({ fileName: "lx_list_all.csv", base64: Buffer.from(csv, "utf8").toString("base64") });
    expect(result.tracks[0]).toMatchObject({ title: "我不是你的宋冬野", artist: "刘大壮", album: "我不是你的宋冬野" });
  });
});
