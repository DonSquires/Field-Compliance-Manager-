#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from datetime import date, datetime
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError as error:
    raise SystemExit(
        "openpyxl is required. Install scripts/requirements-patrol-import.txt first."
    ) from error


def json_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_value(value):
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() else value
    if isinstance(value, list):
        return [canonical_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: canonical_value(value[key])
            for key in sorted(value)
        }
    return value


def main():
    parser = argparse.ArgumentParser(
        description="Export one patrol workbook sheet into a governed local JSON derivative."
    )
    parser.add_argument("--workbook", required=True)
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-label", required=True)
    parser.add_argument("--header-row", type=int, default=1)
    args = parser.parse_args()

    source_path = Path(args.workbook).resolve()
    output_path = Path(args.output).resolve()
    if args.header_row < 1:
        raise SystemExit("--header-row must be a positive integer")
    if source_path.suffix.lower() != ".xlsx":
        raise SystemExit("Only .xlsx workbooks are supported")

    formulas_book = load_workbook(source_path, read_only=True, data_only=False, keep_links=False)
    values_book = load_workbook(source_path, read_only=True, data_only=True, keep_links=False)
    try:
        if args.sheet not in formulas_book.sheetnames:
            raise SystemExit(f"Sheet not found: {args.sheet}")
        formulas_sheet = formulas_book[args.sheet]
        values_sheet = values_book[args.sheet]
        header_cells = next(
            values_sheet.iter_rows(min_row=args.header_row, max_row=args.header_row)
        )
        raw_headers = [str(cell.value or "").strip() for cell in header_cells]
        header_counts = {}
        headers = []
        for header in raw_headers:
            if not header:
                headers.append("")
                continue
            header_counts[header] = header_counts.get(header, 0) + 1
            ordinal = header_counts[header]
            headers.append(header if ordinal == 1 else f"{header} #{ordinal}")
        if not any(headers):
            raise SystemExit("The selected header row is blank")

        rows = []
        formula_rows = formulas_sheet.iter_rows(min_row=args.header_row + 1)
        value_rows = values_sheet.iter_rows(min_row=args.header_row + 1)
        for source_row, (formula_cells, value_cells) in enumerate(
            zip(formula_rows, value_rows), start=args.header_row + 1
        ):
            values = [json_value(cell.value) for cell in value_cells[: len(headers)]]
            if not any(value not in (None, "") for value in values):
                continue
            formulas = []
            for column_index, cell in enumerate(formula_cells[: len(headers)], start=1):
                if cell.data_type == "f" or (
                    isinstance(cell.value, str) and cell.value.startswith("=")
                ):
                    formulas.append([
                        column_index,
                        cell.value
                        if isinstance(cell.value, str)
                        else getattr(cell.value, "text", str(cell.value)),
                    ])
            rows.append(
                {"source_row": source_row, "values": values, "formulas": formulas}
            )
    finally:
        formulas_book.close()
        values_book.close()

    source_hash = sha256_file(source_path)
    derivative_body = {
        "format": "fcm_patrol_workbook_derivative_v1",
        "source_file": args.source_label,
        "source_sha256": source_hash,
        "source_sheet": args.sheet,
        "header_row": args.header_row,
        "headers": headers,
        "rows": rows,
    }
    canonical = json.dumps(
        canonical_value(derivative_body), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    derivative_body["derivative_sha256"] = hashlib.sha256(canonical).hexdigest()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(derivative_body, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "source_file": args.source_label,
                "source_sheet": args.sheet,
                "source_sha256": source_hash,
                "derivative_sha256": derivative_body["derivative_sha256"],
                "rows": len(rows),
                "output": str(output_path),
            }
        )
    )


if __name__ == "__main__":
    main()
