
# BeamDrop P2P ⚡️

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.0-646cff?logo=vite&logoColor=white)
![WebRTC](https://img.shields.io/badge/Protocol-WebRTC-333333?logo=webrtc&logoColor=white)

**BeamDrop** is a modern, secure, and serverless peer-to-peer file transfer application. It establishes a direct connection between devices using **WebRTC**, allowing for unlimited file sharing without intermediate storage servers.

It solves the problem of "How do I get this file from my phone to my laptop (or friend)?" without logging in, uploading to a cloud, or compressing files.

## ✨ New Features

- **Nearby Discovery:** Automatically detects other BeamDrop users on the same Wi-Fi/Network. Connect with a single tap—no codes required (though codes still work for remote connections!).
- **Batch Transfer:** Select and send hundreds of files at once. The app intelligently queues them for maximum throughput.
- **Smart Wake Lock:** Prevents your phone screen from locking during large transfers using a hybrid Native API + Video Fallback engine (works on iOS & Android).
- **Auto-Zip:** Receivers can download all received files as a single ZIP archive.

## 🚀 Core Capabilities

- **True P2P:** Files go directly from Device A to Device B. No cloud storage.
- **Works Everywhere:** optimized for Mobile Data (4G/5G) and Wi-Fi.
- **PWA Support:** Installable on mobile and desktop. Works as a standalone app.
- **Cross-Platform:** Works on iOS, Android, Windows, Mac, Linux.
- **Secure:** End-to-end encryption provided natively by WebRTC `RTCDataChannel`.
- **Zero-Copy Performance:** Uses Web Workers and Transferable Objects to handle file chunks without freezing the UI.

##  Architecture & How It Works

BeamDrop utilizes a "Signaling" concept to establish a connection, after which the signaling channel is no longer needed for data transfer.

1.  **Signaling (Cloudflare Workers):**
    - Acts as a temporary "meeting room" to exchange connection details (SDP/ICE).
    - Uses Durable Objects for low-latency WebSocket coordination.
    - Supports both manual 6-digit code pairing and automatic discovery.

2.  **Direct Transport (WebRTC):**
    - Once signaling is complete, a standard `RTCPeerConnection` is established.
    - An `RTCDataChannel` is opened for binary transfer.
    - Files are chunked (64KB chunks) and piped through a worker thread to maximize bandwidth usage.

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

## 🛠 Tech Stack

- **Frontend Framework:** [React 19](https://react.dev/)
- **Build Tool:** [Vite](https://vitejs.dev/)
- **Styling:** [TailwindCSS](https://tailwindcss.com/)
- **P2P Protocol:** Native WebRTC API (`RTCPeerConnection`, `RTCDataChannel`)
- **State:** React Hooks + Custom Services (Singleton Pattern)

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

*Built with ❤️ for the Open Source Community.*
