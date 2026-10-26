import { describe, expect, it } from "vitest";
import { repairSplitWords } from "./answer-format";

describe("repairSplitWords", () => {
  const source = [
    "Ms Nisha Mehta is Chief Financial Officer and Key Managerial Personnel.",
    "The appointment is effective from 1 November 2026, subject to statutory and regulatory formalities.",
    "The appointee will authorise the filing of disclosures.",
    "CFO",
  ];

  it("joins fragmented words only when the complete word appears in retrieved sources", () => {
    const answer = "Ms N isha Me hta is Chief Financial Officer and Key Manager ial Personnel. The formal ities apply.";

    expect(repairSplitWords(answer, source))
      .toBe("Ms Nisha Mehta is Chief Financial Officer and Key Managerial Personnel. The formalities apply.");
  });

  it("repairs acronym splits and malformed source labels", () => {
    expect(repairSplitWords("The C FO【 S 1† L 1-L 2】 may Author ise filings.", source))
      .toBe("The CFO[S1] may Authorise filings.");
  });

  it("preserves legitimate spaces that do not form a source word", () => {
    expect(repairSplitWords("Key Manager will prepare the report.", source))
      .toBe("Key Manager will prepare the report.");
  });

  it("does not change code spans or fenced code blocks", () => {
    const answer = "`N isha C FO`\n\n```text\nMe hta C FO\n```";

    expect(repairSplitWords(answer, source)).toBe(answer);
  });
});
