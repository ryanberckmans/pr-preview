// Turns the check step's outcome and log into outputs for the PR comment.
import { existsSync, readFileSync } from 'node:fs';
import { isMain, main, readEnv, setOutputs } from './lib/common.mjs';

const MAX_LINES = 40;
const MAX_CHARS = 3000;

export function tailOf(text) {
  const plain = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  let tail = plain.trimEnd().split('\n').slice(-MAX_LINES).join('\n');
  if (tail.length > MAX_CHARS) tail = `…${tail.slice(-MAX_CHARS)}`;
  return tail;
}

export function checkResult(outcome, logFile) {
  const status = outcome === 'success' ? 'passed' : outcome === 'failure' ? 'failed' : 'none';
  const tail = status === 'failed' && logFile && existsSync(logFile) ? tailOf(readFileSync(logFile, 'utf8')) : '';
  return { status, tail };
}

if (isMain(import.meta.url)) {
  await main(async () => {
    setOutputs(checkResult(readEnv(process.env, 'CHECK_OUTCOME'), readEnv(process.env, 'CHECK_LOG')));
  });
}
