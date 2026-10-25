import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from processor import chunk_text, chunks_from_docling, document_type, markdown_fallback_chunks


class ProcessorTests(unittest.TestCase):
    def test_heading_and_pdf_page_are_preserved(self):
        doc = {
            "texts": [
                {"label": "section_header", "text": "Results", "prov": [{"page_no": 4}]},
                {"label": "text", "text": "Revenue increased.\n\nOperating costs were stable.", "prov": [{"page_no": 4}]},
            ],
            "tables": [],
        }
        chunks = chunks_from_docling(doc)
        self.assertEqual(len(chunks), 1)
        self.assertIn("Results", chunks[0]["content"])
        self.assertEqual(chunks[0]["source_location"]["page"], 4)
        self.assertEqual(chunks[0]["metadata"]["section"], "Results")

    def test_table_rows_retain_header_and_location(self):
        doc = {
            "texts": [],
            "tables": [{
                "prov": [{"page_no": 2}],
                "data": {"table_cells": [
                    {"start_row_offset_idx": 0, "start_col_offset_idx": 0, "text": "Metric"},
                    {"start_row_offset_idx": 0, "start_col_offset_idx": 1, "text": "H1"},
                    {"start_row_offset_idx": 1, "start_col_offset_idx": 0, "text": "Revenue"},
                    {"start_row_offset_idx": 1, "start_col_offset_idx": 1, "text": "100"},
                ]},
            }],
        }
        chunks = chunks_from_docling(doc)
        self.assertIn("Metric | H1", chunks[0]["content"])
        self.assertIn("Revenue | 100", chunks[0]["content"])
        self.assertEqual(chunks[0]["source_location"]["page"], 2)
        self.assertEqual(chunks[0]["source_location"]["table"], 1)

    def test_long_text_chunks_without_losing_source_metadata(self):
        chunks = chunk_text("\n\n".join(["Evidence text."] * 140), heading="Minutes", location={"section": "Minutes"})
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(item["source_location"]["section"] == "Minutes" for item in chunks))

    def test_markdown_fallback_tracks_heading(self):
        chunks = markdown_fallback_chunks("# Board outcome\n\nThe board approved the report.")
        self.assertIn("Board outcome", chunks[0]["content"])
        self.assertEqual(chunks[0]["metadata"]["section"], "Board outcome")

    def test_extension_validation(self):
        self.assertEqual(document_type(Path("report.PDF")), "pdf")
        with self.assertRaises(ValueError):
            document_type(Path("notes.txt"))

    def test_spreadsheet_facts_keep_row_cell_period_scope_and_units(self):
        from openpyxl import Workbook
        from processor import spreadsheet_facts

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Consolidated"
            sheet.append(["Metric", "H1 FY2026-27 (₹ Crore)"])
            sheet.append(["Revenue", 125.5])
            sheet.append(["EBITDA", "=SUM(B2:B2)"])
            workbook.save(path)

            facts, warnings = spreadsheet_facts(path)
            self.assertEqual(len(facts), 1)
            self.assertEqual(facts[0]["metric"], "Revenue — H1 FY2026-27 (₹ Crore)")
            self.assertEqual(facts[0]["scope"], "consolidated")
            self.assertEqual(facts[0]["period"], "H1 FY2026-27")
            self.assertEqual(facts[0]["unit"], "₹ crore")
            self.assertEqual(facts[0]["numeric_value"], 125.5)
            self.assertEqual(facts[0]["source_location"], {"sheet": "Consolidated", "row": 2, "cell": "B2"})
            self.assertTrue(any("B3" in warning and "unavailable" in warning for warning in warnings))

    def test_financial_facts_keep_quarter_comparatives_and_inherited_units(self):
        from openpyxl import Workbook
        from processor import spreadsheet_facts

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results_Q2_H1_FY2026-27.xlsx"
            workbook = Workbook()
            standalone = workbook.active
            standalone.title = "Standalone Results"
            consolidated = workbook.create_sheet("Consolidated Results")

            for sheet, values in (
                (standalone, [1245.6, 1108.2, 2430.8, 2165.4]),
                (consolidated, [1378.4, 1216.7, 2690.5, 2381.2]),
            ):
                sheet["A1"] = "UNAUDITED FINANCIAL RESULTS"
                sheet["A2"] = "₹ crore except EPS"
                sheet.append([])
                sheet.append([])
                sheet.append([])
                sheet.append([
                    "Particulars",
                    "Quarter ended 30-Sep-2026",
                    "Quarter ended 30-Sep-2025",
                    "Half year ended 30-Sep-2026",
                    "Half year ended 30-Sep-2025",
                ])
                sheet.append(["Revenue from operations", *values])
                sheet.append(["Basic EPS", 12.5, 11.1, 23.4, 21.6])

            workbook.save(path)
            facts, _ = spreadsheet_facts(path)

        revenue_facts = [fact for fact in facts if "Revenue from operations" in fact["metric"]]
        eps_facts = [fact for fact in facts if "Basic EPS" in fact["metric"]]
        self.assertEqual(len(revenue_facts), 8)
        self.assertEqual(len(eps_facts), 8)
        self.assertTrue(all(fact["unit"] == "₹ per share" for fact in eps_facts))
        self.assertEqual(
            [(fact["period"], fact["unit"], fact["value_text"]) for fact in revenue_facts[:4]],
            [
                ("Q2 FY2026-27", "₹ crore", "1245.6"),
                ("Q2 FY2025-26", "₹ crore", "1108.2"),
                ("H1 FY2026-27", "₹ crore", "2430.8"),
                ("H1 FY2025-26", "₹ crore", "2165.4"),
            ],
        )
        self.assertEqual(
            [fact["scope"] for fact in revenue_facts],
            ["standalone"] * 4 + ["consolidated"] * 4,
        )
        self.assertEqual(
            [fact["numeric_value"] for fact in revenue_facts[4:]],
            [1378.4, 1216.7, 2690.5, 2381.2],
        )


if __name__ == "__main__":
    unittest.main()
