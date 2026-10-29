import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate_workbooks import evaluate_workbooks


class WorkbookEvaluationTests(unittest.TestCase):
    def test_reviewed_real_workbook_cases_have_exact_values_and_provenance(self):
        docs_dir = Path(__file__).resolve().parents[2] / "docs"
        result = evaluate_workbooks(docs_dir)

        self.assertTrue(result["passed"], result["failures"])
        self.assertEqual(result["cases"], 6)
        self.assertEqual(
            result["workbook_sheet_counts"][
                "Silverline_Industries_Financial_Results_Q2_H1_FY2026-27.xlsx"
            ],
            10,
        )
        self.assertEqual(
            result["workbook_sheet_counts"][
                "Silverline_Industries_CTC_Board_Resolutions_Register_and_Templates.xlsx"
            ],
            11,
        )
        self.assertTrue(result["worksheet_manifest_passed"])


if __name__ == "__main__":
    unittest.main()
