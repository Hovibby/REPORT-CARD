/**
 * gradeUtils.ts — Tailwind colour/label helpers keyed by grade letter.
 *
 * GradeLetter is imported from @reportcard/types — the single source of truth.
 * This file only contains UI-layer concerns: Tailwind class strings, labels, emoji.
 */

import type { GradeLetter } from "@reportcard/types";

// Re-export so components that import from here don't need a second import line.
export type { GradeLetter };

export interface GradeVisual {
  bg: string;     // Tailwind bg class
  text: string;   // Tailwind text colour class
  border: string; // Tailwind border class
  ring: string;   // Tailwind ring class (focus indicators)
  label: string;  // Human-readable safety label
  emoji: string;
}

const GRADE_MAP: Record<GradeLetter, GradeVisual> = {
  A: {
    bg: "bg-green-900/40",
    text: "text-green-400",
    border: "border-green-700",
    ring: "ring-green-600",
    label: "Safe",
    emoji: "✅",
  },
  B: {
    bg: "bg-lime-900/40",
    text: "text-lime-400",
    border: "border-lime-700",
    ring: "ring-lime-600",
    label: "Mostly safe",
    emoji: "✔",
  },
  C: {
    bg: "bg-yellow-900/40",
    text: "text-yellow-400",
    border: "border-yellow-700",
    ring: "ring-yellow-600",
    label: "Use caution",
    emoji: "⚠",
  },
  D: {
    bg: "bg-orange-900/40",
    text: "text-orange-400",
    border: "border-orange-700",
    ring: "ring-orange-600",
    label: "High risk",
    emoji: "⚠",
  },
  F: {
    bg: "bg-red-900/40",
    text: "text-red-400",
    border: "border-red-700",
    ring: "ring-red-600",
    label: "Do not sign",
    emoji: "🚫",
  },
};

/**
 * Return Tailwind visual config for a grade letter.
 * Falls back to F when the letter is unrecognised.
 */
export function getGradeVisual(letter: string): GradeVisual {
  return GRADE_MAP[letter as GradeLetter] ?? GRADE_MAP["F"];
}

/** Convert a grade letter to its numeric equivalent (A=5 … F=1). */
export function gradeToNumeric(letter: string): number {
  const map: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };
  return map[letter] ?? 1;
}
