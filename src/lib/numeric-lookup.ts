import type { Citation, RetrievedRecord } from "@/lib/types";

type MetricDefinition = {
  label: string;
  pattern: RegExp;
  searchTerms: string[];
  specificity: number;
};

const metricDefinitions: MetricDefinition[] = [
  {
    label: "PAT attributable to equity shareholders",
    pattern: /\bPAT\s+attributable\s+to\s+equity\s+shareholders\b/i,
    searchTerms: ["PAT attributable to equity shareholders"],
    specificity: 4,
  },
  {
    label: "profit before tax",
    pattern: /\b(?:profit before tax|pbt)\b/i,
    searchTerms: ["profit before tax", "pbt"],
    specificity: 3,
  },
  {
    label: "profit after tax",
    pattern: /\b(?:profit after tax|profit for the period|net profit|pat)\b/i,
    searchTerms: ["profit for the period", "profit after tax", "net profit", "pat"],
    specificity: 3,
  },
  {
    label: "revenue",
    pattern: /\b(?:revenue|turnover|sales)\b/i,
    searchTerms: ["revenue", "turnover", "sales"],
    specificity: 2,
  },
  {
    label: "profit",
    pattern: /\bprofit\b/i,
    searchTerms: ["profit"],
    specificity: 1,
  },
  {
    label: "EBITDA",
    pattern: /\bebitda\b/i,
    searchTerms: ["ebitda"],
    specificity: 2,
  },
  {
    label: "earnings per share",
    pattern: /\b(?:eps|earnings per share)\b/i,
    searchTerms: ["eps", "earnings per share"],
    specificity: 2,
  },
  {
    label: "expenses",
    pattern: /\b(?:expenses?|costs?)\b/i,
    searchTerms: ["expense", "cost"],
    specificity: 2,
  },
  {
    label: "dividend",
    pattern: /\bdividend\b/i,
    searchTerms: ["dividend"],
    specificity: 2,
  },
  {
    label: "capital expenditure",
    pattern: /\b(?:capex|capital expenditure)\b/i,
    searchTerms: ["capex", "capital expenditure"],
    specificity: 2,
  },
  {
    label: "cash flow",
    pattern: /\bcash flow\b/i,
    searchTerms: ["cash flow"],
    specificity: 2,
  },
];

const workbookSheetNames = [
  "Read Me",
  "Dashboard",
  "Balance Sheet",
  "Cash Flow",
  "Standalone Results",
  "Consolidated Results",
  "EPS & Ratios",
  "Segment Information",
  "Notes to Results",
  "Filing Checklist",
  "CTC Register",
  "Resolution Index",
  "BR-01 Results",
  "BR-02 Dividend",
  "BR-03 Record Date",
  "BR-04 Capex",
  "BR-05 CFO",
  "BR-06 Authorisation",
  "Dispatch Log",
  "Pre-Issue Checklist",
];

export type NumericQuery = {
  metricLabel: string;
  metricSearchTerms: string[];
  columnSearchTerms?: string[];
  periods: string[];
  fiscalYear: string | null;
  scope: "standalone" | "consolidated" | null;
  compare: boolean;
  bothScopes: boolean;
  rowNumber?: number;
  columnNumber?: number;
  sheetName?: string;
};

export type NumericQueryClassification =
  | { kind: "not_numeric" }
  | { kind: "clarify"; message: string }
  | { kind: "lookup"; query: NumericQuery };

export type NumericLookupResolution =
  | { kind: "answer"; answer: string; records: RetrievedRecord[] }
  | { kind: "abstain"; answer: string; records: [] };

const numericIntentPattern =
  /\b(?:how much|how many|amount|value|figure|number|numeric|compare|versus|vs\.?|increase|decrease|total|reported|what (?:is|was|were|are)|what's)\b/i;
const narrativeIntentPattern =
  /\b(?:why|explain|describe|meaning|definition|recognition|policy|strategy|conclusion|breakdown|trend|commentary|reason|cause|impact|outlook|forecast)\b/i;

function normalizePeriod(period: string): string {
  return period.toLocaleLowerCase("en").replace(/[–/]/g, "-").replace(/\s+/g, " ").trim();
}

function fiscalYearFromMatch(match: string): string {
  const year = match.replace(/^FY\s*/i, "");
  const normalized = year.replace(/[–/]/g, "-");
  if (/^\d{4}-\d{2,4}$/.test(normalized)) return `FY${normalized}`;
  if (/^\d{2}$/.test(normalized)) {
    const endYear = Number(normalized);
    const startYear = (endYear + 99) % 100;
    return `FY20${String(startYear).padStart(2, "0")}-${String(endYear).padStart(2, "0")}`;
  }
  return `FY${normalized}`;
}

function extractPeriods(question: string): { periods: string[]; fiscalYear: string | null } {
  const fiscalMatch = question.match(/\bFY\s*(\d{2}|\d{4}\s*[-–/]\s*\d{2,4})\b/i);
  const fiscalYear = fiscalMatch ? fiscalYearFromMatch(fiscalMatch[0]) : null;
  const periods: string[] = [];

  for (const match of question.matchAll(/\bQ[1-4]\b/gi)) {
    const quarter = match[0].toUpperCase();
    periods.push(fiscalYear ? `${quarter} ${fiscalYear}` : quarter);
  }
  for (const match of question.matchAll(/\bH[1-2]\b/gi)) {
    const half = match[0].toUpperCase();
    periods.push(fiscalYear ? `${half} ${fiscalYear}` : half);
  }
  if (/\bhalf[\s-]*year\b/i.test(question) && !periods.some((period) => /^H[1-2]\b/i.test(period))) {
    periods.push(fiscalYear ? `H1 ${fiscalYear}` : "H1");
  }

  const asAtMatch = question.match(
    /\b(?:as\s+at|as\s+of)\s+(\d{1,2})[-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s](\d{4})\b/i,
  );
  if (asAtMatch) {
    periods.push(
      `As at ${asAtMatch[1].padStart(2, "0")}-${asAtMatch[2][0].toUpperCase()}${asAtMatch[2].slice(1).toLowerCase()}-${asAtMatch[3]}`,
    );
  }

  if (periods.length === 0 && fiscalYear) periods.push(fiscalYear);
  return { periods: [...new Set(periods)], fiscalYear };
}

function extractColumnTerms(question: string): string[] {
  const financialHeader = question.match(
    /\b((?:quarter|half[\s-]*year)\s+ended\s+\d{1,2}[-/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/\s]\d{4})\b/i,
  )?.[1];
  if (financialHeader) return [financialHeader.replace(/\s+/g, " ").trim()];

  const asAtHeader = question.match(
    /\b(as\s+(?:at|of)\s+\d{1,2}[-/\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/\s]\d{4})\b/i,
  )?.[1];
  return asAtHeader ? [asAtHeader.replace(/\s+/g, " ").trim()] : [];
}

function genericMetric(question: string): string[] {
  const excluded = new Set([
    "a", "about", "an", "and", "are", "as", "at", "be", "between", "both", "by", "compare",
    "consolidated", "difference", "for", "from", "give", "how", "in", "is", "it",
    "me", "of", "on", "or", "please", "q1", "q2", "q3", "q4", "h1", "h2",
    "reported", "standalone", "the", "this", "to", "value", "was", "were",
    "what", "when", "where", "which", "who", "with", "versus", "vs", "amount",
    "figure", "number", "numeric", "total", "much", "many", "increased", "decreased",
    "fy", "year", "result", "results", "previous", "prior", "last", "current",
  ]);
  const withoutPeriods = question
    .replace(/\bFY\s*\d{4}\s*[-–/]\s*\d{2,4}\b/gi, " ")
    .replace(/\b(?:as\s+at|as\s+of)\s+\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s]\d{4}\b/gi, " ")
    .replace(/\b\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s]\d{4}\b/gi, " ");
  const words = withoutPeriods.match(/[\p{L}\p{N}]+/gu) || [];
  return words
    .map((term) => term.toLocaleLowerCase("en"))
    .filter((term) => !excluded.has(term));
}

function excelColumnNumber(column: string): number {
  return [...column.toUpperCase()].reduce(
    (value, character) => value * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function coordinateQuery(question: string): NumericQuery | null {
  const rowColumn = question.match(
    /\brow\s*(\d+)\s*(?:,|\band\b)?\s*col(?:umn)?\s*(\d+)\b/i,
  );
  const columnRow = question.match(
    /\bcol(?:umn)?\s*(\d+)\s*(?:,|\band\b)?\s*row\s*(\d+)\b/i,
  );
  const excelCell = question.match(/\bcell\s+([A-Z]{1,3})(\d+)\b/i);
  const rowNumber = rowColumn
    ? Number(rowColumn[1])
    : columnRow
      ? Number(columnRow[2])
      : excelCell
        ? Number(excelCell[2])
        : undefined;
  const columnNumber = rowColumn
    ? Number(rowColumn[2])
    : columnRow
      ? Number(columnRow[1])
      : excelCell
        ? excelColumnNumber(excelCell[1])
        : undefined;
  if (!rowNumber || !columnNumber) return null;

  const sheet = question.match(/\b(?:in|from)\s+(?:the\s+)?([A-Za-z][\w &-]*?\s+Sheet)\b/i)?.[1];
  return {
    metricLabel: "cell",
    metricSearchTerms: [],
    columnSearchTerms: [],
    periods: [],
    fiscalYear: null,
    scope: null,
    compare: false,
    bothScopes: false,
    rowNumber,
    columnNumber,
    ...(sheet ? { sheetName: sheet.trim() } : {}),
  };
}

function sheetOverviewQuery(question: string): NumericQuery | null {
  const sheetName = workbookSheetNames.find((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question),
  );
  if (!sheetName) return null;

  const residual = question
    .replace(new RegExp(`\\b${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), " ")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const overviewWords = new Set([
    "a", "about", "are", "can", "contents", "describe", "does", "give", "in", "include",
    "information", "is", "list", "me", "of", "on", "overview", "please", "show", "sheet",
    "summarise", "summarize", "summary", "tell", "the", "there", "what", "whats", "with",
  ]);
  if (residual.split(/\s+/).some((word) => word && !overviewWords.has(word))) return null;

  return {
    metricLabel: sheetName,
    metricSearchTerms: [],
    periods: [],
    fiscalYear: null,
    scope: null,
    compare: false,
    bothScopes: true,
    sheetName,
  };
}

export function classifyNumericQuery(question: string): NumericQueryClassification {
  const coordinate = coordinateQuery(question);
  if (coordinate) return { kind: "lookup", query: coordinate };
  const sheetOverview = sheetOverviewQuery(question);
  if (sheetOverview) return { kind: "lookup", query: sheetOverview };

  const definitions = metricDefinitions
    .filter((definition) => definition.pattern.test(question))
    .sort((left, right) => right.specificity - left.specificity);
  const matchedDefinitions = definitions.filter((definition) => {
    if (
      definition.label === "profit after tax" &&
      /\bPAT\s+attributable\s+to\s+equity\s+shareholders\b/i.test(question)
    ) {
      return false;
    }
    if (definition.label === "profit") {
      return !definitions.some((other) =>
        other.specificity > definition.specificity &&
        /profit/i.test(other.label),
      );
    }
    return true;
  });
  const { periods, fiscalYear } = extractPeriods(question);
  const columnSearchTerms = extractColumnTerms(question);
  const hasScope = /\b(?:standalone|consolidated|both)\b/i.test(question);
  const explicitNumericRequest =
    /\b(?:how much|how many|amount|value|figure|number|numeric|compare|versus|vs\.?|difference|increase|decrease|total)\b/i
      .test(question);
  const explicitAsAtDate = periods.some((period) => /^As at\b/i.test(period));
  const explicitPeriodHeader = columnSearchTerms.length > 0;
  if (matchedDefinitions.length > 0 && narrativeIntentPattern.test(question) && !explicitNumericRequest) {
    return { kind: "not_numeric" };
  }
  const looksNumeric = explicitNumericRequest || explicitAsAtDate || explicitPeriodHeader ||
    (matchedDefinitions.length > 0 && (numericIntentPattern.test(question) || periods.length > 0 || hasScope));

  if (!looksNumeric) return { kind: "not_numeric" };
  if (matchedDefinitions.length === 0) {
    if (!explicitNumericRequest && !explicitAsAtDate && !explicitPeriodHeader) {
      return { kind: "not_numeric" };
    }
    const terms = genericMetric(explicitPeriodHeader
      ? question.replace(columnSearchTerms[0], " ")
      : question);
    if (terms.length === 0) {
      if (explicitPeriodHeader) {
        return {
          kind: "lookup",
          query: {
            metricLabel: `column ${columnSearchTerms[0]}`,
            metricSearchTerms: [],
            columnSearchTerms,
            periods,
            fiscalYear,
            scope: /\bstandalone\b/i.test(question)
              ? "standalone"
              : /\bconsolidated\b/i.test(question)
                ? "consolidated"
                : null,
            compare: false,
            bothScopes: /\bboth\b/i.test(question),
          },
        };
      }
      return {
        kind: "clarify",
        message: "Which document metric or line item should I look up?",
      };
    }
    return {
      kind: "lookup",
      query: {
        metricLabel: terms.join(" "),
        metricSearchTerms: terms,
        ...(explicitPeriodHeader ? { columnSearchTerms } : {}),
        periods,
        fiscalYear,
        scope: /\bstandalone\b/i.test(question) && /\bconsolidated\b/i.test(question)
          ? null
          : /\bstandalone\b/i.test(question)
            ? "standalone"
            : /\bconsolidated\b/i.test(question)
              ? "consolidated"
              : null,
        compare: /\b(?:compare|versus|vs\.?|difference|between)\b/i.test(question) || periods.length > 1,
        bothScopes: /\bboth\b/i.test(question) ||
          (/\bstandalone\b/i.test(question) && /\bconsolidated\b/i.test(question)),
      },
    };
  }
  if (matchedDefinitions.length > 1) {
    return {
      kind: "clarify",
      message: "Please ask for one metric at a time so I can look up each value against its exact source cell.",
    };
  }

  const definition = matchedDefinitions[0];
  return {
    kind: "lookup",
    query: {
      metricLabel: definition.label,
      metricSearchTerms: definition.searchTerms,
      ...(explicitPeriodHeader ? { columnSearchTerms } : {}),
      periods,
      fiscalYear,
      scope: /\bstandalone\b/i.test(question) && /\bconsolidated\b/i.test(question)
        ? null
        : /\bstandalone\b/i.test(question)
          ? "standalone"
          : /\bconsolidated\b/i.test(question)
            ? "consolidated"
            : null,
      compare: /\b(?:compare|versus|vs\.?|difference|between)\b/i.test(question) || periods.length > 1,
      bothScopes: /\bboth\b/i.test(question) ||
        (/\bstandalone\b/i.test(question) && /\bconsolidated\b/i.test(question)),
    },
  };
}

export function classifyNumericFollowUp(
  question: string,
  previousQuestion: string,
): NumericQueryClassification {
  const current = classifyNumericQuery(question);
  if (current.kind !== "not_numeric") return current;
  const previous = classifyNumericQuery(previousQuestion);
  if (previous.kind !== "lookup") return { kind: "not_numeric" };

  const { periods, fiscalYear } = extractPeriods(question);
  const hasScope = /\b(?:standalone|consolidated|both)\b/i.test(question);
  if (periods.length === 0 && !hasScope) return { kind: "not_numeric" };

  const previousQuery = previous.query;
  const inheritedFiscalYear = fiscalYear || previousQuery.fiscalYear;
  const resolvedPeriods = periods.length > 0
    ? periods.map((period) =>
        /^(?:Q[1-4]|H[1-2])$/i.test(period) && inheritedFiscalYear
          ? `${period.toUpperCase()} ${inheritedFiscalYear}`
          : period)
    : previousQuery.periods;
  const explicitlyBothScopes = /\bboth\b/i.test(question) ||
    (/\bstandalone\b/i.test(question) && /\bconsolidated\b/i.test(question));
  const scope = explicitlyBothScopes
    ? null
    : /\bstandalone\b/i.test(question)
      ? "standalone"
      : /\bconsolidated\b/i.test(question)
        ? "consolidated"
        : previousQuery.scope;
  const explicitScope = hasScope;

  return {
    kind: "lookup",
    query: {
      ...previousQuery,
      periods: resolvedPeriods,
      fiscalYear: inheritedFiscalYear,
      scope,
      compare: /\b(?:compare|versus|vs\.?|difference|between)\b/i.test(question) ||
        periods.length > 1,
      bothScopes: explicitlyBothScopes || (!explicitScope && previousQuery.bothScopes),
    },
  };
}

function getFactLabel(record: RetrievedRecord): string {
  return typeof record.metadata?.row_label === "string"
    ? record.metadata.row_label
    : typeof record.metadata?.metric === "string"
      ? record.metadata.metric
      : "";
}

function getPeriod(record: RetrievedRecord): string {
  return typeof record.metadata?.period === "string"
    ? record.metadata.period
    : typeof record.metadata?.column_header === "string"
      ? record.metadata.column_header
      : "";
}

function includesSearchTerm(label: string, terms: string[]): boolean {
  const words = label.toLocaleLowerCase("en")
    .replace(/^\s*[ivxlcdm]+\.\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/);
  return terms.some((term) => {
    const requestedWords = term.toLocaleLowerCase("en")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/);
    if (requestedWords.length === 0) return false;
    return words.some((_, start) => {
      let candidateIndex = start;
      for (const requestedWord of requestedWords) {
        candidateIndex = words.indexOf(requestedWord, candidateIndex);
        if (candidateIndex < 0) return false;
        candidateIndex += 1;
      }
      return true;
    });
  });
}

function matchingPeriod(record: RetrievedRecord, periods: string[], fiscalYear: string | null): boolean {
  const period = normalizePeriod(getPeriod(record));
  if (periods.length > 0) {
    return periods.some((requested) => {
      const normalized = normalizePeriod(requested);
      return period === normalized ||
        period.startsWith(`${normalized} `) ||
        period.includes(normalized);
    });
  }
  if (fiscalYear) return period.includes(normalizePeriod(fiscalYear));
  return true;
}

function matchingColumnHeader(record: RetrievedRecord, columnSearchTerms: string[]): boolean {
  if (columnSearchTerms.length === 0) return true;
  const columnHeader = record.metadata?.column_header;
  if (typeof columnHeader !== "string") return true;
  const normalizedHeader = normalizePeriod(columnHeader);
  return columnSearchTerms.some((term) => normalizedHeader.includes(normalizePeriod(term)));
}

function clarification(records: RetrievedRecord[]): string {
  const periods = [...new Set(records.map(getPeriod).filter(Boolean))];
  const scopes = [...new Set(records
    .map((record) => record.metadata?.scope)
    .filter((scope): scope is string => typeof scope === "string" && scope.length > 0))];
  const labels = [...new Set(records.map(getFactLabel).filter(Boolean))];
  if (labels.length > 1) {
    return `I found more than one matching metric (${labels.slice(0, 4).join(", ")}). Which metric do you mean?`;
  }
  if (periods.length > 1) {
    return `I found values for multiple periods (${periods.slice(0, 4).join(", ")}). Which reporting period do you mean, or would you like a comparison?`;
  }
  if (scopes.length > 1) {
    return `I found both standalone and consolidated values. Which reporting scope do you want?`;
  }
  return "I found multiple possible source cells. Please specify the reporting period and scope.";
}

function valueText(record: RetrievedRecord): string {
  return typeof record.metadata?.value_text === "string"
    ? record.metadata.value_text
    : "";
}

function unitText(record: RetrievedRecord): string {
  return typeof record.metadata?.unit === "string" ? record.metadata.unit : "";
}

function scopeText(record: RetrievedRecord): string {
  return typeof record.metadata?.scope === "string" ? record.metadata.scope : "";
}

export function resolveNumericLookup(
  query: NumericQuery,
  candidates: RetrievedRecord[],
): NumericLookupResolution {
  if (query.rowNumber !== undefined && query.columnNumber !== undefined) {
    if (candidates.length === 0) {
      return {
        kind: "abstain",
        answer: `I couldn’t find a populated cell at row ${query.rowNumber}, column ${query.columnNumber} in the indexed workbook.`,
        records: [],
      };
    }
    const uniqueCells = new Map(
      candidates.map((record) => [
        `${record.source_filename}:${record.source_location?.sheet}:${record.source_location?.cell}`,
        record,
      ]),
    );
    if (uniqueCells.size !== 1) {
      const sheets = [...new Set(candidates.map((record) =>
        `${record.source_filename} — ${String(record.source_location?.sheet || "unknown sheet")}`))];
      return {
        kind: "abstain",
        answer: `That coordinate exists in multiple indexed workbooks or sheets (${sheets.slice(0, 5).join("; ")}). Which workbook and sheet do you mean?`,
        records: [],
      };
    }
    const record = [...uniqueCells.values()][0];
    const metadata = record.metadata || {};
    const location = record.source_location || {};
    const rowLabel = typeof metadata.row_label === "string" ? metadata.row_label : "Unlabelled row";
    const columnHeader = typeof metadata.column_header === "string"
      ? metadata.column_header
      : `Column ${query.columnNumber}`;
    const value = typeof metadata.value_text === "string" ? metadata.value_text : "";
    if (!value) {
      return {
        kind: "abstain",
        answer: "The requested cell is missing its original value, so I can’t safely report it.",
        records: [],
      };
    }
    const unit = typeof metadata.unit === "string" && metadata.unit ? ` ${metadata.unit}` : "";
    return {
      kind: "answer",
      answer: `At **${String(location.sheet)}!${String(location.cell)}** (row label: “${rowLabel}”; column header: “${columnHeader}”): **${value}${unit}**. [S1]`,
      records: [record],
    };
  }

  if (query.metricSearchTerms.length === 0 && (query.columnSearchTerms?.length || 0) > 0) {
    const header = query.columnSearchTerms?.[0] || "the requested column";
    if (candidates.length === 0) {
      return {
        kind: "abstain",
        answer: `I couldn’t find the column header “${header}” in the indexed workbook cells. The workbook may need to be indexed after the cell-index migration.`,
        records: [],
      };
    }
    const labels = [...new Set(candidates
      .filter((record) => record.result_kind === "fact")
      .map(getFactLabel)
      .filter(Boolean))];
    if (labels.length === 0) {
      return {
        kind: "abstain",
        answer: `I found cells under “${header}”, but their row labels are missing. Please specify a metric or line item.`,
        records: [],
      };
    }
    const preview = labels.slice(0, 10).map((label) => `“${label}”`).join(", ");
    const remainder = labels.length > 10 ? `, and ${labels.length - 10} more` : "";
    return {
      kind: "abstain",
      answer: `I found the column “${header}” with ${candidates.length} matching cells. Which row or metric do you want? Examples: ${preview}${remainder}.`,
      records: [],
    };
  }

  const records = candidates.filter((record) =>
    record.result_kind === "fact" &&
    includesSearchTerm(getFactLabel(record), query.metricSearchTerms) &&
    matchingColumnHeader(record, query.columnSearchTerms || []) &&
    (!query.scope || record.metadata?.scope === query.scope) &&
    (query.columnSearchTerms?.length
      ? true
      : matchingPeriod(record, query.periods, query.fiscalYear)),
  );
  if (records.length === 0) {
    return {
      kind: "abstain",
      answer: `I couldn’t find a structured ${query.metricLabel} value matching the requested period and scope in the indexed documents.`,
      records: [],
    };
  }

  const labels = [...new Set(records.map(getFactLabel))];
  if (labels.length > 1) {
    return { kind: "abstain", answer: clarification(records), records: [] };
  }

  const periods = [...new Set(records.map(getPeriod))];
  if (periods.length > 1 && !query.compare) {
    return { kind: "abstain", answer: clarification(records), records: [] };
  }
  const scopes = [...new Set(records
    .map(scopeText)
    .filter(Boolean))];
  if (!query.scope && scopes.length > 1 && !query.bothScopes) {
    return { kind: "abstain", answer: clarification(records), records: [] };
  }
  if (records.some((record) => !valueText(record))) {
    return {
      kind: "abstain",
      answer: "A matching spreadsheet fact is missing its original value text, so I can’t safely report a number.",
      records: [],
    };
  }
  if (records.length > 1 && !query.compare && !query.bothScopes) {
    return { kind: "abstain", answer: clarification(records), records: [] };
  }

  const answer = records.length === 1
    ? `**${getFactLabel(records[0])}: ${valueText(records[0])}${unitText(records[0]) ? ` ${unitText(records[0])}` : ""}**${getPeriod(records[0]) ? ` for ${getPeriod(records[0])}` : ""}${scopeText(records[0]) ? ` (${scopeText(records[0])})` : ""}. [S1]`
    : [
        "| Metric | Period | Scope | Value |",
        "|---|---|---|---:|",
        ...records.map((record, index) =>
          `| ${getFactLabel(record)} | ${getPeriod(record) || "Not specified"} | ${scopeText(record) || "Not specified"} | ${valueText(record)}${unitText(record) ? ` ${unitText(record)}` : ""} [S${index + 1}] |`),
      ].join("\n");
  return { kind: "answer", answer, records };
}

export function exactFactCitations(
  records: RetrievedRecord[],
): Citation[] {
  return records.map((record, index) => ({
    id: `S${index + 1}`,
    sourceId: record.result_id,
    filename: record.source_filename,
    documentType: record.source_type,
    location: record.source_location || {},
    excerpt: record.content.slice(0, 420),
    kind: "fact",
    score: 1,
  }));
}
