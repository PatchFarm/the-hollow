import { GENERATED_MARKER } from "./render.js";

export const MIGRATION_CHECKER = ".github/hollow/check-migrations.py";

/**
 * `.github/hollow/check-migrations.py`: reads the migration files a pull request adds or changes
 * and reports destructive changes. Standard library only, so it runs on any GitHub runner.
 *
 * Usage: check-migrations.py <tool> <pattern>... < changed-files
 * Env: OVERRIDE ("true" when the PR has the override label), LABEL (its name).
 */
export function renderMigrationChecker(): string {
  return `${GENERATED_MARKER} from hollow.yml. Do not edit by hand:
# change hollow.yml, then run \`npx the-hollow upgrade\`.
${CHECKER}`;
}

const CHECKER = String.raw`# Flags destructive changes in the migration files a pull request adds or changes: dropped
# tables or columns, renames, type changes, and NOT NULL without a default. Those break the code
# that is still running while a deploy rolls out, or lose data. Expand first (add the new thing),
# migrate, and contract (remove the old thing) in a later release.
import ast
import fnmatch
import os
import re
import sys

SQL_RULES = [
    (r"\bDROP\s+TABLE\b", "drops a table"),
    (r"\bDROP\s+COLUMN\b", "drops a column"),
    (r"\bRENAME\s+COLUMN\b", "renames a column"),
    (r"\bALTER\s+TABLE\b.*\bRENAME\s+TO\b", "renames a table"),
    (r"\bRENAME\s+TABLE\b", "renames a table"),
    (r"\bTRUNCATE\b", "deletes every row of a table"),
    (r"\bALTER\s+COLUMN\b.*\bSET\s+NOT\s+NULL\b", "makes a column NOT NULL"),
    (r"\bALTER\s+COLUMN\b.*\bTYPE\b", "changes a column's type"),
    (r"\b(MODIFY|CHANGE)\s+COLUMN\b", "changes a column definition"),
]
ADD_NOT_NULL = re.compile(r"\bADD\s+(COLUMN\s+)?.*\bNOT\s+NULL\b", re.IGNORECASE | re.DOTALL)
HAS_DEFAULT = re.compile(r"\bDEFAULT\b", re.IGNORECASE)


def statements(text):
    """Split SQL into (line, statement) pairs, dropping -- comments."""
    found, current, start = [], [], None
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.split("--", 1)[0]
        if line.strip() and start is None:
            start = number
        current.append(line)
        if ";" in line:
            found.append((start or number, " ".join(current)))
            current, start = [], None
    if "".join(current).strip():
        found.append((start or 1, " ".join(current)))
    return found


def check_sql(text, offset=0):
    findings = []
    parts = statements(text)
    # Prisma rebuilds SQLite tables by copying into new_X, dropping X and renaming new_X to X.
    # That keeps the data, so it is not reported.
    rebuilt = set(
        name.lower()
        for _, sql in parts
        for name in re.findall(r'ALTER\s+TABLE\s+["\x60]?new_(\w+)["\x60]?\s+RENAME\s+TO', sql, re.IGNORECASE)
    )
    for line, sql in parts:
        drop = re.search(r'DROP\s+TABLE\s+(IF\s+EXISTS\s+)?["\x60]?(\w+)', sql, re.IGNORECASE)
        if drop and drop.group(2).lower() in rebuilt:
            continue
        if re.search(r'ALTER\s+TABLE\s+["\x60]?new_\w+["\x60]?\s+RENAME\s+TO', sql, re.IGNORECASE):
            continue
        for pattern, message in SQL_RULES:
            if re.search(pattern, sql, re.IGNORECASE | re.DOTALL):
                findings.append((line + offset, message))
        if ADD_NOT_NULL.search(sql) and not HAS_DEFAULT.search(sql) and not re.search(r"\bCREATE\s+TABLE\b", sql, re.IGNORECASE):
            findings.append((line + offset, "adds a NOT NULL column without a default"))
    return findings


def call_name(node):
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ""


def keyword(node, name):
    for item in node.keywords:
        if item.arg == name:
            return item.value
    return None


def is_false(value):
    return isinstance(value, ast.Constant) and value.value is False


def is_true(value):
    return isinstance(value, ast.Constant) and value.value is True


def string_value(node):
    if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        return node.args[0].value
    return None


def check_alembic(text):
    findings = []
    tree = ast.parse(text)
    upgrade = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "upgrade"]
    for function in upgrade:
        for node in ast.walk(function):
            if not isinstance(node, ast.Call):
                continue
            name = call_name(node)
            if name == "drop_table":
                findings.append((node.lineno, "drops a table"))
            elif name == "drop_column":
                findings.append((node.lineno, "drops a column"))
            elif name == "rename_table":
                findings.append((node.lineno, "renames a table"))
            elif name == "alter_column":
                if keyword(node, "new_column_name") is not None:
                    findings.append((node.lineno, "renames a column"))
                if is_false(keyword(node, "nullable")):
                    findings.append((node.lineno, "makes a column NOT NULL"))
                if keyword(node, "type_") is not None:
                    findings.append((node.lineno, "changes a column's type"))
            elif name == "add_column":
                for arg in node.args:
                    if isinstance(arg, ast.Call) and call_name(arg) == "Column":
                        if is_false(keyword(arg, "nullable")) and keyword(arg, "server_default") is None:
                            findings.append((node.lineno, "adds a NOT NULL column without a server default"))
            elif name == "execute":
                sql = string_value(node)
                if sql is not None:
                    findings.extend(check_sql(sql, node.lineno - 1))
    return findings


DJANGO_REMOVALS = {
    "RemoveField": "removes a field (drops a column)",
    "DeleteModel": "deletes a model (drops a table)",
    "RenameField": "renames a field (renames a column)",
    "RenameModel": "renames a model (renames a table)",
}


def check_django(text):
    findings = []
    for node in ast.walk(ast.parse(text)):
        if not isinstance(node, ast.Call):
            continue
        name = call_name(node)
        if name in DJANGO_REMOVALS:
            findings.append((node.lineno, DJANGO_REMOVALS[name]))
        elif name in ("AddField", "AlterField"):
            field = keyword(node, "field")
            if not isinstance(field, ast.Call):
                continue
            nullable = is_true(keyword(field, "null"))
            has_default = keyword(field, "default") is not None
            if name == "AddField" and not nullable and not has_default:
                findings.append((node.lineno, "adds a NOT NULL field without a default"))
            if name == "AlterField" and is_false(keyword(field, "null")):
                findings.append((node.lineno, "makes a field NOT NULL"))
        elif name == "RunSQL":
            sql = string_value(node)
            if sql is not None:
                findings.extend(check_sql(sql, node.lineno - 1))
    return findings


CHECKS = {"prisma": check_sql, "drizzle": check_sql, "alembic": check_alembic, "django": check_django}


def main():
    tool, patterns = sys.argv[1], sys.argv[2:]
    override = os.environ.get("OVERRIDE") == "true"
    label = os.environ.get("LABEL", "allow-destructive-migration")
    changed = [line.strip() for line in sys.stdin if line.strip()]
    files = [f for f in changed if any(fnmatch.fnmatch(f, p) for p in patterns)]
    if not files:
        print("No migration files changed.")
        return 0
    total = 0
    level = "warning" if override else "error"
    for path in files:
        try:
            with open(path, encoding="utf-8") as handle:
                findings = CHECKS[tool](handle.read())
        except (OSError, SyntaxError) as error:
            print(f"::{level} file={path}::Could not read this migration: {error}")
            total += 1
            continue
        for line, message in findings:
            print(f"::{level} file={path},line={line},title=Destructive migration::This migration {message}.")
            total += 1
    if total == 0:
        print(f"Checked {len(files)} migration file(s): no destructive changes.")
        return 0
    if override:
        print(f"{total} destructive change(s), allowed by the '{label}' label.")
        return 0
    print(
        f"{total} destructive change(s). Old code keeps running while a deploy rolls out, so split them:"
        f" add the new column or table first, migrate the data, and remove the old one in a later release."
        f" If this change is safe (nothing reads it any more, or the data is disposable), add the '{label}' label."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
`;
