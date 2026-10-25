import { describe, expect, it } from "vitest";
import { markdownWithCitationLinks } from "./markdown";

describe("markdownWithCitationLinks", () => {
  it("repairs whitespace around common emphasis delimiters", () => {
    expect(markdownWithCitationLinks("** Approval status** and ~~ pending ~~"))
      .toBe("**Approval status** and ~~pending~~");
  });

  it("preserves valid emphasis followed by regular prose", () => {
    expect(markdownWithCitationLinks("**Approval status** is pending."))
      .toBe("**Approval status** is pending.");
  });

  it("normalizes spaced source citations and converts them to citation links", () => {
    expect(markdownWithCitationLinks("【 S 5】 and [S 2]"))
      .toBe("[S5](#citation-S5) and [S2](#citation-S2)");
  });

  it("leaves code spans and fenced code blocks unchanged", () => {
    const markdown = "`** literal ** 【 S 5】`\n\n```text\n** literal ** 【 S 5】\n```";

    expect(markdownWithCitationLinks(markdown)).toBe(markdown);
  });
});
