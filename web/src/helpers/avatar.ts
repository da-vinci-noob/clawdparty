// Deterministic monogram-avatar styling for a participant, matching the design's
// muted palette. The color is picked by hashing the id so a given participant is
// stable across renders. Presentation only.
const PALETTE: { bg: string; color: string }[] = [
  { bg: "#414d47", color: "#d7ded9" },
  { bg: "#4d473f", color: "#ded7cd" },
  { bg: "#3f4a4d", color: "#cdd8da" },
  { bg: "#474d3f", color: "#d9ded1" },
  { bg: "#4a3f4d", color: "#d8cddb" },
];

export function avatarColor(id: string): { bg: string; color: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
  }
  return PALETTE[hash % PALETTE.length] ?? { bg: "#414d47", color: "#d7ded9" };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) {
    return "?";
  }
  if (parts.length === 1) {
    return first.slice(0, 2).toUpperCase();
  }
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}
