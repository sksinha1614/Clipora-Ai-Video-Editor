#!/usr/bin/env node

/**
 * Runtime Error Detection Test
 * Tests specific functions for const reassignment and other runtime errors
 */

import { readFileSync } from 'fs';
import path from 'path';

// Mock OpenAI
const openai = {
  chat: {
    completions: {
      create: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              delivery_score: 0.8,
              delivery_flags: [],
              editor_note: "Test delivery analysis"
            })
          }
        }],
        usage: { total_tokens: 100 }
      })
    }
  }
};

// Mock path and fs
const mockPath = {
  join: (...args) => args.join('/')
};

const mockFs = {
  promises: {
    readFile: (filePath) => {
      // Mock file reading - return test data
      if (filePath.includes('vad_timestamps.json')) {
        return Promise.resolve(JSON.stringify({
          segments: [
            { id: 1, start: 20, end: 25, duration: 5 },
            { id: 2, start: 30, end: 35, duration: 5 }
          ]
        }));
      }
      if (filePath.includes('transcript.json')) {
        return Promise.resolve(JSON.stringify({
          segments: [
            { id: 1, start: 20, end: 25, text: "test transcript" },
            { id: 2, start: 30, end: 35, text: "more text" }
          ]
        }));
      }
      return Promise.resolve('{}');
    }
  }
};

// Extract the analyzeDeliveryQuality function (copy from route.js with const error)
const analyzeDeliveryQuality = async (ideaUnits, videoId) => {
  try {
    console.log(`[STAGE 1.5] Analyzing delivery quality for ${ideaUnits.length} idea units...`);

    // Load VAD timestamps
    const fs = mockFs;
    const vadPath = mockPath.join('data', `${videoId}_vad_timestamps.json`);
    const transcriptPath = mockPath.join('data', `${videoId}_transcript.json`);

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
    const deliveryAnalysis = []; // This should be 'const' but code tries to reassign later

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
        const completion = await openai.chat.completions.create({
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
          temperature: 0.3
        });

        const responseContent = completion.choices[0].message.content;
        const parsed = JSON.parse(responseContent);

        deliveryAnalysis.push({
          idea_id: idea_id,
          delivery_score: parseFloat(parsed.delivery_score || 0.5),
          delivery_flags: Array.isArray(parsed.delivery_flags) ? parsed.delivery_flags : [],
          editor_note: parsed.editor_note || "Analyzed successfully"
        });

        console.log(`[STAGE 1.5] ✓ Idea ${idea_id}: delivery_score=${parsed.delivery_score}, flags=${parsed.delivery_flags?.length || 0}`);

      } catch (error) {
        console.error(`[STAGE 1.5] Failed to analyze idea ${ideaUnit.idea_id}:`, error);
        deliveryAnalysis.push({
          idea_id: ideaUnit.idea_id,
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
    deliveryAnalysis = Object.values(deduped); // THIS IS THE BUG - const reassignment!

    // Sort by delivery_score descending
    deliveryAnalysis.sort((a, b) => b.delivery_score - a.delivery_score);

    console.log(`[STAGE 1.5] ✓ Deduplicated: ${Object.keys(deduped).length} unique IDs`);

    return deliveryAnalysis;

  } catch (error) {
    console.error('[STAGE 1.5] Delivery analysis error:', error);
    throw error;
  }
};

// Test data
const testIdeaUnits = [
  {
    idea_id: 1,
    start_time: 24.4,
    end_time: 34.3
  },
  {
    idea_id: 2,
    start_time: 67.2,
    end_time: 71.6
  }
];

// Run the test
const runRuntimeErrorTest = async () => {
  console.log('🔥 Testing Runtime Errors: Const Reassignment Bug');
  console.log('=' .repeat(50));

  try {
    console.log('Calling analyzeDeliveryQuality with test data...');
    const result = await analyzeDeliveryQuality(testIdeaUnits, 'test_video');

    console.log('❌ ERROR: Function completed successfully - bug not caught!');
    console.log('Result:', result);

  } catch (error) {
    if (error.message.includes('Assignment to constant variable')) {
      console.log('✅ SUCCESS: Caught the const reassignment error!');
      console.log(`   Error: ${error.message}`);
      console.log('   This confirms the bug exists in the original code');
    } else {
      console.log(`⚠️  Different error: ${error.message}`);
    }
  }

  console.log('✅ Runtime error test completed');
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runRuntimeErrorTest().catch(console.error);
}

export { analyzeDeliveryQuality, runRuntimeErrorTest };
