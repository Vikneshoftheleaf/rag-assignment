const codeSegments = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;
const wordPattern = /\p{L}+(?:['’]\p{L}+)?/gu;

export function repairSplitWords(answer: string, sourceTexts: string[]): string {
  const sourceWords = new Map<string, string>();
  for (const source of sourceTexts) {
    if (typeof source !== "string") continue;
    for (const word of source.matchAll(wordPattern)) {
      const value = word[0];
      sourceWords.set(value.toLocaleLowerCase("en"), value);
    }
  }

  const segments = answer.split(codeSegments);
  return segments.map((segment, segmentIndex) => {
    if (segmentIndex % 2 !== 0) return segment;

    const words = [...segment.matchAll(wordPattern)];
    if (words.length < 2) return normalizeMalformedCitations(segment);

    let output = "";
    let cursor = 0;
    for (let index = 0; index < words.length;) {
      const current = words[index];
      let bestEnd = index;
      let bestWord = sourceWords.get(current[0].toLocaleLowerCase("en"));
      let joined = current[0];

      for (let end = index + 1; end < Math.min(words.length, index + 4); end++) {
        const previous = words[end - 1];
        const next = words[end];
        const gap = segment.slice(previous.index! + previous[0].length, next.index);
        if (!/^[\p{Zs}\t]+$/u.test(gap)) break;

        joined += next[0];
        const sourceWord = sourceWords.get(joined.toLocaleLowerCase("en"));
        if (sourceWord) {
          bestEnd = end;
          bestWord = sourceWord;
        }
      }

      if (bestEnd > index && bestWord) {
        output += segment.slice(cursor, current.index) + matchSourceCasing(joined, bestWord);
        cursor = words[bestEnd].index! + words[bestEnd][0].length;
        index = bestEnd + 1;
      } else {
        index += 1;
      }
    }

    if (!output) return normalizeMalformedCitations(segment);
    return normalizeMalformedCitations(output + segment.slice(cursor));
  }).join("");
}

function matchSourceCasing(generated: string, source: string): string {
  if (generated === generated.toUpperCase()) return source.toUpperCase();
  if (generated[0] === generated[0].toUpperCase()) {
    return source[0].toUpperCase() + source.slice(1).toLocaleLowerCase("en");
  }
  return source.toLocaleLowerCase("en");
}

function normalizeMalformedCitations(text: string): string {
  return text.replace(/【\s*S\s*(\d+)[^】]*】/gi, "[S$1]");
}
