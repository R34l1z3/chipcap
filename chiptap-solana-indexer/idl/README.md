# IDL files

The indexer needs Anchor-generated IDL JSON for each program at:

* `idl/battle_arena.json`
* `idl/chip_nft.json`
* `idl/treasury.json`

After running `anchor build` in `chiptap-solana-programs/`, copy them:

```bash
cp ../chiptap-solana-programs/target/idl/battle_arena.json ./
cp ../chiptap-solana-programs/target/idl/chip_nft.json ./
cp ../chiptap-solana-programs/target/idl/treasury.json ./
```

These IDLs ship inside the Docker image (see `Dockerfile`) so the
production container is fully self-contained.

The `BorshEventCoder` from `@coral-xyz/anchor` uses these to decode
`Program data:` log lines that `connection.onLogs` produces.
