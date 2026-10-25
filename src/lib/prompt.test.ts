import { describe, expect, it } from "vitest";
import { buildGroundedPrompt } from "./prompt";
import type { RetrievedRecord } from "./types";

const record: RetrievedRecord = {
  result_id: "chunk-1",
  result_kind: "chunk",
  content: "The board approved the budget.",
  source_filename: "minutes.docx",
  source_type: "docx",
  source_location: { page: 2 },
  metadata: null,
  score: 0.9,
};

describe("grounded summary prompts", () => {
  it("instructs the model to synthesize evidence for summary questions", () => {
    const [system] = buildGroundedPrompt("Summarize the key information in this document.", [record]);

    expect(system.content).toContain("synthesize the available excerpts");
    expect(system.content).toContain("key figures, decisions, actions, and caveats");
  });

  it("does not apply summary instructions to ordinary factual questions", () => {
    const [system] = buildGroundedPrompt("What budget did the board approve?", [record]);

    expect(system.content).not.toContain("The user requested a summary");
  });

  it("preserves exact financial figures, periods, units, and reporting scope", () => {
    const [system] = buildGroundedPrompt("Compare revenue for Q2 and H1.", [record]);

    expect(system.content).toContain("preserve exact figures");
    expect(system.content).toContain("standalone versus consolidated results");
    expect(system.content).toContain("include the unit with each figure");
    expect(system.content).toContain("do not round unless asked");
  });

  it("asks for a professional, structured answer without forcing headings on simple questions", () => {
    const [system] = buildGroundedPrompt("What budget did the board approve?", [record]);

    expect(system.content).toContain("lead with the direct answer");
    expect(system.content).toContain("brief descriptive headings");
    expect(system.content).toContain("avoid filler");
    expect(system.content).not.toContain("The user requested a draft");
  });

  it("formats document summaries as concise structured briefs", () => {
    const [system] = buildGroundedPrompt("Summarize the board meeting.", [record]);

    expect(system.content).toContain("an Executive summary");
    expect(system.content).toContain("Important figures or decisions");
    expect(system.content).toContain("Caveats or open questions");
  });

  it("guides requested drafts to be usable while marking unsupported details", () => {
    const [system] = buildGroundedPrompt("Draft an email announcing the board decision.", [record]);

    expect(system.content).toContain("ready-to-edit draft");
    expect(system.content).toContain("Use only supported names, dates, decisions, amounts, and commitments");
    expect(system.content).toContain("short bracketed placeholder");
    expect(system.content).toContain("Cite sourced factual statements inline");
  });
});
