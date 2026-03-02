import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;
const HTTPS_PORT = process.env.HTTPS_PORT || 3457;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(express.text({ type: ["application/sdp", "text/plain"] }));
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

// HTTP server
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`🕷️ HTTP: http://0.0.0.0:${PORT}`);
});

// HTTPS server (for mobile mic access)
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
