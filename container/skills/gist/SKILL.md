---
name: gist
description: Create and edit GitHub Gists for sharing code, logs, configs, and data
allowed-tools: Bash(create-gist:*),Bash(edit-gist:*)
---

# GitHub Gists

Share code snippets, logs, configs, and data files via GitHub Gists.

| Tool | When to use |
|------|-------------|
| `create-gist` | Create a new gist with one file |
| `edit-gist` | Update or add files to an existing gist |

## When to use gists vs direct messages

- **Gist**: code >20 lines, structured data (JSON/CSV/YAML), logs, configs, diffs, anything that benefits from syntax highlighting
- **Direct message**: short answers, small code snippets (<20 lines), plain text explanations

## create-gist

```bash
# From inline content (secret by default)
create-gist "analysis.py" "import pandas as pd
df = pd.read_csv('data.csv')
print(df.describe())"

# From a file
create-gist "results.csv" /workspace/group/output.csv

# Public gist (only if user asks)
create-gist --public "config.yaml" /workspace/group/config.yaml
```

Returns the gist URL. Always send it to the user via `send_message`.

## edit-gist

```bash
# Update a file in an existing gist
edit-gist abc123def456 "analysis.py" "# updated version
import pandas as pd
..."

# Add a new file to an existing gist
edit-gist abc123def456 "results.json" /workspace/group/results.json
```

## Rules

- **Always create secret gists** unless the user explicitly asks for public
- The filename determines syntax highlighting — use proper extensions (.py, .js, .json, .csv, .log, .md, .yaml, .sh, .sql, etc.)
- After creating/editing, always send the URL to the user
- For multi-file shares, create one gist then use edit-gist to add more files to the same gist
