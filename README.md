# poh-frontend

React + Vite frontend for the hybrid Proof of Humanity system. Wallet connection via
**Wagmi**, biometric capture via **face-api.js** (MediaPipe liveness planned).

## Flow

1. Connect an Ethereum wallet (MetaMask / injected).
2. Start the webcam, capture a face, run a basic liveness proxy.
3. Send the face descriptor + liveness result to `poh-backend`, which registers the proof
   on-chain and returns metrics.
4. Verify humanity status on demand.

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
