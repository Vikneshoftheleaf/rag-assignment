"""CLI that extracts with Docling, embeds through Workers AI, and atomically replaces Supabase indexes."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any

from processor import (
    SUPPORTED_EXTENSIONS,
    checksum_file,
    chunks_from_docling,
    document_type,
    markdown_fallback_chunks,
    pdfium_fallback_chunks,
    spreadsheet_chunks,
    spreadsheet_cells,
    spreadsheet_manifest,
    spreadsheet_facts,
)


def _post_json(url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"HTTP {error.code} from indexing service: {detail}") from error


def embed_texts(texts: list[str], dimensions: int) -> list[list[float]]:
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    model = os.getenv("CF_EMBEDDING_MODEL", "@cf/baai/bge-base-en-v1.5")
    model_path = "/".join(urllib.parse.quote(part, safe="") for part in model.split("/"))
    result: list[list[float]] = []
    for start in range(0, len(texts), 16):
        payload = _post_json(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model_path}",
            {"Authorization": f"Bearer {token}"},
            {"text": texts[start : start + 16]},
        )
        vectors = (payload.get("result") or {}).get("data")
        if not isinstance(vectors, list) or len(vectors) != len(texts[start : start + 16]):
            raise RuntimeError("Cloudflare returned an unexpected embedding batch.")
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != dimensions:
                raise RuntimeError(f"Embedding dimension mismatch; expected {dimensions}.")
            result.append([float(value) for value in vector])
    return result


_STOPWORDS = {
    "about", "after", "again", "against", "also", "among", "been", "before",
    "being", "between", "both", "could", "does", "during", "each", "from",
    "have", "into", "more", "most", "other", "over", "same", "should", "some",
    "such", "than", "that", "their", "there", "these", "they", "this", "those",
    "through", "under", "very", "were", "what", "when", "where", "which",
    "while", "with", "would", "your",
}


def _extracted_terms(content: str, limit: int = 12) -> list[str]:
    terms = re.findall(r"\b[\w][\w&'-]{2,}\b", content, flags=re.UNICODE)
    first_seen: dict[str, str] = {}
    first_positions: dict[str, int] = {}
    counts: Counter[str] = Counter()
    for position, term in enumerate(terms):
        normalized = term.casefold()
        if normalized in _STOPWORDS or normalized.isdigit():
            continue
        counts[normalized] += 1
        first_seen.setdefault(normalized, term)
        first_positions.setdefault(normalized, position)
    return [
        first_seen[term]
        for term in sorted(counts, key=lambda item: (-counts[item], first_positions[item]))[:limit]
    ]


def prepare_retrieval_chunks(
    chunks: list[dict[str, Any]],
    *,
    filename: str,
    document_type_name: str,
) -> list[dict[str, Any]]:
    """Attach source-derived context; never rewrite or omit extracted chunk content."""
    prepared: list[dict[str, Any]] = []
    for chunk in chunks:
        location = chunk.get("source_location") or {}
        section = str(chunk.get("metadata", {}).get("section") or "").strip()
        terms = _extracted_terms(chunk["content"])
        context = [
            f"Document: {filename}",
            f"Type: {document_type_name}",
        ]
        if section:
            context.append(f"Section: {section}")
        for key in ("page", "table", "sheet", "row", "cell"):
            value = location.get(key)
            if value is not None:
                context.append(f"{key.title()}: {value}")
        if terms:
            context.append("Extracted terms: " + ", ".join(terms))

        prepared.append({
            **chunk,
            "metadata": {
                **chunk.get("metadata", {}),
                "retrieval": {
                    "filename": filename,
                    "document_type": document_type_name,
                    "section": section or None,
                    "source_location": location,
                    "extracted_terms": terms,
                },
            },
            "retrieval_text": " ".join(context),
        })
    return prepared


@lru_cache(maxsize=1)
def _document_converter() -> Any:
    from docling.document_converter import DocumentConverter

    return DocumentConverter()


def convert_document(path: Path) -> tuple[dict[str, Any], str]:
    converted = _document_converter().convert(str(path)).document
    exported = converted.export_to_dict()
    markdown = converted.export_to_markdown()
    return exported, markdown


def load_environment(env_file: Path | None = None) -> None:
    from dotenv import load_dotenv

    config_path = env_file or Path(__file__).resolve().parents[1] / ".env.local"
    load_dotenv(config_path, override=False)


def index_document(
    path: Path,
    docs_root: Path,
    dry_run: bool = False,
    pdfium_fallback: bool = False,
) -> tuple[int, int, int]:
    facts: list[dict[str, Any]] = []
    cells: list[dict[str, Any]] = []
    workbook_manifest: list[dict[str, Any]] = []
    if path.suffix.lower() == ".xlsx":
        facts, warnings = spreadsheet_facts(path)
        cells, cell_warnings = spreadsheet_cells(path)
        warnings.extend(cell_warnings)
        chunks = spreadsheet_chunks(path, cells)
        workbook_manifest = spreadsheet_manifest(path, facts)
        for warning in warnings:
            print(f"WARNING: {path.name}: {warning}", file=sys.stderr)
    elif pdfium_fallback:
        if path.suffix.lower() != ".pdf":
            raise ValueError("PDFium fallback can only be used with PDF documents.")
        chunks = pdfium_fallback_chunks(path)
    else:
        exported, markdown = convert_document(path)
        chunks = chunks_from_docling(exported)
        if not chunks:
            chunks = markdown_fallback_chunks(markdown)

    source_path = path.relative_to(docs_root).as_posix()
    doc_type = document_type(path)
    checksum = checksum_file(path)
    if dry_run:
        print(
            f"DRY RUN: {source_path} [{doc_type}] - {len(chunks)} chunks, "
            f"{len(facts)} facts, {len(cells)} workbook cells"
        )
        for sheet in workbook_manifest:
            print(
                f"  SHEET: {sheet['sheet']} - {sheet['disposition']} "
                f"({sheet['structured_fact_count']} facts, {sheet['populated_cells']} populated cells)"
            )
        if workbook_manifest:
            print(f"  CELL INDEX: {len(cells)} populated cells with row/column labels")
        return len(chunks), len(facts), len(cells)

    chunks = prepare_retrieval_chunks(
        chunks,
        filename=path.name,
        document_type_name=doc_type,
    )
    dimensions = int(os.getenv("CF_EMBEDDING_DIMENSIONS", "768"))
    texts = [
        f"{item['content']}\n\n{item['retrieval_text']}".strip()
        for item in chunks
    ]
    texts.extend(
        f"{fact['metric']} {fact.get('scope') or ''} {fact.get('period') or ''} "
        f"{fact.get('unit') or ''} {fact['value_text']}"
        for fact in facts
    )
    vectors = embed_texts(texts, dimensions)
    for index, chunk in enumerate(chunks):
        chunk["chunk_index"] = index
        chunk["embedding"] = vectors[index]
        chunk["search_text"] = chunk.pop("retrieval_text")
    for index, fact in enumerate(facts):
        fact["fact_index"] = index
        fact["embedding"] = vectors[len(chunks) + index]
    for index, cell in enumerate(cells):
        cell["cell_index"] = index

    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    print(
        f"Uploading {source_path}: {len(chunks)} chunks, "
        f"{len(facts)} spreadsheet facts, {len(cells)} workbook cells"
    )
    _post_json(
        f"{base_url}/rest/v1/rpc/replace_document_index_v2",
        {"apikey": key, "Authorization": f"Bearer {key}"},
        {
            "p_source_path": source_path,
            "p_filename": path.name,
            "p_document_type": doc_type,
            "p_checksum": checksum,
            "p_metadata": {
                "sha256": checksum,
                "fictional_corpus": True,
                **({"spreadsheet_manifest": workbook_manifest} if workbook_manifest else {}),
            },
            "p_chunks": chunks,
            "p_facts": facts,
            "p_cells": cells,
        },
    )
    print(
        f"Indexed {source_path}: {len(chunks)} chunks, {len(facts)} spreadsheet facts, "
        f"{len(cells)} workbook cells"
    )
    return len(chunks), len(facts), len(cells)


def main() -> int:
    load_environment()
    parser = argparse.ArgumentParser(description="Index supplied Silverline sample documents.")
    parser.add_argument("--docs-dir", default=os.getenv("DOCS_DIR", "./docs"), type=Path)
    parser.add_argument("--file", type=Path, help="Index one supported document under --docs-dir.")
    parser.add_argument("--dry-run", action="store_true", help="Parse files and report counts without credentials or indexing.")
    parser.add_argument("--pdfium-fallback", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.docs_dir.resolve()
    if not root.is_dir():
        parser.error(f"Documents directory does not exist: {root}")
    if args.file:
        selected_file = args.file.resolve()
        if not selected_file.is_file():
            parser.error(f"Document file does not exist: {selected_file}")
        try:
            selected_file.relative_to(root)
        except ValueError:
            parser.error(f"Document file must be under --docs-dir: {root}")
        if selected_file.suffix.lower() not in SUPPORTED_EXTENSIONS:
            parser.error(f"Unsupported document extension: {selected_file.suffix}")
        paths = [selected_file]
    else:
        paths = sorted(
            path for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        )
    if not paths:
        parser.error(f"No PDF, DOCX, or XLSX files found under {root}")
    if not args.dry_run:
        missing = [
            name for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")
            if not os.getenv(name)
        ]
        if missing:
            parser.error("Missing environment variables: " + ", ".join(missing))

    if not args.file:
        completed_count = 0
        failures: list[Path] = []
        for path in paths:
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--docs-dir",
                str(root),
                "--file",
                str(path),
            ]
            if args.dry_run:
                command.append("--dry-run")
            try:
                result = subprocess.run(command, check=False)
            except OSError as error:
                failures.append(path)
                print(
                    f"ERROR: Could not start indexing process for "
                    f"{path.relative_to(root).as_posix()}: {type(error).__name__}: {error}",
                    file=sys.stderr,
                )
                continue
            if result.returncode != 0 and path.suffix.lower() == ".pdf":
                print(
                    f"WARNING: Docling worker failed for {path.name} "
                    f"(exit code {result.returncode}); retrying text extraction with PDFium.",
                    file=sys.stderr,
                )
                try:
                    fallback_result = subprocess.run(
                        [*command, "--pdfium-fallback"],
                        check=False,
                    )
                except OSError as error:
                    failures.append(path)
                    print(
                        f"ERROR: Could not start PDFium fallback for "
                        f"{path.relative_to(root).as_posix()}: {type(error).__name__}: {error}",
                        file=sys.stderr,
                    )
                    continue
                if fallback_result.returncode == 0:
                    completed_count += 1
                    continue
                result = fallback_result
            if result.returncode == 0:
                completed_count += 1
            else:
                failures.append(path)
                print(
                    f"ERROR: Indexing process failed for {path.relative_to(root).as_posix()} "
                    f"with exit code {result.returncode}.",
                    file=sys.stderr,
                )
        print(
            f"Done: {len(paths)} documents attempted, {completed_count} completed, "
            f"{len(failures)} failed."
        )
        return 1 if failures else 0

    chunk_count = fact_count = cell_count = completed_count = 0
    failures: list[tuple[Path, Exception]] = []
    for path in paths:
        try:
            chunks, facts, cells = index_document(
                path,
                root,
                args.dry_run,
                args.pdfium_fallback,
            )
        except Exception as error:
            failures.append((path, error))
            print(
                f"ERROR: Failed to index {path.relative_to(root).as_posix()}: "
                f"{type(error).__name__}: {error}",
                file=sys.stderr,
            )
            continue
        completed_count += 1
        chunk_count += chunks
        fact_count += facts
        cell_count += cells
    print(
        f"Done: {len(paths)} documents attempted, {completed_count} completed, "
        f"{chunk_count} chunks, {fact_count} facts, {cell_count} workbook cells."
    )
    if failures:
        print(f"Failed documents: {len(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
