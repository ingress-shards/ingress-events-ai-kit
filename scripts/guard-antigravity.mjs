import { readFileSync } from 'node:fs';
import { evaluateCommand } from './evaluate-command.mjs';

try {
  const raw = readFileSync(0, 'utf8');
  const input = raw ? JSON.parse(raw) : {};
  const cmd = input?.toolCall?.args?.CommandLine ?? '';
  const cwd = input?.cwd ?? '';
  const workspacePaths = input?.workspacePaths ?? [];

  const result = evaluateCommand(cmd, { cwd, workspacePaths });
  const decision = result.action === 'allow' ? 'auto_approve' : result.action;
  const payload = result.reason ? { decision, reason: result.reason } : { decision };

  process.stdout.write(JSON.stringify(payload));
} catch (error) {
  console.error('[guard-antigravity] Failed to evaluate command:', error);
  process.stdout.write(JSON.stringify({ decision: 'ask' }));
}
