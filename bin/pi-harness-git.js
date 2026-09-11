#!/usr/bin/env node
import { evaluateGitHook } from '../src/git.js';

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
try {
  const hook = process.argv[2];
  const verdict = await evaluateGitHook(process.cwd(), hook, process.argv.slice(3), stdin);
  for (const result of verdict.results.filter(item => item.status !== 'pass')) {
    console.error(`Harness ${result.action}: ${result.rule}: ${result.reason}`);
  }
  if (verdict.blocked) process.exitCode = 1;
} catch (error) {
  console.error(`Harness Git hook error: ${error.message}`);
  process.exitCode = 1;
}
