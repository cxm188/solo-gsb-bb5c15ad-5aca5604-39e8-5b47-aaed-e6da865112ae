/**
 * 路由歧义分析核心逻辑。
 *
 * 路径模式由若干段组成：
 *   - 静态段   如 `api`           —— 精确匹配一个段
 *   - 参数段   如 `:id`           —— 匹配任意一个非空段
 *   - 通配段   `*`                —— 匹配零个或多个段
 *
 * 两条规则"歧义"当且仅当存在至少一条具体请求路径同时命中二者。
 * 通过在两条规则的段自动机上做 0-1 代价的 Dijkstra 积构造，
 * 找出一条段数最少的具体见证路径。
 */

export type SegmentToken =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface RuleInput {
  pattern: string;
  priority?: number;
  enabled?: boolean;
}

export interface AnalyzedRule {
  id: string;
  index: number;
  pattern: string;
  priority: number;
  enabled: boolean;
  error: string | null;
  tokens: SegmentToken[];
}

export interface Conflict {
  ruleA: string;
  ruleB: string;
  /** 最短具体见证路径，如 /api/users/new */
  witness: string;
  witnessSegments: string[];
  /** 对该见证路径模拟最终命中的规则 id（优先级大者优先，平手取输入顺序靠前者） */
  winner: string | null;
  /** 所有能命中该见证路径的启用规则 id */
  matchedRules: string[];
}

const MAX_SEGMENTS = 64;
const MAX_PATTERN_LEN = 500;
/** 参数段/通配段在见证路径中使用的具体占位段 */
const PLACEHOLDER_SEGMENT = 'x';

export function parsePattern(pattern: string): SegmentToken[] {
  if (pattern.length > MAX_PATTERN_LEN) {
    throw new Error(`模式长度超过 ${MAX_PATTERN_LEN} 字符`);
  }
  const rawSegments = pattern.split('/').filter((s) => s.length > 0);
  if (rawSegments.length > MAX_SEGMENTS) {
    throw new Error(`段数超过 ${MAX_SEGMENTS}`);
  }
  return rawSegments.map((seg): SegmentToken => {
    if (/\s/.test(seg)) {
      throw new Error(`段中包含空白字符: "${seg}"`);
    }
    if (seg === '*') return { kind: 'star' };
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      if (!name) throw new Error('参数段缺少名称（":" 后需跟参数名）');
      return { kind: 'param', name };
    }
    return { kind: 'static', value: seg };
  });
}

/** 判断一条具体路径（段数组）是否命中规则 */
export function matchPattern(tokens: SegmentToken[], segments: string[]): boolean {
  const memo = new Map<number, boolean>();
  const key = (i: number, j: number) => i * (segments.length + 1) + j;

  const rec = (i: number, j: number): boolean => {
    const k = key(i, j);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;
    let res: boolean;
    if (i === tokens.length) {
      res = j === segments.length;
    } else {
      const t = tokens[i];
      if (t.kind === 'static') {
        res = j < segments.length && segments[j] === t.value && rec(i + 1, j + 1);
      } else if (t.kind === 'param') {
        res = j < segments.length && rec(i + 1, j + 1);
      } else {
        // `*`：先尝试消费零段，再逐段消费
        res = rec(i + 1, j) || (j < segments.length && rec(i, j + 1));
      }
    }
    memo.set(k, res);
    return res;
  };

  return rec(0, 0);
}

interface ConsumeOption {
  next: number;
  /** 该选项对消费段的具体取值约束；null 表示任意段均可 */
  stat: string | null;
}

/** token 消费一个段后的位置选项（star 消费一段后停在原地） */
function consumeOptions(tokens: SegmentToken[], i: number): ConsumeOption[] {
  const t = tokens[i];
  if (t.kind === 'star') return [{ next: i, stat: null }];
  if (t.kind === 'static') return [{ next: i + 1, stat: t.value }];
  return [{ next: i + 1, stat: null }];
}

/**
 * 求两条模式交集的最短具体见证路径（段数最少）。
 * 状态为 (i, j)：两条模式各自已消费到的 token 下标。
 *   - star 跳过：0 代价 epsilon 边
 *   - 双方同时消费一个具体段：1 代价边
 * 返回具体段数组；交集为空时返回 null。
 */
export function shortestWitness(a: SegmentToken[], b: SegmentToken[]): string[] | null {
  const width = b.length + 1;
  const keyOf = (i: number, j: number) => i * width + j;
  const start = keyOf(0, 0);
  const goal = keyOf(a.length, b.length);
  if (start === goal) return [];

  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, { from: number; seg: string | null }>();
  // 状态规模很小（段数级别），用数组当简易优先队列即可
  const pq: Array<[number, number]> = [[0, start]];

  while (pq.length > 0) {
    let mi = 0;
    for (let k = 1; k < pq.length; k++) if (pq[k][0] < pq[mi][0]) mi = k;
    const [d, s] = pq.splice(mi, 1)[0];
    if (d > (dist.get(s) ?? Infinity)) continue;
    if (s === goal) break;

    const i = Math.floor(s / width);
    const j = s % width;

    const relax = (ni: number, nj: number, cost: number, seg: string | null) => {
      const nk = keyOf(ni, nj);
      const nd = d + cost;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { from: s, seg });
        pq.push([nd, nk]);
      }
    };

    // epsilon：star 消费零段
    if (i < a.length && a[i].kind === 'star') relax(i + 1, j, 0, null);
    if (j < b.length && b[j].kind === 'star') relax(i, j + 1, 0, null);

    // 双方各消费同一个具体段
    if (i < a.length && j < b.length) {
      for (const oa of consumeOptions(a, i)) {
        for (const ob of consumeOptions(b, j)) {
          let seg: string;
          if (oa.stat !== null && ob.stat !== null) {
            if (oa.stat !== ob.stat) continue; // 静态段冲突，此路不通
            seg = oa.stat;
          } else {
            seg = oa.stat ?? ob.stat ?? PLACEHOLDER_SEGMENT;
          }
          relax(oa.next, ob.next, 1, seg);
        }
      }
    }
  }

  if (!prev.has(goal)) return null;
  const segments: string[] = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) return null;
    if (p.seg !== null) segments.push(p.seg);
    cur = p.from;
  }
  return segments.reverse();
}

/** 平手裁决：优先级数字大者优先；相同则输入顺序靠前者（index 小）优先 */
export function pickWinner(rules: AnalyzedRule[]): AnalyzedRule | null {
  let best: AnalyzedRule | null = null;
  for (const r of rules) {
    if (
      best === null ||
      r.priority > best.priority ||
      (r.priority === best.priority && r.index < best.index)
    ) {
      best = r;
    }
  }
  return best;
}

export interface AnalyzeResult {
  rules: Array<Omit<AnalyzedRule, 'tokens'>>;
  conflicts: Conflict[];
}

export function analyze(inputs: RuleInput[]): AnalyzeResult {
  const rules: AnalyzedRule[] = inputs.map((inp, index) => {
    const pattern = String(inp.pattern ?? '').trim();
    const priorityRaw = Number(inp.priority);
    let tokens: SegmentToken[] = [];
    let error: string | null = null;
    try {
      if (!pattern) throw new Error('模式为空');
      tokens = parsePattern(pattern);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return {
      id: `r${index + 1}`,
      index,
      pattern,
      priority: Number.isFinite(priorityRaw) ? priorityRaw : 0,
      enabled: inp.enabled !== false,
      error,
      tokens,
    };
  });

  const active = rules.filter((r) => r.enabled && r.error === null);
  const conflicts: Conflict[] = [];

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const witnessSegments = shortestWitness(active[i].tokens, active[j].tokens);
      if (witnessSegments === null) continue;
      // 防御性校验：见证路径必须真实命中两条规则
      if (!matchPattern(active[i].tokens, witnessSegments)) continue;
      if (!matchPattern(active[j].tokens, witnessSegments)) continue;

      const matched = active.filter((r) => matchPattern(r.tokens, witnessSegments));
      const winner = pickWinner(matched);
      conflicts.push({
        ruleA: active[i].id,
        ruleB: active[j].id,
        witness: '/' + witnessSegments.join('/'),
        witnessSegments,
        winner: winner ? winner.id : null,
        matchedRules: matched.map((r) => r.id),
      });
    }
  }

  return {
    rules: rules.map(({ tokens: _tokens, ...rest }) => rest),
    conflicts,
  };
}
