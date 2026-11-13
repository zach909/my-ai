# Extension Builder

The Extension Builder is where a user (or the AI itself, via the Plugin Builder / Skill Builder skills — see [[Skills]]) creates, connects, and installs new neural behaviour — the design notes' "Save projects without quantization. Install projects using quantization." plus the visual drag-and-connect editor.

## Overview

**Purpose**: Turn a declarative spec (drag-and-connect neurons, or a [[NeuroLang]] program) into trained weights, saved editable, then installed compressed.

Like the mesh itself, there are two real, connected implementations:

| Layer | File | What it is |
|---|---|---|
| TypeScript runtime backend | `extension-builder/builder.js` (JS-only module; no `.ts` source has ever existed here) — `ExtensionBuilder` | Project/neuron/connection CRUD, Net Search, Code-to-Net, save/install |
| React visual editor | `src/features/builder/builder-canvas.tsx` + `use-builder.ts` | The actual drag-and-connect canvas — pointer-drag to move, click-click to connect, HTML5-drag to attach a label, click a connection's weight to delete it |

## The visual editor (drag-and-connect)

`builder-canvas.tsx` implements every Extension Builder feature from the design notes directly against the real engine (not a mock):

- **Drag to arrange**: `onPointerDown`/`onPointerMove` write positions back through `engine.moveNeuron`.
- **Connect mode**: click a source neuron, then a target — installs a real weighted connection (rendered as an SVG curve labeled with its weight; click the label to delete it).
- **Drag labels between neurons**: HTML5 drag-and-drop of a label chip onto a node calls `engine.dragLabel` — the spec's literal "drag labels between neurons."
- **Search neurons**: matches are highlighted with a ring on the canvas (`searchMatches`).
- **Simulate a neuron's output**: `typeModelOutput` — feed one input value into one neuron and see what it produces, without running the whole mesh.
- **API-capable output layers**: `addOutputLayer` with an `APIOutputConfig` (endpoint/method/port/auth) turns a neuron's activation into a call to a local endpoint — gated through the alignment veto, never external.

## Save vs. install (`ExtensionBuilder`, TypeScript)

```typescript
builder.saveWithoutQuantization(projectId);      // exact weights, still editable
builder.installWithQuantization(projectId, { bits: 8, ... });  // compressed, deployment-ready
```

This is the direct implementation of "Save projects without quantization. Install projects using quantization." — a project stays full-precision and editable until you're ready to deploy it, at which point installing quantizes it (see [[Quantization]]).

## Training contracts (`ExtensionBuilder`, Python)

`eb.train(contracts, ...)` actually trains the mesh with gradient descent until each contract's constraint loss drops below tolerance (or the epoch budget runs out); satisfied contracts are the mesh's own [[Elastic-Value-Budget]] locking in via `raise_vale()`. This is also the real mechanism behind the **Skill Builder** skill (`build_skill()`, see [[Skills]]) — building an extension and building a new skill are the same operation, just registered differently afterward.

## Net Search & Code-to-Net

- **Net Search** (`netSearch` / `netSearchGenerate` in TS, `NetSearchManager` in Python's `neurolang.py`): semantic search across neural definitions, then trains a small retrieval net and wires a new `netsearch`-type neuron to each match with a weighted edge.
- **Code-to-Net** (`importCodeToNet` in TS, `train_codenet` in Python's `neurolang.py`): imports source or binary code and converts it into an equivalent neural network — function approximation when the code defines a numeric function.

## Knowledge extensions (cited data)

An extension does not have to be neurons. `extension-builder/corpus-extension.mjs` builds a **knowledge
extension** from the cited open corpus in `training_data/open_corpus/` (fetched by
`scripts/fetch-open-corpus.mjs`: Project Gutenberg public-domain books and Wikipedia text under CC BY-SA 4.0,
each with its link, licence, access date, revision and SHA-256).

```bash
node scripts/fetch-open-corpus.mjs                                   # get the data and write the citations
node extension-builder/build-corpus-extension.mjs                    # -> extension-builder/extensions/open-corpus-knowledge.kx.json
node extension-builder/build-corpus-extension.mjs --search "second law of thermodynamics"
node extension-builder/build-corpus-extension.mjs --verify extension-builder/extensions/open-corpus-knowledge.kx.json
```

- **No citation, no extension.** The build stops if any text file is missing from `manifest.json`, has a
  licence other than public domain or CC BY-SA 4.0, or no longer matches its recorded SHA-256.
- **Passages are exact slices** of the source (`text.slice(o, o + n)`), each with a hash and an offset, so a
  passage can always be traced to the place it came from. The extension id is a hash of the sources.
- **Search never returns text without its citation** (`searchKnowledgeExtension`). It compares character
  3-grams of the raw text; there is no tokenizer.
- **ShareAlike travels with the data:** the file carries an attribution block (authors via each article's
  history link, licence obligations). Keep it with any copy.
- The suffix is `.kx.json`, not `.ext.json`, because the server grafts the `neurons` of every `*.ext.json` at boot.
- `applyToBuilder(builder, ext)` puts the sources into a live `ExtensionBuilder` as `netsearch` neurons. It is
  only tested against a stand-in builder (`test/platform/corpus-extension.test.mjs`); run it against the real
  engine once the backend is built.

## Verifying it

- `python main.py demo` (`test_integration.py`, §3) saves a project un-quantized, installs it quantized, confirms the installed file is smaller, and reloads the installed extension into a **fresh** model object to prove the behaviour genuinely persisted rather than surviving in memory.
- `npm test` (`test/smoke.mjs`)'s "Extension Builder flow" section covers drag-connect, drag-label, simulate, output layers, Net Search (including the null-result edge cases for an empty or untokenizable query), and the save-vs-install size/behaviour distinction directly.

## Implementation specification

`docs/EXTENSION_BUILDER_SPEC.md` is the full build-out spec for everything
this page describes plus the gaps not yet built: the versioned `.ext`/`.extproj`
file format, the `.extpkg` package format, the install/uninstall procedure,
a real debugger (breakpoints, step propagation, activation inspector), a
unified search command palette, and the full test matrix.

## See Also

- [[Home]] - Main wiki page
- [[NeuroLang]] - The DSL that can drive the builder as text instead of drag-and-connect
- [[Quantization]] - What "install" actually does to the weights
- [[Skills]] - Skill Builder / Plugin Builder, which call this machinery programmatically
- [[Code-to-Net]] - Importing existing code as a neural network
- [[Net-Search]] - Semantic search over neural definitions

---

*The Extension Builder is how a taught behaviour becomes a permanent, installable part of the mesh — save it exact, install it compressed.*
