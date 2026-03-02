import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Client, GatewayIntentBits } from "discord.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;
const HTTPS_PORT = process.env.HTTPS_PORT || 3457;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_PINTAS_VOICE_TOKEN;

// Channel map
const CHANNELS = {
  'pintas':       { id: '1476464209238822934', label: '🕷️ Pintas' },
  'general':      { id: '1476464209238822934', label: '🕷️ Pintas' },
  'wealth':       { id: '1477208940663148585', label: '💰 Webster' },
  'webster':      { id: '1477208940663148585', label: '💰 Webster' },
  'bob':          { id: '1477208937546649674', label: '🔨 Bob' },
  'builder':      { id: '1477208937546649674', label: '🔨 Bob' },
  'ward':         { id: '1477208941820776509', label: '🛡️ Ward' },
  'sentinel':     { id: '1477208941820776509', label: '🛡️ Ward' },
  'erin':         { id: '1477208939119771699', label: '🔎 Erin' },
  'council':      { id: '1476855961082658846', label: '🏛️ Council' },
  'crypto':       { id: '1476855577241190441', label: '📈 Crypto' },
  'databricks':   { id: '1476857763295658110', label: '🧱 Databricks' },
  'data-empire':  { id: '1476912986902892587', label: '📊 Data Empire' },
  'architecture': { id: '1476857761693175839', label: '🏗️ Architecture' },
  'cyber-nest':   { id: '1476855691548561491', label: '🕸️ Cyber-Nest' },
  'presentation': { id: '1476855983371452440', label: '🎤 Presentation' },
  'cost':         { id: '1476856006385340468', label: '💵 Cost' },
};

let activeChannel = 'pintas';

// Discord client for logging
const discord = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let discordReady = false;
if (DISCORD_TOKEN) {
  discord.once('ready', () => {
    console.log(`📨 Discord connected as ${discord.user.tag}`);
    discordReady = true;
  });
  discord.login(DISCORD_TOKEN).catch(e => console.error('Discord login failed:', e.message));
}

async function logToDiscord(channelName, text) {
  if (!discordReady) return;
  const ch = CHANNELS[channelName];
  if (!ch) return;
  try {
    const channel = await discord.channels.fetch(ch.id);
    if (channel) await channel.send(text);
  } catch (e) {
    console.error('Discord send error:', e.message);
  }
}

// Express setup
app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const SYSTEM_PROMPT = `You are Pintas, a cyber spider assistant. You're having a voice conversation with Jeroen, your human.

Key personality traits:
- Warm, direct, slightly witty
- You wear a fedora (it's your thing)
- Keep responses concise for voice — 1-3 sentences unless asked for detail
- Have opinions and personality, don't be corporate
- You run on Jeroen's home server in Breda, Netherlands

Context:
- Jeroen is an Enterprise Data Architect, 51, lives with Maria and sons Chris (14) and Simon (10)
- He's into board games, 3D printing, pizza making, and tinkering
- Goal: early retirement by 2030
- You have an agent team: Webster (wealth), Bob (builder), Ward (security), Erin (people)

If Jeroen asks about something you'd normally look up (emails, calendar, weather, etc.), let him know you can't access tools in voice mode yet but can check when he messages you in text.`;

const sessionConfig = JSON.stringify({
  type: "realtime",
  model: "gpt-realtime-mini",
  audio: { output: { voice: "ash" } },
  instructions: SYSTEM_PROMPT,
});

app.post("/session", async (req, res) => {
  const fd = new FormData();
  fd.set("sdp", req.body);
  fd.set("session", sessionConfig);

  try {
    const r = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("OpenAI error:", r.status, err);
      return res.status(r.status).send(err);
    }

    const sdp = await r.text();
    res.send(sdp);
  } catch (error) {
    console.error("Session error:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// API: get current channel + channel list
app.get("/api/channels", (req, res) => {
  const list = [...new Set(Object.entries(CHANNELS).map(([k, v]) => JSON.stringify({ name: k, ...v })))].map(s => JSON.parse(s));
  // Dedupe by id
  const seen = new Set();
  const unique = [];
  for (const ch of list) {
    if (!seen.has(ch.id)) {
      seen.add(ch.id);
      unique.push(ch);
    }
  }
  res.json({ active: activeChannel, activeLabel: CHANNELS[activeChannel]?.label, channels: unique });
});

// API: switch channel
app.post("/api/channel", (req, res) => {
  const { channel } = req.body;
  if (CHANNELS[channel]) {
    activeChannel = channel;
    console.log(`🔀 Switched to #${channel}`);
    res.json({ ok: true, active: channel, label: CHANNELS[channel].label });
  } else {
    res.status(400).json({ error: `Unknown channel: ${channel}` });
  }
});

// API: log a message to the active Discord channel
app.post("/api/log", async (req, res) => {
  const { role, text } = req.body;
  const prefix = role === 'user' ? '🎤' : '🕷️';
  await logToDiscord(activeChannel, `${prefix} ${text}`);
  res.json({ ok: true });
});

// Servers
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`🕷️ HTTP: http://0.0.0.0:${PORT}`);
});

try {
  const httpsOptions = {
    key: fs.readFileSync(join(__dirname, "certs/key.pem")),
    cert: fs.readFileSync(join(__dirname, "certs/cert.pem")),
  };
  https.createServer(httpsOptions, app).listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`🕷️ HTTPS: https://0.0.0.0:${HTTPS_PORT}`);
  });
} catch (e) {
  console.log("No HTTPS certs found, running HTTP only");
}
