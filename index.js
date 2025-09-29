const express = require('express');
const pool = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('TommyTVStats API is live!');
});

// ✅ DB test route
app.get('/hello-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as server_time');
    res.json({ status: 'ok', time: result.rows[0].server_time });
  } catch (err) {
    console.error('DB connection error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TommyTVStats running on http://0.0.0.0:${PORT}`);
});

