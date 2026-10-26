import type { Citation } from "@/lib/types";

export type ConversationTurn = {
  question: string;
  answer: string;
  citations: Citation[];
  abstained: boolean;
  retrievalMatchPercent: number | null;
};

export type ConversationIntent =
  | { kind: "search"; retrievalQuestion: string }
  | { kind: "transform"; previousTurn: ConversationTurn };

const transformRequestPattern =
  /\b(?:bullet\s*points?|bullets|table|shorter|more concise|brief(?:er)?|rephrase|rewrite|reword|reformat|format|simplify|translate|change the format|different format|one sentence|plain language)\b/i;
const previousAnswerReferencePattern =
  /\b(?:that|it|this|above|last|previous|prior|answer|response|reply)\b/i;
const implicitTransformRequestPattern =
  /^(?:please\s+)?(?:in\s+)?(?:bullet\s*points?|bullets|table|shorter|more concise|brief(?:er)?|one sentence|plain language)\b/i;

export function determineConversationIntent(
  message: string,
  history: ConversationTurn[],
): ConversationIntent {
  const previousTurn = history.at(-1);
  if (
    previousTurn &&
    !previousTurn.abstained &&
    (previousAnswerReferencePattern.test(message) || implicitTransformRequestPattern.test(message)) &&
    !/\?/.test(message) &&
    transformRequestPattern.test(message)
  ) {
    return { kind: "transform", previousTurn };
  }

  const contextualQuestions = history
    .slice(-3)
    .map((turn) => turn.question.trim())
    .filter(Boolean);
  return {
    kind: "search",
    retrievalQuestion: [...contextualQuestions, message.trim()].join("\n"),
  };
}
