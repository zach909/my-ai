/**
 * Coding jobs: telling a coding message from any other, which of the four jobs it is, and how hard it looks
 * (models && skills/core/coding-jobs.ts), and what that does to auto route's effort (core/auto-route.ts).
 * Pure logic against the compiled modules, Node built-ins only; nothing is mocked except the device.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBuilt, dist } from './helpers.mjs';

ensureBuilt();
const C = await import(dist('models && skills/core/coding-jobs.js'));
const A = await import(dist('models && skills/core/auto-route.js'));

const GB = 1024 ** 3;

/* --------------------------------------------------------- not a coding job */

test('messages that are not about software are left alone', () => {
  for (const text of [
    'hi',
    'thanks!',
    "what's the weather like in Lisbon",
    'write a poem about autumn',
    'fix my sleep schedule',
    'explain why the sky is blue',
    "what's a good recipe for a class dinner",
    '',
    '   ',
  ]) assert.equal(C.detectCodeIntent(text), null, JSON.stringify(text));
  assert.equal(C.detectCodeIntent(undefined), null);
  assert.equal(C.detectCodeIntent(42), null);
});

test('a software word on its own, with no ask, is not a coding job', () => {
  assert.equal(C.detectCodeIntent('my favourite word is algorithm'), null);
});

/* ------------------------------------------------------------- the four jobs */

test('write: asks for code to be made', () => {
  const r = C.detectCodeIntent('write a python function that reverses a string');
  assert.equal(r.task, 'write');
  assert.equal(r.language, 'python');
  assert.equal(r.difficulty, 'simple');
  assert.equal(r.hasCode, false);
});

test('explain: asks what code does', () => {
  const r = C.detectCodeIntent('explain what this does:\n```js\nconst doubled = items.map(x => x * 2);\nconsole.log(doubled);\n```');
  assert.equal(r.task, 'explain');
  assert.equal(r.language, 'javascript');
  assert.equal(r.hasCode, true);
});

test('debug: a Python traceback', () => {
  const r = C.detectCodeIntent('Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    print(x)\nNameError: name x is not defined');
  assert.equal(r.task, 'debug');
  assert.equal(r.language, 'python');
  assert.equal(r.hasTrace, true);
  assert.ok(r.reasons.some((x) => /stack frame/.test(x)));
});

test('debug: a JavaScript stack trace', () => {
  const r = C.detectCodeIntent("why does this crash?\nTypeError: Cannot read properties of undefined (reading 'id')\n    at load (/app/user.js:10:5)\n    at run (/app/main.js:4:3)");
  assert.equal(r.task, 'debug');
  assert.equal(r.hasTrace, true);
  assert.equal(r.language, 'javascript');
});

test('debug: no trace, just "it does not work" about code', () => {
  const r = C.detectCodeIntent("my rust function doesn't work and returns the wrong result");
  assert.equal(r.task, 'debug');
  assert.equal(r.language, 'rust');
});

test('technical: engineering questions that are not about typing code', () => {
  const r = C.detectCodeIntent('what is the time complexity of quicksort in the worst case');
  assert.equal(r.task, 'technical');
  const r2 = C.detectCodeIntent('should we shard the database or add read replicas?');
  assert.equal(r2.task, 'technical');
});

test('the tie-break: an error beats "explain", and explain beats write', () => {
  const trace = C.detectCodeIntent('explain this:\nTypeError: x is not a function\n    at f (/a.js:1:1)');
  assert.equal(trace.task, 'debug');
  const mixed = C.detectCodeIntent('explain this function, then write a test for it:\n```py\ndef add(a, b):\n    return a + b\n```');
  assert.equal(mixed.task, 'explain');
});

test('the language comes from the fence tag, a file name or a word', () => {
  assert.equal(C.detectCodeIntent('fix this:\n```ts\nlet a: number = "x";\nconsole.log(a);\n```').language, 'typescript');
  assert.equal(C.detectCodeIntent('refactor main.go so the handler is smaller').language, 'go');
  assert.equal(C.detectCodeIntent('write a bash script that backs up my home folder').language, 'bash');
  assert.equal(C.detectCodeIntent('write a function that sorts an array').language, null);
});

/* --------------------------------------------------------------- difficulty */

test('plain jobs are simple, hard bugs are complex', () => {
  assert.equal(C.detectCodeIntent('how do I reverse a list in python').difficulty, 'simple');
  const hard = C.detectCodeIntent('my python service has a race condition that makes the tests fail intermittently in production; I already tried everything and it still fails');
  assert.equal(hard.task, 'debug');
  assert.equal(hard.difficulty, 'complex');
  assert.ok(hard.score >= 3);
});

test('a deep stack trace and a large paste each push the score up', () => {
  const frames = Array.from({ length: 8 }, (_, i) => `    at f${i} (/app/m${i}.js:${i + 1}:1)`).join('\n');
  const deep = C.detectCodeIntent('TypeError: boom\n' + frames);
  assert.ok(deep.reasons.some((r) => /deep stack trace/.test(r)));
  const lines = Array.from({ length: 50 }, (_, i) => `const v${i} = compute(${i});`).join('\n');
  const big = C.detectCodeIntent('why does this fail?\n```js\n' + lines + '\n```');
  assert.ok(big.reasons.some((r) => /lines of code/.test(r)));
});

/* ------------------------------------------------------------------- effort */

const intent = (text) => C.detectCodeIntent(text);
const HARD_BUG = 'my python service has a race condition that makes the tests fail intermittently in production; I already tried everything and it still fails';
const MEDIUM_HARD = 'my java service deadlocks and the build fails';

test('effort: a hard job is raised to a floor, debugging higher than the rest, a very hard one to the top', () => {
  assert.equal(C.adjustEffortForCode(30, intent(HARD_BUG)).level, C.CODE_VERY_HARD_FLOOR);
  const mid = intent(MEDIUM_HARD);
  assert.equal(mid.difficulty, 'complex');
  assert.equal(mid.task, 'debug');
  assert.equal(C.adjustEffortForCode(30, mid).level, mid.score >= 3 ? C.CODE_VERY_HARD_FLOOR : C.CODE_COMPLEX_DEBUG_FLOOR);
  const design = intent('review the architecture of our microservices across the services and say what to change');
  assert.equal(design.difficulty, 'complex');
  assert.equal(C.adjustEffortForCode(30, design).level, C.CODE_COMPLEX_FLOOR);
  const note = C.adjustEffortForCode(30, intent(HARD_BUG)).note;
  assert.match(note, /effort raised from 30 to 90/);
});

test('effort: it is a floor for hard jobs, never a cut', () => {
  assert.equal(C.adjustEffortForCode(97, intent(HARD_BUG)).level, 97);
  assert.equal(C.adjustEffortForCode(97, intent(HARD_BUG)).note, null);
});

test('effort: a plain job is held at a ceiling, but never below what the ask alone earned', () => {
  const plain = intent('how do I reverse a list in python');
  assert.equal(C.adjustEffortForCode(65, plain).level, C.CODE_SIMPLE_CEILING);
  assert.match(C.adjustEffortForCode(65, plain).note, /held at 40/);
  assert.equal(C.adjustEffortForCode(65, plain, 65).level, 65, 'an ask that earned 65 keeps 65');
  assert.equal(C.adjustEffortForCode(65, plain, 55).level, 55, 'the ceiling follows the ask');
  assert.equal(C.adjustEffortForCode(20, plain).level, 20, 'a ceiling never raises');
});

test('askOf: the message with the code taken out', () => {
  const msg = 'why does this fail?\n```js\nconst a = 1;\nconst b = 2;\n```\nTypeError: boom\n    at f (/a.js:1:1)\nthanks';
  const ask = C.askOf(msg);
  assert.ok(ask.includes('why does this fail?'));
  assert.ok(ask.includes('thanks'));
  assert.ok(!ask.includes('const a'));
  assert.ok(!ask.includes('at f ('));
  assert.equal(C.askOf('```js\nlet x = 1;\n'), '', 'an unclosed fence is code to the end');
  assert.equal(C.askOf(undefined), '');
});

test('effort: anything that is not code comes back untouched', () => {
  assert.deepEqual(C.adjustEffortForCode(77, null), { level: 77, note: null });
});

/* ------------------------------------------------------------ auto route use */

const device = { kind: 'desktop', platform: 'linux', cores: 8, totalMemBytes: 32 * GB, freeMemBytes: 24 * GB, load: 0.1, mops: 6000, battery: null, online: true };
const request = (over = {}) => ({ auto: true, instant: false, optimize: false, effort: null, ...over });
const route = (prompt, over = {}) => A.planRoute({
  prompt, device, remote: { available: false }, fullModelBytes: 4 * GB, quantizedModelBytes: 1 * GB, request: request(), ...over,
});

test('auto route: a hard debugging message gets the top of the dial and says why', () => {
  const plan = route(HARD_BUG);
  assert.equal(plan.code.task, 'debug');
  assert.equal(plan.effort.level, C.CODE_VERY_HARD_FLOOR);
  assert.equal(plan.effort.tryAnother, true, 'at the top the mesh tries a second way and compares');
  assert.equal(plan.effort.source, 'auto');
  assert.ok(plan.effort.estimated < plan.effort.level, 'the raw estimate is kept beside the adjusted level');
  assert.ok(plan.reasons.some((r) => /coding job: debug in python, complex/.test(r)));
  assert.ok(plan.reasons.some((r) => /effort raised/.test(r)));
});

test('auto route: a plain code question is held at a steady setting', () => {
  const plan = route('how do I reverse a list in python?\n```py\nxs = [1, 2, 3]\nprint(xs)\n```');
  assert.equal(plan.code.task, 'write', 'a how-to question asks for code');
  assert.equal(plan.code.difficulty, 'simple');
  assert.ok(plan.effort.level <= C.CODE_SIMPLE_CEILING);
});

test('auto route: a dial set by hand, and instant, are never adjusted', () => {
  const manual = route(HARD_BUG, { request: request({ effort: 10 }) });
  assert.equal(manual.effort.level, 10);
  assert.equal(manual.effort.source, 'manual');
  assert.ok(manual.code, 'it is still read, so the panel can show it');
  const instant = route(HARD_BUG, { request: request({ instant: true }) });
  assert.equal(instant.effort.level, 5);
  assert.equal(instant.effort.source, 'instant');
});

test('auto route: pasted code does not make a plain question a big job, but a many-part ask keeps its effort', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `const v${i} = compute(${i});`).join('\n');
  const pasted = route('why is v3 wrong?\n```js\n' + lines + '\n```');
  const bare = route('why is v3 wrong?');
  assert.ok(pasted.effort.level <= Math.max(C.CODE_SIMPLE_CEILING, bare.effort.level), 'the paste adds nothing');
  const rateLimiter = 'Design and implement a rate limiter for our API, then write the tests, and finally explain the trade-offs step by step.';
  const big = route(rateLimiter);
  assert.ok(big.code, 'it is a coding message');
  assert.ok(big.effort.level >= 70, 'a many-part build keeps the effort the estimate gave it');
  assert.equal(big.effort.level, big.effort.estimated, 'nothing was cut');
});

test('auto route: a message that is not code has no code entry and the same effort as before', () => {
  const plan = route('hello');
  assert.equal(plan.code, null);
  assert.ok(!plan.reasons.some((r) => /coding job/.test(r)));
  assert.ok(plan.effort.level < 15);
  const plain = route('what time is it in Tokyo?');
  assert.equal(plain.code, null);
  assert.equal(plain.effort.level, plain.effort.estimated);
});

test('auto route: engine and the secret rule are not changed by the coding-jobs reader', () => {
  const secret = HARD_BUG + '\nmy api key is sk-live_abcdefghijklmnop1234567890';
  const plan = route(secret, { remote: { available: true } });
  assert.notEqual(plan.engine, 'remote');
  assert.equal(plan.where, 'local');
});

test('the summary carries the code job only for a coding message', () => {
  const coding = A.routeSummary(route(HARD_BUG), HARD_BUG);
  assert.deepEqual(coding.code, { task: 'debug', difficulty: 'complex', language: 'python' });
  const other = A.routeSummary(route('hello'), 'hello');
  assert.equal('code' in other, false);
  JSON.stringify(coding); // small and safe to send as JSON
});
