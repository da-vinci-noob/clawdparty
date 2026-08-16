/**
 * The leading `---`…`---` frontmatter of a SKILL.md, as `key: value` pairs.
 *
 * ONE copy, imported by both `capabilities.ts` (the discovery listing) and `skills.ts` (the
 * system-prompt index). It was two, and that is how the bug below survived in one of them.
 *
 * Deliberately not a YAML dependency — only `name` and `description` are ever read. But it does
 * have to understand BLOCK SCALARS, because measured on this host **46 of 58 skills** write
 * `description: |` and continue on the following indented lines. A parser that takes the text
 * after the colon returns the literal `"|"` for all of them, which is what the capabilities
 * popover displayed and what the skill index would have offered the model as its only hint about
 * when a skill applies.
 */

/** Folded into ONE LINE: both consumers display or index the description, never render it. */
export function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) {
    return {};
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }

  const out: Record<string, string> = {};
  const lines = content.slice(3, end).split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[at] as string);
    if (!match?.[1]) {
      continue;
    }
    const key = match[1];
    const inline = (match[2] ?? "").trim();

    if (inline === "|" || inline === "|-" || inline === ">" || inline === ">-") {
      const [value, consumed] = blockScalar(lines, at + 1);
      out[key] = value;
      at = consumed - 1;
      continue;
    }
    out[key] = unquote(inline);
  }
  return out;
}

/** Indented continuation lines after a `|` / `>` marker, joined into one line. */
function blockScalar(lines: readonly string[], from: number): [value: string, nextIndex: number] {
  const parts: string[] = [];
  let at = from;
  for (; at < lines.length; at += 1) {
    const line = lines[at] as string;
    // A blank line inside a block is part of it; a non-indented line ends it.
    if (line.trim() === "") {
      parts.push("");
      continue;
    }
    if (!/^\s/.test(line)) {
      break;
    }
    parts.push(line.trim());
  }
  return [parts.join(" ").replace(/\s+/g, " ").trim(), at];
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}
