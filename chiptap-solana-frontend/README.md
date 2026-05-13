# ChipTap Solana frontend

React + Vite + Tailwind + `@solana/wallet-adapter-react`.  Same retro
look as the EVM version; SDK and wallet plumbing replaced.

## Quick start

```bash
yarn install     # or npm i
cp .env.example .env
# fill in VITE_*_PROGRAM after `anchor deploy`
yarn dev
```

After `anchor build` in `chiptap-solana-programs/`, copy the IDLs:

```bash
cp ../chiptap-solana-programs/target/idl/battle_arena.json src/idl/
cp ../chiptap-solana-programs/target/idl/chip_nft.json     src/idl/
cp ../chiptap-solana-programs/target/idl/treasury.json     src/idl/
```

Without IDLs the page shells render but no on-chain calls work.

## What's done

* `wallet-adapter-react` + Phantom / Solflare adapters
* Anchor TS client wired (`useArenaProgram`, `useChipNftProgram`, `useTreasuryProgram`)
* PDA helpers mirroring `chiptap-solana-programs/tests/helpers.ts`
* Indexer-backed read hooks: `useIndexerBattles`, `useChipsByOwner`,
  `useUserAccount`, `useArenaConfig`
* Toast bus + global notification store
* Pages: shell + indexer-driven views (Inventory, History, Leaderboard, Profile)

## What's still stubs

* **MintPage**: real `mint_chip` flow (Asset keypair generation +
  mpl-core CPI through chip-nft program)
* **BattlePage**: full create/join/VRF/claim/pay-ransom/forfeit/force-resolve
  flow with internal-balance ledger UI

These come in the next iteration; the rest of the app builds and runs.

## Diff vs EVM frontend

| EVM frontend          | Solana frontend                              |
|-----------------------|----------------------------------------------|
| `wagmi`, `viem`       | `@solana/web3.js`, `@coral-xyz/anchor`       |
| `RainbowKit`          | `@solana/wallet-adapter-react-ui`            |
| `useReadContract`     | direct `program.account.<X>.fetchNullable()` |
| `useWriteContract`    | `program.methods.x().accounts({...}).rpc()` |
| ABIs (`contracts.ts`) | IDL JSON (`src/idl/*.json`)                  |
| ERC-721 `tokenId`     | Metaplex Core Asset `Pubkey`                 |
| MATIC                 | SOL (lamports)                               |
| Chainlink price feed  | (none — fixed lamport tiers)                 |
