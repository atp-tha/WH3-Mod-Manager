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

/**
 * Everything each pack must precede, following the rules through as many hops as they chain.
 *
 * The closure matters because a rule can be implied rather than stated: with "p before u" and
 * "u before s", p must also precede s, and a placement that only knew the stated pairs could put p
 * after s and then have nowhere legal left to put u.
 */
const buildTransitiveSuccessors = (edges: LoadOrderEdges): Map<string, Set<string>> => {
  const transitiveSuccessors = new Map<string, Set<string>>();

  for (const startKey of edges.successorsByPackName.keys()) {
    const reached = new Set<string>();
    const stack = [...(edges.successorsByPackName.get(startKey) ?? [])];

    while (stack.length > 0) {
      const key = stack.pop() as string;
      // Also the guard that keeps a hand-built cyclic edge set from looping forever.
      if (reached.has(key)) continue;
      reached.add(key);
      for (const next of edges.successorsByPackName.get(key) ?? []) stack.push(next);
    }

    reached.delete(startKey);
    transitiveSuccessors.set(startKey, reached);
  }

  return transitiveSuccessors;
};

/**
 * Reorders an already-sorted list so it also satisfies the rules, moving as little as possible.
 *
 * Each pack is placed as late as the rules allow rather than as early as possible. That is the whole
 * difference between this and a textbook topological sort, and it is what stops a rule between two
 * packs from disturbing a third: a pack no rule mentions keeps its place, and one that is merely
 * waiting for another pack does not get overtaken by everything that happens to be unblocked.
 */
export function applyLoadOrderEdges<T extends { name: string }>(sortedItems: T[], edges: LoadOrderEdges): T[] {
  if (edges.edgeCount === 0 || sortedItems.length < 2) return sortedItems;

  const transitiveSuccessors = buildTransitiveSuccessors(edges);
  const transitivePredecessors = new Map<string, Set<string>>();
  for (const [beforeKey, afterKeys] of transitiveSuccessors) {
    for (const afterKey of afterKeys) {
      const predecessors = transitivePredecessors.get(afterKey);
      if (predecessors) predecessors.add(beforeKey);
      else transitivePredecessors.set(afterKey, new Set([beforeKey]));
    }
  }

  const result: T[] = [];

  for (const item of sortedItems) {
    const key = loadOrderPackNameKey(item.name);
    const mustPrecede = transitiveSuccessors.get(key);
    const mustFollow = transitivePredecessors.get(key);

    // The overwhelming majority of packs are named by no rule at all and simply keep their place.
    if ((!mustPrecede || mustPrecede.size === 0) && (!mustFollow || mustFollow.size === 0)) {
      result.push(item);
      continue;
    }

    let earliest = 0;
    let latest = result.length;
    for (let index = 0; index < result.length; index++) {
      const placedKey = loadOrderPackNameKey(result[index].name);
      if (mustFollow?.has(placedKey)) earliest = Math.max(earliest, index + 1);
      if (mustPrecede?.has(placedKey)) latest = Math.min(latest, index);
    }

    // earliest can only exceed latest for edges that contradict each other, which resolveLoadOrderRules
    // has already removed. Clamping keeps a hand-built set from losing the item entirely.
    result.splice(Math.max(earliest, Math.min(latest, result.length)), 0, item);
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
