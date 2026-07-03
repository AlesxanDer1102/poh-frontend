# poh-frontend

React + Vite frontend for the hybrid Proof of Humanity system. Wallet connection via
**Wagmi**, liveness via **MediaPipe FaceLandmarker**, identity descriptor via **face-api.js**.

## Flow

1. Connect an Ethereum wallet (MetaMask / injected).
2. Start the webcam. **Liveness challenge**: the user must blink twice — MediaPipe
   blendshapes (`eyeBlinkLeft/Right`) drive a blink state machine (`src/lib/liveness.js`).
3. On liveness pass, capture the 128-d face descriptor with face-api.js.
4. Send the descriptor + liveness result to `poh-backend`, which registers the proof
   on-chain and returns metrics.
5. Verify humanity status on demand.

## Liveness (MediaPipe)

`src/lib/liveness.js` wraps `FaceLandmarker` and exposes `LivenessDetector`, a stateful
blink counter (extensible to a head-turn challenge via `requireHeadTurn`). The WASM runtime
and `.task` model load from the official CDN by default; set `VITE_MEDIAPIPE_WASM_URL` and
`VITE_FACE_LANDMARKER_MODEL_URL` to self-host them under `public/` for offline use.

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

- Real temporal liveness challenge (blink / head movement) with MediaPipe.
- Web3Modal/WalletConnect for broader wallet support (needs a projectId).
