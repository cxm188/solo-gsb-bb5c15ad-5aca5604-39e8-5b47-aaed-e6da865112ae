import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { analyze, RuleInput } from './analyze';

const app = express();
app.use(express.json({ limit: '1mb' }));

const MAX_RULES = 300;

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post('/api/analyze', (req: Request, res: Response) => {
  const body = req.body as { rules?: RuleInput[] } | undefined;
  if (!body || !Array.isArray(body.rules)) {
    res.status(400).json({ error: '请求体需为 { rules: [{ pattern, priority?, enabled? }] }' });
    return;
  }
  if (body.rules.length > MAX_RULES) {
    res.status(400).json({ error: `规则数量超过上限 ${MAX_RULES}` });
    return;
  }
  try {
    res.json(analyze(body.rules));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// 生产模式下由后端托管前端构建产物
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA 回退：非 API 的 GET 请求一律返回前端入口
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`route-ambiguity-explorer listening on http://0.0.0.0:${port}`);
});
