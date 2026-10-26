import { describe, expect, it } from "vitest";
import { buildGroundedPrompt, buildTransformPrompt } from "./prompt";
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

  it("requires source citations and conservative action reporting for board decisions", () => {
    const [system] = buildGroundedPrompt(
      "What decisions and follow-up actions were recorded in the board meeting?",
      [record],
    );

    expect(system.content).toContain("a source citation in every row");
    expect(system.content).toContain("Do not infer actions or owners");
    expect(system.content).toContain("Include each distinct agenda item only once");
  });

  it("preserves the auditor's limited-review wording without overstating assurance", () => {
    const [system] = buildGroundedPrompt(
      "What did the auditor conclude about the financial results?",
      [record],
    );

    expect(system.content).toContain("preserve its exact limited-review wording");
    expect(system.content).toContain("Do not strengthen limited assurance into a guarantee");
    expect(system.content).toContain("Distinguish standalone and consolidated conclusions");
  });

  it("guides requested drafts to be usable while marking unsupported details", () => {
    const [system] = buildGroundedPrompt("Draft an email announcing the board decision.", [record]);

    expect(system.content).toContain("ready-to-edit draft");
    expect(system.content).toContain("Use only supported names, dates, decisions, amounts, and commitments");
    expect(system.content).toContain("short bracketed placeholder");
    expect(system.content).toContain("Cite sourced factual statements inline");
  });

  it("includes prior conversation only as reference context for a follow-up search", () => {
    const [, user] = buildGroundedPrompt("What about H1?", [record], [
      { question: "What revenue was reported for Q2?", answer: "₹1,245.6 crore [S1]" },
    ]);

    expect(user.content).toContain("prior assistant statements are not source evidence");
    expect(user.content).toContain("What revenue was reported for Q2?");
    expect(user.content).toContain("Current question: What about H1?");
  });

  it("instructs answer reformatting to preserve citations and avoid new facts", () => {
    const [system, user] = buildTransformPrompt(
      "Put the last response in bullet points.",
      "Revenue was ₹1,245.6 crore. [S1]",
    );

    expect(system.content).toContain("Preserve its factual meaning");
    expect(system.content).toContain("do not add facts, claims, or citations");
    expect(user.content).toContain("Revenue was ₹1,245.6 crore. [S1]");
  });
});
