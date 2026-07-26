# Agent Reasoning Pipeline (3 Stages)

## Overview

The Agent Reasoning Pipeline is a 3-stage AI system that transforms raw video transcripts into structured, publishable content decisions. It separates **what the creator meant**, **what is worth publishing**, and **how the internet should see it**.

## Pipeline Architecture

```
Cleaned Transcript (from VAD + Whisper)
           ↓
    ┌──────────────────────────────────┐
    │  STAGE 1: Meaning Extraction     │
    │  What did the creator mean?      │
    │  Output: idea_units.json         │
    └──────────────────────────────────┘
           ↓
    ┌──────────────────────────────────┐
    │  STAGE 2: Publish Ranking        │
    │  What is worth publishing?       │
    │  Output: publish_ranking.json    │
    └──────────────────────────────────┘
           ↓
    ┌──────────────────────────────────┐
    │  STAGE 3: Internet Framing       │
    │  How should internet see it?     │
    │  Output: publish_plan.json       │
    └──────────────────────────────────┘
           ↓
    Publishable Clips (combined data)
```

## Stage 1: Meaning Extraction

### Purpose
Extract clean, finalized thoughts from the transcript, excluding filler, retakes, and incomplete ideas.

### Input
- Cleaned transcript text (after VAD)
- Timestamp-mapped segments

### Process
OpenAI LLM analyzes the transcript to identify **idea units** - complete, resolved thoughts the creator finalized.

### Filtering Rules
- ✅ Complete, resolved thoughts only
- ❌ Exclude filler words: "um", "uh", "like"
- ❌ Exclude false starts and corrections
- ❌ Exclude repeated attempts (keep only final version)
- ❌ Exclude incomplete thoughts
- 🎯 Prefer quality over quantity

### Output Structure
```json
{
  "video_id": "abc-123",
  "total_units": 5,
  "idea_units": [
    {
      "idea_id": 1,
      "start_time": 15.5,
      "end_time": 28.3,
      "duration": 12.8,
      "cleaned_summary": "Explains the importance of consistent practice in skill development, using personal guitar learning experience as example",
      "certainty_score": 0.92
    }
  ],
  "metadata": {
    "stage": 1,
    "model": "gpt-4o-mini",
    "tokens_used": 1250,
    "timestamp": "2025-06-18T10:00:00Z"
  }
}
```

**Saved to:** `data/{videoId}_idea_units.json`

### Fields Explained
- `idea_id`: Sequential identifier
- `start_time`: Original video timestamp (seconds)
- `end_time`: Original video timestamp (seconds)
- `duration`: Length of idea unit (seconds)
- `cleaned_summary`: Clear, concise description (1-3 sentences)
- `certainty_score`: 0.0-1.0 (confidence this is complete thought)

## Stage 2: Publish-Worthiness Ranking

### Purpose
Evaluate which idea units are worth publishing as short-form content.

### Input
- Idea units from Stage 1

### Process
OpenAI LLM ranks each idea unit based on:
1. **Clarity** - Is the idea clear and easy to understand?
2. **Standalone Value** - Can viewers get value without extra context?
3. **Watch Likelihood** - Would people actually watch this?
4. **Engagement Potential** - Does it spark interest or action?

### Scoring Guidelines
- **80-100**: Exceptional content, viral potential
- **60-79**: Strong content, definitely publishable
- **40-59**: Okay content, consider publishing
- **20-39**: Weak content, likely skip
- **0-19**: Poor content, definitely discard

**Discard Threshold:** Scores < 40 are marked as discarded

### Output Structure
```json
{
  "video_id": "abc-123",
  "total_units": 5,
  "publishable_units": 3,
  "discarded_units": 2,
  "rankings": [
    {
      "idea_id": 1,
      "publish_score": 87,
      "discard_reason": null,
      "is_discarded": false
    },
    {
      "idea_id": 2,
      "publish_score": 32,
      "discard_reason": "Too generic, lacks specific value proposition",
      "is_discarded": true
    }
  ],
  "metadata": {
    "stage": 2,
    "model": "gpt-4o-mini",
    "tokens_used": 850,
    "timestamp": "2025-06-18T10:00:05Z"
  }
}
```

**Saved to:** `data/{videoId}_publish_ranking.json`

### Fields Explained
- `publish_score`: 0-100 (higher = more publishable)
- `discard_reason`: Why it shouldn't be published (if score < 40)
- `is_discarded`: Boolean flag for filtering

## Stage 3: Internet Framing

### Purpose
For publishable ideas, decide how they should be presented to maximize online engagement.

### Input
- Publishable idea units (not discarded from Stage 2)
- Rankings from Stage 2

### Process
OpenAI LLM assigns three key attributes for each publishable idea:

#### 1. Story Type (Content Framing)
- `educational` - Teaching something useful
- `reflective` - Personal insight or deep thought
- `promotional` - Product/service/announcement
- `fun` - Entertainment, humor, light-hearted
- `inspirational` - Motivational, uplifting
- `random` - Miscellaneous content

#### 2. Energy (Pacing and Tone)
- `high` - Fast-paced, exciting, dynamic
- `medium` - Steady, engaging, conversational
- `low` - Calm, contemplative, slow

#### 3. Intent (Desired Viewer Action)
- `comment` - Spark discussion and replies
- `save` - Make them bookmark for later
- `follow` - Build audience/authority
- `think` - Provoke reflection

### Output Structure
```json
{
  "video_id": "abc-123",
  "total_plans": 3,
  "publish_plan": [
    {
      "idea_id": 1,
      "story_type": "educational",
      "energy": "medium",
      "intent": "save"
    },
    {
      "idea_id": 3,
      "story_type": "inspirational",
      "energy": "high",
      "intent": "comment"
    }
  ],
  "metadata": {
    "stage": 3,
    "model": "gpt-4o-mini",
    "tokens_used": 650,
    "timestamp": "2025-06-18T10:00:10Z"
  }
}
```

**Saved to:** `data/{videoId}_publish_plan.json`

## Combined API Response

The final API response merges all three stages into publishable clips:

```json
{
  "videoId": "abc-123",
  "status": "completed",
  "processingStep": "Complete",
  
  "ideaUnits": [...],           // Stage 1 raw data
  "publishRankings": [...],     // Stage 2 raw data
  "publishPlan": [...],         // Stage 3 raw data
  
  "results": {
    "roughcuts": [
      {
        "id": 1,
        "start_time": 15.5,
        "end_time": 28.3,
        "duration": 12.8,
        "timestamp": "00:15",
        
        // Stage 1: What creator meant
        "cleaned_summary": "Explains consistent practice...",
        "certainty_score": 0.92,
        
        // Stage 2: Worth publishing?
        "publish_score": 87,
        
        // Stage 3: How internet should see it
        "story_type": "educational",
        "energy": "medium",
        "intent": "save"
      }
    ],
    "totalRoughcuts": 3,
    "topClips": [...],           // Top 3 by publish_score
    
    "stats": {
      "total_idea_units": 5,
      "publishable_units": 3,
      "discarded_units": 2
    }
  }
}
```

## Processing Steps

When monitoring status, you'll see these steps:

1. `"Extracting audio..."`
2. `"Running voice activity detection..."`
3. `"Transcribing speech..."`
4. **`"Stage 1: Extracting idea units..."`** ← NEW
5. **`"Stage 2: Ranking publish-worthiness..."`** ← NEW
6. **`"Stage 3: Generating internet framing..."`** ← NEW
7. `"Complete"`

## File Structure

All JSON outputs are saved to the `data/` directory:

```
data/
├── {videoId}_idea_units.json       # Stage 1 output
├── {videoId}_publish_ranking.json  # Stage 2 output
└── {videoId}_publish_plan.json     # Stage 3 output
```

## Quality Over Quantity

The pipeline is designed to extract **fewer, higher-quality** idea units rather than many noisy ones.

**Example:**
- Input: 5-minute video with lots of rambling
- Stage 1: Extracts 7 clean idea units (not 50 fragments)
- Stage 2: 4 units publishable, 3 discarded
- Stage 3: 4 units framed for internet
- Final: 4 high-quality clips ready for production

## LLM Configuration

All stages use OpenAI GPT-4o-mini with optimized settings:

```javascript
{
  model: "gpt-4o-mini",
  temperature: 0.2-0.4,  // Low for consistency
  response_format: { type: "json_object" }
}
```

**Temperature by Stage:**
- Stage 1: 0.2 (most deterministic - finding facts)
- Stage 2: 0.3 (balanced - evaluating quality)
- Stage 3: 0.4 (more creative - framing content)

## Usage Example

```bash
# 1. Upload and process video
curl -X POST http://localhost:3000/api/upload -F "video=@video.mp4"
curl -X POST http://localhost:3000/api/process -H "Content-Type: application/json" \
  -d '{"videoId":"abc-123"}'

# 2. Monitor processing (poll every 2 seconds)
curl http://localhost:3000/api/status/abc-123

# 3. View stage outputs
cat data/abc-123_idea_units.json | jq '.'
cat data/abc-123_publish_ranking.json | jq '.'
cat data/abc-123_publish_plan.json | jq '.'

# 4. Get publishable clips
curl http://localhost:3000/api/status/abc-123 | jq '.results.roughcuts'

# 5. Filter by publish score
curl http://localhost:3000/api/status/abc-123 | \
  jq '.results.roughcuts[] | select(.publish_score >= 80)'

# 6. Filter by story type
curl http://localhost:3000/api/status/abc-123 | \
  jq '.results.roughcuts[] | select(.story_type == "educational")'
```

## Key Principles

### Separation of Concerns
1. **Stage 1**: Objective extraction (what was said)
2. **Stage 2**: Subjective evaluation (is it good?)
3. **Stage 3**: Strategic framing (how to present it)

### Quality Filters
- Stage 1 removes noise (filler, retakes)
- Stage 2 removes low-value content
- Stage 3 frames remaining content optimally

### Transparency
All intermediate outputs are saved for:
- Debugging pipeline issues
- Understanding AI decisions
- Manual review if needed
- Fine-tuning prompts

## Performance

**Typical Timeline (2-minute video):**
- VAD + Whisper: ~15-20 seconds
- Stage 1: ~3-5 seconds
- Stage 2: ~2-4 seconds
- Stage 3: ~2-4 seconds
- **Total: ~22-33 seconds**

**Token Usage (2-minute video):**
- Stage 1: ~1000-1500 tokens
- Stage 2: ~600-1000 tokens
- Stage 3: ~500-800 tokens
- **Total: ~2100-3300 tokens**

## Error Handling

Each stage has independent error handling:
- If Stage 1 fails → No idea units, processing stops
- If Stage 2 fails → Falls back to default scores
- If Stage 3 fails → Falls back to default framing

All errors are logged and saved in status.

## Next Steps

The 3-stage pipeline outputs **structured decisions**, ready for:
- ✅ Hook generation
- ✅ Script writing
- ✅ Caption creation
- ✅ Video cutting/editing
- ✅ Thumbnail generation
- ✅ Platform optimization

---

**Status**: ✅ Production-ready 3-stage agent reasoning pipeline
