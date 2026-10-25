import { describe, expect, it } from "vitest";
import { applyQueryPolicy } from "./query-policy";

describe("query scope policy", () => {
  it.each([
    "What decisions were recorded at the latest board meeting?",
    "Who attended the 22 October board meeting?",
    "What revenue and profit were reported for H1 FY2026-27?",
    "What did the auditor conclude?",
    "Summarize these documents.",
    "Summarize the key information, decisions or figures, actions, and caveats in Silverline_Industries_Financial_Results_Q2_H1_FY2026-27.xlsx.",
    "Summarize the key information, decisions or figures, actions, and caveats in Silverline_Industries_CTC_Board_Resolutions_Register_and_Templates.xlsx.",
    "Summarize the key information, decisions or figures, actions, and caveats in Silverline_Industries_Board_Meeting_Minutes_22_October_2026.docx.",
    "Summarize the key information, decisions or figures, actions, and caveats in Silverline_Industries_Auditors_Limited_Review_Report_Q2_H1_FY2026-27.pdf.",
    "Summarize the key information, decisions or figures, actions, and caveats in Illustrative_Board_Meeting_Outcome_Silverline_Industries_Limited.pdf.",
    "What does the resolutions register say?",
  ])("allows a Silverline corpus question: %s", (message) => {
    expect(applyQueryPolicy(message)).toEqual({ allowed: true });
  });

  it.each([
    "What is the weather today?",
    "Write a Python script to sort a list.",
    "Tell me a joke.",
    "Who is the president of France?",
    "Can you help me with a recipe?",
  ])("redirects a general question: %s", (message) => {
    const decision = applyQueryPolicy(message);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.answer).toContain("Silverline sample documents");
      expect(decision.answer).toContain("financial results");
    }
  });

  it("responds to a greeting with a short use-case redirect", () => {
    const decision = applyQueryPolicy("Hello!");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.answer).toMatch(/^Hello!/);
  });
});