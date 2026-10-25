export function markdownWithCitationLinks(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return segments.map((segment, index) => {
    if (index % 2 !== 0) return segment;

    return segment
      .replace(/【\s*S\s*(\d+)\s*】/gi, "[S$1]")
      .replace(/\[(S)\s*(\d+)\]/gi, "[$1$2]")
      .replace(/(\*\*|__|~~)([^\n]*?)\1/g, (_match, delimiter: string, content: string) =>
        `${delimiter}${content.trim()}${delimiter}`)
      .replace(/\[(S\d+)\](?!\()/g, "[$1](#citation-$1)");
  }).join("");
}
