"""Document transformation helpers. No credentials or network access are used here."""

from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path
from typing import Any, Iterable

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".xlsx"}
CHUNK_TARGET = 1100
CHUNK_OVERLAP = 120


def checksum_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def document_type(path: Path) -> str:
    extension = path.suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported document extension: {extension}")
    return extension[1:]


def _provenance(item: dict[str, Any]) -> dict[str, Any]:
    prov = item.get("prov") or item.get("provenance") or []
    if isinstance(prov, dict):
        prov = [prov]
    first = prov[0] if prov and isinstance(prov[0], dict) else {}
    location: dict[str, Any] = {}
    page = first.get("page_no", first.get("page"))
    if page is not None:
        location["page"] = page
    return location


def _item_order(item: dict[str, Any], fallback: int) -> tuple[int, int]:
    location = _provenance(item)
    page = int(location.get("page", 0) or 0)
    ref = str(item.get("self_ref", ""))
    match = re.search(r"/(\d+)$", ref)
    return page, int(match.group(1)) if match else fallback


def chunk_text(text: str, *, heading: str = "", location: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Split text at paragraph boundaries and attach heading/source context."""
    clean = re.sub(r"[ \t]+\n", "\n", text).strip()
    if not clean:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", clean) if part.strip()]
    chunks: list[dict[str, Any]] = []
    current: list[str] = []
    current_size = 0

    def emit() -> None:
        nonlocal current, current_size
        if not current:
            return
        content = "\n\n".join(current)
        if heading and not content.startswith(heading):
            content = f"{heading}\n\n{content}"
        chunks.append({
            "content": content,
            "source_location": dict(location or {}),
            "metadata": {"section": heading} if heading else {},
        })
        if CHUNK_OVERLAP and len(content) > CHUNK_OVERLAP:
            current = [content[-CHUNK_OVERLAP:]]
            current_size = len(current[0])
        else:
            current, current_size = [], 0

    for paragraph in paragraphs:
        if current and current_size + len(paragraph) + 2 > CHUNK_TARGET:
            emit()
        current.append(paragraph)
        current_size += len(paragraph) + 2
    if current:
        emit()
    return chunks


def _text_items(doc: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for key in ("texts", "key_value_items"):
        items = doc.get(key, [])
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and str(item.get("text", "")).strip():
                    yield item


def _table_chunks(doc: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table_index, table in enumerate(doc.get("tables", []) or []):
        if not isinstance(table, dict):
            continue
        data = table.get("data") if isinstance(table.get("data"), dict) else table
        cells = data.get("table_cells") or data.get("cells") or []
        if not isinstance(cells, list) or not cells:
            continue
        rows: dict[int, dict[int, str]] = {}
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            row = cell.get("start_row_offset_idx", cell.get("row", 0))
            col = cell.get("start_col_offset_idx", cell.get("col", 0))
            try:
                row_i, col_i = int(row), int(col)
            except (TypeError, ValueError):
                continue
            value = str(cell.get("text", "")).strip()
            if value:
                rows.setdefault(row_i, {})[col_i] = value
        ordered_rows = [rows[index] for index in sorted(rows)]
        if not ordered_rows:
            continue
        headers = ordered_rows[0]
        lines = []
        for row_index, row in enumerate(ordered_rows):
            values = [row.get(column, "") for column in sorted(set(headers) | set(row))]
            label = "Header" if row_index == 0 else f"Row {row_index}"
            lines.append(f"{label}: " + " | ".join(value for value in values if value))
        location = _provenance(table)
        location["table"] = table_index + 1
        result.append({
            "content": "Table data with headers:\n" + "\n".join(lines),
            "source_location": location,
            "metadata": {"table": table_index + 1},
        })
    return result


def chunks_from_docling(doc: dict[str, Any]) -> list[dict[str, Any]]:
    items = list(_text_items(doc))
    indexed_items = list(enumerate(items))
    indexed_items.sort(key=lambda pair: _item_order(pair[1], pair[0]))
    chunks: list[dict[str, Any]] = []
    heading = ""
    for _, item in indexed_items:
        text = str(item.get("text", "")).strip()
        label = str(item.get("label", "")).lower()
        if "heading" in label or label in {"title", "section_header"}:
            heading = text
            continue
        location = _provenance(item)
        if heading:
            location["section"] = heading
        chunks.extend(chunk_text(text, heading=heading, location=location))
    chunks.extend(_table_chunks(doc))
    return chunks


def markdown_fallback_chunks(markdown: str) -> list[dict[str, Any]]:
    """Fallback for Docling exports that do not include structured text items."""
    chunks: list[dict[str, Any]] = []
    heading = ""
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            chunks.extend(chunk_text("\n\n".join(buffer), heading=heading))
            buffer.clear()

    for line in markdown.splitlines():
        match = re.match(r"^\s{0,3}#{1,6}\s+(.+)$", line)
        if match:
            flush()
            heading = match.group(1).strip()
        elif line.strip():
            buffer.append(line)
        elif buffer and buffer[-1] != "":
            buffer.append("")
    flush()
    return chunks


def _numeric(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        raw = str(value).strip().replace(",", "").replace("₹", "").replace("$", "")
        raw = re.sub(r"(?i)^(rs\.?|inr)\s*", "", raw)
        is_percent = raw.endswith("%")
        raw = raw.rstrip("%").strip()
        if raw.startswith("(") and raw.endswith(")"):
            raw = "-" + raw[1:-1]
        try:
            result = float(raw)
        except ValueError:
            return None
        if is_percent:
            return result
    return result if math.isfinite(result) else None


def _infer_scope(*labels: str) -> str | None:
    text = " ".join(labels).lower()
    if "consolidat" in text or "group" in text:
        return "consolidated"
    if "standalone" in text or "company" in text:
        return "standalone"
    return None


def _financial_period(header: str, filename_period: str | None, filename_fiscal_year: str | None) -> str | None:
    normalized_header = re.sub(r"\s+", " ", header).strip()
    explicit = re.search(
        r"\b(Q[1-4]|H[1-2])(?:\s+FY\s*(\d{4}(?:[-–/]\d{2,4})?|\d{2}))?\b",
        normalized_header,
        re.I,
    )
    if explicit:
        period = explicit.group(1).upper()
        fiscal_year = explicit.group(2)
        if fiscal_year:
            return f"{period} FY{fiscal_year.replace('–', '-').replace('/', '-')}"
        if filename_fiscal_year:
            return f"{period} FY{filename_fiscal_year}"
        return period

    header_kind = re.search(r"\b(quarter|half[\s-]*year)\b", normalized_header, re.I)
    date = re.search(
        r"\b\d{1,2}[-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s](\d{4})\b",
        normalized_header,
        re.I,
    )
    period = filename_period.upper() if filename_period else None
    fiscal_year = filename_fiscal_year
    if date:
        month = date.group(1).lower()
        calendar_year = int(date.group(2))
        fiscal_start = calendar_year if month in {
            "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        } else calendar_year - 1
        fiscal_year = f"{fiscal_start}-{str(fiscal_start + 1)[-2:]}"
    if header_kind:
        period = "H1" if header_kind.group(1).lower().startswith("half") else period
    if period and fiscal_year:
        return f"{period} FY{fiscal_year}"
    return period


def _financial_unit(header: str, metric: str, sheet_context: str) -> str | None:
    measure = f"{header} {metric}"
    normalized_measure = measure.lower()
    context = f"{header} {sheet_context}"
    normalized_context = context.lower()

    currency = "₹" if "₹" in context or re.search(r"\b(?:inr|rs\.?)\b", normalized_context) else (
        "USD" if "$" in context or re.search(r"\busd\b", normalized_context) else ""
    )
    scale_match = re.search(
        r"\b(crore|lakh|million|billion|thousand)\b",
        normalized_measure,
    ) or re.search(r"\b(crore|lakh|million|billion|thousand)\b", normalized_context)
    if "per share" in normalized_measure or re.search(r"\beps\b", normalized_measure):
        return f"{currency} per share".strip() if currency else "per share"
    if "%" in measure or re.search(r"\bpercent(?:age)?\b", normalized_measure):
        return "%"
    if "shares" in normalized_measure and scale_match:
        return f"{scale_match.group(1)} shares"
    if scale_match:
        return f"{currency} {scale_match.group(1)}".strip()
    if currency:
        return currency
    if re.search(r"\btimes\b|\bx\b", normalized_measure):
        return "times"
    return None


def spreadsheet_facts(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Read populated workbook cells; formulas with blank cached results are warnings, not zeroes."""
    from openpyxl import load_workbook

    value_book = load_workbook(path, read_only=True, data_only=True)
    formula_book = load_workbook(path, read_only=True, data_only=False)
    facts: list[dict[str, Any]] = []
    warnings: list[str] = []
    filename_period = re.search(r"(?<![A-Za-z0-9])(Q[1-4]|H[1-2])(?![A-Za-z0-9])", path.stem, re.I)
    filename_fiscal_year = re.search(r"(?<![A-Za-z0-9])FY\s*(\d{4}[-–/]\d{2,4})\b", path.stem, re.I)
    filename_period_text = filename_period.group(1) if filename_period else None
    filename_fiscal_year_text = (
        filename_fiscal_year.group(1).replace("–", "-").replace("/", "-")
        if filename_fiscal_year
        else None
    )
    try:
        for values_sheet in value_book.worksheets:
            formulas_sheet = formula_book[values_sheet.title]
            sheet_context = " ".join(
                str(cell.value).strip()
                for row in values_sheet.iter_rows(min_row=1, max_row=min(5, values_sheet.max_row))
                for cell in row
                if cell.value is not None and not isinstance(cell.value, (int, float, bool))
            )
            for formula_row in formulas_sheet.iter_rows():
                for formula_cell in formula_row:
                    if not (
                        isinstance(formula_cell.value, str)
                        and formula_cell.value.startswith("=")
                    ):
                        continue
                    cached_value = values_sheet.cell(formula_cell.row, formula_cell.column).value
                    if cached_value is None:
                        warnings.append(
                            f"{values_sheet.title}!{formula_cell.coordinate}: formula has no cached result; left unavailable"
                        )
            for row in values_sheet.iter_rows():
                populated = [cell for cell in row if cell.value is not None]
                if not populated:
                    continue
                first = populated[0]
                metric = str(first.value).strip()
                if _numeric(first.value) is not None:
                    continue
                headers: dict[int, str] = {}
                if first.row > 1:
                    for col in range(1, values_sheet.max_column + 1):
                        header_val = values_sheet.cell(first.row - 1, col).value
                        if header_val is not None:
                            headers[col] = str(header_val).strip()
                for cell in populated[1:]:
                    number = _numeric(cell.value)
                    if number is None:
                        continue
                    header = headers.get(cell.column, "")
                    period = _financial_period(header, filename_period_text, filename_fiscal_year_text)
                    unit = _financial_unit(header, metric, sheet_context)
                    value_text = str(cell.value).strip()
                    facts.append({
                        "metric": f"{metric} — {header}" if header else metric,
                        "scope": _infer_scope(metric, header, values_sheet.title, path.name),
                        "period": period,
                        "unit": unit,
                        "value_text": value_text,
                        "numeric_value": number,
                        "source_location": {
                            "sheet": values_sheet.title,
                            "row": cell.row,
                            "cell": cell.coordinate,
                        },
                        "metadata": {"row_label": metric, "column_header": header},
                    })
    finally:
        value_book.close()
        formula_book.close()
    return facts, warnings
