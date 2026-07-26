#!/usr/bin/env node

/**
 * Simple Transcription Test Script
 * Tests transcription functionality with any video file
 * Usage: node test_transcription.mjs <video_path>
 */

import { readFileSync } from 'fs';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Groq client (only when needed)
let groq = null;

function getGroqClient() {
  if (!groq) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY environment variable not set');
    }
    groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }
  return groq;
}

async function testTranscription(videoPath) {
  console.log(`🧪 Testing transcription for: ${videoPath}`);

  try {
    // Check if file exists
    try {
      readFileSync(videoPath);
    } catch (error) {
      console.error(`❌ Video file not found: ${videoPath}`);
      return false;
    }

    console.log('📤 Starting transcription...');

    // Call Groq Whisper API with the same parameters as the main app
    const transcription = await getGroqClient().audio.transcriptions.create({
      file: readFileSync(videoPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      temperature: 0.0
    });

    console.log('✅ Transcription completed successfully!');
    console.log('\n📊 TRANSCRIPTION RESULTS:');
    console.log('=' .repeat(50));

    // Test the new structure: transcription.segments[].words[]
    console.log('\n🔍 Testing word extraction from segments...');

    // Extract words from segments structure (NEW WAY)
    const wordsFromSegments = transcription.segments?.flatMap(segment => segment.words || []) || [];

    console.log(`📝 Total words extracted: ${wordsFromSegments.length}`);

    if (wordsFromSegments.length > 0) {
      console.log('\n🎯 First 5 words:');
      wordsFromSegments.slice(0, 5).forEach((word, i) => {
        console.log(`  ${i + 1}. "${word.word}" (${word.start.toFixed(2)}s - ${word.end.toFixed(2)}s)`);
      });

      console.log('\n🎯 Last 5 words:');
      wordsFromSegments.slice(-5).forEach((word, i) => {
        const index = wordsFromSegments.length - 5 + i + 1;
        console.log(`  ${index}. "${word.word}" (${word.start.toFixed(2)}s - ${word.end.toFixed(2)}s)`);
      });

      // Calculate total duration
      const totalDuration = wordsFromSegments[wordsFromSegments.length - 1].end;
      console.log(`\n⏱️  Total duration: ${totalDuration.toFixed(2)} seconds`);
    }

    // Show segment structure
    console.log('\n📋 Segment Structure:');
    if (transcription.segments && transcription.segments.length > 0) {
      console.log(`  Total segments: ${transcription.segments.length}`);
      console.log('  Sample segment:');
      const sampleSegment = transcription.segments[0];
      console.log(`    ID: ${sampleSegment.id}`);
      console.log(`    Start: ${sampleSegment.start}s`);
      console.log(`    End: ${sampleSegment.end}s`);
      console.log(`    Text: "${sampleSegment.text?.substring(0, 100)}..."`);
      console.log(`    Words in segment: ${sampleSegment.words?.length || 0}`);
    }

    // Show full text
    console.log('\n📄 Full transcription text:');
    console.log(`"${transcription.text?.substring(0, 300)}${transcription.text?.length > 300 ? '...' : ''}"`);

    console.log('\n✅ Test completed successfully!');
    return true;

  } catch (error) {
    console.error('❌ Transcription test failed:');
    console.error(error.message);

    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }

    return false;
  }
}

function printUsage() {
  console.log('\n📖 Usage:');
  console.log('  node test_transcription.mjs <video_path>');
  console.log('\n📝 Examples:');
  console.log('  node test_transcription.mjs ./outputs/reels/video_123_reel_1.mp4');
  console.log('  node test_transcription.mjs /path/to/any/video.mp4');
  console.log('\n🔧 Requirements:');
  console.log('  - Set GROQ_API_KEY environment variable');
  console.log('  - Video file must be accessible');
  console.log('  - Supported formats: mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm');
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('❌ Error: No video path provided');
  printUsage();
  process.exit(1);
}

if (args[0] === '--help' || args[0] === '-h') {
  printUsage();
  process.exit(0);
}

const videoPath = args[0];

// Check for API key
if (!process.env.GROQ_API_KEY) {
  console.error('❌ Error: GROQ_API_KEY environment variable not set');
  console.log('   Please set your Groq API key:');
  console.log('   export GROQ_API_KEY=your_api_key_here');
  process.exit(1);
}

testTranscription(videoPath).then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('💥 Unexpected error:', error);
  process.exit(1);
});
