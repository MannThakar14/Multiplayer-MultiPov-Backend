const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const roomHandler = require("./socketHandlers/roomHandler");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for POC
    methods: ["GET", "POST"],
  },

  // Heartbeat settings — increased for unstable / mobile networks
  pingInterval: 25000,   // How often the server pings the client (ms)
  pingTimeout: 300000,   // How long to wait for a pong before disconnecting (ms) — 5 minutes
});

// Middleware
app.use(express.json());

// Basic route for health check
app.get("/", (req, res) => {
  res.send("Multiplayer Room Backend is running.");
});

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Register room handlers
  roomHandler(io, socket);
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is listening on all interfaces at port ${PORT}`);
});
