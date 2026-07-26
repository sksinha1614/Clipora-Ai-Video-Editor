# Roughcut Agent Pipeline: Stages 4-6 Implementation

## Overview

Completed the final stages of the Roughcut Agent Pipeline that transform analyzed content into ready-to-publish video reels.

## Pipeline Flow (Complete)

```
Upload Video
    ↓
Audio Extraction (FFmpeg)
    ↓
VAD Processing (Local Silero VAD)
    ↓
Transcription (OpenAI Whisper)
    ↓
STAGE 1: Extract Idea Units
    ↓
STAGE 2: Rank Publish-Worthiness  
    ↓
STAGE 3: Internet Framing
    ↓
STAGE 4: Script Skeletons ← NEW
    ↓
STAGE 5: Video Assembly ← NEW
    ↓
STAGE 6: Abundance Packaging ← NEW
    ↓
Ready-to-Publish Reels
```

## STAGE 4: Script Skeleton Generation

### Purpose
Generate lightweight script structures (NOT rewrites) to guide short-form content creation.

### Input
- `data/{videoId}_idea_units.json`
- `data/{videoId}_publish_ranking.json`

### Process

Uses OpenAI GPT-4o-mini to create script skeletons for each publishable idea unit.

**Each skeleton includes:**

1. **Hook** (1 short sentence, 2-3 seconds)
   - Reframes the core idea to grab attention
   - Does NOT invent new content
   - Example: "Here's why most people get this wrong..."

2. **Body Outline** (3-5 bullet points)
   - Structural markers, NOT prose
   - Guides narrative flow
   - Example: ["setup the problem", "reveal the insight", "explain the benefit"]

3. **CTA** (Call to Action, optional)
   - Natural, not forced
   - Matches intent: comment / save / follow / think
   - Example: "Drop your thoughts below" or "Save this for later"

### Constraints
- ✅ Lightweight structural guides
- ✅ Reframe, don't invent
- ❌ NO rewriting spoken content
- ❌ NO paraphrasing what was said
- ❌ NO prose generation

### Output Structure

**File:** `data/{videoId}_scripts.json`

```json
{
  "video_id": "abc-123",
  "total_scripts": 5,
  "scripts": [
    {
      "idea_id": 1,
      "hook": "Here's the one thing everyone gets wrong about productivity",
      "body_outline": [
        "introduce common productivity myth",
        "reveal the real issue",
        "explain the better approach",
        "show practical example"
      ],
      "cta": "Which tip resonated with you most?"
    }
  ],
  "metadata": {
    "stage": 4,
    "model": "gpt-4o-mini",
    "tokens_used": 850,
    "timestamp": "2025-06-18T10:05:00Z"
  }
}
```

### Implementation

```javascript
const generateScriptSkeletons = async (ideaUnits, rankings, videoId) => {
  // Filter publishable units
  const publishableUnits = ideaUnits.filter(unit => {
    const ranking = rankings.find(r => r.idea_id === unit.idea_id);
    return ranking && !ranking.is_discarded;
  });
  
  // Call OpenAI to generate skeletons
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [...], // See prompt in code
    temperature: 0.3
  });
  
  // Save to data/scripts.json
  await writeFile(outputPath, JSON.stringify(scripts, null, 2));
  
  return scripts;
};
```

## STAGE 5: Video Assembly

### Purpose
Cut the original video into vertical 9:16 reels using the detected idea units' timestamps.

### Input
- Original uploaded video file
- `data/{videoId}_idea_units.json` (for timestamps)
- `data/{videoId}_publish_ranking.json` (for filtering)

### Process

For each publishable idea unit:

1. **Extract Video Segment**
   - Use `start_time` and `end_time` from idea unit
   - Cut with FFmpeg (deterministic)

2. **Convert to Vertical Format**
   - Resize to 1080x1920 (9:16 aspect ratio)
   - Auto-pad to maintain content

3. **Apply Clean Encoding**
   - H.264 video codec
   - AAC audio codec
   - Fast preset for quick processing
   - No transitions or effects

### Output

**Directory:** `outputs/reels/`

**File naming:** `{videoId}_reel_{idea_id}.mp4`

Example:
```
outputs/reels/
├── abc-123_reel_1.mp4
├── abc-123_reel_2.mp4
├── abc-123_reel_3.mp4
└── abc-123_reel_4.mp4
```

### Implementation

```javascript
const assembleVideoReels = async (ideaUnits, rankings, videoPath, videoId) => {
  await ensureOutputsDir();
  
  const publishableUnits = ideaUnits.filter(/* not discarded */);
  const reelPaths = [];
  
  for (const unit of publishableUnits) {
    const outputPath = `outputs/reels/${videoId}_reel_${unit.idea_id}.mp4`;
    
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .setStartTime(unit.start_time)
        .setDuration(unit.duration)
        .size('1080x1920')      // 9:16 vertical
        .aspect('9:16')
        .autopad()
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset fast', '-crf 23'])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    });
    
    reelPaths.push({ idea_id: unit.idea_id, reel_path: outputPath });
  }
  
  return reelPaths;
};
```

### Video Specifications

**Format:**
- Container: MP4
- Video Codec: H.264 (libx264)
- Audio Codec: AAC
- Resolution: 1080x1920 (9:16)
- CRF: 23 (good quality/size balance)
- Preset: fast

**Output Features:**
- ✅ Clean hard cuts (no transitions)
- ✅ Vertical orientation (9:16)
- ✅ Padded to fit (black bars if needed)
- ✅ Optimized for social media
- ❌ NO effects or filters
- ❌ NO overlays or text

## STAGE 6: Abundance Packaging

### Purpose
Create a structured content inventory that demonstrates "one video → many reels" transformation.

### Input
- `data/{videoId}_idea_units.json`
- `data/{videoId}_publish_ranking.json`
- `data/{videoId}_publish_plan.json`
- Reel paths from Stage 5

### Process

1. **Combine All Metadata**
   - Merge data from all previous stages
   - Create comprehensive reel inventory

2. **Group Reels**
   - By story_type (educational, fun, inspirational, etc.)
   - By energy (high, medium, low)

3. **Sort by Publish-Worthiness**
   - Order by publish_score (best first)
   - Highlight top performers

### Output Structure

**File:** `data/{videoId}_final_reels.json`

```json
{
  "video_id": "abc-123",
  "total_reels": 5,
  "reels": [
    {
      "idea_id": 1,
      "core_idea": "Explains the importance of daily exercise for mental health",
      "story_type": "educational",
      "energy": "medium",
      "intent": "save",
      "publish_score": 87,
      "duration": 12.8,
      "timestamp": "00:15",
      "reel_path": "/app/outputs/reels/abc-123_reel_1.mp4"
    }
  ],
  "grouped": {
    "by_story_type": {
      "educational": [
        { /* reel 1 */ },
        { /* reel 3 */ }
      ],
      "inspirational": [
        { /* reel 2 */ }
      ]
    },
    "by_energy": {
      "high": [
        { /* reel 2 */ }
      ],
      "medium": [
        { /* reel 1 */, /* reel 3 */ }
      ]
    }
  },
  "summary": {
    "story_types": [
      { "type": "educational", "count": 2 },
      { "type": "inspirational", "count": 1 }
    ],
    "energy_levels": [
      { "level": "high", "count": 1 },
      { "level": "medium", "count": 2 }
    ]
  },
  "metadata": {
    "stage": 6,
    "timestamp": "2025-06-18T10:10:00Z"
  }
}
```

### Implementation

```javascript
const packageFinalReels = async (ideaUnits, rankings, publishPlan, reelPaths, videoId) => {
  const finalReels = [];
  
  // Build comprehensive reel inventory
  for (const unit of ideaUnits) {
    const ranking = rankings.find(r => r.idea_id === unit.idea_id);
    const plan = publishPlan.find(p => p.idea_id === unit.idea_id);
    const reelPath = reelPaths.find(r => r.idea_id === unit.idea_id);
    
    if (ranking && !ranking.is_discarded && reelPath) {
      finalReels.push({
        idea_id: unit.idea_id,
        core_idea: unit.cleaned_summary,
        story_type: plan?.story_type,
        energy: plan?.energy,
        intent: plan?.intent,
        publish_score: ranking.publish_score,
        duration: unit.duration,
        reel_path: reelPath.reel_path
      });
    }
  }
  
  // Sort by publish score
  finalReels.sort((a, b) => b.publish_score - a.publish_score);
  
  // Group by story_type and energy
  const byStoryType = /* grouping logic */;
  const byEnergy = /* grouping logic */;
  
  // Save final package
  await writeFile(outputPath, JSON.stringify({
    video_id: videoId,
    total_reels: finalReels.length,
    reels: finalReels,
    grouped: { by_story_type: byStoryType, by_energy: byEnergy }
  }, null, 2));
  
  return finalReels;
};
```

## Complete File Structure

After processing, the following files are created:

```
/app
├── uploads/
│   ├── {videoId}.mp4                    # Original video
│   ├── {videoId}_audio.wav              # Extracted audio
│   └── {videoId}_audio_cleaned.wav      # VAD-processed audio
│
├── data/
│   ├── {videoId}_vad_segments.json      # VAD utterances
│   ├── {videoId}_idea_units.json        # Stage 1 output
│   ├── {videoId}_publish_ranking.json   # Stage 2 output
│   ├── {videoId}_publish_plan.json      # Stage 3 output
│   ├── {videoId}_scripts.json           # Stage 4 output ← NEW
│   └── {videoId}_final_reels.json       # Stage 6 output ← NEW
│
└── outputs/
    └── reels/
        ├── {videoId}_reel_1.mp4         # Stage 5 output ← NEW
        ├── {videoId}_reel_2.mp4
        ├── {videoId}_reel_3.mp4
        └── ...
```

## API Response

### Status Endpoint

**GET `/api/status/{videoId}`**

Returns complete pipeline status including new stages:

```json
{
  "videoId": "abc-123",
  "status": "completed",
  "processingStep": "Complete",
  
  "scripts": [...],        // Stage 4 output
  "reelPaths": [...],      // Stage 5 output
  "finalReels": [...],     // Stage 6 output
  
  "results": {
    "stats": {
      "total_idea_units": 7,
      "publishable_units": 5,
      "discarded_units": 2,
      "reels_created": 5,
      "scripts_generated": 5
    },
    "finalReels": [
      {
        "idea_id": 1,
        "core_idea": "...",
        "story_type": "educational",
        "energy": "medium",
        "publish_score": 87,
        "reel_path": "/app/outputs/reels/abc-123_reel_1.mp4"
      }
    ],
    "outputPaths": {
      "idea_units": "data/abc-123_idea_units.json",
      "scripts": "data/abc-123_scripts.json",
      "final_reels": "data/abc-123_final_reels.json",
      "reels_directory": "outputs/reels/"
    }
  }
}
```

## Processing Steps

When monitoring status, you'll see these steps:

1. `"Extracting audio..."`
2. `"Running voice activity detection..."`
3. `"Transcribing speech..."`
4. `"Stage 1: Extracting idea units..."`
5. `"Stage 2: Ranking publish-worthiness..."`
6. `"Stage 3: Generating internet framing..."`
7. **`"Stage 4: Generating script skeletons..."`** ← NEW
8. **`"Stage 5: Assembling video reels..."`** ← NEW
9. **`"Stage 6: Packaging final reels..."`** ← NEW
10. `"Complete"`

## Performance

**Typical Timeline (2-minute video):**
- Stages 1-3: ~15-25 seconds (LLM processing)
- **Stage 4:** ~3-5 seconds (script generation)
- **Stage 5:** ~10-20 seconds (video cutting, depends on # of reels)
- **Stage 6:** ~1-2 seconds (JSON packaging)
- **Total additional time:** ~15-30 seconds

## Error Handling

### Stage 4 Failures
- If script generation fails → Continue without scripts
- Partial results still saved

### Stage 5 Failures
- If reel creation fails → Log error, continue with others
- At least some reels created (best-effort)

### Stage 6 Failures
- Falls back to basic packaging
- Ensures data/ files are still accessible

## Key Design Decisions

### 1. Favor Quality Over Quantity
- Only create reels for publishable units
- Filter out low-scoring content early
- Result: Fewer, better reels

### 2. Deterministic Video Assembly
- Uses exact timestamps from idea units
- No AI interpretation in video cutting
- Result: Predictable, reproducible output

### 3. Lightweight Script Skeletons
- NOT full script rewrites
- Structural guides only
- Result: Fast processing, authentic content

### 4. Clean Hard Cuts
- No transitions or effects
- Pure content extraction
- Result: Raw, ready-to-edit reels

### 5. Abundance Packaging
- Demonstrates content inventory
- Groups by multiple dimensions
- Result: Clear content abundance visualization

## Usage Examples

### Access All Reels
```bash
ls -lh outputs/reels/

# View final reels inventory
cat data/{videoId}_final_reels.json | jq '.'
```

### Get Top 3 Reels
```bash
cat data/{videoId}_final_reels.json | jq '.reels[:3]'
```

### Filter by Story Type
```bash
cat data/{videoId}_final_reels.json | jq '.grouped.by_story_type.educational'
```

### Get High Energy Reels
```bash
cat data/{videoId}_final_reels.json | jq '.grouped.by_energy.high'
```

### View Script Skeletons
```bash
cat data/{videoId}_scripts.json | jq '.scripts'
```

## Demonstration Value

The complete pipeline demonstrates:

### ✅ One Video → Many Reels
- Single long-form video input
- Multiple short-form reel outputs
- Each reel is standalone

### ✅ Content Abundance
- 5-10 reels from a 2-minute video
- Grouped by type and energy
- Sorted by quality

### ✅ Ready to Publish
- Vertical format (9:16)
- Clean cuts
- Script guidance included

### ✅ Structured Inventory
- Complete metadata
- Easy filtering and sorting
- Clear organization

## Next Steps

The pipeline now provides:
- ✅ Video reels (MP4 files)
- ✅ Script skeletons (guidance)
- ✅ Comprehensive metadata (JSON)

**Potential enhancements:**
- [ ] Add captions/subtitles to reels
- [ ] Generate thumbnails
- [ ] Add background music
- [ ] Implement batch processing
- [ ] Add reel previews in UI

---

**Status**: ✅ Complete 6-stage Roughcut Agent Pipeline implemented and tested
