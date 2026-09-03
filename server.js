const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'database.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initial DB template
function getInitialData() {
  return {
    settings: {
      streamerName: "Jonpeek",
      kickUrl: "https://kick.com/JONPEEK",
      youtubeUrl: "https://www.youtube.com/@Jonpeekcs",
      adminPin: "1234",
      currency: "USD",
      currencySymbol: "$",
      payoutTiers: [
        { minViews: 10000, maxViews: 49999, payout: 5, label: "🥉 Nivel 1 (10K+ Views)", badge: "tier-1" },
        { minViews: 50000, maxViews: 99999, payout: 25, label: "🥈 Nivel 2 (50K+ Views)", badge: "tier-2" },
        { minViews: 100000, maxViews: 499999, payout: 40, label: "🥇 Nivel 3 (100K+ Views)", badge: "tier-3" },
        { minViews: 500000, maxViews: 999999, payout: 120, label: "💎 Nivel Master (500K+ Views)", badge: "tier-4" },
        { minViews: 1000000, maxViews: null, payout: 250, label: "👑 Nivel Viral Legend (1M+ Views)", badge: "tier-5" }
      ]
    },
    clippers: [
      { id: "c1", name: "Clipper 1", handle: "@clipper1_jp", role: "Picks Verdes y Cuotas en Vivo", active: true },
      { id: "c2", name: "Clipper 2", handle: "@clipper2_jp", role: "Estadísticas y Datos Anti-Humo", active: true },
      { id: "c3", name: "Clipper 3", handle: "@clipper3_jp", role: "Momentos Tensión / Polémicas", active: true },
      { id: "c4", name: "Clipper 4", handle: "@clipper4_jp", role: "Psicología & Gestión de Capital", active: true },
      { id: "c5", name: "Clipper 5", handle: "@clipper5_jp", role: "Multiplicadores y Just Chatting", active: true }
    ],
    clips: [],
    events: []
  };
}

function readDB() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const init = getInitialData();
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), 'utf-8');
    return init;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return getInitialData();
  }
}

function writeDB(data) {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Payout Calculation Engine
function calculatePayout(views, tiers) {
  views = parseInt(views) || 0;
  let matchingTier = null;
  let payout = 0;
  let tierLabel = "En progreso (< 10K views)";
  let badge = "tier-0";

  const sortedTiers = [...tiers].sort((a, b) => b.minViews - a.minViews);
  for (const tier of sortedTiers) {
    if (views >= tier.minViews) {
      matchingTier = tier;
      payout = tier.payout;
      tierLabel = tier.label;
      badge = tier.badge;
      break;
    }
  }

  return { payout, tierLabel, badge };
}

// Detect Platform
function detectPlatform(url) {
  if (!url) return 'otro';
  const u = url.toLowerCase();
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  return 'otro';
}

// Parse Embed Details
function parseEmbedInfo(url, platform) {
  if (!url) return { type: 'link', embedUrl: url };

  try {
    if (platform === 'facebook') {
      return {
        type: 'facebook',
        embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&width=360`
      };
    }

    if (platform === 'youtube') {
      let videoId = '';
      if (url.includes('/shorts/')) {
        videoId = url.split('/shorts/')[1].split('?')[0].split('/')[0];
      } else if (url.includes('v=')) {
        videoId = new URL(url).searchParams.get('v');
      } else if (url.includes('youtu.be/')) {
        videoId = url.split('youtu.be/')[1].split('?')[0];
      }
      if (videoId) {
        return {
          type: 'youtube',
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0`,
          videoId
        };
      }
    }

    if (platform === 'tiktok') {
      const match = url.match(/video\/(\d+)/);
      if (match && match[1]) {
        return {
          type: 'tiktok',
          videoId: match[1],
          embedUrl: `https://www.tiktok.com/embed/v2/${match[1]}`
        };
      }
      return { type: 'tiktok', embedUrl: url };
    }

    if (platform === 'instagram') {
      const match = url.match(/(?:reel|p)\/([A-Za-z0-9_-]+)/);
      if (match && match[1]) {
        return {
          type: 'instagram',
          code: match[1],
          embedUrl: `https://www.instagram.com/reel/${match[1]}/embed`
        };
      }
    }

    if (platform === 'twitter') {
      const match = url.match(/status\/(\d+)/);
      if (match && match[1]) {
        return {
          type: 'twitter',
          tweetId: match[1],
          embedUrl: url
        };
      }
    }
  } catch (e) {}

  return { type: 'link', embedUrl: url };
}

// Helper: HTTP Request for scraping & oEmbed
function fetchText(targetUrl) {
  return new Promise((resolve) => {
    const client = targetUrl.startsWith('https') ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*'
      },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { if (data.length < 500000) data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// --- API ROUTES ---

// Helper: Execute python extractor
const { execFile } = require('child_process');

function runPythonExtractor(url) {
  return new Promise((resolve) => {
    execFile('python', [path.join(__dirname, 'extract_meta.py'), url], { timeout: 12000 }, (error, stdout, stderr) => {
      if (error || !stdout) {
        return resolve(null);
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json && json.success) {
          return resolve(json);
        }
        return resolve(null);
      } catch (e) {
        return resolve(null);
      }
    });
  });
}

// 1. AUTO-METADATA FETCHER (Auto-fill title, views, platform, embed on link paste)
app.post('/api/fetch-metadata', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL requerida" });

  const platform = detectPlatform(url);
  const embedInfo = parseEmbedInfo(url, platform);
  let metadata = {
    url,
    platform,
    title: "",
    views: 0,
    author: "",
    thumbnail: "",
    publishDate: new Date().toISOString().split('T')[0],
    embedInfo,
    suggestedCategory: "Pick Verde",
    autoDetected: false
  };

  try {
    // 1. First attempt: High-accuracy extraction using yt-dlp (Extracts REAL views, title, upload date)
    const pyMeta = await runPythonExtractor(url);
    if (pyMeta) {
      metadata.title = pyMeta.title || metadata.title;
      metadata.views = parseInt(pyMeta.views) || 0;
      metadata.author = pyMeta.author || "";
      metadata.thumbnail = pyMeta.thumbnail || "";
      if (pyMeta.publishDate) metadata.publishDate = pyMeta.publishDate;
      metadata.autoDetected = true;
    }

    // 2. Fallback if views or title were missing
    if (!metadata.title || metadata.views === 0) {
      if (platform === 'youtube') {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const raw = await fetchText(oembedUrl);
        if (raw) {
          try {
            const json = JSON.parse(raw);
            if (!metadata.title) metadata.title = json.title || "";
            if (!metadata.author) metadata.author = json.author_name || "";
            if (!metadata.thumbnail) metadata.thumbnail = json.thumbnail_url || "";
            metadata.autoDetected = true;
          } catch (e) {}
        }
      }

      if (platform === 'tiktok') {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
        const raw = await fetchText(oembedUrl);
        if (raw) {
          try {
            const json = JSON.parse(raw);
            if (!metadata.title) metadata.title = json.title || `TikTok de ${json.author_name || 'Jonpeek'}`;
            if (!metadata.author) metadata.author = json.author_name || "";
            metadata.autoDetected = true;
          } catch (e) {}
        }
      }
    }

    // Suggest Category based on title
    const t = (metadata.title || "").toLowerCase();
    if (t.includes('analisis') || t.includes('dato') || t.includes('tactico') || t.includes('estadistica')) {
      metadata.suggestedCategory = "Análisis Anti-Humo";
    } else if (t.includes('var') || t.includes('robo') || t.includes('polemica') || t.includes('anulado') || t.includes('rage')) {
      metadata.suggestedCategory = "Momentos Tensión";
    } else if (t.includes('bankroll') || t.includes('disciplina') || t.includes('perdida') || t.includes('capital')) {
      metadata.suggestedCategory = "Bankroll & Psicología";
    } else if (t.includes('casino') || t.includes('slot') || t.includes('multiplicador')) {
      metadata.suggestedCategory = "Casino & Multiplicador";
    } else {
      metadata.suggestedCategory = "Pick Verde";
    }

  } catch (err) {
    console.error("Error auto-fetching metadata:", err.message);
  }

  res.json(metadata);
});

// 2. Verify Admin PIN
app.post('/api/auth/admin', (req, res) => {
  const { pin } = req.body;
  const db = readDB();
  const validPin = db.settings.adminPin || "2001";

  if (pin === validPin) {
    res.json({ success: true, message: "PIN correcto. Acceso como Admin concedido." });
  } else {
    res.status(401).json({ success: false, error: "PIN incorrecto. Intenta con el PIN de administrador." });
  }
});

// Helper: Determine clip billing period month
function getClipMonth(clip) {
  if (clip.checkDate && clip.checkDate.length >= 7) return clip.checkDate.slice(0, 7);
  if (clip.createdAt && clip.createdAt.length >= 7) return clip.createdAt.slice(0, 7);
  if (clip.publishDate && clip.publishDate.length >= 7) return clip.publishDate.slice(0, 7);
  return new Date().toISOString().slice(0, 7);
}

// Helper: Generate rolling months (past 6 months + current + next 6 future months + DB months)
function getFullMonthList(clips, events) {
  const monthSet = new Set();
  const now = new Date();

  // Generate 6 months before, current month, and 6 months ahead
  for (let i = -6; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    monthSet.add(d.toISOString().slice(0, 7));
  }

  (clips || []).forEach(c => {
    monthSet.add(getClipMonth(c));
  });
  (events || []).forEach(e => {
    const m = (e.date || "").slice(0, 7);
    if (m && m.length === 7) monthSet.add(m);
  });

  return Array.from(monthSet).sort().reverse();
}

// 3. Stats & Overview (With Monthly Filtering & Full Rolling Calendar)
app.get('/api/stats', (req, res) => {
  const db = readDB();
  let clips = db.clips || [];
  const clippers = db.clippers || [];
  const events = db.events || [];
  const { month } = req.query; // e.g. "2026-09"

  const availableMonths = getFullMonthList(clips, events);
  const currentMonth = new Date().toISOString().slice(0, 7); // "2026-09"

  // Filter clips by month if requested
  if (month && month !== 'all') {
    clips = clips.filter(c => getClipMonth(c) === month);
  }

  let totalViews = 0;
  let totalEarned = 0;
  let totalPendingPayout = 0;
  let totalPaid = 0;
  let qualifiedClips = 0;

  const clipperStats = {};
  clippers.forEach(c => {
    clipperStats[c.id] = {
      id: c.id,
      name: c.name,
      handle: c.handle,
      role: c.role,
      clipsCount: 0,
      qualifiedClips: 0,
      totalViews: 0,
      totalEarned: 0,
      pendingPayout: 0,
      paidAmount: 0,
      topViews: 0
    };
  });

  clips.forEach(clip => {
    const views = parseInt(clip.views) || 0;
    const payout = parseFloat(clip.payout) || 0;
    totalViews += views;
    totalEarned += payout;

    if (views >= 10000) qualifiedClips++;

    if (clip.status === 'paid') {
      totalPaid += payout;
    } else {
      totalPendingPayout += payout;
    }

    if (clipperStats[clip.clipperId]) {
      const cs = clipperStats[clip.clipperId];
      cs.clipsCount++;
      if (views >= 10000) cs.qualifiedClips++;
      cs.totalViews += views;
      cs.totalEarned += payout;
      if (clip.status === 'paid') {
        cs.paidAmount += payout;
      } else {
        cs.pendingPayout += payout;
      }
      if (views > cs.topViews) {
        cs.topViews = views;
      }
    }
  });

  const leaderboard = Object.values(clipperStats).sort((a, b) => b.totalViews - a.totalViews);

  res.json({
    totalClips: clips.length,
    qualifiedClips,
    totalViews,
    totalEarned,
    totalPendingPayout,
    totalPaid,
    leaderboard,
    availableMonths,
    selectedMonth: month || currentMonth,
    settings: db.settings
  });
});

// 4. Clips CRUD
app.get('/api/clips', (req, res) => {
  const db = readDB();
  let clips = db.clips || [];
  const { clipperId, platform, status, search, month } = req.query;

  if (month && month !== 'all') {
    clips = clips.filter(c => getClipMonth(c) === month);
  }
  if (clipperId) clips = clips.filter(c => c.clipperId === clipperId);
  if (platform) clips = clips.filter(c => c.platform === platform);
  if (status) clips = clips.filter(c => c.status === status);
  if (search) {
    const s = search.toLowerCase();
    clips = clips.filter(c => 
      (c.title && c.title.toLowerCase().includes(s)) ||
      (c.clipperName && c.clipperName.toLowerCase().includes(s)) ||
      (c.category && c.category.toLowerCase().includes(s)) ||
      (c.url && c.url.toLowerCase().includes(s))
    );
  }

  const enriched = clips.map(clip => ({
    ...clip,
    embedInfo: parseEmbedInfo(clip.url, clip.platform)
  }));

  res.json(enriched);
});

// Create Clip (with URL deduplication update)
app.post('/api/clips', (req, res) => {
  const db = readDB();
  const { clipperId, url, views, title, category, publishDate, checkDate, notes } = req.body;

  if (!clipperId || !url) {
    return res.status(400).json({ error: "Faltan campos obligatorios: clipperId y url" });
  }

  const clipper = db.clippers.find(c => c.id === clipperId);
  const clipperName = clipper ? clipper.name : "Clipper";
  const platform = detectPlatform(url);
  const numViews = parseInt(views) || 0;
  const { payout, tierLabel, badge } = calculatePayout(numViews, db.settings.payoutTiers);

  // Check if clip URL already exists for this clipper: update views instead of duplicating
  const cleanUrl = url.split('?')[0];
  const existingIndex = db.clips.findIndex(c => c.clipperId === clipperId && (c.url === url || c.url.split('?')[0] === cleanUrl));

  if (existingIndex !== -1) {
    const updated = {
      ...db.clips[existingIndex],
      views: numViews,
      payout,
      tierLabel,
      badge,
      title: title || db.clips[existingIndex].title,
      category: category || db.clips[existingIndex].category,
      checkDate: checkDate || new Date().toISOString().split('T')[0],
      notes: notes || db.clips[existingIndex].notes,
      updatedAt: new Date().toISOString()
    };
    db.clips[existingIndex] = updated;
    writeDB(db);
    return res.status(200).json(updated);
  }

  const newClip = {
    id: "clip-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4),
    clipperId,
    clipperName,
    url,
    platform,
    title: title || `Clip de ${clipperName}`,
    category: category || "Pick Verde",
    views: numViews,
    publishDate: publishDate || new Date().toISOString().split('T')[0],
    checkDate: checkDate || new Date().toISOString().split('T')[0],
    status: req.body.status || "pending",
    payout,
    tierLabel,
    badge,
    notes: notes || "",
    createdAt: new Date().toISOString()
  };

  db.clips.unshift(newClip);
  writeDB(db);

  res.status(201).json(newClip);
});

app.put('/api/clips/:id', (req, res) => {
  const db = readDB();
  const clipIndex = db.clips.findIndex(c => c.id === req.params.id);
  if (clipIndex === -1) return res.status(404).json({ error: "Clip no encontrado" });

  const current = db.clips[clipIndex];
  const views = req.body.views !== undefined ? parseInt(req.body.views) : current.views;
  const { payout, tierLabel, badge } = calculatePayout(views, db.settings.payoutTiers);

  let clipperName = current.clipperName;
  if (req.body.clipperId && req.body.clipperId !== current.clipperId) {
    const cl = db.clippers.find(c => c.id === req.body.clipperId);
    if (cl) clipperName = cl.name;
  }

  const updated = {
    ...current,
    ...req.body,
    clipperName,
    views,
    payout: req.body.customPayout !== undefined ? parseFloat(req.body.customPayout) : payout,
    tierLabel,
    badge,
    platform: req.body.url ? detectPlatform(req.body.url) : current.platform,
    updatedAt: new Date().toISOString()
  };

  db.clips[clipIndex] = updated;
  writeDB(db);

  res.json(updated);
});

app.delete('/api/clips/:id', (req, res) => {
  const db = readDB();
  db.clips = db.clips.filter(c => c.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// 5. Clippers CRUD
app.get('/api/clippers', (req, res) => {
  const db = readDB();
  res.json(db.clippers || []);
});

// Create New Clipper
app.post('/api/clippers', (req, res) => {
  const db = readDB();
  db.clippers = db.clippers || [];

  let nextNum = db.clippers.length + 1;
  while (db.clippers.some(c => c.id === `c${nextNum}`)) {
    nextNum++;
  }
  const nextId = req.body.id || `c${nextNum}`;

  const newClipper = {
    id: nextId,
    name: req.body.name || `Clipper ${nextNum}`,
    handle: req.body.handle || `@clipper${nextNum}_jp`,
    role: req.body.role || "Editor de Contenido General",
    active: req.body.active !== undefined ? req.body.active : true,
    createdAt: new Date().toISOString()
  };

  db.clippers.push(newClipper);
  writeDB(db);

  res.status(201).json(newClipper);
});

// Delete Clipper
app.delete('/api/clippers/:id', (req, res) => {
  const db = readDB();
  db.clippers = (db.clippers || []).filter(c => c.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// Update Clipper Profile
app.put('/api/clippers/:id', (req, res) => {
  const db = readDB();
  const clipperIndex = db.clippers.findIndex(c => c.id === req.params.id);
  if (clipperIndex === -1) return res.status(404).json({ error: "Clipper no encontrado" });

  const updatedClipper = {
    ...db.clippers[clipperIndex],
    name: req.body.name || db.clippers[clipperIndex].name,
    handle: req.body.handle || db.clippers[clipperIndex].handle,
    role: req.body.role || db.clippers[clipperIndex].role,
    active: req.body.active !== undefined ? req.body.active : db.clippers[clipperIndex].active
  };

  db.clippers[clipperIndex] = updatedClipper;

  // Also update clipperName on all their clips
  if (req.body.name) {
    db.clips = db.clips.map(clip => {
      if (clip.clipperId === req.params.id) {
        return { ...clip, clipperName: req.body.name };
      }
      return clip;
    });
  }

  writeDB(db);
  res.json(updatedClipper);
});

app.post('/api/clippers/:id/payout', (req, res) => {
  const db = readDB();
  const clipperId = req.params.id;
  let paidCount = 0;
  let paidSum = 0;

  db.clips = db.clips.map(clip => {
    if (clip.clipperId === clipperId && clip.status !== 'paid') {
      paidCount++;
      paidSum += clip.payout;
      return { ...clip, status: 'paid', paidAt: new Date().toISOString() };
    }
    return clip;
  });

  writeDB(db);
  res.json({ success: true, paidCount, paidSum });
});

// 6. Settings & Tiers
app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json(db.settings);
});

app.put('/api/settings', (req, res) => {
  const db = readDB();
  db.settings = { ...db.settings, ...req.body };
  
  db.clips = db.clips.map(clip => {
    const { payout, tierLabel, badge } = calculatePayout(clip.views, db.settings.payoutTiers);
    return { ...clip, payout, tierLabel, badge };
  });

  writeDB(db);
  res.json(db.settings);
});

// 7. Events API
app.get('/api/events', (req, res) => {
  const db = readDB();
  res.json(db.events || []);
});

app.post('/api/events', (req, res) => {
  const db = readDB();
  const newEvent = {
    id: "ev-" + Date.now(),
    title: req.body.title || "Directo Kick",
    date: req.body.date,
    time: req.body.time || "20:00 CEST",
    assignedTo: req.body.assignedTo || "Equipo",
    streamType: req.body.streamType || "Pronósticos y Cuotas",
    status: req.body.status || "programado"
  };
  db.events.push(newEvent);
  writeDB(db);
  res.status(201).json(newEvent);
});

app.delete('/api/events/:id', (req, res) => {
  const db = readDB();
  db.events = db.events.filter(e => e.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// 8. CSV Export
app.get('/api/export/csv', (req, res) => {
  const db = readDB();
  const clips = db.clips || [];

  const headers = ['ID', 'Clipper', 'Plataforma', 'Titulo', 'Categoria', 'Vistas', 'Pago ($)', 'Nivel/Tier', 'Fecha Publicacion', 'Fecha Revision', 'Estado Pago', 'URL', 'Notas'];
  const rows = clips.map(c => [
    `"${c.id}"`,
    `"${c.clipperName}"`,
    `"${c.platform}"`,
    `"${(c.title || '').replace(/"/g, '""')}"`,
    `"${c.category || ''}"`,
    c.views,
    c.payout,
    `"${c.tierLabel || ''}"`,
    `"${c.publishDate || ''}"`,
    `"${c.checkDate || ''}"`,
    `"${c.status}"`,
    `"${c.url}"`,
    `"${(c.notes || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reporte_clippers_jonpeek_${new Date().toISOString().split('T')[0]}.csv"`);
  res.send('\uFEFF' + csvContent);
});

// 9. Full Database Backup
app.get('/api/backup', (req, res) => {
  const db = readDB();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup_jonpeek_clippers_${new Date().toISOString().split('T')[0]}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

// Server listen
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 JONPEEK CLIPPERS HUB & AUTO-FETCHER RUNNING!`);
  console.log(`📡 URL Local: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
