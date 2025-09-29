// index.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Simple route
app.get("/", (req, res) => {
  res.send("Hello TommyTVStats! Your app is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(`TommyTVStats server listening on port ${PORT}`);
});

