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
    "What is the capital of France?",
    "Give me the latest football match score.",
    "Write a short story about a dragon.",
  ])("redirects a clearly unrelated request: %s", (message) => {
    const decision = applyQueryPolicy(message);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.answer).toContain("outside this assistant’s scope");
      expect(decision.answer).toContain("Silverline sample documents");
    }
  });

  it.each([
    "Authorisation and Contact Details",
    "Who attended the 22 October board meeting?",
    "Calculate the revenue reported in the financial results.",
  ])("allows a document-oriented query even when its wording is uncommon: %s", (message) => {
    expect(applyQueryPolicy(message)).toEqual({ allowed: true });
  });

  it.each(["Hello!", "Hey there", "Good night", "How are you doing?"])("uses the greeting redirect: %s", (message) => {
    const decision = applyQueryPolicy(message);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.answer).toMatch(/^Hello!/);
      expect(decision.answer).toContain("board minutes, resolutions, and financial results");
    }
  });

  it("uses a separate concise response for a brief courtesy message", () => {
    const decision = applyQueryPolicy("Thanks!");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.answer).toMatch(/^You’re welcome!/);
      expect(decision.answer).not.toContain("I can’t help");
    }
  });
});