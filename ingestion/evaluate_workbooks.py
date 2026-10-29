"""Evaluate indexed-workbook extraction against reviewed source-cell answers."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from processor import spreadsheet_cells, spreadsheet_facts, spreadsheet_manifest

GOLD_PATH = Path(__file__).resolve().parent / "tests" / "fixtures" / "workbook_numeric_gold.json"
EXPECTED_WORKBOOK_SHEETS = {
    "Silverline_Industries_Financial_Results_Q2_H1_FY2026-27.xlsx": 10,
    "Silverline_Industries_CTC_Board_Resolutions_Register_and_Templates.xlsx": 11,
}


def evaluate_workbooks(docs_dir: Path) -> dict[str, Any]:
    gold_cases = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    facts_by_filename: dict[str, list[dict[str, Any]]] = {}
    cells_by_filename: dict[str, list[dict[str, Any]]] = {}
    manifests_by_filename: dict[str, list[dict[str, Any]]] = {}
    for filename in sorted(EXPECTED_WORKBOOK_SHEETS):
        path = docs_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Gold workbook is missing: {path}")
        facts, _ = spreadsheet_facts(path)
        cells, _ = spreadsheet_cells(path)
        facts_by_filename[filename] = facts
        cells_by_filename[filename] = cells
        manifests_by_filename[filename] = spreadsheet_manifest(path, facts)

    checks = {
        "value": 0,
        "period": 0,
        "scope": 0,
        "unit": 0,
        "provenance": 0,
        "cell_row_label": 0,
        "cell_column_header": 0,
        "cell_value": 0,
    }
    failures: list[dict[str, Any]] = []
    for case in gold_cases:
        candidates = [
            fact for fact in facts_by_filename[case["filename"]]
            if fact["source_location"].get("sheet") == case["sheet"]
            and fact["source_location"].get("cell") == case["cell"]
        ]
        if len(candidates) != 1:
            failures.append({
                "case": case,
                "error": f"Expected exactly one fact for source cell; found {len(candidates)}",
            })
            continue

        fact = candidates[0]
        cell_candidates = [
            cell for cell in cells_by_filename[case["filename"]]
            if cell["sheet_name"] == case["sheet"]
            and cell["cell_address"] == case["cell"]
        ]
        if len(cell_candidates) != 1:
            failures.append({
                "case": case,
                "error": f"Expected exactly one workbook cell; found {len(cell_candidates)}",
            })
            continue
        workbook_cell = cell_candidates[0]
        checks["cell_row_label"] += int(workbook_cell["row_label"] == case["row_label"])
        checks["cell_column_header"] += int(
            case["column_header"] in workbook_cell["column_headers"]
        )
        checks["cell_value"] += int(
            workbook_cell["value_text"] == case["value_text"]
            and workbook_cell["numeric_value"] == case["numeric_value"]
        )
        checks["value"] += int(
            fact["value_text"] == case["value_text"]
            and math.isclose(fact["numeric_value"], case["numeric_value"], rel_tol=0, abs_tol=0)
        )
        checks["period"] += int(fact["period"] == case["period"])
        checks["scope"] += int(fact["scope"] == case["scope"])
        checks["unit"] += int(fact["unit"] == case["unit"])
        checks["provenance"] += int(
            fact["source_location"].get("row") == int("".join(
                character for character in case["cell"] if character.isdigit()
            ))
            and fact["metadata"].get("row_label") == case["row_label"]
        )
        for field in ("value_text", "period", "scope", "unit"):
            if fact[field] != case[field]:
                failures.append({
                    "case": case,
                    "error": f"{field} mismatch",
                    "actual": fact[field],
                })
        if fact["numeric_value"] != case["numeric_value"]:
            failures.append({
                "case": case,
                "error": "numeric_value mismatch",
                "actual": fact["numeric_value"],
            })
        if fact["metadata"].get("row_label") != case["row_label"]:
            failures.append({
                "case": case,
                "error": "row_label mismatch",
                "actual": fact["metadata"].get("row_label"),
            })
        if workbook_cell["row_label"] != case["row_label"]:
            failures.append({
                "case": case,
                "error": "workbook cell row_label mismatch",
                "actual": workbook_cell["row_label"],
            })
        if case["column_header"] not in workbook_cell["column_headers"]:
            failures.append({
                "case": case,
                "error": "workbook cell column_header mismatch",
                "actual": workbook_cell["column_headers"],
            })
        if (
            workbook_cell["value_text"] != case["value_text"]
            or workbook_cell["numeric_value"] != case["numeric_value"]
        ):
            failures.append({
                "case": case,
                "error": "workbook cell value mismatch",
                "actual": workbook_cell["value_text"],
            })

    workbook_sheets = {filename: len(manifest) for filename, manifest in manifests_by_filename.items()}
    sheet_manifest_passed = workbook_sheets == EXPECTED_WORKBOOK_SHEETS and all(
        sheet["disposition"] in {
            "structured_facts", "narrative_or_unstructured", "dashboard_cells",
        }
        for manifest in manifests_by_filename.values()
        for sheet in manifest
    )
    return {
        "cases": len(gold_cases),
        "checks": {
            name: {
                "passed": passed,
                "total": len(gold_cases),
                "accuracy": passed / len(gold_cases) if gold_cases else 1,
            }
            for name, passed in checks.items()
        },
        "workbook_sheet_counts": workbook_sheets,
        "workbook_cell_counts": {
            filename: len(cells)
            for filename, cells in cells_by_filename.items()
        },
        "worksheet_manifest_passed": sheet_manifest_passed,
        "failures": failures,
        "passed": (
            not failures
            and sheet_manifest_passed
            and all(value == len(gold_cases) for value in checks.values())
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-dir", type=Path, default=Path("docs"))
    args = parser.parse_args()
    result = evaluate_workbooks(args.docs_dir.resolve())
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
