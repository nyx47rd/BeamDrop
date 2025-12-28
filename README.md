# BeamDrop P2P ⚡️

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.0-646cff?logo=vite&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38bdf8?logo=tailwindcss&logoColor=white)
![WebRTC](https://img.shields.io/badge/Protocol-WebRTC-333333?logo=webrtc&logoColor=white)
![Cloudflare](https://img.shields.io/badge/Serverless-Cloudflare%20Workers-orange?logo=cloudflare&logoColor=white)

**BeamDrop** is a modern, secure, and serverless peer-to-peer file transfer application. It establishes a direct connection between devices using **WebRTC**, allowing for unlimited file sharing without intermediate storage servers.

It solves the problem of "How do I get this file from my phone to my laptop (or friend)?" without logging in, uploading to a cloud, or compressing files.

## ✨ Features

- **True P2P:** Files go directly from Device A to Device B. No cloud storage.
- **Smart Connectivity:** Optimized connection logic for mobile networks with **real-time status feedback** for both sender and receiver.
- **PWA Support:** Installable on mobile and desktop. Works as a standalone app with offline shell support.
- **Easy Pairing:** Uses a simple 6-digit numeric code to handshake (no QR codes required).
- **Cross-Platform:** Works on any modern browser (iOS, Android, Windows, Mac, Linux).
- **Modern UI:** Apple-esque dark mode aesthetic with a clean black & white theme.
- **Secure:** End-to-end encryption provided natively by WebRTC `RTCDataChannel`.
- **Serverless Signaling:** Uses a custom Cloudflare Worker with Durable Objects for instant, low-latency signaling.

## 📱 Progressive Web App (PWA)

BeamDrop is fully PWA compliant:
- **Installable:** Add to Home Screen on iOS and Android for a native app experience.
- **Themed:** Custom black background icon and splash screen.
- **Offline Ready:** App shell loads instantly even on spotty connections.

##  Architecture & How It Works

BeamDrop utilizes a "Signaling" concept to establish a connection, after which the signaling channel is no longer needed for data transfer.

1.  **Signaling (Cloudflare Workers):**
    - We use a **Cloudflare Worker** + **Durable Objects** as a signaling server.
    - **Sender** generates a random 6-digit Channel ID.
    - **Receiver** connects to the Worker using that ID.
    - The Durable Object acts as a temporary "room", broadcasting SDP Offers, Answers, and ICE Candidates to connected peers via WebSockets.
    - This replaces the older MQTT implementation for better control and lower latency.

2.  **Direct Transport (WebRTC):**
    - Once signaling is complete, a standard `RTCPeerConnection` is established.
    - An `RTCDataChannel` is opened for binary transfer.
    - Files are chunked (64KB chunks) and streamed to prevent memory overflow, managing backpressure via `bufferedAmount`.

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Cloudflare Account (for deploying the signaling worker)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/nyx47rd/beamdrop.git
    cd beamdrop
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Run the development server**
    ```bash
    npm run dev
    ```

4.  **Open in Browser**
    Visit `http://localhost:5173`

### Deploying the Signaling Server
BeamDrop requires a signaling server to exchange connection details.
1. Create a Cloudflare Worker: `npm create cloudflare@latest beamdrop-signaling`
2. Select "Hello World" > "Worker + Durable Objects".
3. Replace the worker code with the provided `src/index.js` content.
4. Deploy: `npx wrangler deploy`.
5. Update `services/signaling.ts` in the frontend with your new Worker URL.

## 🛠 Tech Stack

- **Frontend Framework:** [React 19](https://react.dev/)
- **Build Tool:** [Vite](https://vitejs.dev/)
- **Styling:** [TailwindCSS](https://tailwindcss.com/)
- **Icons:** [Lucide React](https://lucide.dev/)
- **P2P Protocol:** Native WebRTC API (`RTCPeerConnection`, `RTCDataChannel`)
- **Signaling:** Cloudflare Workers (WebSockets + Durable Objects)

## ⚠️ Limitations (v1.0)

- **NAT Traversal:** Currently uses public STUN servers. If both users are behind strict Symmetric NATs (e.g., some corporate firewalls or specific 4G networks), connection might fail without a TURN server.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1.  Fork the Project
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the Branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

*Built with ❤️ for the Open Source Community.*