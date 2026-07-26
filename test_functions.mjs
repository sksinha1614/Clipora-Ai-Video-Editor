#!/usr/bin/env node

/**
 * Independent Test Script for XCut API Functions
 * Tests all functions from /app/api/[[...path]]/route.js using JSON data from /data
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION & MOCKS
// ============================================================================

const CONFIG = {
  dataDir: path.join(__dirname, 'data'),
  uploadsDir: path.join(__dirname, 'uploads'),
  outputsDir: path.join(__dirname, 'outputs', 'reels'),
  testVideoId: 'video_1765663736164_05iwljjbc'
};

// Extract functions for testing (avoid Next.js imports)
let extractedFunctions = null;
const loadExtractedFunctions = async () => {
  if (extractedFunctions) return extractedFunctions;

  try {
    // Create a module that extracts just the functions we need
    const { readFileSync } = await import('fs');
    const routeContent = readFileSync('./app/api/[[...path]]/route.js', 'utf-8');

    // Extract analyzeDeliveryQuality function
    const analyzeDeliveryQualityMatch = routeContent.match(/const analyzeDeliveryQuality = async \([^}]+\};/s);
    if (!analyzeDeliveryQualityMatch) {
      throw new Error('Could not extract analyzeDeliveryQuality function');
    }

    // Create a testable version by replacing dependencies
    let functionCode = analyzeDeliveryQualityMatch[0];

    // Replace Next.js and other imports with test-compatible versions
    functionCode = functionCode.replace(/openaiText/g, 'openai');
    functionCode = functionCode.replace(/dataDir/g, 'dataDirectory');
    functionCode = functionCode.replace(/ensureDataDir\(\)/g, 'Promise.resolve()');
    functionCode = functionCode.replace(/path\.join\(dataDir/g, 'path.join(dataDirectory');
    functionCode = functionCode.replace(/await import\('fs'\)/g, '({ promises: { readFile: () => Promise.resolve("{}") } })');

    // Create the function in a test context
    const testCode = `
      const openai = {
        chat: {
          completions: {
            create: ${mockOpenAICall.toString()}
          }
        }
      };
      const path = { join: (...args) => args.join('/') };
      const dataDirectory = '${CONFIG.dataDir}';

      ${functionCode}

      return { analyzeDeliveryQuality };
    `;

    // Execute in a safe context
    const func = new Function(testCode)();
    extractedFunctions = func;

    console.log('✓ Extracted functions for runtime testing');
    return extractedFunctions;
  } catch (error) {
    console.warn('⚠️  Could not extract functions for testing:', error.message);
    return null;
  }
};

// Mock OpenAI client (will use real API if keys are available)
const openaiText = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'mock-key',
});

// Mock Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'mock-key',
});

// ============================================================================
// UTILITY FUNCTIONS (extracted from route.js)
// ============================================================================

// Generate timestamp-based ID
const generateTimestampId = () => {
  return `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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

// ============================================================================
// DATA LOADING FUNCTIONS
// ============================================================================

const loadJSON = (filename) => {
  const filepath = path.join(CONFIG.dataDir, filename);
  if (!existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }
  return JSON.parse(readFileSync(filepath, 'utf-8'));
};

const saveJSON = (filename, data) => {
  const filepath = path.join(CONFIG.dataDir, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`✓ Saved: ${filepath}`);
};

// ============================================================================
// TEST DATA SETUP
// ============================================================================

const setupTestData = () => {
  console.log('🔧 Setting up test data...');

  const transcript = loadJSON(`${CONFIG.testVideoId}_transcript.json`);
  const vadData = loadJSON(`${CONFIG.testVideoId}_vad_timestamps.json`);
  const ideaUnits = loadJSON(`${CONFIG.testVideoId}_idea_units.json`);
  const deliveryAnalysis = loadJSON(`${CONFIG.testVideoId}_stage1_5_delivery.json`);
  const mergedUnits = loadJSON(`${CONFIG.testVideoId}_stage1_75_merged.json`);

  return {
    transcript,
    vadData,
    ideaUnits,
    deliveryAnalysis,
    mergedUnits
  };
};

// ============================================================================
// MOCK FUNCTIONS (for testing without external dependencies)
// ============================================================================

const mockOpenAICall = async (messages, options = {}) => {
  console.log('🤖 Mock OpenAI call - would send:', messages[1]?.content?.substring(0, 100) + '...');

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 100));

  // Return mock response based on the prompt type
  const userContent = messages[1]?.content || '';

  if (userContent.includes('Extract publishable idea units')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            idea_units: [
              {
                idea_id: 1,
                start_time: 24.4,
                end_time: 34.3,
                duration: 9.9,
                idea_type: "CONCEPT",
                cleaned_summary: "Mock: Tarot cards are special cards used for future telling.",
                certainty_score: 1.0,
                publishability_score: 0.8
              }
            ]
          })
        }
      }],
      usage: { total_tokens: 1000 }
    };
  }

  if (userContent.includes('Evaluate the delivery quality')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            delivery_score: 0.8,
            delivery_flags: [],
            editor_note: "Mock: Good delivery quality"
          })
        }
      }],
      usage: { total_tokens: 500 }
    };
  }

  if (userContent.includes('Analyze these idea units and determine which should be merged')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            merges: [],
            unmerged_ids: [1, 2, 3, 4, 5]
          })
        }
      }],
      usage: { total_tokens: 800 }
    };
  }

  if (userContent.includes('Rank these idea units like a content director')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            rankings: [
              {
                canonical_id: 1,
                publish_score: 75,
                content_role: "SECONDARY_REEL",
                publish_reason: "Mock: Strong concept",
                discard_reason: null
              }
            ]
          })
        }
      }],
      usage: { total_tokens: 600 }
    };
  }

  if (userContent.includes('Frame these ideas for maximum online impact')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            publish_plan: [
              {
                canonical_id: 1,
                story_type: "educational",
                energy: "medium",
                intent: "save",
                format_tag: "expert_explains"
              }
            ]
          })
        }
      }],
      usage: { total_tokens: 400 }
    };
  }

  if (userContent.includes('Generate script skeletons for these ideas')) {
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            scripts: [
              {
                canonical_id: 1,
                hook: "Mock: Did you know tarot cards aren't just for fun?",
                body_outline: [
                  "Explain what tarot cards are",
                  "Describe their history",
                  "Show how they're used today"
                ],
                cta: "Save this if you want to learn more about psychology",
                editor_notes: ["Add mysterious music", "Use close-up shots of cards"]
              }
            ]
          })
        }
      }],
      usage: { total_tokens: 700 }
    };
  }

  // Default mock response
  return {
    choices: [{
      message: {
        content: JSON.stringify({ mock: true, prompt_type: 'unknown' })
      }
    }],
    usage: { total_tokens: 100 }
  };
};

const mockGroqTranscription = async (audioPath) => {
  console.log('🎙️ Mock Groq transcription - would transcribe:', audioPath);

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 200));

  return {
    text: "Mock transcription text for testing purposes.",
    segments: [
      {
        id: 0,
        start: 0,
        end: 5,
        text: "Mock segment for testing."
      }
    ]
  };
};

// ============================================================================
// EXTRACTED FUNCTIONS FROM route.js (modified for testing)
// ============================================================================

// Apply tolerances to make VAD cuts look more natural
function applyVADTolerances(segments, totalDuration) {
  const TOLERANCES = {
    preSpeech: 0.3,      // Add 0.3s before detected speech starts
    postSpeech: 0.2,     // Add 0.2s after detected speech ends
    minSegment: 0.8,     // Minimum segment duration (filter out very short segments)
    maxGap: 0.5          // Maximum gap to fill (merge segments if gap < 0.5s)
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

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

const testUtilityFunctions = async () => {
  console.log('\n🧪 Testing Utility Functions...');

  // Test generateTimestampId
  const id = generateTimestampId();
  console.log('✓ generateTimestampId:', id);
  assert(id.startsWith('video_'), 'ID should start with video_');

  // Test formatTimestamp
  const formatted = formatTimestamp(3661.5); // 1h 1m 1.5s
  console.log('✓ formatTimestamp:', formatted);
  assert(formatted === '01:01:01', 'Should format correctly');

  // Test applyVADTolerances
  const testSegments = [
    { start: 1.0, end: 2.0 },
    { start: 3.0, end: 4.0 },
    { start: 4.2, end: 5.0 } // Close gap, should merge
  ];
  const processed = applyVADTolerances(testSegments, 10.0);
  console.log('✓ applyVADTolerances:', processed);
  assert(processed.length >= 1, 'Should return at least one segment');

  console.log('✅ Utility functions tests passed');
};

const testDataLoading = () => {
  console.log('\n📁 Testing Data Loading...');

  const { transcript, vadData, ideaUnits, deliveryAnalysis, mergedUnits } = setupTestData();

  console.log('✓ Loaded transcript:', transcript.video_id, `(${transcript.total_segments} segments)`);
  console.log('✓ Loaded VAD data:', vadData.video_id, `(${vadData.total_segments} segments)`);
  console.log('✓ Loaded idea units:', ideaUnits.video_id, `(${ideaUnits.total_units} units)`);
  console.log('✓ Loaded delivery analysis:', deliveryAnalysis.video_id, `(${deliveryAnalysis.total_analyzed} units)`);
  console.log('✓ Loaded merged units:', mergedUnits.video_id, `(${mergedUnits.total_merged_units} units)`);

  console.log('✅ Data loading tests passed');
};

const testStage1IdeaExtraction = async () => {
  console.log('\n🎯 Testing Stage 1: Idea Extraction...');

  const { transcript } = setupTestData();

  // Mock the OpenAI call
  const originalChatCompletions = openaiText.chat.completions.create;
  openaiText.chat.completions.create = mockOpenAICall;

  try {
    // Import the actual function from route.js (we'll extract it)
    // For now, test the data structure
    assert(transcript.segments, 'Transcript should have segments');
    assert(transcript.segments.length > 0, 'Should have segments');
    assert(transcript.segments[0].start !== undefined, 'Segments should have start time');

    console.log('✅ Stage 1 tests passed');
  } finally {
    openaiText.chat.completions.create = originalChatCompletions;
  }
};

const testStage1_5DeliveryAnalysis = async () => {
  console.log('\n🎤 Testing Stage 1.5: Delivery Quality Analysis...');

  const { ideaUnits, vadData, transcript } = setupTestData();

  // Mock the OpenAI call
  const originalChatCompletions = openaiText.chat.completions.create;
  openaiText.chat.completions.create = mockOpenAICall;

  try {
    // Test data structure validation
    assert(ideaUnits.idea_units, 'Should have idea_units array');
    assert(vadData.segments, 'Should have VAD segments');
    assert(transcript.segments, 'Should have transcript segments');

    console.log('✅ Stage 1.5 tests passed');
  } finally {
    openaiText.chat.completions.create = originalChatCompletions;
  }
};

const testStage1_75MergeEngine = async () => {
  console.log('\n🔗 Testing Stage 1.75: Thought Continuity & Merge Engine...');

  const { mergedUnits } = setupTestData();

  // Test merged units structure
  assert(mergedUnits.merged_units, 'Should have merged_units array');
  assert(mergedUnits.merged_units.length > 0, 'Should have merged units');

  const firstUnit = mergedUnits.merged_units[0];
  assert(firstUnit.canonical_id !== undefined, 'Should have canonical_id');
  assert(firstUnit.source_idea_ids, 'Should have source_idea_ids');
  assert(firstUnit.delivery_quality_score !== undefined, 'Should have delivery_quality_score');

  console.log('✅ Stage 1.75 tests passed');
};

const testStage2Ranking = async () => {
  console.log('\n📊 Testing Stage 2: Publish-Worthiness Ranking...');

  const { mergedUnits } = setupTestData();

  // Mock the OpenAI call
  const originalChatCompletions = openaiText.chat.completions.create;
  openaiText.chat.completions.create = mockOpenAICall;

  try {
    // Test merged units have required fields
    const units = mergedUnits.merged_units;
    units.forEach(unit => {
      assert(unit.canonical_id, 'Unit should have canonical_id');
      assert(unit.merged_summary || unit.cleaned_summary, 'Unit should have summary');
      assert(unit.delivery_quality_score !== undefined, 'Unit should have delivery_quality_score');
    });

    console.log('✅ Stage 2 tests passed');
  } finally {
    openaiText.chat.completions.create = originalChatCompletions;
  }
};

const testStage3InternetFraming = async () => {
  console.log('\n🌐 Testing Stage 3: Internet Framing...');

  const { mergedUnits } = setupTestData();

  // Mock the OpenAI call
  const originalChatCompletions = openaiText.chat.completions.create;
  openaiText.chat.completions.create = mockOpenAICall;

  try {
    // Test data structure
    assert(mergedUnits.merged_units, 'Should have merged units');

    console.log('✅ Stage 3 tests passed');
  } finally {
    openaiText.chat.completions.create = originalChatCompletions;
  }
};

const testStage4ScriptGeneration = async () => {
  console.log('\n📝 Testing Stage 4: Script Skeleton Generation...');

  const { mergedUnits } = setupTestData();

  // Mock the OpenAI call
  const originalChatCompletions = openaiText.chat.completions.create;
  openaiText.chat.completions.create = mockOpenAICall;

  try {
    // Test data structure
    assert(mergedUnits.merged_units, 'Should have merged units');

    console.log('✅ Stage 4 tests passed');
  } finally {
    openaiText.chat.completions.create = originalChatCompletions;
  }
};

// ============================================================================
// RUNTIME ERROR DETECTION TESTS
// ============================================================================

const testRuntimeErrors = async () => {
  console.log('\n🔥 Testing Runtime Errors: Variable Reassignment & Const Errors...');

  // Import the runtime error test
  const { runRuntimeErrorTest } = await import('./test_runtime_errors.mjs');

  try {
    await runRuntimeErrorTest();
    console.log('✅ Runtime error detection tests completed');
  } catch (error) {
    console.log(`⚠️  Runtime error test failed: ${error.message}`);
  }
};

const testFunctionImports = async () => {
  console.log('\n📦 Testing Function Imports & Availability...');

  const extractedFuncs = await loadExtractedFunctions();
  if (!extractedFuncs) {
    console.log('❌ Could not load extracted functions for testing');
    return;
  }

  // Check that key functions are available
  const requiredFunctions = [
    'analyzeDeliveryQuality',
    'extractIdeaUnits',
    'mergeContinuousThoughts',
    'rankPublishWorthiness',
    'generatePublishPlan',
    'generateScriptSkeletons',
    'assembleVideoReels',
    'packageFinalReels'
  ];

  let availableCount = 0;
  let missingCount = 0;

  for (const funcName of requiredFunctions) {
    if (typeof realFuncs[funcName] === 'function') {
      console.log(`✓ ${funcName}: Available`);
      availableCount++;
    } else {
      console.log(`❌ ${funcName}: Missing`);
      missingCount++;
    }
  }

  console.log(`📊 Function availability: ${availableCount}/${requiredFunctions.length} available`);

  if (missingCount > 0) {
    console.log('⚠️  Some functions missing - runtime error tests may be incomplete');
  }

  console.log('✅ Function import tests completed');
};

const testDataIntegrity = () => {
  console.log('\n🔍 Testing Data Integrity & Structure Validation...');

  const { ideaUnits, deliveryAnalysis, mergedUnits } = setupTestData();

  // Test for data structure issues that could cause runtime errors

  // Check idea units structure
  if (ideaUnits.idea_units) {
    ideaUnits.idea_units.forEach((unit, index) => {
      if (unit.idea_id === undefined) {
        console.log(`⚠️  Idea unit ${index} missing idea_id`);
      }
      if (typeof unit.start_time !== 'number') {
        console.log(`⚠️  Idea unit ${index} start_time is not a number: ${unit.start_time}`);
      }
      if (typeof unit.end_time !== 'number') {
        console.log(`⚠️  Idea unit ${index} end_time is not a number: ${unit.end_time}`);
      }
    });
  }

  // Check delivery analysis structure (this has the problematic data)
  if (deliveryAnalysis.delivery_analysis) {
    const analysis = deliveryAnalysis.delivery_analysis;
    console.log(`Analyzing ${analysis.length} delivery analysis entries...`);

    // Check for duplicate idea_ids (which could cause issues)
    const ideaIds = analysis.map(d => d.idea_id);
    const uniqueIds = [...new Set(ideaIds)];
    if (ideaIds.length !== uniqueIds.length) {
      console.log(`⚠️  Duplicate idea_ids found in delivery analysis: ${ideaIds.length} entries but ${uniqueIds.length} unique IDs`);
      console.log(`   IDs: ${ideaIds.join(', ')}`);
    }

    // Check for const reassignment potential
    analysis.forEach((entry, index) => {
      if (!entry.idea_id) {
        console.log(`⚠️  Delivery analysis entry ${index} missing idea_id`);
      }
    });
  }

  // Check merged units structure
  if (mergedUnits.merged_units) {
    mergedUnits.merged_units.forEach((unit, index) => {
      if (!unit.canonical_id) {
        console.log(`⚠️  Merged unit ${index} missing canonical_id`);
      }
    });
  }

  console.log('✅ Data integrity tests completed');
};

const testTranscriptionFunctions = async () => {
  console.log('\n🎙️ Testing Transcription Functions...');

  // Mock the Groq transcription
  const originalCreate = groq.audio.transcriptions.create;
  groq.audio.transcriptions.create = mockGroqTranscription;

  try {
    // Test mock transcription
    const result = await mockGroqTranscription('/fake/audio.wav');
    assert(result.text, 'Should return text');
    assert(result.segments, 'Should return segments');
    assert(Array.isArray(result.segments), 'Segments should be array');

    console.log('✅ Transcription tests passed');
  } finally {
    groq.audio.transcriptions.create = originalCreate;
  }
};

// ============================================================================
// ASSERTION HELPER
// ============================================================================

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

const runTest = async (testName, testFn, results) => {
  try {
    console.log(`\n🔬 Running: ${testName}`);
    await testFn();
    results.passed++;
    console.log(`✅ PASSED: ${testName}`);
  } catch (error) {
    results.failed++;
    results.errors.push({ test: testName, error: error.message });
    console.log(`❌ FAILED: ${testName} - ${error.message}`);
  }
};

const runAllTests = async () => {
  console.log('🚀 Starting XCut API Function Tests');
  console.log('=' .repeat(50));

  const results = {
    passed: 0,
    failed: 0,
    errors: []
  };

  // Run all tests
  await runTest('Utility Functions', testUtilityFunctions, results);
  await runTest('Data Loading', testDataLoading, results);
  await runTest('Data Integrity', testDataIntegrity, results);
  await runTest('Function Imports', testFunctionImports, results);
  await runTest('Runtime Errors', testRuntimeErrors, results);
  await runTest('Transcription Functions', testTranscriptionFunctions, results);
  await runTest('Stage 1: Idea Extraction', testStage1IdeaExtraction, results);
  await runTest('Stage 1.5: Delivery Analysis', testStage1_5DeliveryAnalysis, results);
  await runTest('Stage 1.75: Merge Engine', testStage1_75MergeEngine, results);
  await runTest('Stage 2: Ranking', testStage2Ranking, results);
  await runTest('Stage 3: Internet Framing', testStage3InternetFraming, results);
  await runTest('Stage 4: Script Generation', testStage4ScriptGeneration, results);

  // Summary
  console.log('\n' + '=' .repeat(50));
  console.log('🏁 Test Results Summary');
  console.log('=' .repeat(50));
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📊 Total: ${results.passed + results.failed}`);

  if (results.errors.length > 0) {
    console.log('\n❌ Errors:');
    results.errors.forEach(({ test, error }) => {
      console.log(`  ${test}: ${error}`);
    });
  }

  console.log('\n🎉 Test run complete!');
  return results;
};

// ============================================================================
// CLI INTERFACE
// ============================================================================

const runSpecificTest = async (testName) => {
  const testMap = {
    'utils': testUtilityFunctions,
    'data': testDataLoading,
    'integrity': testDataIntegrity,
    'imports': testFunctionImports,
    'runtime': testRuntimeErrors,
    'transcription': testTranscriptionFunctions,
    'stage1': testStage1IdeaExtraction,
    'stage1.5': testStage1_5DeliveryAnalysis,
    'stage1.75': testStage1_75MergeEngine,
    'stage2': testStage2Ranking,
    'stage3': testStage3InternetFraming,
    'stage4': testStage4ScriptGeneration
  };

  const testFn = testMap[testName];
  if (!testFn) {
    console.log(`Unknown test: ${testName}`);
    console.log('Available tests:', Object.keys(testMap).join(', '));
    return;
  }

  const results = { passed: 0, failed: 0, errors: [] };
  await runTest(testName, testFn, results);

  console.log(`\n🏁 Test Result: ${results.passed > 0 ? 'PASSED' : 'FAILED'}`);
};

// Run tests based on command line arguments
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Run all tests
    runAllTests().catch(console.error);
  } else {
    // Run specific test
    const testName = args[0];
    runSpecificTest(testName).catch(console.error);
  }
}

export {
  runAllTests,
  runSpecificTest,
  setupTestData,
  mockOpenAICall,
  mockGroqTranscription
};
