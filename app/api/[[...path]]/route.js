import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import ffmpeg from 'fluent-ffmpeg';

// Generate timestamp-based ID
const generateTimestampId = () => {
  return `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// Use system ffmpeg (must be installed on the system)
// Install with: apt-get install ffmpeg (Linux) or brew install ffmpeg (Mac)
ffmpeg.setFfmpegPath('ffmpeg'); // Uses system PATH

// Initialize Groq client for Whisper transcription
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ============================================================================
// SILERO VAD IMPLEMENTATION (Direct ONNX - No Wrappers)
// ============================================================================

let sileroSession = null;

async function loadSilero() {
  if (sileroSession) return sileroSession;

  const fs = await import('fs');
  const ort = await import('onnxruntime-node');
  const path = await import('path');

  const modelPath = path.join(process.cwd(), 'public/silero_vad.onnx');
  sileroSession = await ort.InferenceSession.create(
    fs.readFileSync(modelPath)
  );
  console.log('[VAD] Silero model loaded');
  return sileroSession;
}

function frameAudio(audio, frameSize = 512) {
  const frames = [];
  for (let i = 0; i < audio.length; i += frameSize) {
    let frame = audio.slice(i, i + frameSize);
    if (frame.length < frameSize) {
      const padded = new Float32Array(frameSize);
      padded.set(frame);
      frame = padded;
    }
    frames.push(frame);
  }
  return frames;
}

async function getVadProbs(audio, sampleRate = 16000) {
  const session = await loadSilero();
  const frames = frameAudio(audio, 512);
  const probs = [];
  const ort = await import('onnxruntime-node');

  // Initialize hidden and cell states (2, 1, 64) - shape for Silero VAD LSTM
  let h = new ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);
  let c = new ort.Tensor("float32", new Float32Array(2 * 1 * 64), [2, 1, 64]);

  for (const frame of frames) {
    const input = new ort.Tensor("float32", frame, [1, frame.length]);
    const sr = new ort.Tensor("int64", [sampleRate], []);

    const outputs = await session.run({
      input,
      sr,
      h,
      c
    });

    probs.push(outputs.output.data[0]); // speech probability

    // Update hidden and cell states for next frame
    h = outputs.hn;
    c = outputs.cn;
  }

  return probs;
}

function probsToSegments(probs, threshold = 0.5, frameDuration = 0.032) {
  const segments = [];
  let active = false;
  let start = 0;

  probs.forEach((p, i) => {
    if (p > threshold && !active) {
      active = true;
      start = i * frameDuration;
    } else if (p <= threshold && active) {
      segments.push({ start, end: i * frameDuration });
      active = false;
    }
  });

  if (active) {
    segments.push({ start, end: probs.length * frameDuration });
  }

  return segments;
}

async function runSileroVAD(audioFloat32, sampleRate) {
  const probs = await getVadProbs(audioFloat32, sampleRate);
  let segments = probsToSegments(probs, 0.5, 512 / sampleRate);

  // GUARDRAIL: Never return zero segments - fallback to full duration
  if (segments.length === 0) {
    console.warn("[VAD] No speech detected, falling back to full duration");
    const audioDuration = audioFloat32.length / sampleRate;
    return [{ start: 0, end: audioDuration }];
  }

  // Apply tolerances for more natural cuts
  segments = applyVADTolerances(segments, audioFloat32.length / sampleRate);

  return segments;
}

// Apply tolerances to make VAD cuts look more natural
function applyVADTolerances(segments, totalDuration) {
  const TOLERANCES = {
    preSpeech: 0.3,      
    postSpeech: 0.5,     // Increased slightly to prevent mid-sentence cutting
    minSegment: 1.5,     // Your new setting: Ignores everything under 1.5s
    maxGap: 3.0          // Increased: Joins segments together unless there is 3s of silence
};

  let processedSegments = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Skip segments that are too short
    if (segment.end - segment.start < TOLERANCES.minSegment) {
      console.log(`[VAD] Skipping segment too short: ${segment.end - segment.start}s`);
      continue;
    }

    // Apply pre/post speech padding
    let start = Math.max(0, segment.start - TOLERANCES.preSpeech);
    let end = Math.min(totalDuration, segment.end + TOLERANCES.postSpeech);

    // Check if this segment can be merged with the previous one
    if (processedSegments.length > 0) {
      const prevSegment = processedSegments[processedSegments.length - 1];
      const gap = start - prevSegment.end;

      if (gap < TOLERANCES.maxGap) {
        // Merge segments
        prevSegment.end = end;
        console.log(`[VAD] Merged segments (gap: ${gap.toFixed(2)}s)`);
        continue;
      }
    }

    processedSegments.push({ start, end });
  }

  console.log(`[VAD] Applied tolerances: ${segments.length} → ${processedSegments.length} segments`);

  // Final guardrail: if all segments were filtered out, return full duration
  if (processedSegments.length === 0) {
    console.warn("[VAD] All segments filtered out, falling back to full duration");
    return [{ start: 0, end: totalDuration }];
  }

  return processedSegments;
}

// Initialize OpenAI client for text generation (direct OpenAI)
const openaiText = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 120000, // 2 minutes timeout
  maxRetries: 2,
});

// In-memory storage
const videos = new Map();
const processingQueue = new Map();

// Ensure uploads and data directories exist
const uploadsDir = path.join(process.cwd(), 'uploads');
const dataDir = path.join(process.cwd(), 'data');

const ensureUploadsDir = async () => {
  if (!existsSync(uploadsDir)) {
    await mkdir(uploadsDir, { recursive: true });
  }
};

const ensureDataDir = async () => {
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }
};

// Format seconds to MM:SS or HH:MM:SS
const formatTimestamp = (seconds) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// Extract audio from video with compression (WAV format)
const extractAudio = (videoPath, audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec('pcm_s16le')    // WAV codec
      .audioBitrate('32k')         // 32kbps bitrate
      .audioFrequency(16000)       // 16kHz sample rate
      .audioChannels(1)            // Mono
      .format('wav')
      .on('end', () => resolve(audioPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

// Run VAD - Voice Activity Detection and cut long silences
// Returns: [cleanedVideoPath, cleanedAudioPath]
const runVAD = async (audioPath, videoPath, videoId) => {
  try {
    console.log(`[VAD] Running Voice Activity Detection for video ${videoId}...`);

    // Ensure data directory exists
    await ensureDataDir();

    const fs = await import('fs');
    const path = await import('path');
    const { decode } = await import('wav-decoder');

    // Read and decode WAV file
    const buffer = await fs.promises.readFile(audioPath);
    const decoded = await decode(buffer);
    const channelData = decoded.channelData[0]; // Mono channel
    const sampleRate = decoded.sampleRate;

    console.log(`[VAD] Audio info: ${sampleRate}Hz, ${channelData.length} samples`);

    // Run Silero VAD directly
    const segments = await runSileroVAD(channelData, sampleRate);
    
    console.log(`[VAD] Detected ${segments.length} speech segments`);

    // Save VAD timestamps
    const vadOutputPath = path.join(dataDir, `${videoId}_vad_timestamps.json`);
    await writeFile(vadOutputPath, JSON.stringify({
      video_id: videoId,
      sample_rate: sampleRate,
      total_segments: segments.length,
      segments: segments.map((seg, idx) => ({
        id: idx + 1,
        start: parseFloat(seg.start.toFixed(3)),
        end: parseFloat(seg.end.toFixed(3)),
        duration: parseFloat((seg.end - seg.start).toFixed(3))
      }))
    }, null, 2));
    
    console.log(`[VAD] Saved VAD timestamps to ${vadOutputPath}`);

    // Step 3: Cut long silences (>3 seconds) from video
    const cleanedVideoPath = await cutLongSilences(videoPath, segments, videoId);

    // Return paths: [cleanedVideoPath, audioPathToUse]
    if (cleanedVideoPath !== videoPath) {
      // Extract audio from cleaned video for transcription
      const cleanedAudioPath = path.join(uploadsDir, `${videoId}_cleaned_audio.wav`);
      console.log(`[VAD] Extracting audio from cleaned video...`);
      await extractAudio(cleanedVideoPath, cleanedAudioPath);
      return [cleanedVideoPath, cleanedAudioPath];
    }

    // Return original paths if no cleaning was done
    return [videoPath, audioPath];
    
  } catch (error) {
    console.error('[VAD] Error:', error);
    console.log('[VAD] Falling back to using original audio without VAD');
    return [videoPath, audioPath];
  }
};

// Split audio into chunks for large files (smaller chunks to stay under 25MB)
const splitAudio = (inputPath, chunkDuration = 600) => { // Reduced from 900 to 600 seconds (10 minutes)
  return new Promise((resolve, reject) => {
    const outputPattern = inputPath.replace('.wav', '_chunk_%03d.wav');

    ffmpeg(inputPath)
      .outputOptions([
        `-f segment`,
        `-segment_time ${chunkDuration}`,
        `-c copy`
      ])
      .output(outputPattern)
      .on('end', () => {
        // Find all chunk files
        const fs = require('fs');
        const path = require('path');
        const dir = path.dirname(inputPath);
        const basename = path.basename(inputPath, '.wav');
        const chunks = fs.readdirSync(dir)
          .filter(f => f.startsWith(basename + '_chunk_'))
          .map(f => path.join(dir, f))
          .sort();
        resolve(chunks);
      })
      .on('error', reject)
      .run();
  });
};

// Transcribe audio using Groq Whisper with chunking support
const transcribeWithWhisper = async (audioFilePath) => {
  try {
    const fs = await import('fs');

    // Check file size (Groq Whisper limit is 25MB)
    const stats = await fs.promises.stat(audioFilePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`[Groq] Audio file size: ${fileSizeMB.toFixed(2)}MB`);

    // If file is larger than 20MB, split into chunks
    if (fileSizeMB > 20) {
      // Calculate chunk duration to ensure each chunk is under 20MB
      // Assuming ~2MB per minute for WAV audio, target 15MB chunks max
      const estimatedMBPerMinute = fileSizeMB / (stats.size / (16000 * 2 * 60)); // Rough estimate
      const targetChunkMB = 15; // Keep chunks under 15MB to be safe
      const chunkDurationSeconds = Math.floor((targetChunkMB / estimatedMBPerMinute) * 60);

      console.log(`[Groq] File too large (${fileSizeMB.toFixed(2)}MB), splitting into ${chunkDurationSeconds}-second chunks...`);
      const chunks = await splitAudio(audioFilePath, Math.max(300, chunkDurationSeconds)); // Min 5 minutes
      console.log(`[Groq] Created ${chunks.length} chunks`);

      // Verify chunk sizes before uploading
      for (let i = 0; i < chunks.length; i++) {
        const chunkStats = await fs.promises.stat(chunks[i]);
        const chunkSizeMB = chunkStats.size / (1024 * 1024);
        if (chunkSizeMB > 20) {
          console.log(`[Groq] Chunk ${i + 1} is still too large (${chunkSizeMB.toFixed(2)}MB), skipping...`);
          continue; // Skip this chunk or could split further
        }
        console.log(`[Groq] Chunk ${i + 1} size: ${chunkSizeMB.toFixed(2)}MB`);
      }
      
      let allText = '';
      let allSegments = [];
      let timeOffset = 0;
      
      for (let i = 0; i < chunks.length; i++) {
        try {
          // Check chunk size before attempting upload
          const chunkStats = await fs.promises.stat(chunks[i]);
          const chunkSizeMB = chunkStats.size / (1024 * 1024);

          if (chunkSizeMB > 20) {
            console.log(`[Groq] Chunk ${i + 1} too large (${chunkSizeMB.toFixed(2)}MB), skipping...`);
            timeOffset += 600; // Still update offset
            await fs.promises.unlink(chunks[i]);
            continue;
          }

          console.log(`[Groq] Transcribing chunk ${i + 1}/${chunks.length}...`);
          const chunkStream = fs.createReadStream(chunks[i]);

          const transcription = await groq.audio.transcriptions.create({
            file: chunkStream,
            model: "whisper-large-v3",
            response_format: "verbose_json"
          });

          allText += transcription.text + ' ';

          // Adjust timestamps based on chunk position
          if (transcription.segments) {
            const adjustedSegments = transcription.segments.map(seg => ({
              ...seg,
              start: seg.start + timeOffset,
              end: seg.end + timeOffset
            }));
            allSegments.push(...adjustedSegments);
          }

          // Update time offset for next chunk (10 minutes in seconds)
          timeOffset += 600;

        } catch (error) {
          console.log(`[Groq] Error transcribing chunk ${i + 1}: ${error.message}`);
          // Continue with other chunks but update time offset
          timeOffset += 600;
        }

        // Clean up chunk file
        try {
          await fs.promises.unlink(chunks[i]);
        } catch (cleanupError) {
          console.log(`[Groq] Warning: Could not clean up chunk ${i + 1}: ${cleanupError.message}`);
        }
      }
      
      console.log(`[Groq] Combined transcription complete. Text length: ${allText.length} chars`);
      
      return {
        text: allText.trim(),
        segments: allSegments
      };
    }
    
    // File is small enough, transcribe directly
    console.log(`[Groq] Starting transcription...`);
    const fileStream = fs.createReadStream(audioFilePath);
    
    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-large-v3",
      response_format: "verbose_json"
    });
    
    console.log(`[Groq] Transcription complete. Text length: ${transcription.text?.length || 0} chars`);
    
    return {
      text: transcription.text,
      segments: transcription.segments || []
    };
  } catch (error) {
    console.error('[Groq] Transcription error:', error);
    
    // More detailed error logging
    if (error.message?.includes('timeout')) {
      console.error('[Groq] Request timed out. Audio file might be too large or API is slow.');
    }
    if (error.status === 413) {
      console.error('[Groq] File too large for Groq Whisper API even after chunking.');
    }
    
    throw error;
  }
};

// Detect narrative moments using OpenAI LLM
const detectNarrativeMoments = async (transcript, videoId) => {
  try {
    // Prepare transcript with timestamps for LLM
    const transcriptWithTimestamps = transcript.segments
      .map(seg => `[${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s]: ${seg.text}`)
      .join('\n');
    
    // Save input for debugging
    const debugInputPath = path.join(uploadsDir, `${videoId}_narrative_input.json`);
    await writeFile(debugInputPath, JSON.stringify({
      fullText: transcript.text,
      segments: transcript.segments,
      timestampedTranscript: transcriptWithTimestamps
    }, null, 2));
    
    console.log(`Analyzing transcript for narrative moments (${transcript.segments.length} segments)...`);
    
    // Call OpenAI to identify narrative moments
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert video editor specializing in identifying compelling narrative moments for short-form content (reels, TikToks, YouTube Shorts).

Your task: Analyze a timestamped transcript and identify standalone narrative moments suitable for short-form reels.

Guidelines:
- Each moment should represent a single clear idea or story
- Must be understandable without extra context
- Exclude filler words, corrections, repeated attempts, and "um"s
- Prefer fewer, clean segments over many noisy ones
- Moments can vary in length (5s to 60s typically)
- Slight overlaps are acceptable if they improve narrative flow
- Focus on moments with strong hooks, emotional resonance, or clear value

For each moment, provide:
- start_time: timestamp in seconds (from original video)
- end_time: timestamp in seconds (from original video)
- core_idea: 1-2 sentence description of the moment
- energy: "high", "medium", or "low"
- story_type: one of: "high-energy", "reflective", "promotional", "fun", "educational", "inspirational", "random"
- confidence_score: 0.0 to 1.0 (how suitable is this for a reel?)
- hook_strength: 0.0 to 1.0 (how attention-grabbing is the opening?)

Return moments sorted by publish-worthiness (best first).`
        },
        {
          role: "user",
          content: `Analyze this transcript and identify narrative moments suitable for short-form reels:\n\n${transcriptWithTimestamps}\n\nReturn ONLY a valid JSON array of moments, with no additional text or markdown formatting.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    
    // Save raw LLM response for debugging
    const debugResponsePath = path.join(uploadsDir, `${videoId}_narrative_llm_response.json`);
    await writeFile(debugResponsePath, JSON.stringify({
      model: completion.model,
      usage: completion.usage,
      response: responseContent
    }, null, 2));
    
    // Parse the response
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseContent);
    } catch (parseError) {
      console.error('Failed to parse LLM response:', responseContent);
      throw new Error('Invalid JSON response from LLM');
    }
    
    // Extract moments array (handle different response structures)
    let moments = parsedResponse.moments || parsedResponse.narrative_moments || parsedResponse;
    
    // If moments is not an array, try to extract it
    if (!Array.isArray(moments)) {
      if (typeof moments === 'object') {
        // Look for any array property
        const arrayProps = Object.values(moments).filter(v => Array.isArray(v));
        if (arrayProps.length > 0) {
          moments = arrayProps[0];
        } else {
          moments = [];
        }
      } else {
        moments = [];
      }
    }
    
    // Validate and clean moments
    const validatedMoments = moments
      .filter(m => m.start_time !== undefined && m.end_time !== undefined)
      .map((moment, index) => ({
        id: index + 1,
        start_time: parseFloat(moment.start_time),
        end_time: parseFloat(moment.end_time),
        duration: parseFloat(moment.end_time) - parseFloat(moment.start_time),
        core_idea: moment.core_idea || moment.description || '',
        energy: moment.energy || 'medium',
        story_type: moment.story_type || moment.type || 'random',
        confidence_score: parseFloat(moment.confidence_score || moment.confidence || 0.7),
        hook_strength: parseFloat(moment.hook_strength || moment.hook || 0.5)
      }))
      .sort((a, b) => b.confidence_score - a.confidence_score); // Sort by confidence
    
    // Save final validated moments for debugging
    const debugOutputPath = path.join(uploadsDir, `${videoId}_narrative_moments.json`);
    await writeFile(debugOutputPath, JSON.stringify({
      total_moments: validatedMoments.length,
      moments: validatedMoments,
      metadata: {
        transcript_length: transcript.text.length,
        segments_count: transcript.segments.length,
        analysis_timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`Detected ${validatedMoments.length} narrative moments`);
    
    return validatedMoments;
  } catch (error) {
    console.error('Narrative detection error:', error);
    throw error;
  }
};

// Cut long silences (>3 seconds) from video and create cleaned version
const cutLongSilences = async (videoPath, segments, videoId) => {
  const path = await import('path');
  const fs = await import('fs');

  // If no segments or only one segment, return original video
  if (!segments || segments.length === 0) {
    console.log(`[VAD] No speech segments found, using original video`);
    return videoPath;
  }

  // Check if there are any long silences (>3 seconds)
  let hasLongSilences = false;
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].start - segments[i-1].end;
    if (gap > 1.0) {
      hasLongSilences = true;
      break;
    }
  }

  if (!hasLongSilences) {
    console.log(`[VAD] No long silences (>3s) found, using original video`);
    return videoPath;
  }

  console.log(`[VAD] Found long silences, creating cleaned video without fluff...`);

  // Create output path for cleaned video
  const outputPath = path.join(uploadsDir, `${videoId}_cleaned.mp4`);

  // For small number of segments, use optimized complex filter approach
  if (segments.length <= 10) {
    return createCleanedVideoComplexFilter(videoPath, segments, outputPath);
  } else {
    // For many segments, use segment-based approach (more memory efficient)
    return createCleanedVideoSegments(videoPath, segments, outputPath, videoId);
  }
};

// Optimized complex filter approach for fewer segments
const createCleanedVideoComplexFilter = (videoPath, segments, outputPath) => {
  // Build ffmpeg filter for concatenating speech segments
  const filterParts = [];
  let totalDuration = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const duration = segment.end - segment.start;

    filterParts.push(`[0:v]trim=${segment.start}:${segment.end},setpts=PTS-STARTPTS[av${i}]`);
    filterParts.push(`[0:a]atrim=${segment.start}:${segment.end},asetpts=PTS-STARTPTS[aa${i}]`);

    totalDuration += duration;
  }

  // Concatenate all segments
  const concatVideo = segments.map((_, i) => `[av${i}]`).join('');
  const concatAudio = segments.map((_, i) => `[aa${i}]`).join('');

  filterParts.push(`${concatVideo}concat=n=${segments.length}:v=1:a=0[vout]`);
  filterParts.push(`${concatAudio}concat=n=${segments.length}:v=0:a=1[aout]`);

  const filterComplex = filterParts.join(';');

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .complexFilter(filterComplex)
      .outputOptions([
        '-map [vout]',
        '-map [aout]',
        // Ultra-fast encoding for hackathon - sacrifice quality for speed
        '-c:v libx264',
        '-c:a aac',
        '-preset ultrafast',  // Much faster than 'fast'
        '-crf 28',           // Lower quality (higher number = lower quality)
        '-threads 0',        // Use all available CPU threads
        '-movflags +faststart', // Optimize for web playback
        // Skip B-frames for faster encoding
        '-bf 0',
        // Reduce keyframe interval for faster seeking
        '-keyint_min 30',
        '-g 30'
      ])
      .output(outputPath)
      .on('end', () => {
        console.log(`[VAD] Created cleaned video: ${outputPath} (${segments.length} segments, ${totalDuration.toFixed(1)}s total)`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[VAD] Error creating cleaned video:`, err);
        // Fallback to original video
        resolve(videoPath);
      })
      .run();
  });
};

// Segment-based approach for many segments (more memory efficient)
const createCleanedVideoSegments = async (videoPath, segments, outputPath, videoId) => {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { exec } = await import('child_process');
  const util = await import('util');
  const execAsync = util.promisify(exec);

  const tempDir = path.join(uploadsDir, `temp_${videoId}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    // Create individual segment files
    const segmentFiles = [];
    let totalDuration = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const duration = segment.end - segment.start;
      const segmentPath = path.join(tempDir, `segment_${i}.mp4`);
      segmentFiles.push(segmentPath);
      totalDuration += duration;

      // Extract segment with ultra-fast settings
      await execAsync(`ffmpeg -y -i "${videoPath}" -ss ${segment.start} -t ${duration} -c:v libx264 -preset ultrafast -crf 28 -c:a aac -avoid_negative_ts make_zero -threads 0 "${segmentPath}"`);
    }

    // Create concat file list
    const concatFile = path.join(tempDir, 'concat.txt');
    const concatContent = segmentFiles.map(file => `file '${file}'`).join('\n');
    await fs.writeFile(concatFile, concatContent);

    // Concatenate segments
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v copy -c:a copy -avoid_negative_ts make_zero -threads 0 "${outputPath}"`);

    console.log(`[VAD] Created cleaned video: ${outputPath} (${segments.length} segments, ${totalDuration.toFixed(1)}s total)`);
    return outputPath;

  } catch (error) {
    console.error(`[VAD] Error creating cleaned video with segments:`, error);
    // Fallback to original video
    return videoPath;
  } finally {
    // Clean up temp files (async, don't wait)
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

// ============================================================================
// AGENT REASONING PIPELINE (3 STAGES)
// ============================================================================

// STAGE 1: Extract clean idea units from transcript with editorial judgment
const extractIdeaUnits = async (transcript, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 1] Extracting idea units for video ${videoId}...`);
    
    // Prepare transcript with timestamps
    const transcriptWithTimestamps = transcript.segments
      .map(seg => `[${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s]: ${seg.text}`)
      .join('\n');
    
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a senior video editor with deep experience in short-form content. Your job is to identify publishable idea units from raw transcripts.

EDITORIAL MINDSET:
Think like an editor deciding what deserves to be a reel. Prefer fewer, stronger units over many weak ones. Merge redundant setups. Drop repetitive intros.

IDEA TYPES (assign ONE per unit):
- HOOK: Curiosity-driven opening or question that grabs attention
- CONCEPT: Defines what something is (clear definition)
- EXPLANATION: Describes how or why something works (process/mechanism)
- INSIGHT: Reveals a non-obvious takeaway or reframing (aha moment)
- CONCLUSION: Wrap-up or call-to-action (usually weakest for reels)

SCORING SYSTEM:
1. certainty_score (0.0 - 1.0): Is this idea complete and finalized?
   - 1.0 = Crystal clear, fully formed thought
   - 0.7 = Good but could be clearer
   - 0.5 = Somewhat vague or incomplete
   - 0.3 = Very rough or unclear

2. publishability_score (0.0 - 1.0): Can this work as a standalone reel?
   Consider:
   - Works without extra context
   - Has a clear point or takeaway
   - Likely to hold attention for 30–60 seconds
   - Short clips (<15s) should score lower unless extremely powerful.
   - 1.0 = Perfect reel material
   - 0.7 = Strong potential
   - 0.5 = Needs support but viable
   - 0.3 = Weak standalone value

CRITICAL RULES:
- MERGE adjacent segments expressing the same setup/intro
- EXCLUDE filler, retakes, false starts, "um/uh/like"
- EXCLUDE repeated attempts (keep only final version)
- Each unit must feel RESOLVED
- Quality over quantity: 5 great units > 20 mediocre ones
- Keep summaries short, neutral, no hallucinations

CRITICAL EDITORIAL CONSTRAINT (READ CAREFULLY):

A publishable idea unit is NOT a single sentence or claim.
A publishable idea unit is a MINI-NARRATIVE ARC.

Each idea unit SHOULD:
- Contain setup → explanation → payoff OR
- Contain claim → reasoning → implication
- Feel satisfying to watch for 20–60 seconds

DO NOT extract atomic thoughts if they rely on nearby explanation.
If an idea is introduced and then explained across multiple segments,
they MUST be included in the SAME idea unit.

Minimum target duration per idea unit:
- Aim for 20–60 seconds where possible
- Only allow <15s units if they are exceptionally punchy hooks

If an idea feels “too short to be a reel”, it is NOT a valid unit yet.
Extend the unit to include the explanation or conclusion.


OUTPUT FORMAT:
{
  "video_id": "string",
  "total_units": number,
  "idea_units": [
    {
      "idea_id": number,
      "start_time": number,
      "end_time": number,
      "duration": number,
      "idea_type": "HOOK|CONCEPT|EXPLANATION|INSIGHT|CONCLUSION",
      "cleaned_summary": "string",
      "certainty_score": number,
      "publishability_score": number
    }
  ]
}

Return ONLY valid JSON. No markdown, no additional text.`
        },
        {
          role: "user",
          content: `Extract publishable idea units from this transcript with editorial judgment:\n\n${transcriptWithTimestamps}\n\nApply the scoring system rigorously. Merge redundant setups. Return ONLY valid JSON.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    const parsed = JSON.parse(responseContent);
    const ideaUnits = parsed.idea_units || parsed.ideas || [];
    
    if (!Array.isArray(ideaUnits)) {
      throw new Error('Invalid response format from LLM');
    }
    
    // Validate and clean idea units
    const validatedUnits = ideaUnits
      .filter(unit => unit.start_time !== undefined && unit.end_time !== undefined)
      .map((unit, index) => ({
        idea_id: index + 1,
        start_time: parseFloat(unit.start_time),
        end_time: parseFloat(unit.end_time),
        duration: parseFloat((unit.end_time - unit.start_time).toFixed(2)),
        idea_type: unit.idea_type || 'CONCEPT',
        cleaned_summary: unit.cleaned_summary || unit.summary || '',
        certainty_score: parseFloat(unit.certainty_score || 0.7),
        publishability_score: parseFloat(unit.publishability_score || 0.5)
      }));
    
    // Save to data/idea_units.json
    const outputPath = path.join(dataDir, `${videoId}_idea_units.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      total_units: validatedUnits.length,
      idea_units: validatedUnits,
      metadata: {
        stage: 1,
        model: completion.model,
        tokens_used: completion.usage.total_tokens,
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[STAGE 1] Extracted ${validatedUnits.length} idea units`);
    return validatedUnits;
  } catch (error) {
    console.error('[STAGE 1] Idea extraction error:', error);
    throw error;
  }
};

// STAGE 1.5: Delivery Quality Analysis
const analyzeDeliveryQuality = async (ideaUnits, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 1.5] Analyzing delivery quality for ${ideaUnits.length} idea units...`);
    
    // Load VAD timestamps
    const fs = await import('fs');
    const vadPath = path.join(dataDir, `${videoId}_vad_timestamps.json`);
    const transcriptPath = path.join(dataDir, `${videoId}_transcript.json`);
    
    let vadData, transcriptData;
    try {
      vadData = JSON.parse(await fs.promises.readFile(vadPath, 'utf-8'));
      transcriptData = JSON.parse(await fs.promises.readFile(transcriptPath, 'utf-8'));
    } catch (error) {
      console.error('[STAGE 1.5] Failed to load VAD or transcript data:', error);
      throw error;
    }
    
    const vadSegments = vadData.segments || [];
    const transcriptSegments = transcriptData.segments || [];
    
    // Process each idea unit
    let deliveryAnalysis = []; // FIX 1️⃣: Must be 'let' for reassignment during dedup
    
    for (const ideaUnit of ideaUnits) {
      try {
        const { idea_id, start_time, end_time } = ideaUnit;
        
        // Extract transcript text within the time range
        const relevantTranscript = transcriptSegments
          .filter(seg => {
            // Include segments that overlap with the idea unit time range
            return seg.start < end_time && seg.end > start_time;
          })
          .map(seg => seg.text)
          .join(' ');
        
        // Extract VAD segments within the time range
        const relevantVadSegments = vadSegments
          .filter(seg => {
            // Include segments that overlap with the idea unit time range
            return seg.start < end_time && seg.end > start_time;
          })
          .map(seg => ({
            start: Math.max(seg.start, start_time),
            end: Math.min(seg.end, end_time),
            duration: Math.min(seg.end, end_time) - Math.max(seg.start, start_time)
          }));
        
        // Calculate total speech time and pause structure
        const totalDuration = end_time - start_time;
        const totalSpeechTime = relevantVadSegments.reduce((sum, seg) => sum + seg.duration, 0);
        const speechRatio = totalDuration > 0 ? (totalSpeechTime / totalDuration) : 0;
        
        // Prepare data for LLM
        const vadSummary = `Speech segments (${relevantVadSegments.length}): ${relevantVadSegments.map(s => 
          `${s.start.toFixed(1)}s-${s.end.toFixed(1)}s (${s.duration.toFixed(1)}s)`
        ).join(', ')}`;
        
        // Call LLM for delivery evaluation
        const completion = await openaiText.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: `You are a senior video editor evaluating spoken delivery quality.
Judge how well the idea was delivered on camera, not the idea itself.
Be ruthless. Prefer rejecting weak delivery over being polite.
Do NOT rewrite or improve content. Judge only what was spoken.

DELIVERY EVALUATION CRITERIA:
1. Fluency: Are there stammering, repetitions, or false starts?
2. Coherence: Does it progress cleanly or have corrections?
3. Pause structure: Fragmented or natural?
4. Confidence: Decisive tone or uncertain?

SCORING (0.0 - 1.0):
- 1.0 = Clean, confident, clip-ready
- 0.8 = Minor issues, still usable
- 0.6 = Usable with trimming
- 0.4 = Poor delivery
- 0.2 = Very broken
- 0.0 = Unusable

FLAGS (only if applicable):
- STAMMERING: Noticeable stammering or stuttering
- REPETITION: Repeated words or phrases unnecessarily
- FRAGMENTED: Lots of short pauses, broken flow
- WEAK_START: Opening is hesitant or unclear
- WEAK_END: Ending trails off or is unclear

OUTPUT FORMAT:
{
  "idea_id": number,
  "delivery_score": number (0.0-1.0),
  "delivery_flags": ["FLAG1", "FLAG2", ...],
  "editor_note": "Brief explanation of score"
}

Return ONLY valid JSON. No markdown, no additional text.`
            },
            {
              role: "user",
              content: `Evaluate the delivery quality of this idea unit:

TIME RANGE: ${start_time.toFixed(1)}s - ${end_time.toFixed(1)}s (${totalDuration.toFixed(1)}s total)
SPEECH RATIO: ${(speechRatio * 100).toFixed(1)}% of time is speech

TRANSCRIPT TEXT:
"${relevantTranscript}"

VAD ANALYSIS:
${vadSummary}
Speech segments: ${relevantVadSegments.length}
Total speech time: ${totalSpeechTime.toFixed(1)}s

Judge ONLY the spoken delivery quality. Be ruthless about weak delivery. Return ONLY valid JSON.`
            }
          ],
          response_format: { type: "json_object" },
          temperature: 1
        });
        
        const responseContent = completion.choices[0].message.content;
        const parsed = JSON.parse(responseContent);
        
        // FIX 1️⃣: ENFORCE ID IN CODE - Never trust LLM for IDs
        // Always use idea_id from the loop, ignore any ID from LLM
        deliveryAnalysis.push({
          idea_id: idea_id, // ENFORCED: Use source ID, not LLM output
          delivery_score: parseFloat(parsed.delivery_score || 0.5),
          delivery_flags: Array.isArray(parsed.delivery_flags) ? parsed.delivery_flags : [],
          editor_note: parsed.editor_note || "Analyzed successfully"
        });
        
        console.log(`[STAGE 1.5] ✓ Idea ${idea_id}: delivery_score=${parsed.delivery_score}, flags=${parsed.delivery_flags?.length || 0}`);
        
      } catch (error) {
        console.error(`[STAGE 1.5] Failed to analyze idea ${ideaUnit.idea_id}:`, error);
        // FIX 1️⃣: Fail safely with enforced ID
        deliveryAnalysis.push({
          idea_id: ideaUnit.idea_id, // ENFORCED: Use source ID
          delivery_score: 0.5,
          delivery_flags: [],
          editor_note: "Failed to analyze delivery quality"
        });
      }
    }
    
    // FIX 1️⃣: Deduplicate by idea_id (defensive - shouldn't happen now)
    const deduped = {};
    deliveryAnalysis.forEach(entry => {
      if (!deduped[entry.idea_id] || entry.delivery_score > deduped[entry.idea_id].delivery_score) {
        deduped[entry.idea_id] = entry;
      }
    });
    deliveryAnalysis = Object.values(deduped);
    
    // Sort by delivery_score descending
    deliveryAnalysis.sort((a, b) => b.delivery_score - a.delivery_score);
    
    console.log(`[STAGE 1.5] ✓ Deduplicated: ${Object.keys(deduped).length} unique IDs`);
    
    // Save to file
    const outputPath = path.join(dataDir, `${videoId}_stage1_5_delivery.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      stage: "1.5",
      total_analyzed: deliveryAnalysis.length,
      delivery_analysis: deliveryAnalysis,
      metadata: {
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[STAGE 1.5] Analyzed ${deliveryAnalysis.length} units, saved to ${outputPath}`);
    return deliveryAnalysis;
    
  } catch (error) {
    console.error('[STAGE 1.5] Delivery analysis error:', error);
    throw error;
  }
};

// STAGE 1.75: Thought Continuity & Merge Engine
const mergeContinuousThoughts = async (ideaUnits, deliveryAnalysis, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 1.75] Merging continuous thoughts for ${ideaUnits.length} idea units...`);
    
    // Combine idea units with delivery scores
    const enrichedUnits = ideaUnits.map(unit => {
      const delivery = deliveryAnalysis.find(d => d.idea_id === unit.idea_id) || {
        delivery_score: 0.5,
        delivery_flags: [],
        editor_note: 'No delivery data'
      };
      
      return {
        idea_id: unit.idea_id,
        start_time: unit.start_time,
        end_time: unit.end_time,
        duration: unit.duration,
        idea_type: unit.idea_type,
        cleaned_summary: unit.cleaned_summary,
        certainty_score: unit.certainty_score,
        publishability_score: unit.publishability_score,
        delivery_score: delivery.delivery_score,
        delivery_flags: delivery.delivery_flags,
        delivery_note: delivery.editor_note
      };
    });
    
    // Sort by start_time
    enrichedUnits.sort((a, b) => a.start_time - b.start_time);
    
    // Prepare data for LLM with merge context
    const unitsWithGaps = enrichedUnits.map((unit, index) => {
      const nextUnit = enrichedUnits[index + 1];
      const timeGap = nextUnit ? (nextUnit.start_time - unit.end_time) : null;
      
      return {
        ...unit,
        time_gap_to_next: timeGap !== null ? parseFloat(timeGap.toFixed(2)) : null
      };
    });
    
    // Call LLM for merge analysis
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a senior video editor merging broken takes into clean thoughts.
Think like a human editor who's assembling the final cut.
Prefer fewer, stronger segments over many fragmented ones.
Be conservative: only merge when clearly the same thought.

MERGE RULES (ALL must apply):
1. Same idea_type OR logically continuous:
   - HOOK → CONCEPT (curiosity leads to definition)
   - CONCEPT → EXPLANATION (definition leads to how it works)
   - EXPLANATION → INSIGHT (process leads to takeaway)
   
2. Time gap ≤ 6 seconds OR delivery_score < 0.6 (poor delivery suggests fragmentation)

3. cleaned_summary refers to the same concept/topic (not introducing new ideas)

4. Second unit completes or extends the thought started earlier

DO NOT MERGE IF:
- Different core ideas (even if same type)
- New topic introduced
- One unit is a CONCLUSION or call-to-action
- Units are already high quality standalone (both delivery_score > 0.7)

MERGE STRATEGY:
- Look ahead: can unit N and N+1 be merged?
- Create merged_summary that captures the complete thought
- Assign confidence: how sure are you this merge makes sense? (0.0-1.0)
- Explain merge_reason briefly

EDITORIAL LENGTH HEURISTIC (IMPORTANT):

If two adjacent units together form a stronger 20–60 second narrative,
you SHOULD merge them even if each could stand alone.

Prefer merging when:
- One unit introduces an idea and the next explains or justifies it
- One unit feels like setup and the next feels like payoff
- The combined result would feel more satisfying than either alone

For hackathon/demo quality:
Bias slightly toward MERGING rather than keeping fragments separate,
as long as the topic remains coherent.

OUTPUT FORMAT:
{
  "video_id": "string",
  "merges": [
    {
      "merged_id": number (use lowest source idea_id),
      "source_idea_ids": [id1, id2, ...],
      "start_time": number (from first unit),
      "end_time": number (from last unit),
      "merged_summary": "Combined clean summary capturing complete thought",
      "confidence": number (0.0-1.0),
      "merge_reason": "Brief explanation of why these were merged"
    }
  ],
  "unmerged_ids": [ids that should remain standalone]
}

Return ONLY valid JSON. No markdown, no additional text.`
        },
        {
          role: "user",
          content: `Analyze these idea units and determine which should be merged:

${JSON.stringify(unitsWithGaps, null, 2)}

Apply the merge rules rigorously. Be conservative - only merge when clearly the same thought.
Return ONLY valid JSON with merges and unmerged_ids.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    const parsed = JSON.parse(responseContent);
    
    const merges = parsed.merges || [];
    const unmergedIds = parsed.unmerged_ids || [];
    
    // Helper function to calculate delivery_quality_score
    const calculateDeliveryQuality = (unit, sourceIds, deliveryFlags) => {
      // Start with base score
      let score = 1.0;
      
      // Penalty for merged segments (indicates fragmented delivery)
      const mergeCount = sourceIds.length;
      if (mergeCount > 1) {
        score -= Math.min(0.3, (mergeCount - 1) * 0.15); // -0.15 per extra segment, max -0.3
      }
      
      // Penalty for delivery flags
      const flags = deliveryFlags || [];
      if (flags.includes('STAMMERING')) score -= 0.2;
      if (flags.includes('REPETITION')) score -= 0.15;
      if (flags.includes('FRAGMENTED')) score -= 0.2;
      if (flags.includes('WEAK_START')) score -= 0.05;
      if (flags.includes('WEAK_END')) score -= 0.05;
      
      // Penalty for low delivery_score from Stage 1.5
      const deliveryScoreFromAnalysis = unit.delivery_score || 0.7;
      score = Math.min(score, deliveryScoreFromAnalysis + 0.1); // Cap at analysis score + 0.1
      
      // Clamp to 0.0 - 1.0
      return Math.max(0.0, Math.min(1.0, parseFloat(score.toFixed(2))));
    };
    
    // Build final merged units list
    const mergedUnits = [];
    
    // Add merged units
    merges.forEach((merge, index) => {
      const sourceIds = merge.source_idea_ids || [];
      const sourceUnits = sourceIds.map(id => enrichedUnits.find(u => u.idea_id === id)).filter(Boolean);
      const allFlags = sourceUnits.flatMap(u => u.delivery_flags || []);
      const avgDeliveryScore = sourceUnits.length > 0 
        ? sourceUnits.reduce((sum, u) => sum + (u.delivery_score || 0.5), 0) / sourceUnits.length 
        : 0.5;
      
      const deliveryQualityScore = calculateDeliveryQuality(
        { delivery_score: avgDeliveryScore },
        sourceIds,
        allFlags
      );
      
      mergedUnits.push({
        merged_id: merge.merged_id || (index + 1),
        source_idea_ids: sourceIds,
        start_time: parseFloat(merge.start_time),
        end_time: parseFloat(merge.end_time),
        duration: parseFloat((merge.end_time - merge.start_time).toFixed(2)),
        merged_summary: merge.merged_summary || '',
        confidence: parseFloat(merge.confidence || 0.5),
        merge_reason: merge.merge_reason || 'Merged continuous thought',
        is_merged: true,
        delivery_quality_score: deliveryQualityScore
      });
    });
    
    // Add unmerged units (keep original data)
    unmergedIds.forEach(id => {
      const originalUnit = enrichedUnits.find(u => u.idea_id === id);
      if (originalUnit) {
        const deliveryQualityScore = calculateDeliveryQuality(
          originalUnit,
          [originalUnit.idea_id],
          originalUnit.delivery_flags || []
        );
        
        mergedUnits.push({
          merged_id: originalUnit.idea_id,
          source_idea_ids: [originalUnit.idea_id],
          start_time: originalUnit.start_time,
          end_time: originalUnit.end_time,
          duration: originalUnit.duration,
          merged_summary: originalUnit.cleaned_summary,
          confidence: 1.0,
          merge_reason: 'Standalone unit - no merge needed',
          is_merged: false,
          // Preserve original metadata
          idea_type: originalUnit.idea_type,
          certainty_score: originalUnit.certainty_score,
          publishability_score: originalUnit.publishability_score,
          delivery_score: originalUnit.delivery_score,
          delivery_quality_score: deliveryQualityScore
        });
      }
    });
    
    // Sort by start_time
    mergedUnits.sort((a, b) => a.start_time - b.start_time);
    
    // FIX 1: Normalize to canonical_id (single source of truth)
    // From this point forward, ONLY canonical_id should be used
    mergedUnits.forEach(unit => {
      unit.canonical_id = unit.merged_id;
      delete unit.merged_id; // Prevent mixed usage
    });
    
    console.log(`[STAGE 1.75] ✓ Canonical IDs assigned: ${mergedUnits.map(u => u.canonical_id).join(', ')}`);
    console.log(`[GUARDRAIL] ✓ ID normalization complete - ${mergedUnits.length} units with canonical_id`);
    
    // Save to file
    const outputPath = path.join(dataDir, `${videoId}_stage1_75_merged.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      stage: "1.75",
      total_input_units: ideaUnits.length,
      total_merged_units: mergedUnits.length,
      merge_count: merges.length,
      merged_units: mergedUnits,
      metadata: {
        timestamp: new Date().toISOString(),
        merge_strategy: "conservative",
        model: completion.model,
        tokens_used: completion.usage.total_tokens
      }
    }, null, 2));
    
    console.log(`[STAGE 1.75] Merged ${ideaUnits.length} units → ${mergedUnits.length} final units (${merges.length} merges performed)`);
    console.log(`[STAGE 1.75] Saved to ${outputPath}`);
    
    return mergedUnits;
    
  } catch (error) {
    console.error('[STAGE 1.75] Merge engine error:', error);
    // Fail gracefully: return original units without merging
    console.log('[STAGE 1.75] Falling back to unmerged units');
    return ideaUnits.map(unit => ({
      merged_id: unit.idea_id,
      source_idea_ids: [unit.idea_id],
      start_time: unit.start_time,
      end_time: unit.end_time,
      duration: unit.duration,
      merged_summary: unit.cleaned_summary,
      confidence: 1.0,
      merge_reason: 'Merge failed - using original',
      is_merged: false,
      idea_type: unit.idea_type,
      certainty_score: unit.certainty_score,
      publishability_score: unit.publishability_score
    }));
  }
};



// STAGE 2: Rank idea units by publish-worthiness with editorial judgment
const rankPublishWorthiness = async (ideaUnits, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 2] Ranking publish-worthiness for ${ideaUnits.length} idea units...`);
    
    // FIX 1: Validate canonical_id exists (no idea_id allowed)
    ideaUnits.forEach((unit, idx) => {
      if (!unit.canonical_id) {
        throw new Error(`[STAGE 2] Unit ${idx} missing canonical_id - pipeline coordination failure`);
      }
      if (unit.idea_id || unit.merged_id) {
        throw new Error(`[STAGE 2] Unit ${idx} has idea_id/merged_id - must use canonical_id only`);
      }
    });
    
    // FIX 3: Remove silent fallbacks - throw if critical data missing
    // FIX 4: Delivery quality must be first-class signal
    const unitsForRanking = ideaUnits.map(unit => {
      if (!unit.delivery_quality_score) {
        throw new Error(`[STAGE 2] Unit ${unit.canonical_id} missing delivery_quality_score`);
      }
      
      return {
        canonical_id: unit.canonical_id,
        idea_type: unit.idea_type,
        duration: unit.duration.toFixed(1) + 's',
        summary: unit.merged_summary || unit.cleaned_summary,
        certainty: unit.certainty_score,
        publishability: unit.publishability_score,
        delivery_quality: unit.delivery_quality_score
      };
    });
    
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a ruthless content director curating this week's reel lineup. Your job is to pick winners and cut losers.

EDITORIAL MINDSET:
Think like a human editor deciding what gets posted this week. Be opinionated. Use the full 0-100 range. Avoid clustering scores in the 50-70 zone.

SCORE DISTRIBUTION RULES (ENFORCE STRICTLY):
- Only 1-2 ideas may score ≥ 80 (flagship content)
- Only 2-3 ideas may score < 40 (clear discards)
- Spread the rest across the full range
- If multiple ideas say the same thing, rank only the strongest one highly

CONTENT ROLE ASSIGNMENT:
Based on publish_score, assign ONE role:

80-100 → PRIMARY_REEL (flagship content, must publish)
60-79  → SECONDARY_REEL (strong content, good to publish)
40-59  → SUPPORTING (context, filler, or optional)
<40    → DISCARD (not worth publishing)

DURATION AWARENESS:

- 20–60s clips are generally preferred for reels
- Very short clips (<12s) should be penalized unless they are exceptional hooks
- If two ideas are similar in strength, prefer the longer, more developed one

EVALUATION CRITERIA:
1. Clear Takeaway: Does it have a point?
2. Curiosity Factor: Does it make you want to keep watching?
3. Resolution: Does it feel complete?
4. Standalone Value: Works without extra context?
5. Delivery Quality: How well was it spoken?

DELIVERY QUALITY INFLUENCE:
- When two ideas have similar meaning or takeaway, prefer the one with clearer delivery (higher delivery_quality score)
- Ideas with smooth, confident delivery (delivery_quality ≥ 0.8) may outrank semantically similar ideas with broken delivery
- Low delivery quality (< 0.5) should slightly penalize otherwise strong ideas
- Don't expose this logic explicitly - let it influence your editorial judgment naturally

PENALTIES:
- Pure information without insight or reframing → score lower
- Repetitive ideas → only rank strongest highly
- Weak conclusions or CTAs → usually low scores
- Setup without payoff → discard
- Stammering or fragmented delivery → slight penalty if content is otherwise mediocre

REQUIRED REASONING:
- For publish_score ≥ 60: include publish_reason (short editorial justification)
- For publish_score < 40: include discard_reason (why not worth publishing)

ADDITIONAL RULES:
- Use the full 0–100 score range (avoid clustering)
- Only 1–2 ideas should score above 80
- Include a publish_reason for ideas with publish_score ≥ 60
- Assign a content_role: PRIMARY_REEL, SECONDARY_REEL, SUPPORTING, DISCARD
- Penalize ideas that are purely informational without a clear takeaway
- Ranking should reflect an editor's judgment, not politeness

OUTPUT FORMAT:
{
  "video_id": "string",
  "rankings": [
    {
      "canonical_id": number,
      "publish_score": number,
      "content_role": "PRIMARY_REEL" | "SECONDARY_REEL" | "SUPPORTING" | "DISCARD",
      "publish_reason": string | null,
      "discard_reason": string | null
    }
  ]
}

CRITICAL: Use canonical_id in output, NOT idea_id.

Be brutal. Be opinionated. Think about what YOU would actually want to publish.`
        },
        {
          role: "user",
          content: `Rank these idea units like a content director curating this week's slate:\n\n${JSON.stringify(unitsForRanking, null, 2)}\n\nEnforce score separation. Be opinionated. Return ONLY valid JSON.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    const parsed = JSON.parse(responseContent);
    const rankings = parsed.rankings || parsed.ranking || [];
    
    if (!Array.isArray(rankings)) {
      throw new Error('Invalid rankings format from LLM');
    }
    
    // FIX 1 & FIX 3: Merge rankings with original units using canonical_id, NO FALLBACKS
    const rankedUnits = ideaUnits.map(unit => {
      const ranking = rankings.find(r => r.canonical_id === unit.canonical_id);
      
      // FIX 3: Throw if ranking missing (no silent fallbacks)
      if (!ranking) {
        throw new Error(`[STAGE 2] No ranking returned for canonical_id ${unit.canonical_id} - LLM coordination failure`);
      }
      
      // FIX 3: Throw if critical fields missing
      if (ranking.publish_score === undefined || ranking.publish_score === null) {
        throw new Error(`[STAGE 2] Missing publish_score for canonical_id ${unit.canonical_id}`);
      }
      if (!ranking.content_role) {
        throw new Error(`[STAGE 2] Missing content_role for canonical_id ${unit.canonical_id}`);
      }
      
      const publishScore = parseInt(ranking.publish_score);
      const isDiscarded = ranking.content_role === 'DISCARD';
      
      return {
        canonical_id: unit.canonical_id,
        publish_score: publishScore,
        content_role: ranking.content_role,
        publish_reason: ranking.publish_reason || null,
        discard_reason: ranking.discard_reason || null,
        is_discarded: isDiscarded
      };
    }).sort((a, b) => b.publish_score - a.publish_score); // Sort by score descending
    
    // Save to data/publish_ranking.json
    const outputPath = path.join(dataDir, `${videoId}_publish_ranking.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      total_units: rankedUnits.length,
      publishable_units: rankedUnits.filter(u => !u.is_discarded).length,
      discarded_units: rankedUnits.filter(u => u.is_discarded).length,
      rankings: rankedUnits,
      metadata: {
        stage: 2,
        model: completion.model,
        tokens_used: completion.usage.total_tokens,
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    // FIX 2: Create approvedUnits list (freeze publishability decision)
    const approvedUnits = rankedUnits.filter(u => !u.is_discarded);
    
    console.log(`[STAGE 2] Ranked ${rankedUnits.length} units → ${approvedUnits.length} APPROVED for publication`);
    console.log(`[STAGE 2] ✓ Approved canonical_ids: ${approvedUnits.map(u => u.canonical_id).join(', ')}`);
    
    // FIX 4️⃣: EDITORIAL SCORE SPREAD GUARD
    if (approvedUnits.length > 1) {
      const scores = approvedUnits.map(u => u.publish_score);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      const spread = maxScore - minScore;
      
      // If all scores collapsed to narrow range (±5)
      if (spread <= 5) {
        console.warn(`[GUARDRAIL] ⚠️  Publish scores collapsed (spread=${spread}) - forcing separation`);
        
        // Boost highest quality unit
        const bestUnit = approvedUnits.reduce((best, curr) => 
          (curr.publish_score > best.publish_score) ? curr : best
        );
        const originalBestScore = bestUnit.publish_score;
        bestUnit.publish_score = Math.max(70, originalBestScore + 15);
        
        // Demote weakest unit
        const worstUnit = approvedUnits.reduce((worst, curr) => 
          (curr.publish_score < worst.publish_score) ? curr : worst
        );
        if (worstUnit.canonical_id !== bestUnit.canonical_id) {
          const originalWorstScore = worstUnit.publish_score;
          worstUnit.publish_score = Math.min(40, originalWorstScore - 10);
        }
        
        // Upgrade content role for boosted unit
        if (bestUnit.content_role === 'SUPPORTING') {
          bestUnit.content_role = 'SECONDARY_REEL';
        }
        
        console.log(`[GUARDRAIL] ✓ Score spread enforced: best=${bestUnit.canonical_id} (${originalBestScore}→${bestUnit.publish_score}), worst=${worstUnit.canonical_id} (${worstUnit.publish_score})`);
      }
    }
    
    // FIX 2: Return both rankings and frozen approvedUnits
    return { rankedUnits, approvedUnits };
  } catch (error) {
    console.error('[STAGE 2] Ranking error:', error);
    throw error;
  }
};

// STAGE 3: Internet framing for publishable ideas (editorial positioning)
const generatePublishPlan = async (ideaUnits, approvedUnits, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 3] Generating internet framing for ${approvedUnits.length} approved ideas...`);
    
    // FIX 2: NO FILTERING - consume approvedUnits only
    // FIX 1: Validate canonical_id usage
    const publishableUnits = ideaUnits.map(unit => {
      const approval = approvedUnits.find(a => a.canonical_id === unit.canonical_id);
      
      if (!approval) {
        throw new Error(`[STAGE 3] Unit ${unit.canonical_id} not in approvedUnits - pipeline violation`);
      }
      
      return {
        canonical_id: unit.canonical_id,
        cleaned_summary: unit.merged_summary || unit.cleaned_summary,
        idea_type: unit.idea_type,
        content_role: approval.content_role,
        publish_score: approval.publish_score
      };
    });
    
    if (publishableUnits.length === 0) {
      throw new Error('[STAGE 3] publishableUnits is empty despite having approvedUnits - coordination failure');
    }
    
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert social media editor who decides how ideas should be positioned online, not a classifier.

Your task: For each publishable idea, choose the most effective internet framing.

INPUT CONTEXT (for each idea):
- cleaned_summary: The core idea
- idea_type: HOOK, CONCEPT, EXPLANATION, INSIGHT, CONCLUSION
- content_role: PRIMARY_REEL, SECONDARY_REEL, SUPPORTING
- publish_score: Editorial ranking (0-100)

Use these signals to guide your framing decisions.

ATTRIBUTES TO ASSIGN:

1. STORY_TYPE (how this should be framed):
   - educational → explaining a concept or insight
   - reflective → perspective, realization, reframing
   - inspirational → motivating or empowering
   - fun → light, entertaining, curiosity-driven
   - promotional → announcements or calls-to-action
   - random → ONLY if no other category fits (use sparingly)

2. ENERGY (pacing & tone):
   - high → hooks, strong claims, surprising insights
   - medium → explanations, conversational ideas
   - low → thoughtful, reflective content

3. INTENT (what the viewer should do):
   - comment → debate, opinion, discussion
   - save → informational or insightful
   - follow → authority-building ideas
   - think → reflective, perspective-shifting content

4. FORMAT_TAG (how it FEELS on social media):
   - curiosity_question → poses intriguing question or paradox
   - myth_vs_fact → challenges common misconception
   - belief_challenge → confronts viewer's assumptions
   - expert_explains → authority breaking down complex topic
   - psychology_breakdown → reveals mental patterns or biases
   - pov_statement → strong opinion or perspective

IMPORTANT RULES:
- PRIMARY_REEL ideas should NOT be labeled "random"
- PRIMARY_REEL ideas MUST have a strong format_tag (no generic)
- HOOK ideas should usually have HIGH energy
- INSIGHT ideas should rarely be "random"
- Use a MIX of story types, energies, and format_tags across all ideas
- At most ONE idea may be labeled "random"
- Avoid repeating the same format_tag across many ideas
- Think about variety in the content slate, not uniform tagging

OUTPUT FORMAT:
{
  "publish_plan": [
    {
      "canonical_id": number,
      "story_type": string,
      "energy": string,
      "intent": string,
      "format_tag": string
    }
  ]
}

CRITICAL: Use canonical_id in output, NOT idea_id.

Think like an editor building a compelling content lineup.`
        },
        {
          role: "user",
          content: `Frame these ideas for maximum online impact. Create a deliberate content slate with variety:\n\n${JSON.stringify(publishableUnits, null, 2)}\n\nReturn ONLY valid JSON.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    const parsed = JSON.parse(responseContent);
    const publishPlan = parsed.publish_plan || parsed.plan || parsed;
    
    if (!Array.isArray(publishPlan)) {
      throw new Error('Invalid publish plan format from LLM');
    }
    
    // FIX 1 & FIX 3: Validate and merge using canonical_id, NO FALLBACKS
    const finalPlan = publishableUnits.map(unit => {
      const plan = publishPlan.find(p => p.canonical_id === unit.canonical_id);
      
      // FIX 3: Throw if plan missing (no silent fallbacks)
      if (!plan) {
        throw new Error(`[STAGE 3] No plan returned for canonical_id ${unit.canonical_id} - LLM coordination failure`);
      }
      
      // FIX 3: Throw if required fields missing
      if (!plan.story_type) {
        throw new Error(`[STAGE 3] Missing story_type for canonical_id ${unit.canonical_id}`);
      }
      if (!plan.energy) {
        throw new Error(`[STAGE 3] Missing energy for canonical_id ${unit.canonical_id}`);
      }
      if (!plan.intent) {
        throw new Error(`[STAGE 3] Missing intent for canonical_id ${unit.canonical_id}`);
      }
      if (!plan.format_tag) {
        throw new Error(`[STAGE 3] Missing format_tag for canonical_id ${unit.canonical_id}`);
      }
      
      return {
        canonical_id: unit.canonical_id,
        story_type: plan.story_type,
        energy: plan.energy,
        intent: plan.intent,
        format_tag: plan.format_tag
      };
    });
    
    // FIX 3: Enforce "random" limit (max 1)
    const randomCount = finalPlan.filter(p => p.story_type === 'random').length;
    if (randomCount > 1) {
      throw new Error(`[STAGE 3] ${randomCount} units tagged as "random" - maximum 1 allowed`);
    }
    
    console.log(`[STAGE 3] ✓ Validated: ${randomCount} random, ${finalPlan.length - randomCount} categorized`);
    
    // Save to data/publish_plan.json
    const outputPath = path.join(dataDir, `${videoId}_publish_plan.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      total_plans: finalPlan.length,
      publish_plan: finalPlan,
      metadata: {
        stage: 3,
        model: completion.model,
        tokens_used: completion.usage.total_tokens,
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[STAGE 3] Generated publish plan for ${finalPlan.length} ideas`);
    return finalPlan;
  } catch (error) {
    console.error('[STAGE 3] Publish plan error:', error);
    throw error;
  }
};

// ============================================================================
// STAGE 4: Script Skeleton Generation (with rich context)
// ============================================================================

const generateScriptSkeletons = async (ideaUnits, approvedUnits, publishPlan, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 4] Generating script skeletons for ${approvedUnits.length} approved units...`);
    
    // FIX 2: NO FILTERING - consume approvedUnits only
    // FIX 1: Use canonical_id, FIX 3: No fallbacks
    const publishableUnits = ideaUnits.map(unit => {
      const approval = approvedUnits.find(a => a.canonical_id === unit.canonical_id);
      const plan = publishPlan.find(p => p.canonical_id === unit.canonical_id);
      
      if (!approval) {
        throw new Error(`[STAGE 4] Unit ${unit.canonical_id} not in approvedUnits - pipeline violation`);
      }
      if (!plan) {
        throw new Error(`[STAGE 4] Unit ${unit.canonical_id} missing from publishPlan - coordination failure`);
      }
      
      return {
        canonical_id: unit.canonical_id,
        cleaned_summary: unit.merged_summary || unit.cleaned_summary,
        idea_type: unit.idea_type,
        content_role: approval.content_role,
        intent: plan.intent
      };
    });
    
    if (publishableUnits.length === 0) {
      throw new Error('[STAGE 4] publishableUnits is empty despite having approvedUnits - coordination failure');
    }
    
    const completion = await openaiText.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert short-form video editor and script writer.

Your task: Create SCRIPT SKELETONS for short-form reels.
These are NOT full scripts — they are structural guides.

For each idea, provide:

1. HOOK (1 short sentence, ~2–3 seconds)
   - Reframe the SAME core idea to grab attention
   - You MAY reword for clarity or curiosity
   - Do NOT introduce new facts, claims, or opinions

2. BODY_OUTLINE (3–5 bullet points)
   - Structural beats, NOT prose
   - Describe WHAT happens, not exact words
   - Example: ["present common belief", "introduce counterpoint", "explain why it matters"]

3. CTA (optional)
   - Natural and aligned with intent (comment / save / follow / think)
   - Skip if it would feel forced

4. EDITOR_NOTES (optional, 0–3 notes max)
   - These are NOT spoken lines
   - These are editing instructions for short-form video
   - Examples: "hard jump cut after hook", "add on-screen text: 'Barnum Effect'", "pause before insight beat", "zoom-in on final line"
   - Reflect real short-form editing behavior
   - Skip if unnecessary

INPUT CONTEXT YOU WILL RECEIVE:
- cleaned_summary
- idea_type (HOOK, CONCEPT, EXPLANATION, INSIGHT, CONCLUSION)
- content_role (PRIMARY_REEL, SECONDARY_REEL, SUPPORTING)
- intent

RULES:
- Do NOT invent new ideas or facts
- Hooks may paraphrase for engagement
- Body outlines may restructure the same idea
- PRIMARY_REEL ideas require the strongest hooks
- Assume the final reel should run approximately 30–60 seconds.
- Structure the body_outline to naturally fill this duration.

Return ONLY valid JSON:
{
  "scripts": [
    {
      "canonical_id": number,
      "hook": string,
      "body_outline": string[],
      "cta": string | null,
      "editor_notes": string[] | null
    }
  ]
}

CRITICAL: Use canonical_id in output, NOT idea_id.`
        },
        {
          role: "user",
          content: `Generate script skeletons for these ideas:\n\n${JSON.stringify(publishableUnits, null, 2)}\n\nReturn ONLY valid JSON.`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 1
    });
    
    const responseContent = completion.choices[0].message.content;
    const parsed = JSON.parse(responseContent);
    const scripts = parsed.scripts || parsed.script_skeletons || [];
    
    if (!Array.isArray(scripts)) {
      throw new Error('Invalid scripts format from LLM');
    }
    
    // Validate and structure scripts with QUALITY ENFORCEMENT
    const validatedScripts = scripts
      .map(script => {
        // Enforce non-empty hooks
        const hook = script.hook?.trim() || '';
        
        // Enforce 3-5 body outline items
        const bodyOutline = Array.isArray(script.body_outline) 
          ? script.body_outline.filter(item => item?.trim())
          : [];
        
        // Validate editor_notes (0-3 max)
        const editorNotes = Array.isArray(script.editor_notes)
          ? script.editor_notes.filter(note => note?.trim()).slice(0, 3)
          : null;
        
        // Validate minimum quality
        if (!hook || bodyOutline.length < 3 || bodyOutline.length > 5) {
          console.warn(`[STAGE 4] Script quality issue for canonical_id ${script.canonical_id}: hook="${hook}", outline items=${bodyOutline.length}`);
        }
        
        return {
          canonical_id: script.canonical_id,
          hook: hook,
          body_outline: bodyOutline,
          cta: script.cta?.trim() || null,
          editor_notes: editorNotes
        };
      })
      .filter(script => script.hook && script.body_outline.length >= 3); // Filter out low-quality scripts
    
    // Save to data/scripts.json
    const outputPath = path.join(dataDir, `${videoId}_scripts.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      total_scripts: validatedScripts.length,
      scripts: validatedScripts,
      metadata: {
        stage: 4,
        model: completion.model,
        tokens_used: completion.usage.total_tokens,
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[STAGE 4] Generated ${validatedScripts.length} script skeletons`);
    return validatedScripts;
  } catch (error) {
    console.error('[STAGE 4] Script generation error:', error);
    throw error;
  }
};

// ============================================================================
// STAGE 5: Video Assembly
// ============================================================================

const outputsDir = path.join(process.cwd(), 'outputs', 'reels');

const ensureOutputsDir = async () => {
  if (!existsSync(outputsDir)) {
    await mkdir(outputsDir, { recursive: true });
  }
};

// FIX 5: STAGE 5 IS NOW PURELY MECHANICAL
// No filtering, no editorial logic, only video cutting
const assembleVideoReels = async (approvedUnits, videoPath, videoId) => {
  try {
    await ensureOutputsDir();
    console.log(`[STAGE 5] MECHANICAL ASSEMBLY: Cutting ${approvedUnits.length} approved reels...`);
    
    // FIX 2: approvedUnits already filtered by Stage 2 - no re-filtering allowed
    if (approvedUnits.length === 0) {
      throw new Error('[STAGE 5] approvedUnits is empty - should have been caught earlier');
    }
    
    const reelPaths = [];
    
    for (const unit of approvedUnits) {
      try {
        // FIX 3️⃣: HARD GUARDRAIL - Assert canonical_id exists
        if (!unit.canonical_id && unit.canonical_id !== 0) {
          throw new Error(`[GUARDRAIL] CRITICAL: Unit has undefined canonical_id - ${JSON.stringify(unit)}`);
        }
        
        // FIX 3️⃣: Additional guardrails for video cutting
        if (unit.start_time === undefined || unit.end_time === undefined) {
          throw new Error(`[GUARDRAIL] CRITICAL: Unit ${unit.canonical_id} missing timestamps`);
        }
        
        // FIX 5: Deterministic filename using canonical_id
        const outputPath = path.join(outputsDir, `${videoId}_reel_${unit.canonical_id}.mp4`);
        
        // FIX 3️⃣: Verify filename doesn't contain 'undefined'
        if (outputPath.includes('undefined')) {
          throw new Error(`[GUARDRAIL] CRITICAL: Output path contains 'undefined': ${outputPath}`);
        }
        
        console.log(`[STAGE 5] Cutting reel ${unit.canonical_id}: ${unit.start_time}s - ${unit.end_time}s`);
        
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .setStartTime(unit.start_time)
            .setDuration(unit.duration)
            // Convert to vertical 9:16 format
            .size('1080x1920')
            .aspect('9:16')
            .autopad()
            // Clean output
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-preset fast',
              '-crf 23',
              '-movflags +faststart'
            ])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
        });
        
        // FIX 1: Use canonical_id
        reelPaths.push({
          canonical_id: unit.canonical_id,
          reel_path: outputPath
        });
        
        console.log(`[STAGE 5] ✓ Reel ${unit.canonical_id} created at ${outputPath}`);
        
      } catch (error) {
        // FIX 6: Fail loudly, don't silently skip
        console.error(`[STAGE 5] FATAL: Failed to create reel ${unit.canonical_id}:`, error);
        throw new Error(`[STAGE 5] Video cutting failed for canonical_id ${unit.canonical_id}: ${error.message}`);
      }
    }
    
    console.log(`[STAGE 5] ✓ Created ${reelPaths.length} reels (mechanical operation complete)`);
    console.log(`[GUARDRAIL] ✓ Reel assembly complete - ${reelPaths.length} files guaranteed`);
    return reelPaths;
    
  } catch (error) {
    console.error('[STAGE 5] Video assembly error:', error);
    throw error;
  }
};

// ============================================================================
// STAGE 5.5: Delivery Polish (NEW LAYER - MECHANICAL CLEANUP ONLY)
// ============================================================================
// Purpose: Remove audible stammering and verbal noise using word-level timestamps
// Constraints: ONE Groq API call per reel, fail-safe to original, NO editorial logic

const polishReelDelivery = async (reelPaths, videoId) => {
  // HACKATHON MODE: Fail hard, no fallbacks
  await ensureOutputsDir();
  console.log(`[STAGE 5.5] 🎙️  Delivery Polish: Cleaning ${reelPaths.length} reels...`);
  
  const fs = await import('fs');
  const polishedReels = [];
  const Groq = (await import('groq-sdk')).default;
  const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  
  for (const reelEntry of reelPaths) {
    const { canonical_id, reel_path } = reelEntry;
    
    console.log(`[STAGE 5.5] Processing reel ${canonical_id}...`);
        
        // STEP 1: Groq word-level transcription (ONE API call)
        const transcription = await groqClient.audio.transcriptions.create({
          file: fs.createReadStream(reel_path),
          model: 'whisper-large-v3-turbo',
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          temperature: 0.0
        });

        console.log(transcription)
        
        if (!transcription.words || transcription.words.length === 0) {
          console.log(`[STAGE 5.5] ⚠️  No words detected for reel ${canonical_id} - keeping original`);
          polishedReels.push({
            canonical_id,
            original_path: reel_path,
            cleaned_path: reel_path,
            polished: false
          });
          continue;
        }
        
        const words = transcription.words;
        const reelDuration = words[words.length - 1].end;
        
        // STEP 2: Detect removable words (SIMPLE RULES)
        const removableWords = [];
        
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const wordText = word.word.toLowerCase().trim();
          const wordDuration = (word.end - word.start) * 1000; // ms
          
          let removable = false;
          let reason = '';
          
          // Rule A: Immediate repetition (same word within 600ms)
          if (i > 0) {
            const prevWord = words[i - 1];
            const prevText = prevWord.word.toLowerCase().trim();
            const gap = (word.start - prevWord.end) * 1000;
            
            if (wordText === prevText && gap < 600) {
              removable = true;
              reason = 'repetition';
            }
          }
          
          // Rule B: Low-confidence filler (short + low logprob)
          if (!removable && wordDuration < 400) {
            // Use segment avg_logprob as proxy (Groq doesn't return per-word confidence)
            const avgLogprob = transcription.segments?.[0]?.avg_logprob || 0;
            if (avgLogprob < -0.6) {
              removable = true;
              reason = 'low_confidence';
            }
          }
          
          if (removable) {
            removableWords.push({ index: i, word, reason });
          }
        }
        
        console.log(`[STAGE 5.5] Found ${removableWords.length} removable words for reel ${canonical_id}`);
        
        if (removableWords.length === 0) {
          console.log(`[STAGE 5.5] ✓ No cleanup needed for reel ${canonical_id}`);
          polishedReels.push({
            canonical_id,
            original_path: reel_path,
            cleaned_path: reel_path,
            polished: false
          });
          continue;
        }
        
        // STEP 3: Build trim spans (merge adjacent removable words)
        const trimSpans = [];
        let currentSpan = null;
        
        for (const { index, word } of removableWords) {
          // Safety: Never trim first 1s or last 1s
          if (word.start < 1.0 || word.end > (reelDuration - 1.0)) {
            continue;
          }
          
          if (!currentSpan) {
            currentSpan = { start: word.start, end: word.end };
          } else {
            const gap = word.start - currentSpan.end;
            const spanDuration = currentSpan.end - currentSpan.start;
            
            // Merge if adjacent (gap < 200ms) and span won't exceed 1.0s
            if (gap < 0.2 && (word.end - currentSpan.start) <= 1.0) {
              currentSpan.end = word.end;
            } else {
              // Finalize current span
              if (spanDuration <= 1.0) {
                trimSpans.push(currentSpan);
              }
              currentSpan = { start: word.start, end: word.end };
            }
          }
        }
        
        // Add last span
        if (currentSpan && (currentSpan.end - currentSpan.start) <= 1.0) {
          trimSpans.push(currentSpan);
        }
        
        console.log(`[STAGE 5.5] Built ${trimSpans.length} trim spans for reel ${canonical_id}`);
        
        if (trimSpans.length === 0) {
          console.log(`[STAGE 5.5] ✓ No valid trim spans for reel ${canonical_id}`);
          polishedReels.push({
            canonical_id,
            original_path: reel_path,
            cleaned_path: reel_path,
            polished: false
          });
          continue;
        }
        
        // STEP 4: Safety guards
        const totalRemovedTime = trimSpans.reduce((sum, span) => sum + (span.end - span.start), 0);
        const removalPercentage = (totalRemovedTime / reelDuration) * 100;
        
        if (removalPercentage > 20) {
          console.warn(`[STAGE 5.5] ⚠️  Would remove ${removalPercentage.toFixed(1)}% (>20%) - keeping original for reel ${canonical_id}`);
          polishedReels.push({
            canonical_id,
            original_path: reel_path,
            cleaned_path: reel_path,
            polished: false
          });
          continue;
        }
        
        // STEP 5: Re-cut video (FFmpeg - subtract trim spans)
        const cleanedPath = path.join(outputsDir, `${videoId}_reel_${canonical_id}_cleaned.mp4`);
        
        // Build keep segments (inverse of trim spans)
        const keepSegments = [];
        let lastEnd = 0;
        
        for (const span of trimSpans) {
          if (span.start > lastEnd) {
            keepSegments.push({ start: lastEnd, end: span.start });
          }
          lastEnd = span.end;
        }
        
        // Add final segment
        if (lastEnd < reelDuration) {
          keepSegments.push({ start: lastEnd, end: reelDuration });
        }
        
        console.log(`[STAGE 5.5] Stitching ${keepSegments.length} segments for reel ${canonical_id}...`);
        
        // Create concat file for FFmpeg
        const concatFilePath = path.join(outputsDir, `${videoId}_concat_${canonical_id}.txt`);
        const segmentPaths = [];
        
        // Extract each keep segment
        for (let i = 0; i < keepSegments.length; i++) {
          const seg = keepSegments[i];
          const segPath = path.join(outputsDir, `${videoId}_seg_${canonical_id}_${i}.mp4`);
          
          await new Promise((resolve, reject) => {
            ffmpeg(reel_path)
              .setStartTime(seg.start)
              .setDuration(seg.end - seg.start)
              .outputOptions(['-c copy']) // Fast - no re-encode
              .output(segPath)
              .on('end', () => resolve())
              .on('error', (err) => reject(err))
              .run();
          });
          
          segmentPaths.push(segPath);
        }
        
        // Create concat file
        const concatContent = segmentPaths.map(p => `file '${path.basename(p)}'`).join('\n');
        await writeFile(concatFilePath, concatContent);
        
        // Concatenate segments
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .output(cleanedPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
        });
        
        // Cleanup temp files
        for (const segPath of segmentPaths) {
          try { fs.unlinkSync(segPath); } catch (e) {}
        }
        try { fs.unlinkSync(concatFilePath); } catch (e) {}
        
        console.log(`[STAGE 5.5] ✓ Cleaned reel ${canonical_id}: removed ${totalRemovedTime.toFixed(2)}s (${removalPercentage.toFixed(1)}%)`);
        
        polishedReels.push({
          canonical_id,
          original_path: reel_path,
          cleaned_path: cleanedPath,
          polished: true,
          removed_spans: trimSpans.length,
          removed_ms: Math.round(totalRemovedTime * 1000)
        });
  }
    
    console.log(`[STAGE 5.5] ✓ Delivery polish complete: ${polishedReels.filter(r => r.polished).length}/${reelPaths.length} reels cleaned`);
    
    // Save polish log
    const logPath = path.join(dataDir, `${videoId}_stage5_5_polish.json`);
    await writeFile(logPath, JSON.stringify({
      stage: '5.5',
      video_id: videoId,
      total_reels: reelPaths.length,
      polished_reels: polishedReels.filter(r => r.polished).length,
      reels: polishedReels,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return polishedReels;
};


// ============================================================================
// STAGE 6: Abundance Packaging
// ============================================================================

// FIX 6: STAGE 6 STRICT MATCHING - No silent skips
const packageFinalReels = async (approvedUnits, approvedUnitRankings, publishPlan, reelPaths, videoId) => {
  try {
    await ensureDataDir();
    console.log(`[STAGE 6] STRICT PACKAGING: Matching ${approvedUnitRankings.length} approved units with reel files...`);
    
    // FIX 2: NO FILTERING - consume approvedUnits only
    const finalReels = [];
    const fs = await import('fs');
    
    for (const unit of approvedUnits) {
      // FIX 1: Use canonical_id for all lookups
      const ranking = approvedUnitRankings.find(r => r.canonical_id === unit.canonical_id);
      const plan = publishPlan.find(p => p.canonical_id === unit.canonical_id);
      const reelPath = reelPaths.find(r => r.canonical_id === unit.canonical_id);
      
      // FIX 6: Strict validation - throw if any data missing
      if (!ranking) {
        throw new Error(`[STAGE 6] Unit ${unit.canonical_id} missing ranking - coordination failure`);
      }
      if (!plan) {
        throw new Error(`[STAGE 6] Unit ${unit.canonical_id} missing publish plan - coordination failure`);
      }
      if (!reelPath) {
        throw new Error(`[STAGE 6] Unit ${unit.canonical_id} missing reel path - Stage 5 failed`);
      }
      
      // FIX 6: Verify file actually exists on disk
      if (!fs.existsSync(reelPath.reel_path)) {
        throw new Error(`[STAGE 6] Reel file missing for ${unit.canonical_id}: ${reelPath.reel_path}`);
      }
      
      // FIX 7: Full traceability for demo explainability
      finalReels.push({
        canonical_id: unit.canonical_id,
        core_idea: unit.merged_summary || unit.cleaned_summary,
        story_type: plan.story_type,
        energy: plan.energy,
        intent: plan.intent,
        format_tag: plan.format_tag,
        publish_score: ranking.publish_score,
        content_role: ranking.content_role,
        publish_reason: ranking.publish_reason, // FIX 7: Why selected
        merge_reason: unit.merge_reason || null, // FIX 7: Why merged
        delivery_quality_score: unit.delivery_quality_score, // FIX 7: Delivery context
        is_merged: unit.is_merged || false,
        source_idea_ids: unit.source_idea_ids || [unit.canonical_id],
        duration: unit.duration,
        start_time: unit.start_time,
        end_time: unit.end_time,
        timestamp: formatTimestamp(unit.start_time),
        reel_path: reelPath.reel_path
      });
    }
    
    // Sort by publish score (best first)
    finalReels.sort((a, b) => b.publish_score - a.publish_score);
    
    console.log(`[STAGE 6] ✓ Strict match: ${finalReels.length}/${approvedUnitRankings.length} reels packaged`);
    console.log(`[GUARDRAIL] ✓ Final packaging complete - ${finalReels.length} reels ready for output`);
    
    // Group by story_type
    const byStoryType = {};
    finalReels.forEach(reel => {
      if (!byStoryType[reel.story_type]) {
        byStoryType[reel.story_type] = [];
      }
      byStoryType[reel.story_type].push(reel);
    });
    
    // Group by energy
    const byEnergy = {};
    finalReels.forEach(reel => {
      if (!byEnergy[reel.energy]) {
        byEnergy[reel.energy] = [];
      }
      byEnergy[reel.energy].push(reel);
    });
    
    // Save final package
    const outputPath = path.join(dataDir, `${videoId}_final_reels.json`);
    await writeFile(outputPath, JSON.stringify({
      video_id: videoId,
      total_reels: finalReels.length,
      reels: finalReels,
      grouped: {
        by_story_type: byStoryType,
        by_energy: byEnergy
      },
      summary: {
        story_types: Object.keys(byStoryType).map(type => ({
          type,
          count: byStoryType[type].length
        })),
        energy_levels: Object.keys(byEnergy).map(level => ({
          level,
          count: byEnergy[level].length
        }))
      },
      metadata: {
        stage: 6,
        timestamp: new Date().toISOString()
      }
    }, null, 2));
    
    console.log(`[STAGE 6] Packaged ${finalReels.length} reels`);
    console.log(`[STAGE 6] Story types: ${Object.keys(byStoryType).join(', ')}`);
    console.log(`[STAGE 6] Energy levels: ${Object.keys(byEnergy).join(', ')}`);
    
    return finalReels;
    
  } catch (error) {
    console.error('[STAGE 6] Packaging error:', error);
    throw error;
  }
};

// Process video with VAD + Whisper
const processVideo = async (videoId) => {
  const video = videos.get(videoId);
  if (!video) return;

  try {
    // Ensure data directory exists
    await ensureDataDir();

    // Update status to processing
    video.status = 'processing';
    video.startedAt = new Date().toISOString();
    video.processingStep = 'Extracting audio...';

    // Step 1: Extract audio from video (compressed WAV)
    const audioPath = path.join(uploadsDir, `${videoId}_audio.wav`);
    console.log(`Extracting audio for video ${videoId}...`);
    await extractAudio(video.filepath, audioPath);
    video.audioPath = audioPath;
    video.processingStep = 'Running voice activity detection...';

    // Step 2: Run VAD to remove silence and cut long gaps
    console.log(`Running local VAD for video ${videoId}...`);
    const [cleanedVideoPath, cleanedAudioPath] = await runVAD(audioPath, video.filepath, videoId);
    video.cleanedVideoPath = cleanedVideoPath;
    video.cleanedAudioPath = cleanedAudioPath;
    video.processingStep = 'Transcribing speech...';

    // Step 3: Transcribe with Whisper
    console.log(`Transcribing audio for video ${videoId}...`);
    const transcription = await transcribeWithWhisper(cleanedAudioPath);
    video.transcript = {
      text: transcription.text,
      segments: transcription.segments.map(seg => ({
        id: seg.id,
        start: seg.start,
        end: seg.end,
        text: seg.text
      }))
    };
    
    // Save transcription to file
    const transcriptOutputPath = path.join(dataDir, `${videoId}_transcript.json`);
    await writeFile(transcriptOutputPath, JSON.stringify({
      video_id: videoId,
      text: transcription.text,
      total_segments: transcription.segments.length,
      segments: transcription.segments.map(seg => ({
        id: seg.id,
        start: parseFloat(seg.start?.toFixed(3) || 0),
        end: parseFloat(seg.end?.toFixed(3) || 0),
        text: seg.text
      }))
    }, null, 2));
    console.log(`[Transcript] Saved transcription to ${transcriptOutputPath}`);
    video.processingStep = 'Running agent pipeline...';
    
    // ========================================================================
    // AGENT REASONING PIPELINE (3 STAGES)
    // ========================================================================
    
    // Step 4: STAGE 1 - Extract idea units
    video.processingStep = 'Stage 1: Extracting idea units...';
    console.log(`[AGENT PIPELINE] Starting Stage 1 for video ${videoId}...`);
    const ideaUnits = await extractIdeaUnits(transcription, videoId);
    video.ideaUnits = ideaUnits;
    
    // Step 4.5: STAGE 1.5 - Analyze delivery quality
    video.processingStep = 'Stage 1.5: Analyzing delivery quality...';
    console.log(`[AGENT PIPELINE] Starting Stage 1.5 for video ${videoId}...`);
    const deliveryAnalysis = await analyzeDeliveryQuality(ideaUnits, videoId);
    video.deliveryAnalysis = deliveryAnalysis;
    
    // Step 4.75: STAGE 1.75 - Merge continuous thoughts
    video.processingStep = 'Stage 1.75: Merging continuous thoughts...';
    console.log(`[AGENT PIPELINE] Starting Stage 1.75 for video ${videoId}...`);
    const mergedUnits = await mergeContinuousThoughts(ideaUnits, deliveryAnalysis, videoId);
    video.mergedUnits = mergedUnits;
    
    // Step 5: STAGE 2 - Rank publish-worthiness (use merged units)
    video.processingStep = 'Stage 2: Ranking publish-worthiness...';
    console.log(`[AGENT PIPELINE] Starting Stage 2 for video ${videoId}...`);
    const { rankedUnits: rankings, approvedUnits } = await rankPublishWorthiness(mergedUnits, videoId);
    video.publishRankings = rankings;
    video.approvedUnits = approvedUnits;
    
    // FIX 2️⃣: FAIL-SAFE for zero publishable reels (hackathon must show something)
    if (approvedUnits.length === 0) {
      console.warn('[GUARDRAIL] ⚠️  Stage 2 approved ZERO units - activating fallback mode');
      
      // Select best fallback unit from mergedUnits
      let fallbackUnit = null;
      
      // Strategy 1: Highest publishability_score
      const sortedByPublishability = [...mergedUnits].sort((a, b) => 
        (b.publishability_score || 0) - (a.publishability_score || 0)
      );
      
      // Strategy 2: Highest delivery_quality_score
      const sortedByDelivery = [...mergedUnits].sort((a, b) => 
        (b.delivery_quality_score || 0) - (a.delivery_quality_score || 0)
      );
      
      // Pick best from either strategy
      fallbackUnit = sortedByPublishability[0] || sortedByDelivery[0] || mergedUnits[0];
      
      if (!fallbackUnit) {
        throw new Error(`[GUARDRAIL] CRITICAL: No merged units available for fallback`);
      }
      
      // Create fallback approval
      const fallbackApproval = {
        canonical_id: fallbackUnit.canonical_id,
        publish_score: 60, // Forced moderate score
        content_role: 'SUPPORTING',
        publish_reason: '[FALLBACK] Auto-selected as best available unit',
        discard_reason: null,
        is_discarded: false
      };
      
      approvedUnits.push(fallbackApproval);
      rankings.push(fallbackApproval);
      
      console.log(`[GUARDRAIL] ✓ Forced fallback reel: canonical_id=${fallbackUnit.canonical_id}, publishability=${fallbackUnit.publishability_score}, delivery=${fallbackUnit.delivery_quality_score}`);
    }
    
    // Get full context for approved units only
    const approvedMergedUnits = mergedUnits.filter(u => 
      approvedUnits.some(a => a.canonical_id === u.canonical_id)
    );
    
    console.log(`[PIPELINE] ✓ Proceeding with ${approvedUnits.length} approved units to Stages 3-6`);
    
    // Step 6: STAGE 3 - Internet framing (ONLY approved units)
    video.processingStep = 'Stage 3: Generating internet framing...';
    console.log(`[AGENT PIPELINE] Starting Stage 3 for video ${videoId}...`);
    const publishPlan = await generatePublishPlan(approvedMergedUnits, approvedUnits, videoId);
    video.publishPlan = publishPlan;
    
    // Step 7: STAGE 4 - Script Skeletons (ONLY approved units)
    video.processingStep = 'Stage 4: Generating script skeletons...';
    console.log(`[AGENT PIPELINE] Starting Stage 4 for video ${videoId}...`);
    const scripts = await generateScriptSkeletons(approvedMergedUnits, approvedUnits, publishPlan, videoId);
    video.scripts = scripts;
    
    // Step 8: STAGE 5 - Video Assembly (ONLY approved units - MECHANICAL)
    video.processingStep = 'Stage 5: Assembling video reels...';
    console.log(`[AGENT PIPELINE] Starting Stage 5 for video ${videoId}...`);

    // Use cleaned video for reel assembly (timestamps are based on cleaned video)
    const videoPathForReels = video.cleanedVideoPath || video.filepath;
    console.log(`[STAGE 5] Using video path for reels: ${videoPathForReels}`);

    const reelPaths = await assembleVideoReels(approvedMergedUnits, videoPathForReels, videoId);
    video.reelPaths = reelPaths;
    
    // Step 8.5: STAGE 5.5 - Delivery Polish (NEW LAYER - MECHANICAL CLEANUP)
    video.processingStep = 'Stage 5.5: Polishing delivery...';
    console.log(`[AGENT PIPELINE] Starting Stage 5.5 for video ${videoId}...`);
    const polishedReels = await polishReelDelivery(reelPaths, videoId);
    video.polishedReels = polishedReels;
    
    // Update reel paths to use cleaned versions
    const finalReelPaths = polishedReels.map(pr => ({
      canonical_id: pr.canonical_id,
      reel_path: pr.cleaned_path // Use cleaned path if polished, original otherwise
    }));
    
    // Step 9: STAGE 6 - Abundance Packaging (ONLY approved units - STRICT MATCHING)
    video.processingStep = 'Stage 6: Packaging final reels...';
    console.log(`[AGENT PIPELINE] Starting Stage 6 for video ${videoId}...`);
    const finalReels = await packageFinalReels(approvedMergedUnits, approvedUnits, publishPlan, finalReelPaths, videoId);
    video.finalReels = finalReels;
    
    // ========================================================================
    // FIX 7: Final Results with FULL TRACEABILITY
    // ========================================================================
    
    // finalReels already has complete traceability from Stage 6
    // Use it directly for publishable clips
    const publishableClips = finalReels.map(reel => ({
      canonical_id: reel.canonical_id,
      start_time: reel.start_time,
      end_time: reel.end_time,
      duration: reel.duration,
      timestamp: reel.timestamp,
      
      // Stage 1.75: Merge information (FIX 7: Traceability)
      is_merged: reel.is_merged,
      source_idea_ids: reel.source_idea_ids,
      merge_reason: reel.merge_reason,
      
      // Stage 1: Core content
      core_idea: reel.core_idea,
      delivery_quality_score: reel.delivery_quality_score, // FIX 7: Delivery context
      
      // Stage 2: Editorial decision (FIX 7: Why published)
      publish_score: reel.publish_score,
      content_role: reel.content_role,
      publish_reason: reel.publish_reason, // FIX 7: Explainability
      
      // Stage 3: Internet framing
      story_type: reel.story_type,
      energy: reel.energy,
      intent: reel.intent,
      format_tag: reel.format_tag,
      
      // Stage 5/6: File location
      reel_path: reel.reel_path,
      thumbnail: null
    }));
    
    // Update video with results
    video.status = 'completed';
    video.completedAt = new Date().toISOString();
    video.processingStep = 'Complete';
    
    // FIX 5️⃣: FINAL GUARDRAIL LOG - Demo confidence
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`[GUARDRAIL] 🎬 PIPELINE COMPLETE - HACKATHON READY`);
    console.log(`[GUARDRAIL] ✓ Total reels created: ${publishableClips.length}`);
    console.log(`[GUARDRAIL] ✓ Canonical IDs: ${publishableClips.map(c => c.canonical_id).join(', ')}`);
    console.log(`[GUARDRAIL] ✓ Publish scores: ${publishableClips.map(c => c.publish_score).join(', ')}`);
    console.log(`[GUARDRAIL] ✓ All files verified on disk`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    video.results = {
      video_id: videoId,
      roughcuts: publishableClips,
      totalRoughcuts: publishableClips.length,
      topClips: publishableClips.slice(0, 3), // Top 3 by publish score

      // Summary stats
      stats: {
        total_idea_units: ideaUnits.length,
        publishable_units: publishableClips.length,
        discarded_units: ideaUnits.length - publishableClips.length,
        reels_created: finalReels.length,
        scripts_generated: scripts.length
      },

      // Final reels (from Stage 6)
      finalReels: finalReels,

      // File paths for accessing outputs
      outputPaths: {
        idea_units: `data/${videoId}_idea_units.json`,
        publish_ranking: `data/${videoId}_publish_ranking.json`,
        publish_plan: `data/${videoId}_publish_plan.json`,
        scripts: `data/${videoId}_scripts.json`,
        vad_segments: `data/${videoId}_vad_segments.json`,
        final_reels: `data/${videoId}_final_reels.json`,
        reels_directory: `outputs/reels/`
      }
    };

    console.log(`[AGENT PIPELINE] Complete for video ${videoId}:
      - ${ideaUnits.length} idea units extracted
      - ${publishableClips.length} publishable clips
      - ${scripts.length} scripts generated
      - ${finalReels.length} reels created
      - ${ideaUnits.length - publishableClips.length} discarded
    `);
  } catch (error) {
    console.error(`Processing error for video ${videoId}:`, error);
    video.status = 'failed';
    video.error = error.message;
    video.processingStep = 'Failed';
  }
};

export async function GET(request, { params }) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];
  const route = pathSegments.join('/');

  // GET /api/status/:videoId
  if (route.startsWith('status/')) {
    const videoId = route.split('/')[1];
    
    if (!videoId) {
      return NextResponse.json({ error: 'Video ID is required' }, { status: 400 });
    }

    const video = videos.get(videoId);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    return NextResponse.json({
      videoId: video.id,
      filename: video.filename,
      status: video.status,
      uploadedAt: video.uploadedAt,
      startedAt: video.startedAt || null,
      completedAt: video.completedAt || null,
      processingStep: video.processingStep || null,
      transcript: video.transcript || null,
      cleanedAudioPath: video.cleanedAudioPath || null,
      error: video.error || null,
      
      // Agent Reasoning Pipeline Results (Stages 1-6)
      ideaUnits: video.ideaUnits || null,
      publishRankings: video.publishRankings || null,
      publishPlan: video.publishPlan || null,
      scripts: video.scripts || null,
      reelPaths: video.reelPaths || null,
      finalReels: video.finalReels || null,
      
      // Combined results
      results: video.results || null
    });
  }

  // GET /api/videos - List all videos (bonus endpoint)
  if (route === 'videos') {
    const videoList = Array.from(videos.values()).map(v => ({
      id: v.id,
      filename: v.filename,
      status: v.status,
      uploadedAt: v.uploadedAt
    }));
    return NextResponse.json({ videos: videoList });
  }

  // GET /api/video/:videoId - Serve original uploaded video file
  if (route.startsWith('video/') && !route.includes('/clip/')) {
    const videoId = route.split('/')[1];
    
    if (!videoId) {
      return NextResponse.json({ error: 'Video ID is required' }, { status: 400 });
    }

    const video = videos.get(videoId);
    if (!video) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    try {
      const fs = await import('fs');
      const videoPath = video.filepath;
      
      if (!fs.existsSync(videoPath)) {
        return NextResponse.json({ error: 'Video file not found' }, { status: 404 });
      }

      const videoBuffer = fs.readFileSync(videoPath);
      const stat = fs.statSync(videoPath);
      
      // Determine content type based on file extension
      const ext = path.extname(videoPath).toLowerCase();
      const contentTypeMap = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska'
      };
      const contentType = contentTypeMap[ext] || 'video/mp4';

      return new NextResponse(videoBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (error) {
      console.error('Error serving video:', error);
      return NextResponse.json({ error: 'Failed to serve video' }, { status: 500 });
    }
  }

  // GET /api/video/:videoId/clip/:clipId - Serve processed clip video
  if (route.startsWith('video/') && route.includes('/clip/')) {
    const parts = route.split('/');
    const videoId = parts[1];
    const clipId = parseInt(parts[3]);
    
    if (!videoId || !clipId) {
      return NextResponse.json({ error: 'Video ID and Clip ID are required' }, { status: 400 });
    }

    try {
      const fs = await import('fs');

      // Read final_reels.json to get the clip path
      const reelsJsonPath = path.join(dataDir, `${videoId}_final_reels.json`);
      
      if (!fs.existsSync(reelsJsonPath)) {
        return NextResponse.json({ error: 'Processed clips not found' }, { status: 404 });
      }

      const reelsData = JSON.parse(fs.readFileSync(reelsJsonPath, 'utf8'));
      const clip = reelsData.reels.find(r => r.canonical_id === clipId);
      
      if (!clip || !clip.reel_path) {
        return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
      }

      const clipPath = clip.reel_path;
      
      if (!fs.existsSync(clipPath)) {
        return NextResponse.json({ error: 'Clip file not found on disk' }, { status: 404 });
      }

      const videoBuffer = fs.readFileSync(clipPath);
      const stat = fs.statSync(clipPath);
      
      const ext = path.extname(clipPath).toLowerCase();
      const contentTypeMap = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska'
      };
      const contentType = contentTypeMap[ext] || 'video/mp4';

      return new NextResponse(videoBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (error) {
      console.error('Error serving clip:', error);
      return NextResponse.json({ error: 'Failed to serve clip' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Route not found' }, { status: 404 });
}

export async function POST(request, { params }) {
  const resolvedParams = await params;
  const pathSegments = resolvedParams.path || [];
  const route = pathSegments.join('/');

  // POST /api/upload
  if (route === 'upload') {
    try {
      await ensureUploadsDir();

      const formData = await request.formData();
      const file = formData.get('video');

      if (!file) {
        return NextResponse.json({ error: 'No video file provided' }, { status: 400 });
      }

      // Validate file type
      const validTypes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo'];
      if (!validTypes.includes(file.type)) {
        return NextResponse.json({ error: 'Invalid file type. Please upload a video file.' }, { status: 400 });
      }

      const videoId = generateTimestampId();
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      // Save file with unique name
      const fileExtension = path.extname(file.name);
      const filename = `${videoId}${fileExtension}`;
      const filepath = path.join(uploadsDir, filename);

      await writeFile(filepath, buffer);

      // Store video metadata
      const videoData = {
        id: videoId,
        filename: file.name,
        savedFilename: filename,
        filepath: filepath,
        originalFilePath: filepath, // Keep original file path for re-runs
        size: buffer.length,
        type: file.type,
        status: 'uploaded',
        uploadedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        results: null
      };

      videos.set(videoId, videoData);

      return NextResponse.json({
        success: true,
        videoId: videoId,
        filename: file.name,
        size: buffer.length
      });
    } catch (error) {
      console.error('Upload error:', error);
      return NextResponse.json({ error: 'Failed to upload video' }, { status: 500 });
    }
  }

  // POST /api/process
  if (route === 'process') {
    try {
      const body = await request.json();
      const { videoId } = body;

      if (!videoId) {
        return NextResponse.json({ error: 'Video ID is required' }, { status: 400 });
      }

      const video = videos.get(videoId);
      if (!video) {
        return NextResponse.json({ error: 'Video not found' }, { status: 404 });
      }

      if (video.status === 'processing') {
        return NextResponse.json({ error: 'Video is already being processed' }, { status: 400 });
      }

      // Trigger async processing (fire and forget)
      processVideo(videoId).catch(err => {
        console.error('Processing error:', err);
        const v = videos.get(videoId);
        if (v) {
          v.status = 'failed';
          v.error = err.message;
        }
      });

      return NextResponse.json({
        success: true,
        message: 'Processing started',
        videoId: videoId
      });
    } catch (error) {
      console.error('Process error:', error);
      return NextResponse.json({ error: 'Failed to start processing' }, { status: 500 });
    }
  }

  // POST /api/rerun - Rerun processing with new timestamp ID
  if (route === 'rerun') {
    try {
      const body = await request.json();
      const { videoId } = body;

      if (!videoId) {
        return NextResponse.json({ error: 'Video ID is required' }, { status: 400 });
      }

      const existingVideo = videos.get(videoId);
      if (!existingVideo) {
        return NextResponse.json({ error: 'Video not found' }, { status: 404 });
      }

      // Create new video entry with new timestamp ID but same file
      const newVideoId = generateTimestampId();
      const newVideoData = {
        id: newVideoId,
        filename: existingVideo.filename,
        savedFilename: existingVideo.savedFilename,
        filepath: existingVideo.originalFilePath || existingVideo.filepath,
        originalFilePath: existingVideo.originalFilePath || existingVideo.filepath,
        size: existingVideo.size,
        type: existingVideo.type,
        status: 'uploaded',
        uploadedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        results: null
      };

      videos.set(newVideoId, newVideoData);

      // Trigger async processing with new ID
      processVideo(newVideoId).catch(err => {
        console.error('Processing error:', err);
        const v = videos.get(newVideoId);
        if (v) {
          v.status = 'failed';
          v.error = err.message;
        }
      });

      return NextResponse.json({
        success: true,
        message: 'Reprocessing started with new ID',
        videoId: newVideoId,
        previousVideoId: videoId
      });
    } catch (error) {
      console.error('Rerun error:', error);
      return NextResponse.json({ error: 'Failed to start reprocessing' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Route not found' }, { status: 404 });
}
