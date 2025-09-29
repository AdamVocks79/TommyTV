// index.js
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Simple route
app.get("/", (req, res) => {
  res.send("This is the TommyTV Stats app! Your app is running.");
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TommyTVStats server listening on port ${PORT}`);
});

