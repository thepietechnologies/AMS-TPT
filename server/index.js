'use strict';
/* ─── AMS — The Pie Technologies: Agency Management System ───────────────── */
const express = require('express');
const path = require('path');
require('./db'); // init schema + seed
const api = require('./routes');
const { startScheduler } = require('./notify/scheduler');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api', api);

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));

/* SPA fallback (Express 5: plain middleware instead of '*') */
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(pub, 'index.html'));
  }
  next();
});

/* Error handler */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AMS-TPT running on http://0.0.0.0:${PORT}`);
  startScheduler();
});
