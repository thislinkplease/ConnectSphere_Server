require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const http = require("http");
const { initializeWebSocket } = require("./websocket");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Trust reverse proxies (for services like Railway, Render, etc.)
app.set("trust proxy", 1);

// Enable CORS from allowed origins
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : ["*"]; // For development, allow all

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// Initialize WebSocket server
initializeWebSocket(server, allowedOrigins);

// Body parsers (for handling large JSON payloads)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Logger (for development)
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV || "development" });
});

// Routes
const userRoutes = require("./routes/user.routes");
const postRoutes = require("./routes/post.routes");
const messageRoutes = require("./routes/message.routes");
const eventRoutes = require("./routes/event.routes");
const hangoutRoutes = require("./routes/hangout.routes");
const communityRoutes = require("./routes/community.routes");
const notificationRoutes = require("./routes/notification.routes");
const quickMessageRoutes = require("./routes/quickMessage.routes");
const authRoutes = require("./routes/auth.routes");

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/posts", postRoutes);
app.use("/messages", messageRoutes);
app.use("/events", eventRoutes);
app.use("/hangouts", hangoutRoutes);
app.use("/communities", communityRoutes);
app.use("/notifications", notificationRoutes);
app.use("/quick-messages", quickMessageRoutes);

// Root route
app.get("/", (_req, res) => {
  res.send("ConnectSphere API is up and running 🚀");
});

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal Server Error" });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
});

