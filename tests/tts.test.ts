import { describe, expect, it } from "vitest";
import { buildSiliconFlowSpeechRequest, formatSiliconFlowTtsInput } from "../server/services/openai.js";

describe("SiliconFlow TTS request helpers", () => {
  it("prefixes plain text with a single speaker tag", () => {
    expect(formatSiliconFlowTtsInput("  浣犲ソ锛屼粖鏅氱户缁惉姝屽惂  ")).toBe("[S1] 浣犲ソ锛屼粖鏅氱户缁惉姝屽惂");
  });

  it("keeps existing speaker tags intact", () => {
    expect(formatSiliconFlowTtsInput("[S2] 杞埌鎴戞潵鎺ョ潃璇?")).toBe("[S2] 杞埌鎴戞潵鎺ョ潃璇?");
  });

  it("builds the SiliconFlow speech request with the expected endpoint and payload", () => {
    const request = buildSiliconFlowSpeechRequest({
      text: "浠婃櫄缁х画鍚瓕鍚?",
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "FunAudioLLM/CosyVoice2-0.5B:anna",
      baseUrl: "https://api.siliconflow.com/v1"
    });

    expect(request.url).toBe("https://api.siliconflow.com/v1/audio/speech");
    expect(request.body).toEqual({
      model: "FunAudioLLM/CosyVoice2-0.5B",
      voice: "FunAudioLLM/CosyVoice2-0.5B:anna",
      input: "[S1] 浠婃櫄缁х画鍚瓕鍚?",
      response_format: "mp3",
      stream: false
    });
  });
});
