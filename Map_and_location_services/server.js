require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const connectMongo = require("./config/mongo");
const socketHandler = require("./socket");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Connect to MongoDB
connectMongo();

// Initialize socket logic
socketHandler(io);

// REST routes placeholder (if needed)
app.get("/", (req, res) => {
  res.send("Location service running...");
});

const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
