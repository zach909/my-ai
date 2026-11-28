/**
 * Sealed test families for the repair agent. Written AFTER the agent's edit kinds were fixed and BEFORE the
 * agent was ever run on them, then run once. They must not be used to tune the agent: if they are, they stop
 * being a test. Add new families to test again; do not edit these to make the agent pass.
 *
 * Each family: the correct source, named defects (each is a full source with that defect), and the check inputs.
 * Expected values are never written here. They come from RUNNING the correct version (see sealed.mjs), the same
 * rule as scripts/drill-generators/repair.mjs. Some defect kinds below have NO matching edit in agent.mjs on
 * purpose, so a score of 100% would be suspicious.
 */
export const SEALED = [
  {
    name: 'sumTo', params: ['n'],
    correct: `function sumTo(n) {\n  let t = 0\n  for (let i = 1; i <= n; i++) t += i\n  return t\n}`,
    bugs: {
      bound: `function sumTo(n) {\n  let t = 0\n  for (let i = 1; i < n; i++) t += i\n  return t\n}`,
      start: `function sumTo(n) {\n  let t = 0\n  for (let i = 0; i <= n; i++) t += i + 1\n  return t\n}`,
    },
    tests: [[5], [1], [0], [10]],
  },
  {
    name: 'isEven', params: ['n'],
    correct: `function isEven(n) {\n  return n % 2 === 0\n}`,
    bugs: { rem: `function isEven(n) {\n  return n % 2 === 1\n}`, op: `function isEven(n) {\n  return n % 2 !== 0\n}` },
    tests: [[4], [7], [0], [-3], [-8]],
  },
  {
    name: 'lastOf', params: ['xs'],
    correct: `function lastOf(xs) {\n  return xs[xs.length - 1]\n}`,
    bugs: { index: `function lastOf(xs) {\n  return xs[xs.length]\n}`, first: `function lastOf(xs) {\n  return xs[0]\n}` },
    tests: [[[1, 2, 3]], [[9]], [[4, 8]]],
  },
  {
    name: 'countVowels', params: ['s'],
    correct: `function countVowels(s) {\n  const t = s.toLowerCase()\n  let c = 0\n  for (const ch of t) if ('aeiou'.includes(ch)) c++\n  return c\n}`,
    bugs: {
      casing: `function countVowels(s) {\n  const t = s\n  let c = 0\n  for (const ch of t) if ('aeiou'.includes(ch)) c++\n  return c\n}`,
      init: `function countVowels(s) {\n  const t = s.toLowerCase()\n  let c = 1\n  for (const ch of t) if ('aeiou'.includes(ch)) c++\n  return c\n}`,
    },
    tests: [['hello'], ['AEIOU'], ['xyz'], [''], ['Banana']],
  },
  {
    name: 'absDiff', params: ['a', 'b'],
    correct: `function absDiff(a, b) {\n  return Math.abs(a - b)\n}`,
    bugs: { noabs: `function absDiff(a, b) {\n  return a - b\n}`, sign: `function absDiff(a, b) {\n  return Math.abs(a + b)\n}` },
    tests: [[3, 8], [8, 3], [5, 5], [-2, 4]],
  },
  {
    name: 'factorial', params: ['n'],
    correct: `function factorial(n) {\n  let r = 1\n  for (let i = 2; i <= n; i++) r *= i\n  return r\n}`,
    bugs: {
      init: `function factorial(n) {\n  let r = 0\n  for (let i = 2; i <= n; i++) r *= i\n  return r\n}`,
      bound: `function factorial(n) {\n  let r = 1\n  for (let i = 2; i < n; i++) r *= i\n  return r\n}`,
    },
    tests: [[5], [1], [0], [3]],
  },
  {
    name: 'reverseWords', params: ['s'],
    correct: `function reverseWords(s) {\n  return s.split(' ').reverse().join(' ')\n}`,
    bugs: {
      noreverse: `function reverseWords(s) {\n  return s.split(' ').join(' ')\n}`,
      sep: `function reverseWords(s) {\n  return s.split(' ').reverse().join('')\n}`,
    },
    tests: [['one two three'], ['a b'], ['solo'], ['x y z w']],
  },
  {
    name: 'inRange', params: ['x', 'lo', 'hi'],
    correct: `function inRange(x, lo, hi) {\n  return x >= lo && x <= hi\n}`,
    bugs: {
      strict: `function inRange(x, lo, hi) {\n  return x > lo && x <= hi\n}`,
      or: `function inRange(x, lo, hi) {\n  return x >= lo || x <= hi\n}`,
    },
    tests: [[5, 1, 9], [1, 1, 9], [9, 1, 9], [0, 1, 9], [10, 1, 9]],
  },
]
