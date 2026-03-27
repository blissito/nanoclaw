---
name: office-reader
description: Read Excel (.xls, .xlsx) and Word (.docx) files — extract text, tables, and data. Use whenever you receive an Office document attachment.
allowed-tools: Bash(office-reader:*)
---

# Office Reader

## Quick start

```bash
office-reader extract report.xlsx              # All sheets as CSV
office-reader extract report.xlsx --sheet Sales # Single sheet
office-reader extract report.xlsx --json        # JSON output
office-reader extract contract.docx             # Word → plain text
office-reader info report.xlsx                  # Sheet names + row counts
office-reader list                              # Find all Office files
```

## Commands

### extract — Extract content from Office files

```bash
office-reader extract <file>                   # CSV (Excel) or text (Word)
office-reader extract <file> --sheet <name>    # Specific sheet only
office-reader extract <file> --json            # JSON array of objects (Excel)
```

Supported formats: `.xls`, `.xlsx`, `.docx`

### info — File metadata

```bash
office-reader info <file>
```

Shows sheet names, row counts, and file size for Excel files.

### list — Find all Office files

```bash
office-reader list
```

Recursively lists all `.xls`, `.xlsx`, `.docx` files with size.

## WhatsApp Office attachments

When a user sends an Office file on WhatsApp, it is saved to `attachments/`. The message includes:

> [Office: attachments/report.xlsx (207KB)]
> Use: office-reader extract attachments/report.xlsx

To read the attached file:

```bash
office-reader extract attachments/report.xlsx
office-reader extract attachments/report.xlsx --json  # structured data
```
