# BeamDrop P2P ⚡️

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.0-646cff?logo=vite&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38bdf8?logo=tailwindcss&logoColor=white)
![WebRTC](https://img.shields.io/badge/Protocol-WebRTC-333333?logo=webrtc&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Ready-purple?logo=pwa&logoColor=white)

**BeamDrop** is a modern, secure, and serverless peer-to-peer file transfer application. It establishes a direct connection between devices using **WebRTC**, allowing for unlimited file sharing without intermediate storage servers.

It solves the problem of "How do I get this file from my phone to my laptop (or friend)?" without logging in, uploading to a cloud, or compressing files.

## ✨ Features

- **True P2P:** Files go directly from Device A to Device B. No cloud storage.
- **Smart Connectivity:** Optimized connection logic for mobile networks with **real-time status feedback** for both sender and receiver.
- **PWA Support:** Installable on mobile and desktop. Works as a standalone app with offline shell support.
- **Easy Pairing:** Uses a simple 6-digit numeric code to handshake (no QR codes required).
- **Cross-Platform:** Works on any modern browser (iOS, Android, Windows, Mac, Linux).
- **Modern UI:** Dark mode aesthetic with a clean black & white theme.
- **Secure:** End-to-end encryption provided natively by WebRTC `RTCDataChannel`.
- **Network Traversal:** Uses public STUN servers to punch through NATs.

## 📱 Progressive Web App (PWA)

BeamDrop is fully PWA compliant:
- **Installable:** Add to Home Screen on iOS, Android, Mac, Windows, Linux and all other platforms for a native app experience.
- **Offline Ready:** App shell loads instantly even on spotty connections.

##  Architecture & How It Works

BeamDrop utilizes a "Signaling" concept to establish a connection, after which the signaling channel is no longer needed for data transfer.

1.  **Signaling (MQTT):**
    - We use `mqtt` over WebSockets (connecting to a public HiveMQ broker for this demo) as a signaling server.
    - **Sender** generates a random 6-digit Channel ID.
    - **Receiver** subscribes to that Channel ID.
    - SDP Offers, Answers, and ICE Candidates are exchanged via this MQTT topic.
    - *New:* connection logs are displayed to the user to indicate the current stage of the handshake (Signaling -> ICE Checking -> Connected).

2.  **Direct Transport (WebRTC):**
    - Once signaling is complete, a standard `RTCPeerConnection` is established.
    - An `RTCDataChannel` is opened for binary transfer.
    - Files are chunked (16KB chunks) and streamed to prevent memory overflow, managing backpressure via `bufferedAmount`.

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

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

### Testing on Local Network (Mobile to Desktop)
To test P2P between your phone and computer, they must be able to reach the dev server.
```bash
npm run dev -- --host
```
Then access the local IP address (e.g., `http://192.168.1.50:5173`) on your phone.

> **Note:** For WebRTC to work over the internet (non-local), you might need a HTTPS connection in production or localhost context. Most browsers require a secure context for camera/mic/WebRTC APIs, though basic DataChannels often work on HTTP for localhost.

## 🛠 Tech Stack

- **Frontend Framework:** [React 19](https://react.dev/)
- **Build Tool:** [Vite](https://vitejs.dev/)
- **Styling:** [TailwindCSS](https://tailwindcss.com/)
- **Icons:** [Lucide React](https://lucide.dev/)
- **P2P Protocol:** Native WebRTC API (`RTCPeerConnection`, `RTCDataChannel`)
- **Signaling Transport:** MQTT (via `mqtt.js`)

## ⚠️ Limitations

- **NAT Traversal:** Currently uses Google's public STUN servers. If both users are behind strict Symmetric NATs (e.g., some corporate firewalls or 4G networks), connection might fail without a TURN server.
- **Signaling:** Uses a public MQTT broker. For a production app, you should host your own Mosquitto or WebSocket server to ensure signaling privacy and uptime.

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