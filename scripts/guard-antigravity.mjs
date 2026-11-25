import fs from 'node:fs';
import { evaluateCommand } from './evaluate-command.mjs';

try {
  const raw = fs.readFileSync(0, 'utf8');
  const input = raw ? JSON.parse(raw) : {};
  const cmd = input?.toolCall?.args?.CommandLine ?? '';
  const cwd = input?.cwd ?? '';
  const workspacePaths = input?.workspacePaths ?? [];

  const result = evaluateCommand(cmd, { cwd, workspacePaths });
  const payload = result.reason
    ? { decision: result.action, reason: result.reason }
    : { decision: result.action };

  process.stdout.write(JSON.stringify(payload));
} catch (error) {
  console.error('[guard-antigravity] Failed to evaluate command:', error);
  process.stdout.write(JSON.stringify({ decision: 'ask' }));
}
