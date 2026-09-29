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

Errors are shown with specific messages: rate limit (429), expired/used challenge, rejected
signature, inconsistent samples, duplicate human, wallet already registered.

## Liveness (MediaPipe)

`src/lib/liveness.js` wraps `FaceLandmarker` and exposes `LivenessDetector`, a stateful
blink counter (extensible to a head-turn challenge via `requireHeadTurn`). The WASM runtime
and `.task` model load from the official CDN by default; set `VITE_MEDIAPIPE_WASM_URL` and
`VITE_FACE_LANDMARKER_MODEL_URL` to self-host them under `public/` for offline use.

## Security notes and limitations

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
