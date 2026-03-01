/**
 * Pintas Voice Bridge
 * 
 * A voice-to-text-channel bridge for Discord.
 * Joins a voice channel, listens to speech, transcribes via OpenAI Whisper,
 * posts to the currently active text channel, monitors for replies,
 * and speaks them back via OpenAI TTS.
 * 
 * Voice commands:
 *   "switch to <agent/channel>" - change active text channel
 *   "go back" - switch to previous channel
 *   "repeat" - replay last TTS response
 *   "summarize" - ask the active agent to summarize
 */

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const prism = require('prism-media');
const path = require('path');

// ── Config ──────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const OPENAI_KEY = process.env.LLM_API;
const STT_ENDPOINT = process.env.STT_ENDPOINT || 'https://api.openai.com';
const STT_MODEL = process.env.STT_MODEL || 'whisper-1';
const TTS_ENDPOINT = process.env.OPENAI_TTS_ENDPOINT || 'https://api.openai.com';
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'onyx';
const WAIT_TIME = parseInt(process.env.WAIT_TIME || '1500');

// Channel map: friendly name → Discord text channel ID
// Update these with your actual channel IDs
const CHANNEL_MAP = {
  'pintas':   process.env.CHANNEL_PINTAS   || '',
  'general':  process.env.CHANNEL_PINTAS   || '',
  'wealth':   process.env.CHANNEL_WEALTH   || '',
  'webster':  process.env.CHANNEL_WEALTH   || '',
  'bob':      process.env.CHANNEL_BOB      || '',
  'builder':  process.env.CHANNEL_BOB      || '',
  'ward':     process.env.CHANNEL_WARD     || '',
  'sentinel': process.env.CHANNEL_WARD     || '',
  'erin':     process.env.CHANNEL_ERIN     || '',
  'council':  process.env.CHANNEL_COUNCIL  || '',
};

const DEFAULT_CHANNEL = process.env.CHANNEL_PINTAS || '';

// ── State ───────────────────────────────────────────────────
let activeChannelId = DEFAULT_CHANNEL;
let previousChannelId = DEFAULT_CHANNEL;
let lastTTSText = '';
let isProcessing = false;
let voiceConnection = null;
let monitoredBotIds = new Set(); // bot IDs we watch for replies
let lastMessageTimestamps = {}; // per-channel: last message we've seen
let audioQueue = [];
let currentAudioIndex = 0;

// ── Discord Client ──────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('ready', () => {
  console.log(`🕷️ Pintas Voice Bridge online as ${client.user.tag}`);
  console.log(`   Active channel: ${activeChannelId}`);
  console.log(`   Listening for voice in any channel I'm invited to join`);
});

// ── Monitor text channels for agent replies ─────────────────
client.on('messageCreate', async (message) => {
  // Ignore messages from this bot itself
  if (message.author.id === client.user.id) return;
  
  // Only listen to the active channel
  if (message.channel.id !== activeChannelId) return;
  
  // Only speak replies from bots (agents) — not from the human
  // (the human's voice is already in the voice channel)
  if (!message.author.bot) return;
  
  // Don't process while we're still handling a previous utterance
  // Actually, we DO want to pick up replies even while processing
  
  console.log(`📨 Reply from ${message.author.username} in active channel: ${message.content.substring(0, 100)}...`);
  
  // Speak the reply
  if (voiceConnection && message.content) {
    // Clean the message for TTS (remove markdown, links, etc.)
    let cleanText = message.content
      .replace(/```[\s\S]*?```/g, ' code block omitted ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
      .replace(/<[^>]+>/g, '')  // strip HTML/Discord tags
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** → bold
      .replace(/\*([^*]+)\*/g, '$1')  // *italic* → italic
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/#{1,3}\s/g, '')  // headers
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .trim();
    
    if (cleanText.length > 0) {
      lastTTSText = cleanText;
      await speakText(cleanText);
    }
  }
});

// ── Slash command: /join ─────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  
  if (interaction.commandName === 'join') {
    const member = interaction.member;
    if (!member.voice.channel) {
      await interaction.reply('You need to be in a voice channel!');
      return;
    }
    
    voiceConnection = joinVoiceChannel({
      channelId: member.voice.channelId,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    
    await interaction.reply(`🕷️ Joined voice! Bridging to <#${activeChannelId}>`);
    startListening();
  }
  
  if (interaction.commandName === 'switch') {
    const target = interaction.options.getString('channel');
    const result = switchChannel(target);
    await interaction.reply(result);
  }
  
  if (interaction.commandName === 'leave') {
    if (voiceConnection) {
      voiceConnection.destroy();
      voiceConnection = null;
      await interaction.reply('👋 Left voice channel.');
    } else {
      await interaction.reply('Not in a voice channel.');
    }
  }
});

// ── Voice command: also allow joining by text ────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const content = message.content.toLowerCase().trim();
  
  if (content === '>join' || content === '>j') {
    const member = message.member;
    if (!member?.voice?.channel) {
      await message.reply('You need to be in a voice channel!');
      return;
    }
    
    voiceConnection = joinVoiceChannel({
      channelId: member.voice.channelId,
      guildId: message.guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    
    await message.reply(`🕷️ Joined! Bridging voice ↔ <#${activeChannelId}>`);
    startListening();
  }
  
  if (content === '>leave' || content === '>l') {
    if (voiceConnection) {
      voiceConnection.destroy();
      voiceConnection = null;
      await message.reply('👋 Left voice channel.');
    }
  }
  
  if (content.startsWith('>switch ')) {
    const target = content.replace('>switch ', '').trim();
    const result = switchChannel(target);
    await message.reply(result);
  }
});

// ── Start listening to voice ────────────────────────────────
function startListening() {
  if (!voiceConnection) return;
  
  const receiver = voiceConnection.receiver;
  
  receiver.speaking.on('start', (userId) => {
    // Only listen to non-bots
    const member = voiceConnection.joinConfig.guildId; // we'll check later
    handleRecordingForUser(userId);
  });
}

// Track active recordings to avoid duplicates
const activeRecordings = new Set();

function handleRecordingForUser(userId) {
  if (activeRecordings.has(userId)) return;
  if (isProcessing) return; // don't record while processing/speaking
  
  activeRecordings.add(userId);
  
  const receiver = voiceConnection.receiver;
  const filePath = `./recordings/${userId}.pcm`;
  const writeStream = fs.createWriteStream(filePath);
  
  const listenStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: WAIT_TIME,
    },
  });
  
  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 1,
    rate: 48000,
  });
  
  listenStream.pipe(opusDecoder).pipe(writeStream);
  
  writeStream.on('finish', () => {
    activeRecordings.delete(userId);
    convertAndTranscribe(filePath, userId);
  });
  
  listenStream.on('error', (err) => {
    console.error(`Recording error for ${userId}:`, err.message);
    activeRecordings.delete(userId);
  });
}

// ── Convert PCM → MP3 → Whisper STT ────────────────────────
function convertAndTranscribe(pcmPath, userId) {
  const mp3Path = pcmPath.replace('.pcm', '.mp3');
  
  ffmpeg(pcmPath)
    .inputFormat('s16le')
    .audioChannels(1)
    .audioFrequency(48000)
    .format('mp3')
    .on('error', (err) => {
      console.error(`FFmpeg error: ${err.message}`);
    })
    .save(mp3Path)
    .on('end', () => {
      transcribeAudio(mp3Path, userId);
    });
}

async function transcribeAudio(mp3Path, userId) {
  const formData = new FormData();
  formData.append('model', STT_MODEL);
  formData.append('file', fs.createReadStream(mp3Path));
  
  try {
    const response = await axios.post(`${STT_ENDPOINT}/v1/audio/transcriptions`, formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
    });
    
    const text = response.data.text?.trim();
    
    // Cleanup files
    try { fs.unlinkSync(mp3Path); } catch {}
    try { fs.unlinkSync(mp3Path.replace('.mp3', '.pcm')); } catch {}
    
    if (!text || text.length < 2) {
      console.log('(empty/short transcription, ignoring)');
      return;
    }
    
    console.log(`🎤 [${userId}]: ${text}`);
    
    // Check for voice commands first
    const handled = await handleVoiceCommand(text, userId);
    if (!handled) {
      // Not a command — forward to the active text channel
      await forwardToChannel(text, userId);
    }
    
  } catch (error) {
    console.error(`STT error: ${error.message}`);
  }
}

// ── Voice commands ──────────────────────────────────────────
async function handleVoiceCommand(text, userId) {
  const lower = text.toLowerCase();
  
  // Switch channel
  const switchMatch = lower.match(/(?:switch to|talk to|go to)\s+(\w+)/);
  if (switchMatch) {
    const target = switchMatch[1];
    const result = switchChannel(target);
    await speakText(result);
    return true;
  }
  
  // Go back
  if (lower.includes('go back') || lower.includes('previous channel')) {
    const temp = activeChannelId;
    activeChannelId = previousChannelId;
    previousChannelId = temp;
    const channelName = getChannelName(activeChannelId);
    await speakText(`Switched back to ${channelName}`);
    return true;
  }
  
  // Repeat
  if (lower === 'repeat' || lower === 'repeat that' || lower === 'say that again') {
    if (lastTTSText) {
      await speakText(lastTTSText);
    } else {
      await speakText("Nothing to repeat yet.");
    }
    return true;
  }
  
  // Summarize — forward as a command to the active channel
  if (lower === 'summarize' || lower === 'give me a summary') {
    await forwardToChannel('Please give me a brief summary of our recent conversation.', userId);
    return true;
  }
  
  return false;
}

// ── Channel switching ───────────────────────────────────────
function switchChannel(target) {
  const lower = target.toLowerCase();
  const channelId = CHANNEL_MAP[lower];
  
  if (!channelId) {
    const available = [...new Set(Object.entries(CHANNEL_MAP).filter(([k,v]) => v).map(([k]) => k))].join(', ');
    return `I don't know "${target}". Available: ${available}`;
  }
  
  previousChannelId = activeChannelId;
  activeChannelId = channelId;
  return `🔀 Switched to ${target}. Voice is now bridged to that channel.`;
}

function getChannelName(channelId) {
  for (const [name, id] of Object.entries(CHANNEL_MAP)) {
    if (id === channelId) return name;
  }
  return 'unknown';
}

// ── Forward transcription to active text channel ────────────
async function forwardToChannel(text, userId) {
  if (!activeChannelId) {
    console.error('No active channel set!');
    return;
  }
  
  try {
    const channel = await client.channels.fetch(activeChannelId);
    if (!channel) {
      console.error(`Could not fetch channel ${activeChannelId}`);
      return;
    }
    
    // Post the transcription. Use a voice emoji to indicate it came from voice.
    await channel.send(`🎤 ${text}`);
    console.log(`📤 Forwarded to #${channel.name}: ${text}`);
    
  } catch (error) {
    console.error(`Failed to forward to channel: ${error.message}`);
  }
}

// ── TTS: text → speech → play in voice channel ─────────────
async function speakText(text) {
  if (!voiceConnection) return;
  
  isProcessing = true;
  
  // Split into chunks at sentence boundaries (max 200 words per chunk)
  const chunks = splitIntoChunks(text, 60);
  audioQueue = [];
  currentAudioIndex = 0;
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      const response = await axios.post(`${TTS_ENDPOINT}/v1/audio/speech`, {
        model: TTS_MODEL,
        input: chunks[i],
        voice: TTS_VOICE,
        response_format: 'mp3',
        speed: 1.0,
      }, {
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
        responseType: 'arraybuffer',
      });
      
      const filename = `./sounds/tts_${i}.mp3`;
      fs.writeFileSync(filename, Buffer.from(response.data));
      audioQueue.push({ file: filename, index: i });
      
      // Start playing as soon as first chunk is ready
      if (i === 0) {
        playAudioQueue();
      }
    } catch (error) {
      console.error(`TTS error: ${error.message}`);
    }
  }
}

function splitIntoChunks(text, maxWords) {
  const words = text.split(' ');
  const chunks = [];
  const punctuation = ['.', '!', '?', ';', ':'];
  
  for (let i = 0; i < words.length;) {
    let end = Math.min(i + maxWords, words.length);
    if (end < words.length) {
      let lastPunct = -1;
      for (let j = i; j < end; j++) {
        if (punctuation.includes(words[j].slice(-1))) lastPunct = j;
      }
      if (lastPunct > i) end = lastPunct + 1;
    }
    chunks.push(words.slice(i, end).join(' '));
    i = end;
  }
  return chunks;
}

async function playAudioQueue() {
  audioQueue.sort((a, b) => a.index - b.index);
  
  while (audioQueue.length > 0) {
    const audio = audioQueue.find(a => a.index === currentAudioIndex);
    if (audio) {
      await new Promise((resolve, reject) => {
        const player = createAudioPlayer();
        const resource = createAudioResource(audio.file);
        voiceConnection.subscribe(player);
        player.play(resource);
        
        player.on(AudioPlayerStatus.Idle, () => {
          try { fs.unlinkSync(audio.file); } catch {}
          audioQueue = audioQueue.filter(a => a.index !== currentAudioIndex);
          currentAudioIndex++;
          resolve();
        });
        
        player.on('error', (err) => {
          console.error(`Audio error: ${err.message}`);
          currentAudioIndex++;
          resolve();
        });
      });
    } else {
      // Wait for chunk to arrive
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  isProcessing = false;
  currentAudioIndex = 0;
  audioQueue = [];
  console.log('🔇 Finished speaking.');
}

// ── Register slash commands ─────────────────────────────────
client.once('ready', async () => {
  const { REST, Routes } = require('discord.js');
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  
  const commands = [
    {
      name: 'join',
      description: 'Join your voice channel and start the voice bridge',
    },
    {
      name: 'leave', 
      description: 'Leave the voice channel',
    },
    {
      name: 'switch',
      description: 'Switch the active text channel',
      options: [{
        name: 'channel',
        description: 'Agent/channel name (pintas, wealth, bob, ward, erin)',
        type: 3, // STRING
        required: true,
      }],
    },
  ];
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
});

// ── Start ───────────────────────────────────────────────────
client.login(TOKEN);
