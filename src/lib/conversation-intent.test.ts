import { describe, expect, it } from "vitest";
import { determineConversationIntent } from "./conversation-intent";

const previousTurn = {
  question: "What revenue was reported for Q2?",
  answer: "Revenue was ₹1,245.6 crore. [S1]",
  citations: [],
  abstained: false,
  retrievalMatchPercent: 82,
};

describe("conversation intent", () => {
  it("transforms the previous answer when the user asks to reformat it", () => {
    expect(determineConversationIntent("Put the last response in bullet points.", [previousTurn]))
      .toEqual({ kind: "transform", previousTurn });
    expect(determineConversationIntent("In bullet points, please.", [previousTurn]))
      .toEqual({ kind: "transform", previousTurn });
  });

  it("uses recent question context to resolve a follow-up search", () => {
    expect(determineConversationIntent("What about H1?", [previousTurn])).toEqual({
      kind: "search",
      retrievalQuestion: "What revenue was reported for Q2?\nWhat about H1?",
    });
  });

  it("uses regular search for a new request even when history is available", () => {
    expect(determineConversationIntent("Who attended the board meeting?", [previousTurn]))
      .toMatchObject({ kind: "search" });
  });
});
