import { useEffect, useMemo, useState } from 'react';

interface ApiRule {
  id: string;
  index: number;
  pattern: string;
  priority: number;
  enabled: boolean;
  error: string | null;
}

interface ApiConflict {
  ruleA: string;
  ruleB: string;
  witness: string;
  witnessSegments: string[];
  winner: string | null;
  matchedRules: string[];
}

interface AnalyzeResponse {
  rules: ApiRule[];
  conflicts: ApiConflict[];
}

interface ParsedRule {
  order: number;
  priority: number;
  pattern: string;
}

const SAMPLE = `# 每行一条规则：<优先级> <路径模式>（# 开头为注释）
# :param 匹配单个段，* 匹配零或多个段
# 优先级数字越大越先命中，平手按输入顺序
10 /api/users/:id
20 /api/users/new
5  /api/*
15 /api/users/:id/settings
30 /assets/*
30 /assets/img/logo.png
40 /api/users/new`;

/** 解析文本框内容：每行 `<优先级> <模式>`，优先级可省略（默认 0） */
function parseRules(text: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let priority = 0;
    let pattern = line;
    const m = line.match(/^(-?\d+)\s+(\S.*)$/);
    if (m) {
      priority = parseInt(m[1], 10);
      pattern = m[2].trim();
    }
    rules.push({ order: rules.length, priority, pattern });
  }
  return rules;
}

export default function App() {
  const [text, setText] = useState(SAMPLE);
  const [disabled, setDisabled] = useState<Record<number, boolean>>({});
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const parsed = useMemo(() => parseRules(text), [text]);

  useEffect(() => {
    const handle = setTimeout(() => {
      fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: parsed.map((r) => ({
            pattern: r.pattern,
            priority: r.priority,
            enabled: !disabled[r.order],
          })),
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          return res.json() as Promise<AnalyzeResponse>;
        })
        .then((data) => {
          setResult(data);
          setFetchError(null);
        })
        .catch((e: unknown) => {
          setFetchError(e instanceof Error ? e.message : String(e));
        });
    }, 200);
    return () => clearTimeout(handle);
  }, [parsed, disabled]);

  const ruleById = useMemo(() => {
    const map = new Map<string, ApiRule>();
    result?.rules.forEach((r) => map.set(r.id, r));
    return map;
  }, [result]);

  const toggleRule = (order: number) =>
    setDisabled((d) => ({ ...d, [order]: !d[order] }));

  const exportJson = () => {
    if (!result) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      rules: result.rules.map(({ id, pattern, priority, enabled, error }) => ({
        id,
        pattern,
        priority,
        enabled,
        error,
      })),
      conflicts: result.conflicts.map((c) => ({
        ruleA: c.ruleA,
        ruleB: c.ruleB,
        witness: c.witness,
        winner: c.winner,
        matchedRules: c.matchedRules,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'route-conflicts.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeCount = result?.rules.filter((r) => r.enabled && !r.error).length ?? 0;
  const errorCount = result?.rules.filter((r) => r.error).length ?? 0;

  return (
    <div className="page">
      <header>
        <h1>路由歧义排查器</h1>
        <p className="subtitle">
          粘贴网关路由规则，自动找出可能同时命中的规则对，生成最短冲突见证路径，并模拟最终命中。
        </p>
      </header>

      <main>
        <section className="panel">
          <div className="panel-title">
            <h2>路由规则</h2>
            <span className="hint">每行一条：&lt;优先级&gt; &lt;路径模式&gt;，# 为注释</span>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={14}
          />

          <div className="rule-list">
            <div className="rule-list-head">
              <span />
              <span>优先级</span>
              <span>路径模式</span>
            </div>
            {parsed.map((r) => {
              const analyzed = result?.rules[r.order];
              const off = !!disabled[r.order];
              return (
                <div
                  key={r.order}
                  className={`rule-row${off ? ' disabled' : ''}${analyzed?.error ? ' invalid' : ''}`}
                >
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => toggleRule(r.order)}
                    />
                    <span className="slider" />
                  </label>
                  <span className="prio">{r.priority}</span>
                  <span className="pattern">
                    <code>{r.pattern}</code>
                    {analyzed?.error && <em className="err">{analyzed.error}</em>}
                  </span>
                </div>
              );
            })}
            {parsed.length === 0 && <div className="empty">尚未输入任何规则</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>冲突分析</h2>
            <div className="actions">
              <span className="hint">
                {activeCount} 条启用{errorCount > 0 ? ` · ${errorCount} 条无效` : ''} ·{' '}
                {result?.conflicts.length ?? 0} 处冲突
              </span>
              <button onClick={exportJson} disabled={!result}>
                导出 JSON
              </button>
            </div>
          </div>

          {fetchError && <div className="banner error">分析请求失败：{fetchError}</div>}

          {result && result.conflicts.length === 0 && !fetchError && (
            <div className="banner ok">✓ 当前启用的规则之间未发现歧义冲突</div>
          )}

          <div className="conflict-list">
            {result?.conflicts.map((c, i) => {
              const a = ruleById.get(c.ruleA);
              const b = ruleById.get(c.ruleB);
              const winner = c.winner ? ruleById.get(c.winner) : undefined;
              const winnerOutsidePair =
                winner && winner.id !== c.ruleA && winner.id !== c.ruleB;
              return (
                <div className="conflict-card" key={i}>
                  <div className="conflict-head">
                    <span className="tag">冲突 #{i + 1}</span>
                    <span className="pair">
                      <code>{a?.pattern}</code>
                      <span className="prio-badge">P{a?.priority}</span>
                      <span className="vs">×</span>
                      <code>{b?.pattern}</code>
                      <span className="prio-badge">P{b?.priority}</span>
                    </span>
                  </div>
                  <div className="witness">
                    <span className="label">最短见证路径</span>
                    <code className="witness-path">{c.witness}</code>
                    <button
                      className="copy"
                      onClick={() => navigator.clipboard.writeText(c.witness)}
                      title="复制见证路径"
                    >
                      复制
                    </button>
                  </div>
                  <div className="winner">
                    <span className="label">模拟最终命中</span>
                    {winner ? (
                      <>
                        <code>{winner.pattern}</code>
                        <span className="prio-badge win">P{winner.priority}</span>
                        {winnerOutsidePair && (
                          <span className="note">（被第三方更高优先级规则截获）</span>
                        )}
                      </>
                    ) : (
                      <span className="note">无</span>
                    )}
                  </div>
                  {c.matchedRules.length > 2 && (
                    <div className="note">
                      该路径同时命中 {c.matchedRules.length} 条规则：
                      {c.matchedRules
                        .map((id) => ruleById.get(id)?.pattern)
                        .filter(Boolean)
                        .join('、')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer>
        段语义：静态段精确匹配 · <code>:param</code> 匹配单段 · <code>*</code> 匹配零或多段 ·
        优先级数字越大越先，平手按输入顺序
      </footer>
    </div>
  );
}
