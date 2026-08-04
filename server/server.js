// server.js
// GuildRun run history server.
//
// Uses Turso (libsql) — data persists across Render restarts/redeploys,
// since it lives outside the container.
//
// ENVIRONMENT VARIABLES:
//   UPLOAD_SECRET       — shared secret between server and companion app (required)
//   TURSO_DATABASE_URL  — libsql://... url from `turso db show <name> --url`
//   TURSO_AUTH_TOKEN    — from `turso db tokens create <name>`
//   PORT                — defaults to 3000

require("dotenv").config();

const express = require("express");
const path    = require("path");
const { createClient } = require("@libsql/client");

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.UPLOAD_SECRET || "dev_secret_change_me";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// small helpers to keep the rest of the file close to how it read before
const dbRun = async (sql, args = []) => db.execute({ sql, args });
const dbGet = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows[0];
};
const dbAll = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows;
};

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
// GuildRun log parser
// Ported from the old companion app — parses one raw log file's text into
// a run summary. Hero name learning (seq -> name) is kept in-memory only;
// it's a fallback for cases where a hero wasn't created in this same log,
// resets on server restart, but each log's own "Added new hero" lines
// cover the common case.
// ---------------------------------------------------------------------------

const CLASS_NAMES  = { 1:"Warrior", 2:"Tank", 3:"Vanguard", 4:"Assassin", 5:"Duelist", 6:"Mystic", 7:"Mage" };
const RANK_LABELS  = { 1: "C", 2: "B", 3: "A", 4: "S", 5: "SS", 6: "SSS", 7: "Red Rift" };
const heroSeqMap    = {}; // seq number -> hero name, learned across uploads (in-memory)

function parseGuildRunLog(content) {
  const lines = content.split(/\r?\n/);

  const run = {
    outcome:         null,
    startedAt:       null,
    endedAt:         null,
    durationSeconds: null,
    stagesCleared:   0,
    furthestStage:   null,
    heroes:          [],
    relics:          [],
  };

  const uuidToName = {};
  const battleConfigs = [];

  for (const line of lines) {
    const ts = (line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1];

    if (line.includes("OnRunStarted") && line.includes("Recording run started")) {
      run.startedAt = ts;
    }

    if (line.includes("has been defeated")) {
      run.outcome = "defeat";
      run.endedAt = ts;
    }

    if (line.includes("OnRunCompleted") || line.includes("RunVictory") || line.includes("RunCompleted") || line.includes("RiftCleared")) {
      run.outcome = "rift_cleared";
      run.endedAt = ts;
    }

    if (line.includes("OnCombatVictory")) {
      run.stagesCleared++;
      if (battleConfigs.length > 0) {
        const last = battleConfigs[battleConfigs.length - 1];
        if (last.IsBossFloor && last.CurrentChunkIndex === 1) {
          run.outcome = "rift_cleared";
          run.endedAt = ts;
        }
      }
    }

    const stageMatch = line.match(/Initializing board for stage (Stage_\d+)/);
    if (stageMatch) run.furthestStage = stageMatch[1];

    const relicMatch = line.match(/Granting relic (.+?) \([0-9a-f-]{36}\)/);
    if (relicMatch) {
      const name = relicMatch[1].trim();
      if (!run.relics.includes(name)) run.relics.push(name);
    }

    const heroCreateMatch = line.match(/Added new hero (\w+) \(([0-9a-f-]{36})\)/);
    if (heroCreateMatch) uuidToName[heroCreateMatch[2]] = heroCreateMatch[1];

    if (line.includes("LogBattle:417") && line.includes("Starting battle with config:")) {
      const jsonStart = line.indexOf("Starting battle with config: ") + "Starting battle with config: ".length;
      try { battleConfigs.push(JSON.parse(line.slice(jsonStart).trim())); } catch {}
    }
  }

  if (run.startedAt && !run.outcome) {
    run.outcome = battleConfigs.length > 0 ? "abandoned" : null;
  }

  if (!run.startedAt || !run.outcome) return null;

  if (run.startedAt && run.endedAt) {
    const s = new Date(run.startedAt.replace(" ", "T"));
    const e = new Date(run.endedAt.replace(" ", "T"));
    run.durationSeconds = Math.round((e - s) / 1000);
  }

  if (battleConfigs.length > 0) {
    const last = battleConfigs[battleConfigs.length - 1];

    for (const cfg of battleConfigs) {
      for (const hero of [...(cfg.HeroDtos || []), ...(cfg.ReserveHeroDtos || [])]) {
        const charRef  = hero.CharacterRef || "";
        const seqMatch = charRef.match(/Hero_(\d+)/);
        const entityId = hero.EntityId || "";
        if (seqMatch && uuidToName[entityId]) {
          const seq = parseInt(seqMatch[1], 10);
          if (!heroSeqMap[seq]) heroSeqMap[seq] = uuidToName[entityId];
        }
      }
    }

    for (const hero of last.HeroDtos || []) {
      const charRef  = hero.CharacterRef || "";
      const seqMatch = charRef.match(/Hero_(\d+)/);
      const seq      = seqMatch ? parseInt(seqMatch[1], 10) : null;
      const name = (seq !== null && heroSeqMap[seq])
        ? heroSeqMap[seq]
        : (uuidToName[hero.EntityId] || `Hero_${seq}`);

      const classes = (hero.HeroClasses || [])
        .map((hc) => {
          const cm = (hc.Id || "").match(/HeroClass_(\d+)/);
          return cm ? (CLASS_NAMES[parseInt(cm[1], 10)] || `Class_${cm[1]}`) : null;
        })
        .filter(Boolean);

      const items = (hero.EquippedItems || [])
        .filter((item) => item !== null && item !== undefined)
        .map((item) => item.ItemRef || "")
        .filter(Boolean);

      run.heroes.push({
        name,
        rank: RANK_LABELS[hero.Rank] || `Rank ${hero.Rank}`,
        classes,
        items,
      });
    }
  }

  return run;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Shared: save a parsed run (dedupes on steam_name + started_at)
// ---------------------------------------------------------------------------

async function saveRun(steamName, r) {
  const existing = await dbGet(
    `SELECT id FROM runs WHERE steam_name = ? AND started_at = ?`,
    [steamName, r.startedAt]
  );
  if (existing) return { status: "duplicate", id: existing.id };

  const result = await dbRun(
    `INSERT INTO runs (steam_name,outcome,started_at,duration_s,stages,furthest,heroes,relics)
     VALUES (?,?,?,?,?,?,?,?)`,
    [steamName, r.outcome, r.startedAt, r.durationSeconds||null,
     r.stagesCleared||0, r.furthestStage||null,
     JSON.stringify(r.heroes||[]), JSON.stringify(r.relics||[])]
  );

  const insertedId = Number(result.lastInsertRowid);
  console.log(`[upload] ${steamName} ${r.outcome} at ${r.startedAt} → id ${insertedId}`);
  return { status: "ok", id: insertedId };
}

// ---------------------------------------------------------------------------
// POST /api/upload  (legacy — structured run object, e.g. from a script)
// ---------------------------------------------------------------------------

app.post("/api/upload", async (req, res) => {
  const { secret, steamName, run: r } = req.body;

  if (secret !== SECRET) return res.status(403).json({ error: "Invalid secret." });
  if (!steamName || !r || !r.outcome || !r.startedAt)
    return res.status(400).json({ error: "Missing required fields." });

  try {
    const result = await saveRun(steamName, r);
    res.json(result);
  } catch (err) {
    console.error("[upload]", err.message);
    res.status(500).json({ error: "Failed to save run." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/upload-log  (drop a raw GuildRun .log file, parsed server-side)
// ---------------------------------------------------------------------------

app.post("/api/upload-log", express.text({ type: "*/*", limit: "20mb" }), async (req, res) => {
  const steamName = (req.query.steamName || "").trim();
  if (!steamName) return res.status(400).json({ error: "Missing steamName." });
  if (!req.body || typeof req.body !== "string" || !req.body.trim())
    return res.status(400).json({ error: "Empty log file." });

  try {
    const run = parseGuildRunLog(req.body);
    if (!run) return res.status(400).json({ error: "No completed run found in this log file." });

    const result = await saveRun(steamName, run);
    res.json({ ...result, run });
  } catch (err) {
    console.error("[upload-log]", err.message);
    res.status(500).json({ error: "Failed to parse or save log." });
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
