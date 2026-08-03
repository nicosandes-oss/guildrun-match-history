// companion.js
// GuildRun run history companion.
//
// Watches your GuildRun log folder for new/completed session logs,
// parses each run, and uploads a structured summary to the history server.
//
// SETUP (run once):
//   1. Install Node.js (nodejs.org)
//   2. Edit config.json with your Steam name, server URL, and secret
//   3. Run: node companion.js
//   4. Leave it running in the background while you play
//
// The companion ONLY reads your log files — it never modifies game files.
// It sends: your steam name, run outcome, heroes used, relics collected,
// stages cleared, and run duration. Nothing else.

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config — reads from config.json in the same folder
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG = {
  steamName:  "YourSteamName",
  serverUrl:  "https://your-site.onrender.com",
  secret:     "dev_secret_change_me",
  // Default log path for Windows — Steam library may differ
  logFolder:  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Guildrun Demo\\Guildrun_Data\\Logs",
  pollIntervalMs: 10000,
};

if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log(`Created config.json — please edit it with your details, then restart.`);
  process.exit(0);
}

const config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };

if (config.steamName === "YourSteamName") {
  console.error("Please edit config.json and set your steamName, then restart.");
  process.exit(1);
}
if (!fs.existsSync(config.logFolder)) {
  console.error(`Log folder not found: ${config.logFolder}`);
  console.error("Edit config.json and set the correct logFolder path.");
  process.exit(1);
}

console.log(`GuildRun Companion started`);
console.log(`  Player:    ${config.steamName}`);
console.log(`  Server:    ${config.serverUrl}`);
console.log(`  Log folder: ${config.logFolder}`);

// ---------------------------------------------------------------------------
// Hero name mapping — built at runtime from log events, grows over time
// Stored in hero_map.json so it persists across sessions
// ---------------------------------------------------------------------------

const HERO_MAP_PATH = path.join(__dirname, "hero_map.json");
let heroSeqMap = {};  // seq number -> hero name, e.g. { 13: "Tilly", 16: "Gustav" }

if (fs.existsSync(HERO_MAP_PATH)) {
  heroSeqMap = JSON.parse(fs.readFileSync(HERO_MAP_PATH, "utf8"));
  console.log(`  Hero map:  ${Object.keys(heroSeqMap).length} heroes known`);
}

function saveHeroMap() {
  fs.writeFileSync(HERO_MAP_PATH, JSON.stringify(heroSeqMap, null, 2));
}

const CLASS_NAMES = { 1:"Warrior", 2:"Tank", 3:"Vanguard", 4:"Assassin", 5:"Duelist", 6:"Mystic", 7:"Mage" };
const RANK_LABELS = { 1:"C", 2:"B", 3:"A", 4:"S" };

// Item ID -> display name. Add more as you discover them.
const ITEM_NAMES = {
  "seq:tem_106": "Runestone",
  "seq:tem_108": "Orb",
  "seq:tem_501": "Rift Seal",
  "seq:tem_611": "Cleric's Scroll",
  "seq:tem_630": "Sentinel's Plate",
  "seq:tem_636": "Battle Mage Robes",
  "seq:tem_724": "Executioner's Blade",
  "seq:tem_739": "Polymath's Prism",
};

// ---------------------------------------------------------------------------
// Log parser — extracts a run summary from one session log file
// ---------------------------------------------------------------------------

function parseLog(logPath) {
  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.split(/\r?\n/);

  const run = {
    outcome:        null,
    startedAt:      null,
    endedAt:        null,
    durationSeconds: null,
    stagesCleared:  0,
    furthestStage:  null,
    heroes:         [],
    relics:         [],
  };

  // uuid -> hero name, built from this session's creation events
  const uuidToName = {};
  const battleConfigs = [];

  for (const line of lines) {
    const ts = (line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1];

    // Run started
    if (line.includes("OnRunStarted") && line.includes("Recording run started")) {
      run.startedAt = ts;
    }

    // Defeat
    if (line.includes("has been defeated")) {
      run.outcome = "defeat";
      run.endedAt = ts;
    }

    // Victory — game logs "runs beaten" increment on next session load,
    // but within the same log we detect it by: last battle was the Act 2
    // boss floor (IsBossFloor:true, CurrentChunkIndex:1) AND a combat
    // victory followed it.
    if (line.includes("OnRunCompleted") || line.includes("RunVictory") || line.includes("RunCompleted") || line.includes("RiftCleared")) {
      run.outcome = "rift_cleared";
      run.endedAt = ts;
    }

    // Combat victory = stage cleared
    if (line.includes("OnCombatVictory")) {
      run.stagesCleared++;
      // If the last battle config was Act 2 boss floor, this combat victory
      // means the Final Boss was defeated — the run was cleared.
      if (battleConfigs.length > 0) {
        const last = battleConfigs[battleConfigs.length - 1];
        if (last.IsBossFloor && last.CurrentChunkIndex === 1) {
          run.outcome = "rift_cleared";
          run.endedAt = ts;
        }
      }
    }

    // Stage tracking
    const stageMatch = line.match(/Initializing board for stage (Stage_\d+)/);
    if (stageMatch) {
      run.furthestStage = stageMatch[1];
    }

    // Relic grants — name is written as plain text in the log
    const relicMatch = line.match(/Granting relic (.+?) \([0-9a-f-]{36}\)/);
    if (relicMatch) {
      const name = relicMatch[1].trim();
      if (!run.relics.includes(name)) {
        run.relics.push(name);
      }
    }

    // Hero creation — builds uuid->name mapping
    const heroCreateMatch = line.match(/Added new hero (\w+) \(([0-9a-f-]{36})\)/);
    if (heroCreateMatch) {
      uuidToName[heroCreateMatch[2]] = heroCreateMatch[1];
    }

    // Battle configs — last one has the final hero state for the run
    if (line.includes("LogBattle:417") && line.includes("Starting battle with config:")) {
      const jsonStart = line.indexOf("Starting battle with config: ") + "Starting battle with config: ".length;
      try {
        battleConfigs.push(JSON.parse(line.slice(jsonStart).trim()));
      } catch {}
    }
  }

  // Outcome fallback: if the log has a run start but no explicit end marker,
  // it's likely the player quit mid-run (abandoned).
  if (run.startedAt && !run.outcome) {
    run.outcome = battleConfigs.length > 0 ? "abandoned" : null;
  }

  // No run found in this file at all
  if (!run.startedAt || !run.outcome) return null;

  // Duration
  if (run.startedAt && run.endedAt) {
    const s = new Date(run.startedAt.replace(" ", "T"));
    const e = new Date(run.endedAt.replace(" ", "T"));
    run.durationSeconds = Math.round((e - s) / 1000);
  }

  // Build hero list from last battle config
  if (battleConfigs.length > 0) {
    const last = battleConfigs[battleConfigs.length - 1];

    // Update hero seq map from this session's data (active + reserve heroes)
    for (const config of battleConfigs) {
      for (const hero of [...(config.HeroDtos || []), ...(config.ReserveHeroDtos || [])]) {
        const charRef = hero.CharacterRef || "";
        const seqMatch = charRef.match(/Hero_(\d+)/);
        const entityId = hero.EntityId || "";
        if (seqMatch && uuidToName[entityId]) {
          const seq = parseInt(seqMatch[1], 10);
          if (!heroSeqMap[seq]) {
            heroSeqMap[seq] = uuidToName[entityId];
            console.log(`  Learned: seq:Hero_${seq} = ${uuidToName[entityId]}`);
          }
        }
      }
    }
    saveHeroMap();

    // Extract heroes from last battle state (active heroes only, not reserve)
    for (const hero of last.HeroDtos || []) {
      const charRef = hero.CharacterRef || "";
      const seqMatch = charRef.match(/Hero_(\d+)/);
      const seq = seqMatch ? parseInt(seqMatch[1], 10) : null;
      const name = (seq !== null && heroSeqMap[seq])
        ? heroSeqMap[seq]
        : (uuidToName[hero.EntityId] || `Hero_${seq}`);

      const classes = (hero.HeroClasses || [])
        .map((hc) => {
          const cm = (hc.Id || "").match(/HeroClass_(\d+)/);
          return cm ? (CLASS_NAMES[parseInt(cm[1], 10)] || `Class_${cm[1]}`) : null;
        })
        .filter(Boolean);

      // Filter out null item slots, translate known IDs to names
      const items = (hero.EquippedItems || [])
        .filter((item) => item !== null && item !== undefined)
        .map((item) => {
          const ref = item.ItemRef || "";
          return ITEM_NAMES[ref] || ref;
        })
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
// Upload a parsed run to the server
// ---------------------------------------------------------------------------

async function uploadRun(run) {
  const response = await fetch(`${config.serverUrl}/api/upload`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret:    config.secret,
      steamName: config.steamName,
      run,
    }),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// File watcher — polls the log folder for files that are "done"
// A log file is considered done when it hasn't been modified in 60 seconds
// (the game is either between sessions or the session has ended)
// ---------------------------------------------------------------------------

const uploadedFiles = new Set();
const UPLOADED_CACHE = path.join(__dirname, "uploaded.json");

if (fs.existsSync(UPLOADED_CACHE)) {
  const cached = JSON.parse(fs.readFileSync(UPLOADED_CACHE, "utf8"));
  cached.forEach((f) => uploadedFiles.add(f));
  console.log(`  Already uploaded: ${uploadedFiles.size} files`);
}

function saveUploadedCache() {
  fs.writeFileSync(UPLOADED_CACHE, JSON.stringify([...uploadedFiles], null, 2));
}

async function checkLogs() {
  const now = Date.now();
  let files;
  try {
    files = fs.readdirSync(config.logFolder).filter((f) => f.match(/^\d{4}-\d{2}-\d{2}-game.*\.log$/));
  } catch (err) {
    console.error(`Cannot read log folder: ${err.message}`);
    return;
  }

  for (const file of files) {
    const fullPath = path.join(config.logFolder, file);
    if (uploadedFiles.has(file)) continue;

    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }

    // Only process files not modified in the last 60 seconds
    // (gives the game time to finish writing)
    const ageSecs = (now - stat.mtimeMs) / 1000;
    if (ageSecs < 60) continue;

    console.log(`Processing: ${file}`);

    try {
      const run = parseLog(fullPath);
      if (!run) {
        console.log(`  No run found (startup-only session), marking done.`);
        uploadedFiles.add(file);
        saveUploadedCache();
        continue;
      }

      console.log(`  Run: ${run.outcome}, ${Math.round((run.durationSeconds || 0)/60)}m, ` +
                  `${run.stagesCleared} stages, ${run.heroes.length} heroes, ${run.relics.length} relics`);

      const result = await uploadRun(run);

      if (result.status === "ok" || result.status === "duplicate") {
        console.log(`  Uploaded: ${result.status} (id: ${result.id || "existing"})`);
        uploadedFiles.add(file);
        saveUploadedCache();
      } else {
        console.error(`  Upload failed:`, result.error || result);
      }
    } catch (err) {
      console.error(`  Error processing ${file}:`, err.message);
    }
  }
}

// Poll on startup and then every N seconds
checkLogs();
setInterval(checkLogs, config.pollIntervalMs);
console.log(`Watching for new runs every ${config.pollIntervalMs / 1000}s...`);
