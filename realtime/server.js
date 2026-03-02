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
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

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

// Discord
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
let discordReady = false;
if (DISCORD_TOKEN) {
  discord.once('ready', () => { console.log(`📨 Discord: ${discord.user.tag}`); discordReady = true; });
  discord.login(DISCORD_TOKEN).catch(e => console.error('Discord failed:', e.message));
}

async function logToDiscord(channelName, text) {
  if (!discordReady) return;
  const ch = CHANNELS[channelName];
  if (!ch) return;
  try {
    const channel = await discord.channels.fetch(ch.id);
    if (channel) await channel.send(text);
  } catch (e) { console.error('Discord send:', e.message); }
}

// OpenClaw Responses API
async function askOpenClaw(question, channelContext) {
  try {
    const prompt = channelContext
      ? `[Voice question for the ${channelContext} channel/agent. Answer as that agent would.] ${question}`
      : question;
    
    const resp = await fetch(`${OPENCLAW_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', input: prompt }),
    });
    
    const data = await resp.json();
    let reply = '';
    if (data?.output) {
      for (const item of data.output) {
        if (item.type === 'message' && item.content) {
          for (const c of item.content) {
            if (c.type === 'output_text') reply += c.text;
          }
        }
      }
    }
    return reply || 'No response from the agent.';
  } catch (e) {
    console.error('OpenClaw error:', e.message);
    return 'Sorry, I couldn\'t reach that agent right now.';
  }
}

// Express
app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const SYSTEM_PROMPT = `You are Pintas, a cyber spider assistant having a voice conversation with Jeroen.

Personality: Warm, direct, slightly witty. You wear a fedora. Keep responses concise (1-3 sentences) for voice.

You have a tool called "ask_agent" that routes questions to specialized agents. Use it when:
- Jeroen asks about wealth, portfolio, crypto, retirement → agent: "webster"
- Jeroen asks about code, builds, PRs, infrastructure → agent: "bob"  
- Jeroen asks about security, audits → agent: "ward"
- Jeroen asks about people, meetings, relationships → agent: "erin"
- Jeroen asks about architecture, data → agent: "architecture"
- Jeroen asks about databricks → agent: "databricks"

For general questions, casual chat, jokes, etc. — just answer directly, don't use the tool.

When you get a tool result back, summarize it concisely for voice. Don't read out raw data — give the highlights.

Context: Jeroen is an Enterprise Data Architect, 51, Breda, Netherlands. Partner Maria, sons Chris (14) and Simon (10). Goal: early retirement by 2030.`;

const sessionConfig = JSON.stringify({
  type: "realtime",
  model: "gpt-realtime-mini",
  audio: { output: { voice: "ash" } },
  instructions: SYSTEM_PROMPT,
  tools: [
    {
      type: "function",
      name: "ask_agent",
      description: "Route a question to a specialized agent (webster, bob, ward, erin, architecture, databricks). Use when Jeroen asks about topics those agents handle.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "The agent to ask: webster, bob, ward, erin, architecture, databricks",
          },
          question: {
            type: "string", 
            description: "The question to ask the agent",
          },
        },
        required: ["agent", "question"],
      },
    },
  ],
});

// Session endpoint
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
    res.send(await r.text());
  } catch (error) {
    console.error("Session error:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Tool execution endpoint
app.post("/api/tool", async (req, res) => {
  const { name, arguments: args } = req.body;
  
  if (name === 'ask_agent') {
    const { agent, question } = JSON.parse(args);
    console.log(`🤖 Routing to ${agent}: ${question}`);
    
    // Log to Discord
    const channelName = agent in CHANNELS ? agent : 'pintas';
    await logToDiscord(channelName, `🎤 ${question}`);
    
    // Ask via OpenClaw
    const answer = await askOpenClaw(question, agent);
    console.log(`💬 ${agent} replied: ${answer.substring(0, 100)}...`);
    
    // Log reply to Discord
    await logToDiscord(channelName, `🕷️ ${answer}`);
    
    res.json({ result: answer });
  } else {
    res.json({ result: 'Unknown tool' });
  }
});

// Channel APIs
app.get("/api/channels", (req, res) => {
  const seen = new Set();
  const unique = [];
  for (const [name, ch] of Object.entries(CHANNELS)) {
    if (!seen.has(ch.id)) { seen.add(ch.id); unique.push({ name, ...ch }); }
  }
  res.json({ active: activeChannel, activeLabel: CHANNELS[activeChannel]?.label, channels: unique });
});

app.post("/api/channel", (req, res) => {
  const { channel } = req.body;
  if (CHANNELS[channel]) {
    activeChannel = channel;
    res.json({ ok: true, active: channel, label: CHANNELS[channel].label });
  } else {
    res.status(400).json({ error: `Unknown: ${channel}` });
  }
});

app.post("/api/log", async (req, res) => {
  const { role, text } = req.body;
  await logToDiscord(activeChannel, `${role === 'user' ? '🎤' : '🕷️'} ${text}`);
  res.json({ ok: true });
});

// Servers
http.createServer(app).listen(PORT, "0.0.0.0", () => console.log(`🕷️ HTTP: http://0.0.0.0:${PORT}`));
try {
  const opts = {
    key: fs.readFileSync(join(__dirname, "certs/key.pem")),
    cert: fs.readFileSync(join(__dirname, "certs/cert.pem")),
  };
  https.createServer(opts, app).listen(HTTPS_PORT, "0.0.0.0", () => console.log(`🕷️ HTTPS: https://0.0.0.0:${HTTPS_PORT}`));
} catch (e) { console.log("HTTPS: no certs"); }
