# poh-frontend

React + Vite frontend for the hybrid Proof of Humanity system. Wallet connection via
**Wagmi**, liveness via **MediaPipe FaceLandmarker**, identity descriptor via **face-api.js**.

## Flow

1. Connect an Ethereum wallet (MetaMask / injected).
2. Press **Start verification**: the frontend requests a challenge from `poh-backend`
   (`POST /api/auth/challenge`). It contains an EIP-4361 (SIWE) message with a single-use nonce
   and the liveness parameters: a random number of blinks (2-3), the allowed sample count and
   the time window.
3. **Liveness + sampling on one stream**: the webcam starts and MediaPipe blendshapes
   (`eyeBlinkLeft/Right`) drive a blink state machine (`src/lib/liveness.js`). During that same
   loop, face-api.js 128-d descriptors are sampled from the same video: one before the first
   blink and one after every blink (so at least one lies between blinks), topped up to the
   server's minimum. Each sample carries `t`, its timestamp in ms since challenge start.
4. Sign the server's message with the wallet (wagmi `useSignMessage`, `personal_sign`).
5. Send `{ address, message, signature, nonce, samples }` to `POST /api/validate`; the backend
   verifies ownership and the samples, registers the proof on-chain and returns metrics.
6. Verify humanity status on demand.

### Semaphore mode (identity + agent delegation)

When the backend runs with `ISSUANCE_MODE=semaphore` (see `VITE_ISSUANCE_MODE`, default `auto`
= ask `/health`), the flow changes as follows. `legacy` keeps the flow above unchanged.

- **Holder identity** (`src/lib/semaphore.js`, `src/context/HolderIdentity.jsx`): the wallet signs a
  fixed, versioned, domain-separated message (`IDENTITY_MESSAGE_V1`) and the Semaphore v4 identity
  is `new Identity(signature)`. Nothing is stored: signing again recovers it. The secret lives in
  memory for the session only (dropped when the account changes) and is never sent anywhere.
  Tradeoff: wallet compromise = identity compromise; benefit: no secret storage or backup.
  Needs a wallet with deterministic (RFC 6979) signatures: MetaMask and EOAs do, ERC-1271
  smart-contract wallets do not.
- **Issuance**: the identity is unlocked before the camera starts (1st signature), then the SIWE
  signature is requested (2nd) and `POST /api/validate` carries `identityCommitment` (decimal string,
  public) next to the face samples. Validators admit it to the HumanityIssuer group.
- **Delegation panel** (`src/components/delegation/`): service scope (string, hashed with keccak256
  over its UTF-8 bytes, verbatim, as the backend e2e does), agent address, permissions (checkboxes
  mapped to the bytes32 bitmask defined in `src/lib/constants.js`: READ=bit 0, WRITE=bit 1,
  TRANSACT=bit 2, rest reserved) and lifetime in hours (up to the contract's `maxTtl`, 30 days, minus
  a 5 min margin). The browser rebuilds the group from the Semaphore `MemberAdded/MembersAdded/
  MemberUpdated/MemberRemoved` events and checks its root against the contract, reads the
  per-nullifier nonce (`nullifier = Poseidon2(keccak256(scope) >> 8, secretScalar)`, checked against
  the circuit's public signal), takes the message from `delegationMessage`, proves with
  `@semaphore-protocol/proof` in the browser and posts proof + params to the backend relayer
  (`POST /api/relay/delegate`). **The holder wallet never sends `delegate`/`revoke`**: `msg.sender`
  would link the wallet to the nullifier on-chain.
- **List and revoke**: `activeAgents` + `getDelegation` for (scope, nullifier); *Revoke* builds a
  revocation proof and sends it to `POST /api/relay/revoke`.

### Browser proving: artifacts and cost

Circuit artifacts (`semaphore-<depth>.wasm` ~1.8 MB + `.zkey` 1.2-2.9 MB per tree depth, depth =
ceil(log2(members)), minimum 1) are served locally from `public/semaphore/` instead of a remote CDN:
`npm run artifacts` downloads depths 1..10 (groups up to 1024 members, ~35 MB on disk; the browser
fetches one pair, 3-5 MB, per proof); `--max-depth N` for bigger groups. `npm run dev`/`build` run it
automatically (and only warn if offline). Set `VITE_SEMAPHORE_ARTIFACTS_URL=cdn` to use the PSE CDN
instead. The proof library is a lazy chunk (~326 kB, 75 kB gzip) loaded on first proof. Note that
`dist/` also contains `public/semaphore` (35 MB).

### Local stack (anvil)

```bash
anvil                                                       # 1. chain
(cd ../poh-contracts && npm run deploy:local)               # 2. contracts -> deployments/local.json
# 3. backend (.env in poh-backend): ISSUANCE_MODE=semaphore, RPC_URL=http://127.0.0.1:8545,
#    SIWE_CHAIN_ID=31337, HUMANITY_ISSUER_ADDRESS, DELEGATION_REGISTRY_ADDRESS (local.json),
#    VALIDATOR_PRIVATE_KEYS = anvil accounts 1..3, RELAYER_PRIVATE_KEY = anvil account 4,
#    DATABASE_URL + TEMPLATE_ENC_KEY (Postgres, see poh-backend README); then: npm start
# 4. frontend .env: VITE_CHAIN_ID=31337, VITE_RPC_URL=http://127.0.0.1:8545,
#    VITE_HUMANITY_ISSUER_ADDRESS, VITE_DELEGATION_REGISTRY_ADDRESS; then: npm run dev
```

MetaMask must use the local network (chain id 31337, RPC http://127.0.0.1:8545).

### Tests

- `npm test` (vitest): scope derivation, permission bitmask, deterministic identity derivation,
  group replay from events, relayer payload serialization.
- `npm run e2e` (needs anvil + `deploy:local` + `npm run artifacts`; no Postgres, camera stubbed):
  runs the same `src/lib` functions as the UI against the real backend app and relayer: identity from a
  wallet signature, admission through `/api/validate`, group from events, proof, relayed `delegate`,
  `getDelegation` active (tx sender is the relayer), tampered request rejected, relayed `revoke`,
  inactive. The React UI itself is not covered by this script.

Errors are shown with specific messages: rate limit (429), expired/used challenge, rejected
signature, inconsistent samples, duplicate human, wallet already registered.

## Liveness (MediaPipe)

`src/lib/liveness.js` wraps `FaceLandmarker` and exposes `LivenessDetector`, a stateful
blink counter (extensible to a head-turn challenge via `requireHeadTurn`). The WASM runtime
and `.task` model load from the official CDN by default; set `VITE_MEDIAPIPE_WASM_URL` and
`VITE_FACE_LANDMARKER_MODEL_URL` to self-host them under `public/` for offline use.

## Security notes and limitations

- The identity secret and the proofs are generated in the browser; only the identity *commitment*
  and the final proof leave it. The RPC provider and the relayer still see the client IP.

- Liveness and descriptor extraction run in the browser. Binding descriptors to the liveness
  loop (same stream, server-checked consistency and timing) makes swapping the face between the
  blink check and the capture harder, but this is **client-side liveness**: it does **not**
  defend against injection attacks (virtual camera, face swap, replayed video), which are the
  subject of later evaluation. The server cannot verify the blinks happened.
- The wallet signature proves ownership of the address; it authorizes no transaction.
- The backend `SIWE_DOMAIN` / `SIWE_URI` should match the origin serving this app, and
  `CORS_ORIGIN` must include it (default `http://localhost:5173`).

## Setup

```bash
npm install
cp .env.example .env      # set VITE_API_URL (default http://localhost:4000)
npm run dev               # http://localhost:5173
```

## face-api.js models (required for real capture)

Download the weights into `public/models/` (see `public/models/.gitkeep`):

- `tiny_face_detector_model-*`
- `face_landmark_68_model-*`
- `face_recognition_model-*`

Source: https://github.com/justadudewhohacks/face-api.js/tree/master/weights

Until the models are present, `FaceCapture` reports "models not loaded" instead of crashing,
so wallet + backend integration stays developable.

## Next

- Head-movement liveness challenge and injection-attack evaluation.
- Web3Modal/WalletConnect for broader wallet support (needs a projectId).
