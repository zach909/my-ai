# NeuroLang Syntax Reference

A condensed cheat-sheet for the [[NeuroLang]] directive grammar, plus the spec-literal / dialect aliasing that page doesn't cover.

## Quick reference

| Directive | Purpose |
|---|---|
| `name="x"` | Create and name a neuron |
| `"x"@value="n"` (old: `@vale`) | What the neuron is worth, and (clamped to 0..1) how much it resists change ([[Elastic-Value-Budget]]) |
| `"x"@connections=".y/var"*"bias"+"weight"` | Explicit connection (defaults to all-to-all if omitted) |
| `"x"@definition="d"` (old: `@definishon`) | Output when the neuron alone has input |
| `code@name="x"` | Name a [[Code-to-Net]] import |
| `"x"@code="src"` | Attach the source/binary to import |
| `"netsearch"@name="x"` | Name a [[Net-Search]] definition |
| `"netsearch"@net="path"` | Corpus location for that search |
| `train` | Run training over the contracts defined so far |
| `kind="network"` / `kind="skill"` | A network of its own, or a skill grafted into the live AI ([[Net-Maker]]) |
| `neurons="64"` | Make 64 neurons (`n1`..`n64`), each connected to the others |
| `neurons@value=` / `@frozen=` | Defaults for those neurons |
| `"x"@frozen="now"` / `"after"` | Never trained or edited, or frozen once training is done |
| `"x"@input="text"` | Typing this drives `x` as hard as a neuron can be driven |
| `"x"@response="text"` | With only `x` driven, the output must say this |
| `"x"@reads="y"` | Which neuron says the response (default: the output neuron) |
| `train="responses"` / `"predict"` / `"random"` | Train the responses, learn to predict given text, or predict generated content |
| `train@epochs=` / `@rounds=` / `@seed=` / `@text=` | How long, how many rounds, the random seed, the text to predict |

## Text, quotes and comments

- A value goes in double quotes. Inside one, `\"` is a quote and `\\` is a backslash: `"a"@definition="he said \"hi\""`.
- `--` starts a comment **outside** a value; inside a value it is just text. A whole line starting with `#` is a comment.
- Not accepted: single quotes, and upper-case keywords (`NAME=`). Keywords are lower-case.
- Numbers may be negative or scientific (`-2`, `1e-3`). The value is clamped to 0..1 for how much it resists change. A connection weight may be negative (`".b*-0.5"`), which is how one neuron inhibits another.

## The bare form

An attribute on a line of its own applies to the neuron the last `name="x"` (or `code@name="x"`) opened, as in the older design notes:

```
name="hidden_layer"
value="5"
connections=".input_layer"*"0.5"+"1.0"
```

is the same as `"hidden_layer"@value="5"` and `"hidden_layer"@connections=".input_layer*0.5+1.0"`. A bare attribute before any `name=` is an error. In a connection, the numbers after `*` and `+` add: `*0.5+1.0` is a weight of 1.5.

## Warnings

A program that parses can still carry `warnings`: a neuron mentioned but never declared when `neurons="N"` was used (usually a typo), a `kind` given twice, a `neurons` count given twice, and two neurons with the same `@input`. The net maker passes them on.

## Spellings

Write the correct spellings: `@value`, `@connections`, `@definition`. The original design notes spelled them `@vale`, `@conections` and `@definishon`. Those older spellings are still accepted and mean **exactly** the same, so older programs and notes keep working.

`@value` and `@vale` are one setting. The number is stored as written and also, clamped to 0..1, as how much the neuron resists change, which is what the [[Elastic-Value-Budget]] reads. (Until this was unified, the TypeScript parser stored `@value` and applied `@vale` as two separate things, so a program written with the correct spelling had no effect on the budget. The Python `asi_core` parser always treated them as one.)

The `@connections=` bias/weight numbers follow the same rule: the design notes quote them (`*"bias"+"weight"`), so the parser accepts `*"0.5"+"0.3"`, `*0.5+0.3`, or a mix — all install the same weight.

## `@connections=` and named state variables

`"x"@connections=".y/variable"*"bias"+"weight"` connects `x` to `y`. The `/variable` part names *which* of `y`'s state variables this connection reads — the concrete surface of Higher-Dimensional Thinking's "each neuron maintains temporary state variables describing every other neuron" ([[Hyperdimensional]]). Each neuron assigns its own variable names to its own state dimensions (first-seen order), so the same name always resolves to the same dimension. A connection to a named variable reads just that one dimension of the target; the whole-state names (`state`, `all`, `*`) or a plain `.y` read the target's full state vector, which is also the default when `@connections=` is omitted entirely (all-to-all). `test_core.py`'s `test_neurolang_spec_aliases` covers both the named-dimension and whole-state paths.

## `@net=` binding order

`"netsearch"@net=` binds to the most recently declared *pending* `"netsearch"@name=` in parse order — a real, tested edge case: if two `netsearch` definitions are declared before either gets its `@net=`, an earlier pending one is not mis-bound by a later `@net=` meant for the second. See [[Net-Search]].

## See Also

- [[Home]] - Main wiki page
- [[NeuroLang]] - The full directive reference with worked examples
- [[Code-to-Net]] - The `code@`/`@code=` directives in depth
- [[Net-Search]] - The `netsearch@` directives in depth
- [[Builder]] - The visual editor that can generate this syntax for you

---

*One setting, two spellings: write the correct one, and the older one still works.*
