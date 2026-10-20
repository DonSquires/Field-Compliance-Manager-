import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook


class PatrolWorkbookInventoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.xlsx"
        self.exporter = Path(__file__).resolve().parents[1] / "scripts" / "export-patrol-workbook.py"
        workbook = Workbook()
        activity = workbook.active
        activity.title = "DATA"
        activity.append(["Job", "Patroller", "Date", "Location", "Issue", "Issue"])
        activity.append([42, "PRIVATE_ROW_VALUE", "19/10/2026", "A place", "=1+2", None])
        summary = workbook.create_sheet("Summary")
        summary.append(["Metric", "Value"])
        summary.append(["Total", 1])
        workbook.create_sheet("Blank")
        offset = workbook.create_sheet("Offset DATA")
        offset.append(["PRIVATE_PREAMBLE"])
        offset.append([])
        offset.append(["Job", "Patroller", "Date", "Location"])
        offset.append([43, "PRIVATE_ROW_VALUE", "20/10/2026", "Another place"])
        workbook.save(self.source)
        workbook.close()

    def run_exporter(self, *arguments):
        return subprocess.run(
            [sys.executable, str(self.exporter), "--workbook", str(self.source),
             "--source-label", "approved-source.xlsx", *arguments],
            capture_output=True, text=True, check=False,
        )

    def test_inventory_exports_metadata_without_business_rows(self):
        output = self.root / "inventory.json"
        before = self.source.read_bytes()
        result = self.run_exporter("--inventory", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        inventory = json.loads(output.read_text())
        self.assertEqual(inventory["format"], "fcm_patrol_workbook_inventory_v1")
        self.assertEqual(inventory["source_sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(len(inventory["sheets"]), 4)
        activity, summary, blank, offset = inventory["sheets"]
        self.assertTrue(activity["candidate_activity_sheet"])
        self.assertFalse(summary["candidate_activity_sheet"])
        self.assertFalse(blank["candidate_activity_sheet"])
        self.assertEqual(summary["headers"], [])
        self.assertTrue(offset["candidate_activity_sheet"])
        self.assertEqual(offset["header_row"], 3)
        self.assertEqual(activity["headers"].count("Issue"), 2)
        self.assertNotIn("rows", activity)
        self.assertNotIn("PRIVATE_ROW_VALUE", output.read_text())
        self.assertNotIn("PRIVATE_ROW_VALUE", result.stdout)
        self.assertNotIn("PRIVATE_PREAMBLE", output.read_text())
        self.assertEqual(json.loads(result.stdout)["business_rows_exported"], 0)
        self.assertEqual(self.source.read_bytes(), before)

    def test_existing_derivative_export_retains_formulas_and_duplicate_header_identity(self):
        output = self.root / "derivative.json"
        result = self.run_exporter("--sheet", "DATA", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        derivative = json.loads(output.read_text())
        self.assertEqual(derivative["format"], "fcm_patrol_workbook_derivative_v1")
        self.assertEqual(derivative["headers"][-1], "Issue #2")
        self.assertEqual(derivative["rows"][0]["formulas"], [[5, "=1+2"]])

    def test_export_requires_a_sheet_and_refuses_to_overwrite_source(self):
        missing = self.run_exporter("--output", str(self.root / "missing.json"))
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--sheet is required", missing.stderr)
        unchanged = self.source.read_bytes()
        overwrite = self.run_exporter("--inventory", "--output", str(self.source))
        self.assertNotEqual(overwrite.returncode, 0)
        self.assertIn("must not replace", overwrite.stderr)
        self.assertEqual(self.source.read_bytes(), unchanged)


if __name__ == "__main__":
    unittest.main()