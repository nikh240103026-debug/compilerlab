import { sddAttributeTable, type SddProduction, type SddSpec } from './sdd-spec';

// S-attributed and L-attributed, by the definitions of section 5.2.
//
// An SDD is S-attributed if every attribute is synthesized. It is L-attributed if every inherited
// attribute of a body symbol Xi depends only on the head's inherited attributes, on symbols left of
// Xi, or on Xi's own attributes when that cannot make a cycle.

export type SddClassKind = 's-attributed' | 'l-attributed' | 'neither';

export interface SddRuleCheck {
  production: number;
  productionText: string;
  rule: number;
  ruleText: string;
  role: 'synthesized' | 'inherited' | 'side effect';
  allowedInS: boolean;
  allowedInL: boolean;
  reason: string;
}

export interface SddClassification {
  kind: SddClassKind;
  isSAttributed: boolean;
  isLAttributed: boolean;
  /** The whole answer, in a sentence or two, naming the first rule that decides it. */
  reason: string;
  checks: SddRuleCheck[];
}

type Summary = Map<string, { inh: string; syn: string }[]>;

function attrKey(occurrence: number, attr: string): string {
  return `${occurrence}.${attr}`;
}

/** Inside one production: which attribute values flow into which, including through children. */
function localEdges(production: SddProduction, summary: Summary): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    edges.set(from, [...(edges.get(from) ?? []), to]);
  };
  for (const rule of production.rules) {
    if (!rule.target) continue;
    const to = attrKey(rule.target.occurrence, rule.target.attr);
    for (const read of rule.reads) add(attrKey(read.occurrence, read.attr), to);
  }
  production.body.forEach((symbol, index) => {
    for (const { inh, syn } of summary.get(symbol.symbol) ?? []) {
      add(attrKey(index, inh), attrKey(index, syn));
    }
  });
  return edges;
}

function reaches(edges: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const pending = [from];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === to) return true;
    for (const next of edges.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

/**
 * For each nonterminal, which synthesized attributes can depend on which inherited ones. This is
 * a merged summary over all its productions, so it may report a cycle that no real tree has, but
 * it never misses one. The rule it checks asks for "no cycles", so erring on that side is right.
 */
function dependencySummary(spec: SddSpec): Summary {
  const table = sddAttributeTable(spec);
  const summary: Summary = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const production of spec.productions) {
      const edges = localEdges(production, summary);
      const own = table.filter((info) => info.symbol === production.head);
      for (const syn of own.filter((info) => info.kind === 'synthesized')) {
        for (const inh of own.filter((info) => info.kind === 'inherited')) {
          const known = summary.get(production.head) ?? [];
          const has = known.some((pair) => pair.inh === inh.attr && pair.syn === syn.attr);
          if (!has && reaches(edges, attrKey(-1, inh.attr), attrKey(-1, syn.attr))) {
            summary.set(production.head, [...known, { inh: inh.attr, syn: syn.attr }]);
            changed = true;
          }
        }
      }
    }
  }
  return summary;
}

/** Decides S-attributed or L-attributed, and gives the reason rule by rule. */
export function sddClassify(spec: SddSpec): SddClassification {
  const table = sddAttributeTable(spec);
  const kindOf = (symbol: string, attr: string): string | undefined =>
    table.find((info) => info.symbol === symbol && info.attr === attr)?.kind;
  const summary = dependencySummary(spec);
  const checks: SddRuleCheck[] = [];

  for (const production of spec.productions) {
    const edges = localEdges(production, summary);
    production.rules.forEach((rule, ruleIndex) => {
      const base = {
        production: production.index,
        productionText: production.text,
        rule: ruleIndex,
        ruleText: rule.text,
      };
      if (!rule.target) {
        checks.push({
          ...base,
          role: 'side effect',
          allowedInS: true,
          allowedInL: true,
          reason:
            'A side effect counts as defining a dummy synthesized attribute of the head, so both classes allow it.',
        });
        return;
      }
      const { occurrence, attr, written } = rule.target;
      if (occurrence === -1) {
        checks.push({
          ...base,
          role: 'synthesized',
          allowedInS: true,
          allowedInL: true,
          reason: `${written}.${attr} belongs to the head, so it is synthesized. Both classes allow any synthesized attribute.`,
        });
        return;
      }

      const problems: string[] = [];
      for (const read of rule.reads) {
        const label = `${read.written}.${read.attr}`;
        if (read.occurrence === -1) {
          if (kindOf(production.head, read.attr) === 'synthesized') {
            problems.push(
              `it reads ${label}, a synthesized attribute of the head, which is only known after the whole subtree is finished`,
            );
          }
        } else if (read.occurrence > occurrence) {
          problems.push(`it reads ${label}, and ${read.written} is to the right of ${written}`);
        } else if (read.occurrence === occurrence) {
          const own = read.attr === attr;
          if (own || reaches(edges, attrKey(occurrence, attr), attrKey(occurrence, read.attr))) {
            problems.push(`${label} can depend on ${written}.${attr}, which makes a cycle`);
          }
        }
      }
      checks.push({
        ...base,
        role: 'inherited',
        allowedInS: false,
        allowedInL: problems.length === 0,
        reason:
          problems.length === 0
            ? `${written}.${attr} is inherited, and it reads only the head's inherited attributes and symbols to its left, so L-attributed definitions allow it. S-attributed ones do not allow inherited attributes at all.`
            : `${written}.${attr} is inherited, but ${problems.join(', and ')}.`,
      });
    });
  }

  const firstNotS = checks.find((check) => !check.allowedInS);
  const firstNotL = checks.find((check) => !check.allowedInL);
  if (!firstNotS) {
    return {
      kind: 's-attributed',
      isSAttributed: true,
      isLAttributed: true,
      reason:
        'Every attribute is synthesized, so it is S-attributed: one bottom-up pass over the parse tree evaluates it. That also makes it L-attributed.',
      checks,
    };
  }
  if (!firstNotL) {
    return {
      kind: 'l-attributed',
      isSAttributed: false,
      isLAttributed: true,
      reason: `It is not S-attributed, because the rule ${firstNotS.ruleText} in ${firstNotS.productionText} defines an inherited attribute. It is L-attributed, because every inherited attribute reads only from the head's inherited attributes and from the left. One left-to-right, depth-first pass evaluates it.`,
      checks,
    };
  }
  return {
    kind: 'neither',
    isSAttributed: false,
    isLAttributed: false,
    reason: `It is neither. In ${firstNotL.productionText}, the rule ${firstNotL.ruleText} breaks the L-attributed condition: ${firstNotL.reason}`,
    checks,
  };
}
