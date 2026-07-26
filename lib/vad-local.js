/**
 * Local Voice Activity Detection (VAD) Module
 * 
 * Uses Silero VAD model running locally via ONNX Runtime
 * No external API calls - everything runs on the server
 */

import { MicVAD } from '@ricky0123/vad-node';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const dataDir = path.join(process.cwd(), 'data');

// Ensure data directory exists
const ensureDataDir = async () => {
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }
};

/**
 * Convert audio file to 16kHz mono WAV for VAD processing
 * @param {string} audioPath - Path to input audio file
 * @returns {Promise<Buffer>} - Audio buffer ready for VAD
 */
const prepareAudioForVAD = async (audioPath) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    
    ffmpeg(audioPath)
      .toFormat('s16le') // 16-bit signed PCM
      .audioFrequency(16000) // 16kHz sample rate
      .audioChannels(1) // Mono
      .on('error', (err) => reject(err))
      .pipe()
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', (err) => reject(err));
  });
};

/**
 * Run local VAD on audio file
 * 
 * @param {string} audioPath - Path to audio file
 * @param {object} options - VAD configuration
 * @param {number} options.threshold - Speech probability threshold (0-1, default: 0.5)
 * @param {number} options.frameDuration - Frame duration in ms (default: 30ms)
 * @param {number} options.minSilenceDuration - Min silence duration to split utterances (ms, default: 500)
 * @param {number} options.minSpeechDuration - Min speech duration to keep (ms, default: 250)
 * @param {string} options.videoId - Video ID for saving results
 * @returns {Promise<Array<{start: number, end: number}>>} - Utterance segments
 */
export async function runLocalVAD(audioPath, options = {}) {
  const {
    threshold = 0.5,
    frameDuration = 30,
    minSilenceDuration = 500,
    minSpeechDuration = 250,
    videoId = 'unknown'
  } = options;

  try {
    await ensureDataDir();
    
    console.log(`[LOCAL VAD] Processing audio file: ${audioPath}`);
    console.log(`[LOCAL VAD] Config: threshold=${threshold}, frameDuration=${frameDuration}ms`);
    
    // Prepare audio (convert to 16kHz mono if needed)
    console.log('[LOCAL VAD] Converting audio to 16kHz mono...');
    const audioBuffer = await prepareAudioForVAD(audioPath);
    
    // Convert buffer to Float32Array (required by VAD)
    const samples = new Int16Array(audioBuffer.buffer);
    const floatSamples = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      floatSamples[i] = samples[i] / 32768.0; // Normalize to [-1, 1]
    }
    
    // Initialize VAD model
    console.log('[LOCAL VAD] Loading Silero VAD model...');
    const vad = await MicVAD.new({
      positiveSpeechThreshold: threshold,
      negativeSpeechThreshold: threshold - 0.15,
      minSpeechFrames: Math.floor(minSpeechDuration / frameDuration),
      preSpeechPadFrames: Math.floor(250 / frameDuration), // 250ms padding before speech
      redemptionFrames: Math.floor(minSilenceDuration / frameDuration),
      frameSamples: Math.floor((16000 * frameDuration) / 1000), // samples per frame at 16kHz
      submitUserSpeechOnPause: true,
    });
    
    // Process audio in chunks (simulate streaming)
    const chunkSize = 512; // Process 512 samples at a time
    const utterances = [];
    let currentUtterance = null;
    
    console.log('[LOCAL VAD] Processing audio with sliding window...');
    
    // Process audio frame by frame
    for (let i = 0; i < floatSamples.length; i += chunkSize) {
      const chunk = floatSamples.slice(i, Math.min(i + chunkSize, floatSamples.length));
      
      // Process chunk with VAD
      const result = await vad.processAudio(chunk);
      
      if (result?.isSpeech) {
        const timestamp = (i / 16000); // Convert sample index to seconds
        
        if (!currentUtterance) {
          // Speech started
          currentUtterance = {
            start: timestamp,
            end: timestamp
          };
        } else {
          // Update end time
          currentUtterance.end = timestamp;
        }
      } else if (currentUtterance) {
        // Speech ended
        const duration = currentUtterance.end - currentUtterance.start;
        
        // Only keep utterances longer than minimum duration
        if (duration >= minSpeechDuration / 1000) {
          utterances.push({
            start: Number(currentUtterance.start.toFixed(3)),
            end: Number(currentUtterance.end.toFixed(3))
          });
        }
        
        currentUtterance = null;
      }
    }
    
    // Close the last utterance if still open
    if (currentUtterance) {
      const duration = currentUtterance.end - currentUtterance.start;
      if (duration >= minSpeechDuration / 1000) {
        utterances.push({
          start: Number(currentUtterance.start.toFixed(3)),
          end: Number(currentUtterance.end.toFixed(3))
        });
      }
    }
    
    // Clean up VAD instance
    vad.destroy();
    
    console.log(`[LOCAL VAD] Detected ${utterances.length} speech segments`);
    
    // Save results to data/vad_segments.json
    const outputPath = path.join(dataDir, `${videoId}_vad_segments.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      audio_file: audioPath,
      config: {
        threshold,
        frameDuration,
        minSilenceDuration,
        minSpeechDuration
      },
      total_segments: utterances.length,
      utterances: utterances,
      metadata: {
        model: 'silero-vad-local',
        sample_rate: 16000,
        processed_at: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[LOCAL VAD] Results saved to: ${outputPath}`);
    
    return utterances;
    
  } catch (error) {
    console.error('[LOCAL VAD] Error:', error);
    throw new Error(`Local VAD processing failed: ${error.message}`);
  }
}

/**
 * Apply VAD segments to create cleaned audio
 * (Only keeps audio segments where speech was detected)
 * 
 * @param {string} audioPath - Path to original audio
 * @param {Array<{start: number, end: number}>} utterances - VAD segments
 * @param {string} outputPath - Path for output audio
 * @returns {Promise<string>} - Path to cleaned audio
 */
export async function applyVADSegments(audioPath, utterances, outputPath) {
  return new Promise((resolve, reject) => {
    if (utterances.length === 0) {
      reject(new Error('No speech segments detected'));
      return;
    }
    
    console.log(`[LOCAL VAD] Creating cleaned audio with ${utterances.length} segments...`);
    
    // Build ffmpeg filter to keep only speech segments
    // For simplicity, we'll concatenate all speech segments
    const filterComplex = utterances.map((utt, idx) => {
      return `[0:a]atrim=start=${utt.start}:end=${utt.end},asetpts=PTS-STARTPTS[a${idx}]`;
    }).join(';');
    
    const concatFilter = utterances.map((_, idx) => `[a${idx}]`).join('') + `concat=n=${utterances.length}:v=0:a=1[out]`;
    
    ffmpeg(audioPath)
      .complexFilter([filterComplex, concatFilter].join(';'))
      .outputOptions(['-map', '[out]'])
      .output(outputPath)
      .on('end', () => {
        console.log(`[LOCAL VAD] Cleaned audio saved to: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('[LOCAL VAD] FFmpeg error:', err);
        reject(err);
      })
      .run();
  });
}
