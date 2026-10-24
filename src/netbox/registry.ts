/**
 * Helpers for resolving user-supplied endpoint identifiers against the spec index.
 */
import type { ResourceEntry, SpecIndex } from "./spec.js";

/** Normalize a user-provided endpoint key into candidate lookup forms. */
export function endpointVariants(input: string): string[] {
  const trimmed = input.trim();
  const noApi = trimmed.replace(/^\/?api\//i, "").replace(/^\/+/, "");
  const noTrailing = noApi.replace(/\/+$/, "");
  const variants = new Set<string>();
  for (const value of [trimmed, noApi, noTrailing]) {
    if (!value) continue;
    variants.add(value);
    variants.add(value.toLowerCase());
    variants.add(value.replace(/\//g, "."));
    variants.add(value.replace(/\//g, ".").toLowerCase());
  }
  return [...variants];
}

export interface ResolveResult {
  entry?: ResourceEntry;
  suggestions: string[];
}

/** Resolve an endpoint key (e.g. `dcim/devices`, `dcim.devices`, `/api/dcim/devices/`). */
export function resolveResource(index: SpecIndex, input: string): ResourceEntry | undefined {
  for (const variant of endpointVariants(input)) {
    const key = index.aliases.get(variant);
    if (key) {
      const entry = index.resources.get(key);
      if (entry) return entry;
    }
  }
  return undefined;
}

/** Suggest canonical keys when a lookup fails. */
export function suggestKeywords(index: SpecIndex, input: string, limit = 8): string[] {
  const needle = input.replace(/^\/?api\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!needle) return [];

  const scored: Array<{ key: string; score: number }> = [];
  for (const key of index.resources.keys()) {
    const haystack = key.toLowerCase();
    let score = 0;
    if (haystack === needle) score = 100;
    else if (haystack.endsWith(`/${needle}`) || haystack.endsWith(needle)) score = 80;
    else if (haystack.includes(needle) || needle.includes(haystack)) score = 60;
    else {
      const distance = levenshtein(haystack, needle);
      const maxLen = Math.max(haystack.length, needle.length);
      score = Math.max(0, 40 - (distance / maxLen) * 40);
    }
    if (score > 0) scored.push({ key, score });
  }

  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((item) => item.key);
}

/** Resolve or produce an error-friendly result. */
export function resolveOrSuggest(index: SpecIndex, input: string): ResolveResult {
  const entry = resolveResource(index, input);
  if (entry) return { entry, suggestions: [] };
  return { suggestions: suggestKeywords(index, input, 8) };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}