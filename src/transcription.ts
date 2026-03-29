import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'whisper-1',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

function execAsync(
  bin: string,
  args: string[],
  timeout = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function whisperAvailable(): Promise<{
  bin: string;
  model: string;
} | null> {
  const env = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL']);
  const bin = env.WHISPER_BIN || 'whisper-cli';
  const model = env.WHISPER_MODEL || 'data/models/ggml-base.bin';

  if (!fs.existsSync(model)) return null;

  try {
    await execAsync(bin, ['--help'], 5000);
    return { bin, model };
  } catch {
    return null;
  }
}

async function transcribeWithWhisper(
  audioBuffer: Buffer,
): Promise<string | null> {
  const whisper = await whisperAvailable();
  if (!whisper) return null;

  const tmp = os.tmpdir();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const oggPath = path.join(tmp, `voice-${id}.ogg`);
  const wavPath = path.join(tmp, `voice-${id}.wav`);

  try {
    fs.writeFileSync(oggPath, audioBuffer);

    // Convert to 16kHz mono WAV (whisper.cpp requirement)
    await execAsync('ffmpeg', [
      '-i',
      oggPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      wavPath,
      '-y',
    ]);

    const stdout = await execAsync(whisper.bin, [
      '-m',
      whisper.model,
      '-f',
      wavPath,
      '--no-timestamps',
      '-nt',
    ]);

    const transcript = stdout.trim();
    if (!transcript) return null;

    logger.info('Transcribed voice message with whisper.cpp');
    return transcript;
  } catch (err) {
    logger.warn({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    try {
      fs.unlinkSync(oggPath);
    } catch {}
    try {
      fs.unlinkSync(wavPath);
    } catch {}
  }
}

async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set in .env');
    return null;
  }

  try {
    const openaiModule = await import('openai');
    const OpenAI = openaiModule.default;
    const toFile = openaiModule.toFile;

    const openai = new OpenAI({ apiKey });

    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });

    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: config.model,
      response_format: 'text',
    });

    // When response_format is 'text', the API returns a plain string
    return transcription as unknown as string;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    logger.info(`Downloaded audio message: ${buffer.length} bytes`);

    // Try local whisper.cpp first, fall back to OpenAI
    const transcript =
      (await transcribeWithWhisper(buffer)) ??
      (await transcribeWithOpenAI(buffer, config));

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
