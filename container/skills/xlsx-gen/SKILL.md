---
name: xlsx-gen
description: Generate professional Excel (.xlsx) files with openpyxl + pandas, following industry-standard financial modeling conventions. Use this whenever the deliverable is a real spreadsheet file (not CSV text, not an HTML table) and the client will open it in Excel/Numbers/Google Sheets.
allowed-tools: Bash(python3:*), Bash(pip3:*), Read, Write
---

# Excel Generator (openpyxl + pandas)

Write Python directly. There is no CLI wrapper — `openpyxl` and `pandas` are pre-installed in the container. This skill teaches you the style, not a command.

## When to use

- User asks for an `.xlsx` file, spreadsheet, cotización, budget, financial model, inventory, report.
- Output must be a real binary `.xlsx` — never deliver CSV text when an Excel file was requested.
- NOT for: HTML tables, Google Sheets API, read-only analysis of existing files (use `office-reader` for reading).

## Minimal template

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Resumen"

# Headers
ws["A1"] = "Concepto"
ws["B1"] = "Cantidad"
ws["C1"] = "Precio unitario ($)"
ws["D1"] = "Total ($)"

# Data rows (only inputs are hardcoded — totals are formulas)
ws.append(["Camiseta", 10, 250])
ws.append(["Gorra", 5, 180])
ws.append(["Sticker", 100, 15])

# Totals column — always a formula
for row in range(2, 5):
    ws[f"D{row}"] = f"=B{row}*C{row}"

# Grand total
ws["C6"] = "Total"
ws["D6"] = "=SUM(D2:D4)"

wb.save("/workspace/group/cotizacion.xlsx")
```

## Required style — financial / business files

Unless the user gives you a template or explicit colors, apply these defaults. They are the conventions professional analysts expect to see:

### Font

- **Arial 10pt** or **Calibri 11pt** (openpyxl default is Calibri — OK to leave).
- Headers: bold.
- No mixed fonts in the same workbook.

### Color coding (text color)

| Cell type | Color | RGB | Why |
|---|---|---|---|
| Hardcoded input (rate, qty, price) | Blue | `0000FF` | User can change it |
| Formula / calculation | Black | `000000` | Derived, don't touch |
| Link to another sheet in same workbook | Green | `008000` | Internal reference |
| Link to external file | Red | `FF0000` | External dependency |

### Cell background

- **Yellow** `FFFF00` for key assumptions that need the user's attention (growth rate, discount %, deadline).
- **Light gray** `F2F2F2` for header rows.
- Nothing else — no rainbow spreadsheets.

```python
from openpyxl.styles import Font, PatternFill

BLUE_INPUT = Font(name="Arial", size=10, color="0000FF")
BLACK_FORMULA = Font(name="Arial", size=10, color="000000")
HEADER = Font(name="Arial", size=10, bold=True)
HEADER_FILL = PatternFill("solid", start_color="F2F2F2")
KEY_ASSUMPTION = PatternFill("solid", start_color="FFFF00")

ws["B2"].font = BLUE_INPUT       # hardcoded quantity
ws["D2"].font = BLACK_FORMULA    # =B2*C2
ws["A1"].font = HEADER
ws["A1"].fill = HEADER_FILL
```

### Number formats

Use `cell.number_format = "..."`. Required formats:

| Thing | Format string | Looks like |
|---|---|---|
| Currency (MXN/USD) | `"$#,##0.00;($#,##0.00);-"` | `$1,234.56` / `(1,234.56)` / `-` |
| Currency (integer) | `"$#,##0;($#,##0);-"` | `$1,234` / `(1,234)` / `-` |
| Percentage | `"0.0%"` | `12.5%` |
| Multiple (P/E, EV/EBITDA) | `"0.0x"` | `3.5x` |
| Quantity (integer) | `"#,##0"` | `1,234` |
| Year | `"0"` or plain text `"2024"` | `2024` (NOT `2,024`) |
| Date | `"yyyy-mm-dd"` | `2026-04-17` |

Zeros must display as `-`, not `$0.00` — that's what the `;-` at the end of the format does. Negatives use parentheses, not minus signs.

```python
ws["D2"].number_format = "$#,##0.00;($#,##0.00);-"
ws["E2"].number_format = "0.0%"
```

## Formula rules

1. **Never hardcode a calculated value.** If it can be computed, write it as a formula. Totals, percentages, differences, averages — all formulas.

   ```python
   # ❌ Wrong — Python calculated, user can't update source
   ws["D10"] = sum(values)

   # ✅ Right — Excel calculates, stays live
   ws["D10"] = "=SUM(D2:D9)"
   ```

2. **Every assumption in its own cell.** Don't embed `1.05` inside a formula; put `0.05` in cell `B3` labeled "Growth rate", then `=B2*(1+$B$3)`. The client changes one cell and the whole model updates.

3. **Use absolute refs (`$B$3`) for assumptions** copied across columns/rows.

4. **Cross-sheet refs**: `='Assumptions'!B3` (note single quotes when sheet name has spaces).

5. **Document hardcoded values** with a comment or an adjacent "Source" column when the number came from outside:
   ```python
   from openpyxl.comments import Comment
   ws["B3"].comment = Comment("Source: 10-K FY2024, page 45", "agent")
   ```

## Column widths

Auto-sizing is painful in openpyxl. Set explicit widths based on content:

```python
ws.column_dimensions["A"].width = 30   # labels
ws.column_dimensions["B"].width = 12   # quantity
ws.column_dimensions["C"].width = 14   # price
ws.column_dimensions["D"].width = 14   # total
```

A good default: label columns 25-35, numeric columns 12-16.

## Sheet organization for financial models

For anything more complex than a flat list, use this layout:

| Sheet | Purpose |
|---|---|
| `Resumen` / `Summary` | One-page overview, key numbers, all formulas referencing other sheets |
| `Supuestos` / `Assumptions` | All blue inputs in one place. Client edits here, everything else recalculates |
| `Cálculos` / `Working` | Line-by-line computations, intermediate results |
| `Datos` / `Data` | Raw data dumps — what pandas typically writes |

## pandas → openpyxl hand-off

pandas is fine for writing raw data. Use openpyxl for formatting and formulas:

```python
import pandas as pd
from openpyxl import load_workbook

df.to_excel("/workspace/group/report.xlsx", sheet_name="Datos", index=False)

wb = load_workbook("/workspace/group/report.xlsx")
ws = wb["Datos"]
# Now add formatting, formulas, other sheets...
wb.save("/workspace/group/report.xlsx")
```

## Validation before delivery

openpyxl writes formulas as strings — Excel recalculates them when the client opens the file. You will not see the computed values during creation.

Before saving, self-check by walking formulas mentally:
- All `SUM(range)` ranges cover the intended rows.
- No divisions where the denominator could be zero without an `IFERROR`.
- No references to cells outside the data block.
- No `=A1+A2` style formulas where `SUM(A1:A2)` would be cleaner.

If you need hard validation (catch `#REF!`/`#DIV/0!` before sending), run `scripts/recalc.py` — it uses LibreOffice (pre-installed) to recalculate and scan for errors:

```bash
python3 .claude/skills/xlsx-gen/scripts/recalc.py /workspace/group/cotizacion.xlsx
```

Returns JSON with `status`, `total_errors`, and error locations. Fix any errors before delivery.

## Delivery

Save to `/workspace/group/<slug>.xlsx` and send via the nanoclaw MCP:

```
mcp__nanoclaw__send_message({
  text: "Aquí tu cotización",
  document_path: "/workspace/group/cotizacion.xlsx"
})
```

## Future addon (not included) — pack/unpack utilities

Anthropic's official `xlsx` skill ships two extras we deliberately skipped: `pack.py` and `unpack.py`. They convert a workbook to/from a plain-text structured representation (YAML-ish) so the agent can edit complex existing files surgically — change cell formulas, insert rows, rewrite formatting — without loading the whole binary into memory and without the brittleness of string-replacing XML.

**Why we didn't add it now:** our current usage is **generating fresh xlsx from scratch** (cotizaciones, reportes, inventarios). Writing with openpyxl directly is already fine for that. Pack/unpack pays off when you're **editing an existing workbook the client uploaded** — especially one with 20+ sheets, named ranges, charts, or custom formatting the agent needs to preserve.

**Re-evaluate adding it when any of these signals show up:**

1. **The agent starts getting uploads of existing xlsx to modify** (client: *"llena este template con los datos del mes"*). Current skill has no good answer — it either regenerates from scratch (loses template formatting) or hand-edits via openpyxl (fragile for non-trivial files).
2. **Agent reports repeated failures editing workbooks >5 sheets** or with merged cells, charts, pivot tables, or named ranges. Symptoms: "I couldn't preserve the chart", "formatting broke", "had to rebuild the whole sheet".
3. **Client workflow shifts toward templates** — we get one xlsx template per client (branded, pre-formatted) and the agent's job is to fill it monthly. At that scale, pack/unpack is the right tool.
4. **We hit openpyxl limits**: openpyxl can't round-trip some Excel features (pivot tables, slicers, some conditional formatting). If clients complain about lost features post-edit, it's time.

**Decision rule:** if none of the above have happened in 60 days of real use, don't add it — it's ~500 LOC of maintenance surface for no perceived value. If one signal fires 3+ times, add it. If two signals fire once each, add it. Revisit this list whenever this skill gets touched.

**What adding it would cost:** ~500 LOC Python (pack.py + unpack.py + small schema), +0 MB image (pure Python on top of existing openpyxl). No runtime cost — only runs when invoked. Low risk.

## Anti-patterns — do NOT do these

- Delivering CSV when the user asked for Excel.
- Hardcoding totals (`ws["D10"] = 5000` instead of `=SUM(...)`).
- Coloring every other row (zebra stripes) — distracting, unprofessional.
- Merged cells for "decoration" — break sorting and filtering.
- Multiple fonts / font sizes / colors per sheet — one font, one size hierarchy (header bold, body regular).
- Leaving `#REF!` or `#DIV/0!` in delivered files.
- Column widths so narrow the content shows as `###`.
