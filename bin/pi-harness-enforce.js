#!/usr/bin/env node
import { evaluate, loadProject } from '../src/engine.js';

try {
  const eventName = process.argv[2] ?? process.env.PI_HARNESS_EVENT;
  const inputText = process.argv[3] ?? process.env.PI_HARNESS_INPUT ?? '{}';
  if (!eventName || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(eventName)) throw new Error('Required event name, for example github:pull-request');
  const supplied = JSON.parse(inputText);
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Event input must be a JSON object');
  const input = eventName.startsWith('github:') ? {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    ref: process.env.GITHUB_REF ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    baseRef: process.env.GITHUB_BASE_REF ?? null,
    headRef: process.env.GITHUB_HEAD_REF ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    githubEventName: process.env.GITHUB_EVENT_NAME ?? null,
    ...supplied,
  } : supplied;
  const project = await loadProject(process.cwd());
  if (!project) throw new Error('No .harness/config.json found');
  const verdict = await evaluate(project, { toolName: eventName, input, cwd: process.cwd() });
  if (!verdict.results.length) throw new Error(`No enabled enforcement matched ${eventName}`);
  for (const result of verdict.results.filter(item => item.status !== 'pass')) {
    console.error(`Harness ${result.action}: ${result.rule}: ${result.reason}`);
  }
  console.log(JSON.stringify({ event: eventName, blocked: verdict.blocked, checks: verdict.results.length }));
  if (verdict.blocked) process.exitCode = 1;
} catch (error) {
  console.error(`Harness enforcement error: ${error.message}`);
  process.exitCode = 1;
}
