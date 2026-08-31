/**
 * Relationship rules that feed the automatic load order: "pack A loads before pack B".
 *
 * Pure — no electron, no redux — so main, both renderers and the tests all share one
 * implementation. The game reads `used_mods.txt` bottom-up, so "before" here means
 * *earlier in the list*, which is the pack that gets overridden by the other one.
 */

export interface LoadOrderRule {
  /** Pack name that loads earlier (higher in the list). */
  before: string;
  /** Pack name that loads later (lower in the list, and so wins conflicts). */
  after: string;
  /** Absent = a rule the user made. Set = the pack whose whmm\load_order.whmm supplied it. */
  sourcePackName?: string;
}

/** Accepted rules in the shape the sort wants: earlier pack -> packs that must follow it. */
export interface LoadOrderEdges {
  successorsByPackName: Map<string, Set<string>>;
  edgeCount: number;
}

export type LoadOrderRuleConflictKind =
  /** Dropped because honouring it would need the order to loop back on itself. */
  | "cycle"
  /** Two mods each demand the opposite order for the same pair, so neither is applied. */
  | "contradiction"
  /** One of the two packs is not in the list, so there is nothing to order. */
  | "missingPack"
  /** A manual load order pin put the packs in the other order, and pins win. */
  | "overriddenByPin";

export interface LoadOrderRuleConflict {
  kind: LoadOrderRuleConflictKind;
  rule: LoadOrderRule;
  /** For "missingPack", the pack that could not be found. */
  packName?: string;
}

export interface ResolveLoadOrderRulesInput {
  userRules: LoadOrderRule[];
  /** Pack name -> the rules that pack ships inside itself. */
  modRules: Record<string, LoadOrderRule[]>;
  /** Canonical keys of individual mod rules the user switched off. */
  disabledRuleKeys?: string[];
  /** Packs whose rules the user ignores wholesale, including ones they add later. */
  disabledPackNames?: string[];
  /** Packs currently in the list. Rules naming anything else are inert. */
  presentPackNames: string[];
}

export interface ResolvedLoadOrderRules {
  /** The rules that became edges. */
  rules: LoadOrderRule[];
  edges: LoadOrderEdges;
  conflicts: LoadOrderRuleConflict[];
  /** Mod rules the user switched off. Still listed so the tab can show and restore them. */
  disabledRules: LoadOrderRule[];
  /** Mod rules a user rule about the same pair replaced. Not a problem, just not in effect. */
  supersededRules: LoadOrderRule[];
}

export const EMPTY_LOAD_ORDER_EDGES: LoadOrderEdges = {
  successorsByPackName: new Map(),
  edgeCount: 0,
};

/** Accepts "foo", "foo.pack" or a whole path, and always answers with a bare "foo.pack". */
export const normalizeLoadOrderPackName = (packName: string): string => {
  const withoutFolders = packName.trim().replace(/^.*[\\/]/, "");
  if (withoutFolders === "") return "";
  return withoutFolders.toLowerCase().endsWith(".pack") ? withoutFolders : `${withoutFolders}.pack`;
};

/** Pack names are compared case-insensitively; only the comparison is lowercased, never the stored name. */
export const loadOrderPackNameKey = (packName: string): string => normalizeLoadOrderPackName(packName).toLowerCase();

/**
 * Identifies one mod-supplied rule across restarts and across the pack being updated, which is what
 * lets "the user switched this rule off" outlive a re-read of someone else's pack.
 */
export const loadOrderRuleKey = (rule: LoadOrderRule): string =>
  [
    rule.sourcePackName ? loadOrderPackNameKey(rule.sourcePackName) : "",
    loadOrderPackNameKey(rule.before),
    loadOrderPackNameKey(rule.after),
  ].join("\t");

/** Both directions of a pair share one key, so a rule and its reverse collide deliberately. */
const packPairKey = (rule: LoadOrderRule): string =>
  [loadOrderPackNameKey(rule.before), loadOrderPackNameKey(rule.after)].sort().join("\t");

export const buildLoadOrderEdges = (rules: LoadOrderRule[]): LoadOrderEdges => {
  const successorsByPackName = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const rule of rules) {
    const beforeKey = loadOrderPackNameKey(rule.before);
    const afterKey = loadOrderPackNameKey(rule.after);
    if (beforeKey === "" || afterKey === "" || beforeKey === afterKey) continue;

    let successors = successorsByPackName.get(beforeKey);
    if (!successors) {
      successors = new Set();
      successorsByPackName.set(beforeKey, successors);
    }
    if (!successors.has(afterKey)) {
      successors.add(afterKey);
      edgeCount++;
    }
  }

  return { successorsByPackName, edgeCount };
};

/** Whether `toKey` can already be reached from `fromKey`, i.e. whether adding fromKey->toKey loops. */
const canReach = (edges: LoadOrderEdges, fromKey: string, toKey: string): boolean => {
  const seen = new Set<string>([fromKey]);
  const stack = [fromKey];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === toKey) return true;

    for (const next of edges.successorsByPackName.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }

  return false;
};

const compareRulesForDeterminism = (first: LoadOrderRule, second: LoadOrderRule): number => {
  const bySource = (first.sourcePackName ?? "").localeCompare(second.sourcePackName ?? "");
  if (bySource !== 0) return bySource;
  const byBefore = loadOrderPackNameKey(first.before).localeCompare(loadOrderPackNameKey(second.before));
  if (byBefore !== 0) return byBefore;
  return loadOrderPackNameKey(first.after).localeCompare(loadOrderPackNameKey(second.after));
};

/**
 * Turns the two rule sources into a cycle-free edge set.
 *
 * Disabling runs before everything else on purpose: a rule the user switched off must not be able to
 * cause a cycle or a contradiction, so muting one bad rule can rescue the rules that were being
 * dropped alongside it.
 */
export function resolveLoadOrderRules(input: ResolveLoadOrderRulesInput): ResolvedLoadOrderRules {
  const presentKeys = new Set(input.presentPackNames.map(loadOrderPackNameKey));
  const disabledKeys = new Set(input.disabledRuleKeys ?? []);
  const disabledPackKeys = new Set((input.disabledPackNames ?? []).map(loadOrderPackNameKey));

  const conflicts: LoadOrderRuleConflict[] = [];
  const disabledRules: LoadOrderRule[] = [];
  const supersededRules: LoadOrderRule[] = [];

  // 1. Mod rules the user switched off never reach any later stage.
  const liveModRules: LoadOrderRule[] = [];
  for (const [sourcePackName, packRules] of Object.entries(input.modRules)) {
    const isPackDisabled = disabledPackKeys.has(loadOrderPackNameKey(sourcePackName));
    for (const packRule of packRules) {
      const rule: LoadOrderRule = { ...packRule, sourcePackName };
      if (isPackDisabled || disabledKeys.has(loadOrderRuleKey(rule))) disabledRules.push(rule);
      else liveModRules.push(rule);
    }
  }

  // 2. A rule needs both of its packs present to mean anything.
  const isUsable = (rule: LoadOrderRule): boolean => {
    const beforeKey = loadOrderPackNameKey(rule.before);
    const afterKey = loadOrderPackNameKey(rule.after);
    if (beforeKey === "" || afterKey === "" || beforeKey === afterKey) return false;

    for (const [key, packName] of [
      [beforeKey, rule.before],
      [afterKey, rule.after],
    ] as const) {
      if (!presentKeys.has(key)) {
        conflicts.push({ kind: "missingPack", rule, packName });
        return false;
      }
    }
    return true;
  };

  const usableUserRules = input.userRules.map((rule) => ({ ...rule, sourcePackName: undefined })).filter(isUsable);
  const usableModRules = liveModRules.filter(isUsable);

  // 3. One rule per pair, with the user's own always winning.
  const ruleByPair = new Map<string, LoadOrderRule>();
  for (const rule of usableUserRules) ruleByPair.set(packPairKey(rule), rule);

  const modRulesByPair = new Map<string, LoadOrderRule[]>();
  for (const rule of usableModRules) {
    const pairKey = packPairKey(rule);
    if (ruleByPair.has(pairKey)) {
      supersededRules.push(rule);
      continue;
    }
    const existing = modRulesByPair.get(pairKey);
    if (existing) existing.push(rule);
    else modRulesByPair.set(pairKey, [rule]);
  }

  // 4. Mods that disagree with each other about a pair cancel out.
  for (const [pairKey, pairRules] of modRulesByPair) {
    const firstDirection = loadOrderPackNameKey(pairRules[0].before);
    const isUnanimous = pairRules.every((rule) => loadOrderPackNameKey(rule.before) === firstDirection);
    if (isUnanimous) {
      ruleByPair.set(pairKey, pairRules[0]);
      continue;
    }
    for (const rule of pairRules) conflicts.push({ kind: "contradiction", rule });
  }

  // 5. Accept edges in a fixed order so the rule dropped to break a cycle never varies between runs.
  const candidates = [...ruleByPair.values()].sort((first, second) => {
    const isFirstUser = first.sourcePackName == undefined;
    const isSecondUser = second.sourcePackName == undefined;
    if (isFirstUser !== isSecondUser) return isFirstUser ? -1 : 1;
    return compareRulesForDeterminism(first, second);
  });

  const edges: LoadOrderEdges = { successorsByPackName: new Map(), edgeCount: 0 };
  const rules: LoadOrderRule[] = [];

  for (const rule of candidates) {
    const beforeKey = loadOrderPackNameKey(rule.before);
    const afterKey = loadOrderPackNameKey(rule.after);

    if (canReach(edges, afterKey, beforeKey)) {
      conflicts.push({ kind: "cycle", rule });
      continue;
    }

    let successors = edges.successorsByPackName.get(beforeKey);
    if (!successors) {
      successors = new Set();
      edges.successorsByPackName.set(beforeKey, successors);
    }
    if (!successors.has(afterKey)) {
      successors.add(afterKey);
      edges.edgeCount++;
    }
    rules.push(rule);
  }

  return { rules, edges, conflicts, disabledRules, supersededRules };
}

/** Indices, smallest first. Kept tiny and local; the alternative is sorting the ready set every pop. */
class MinIndexHeap {
  private readonly values: number[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: number): void {
    const values = this.values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (values[parent] <= values[index]) break;
      [values[parent], values[index]] = [values[index], values[parent]];
      index = parent;
    }
  }

  pop(): number {
    const values = this.values;
    const top = values[0];
    const last = values.pop() as number;
    if (values.length > 0) {
      values[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < values.length && values[left] < values[smallest]) smallest = left;
        if (right < values.length && values[right] < values[smallest]) smallest = right;
        if (smallest === index) break;
        [values[smallest], values[index]] = [values[index], values[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * Reorders an already-sorted list so it also satisfies the rules.
 *
 * The tie-break is the item's position in the input, so anything the rules do not constrain keeps
 * exactly the order it arrived in - which is how "rules refine the name sort" stays true rather than
 * the rules imposing an order of their own.
 */
export function applyLoadOrderEdges<T extends { name: string }>(sortedItems: T[], edges: LoadOrderEdges): T[] {
  if (edges.edgeCount === 0 || sortedItems.length < 2) return sortedItems;

  const indicesByKey = new Map<string, number[]>();
  sortedItems.forEach((item, index) => {
    const key = loadOrderPackNameKey(item.name);
    const indices = indicesByKey.get(key);
    if (indices) indices.push(index);
    else indicesByKey.set(key, [index]);
  });

  const successorIndices: number[][] = sortedItems.map(() => []);
  const incomingCount = new Int32Array(sortedItems.length);
  let usedEdgeCount = 0;

  for (const [beforeKey, afterKeys] of edges.successorsByPackName) {
    const beforeIndices = indicesByKey.get(beforeKey);
    if (!beforeIndices) continue;

    for (const afterKey of afterKeys) {
      const afterIndices = indicesByKey.get(afterKey);
      if (!afterIndices) continue;

      for (const beforeIndex of beforeIndices) {
        for (const afterIndex of afterIndices) {
          successorIndices[beforeIndex].push(afterIndex);
          incomingCount[afterIndex]++;
          usedEdgeCount++;
        }
      }
    }
  }

  if (usedEdgeCount === 0) return sortedItems;

  const ready = new MinIndexHeap();
  for (let index = 0; index < sortedItems.length; index++) {
    if (incomingCount[index] === 0) ready.push(index);
  }

  const result: T[] = [];
  while (ready.size > 0) {
    const index = ready.pop();
    result.push(sortedItems[index]);
    for (const successor of successorIndices[index]) {
      if (--incomingCount[successor] === 0) ready.push(successor);
    }
  }

  // resolveLoadOrderRules already removed every cycle, so this only guards against a caller that
  // built edges by hand. Anything still held back keeps its original position rather than vanishing.
  if (result.length !== sortedItems.length) {
    sortedItems.forEach((item, index) => {
      if (incomingCount[index] > 0) result.push(item);
    });
  }

  return result;
}

/**
 * Rules the finished order does not actually satisfy, which happens when a manual pin sits between
 * the two packs. Pins win by design, so this is reported to the user rather than fixed.
 */
export function findRulesOverriddenByPins(orderedNames: string[], rules: LoadOrderRule[]): LoadOrderRuleConflict[] {
  const positionByKey = new Map<string, number>();
  orderedNames.forEach((name, index) => {
    const key = loadOrderPackNameKey(name);
    if (!positionByKey.has(key)) positionByKey.set(key, index);
  });

  const conflicts: LoadOrderRuleConflict[] = [];
  for (const rule of rules) {
    const beforePosition = positionByKey.get(loadOrderPackNameKey(rule.before));
    const afterPosition = positionByKey.get(loadOrderPackNameKey(rule.after));
    if (beforePosition == undefined || afterPosition == undefined) continue;
    if (beforePosition > afterPosition) conflicts.push({ kind: "overriddenByPin", rule });
  }

  return conflicts;
}
