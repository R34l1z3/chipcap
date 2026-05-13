# IDL files

After `anchor build` in `chiptap-solana-programs/`, copy the generated IDLs:

```bash
cp ../chiptap-solana-programs/target/idl/battle_arena.json ./
cp ../chiptap-solana-programs/target/idl/chip_nft.json ./
cp ../chiptap-solana-programs/target/idl/treasury.json ./
```

The frontend imports them via `import idl from "./idl/battle_arena.json"`.
For full type-safety also copy the type declaration files:

```bash
cp ../chiptap-solana-programs/target/types/battle_arena.ts ./types/
# etc.
```

…and import as `import type { BattleArena } from "./idl/types/battle_arena"`.

Without IDLs, `anchor.Program` cannot decode account data or build instructions.
