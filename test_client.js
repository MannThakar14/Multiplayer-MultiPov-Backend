const { io } = require("socket.io-client");

const SERVER_URL = "http://localhost:8000";

const test = async () => {
  console.log("--- Starting Socket.IO Room System Test ---");

  // Client 1: Host
  const host = io(SERVER_URL);

  host.on("connect", () => {
    console.log("Host connected:", host.id);
    host.emit("create_room", { username: "Admin" });
  });

  host.on("room_created", ({ roomId }) => {
    console.log("Room created with ID:", roomId);

    // Client 2: Joiner
    const joiner = io(SERVER_URL);

    joiner.on("connect", () => {
      console.log("Joiner connected:", joiner.id);
      joiner.emit("join_room_request", { roomId, username: "Player1" });
    });

    joiner.on("join_approved", (data) => {
      console.log("Joiner approved!", data);
    });

    joiner.on("join_rejected", (data) => {
      console.log("Joiner rejected!", data);
    });

    // Host receives join request
    host.on("join_request", ({ socketId, username }) => {
      console.log(`Host received join request from ${username} (${socketId})`);
      console.log("Approving user...");
      host.emit("approve_user", { roomId, userId: socketId });
    });

    host.on("user_joined", (data) => {
      console.log("User joined room event received by host:", data);

      // Verification complete, disconnect
      setTimeout(() => {
        host.disconnect();
        joiner.disconnect();
        console.log("--- Test Completed Successfully ---");
        process.exit(0);
      }, 1000);
    });
  });

  host.on("error", (err) => console.error("Host Error:", err));
};

// We need the server to be running before this test
// This script assumes the server is started separately or we handle it here.
test();
