"""CLI that extracts with Docling, embeds through Workers AI, and atomically replaces Supabase indexes."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import re
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
        with urllib.request.urlopen(request, timeout=60) as response:
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


def index_document(path: Path, docs_root: Path, dry_run: bool = False) -> tuple[int, int]:
    exported, markdown = convert_document(path)
    chunks = chunks_from_docling(exported)
    if not chunks:
        chunks = markdown_fallback_chunks(markdown)
    facts: list[dict[str, Any]] = []
    if path.suffix.lower() == ".xlsx":
        facts, warnings = spreadsheet_facts(path)
        for warning in warnings:
            print(f"WARNING: {path.name}: {warning}", file=sys.stderr)

    source_path = path.relative_to(docs_root).as_posix()
    doc_type = document_type(path)
    checksum = checksum_file(path)
    if dry_run:
        print(f"DRY RUN: {source_path} [{doc_type}] - {len(chunks)} chunks, {len(facts)} facts")
        return len(chunks), len(facts)

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

    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    _post_json(
        f"{base_url}/rest/v1/rpc/replace_document_index",
        {"apikey": key, "Authorization": f"Bearer {key}"},
        {
            "p_source_path": source_path,
            "p_filename": path.name,
            "p_document_type": doc_type,
            "p_checksum": checksum,
            "p_metadata": {"sha256": checksum, "fictional_corpus": True},
            "p_chunks": chunks,
            "p_facts": facts,
        },
    )
    print(f"Indexed {source_path}: {len(chunks)} chunks, {len(facts)} spreadsheet facts")
    return len(chunks), len(facts)


def main() -> int:
    load_environment()
    parser = argparse.ArgumentParser(description="Index supplied Silverline sample documents.")
    parser.add_argument("--docs-dir", default=os.getenv("DOCS_DIR", "./docs"), type=Path)
    parser.add_argument("--dry-run", action="store_true", help="Parse files and report counts without credentials or indexing.")
    args = parser.parse_args()
    root = args.docs_dir.resolve()
    if not root.is_dir():
        parser.error(f"Documents directory does not exist: {root}")
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
    chunk_count = fact_count = 0
    for path in paths:
        chunks, facts = index_document(path, root, args.dry_run)
        chunk_count += chunks
        fact_count += facts
    print(f"Done: {len(paths)} documents, {chunk_count} chunks, {fact_count} facts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
