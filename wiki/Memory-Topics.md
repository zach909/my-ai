# Memory Topics

Memory kept as a **folder tree of topics** instead of one giant list. The AI files notes into it, updates them, and searches it itself.

```
people/
  alex.md
projects/
  garden/plan.md
  garden/shopping.md
preferences/coding.md
```

Each note is a small markdown file on disk, in `memory-topics/` inside your NeuroClaw data folder (`~/.neuroclaw/` unless you moved it). You can open, edit, back up or delete them with any editor. Each account has its own tree.

## What the AI does with it

Through the `memory-topics` plugin, from any chat:

| Command | What it does |
|---------|--------------|
| `memory tree` | Shows the folders and notes, so it can pick where something belongs. |
| `memory search <words>` | Finds notes by topic words. A match in a folder or note **name** counts most, then the title, then the text. |
| `memory read <path>` | Opens one note. |
| `memory save <path>: <text>` | Creates a note, or replaces it. |
| `memory add <path>: <text>` | Adds one dated line to a note. This is the everyday way to update. |
| `memory move <from> to <to>` | Re-files a note or a whole folder when a topic outgrows its place. |
| `memory forget <path>` | Forgets a note, or an empty folder. |

A prompting skill can also use `topics` as a perception source, to read from these notes while it works.

## Limits and safety

- Paths are rewritten to plain lowercase names (letters, digits, dots, hyphens), at most 6 levels deep. `..`, absolute paths and links are refused, so nothing can be written outside the tree.
- A note is at most 20,000 characters when saved and 50,000 once lines are added. When one fills up, the AI is told to split it into subtopics.
- Up to 5,000 notes.
- The AI can forget one note, but forgetting a folder that still has notes in it is refused. That is the owner's call, through the routes below.

## For you

Routes (behind the normal sign-in): `GET /api/memory-topics`, `GET /api/memory-topics/search?q=`, `GET|PUT /api/memory-topics/note`, `POST /api/memory-topics/append`, `POST /api/memory-topics/move`, `DELETE /api/memory-topics?path=` (add `&recursive=1` for a folder with notes in it).

**Delete all memory** in Settings also clears these notes.
