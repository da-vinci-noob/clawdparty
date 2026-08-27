import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

/**
 * The block-scalar case is not an edge case on this host: **46 of 58 skills** write
 * `description: |` and continue on indented lines. The previous parser took the text after the
 * colon, so all 46 had a description of `"|"` — displayed in the capabilities popover, and about to
 * become the model's only hint about when each skill applies.
 */

const wrap = (body: string): string => `---\n${body}\n---\nbody text here`;

describe("plain values", () => {
  it("reads a simple key: value", () => {
    expect(parseFrontmatter(wrap("name: deploy\ndescription: Ship it"))).toEqual({
      name: "deploy",
      description: "Ship it",
    });
  });

  it("strips matching quotes", () => {
    expect(parseFrontmatter(wrap(`name: "deploy"\ndescription: 'Ship it'`))).toMatchObject({
      name: "deploy",
      description: "Ship it",
    });
  });
});

describe("block scalars", () => {
  it("reads a `|` block as its indented content, not as the marker", () => {
    const parsed = parseFrontmatter(
      wrap(
        "name: migrate\ndescription: |\n  Migrate API tokens to AWS SM.\n  Use when moving off app-level encryption.",
      ),
    );

    expect(parsed.description).toBe(
      "Migrate API tokens to AWS SM. Use when moving off app-level encryption.",
    );
    expect(parsed.name).toBe("migrate");
  });

  it("handles the folded and strip variants the same way", () => {
    for (const marker of ["|", "|-", ">", ">-"]) {
      const parsed = parseFrontmatter(wrap(`description: ${marker}\n  one\n  two`));
      expect(parsed.description, marker).toBe("one two");
    }
  });

  it("stops at the next key rather than swallowing it", () => {
    const parsed = parseFrontmatter(
      wrap("description: |\n  first line\n  second line\nname: after-block"),
    );

    expect(parsed.description).toBe("first line second line");
    expect(parsed.name).toBe("after-block");
  });

  it("keeps a blank line inside the block from ending it", () => {
    const parsed = parseFrontmatter(wrap("description: |\n  para one\n\n  para two\nname: x"));

    expect(parsed.description).toBe("para one para two");
    expect(parsed.name).toBe("x");
  });

  it("collapses runs of whitespace, since the value is shown on one line", () => {
    expect(parseFrontmatter(wrap("description: |\n  spaced     out\n     text")).description).toBe(
      "spaced out text",
    );
  });

  it("yields an empty string for a block with no content", () => {
    expect(parseFrontmatter(wrap("description: |\nname: x")).description).toBe("");
  });
});

describe("malformed input", () => {
  it("returns nothing when there is no frontmatter at all", () => {
    expect(parseFrontmatter("# Just a heading")).toEqual({});
  });

  it("returns nothing when the block is never closed", () => {
    expect(parseFrontmatter("---\nname: x\nno closing fence")).toEqual({});
  });

  it("ignores lines that are not key: value", () => {
    expect(parseFrontmatter(wrap("name: x\njust some prose\n- a list item"))).toEqual({
      name: "x",
    });
  });
});
