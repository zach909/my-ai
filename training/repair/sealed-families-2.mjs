/**
 * Second sealed set. Written after round 1 (sealed-families.mjs, 9 of 16 fixed) and after the new edit kinds were
 * added, and BEFORE the agent was run on it. Run once; do not tune on it. Some defects here have no matching edit
 * on purpose (a wrong separator character, missing parentheses), so 100% would be suspicious.
 */
export const SEALED = [
  {
    name: 'sumSquares', params: ['n'],
    correct: `function sumSquares(n) {\n  let t = 0\n  for (let i = 1; i <= n; i++) t += i * i\n  return t\n}`,
    bugs: {
      bound: `function sumSquares(n) {\n  let t = 0\n  for (let i = 1; i < n; i++) t += i * i\n  return t\n}`,
      op: `function sumSquares(n) {\n  let t = 0\n  for (let i = 1; i <= n; i++) t += i + i\n  return t\n}`,
    },
    tests: [[3], [1], [0], [4]],
  },
  {
    name: 'isPositive', params: ['n'],
    correct: `function isPositive(n) {\n  return n > 0\n}`,
    bugs: { incl: `function isPositive(n) {\n  return n >= 0\n}`, dir: `function isPositive(n) {\n  return n < 0\n}` },
    tests: [[5], [0], [-5], [1]],
  },
  {
    name: 'joinDash', params: ['xs'],
    correct: `function joinDash(xs) {\n  return xs.join('-')\n}`,
    bugs: { sep: `function joinDash(xs) {\n  return xs.join(' ')\n}`, none: `function joinDash(xs) {\n  return xs.join('')\n}` },
    tests: [[['a', 'b', 'c']], [['x']], [[]], [['p', 'q']]],
  },
  {
    name: 'secondOf', params: ['xs'],
    correct: `function secondOf(xs) {\n  return xs[1]\n}`,
    bugs: { first: `function secondOf(xs) {\n  return xs[0]\n}`, third: `function secondOf(xs) {\n  return xs[2]\n}` },
    tests: [[[1, 2, 3]], [[9, 8, 7]], [[4, 5, 6, 7]]],
  },
  {
    name: 'both', params: ['a', 'b'],
    correct: `function both(a, b) {\n  return a && b\n}`,
    bugs: { or: `function both(a, b) {\n  return a || b\n}` },
    tests: [[true, true], [true, false], [false, true], [false, false]],
  },
  {
    name: 'countEvens', params: ['xs'],
    correct: `function countEvens(xs) {\n  let c = 0\n  for (const x of xs) if (x % 2 === 0) c++\n  return c\n}`,
    bugs: {
      rem: `function countEvens(xs) {\n  let c = 0\n  for (const x of xs) if (x % 2 === 1) c++\n  return c\n}`,
      init: `function countEvens(xs) {\n  let c = 1\n  for (const x of xs) if (x % 2 === 0) c++\n  return c\n}`,
    },
    tests: [[[2, 4, 5]], [[1, 3]], [[]], [[6, 8, 10, 11]]],
  },
  {
    name: 'trimmedLength', params: ['s'],
    correct: `function trimmedLength(s) {\n  return s.trim().length\n}`,
    bugs: { notrim: `function trimmedLength(s) {\n  return s.length\n}`, extra: `function trimmedLength(s) {\n  return s.trim().length + 1\n}` },
    tests: [['  hi '], ['abc'], [''], ['   ']],
  },
  {
    name: 'average2', params: ['a', 'b'],
    correct: `function average2(a, b) {\n  return (a + b) / 2\n}`,
    bugs: { paren: `function average2(a, b) {\n  return a + b / 2\n}`, div: `function average2(a, b) {\n  return (a + b) / 3\n}` },
    tests: [[2, 4], [10, 20], [0, 6], [-4, 4]],
  },
]
