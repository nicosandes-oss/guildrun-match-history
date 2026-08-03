// server.js
// GuildRun run history server.
//
// Uses sqlite3 (local file). Data resets on Render redeploy on the free tier,
// which is fine for getting the site working — we can add persistence later.
//
// ENVIRONMENT VARIABLES:
//   UPLOAD_SECRET  — shared secret between server and companion app (required)
//   PORT           — defaults to 3000

const express = require("express");
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.UPLOAD_SECRET || "dev_secret_change_me";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new sqlite3.Database(path.join(__dirname, "runs.db"), (err) => {
  if (err) { console.error("DB open error:", err.message); process.exit(1); }
});

const dbRun = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(err) { err ? rej(err) : res(this); }));
const dbGet = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (err, rows) => err ? rej(err) : res(rows)));

async function setupDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_name  TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      duration_s  INTEGER,
      stages      INTEGER DEFAULT 0,
      furthest    TEXT,
      heroes      TEXT,
      relics      TEXT,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_steam   ON runs(steam_name)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_started ON runs(started_at DESC)`);
  console.log("Database ready");
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// POST /api/upload
// ---------------------------------------------------------------------------

app.post("/api/upload", async (req, res) => {
  const { secret, steamName, run: r } = req.body;

  if (secret !== SECRET) return res.status(403).json({ error: "Invalid secret." });
  if (!steamName || !r || !r.outcome || !r.startedAt)
    return res.status(400).json({ error: "Missing required fields." });

  try {
    const existing = await dbGet(
      `SELECT id FROM runs WHERE steam_name = ? AND started_at = ?`,
      [steamName, r.startedAt]
    );
    if (existing) return res.json({ status: "duplicate", id: existing.id });

    const result = await dbRun(
      `INSERT INTO runs (steam_name,outcome,started_at,duration_s,stages,furthest,heroes,relics)
       VALUES (?,?,?,?,?,?,?,?)`,
      [steamName, r.outcome, r.startedAt, r.durationSeconds||null,
       r.stagesCleared||0, r.furthestStage||null,
       JSON.stringify(r.heroes||[]), JSON.stringify(r.relics||[])]
    );

    console.log(`[upload] ${steamName} ${r.outcome} at ${r.startedAt} → id ${result.lastID}`);
    res.json({ status: "ok", id: result.lastID });
  } catch (err) {
    console.error("[upload]", err.message);
    res.status(500).json({ error: "Failed to save run." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/runs/:steamName
// ---------------------------------------------------------------------------

app.get("/api/runs/:steamName", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
  try {
    const rows = await dbAll(
      `SELECT * FROM runs WHERE steam_name = ? ORDER BY started_at DESC LIMIT ?`,
      [req.params.steamName, limit]
    );
    res.json({
      steamName: req.params.steamName,
      runs: rows.map(row => ({
        id:         row.id,
        outcome:    row.outcome,
        startedAt:  row.started_at,
        durationS:  row.duration_s,
        stages:     row.stages,
        furthest:   row.furthest,
        heroes:     JSON.parse(row.heroes || "[]"),
        relics:     JSON.parse(row.relics || "[]"),
        uploadedAt: row.uploaded_at,
      })),
    });
  } catch (err) {
    console.error("[runs]", err.message);
    res.status(500).json({ error: "Failed to fetch runs." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/runs/:steamName/stats
// ---------------------------------------------------------------------------

app.get("/api/runs/:steamName/stats", async (req, res) => {
  try {
    const s = await dbGet(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN outcome='rift_cleared' OR outcome='victory' THEN 1 ELSE 0 END) as victories,
              SUM(CASE WHEN outcome='defeat'  THEN 1 ELSE 0 END) as defeats,
              AVG(duration_s) as avg_duration,
              MAX(stages)     as best_stages,
              MAX(started_at) as last_run
       FROM runs WHERE steam_name = ?`,
      [req.params.steamName]
    );
    res.json({
      steamName:   req.params.steamName,
      total:       s.total       || 0,
      victories:   s.victories   || 0,
      defeats:     s.defeats     || 0,
      winRate:     s.total ? Math.round((s.victories / s.total) * 100) : 0,
      avgDuration: s.avg_duration ? Math.round(s.avg_duration) : null,
      bestStages:  s.best_stages || 0,
      lastRun:     s.last_run    || null,
    });
  } catch (err) {
    console.error("[stats]", err.message);
    res.status(500).json({ error: "Failed to fetch stats." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/suggest
// ---------------------------------------------------------------------------

app.get("/api/suggest", async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const rows = q
      ? await dbAll(`SELECT DISTINCT steam_name FROM runs WHERE LOWER(steam_name) LIKE ? LIMIT 8`, [`%${q.toLowerCase()}%`])
      : await dbAll(`SELECT DISTINCT steam_name FROM runs ORDER BY rowid DESC LIMIT 8`);
    res.json({ suggestions: rows.map(r => r.steam_name) });
  } catch {
    res.json({ suggestions: [] });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

setupDb()
  .then(() => app.listen(PORT, () => console.log(`GuildRun History on port ${PORT}`)))
  .catch(err => { console.error("DB setup failed:", err.message); process.exit(1); });
