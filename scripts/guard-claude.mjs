import fs from 'node:fs';
import { evaluateCommand } from './evaluate-command.mjs';

try {
  const raw = fs.readFileSync(0, 'utf8');
  const input = raw ? JSON.parse(raw) : {};
  const cmd = input?.tool_input?.command ?? '';
  const cwd = input?.cwd ?? '';

  const result = evaluateCommand(cmd, { cwd, workspacePaths: cwd ? [cwd] : [] });

  if (result.action === 'deny' || result.action === 'force_ask' || result.action === 'allow') {
    const permissionDecision = result.action === 'force_ask' ? 'ask' : result.action;
    const hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision,
      ...(result.reason ? { permissionDecisionReason: result.reason } : {})
    };
    process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
} catch (error) {
  console.error('[guard-claude] Failed to evaluate command:', error);
  process.stdout.write(JSON.stringify({}));
}
