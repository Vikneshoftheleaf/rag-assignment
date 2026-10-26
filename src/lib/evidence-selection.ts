import type { RetrievedRecord } from "@/lib/types";

const metricPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "revenue", pattern: /\b(?:revenue|turnover|sales)\b/i },
  { name: "profit", pattern: /\b(?:profit|earnings|net income|pat|pbt)\b/i },
  { name: "expense", pattern: /\b(?:expenses?|costs?)\b/i },
  { name: "income", pattern: /\b(?:income|ebitda|margin|eps|tax)\b/i },
  { name: "dividend", pattern: /\bdividend\b/i },
  { name: "capex", pattern: /\b(?:capex|capital expenditure)\b/i },
  { name: "cash flow", pattern: /\bcash flow\b/i },
];

function recordText(record: RetrievedRecord): string {
  const metadata = record.metadata || {};
  const location = record.source_location || {};
  return [
    record.content,
    record.source_filename,
    metadata.section,
    metadata.row_label,
    metadata.metric,
    location.section,
  ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase("en");
}

function isFinancialMetricQuery(question: string): boolean {
  return metricPatterns.some(({ pattern }) => pattern.test(question));
}

function metricValue(record: RetrievedRecord): string {
  return [
    record.metadata?.row_label,
    record.metadata?.metric,
    record.content,
  ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase("en");
}

function requestedPeriods(question: string): string[] {
  const periods: string[] = [];
  for (const match of question.matchAll(/\bQ[1-4]\b/gi)) periods.push(match[0].toUpperCase());
  for (const match of question.matchAll(/\bH[1-2]\b/gi)) periods.push(match[0].toUpperCase());
  if (/\bhalf[\s-]*year\b/i.test(question) && !periods.some((period) => /^H[1-2]$/.test(period))) {
    periods.push("H1");
  }
  return [...new Set(periods)];
}

function periodValue(record: RetrievedRecord): string {
  return typeof record.metadata?.period === "string"
    ? record.metadata.period
    : typeof record.metadata?.column_header === "string"
      ? record.metadata.column_header
      : record.content;
}

function selectMetricEvidence(
  question: string,
  ordered: Array<{ record: RetrievedRecord; index: number; score: number }>,
  limit: number,
): RetrievedRecord[] {
  const requestedMetrics = metricPatterns.filter(({ pattern }) => pattern.test(question));
  const periods = requestedPeriods(question);
  const fiscalYear = question.match(/\bFY\s*(\d{4}[-–/]\d{2,4})\b/i)?.[1]
    ?.replace(/[–/]/g, "-");
  const scopes = [
    /\bstandalone\b/i.test(question) ? "standalone" : "",
    /\bconsolidated\b/i.test(question) ? "consolidated" : "",
  ].filter(Boolean);
  const required: RetrievedRecord[] = [];

  for (const metric of requestedMetrics) {
    for (const period of periods.length ? periods : [""]) {
      for (const scope of scopes.length ? scopes : [""]) {
        const candidates = ordered.filter(({ record }) => {
          if (record.result_kind !== "fact" || !metric.pattern.test(metricValue(record))) return false;
          const periodText = periodValue(record);
          if (period && !new RegExp(`\\b${period}\\b`, "i").test(periodText)) return false;
          if (fiscalYear && !periodText.replace(/[–/]/g, "-").includes(fiscalYear)) return false;
          if (scope && record.metadata?.scope !== scope) return false;
          return true;
        }).sort((left, right) => {
          const quality = (candidate: RetrievedRecord) => {
            if (metric.name !== "profit") return 0;
            const text = metricValue(candidate);
            if (/profit for the period|profit after tax|net profit|\bpat\b/.test(text)) return 0.3;
            if (/profit before tax|\bpbt\b/.test(text)) return 0.1;
            return 0;
          };
          return quality(right.record) - quality(left.record) ||
            right.score - left.score || left.index - right.index;
        });
        const candidate = candidates[0]?.record;
        if (candidate && !required.some((record) => record.result_id === candidate.result_id)) {
          required.push(candidate);
        }
      }
    }
  }

  const remainder = ordered
    .map(({ record }) => record)
    .filter((record) => {
      if (record.result_kind === "fact") {
        if (requestedMetrics.some(({ pattern }) => pattern.test(metricValue(record)))) return false;
        const periodText = periodValue(record).replace(/[–/]/g, "-");
        if (fiscalYear && /\bFY\s*\d{4}-\d{2,4}\b/i.test(periodText) && !periodText.includes(fiscalYear)) {
          return false;
        }
        if (periods.length && !periods.some((period) =>
          new RegExp(`\\b${period}\\b`, "i").test(periodText))) {
          return false;
        }
      }
      return !required.some((requiredRecord) => requiredRecord.result_id === record.result_id);
    });
  return [...required, ...remainder].slice(0, Math.min(limit, ordered.length));
}

function selectBoardEvidence(
  ordered: Array<{ record: RetrievedRecord; index: number; score: number }>,
  limit: number,
): RetrievedRecord[] {
  const itemRecords = new Map<number, RetrievedRecord[]>();
  for (const { record } of ordered) {
    if (record.result_kind !== "chunk") continue;
    const match = recordText(record).match(/\bitem\s+(\d+)\b/);
    if (!match) continue;
    const item = Number(match[1]);
    const records = itemRecords.get(item) || [];
    records.push(record);
    itemRecords.set(item, records);
  }

  const prioritized: RetrievedRecord[] = [];
  const items = [...itemRecords.keys()].sort((left, right) => left - right);
  for (const item of items) {
    const first = itemRecords.get(item)?.[0];
    if (first) prioritized.push(first);
  }
  const additionalItemRecords = items.flatMap((item) => itemRecords.get(item)?.slice(1) || []);
  additionalItemRecords.sort((left, right) => right.score - left.score);
  prioritized.push(...additionalItemRecords);
  const remainder = ordered
    .map(({ record }) => record)
    .filter((record) => !prioritized.some((priority) => priority.result_id === record.result_id));
  return [...prioritized, ...remainder].slice(0, Math.min(limit, ordered.length));
}

function scoreRecord(question: string, record: RetrievedRecord): number {
  const text = recordText(record);
  const questionLower = question.toLocaleLowerCase("en");
  let score = Number(record.score) || 0;

  if (/\b(?:auditor|audit|limited review|review report|opinion|conclusion)\b/i.test(question)) {
    if (/auditor|limited.review.report/.test(text)) score += 0.45;
    if (/\bconclusion\b/.test(text)) score += 0.55;
    if (record.result_kind === "fact") score -= 0.7;
  }

  if (/\b(?:board|meeting|decision|resolution|follow.up|action)\b/i.test(question)) {
    if (/board_meeting_minutes|board meeting minutes/.test(text)) score += 0.2;
    if (/\b(?:item \d+|summary of resolutions|action items|decision)\b/.test(text)) score += 0.2;
  }

  const requestedMetrics = metricPatterns.filter(({ pattern }) => pattern.test(question));
  if (requestedMetrics.length > 0 && record.result_kind === "fact") {
    const metric = [
      record.metadata?.row_label,
      record.metadata?.metric,
      record.content,
    ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase("en");
    const matchesMetric = requestedMetrics.some(({ pattern }) => pattern.test(metric));
    score += matchesMetric ? 0.7 : -0.35;

    const requestedQuarter = /\bq[1-4]\b/i.test(question);
    const requestedHalf = /\bh[1-2]\b|\bhalf[\s-]*year\b/i.test(question);
    const period = typeof record.metadata?.period === "string"
      ? record.metadata.period
      : typeof record.metadata?.column_header === "string"
        ? record.metadata.column_header
        : "";
    if (requestedQuarter && /\bq[1-4]\b/i.test(period)) score += 0.15;
    if (requestedHalf && /\bh[1-2]\b|half[\s-]*year/i.test(period)) score += 0.15;
    if (/\bFY\s*2026[-–/]27\b/i.test(question) && /2026[-–/]27|FY27/i.test(period)) score += 0.15;
    if (/\bFY\s*2026[-–/]27\b/i.test(question) && /2025[-–/]26|FY26/i.test(period)) score -= 0.2;
    if (/\bstandalone\b/i.test(question) && record.metadata?.scope === "standalone") score += 0.1;
    if (/\bconsolidated\b/i.test(question) && record.metadata?.scope === "consolidated") score += 0.1;
  }

  if (questionLower.includes("auditor") && /financial results/.test(text)) score += 0.05;
  return score;
}

export function selectEvidence(
  question: string,
  records: RetrievedRecord[],
  limit = 16,
): RetrievedRecord[] {
  const ordered = records
    .map((record, index) => ({ record, index, score: scoreRecord(question, record) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (isFinancialMetricQuery(question)) {
    return selectMetricEvidence(question, ordered, limit);
  }

  if (
    /\b(?:board|meeting)\b/i.test(question) &&
    /\b(?:decision|resolution|action|follow[\s-]*up|summari[sz]e|all)\b/i.test(question)
  ) {
    return selectBoardEvidence(ordered, limit);
  }

  return ordered.slice(0, Math.min(limit, records.length)).map(({ record }) => record);
}
