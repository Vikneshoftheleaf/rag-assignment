"""Document transformation helpers. No credentials or network access are used here."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".xlsx"}
CHUNK_TARGET = 1100


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


def _split_oversized_paragraph(paragraph: str) -> list[str]:
    parts: list[str] = []
    remaining = paragraph
    while len(remaining) > CHUNK_TARGET:
        window = remaining[: CHUNK_TARGET + 1]
        sentence_breaks = [
            match.end()
            for match in re.finditer(r"[.!?][\"')\]]*(?:\s+|$)", window)
            if match.end() <= CHUNK_TARGET
        ]
        boundary = sentence_breaks[-1] if sentence_breaks else 0
        if boundary < CHUNK_TARGET // 2:
            whitespace = [match.end() for match in re.finditer(r"\s+", window) if match.end() <= CHUNK_TARGET]
            boundary = whitespace[-1] if whitespace else CHUNK_TARGET
        parts.append(remaining[:boundary])
        remaining = remaining[boundary:]
    if remaining:
        parts.append(remaining)
    return parts


def chunk_text(text: str, *, heading: str = "", location: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Split all source text at semantic boundaries without truncation or overlap loss."""
    clean = re.sub(r"[ \t]+\n", "\n", text).strip()
    if not clean:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", clean) if part.strip()]
    units: list[str] = []
    for paragraph_index, paragraph in enumerate(paragraphs):
        pieces = _split_oversized_paragraph(paragraph)
        for piece_index, piece in enumerate(pieces):
            prefix = "\n\n" if paragraph_index > 0 and piece_index == 0 else ""
            units.append(prefix + piece)

    chunks: list[dict[str, Any]] = []
    current: list[str] = []
    current_size = 0

    def emit() -> None:
        nonlocal current, current_size
        if not current:
            return
        content = "".join(current)
        if heading and not content.startswith(heading):
            content = f"{heading}\n\n{content}"
        chunks.append({
            "content": content,
            "source_location": dict(location or {}),
            "metadata": {"section": heading} if heading else {},
        })
        current, current_size = [], 0

    for unit in units:
        if current and current_size + len(unit) > CHUNK_TARGET:
            emit()
        current.append(unit)
        current_size += len(unit)
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
            lines.append(f"{label}: " + " | ".join(values))
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


def pdfium_fallback_chunks(path: Path) -> list[dict[str, Any]]:
    """Extract page text with PDFium when Docling's native conversion fails."""
    import pypdfium2

    document = pypdfium2.PdfDocument(str(path))
    chunks: list[dict[str, Any]] = []
    try:
        for page_number, page in enumerate(document, start=1):
            text_page = page.get_textpage()
            try:
                page_text = text_page.get_text_range()
            finally:
                text_page.close()
                page.close()
            chunks.extend(
                chunk_text(page_text, location={"page": page_number})
            )
    finally:
        document.close()
    if not chunks:
        raise ValueError(f"PDFium could not extract text from {path.name}")
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
    date = re.search(
        r"\b(\d{1,2})[-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s](\d{4})\b",
        normalized_header,
        re.I,
    )
    if re.search(r"\bas\s+at\b", normalized_header, re.I) and date:
        day, month, year = date.groups()
        return f"As at {int(day):02d}-{month.title()}-{year}"

    explicit = re.search(
        r"\b(Q[1-4]|H[1-2])(?:\s+FY\s*(\d{4}(?:[-–/]\d{2,4})?|\d{2}))?\b",
        normalized_header,
        re.I,
    )
    if explicit:
        period = explicit.group(1).upper()
        fiscal_year = explicit.group(2)
        if fiscal_year:
            normalized_year = fiscal_year.replace("–", "-").replace("/", "-")
            year_digits = re.sub(r"\D", "", normalized_year)
            if len(year_digits) <= 2 and filename_fiscal_year:
                filename_year = filename_fiscal_year.replace("–", "-").replace("/", "-")
                start_year = re.match(r"(\d{4})-(\d{2,4})", filename_year)
                if start_year:
                    start = int(start_year.group(1))
                    end = int(start_year.group(2))
                    end = end if end > 99 else (start // 100) * 100 + end
                    if year_digits == str(start)[-2:]:
                        normalized_year = f"{start - 1}-{str(start)[-2:]}"
                    elif year_digits == str(end)[-2:]:
                        normalized_year = f"{start}-{str(end)[-2:]}"
            return f"{period} FY{normalized_year}"
        if filename_fiscal_year:
            return f"{period} FY{filename_fiscal_year}"
        return period

    header_kind = re.search(r"\b(quarter|half[\s-]*year)\b", normalized_header, re.I)
    period = filename_period.upper() if filename_period else None
    fiscal_year = filename_fiscal_year
    if date:
        month = date.group(2).lower()
        calendar_year = int(date.group(3))
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


_FORMULA_TOKEN = re.compile(
    r"\s*(?:(?P<qualified>'(?:[^']|'')+'!\$?[A-Z]{1,3}\$?\d+)"
    r"|(?P<cell>\$?[A-Z]{1,3}\$?\d+)"
    r"|(?P<number>(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)"
    r"|(?P<identifier>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<operator>[()+\-*/:,])"
    r"|(?P<invalid>.))"
)


class _FormulaEvaluator:
    """Evaluate common numeric workbook formulas without executing arbitrary code."""

    def __init__(self, value_book: Any, formula_book: Any) -> None:
        self.value_book = value_book
        self.formula_book = formula_book
        self.cache: dict[tuple[str, str], float | None] = {}
        self.active: set[tuple[str, str]] = set()

    def cell_value(self, sheet_name: str, coordinate: str) -> float | None:
        coordinate = coordinate.replace("$", "").upper()
        key = (sheet_name, coordinate)
        if key in self.cache:
            return self.cache[key]
        if key in self.active:
            return None

        formula = self.formula_book[sheet_name][coordinate].value
        if isinstance(formula, str) and formula.startswith("="):
            self.active.add(key)
            try:
                result = self.evaluate(formula[1:], sheet_name)
            except (ArithmeticError, ValueError, KeyError, IndexError):
                result = None
            finally:
                self.active.remove(key)
        else:
            value = self.value_book[sheet_name][coordinate].value
            result = 0.0 if value is None else _numeric(value)
        self.cache[key] = result
        return result

    def evaluate(self, formula: str, sheet_name: str) -> float | None:
        tokens: list[tuple[str, str]] = []
        position = 0
        while position < len(formula):
            match = _FORMULA_TOKEN.match(formula, position)
            if not match:
                return None
            position = match.end()
            kind = next((name for name, value in match.groupdict().items() if value is not None), "")
            if kind == "invalid":
                return None
            if kind:
                tokens.append((kind, match.group(kind)))

        class Parser:
            def __init__(
                self,
                evaluator: _FormulaEvaluator,
                formula_tokens: list[tuple[str, str]],
            ) -> None:
                self.evaluator = evaluator
                self.tokens = formula_tokens
                self.index = 0

            def peek(self, value: str | None = None) -> bool:
                if self.index >= len(self.tokens):
                    return False
                return value is None or self.tokens[self.index][1] == value

            def take(self) -> tuple[str, str]:
                if self.index >= len(self.tokens):
                    raise ValueError("Unexpected end of formula")
                token = self.tokens[self.index]
                self.index += 1
                return token

            def parse(self) -> float:
                result = self.expression()
                if self.index != len(self.tokens) or not math.isfinite(result):
                    raise ValueError("Invalid or non-finite formula result")
                return result

            def expression(self) -> float:
                result = self.term()
                while self.peek("+") or self.peek("-"):
                    operator = self.take()[1]
                    right = self.term()
                    result = result + right if operator == "+" else result - right
                return result

            def term(self) -> float:
                result = self.factor()
                while self.peek("*") or self.peek("/"):
                    operator = self.take()[1]
                    right = self.factor()
                    result = result * right if operator == "*" else result / right
                return result

            def reference(self) -> tuple[str, str]:
                kind, value = self.take()
                if kind not in {"cell", "qualified"}:
                    raise ValueError("Expected a cell reference")
                if kind == "qualified":
                    sheet, coordinate = value.rsplit("!", 1)
                    sheet = sheet[1:-1].replace("''", "'")
                else:
                    sheet, coordinate = sheet_name, value
                return sheet, coordinate.replace("$", "").upper()

            def factor(self) -> float:
                if self.peek("+") or self.peek("-"):
                    operator = self.take()[1]
                    value = self.factor()
                    return value if operator == "+" else -value
                if self.peek("("):
                    self.take()
                    value = self.expression()
                    if not self.peek(")"):
                        raise ValueError("Unclosed formula parenthesis")
                    self.take()
                    return value

                kind, value = self.tokens[self.index] if self.index < len(self.tokens) else ("", "")
                if kind == "number":
                    self.take()
                    return float(value)
                if (
                    kind == "identifier"
                    and value.upper() == "SUM"
                    and self.index + 1 < len(self.tokens)
                    and self.tokens[self.index + 1][1] == "("
                ):
                    self.take()
                    self.take()
                    total = 0.0
                    while True:
                        if self.index >= len(self.tokens):
                            raise ValueError("Unclosed SUM")
                        if self.tokens[self.index][0] in {"cell", "qualified"}:
                            first_sheet, first_cell = self.reference()
                            if self.peek(":"):
                                self.take()
                                last_sheet, last_cell = self.reference()
                                if first_sheet != last_sheet:
                                    raise ValueError("SUM ranges cannot cross worksheets")
                                from openpyxl.utils.cell import range_boundaries

                                min_col, min_row, max_col, max_row = range_boundaries(
                                    f"{first_cell}:{last_cell}"
                                )
                                worksheet = self.evaluator.value_book[first_sheet]
                                for row in worksheet.iter_rows(
                                    min_row=min_row,
                                    max_row=max_row,
                                    min_col=min_col,
                                    max_col=max_col,
                                ):
                                    for cell in row:
                                        total += self.evaluator.cell_value(first_sheet, cell.coordinate) or 0
                            else:
                                total += self.evaluator.cell_value(first_sheet, first_cell) or 0
                        else:
                            total += self.expression()
                        if self.peek(","):
                            self.take()
                            continue
                        if not self.peek(")"):
                            raise ValueError("Invalid SUM arguments")
                        self.take()
                        return total
                if (
                    kind == "identifier"
                    and value.upper() == "IFERROR"
                    and self.index + 1 < len(self.tokens)
                    and self.tokens[self.index + 1][1] == "("
                ):
                    self.take()
                    self.take()
                    first_start = self.index
                    depth = 0
                    separator = None
                    closing = None
                    for position in range(first_start, len(self.tokens)):
                        token_value = self.tokens[position][1]
                        if token_value == "(":
                            depth += 1
                        elif token_value == ")":
                            if depth == 0:
                                closing = position
                                break
                            depth -= 1
                        elif token_value == "," and depth == 0 and separator is None:
                            separator = position
                    if separator is None or closing is None:
                        raise ValueError("Invalid IFERROR arguments")
                    first_argument = self.tokens[first_start:separator]
                    fallback_argument = self.tokens[separator + 1:closing]
                    self.index = closing + 1
                    try:
                        return Parser(self.evaluator, first_argument).parse()
                    except (ArithmeticError, ValueError, KeyError, IndexError):
                        return Parser(self.evaluator, fallback_argument).parse()
                if kind in {"cell", "qualified"}:
                    sheet, coordinate = self.reference()
                    value = self.evaluator.cell_value(sheet, coordinate)
                    if value is None:
                        raise ValueError("Formula references a nonnumeric or unavailable cell")
                    return value
                raise ValueError("Unsupported formula")

        try:
            return Parser(self, tokens).parse()
        except (ArithmeticError, ValueError, KeyError, IndexError):
            return None


def spreadsheet_facts(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Read numeric workbook cells, calculating supported formulas without treating blanks as zero."""
    from openpyxl import load_workbook

    value_book = load_workbook(path, read_only=False, data_only=True)
    formula_book = load_workbook(path, read_only=False, data_only=False)
    evaluator = _FormulaEvaluator(value_book, formula_book)
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
            if values_sheet.title.strip().casefold() == "dashboard":
                continue
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
                    calculated_value = evaluator.cell_value(values_sheet.title, formula_cell.coordinate)
                    if calculated_value is None:
                        warnings.append(
                            f"{values_sheet.title}!{formula_cell.coordinate}: formula result is unavailable or unsupported"
                        )
            for row in values_sheet.iter_rows():
                first = next((cell for cell in row if cell.value is not None), None)
                if first is None:
                    continue
                metric = str(first.value).strip()
                if _numeric(first.value) is not None:
                    continue
                headers: dict[int, str] = {}
                if first.row > 1:
                    header_row = first.row - 1
                    for candidate_row in range(first.row - 1, max(0, first.row - 40), -1):
                        candidate_values = [
                            values_sheet.cell(candidate_row, col).value
                            for col in range(2, values_sheet.max_column + 1)
                        ]
                        candidate_text = " ".join(
                            str(value) for value in candidate_values if value is not None
                        )
                        if re.search(
                            r"\b(?:as\s+at|as\s+of|quarter|half[\s-]*year|Q[1-4]|H[1-2]|FY\s*\d{2,4})\b",
                            candidate_text,
                            re.I,
                        ):
                            header_row = candidate_row
                            break
                    for col in range(1, values_sheet.max_column + 1):
                        header_val = values_sheet.cell(header_row, col).value
                        if header_val is not None:
                            headers[col] = str(header_val).strip()
                for column in range(first.column + 1, values_sheet.max_column + 1):
                    from openpyxl.utils import get_column_letter

                    coordinate = f"{get_column_letter(column)}{first.row}"
                    cell_value = values_sheet.cell(row=first.row, column=column).value
                    formula = formula_book[values_sheet.title][coordinate].value
                    formula_evaluated = False
                    if isinstance(formula, str) and formula.startswith("="):
                        number = evaluator.cell_value(values_sheet.title, coordinate)
                        formula_evaluated = number is not None
                    else:
                        number = _numeric(cell_value)
                    if number is None:
                        continue
                    header = headers.get(column, "")
                    period = _financial_period(header, filename_period_text, filename_fiscal_year_text)
                    unit = _financial_unit(header, metric, sheet_context)
                    value_text = (
                        format(number, ".15g")
                        if isinstance(formula, str) and formula.startswith("=")
                        else str(cell_value).strip()
                    )
                    facts.append({
                        "metric": f"{metric} — {header}" if header else metric,
                        "scope": _infer_scope(metric, header, values_sheet.title, path.name),
                        "period": period,
                        "unit": unit,
                        "value_text": value_text,
                        "numeric_value": number,
                        "source_location": {
                            "sheet": values_sheet.title,
                            "row": first.row,
                            "cell": coordinate,
                        },
                        "metadata": {
                            "row_label": metric,
                            "column_header": header,
                            **({"formula": formula, "formula_evaluated": True} if formula_evaluated else {}),
                        },
                    })
    finally:
        value_book.close()
        formula_book.close()
    return facts, warnings


def _spreadsheet_header_row(values: list[Any]) -> bool:
    populated = [value for value in values if value is not None]
    if len(populated) < 2:
        return False
    first = str(populated[0]).strip().casefold()
    recognized_label = bool(re.match(
        r"^(?:particulars?|metric|field|ctc id|item|step|check id|control|"
        r"sr\.?\s*no\.?|resolution no\.?|agenda item|description|parameter|"
        r"segment|share class|cash flow activity|task id|action id)\b",
        first,
    ))
    text = " ".join(str(value) for value in populated if isinstance(value, str))
    has_period_header = bool(re.search(
        r"\b(?:as\s+at|as\s+of|quarter ended|half year ended|Q[1-4]|H[1-2]|FY\s*\d{2,4})\b",
        text,
        re.I,
    ))
    if recognized_label:
        return has_period_header or not any(
            _looks_like_spreadsheet_value(value) for value in populated[1:]
        )
    return has_period_header and len(populated) >= 2


def _looks_like_spreadsheet_value(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)) or _numeric(value) is not None:
        return True
    text = str(value).strip()
    return bool(
        re.search(
            r"\b\d{1,2}[-/\s](?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|"
            r"May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
            r"Nov(?:ember)?|Dec(?:ember)?)[-/\s]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b",
            text,
            re.I,
        )
        or re.fullmatch(r"[A-Z]{2,}(?:[-_/][A-Z0-9]+)+", text, re.I)
    )


def _spreadsheet_form_labels(populated: list[Any]) -> dict[str, tuple[str, str]] | None:
    if len(populated) < 4 or len(populated) % 2:
        return None
    labels = populated[::2]
    values = populated[1::2]
    if any(
        not isinstance(cell.value, str) or _looks_like_spreadsheet_value(cell.value)
        for cell in labels
    ):
        return None
    if not any(_looks_like_spreadsheet_value(cell.value) for cell in values):
        return None

    field_labels: dict[str, tuple[str, str]] = {}
    for label, value in zip(labels, values):
        field_text = _spreadsheet_cell_text(label.value)
        field_labels[label.coordinate] = (field_text, "Field")
        field_labels[value.coordinate] = (field_text, "Value")
    return field_labels


def _spreadsheet_cell_text(value: Any) -> str:
    from datetime import date, datetime

    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        return format(value, ".15g")
    return str(value).strip()


def spreadsheet_cells(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Extract populated cells with row labels and column-header paths."""
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter

    value_book = load_workbook(path, read_only=False, data_only=True)
    formula_book = load_workbook(path, read_only=False, data_only=False)
    evaluator = _FormulaEvaluator(value_book, formula_book)
    cells: list[dict[str, Any]] = []
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
            merged_headers: dict[int, dict[int, str]] = {}
            for merged_range in formulas_sheet.merged_cells.ranges:
                min_col, min_row, max_col, _ = merged_range.bounds
                anchor = formulas_sheet.cell(min_row, min_col).value
                if anchor is not None:
                    for column in range(min_col, max_col + 1):
                        merged_headers.setdefault(min_row, {})[column] = str(anchor).strip()

            header_rows: dict[int, dict[int, str]] = {}
            for row_number in range(1, values_sheet.max_row + 1):
                row_values = [
                    values_sheet.cell(row_number, column).value
                    for column in range(1, values_sheet.max_column + 1)
                ]
                if not _spreadsheet_header_row(row_values):
                    continue
                header_rows[row_number] = {
                    column: (
                        str(values_sheet.cell(row_number, column).value).strip()
                        if values_sheet.cell(row_number, column).value is not None
                        else merged_headers.get(row_number, {}).get(column, "")
                    )
                    for column in range(1, values_sheet.max_column + 1)
                    if values_sheet.cell(row_number, column).value is not None
                    or column in merged_headers.get(row_number, {})
                }

            sheet_context = " ".join(
                str(cell.value).strip()
                for row in values_sheet.iter_rows(min_row=1, max_row=min(5, values_sheet.max_row))
                for cell in row
                if cell.value is not None and not isinstance(cell.value, (int, float, bool))
            )
            active_headers: dict[int, list[str]] = {}
            for row in values_sheet.iter_rows():
                row_number = row[0].row
                if row_number in header_rows:
                    for column, header in header_rows[row_number].items():
                        if header:
                            active_headers.setdefault(column, []).append(header)
                            active_headers[column] = active_headers[column][-3:]
                populated = [
                    cell for cell in row
                    if cell.value is not None or formulas_sheet[cell.coordinate].value is not None
                ]
                if not populated:
                    continue
                first = populated[0]
                row_header = first.row in header_rows
                row_label = _spreadsheet_cell_text(first.value)
                row_header_text = header_rows.get(first.row, {})
                if row_header:
                    row_label = row_header_text.get(first.column, row_label)
                form_labels = None if row_header else _spreadsheet_form_labels(populated)

                for source_cell in populated:
                    coordinate = source_cell.coordinate
                    formula = formulas_sheet[coordinate].value
                    formula_evaluated = False
                    effective_value = source_cell.value
                    if isinstance(formula, str) and formula.startswith("="):
                        evaluated = evaluator.cell_value(values_sheet.title, coordinate)
                        if evaluated is None:
                            warnings.append(
                                f"{values_sheet.title}!{coordinate}: formula result is unavailable or unsupported"
                            )
                        else:
                            effective_value = evaluated
                            formula_evaluated = True

                    value_text = _spreadsheet_cell_text(effective_value)
                    column = source_cell.column
                    cell_row_label = row_label
                    if form_labels and coordinate in form_labels:
                        cell_row_label, form_column_header = form_labels[coordinate]
                        column_headers = [form_column_header]
                    else:
                        column_headers = list(active_headers.get(column, []))
                    if not column_headers:
                        column_headers = [f"Column {get_column_letter(column)}"]
                    column_header = " / ".join(column_headers)
                    period = _financial_period(
                        column_header,
                        filename_period_text,
                        filename_fiscal_year_text,
                    )
                    unit = _financial_unit(column_header, cell_row_label, sheet_context)
                    numeric_value = _numeric(effective_value)
                    cells.append({
                        "sheet_name": values_sheet.title,
                        "row_number": source_cell.row,
                        "column_number": column,
                        "cell_address": coordinate,
                        "row_label": cell_row_label,
                        "column_header": column_header,
                        "column_headers": column_headers,
                        "header_row": max(
                            (row_num for row_num in header_rows if row_num < source_cell.row),
                            default=None,
                        ),
                        "value_text": value_text,
                        "numeric_value": numeric_value,
                        "cell_type": (
                            "formula" if isinstance(formula, str) and formula.startswith("=")
                            else "numeric" if numeric_value is not None
                            else "text"
                        ),
                        "period": period,
                        "scope": _infer_scope(row_label, column_header, values_sheet.title, path.name),
                        "unit": unit,
                        "formula": formula if isinstance(formula, str) and formula.startswith("=") else None,
                        "formula_evaluated": formula_evaluated,
                        "source_location": {
                            "sheet": values_sheet.title,
                            "row": source_cell.row,
                            "column": column,
                            "cell": coordinate,
                        },
                        "metadata": {
                            "row_header_cell": first.coordinate,
                            "row_is_header": row_header,
                            "column_headers": column_headers,
                            **({"formula": formula, "formula_evaluated": formula_evaluated}
                               if isinstance(formula, str) and formula.startswith("=") else {}),
                        },
                    })
    finally:
        value_book.close()
        formula_book.close()
    return cells, warnings


def spreadsheet_chunks(
    path: Path,
    cells: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Create self-contained JSONL evidence records for every worksheet cell."""
    from collections import defaultdict
    from openpyxl.utils import get_column_letter

    if cells is None:
        cells, _ = spreadsheet_cells(path)
    rows: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for cell in cells:
        rows[(cell["sheet_name"], cell["row_number"])].append(cell)

    chunks: list[dict[str, Any]] = []
    for (sheet_name, row_number), row_cells in sorted(rows.items()):
        row_cells.sort(key=lambda cell: cell["column_number"])
        row_label = next(
            (cell["row_label"] for cell in row_cells if cell["row_label"]),
            f"Row {row_number}",
        )
        records = [
            json.dumps(
                {
                    "type": "workbook_cell",
                    "sheet": cell["sheet_name"],
                    "row": cell["row_number"],
                    "row_label": cell["row_label"],
                    "column": get_column_letter(cell["column_number"]),
                    "column_header": cell["column_header"],
                    "cell": cell["cell_address"],
                    "value": cell["value_text"],
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            for cell in row_cells
        ]
        content = "\n\n".join(records)
        location = {
            "sheet": sheet_name,
            "row": row_number,
            "cell": row_cells[0]["cell_address"],
            "cells": [cell["cell_address"] for cell in row_cells],
        }
        row_chunks = chunk_text(content, heading=f"Sheet: {sheet_name}", location=location)
        for item in row_chunks:
            item["metadata"] = {
                **item.get("metadata", {}),
                "sheet": sheet_name,
                "row": row_number,
                "row_label": row_label,
            }
        chunks.extend(row_chunks)
    return chunks


def spreadsheet_manifest(
    path: Path,
    facts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Record an auditable disposition for every worksheet in a workbook."""
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=False, data_only=False)
    facts_by_sheet: dict[str, int] = {}
    for fact in facts:
        sheet = fact.get("source_location", {}).get("sheet")
        if isinstance(sheet, str):
            facts_by_sheet[sheet] = facts_by_sheet.get(sheet, 0) + 1

    manifest: list[dict[str, Any]] = []
    try:
        for worksheet in workbook.worksheets:
            populated_cells = 0
            numeric_cells = 0
            formula_cells = 0
            for row in worksheet.iter_rows():
                for cell in row:
                    value = cell.value
                    if value is None:
                        continue
                    populated_cells += 1
                    if isinstance(value, bool):
                        continue
                    if isinstance(value, (int, float)) or _numeric(value) is not None:
                        numeric_cells += 1
                    if isinstance(value, str) and value.startswith("="):
                        formula_cells += 1

            is_dashboard = worksheet.title.strip().casefold() == "dashboard"
            manifest.append({
                "sheet": worksheet.title,
                "state": worksheet.sheet_state,
                "max_row": worksheet.max_row,
                "max_column": worksheet.max_column,
                "populated_cells": populated_cells,
                "numeric_cells": numeric_cells,
                "formula_cells": formula_cells,
                "structured_fact_count": facts_by_sheet.get(worksheet.title, 0),
                "disposition": (
                    "dashboard_cells" if is_dashboard
                    else "structured_facts" if facts_by_sheet.get(worksheet.title, 0)
                    else "narrative_or_unstructured"
                ),
            })
    finally:
        workbook.close()
    return manifest
