# GameNight — working notes

## How the owner wants work done
- Be wise, smart and bold: write good, elegant code and trust it.
- Don't test or screenshot everything. Only test when it's genuinely necessary (a risky
  change to the sim rules, something that can't be reasoned about from the code).
- Remember what has been asked before; don't make the owner repeat it.
- Bump the version in `package.json` on every push (it's shown on the home screen).
- Two chats may work on this branch at once: fetch before pushing and merge (never
  overwrite) anything new on the remote.

## Current product decisions
- Graphics: the pixel-art look is the only mode. Palette and HD are retired but kept
  working in the code (`GRAPHICS` in `src/main.ts` lists the enabled modes).
