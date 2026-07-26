# Testing Narrative Moment Detection

## Overview
This guide shows how to test the complete pipeline: Upload → VAD → Whisper → Narrative Detection

## Test Flow

### 1. Upload a Video
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "video=@your_video.mp4"
```

**Expected Response:**
```json
{
  "success": true,
  "videoId": "abc-123-def",
  "filename": "your_video.mp4",
  "size": 5242880
}
```

### 2. Start Processing
```bash
curl -X POST http://localhost:3000/api/process \
  -H "Content-Type: application/json" \
  -d '{"videoId": "abc-123-def"}'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Processing started",
  "videoId": "abc-123-def"
}
```

### 3. Monitor Processing Status
```bash
# Poll this endpoint every 2-3 seconds
curl http://localhost:3000/api/status/abc-123-def
```

**Processing Steps (in order):**
1. Status: `processing`, Step: `"Extracting audio..."`
2. Status: `processing`, Step: `"Running voice activity detection..."`
3. Status: `processing`, Step: `"Transcribing speech..."`
4. Status: `processing`, Step: `"Detecting narrative moments..."`
5. Status: `completed`, Step: `"Complete"`

### 4. View Final Results

**Complete Response Structure:**
```json
{
  "videoId": "abc-123-def",
  "filename": "your_video.mp4",
  "status": "completed",
  "uploadedAt": "2025-06-18T10:00:00.000Z",
  "startedAt": "2025-06-18T10:00:05.000Z",
  "completedAt": "2025-06-18T10:00:45.000Z",
  "processingStep": "Complete",
  
  "transcript": {
    "text": "Full transcript of the video...",
    "segments": [
      {
        "id": 0,
        "start": 2.5,
        "end": 5.8,
        "text": "Hello everyone, today I want to talk about..."
      }
    ]
  },
  
  "cleanedAudioURL": "https://replicate.delivery/.../output.mp3",
  
  "narrativeMoments": [
    {
      "id": 1,
      "start_time": 15.5,
      "end_time": 28.3,
      "duration": 12.8,
      "core_idea": "Explains the importance of daily exercise for mental health",
      "energy": "medium",
      "story_type": "educational",
      "confidence_score": 0.87,
      "hook_strength": 0.75,
      "timestamp": "00:15"
    },
    {
      "id": 2,
      "start_time": 35.2,
      "end_time": 48.1,
      "duration": 12.9,
      "core_idea": "Shares a personal story about overcoming anxiety",
      "energy": "high",
      "story_type": "inspirational",
      "confidence_score": 0.92,
      "hook_strength": 0.88,
      "timestamp": "00:35"
    }
  ],
  
  "results": {
    "roughcuts": [
      {
        "id": 1,
        "timestamp": "00:15",
        "duration": "12.8s",
        "start_time": 15.5,
        "end_time": 28.3,
        "core_idea": "Explains the importance of daily exercise",
        "energy": "medium",
        "story_type": "educational",
        "confidence_score": 0.87,
        "hook_strength": 0.75,
        "thumbnail": null
      }
    ],
    "totalRoughcuts": 5,
    "topMoments": [
      // Top 3 highest confidence moments
    ]
  }
}
```

## Debug Files

Check the `/uploads/` directory for debug files:

```bash
ls -la /app/uploads/

# You should see:
# - {videoId}.mp4                      # Original video
# - {videoId}_audio.wav                # Extracted audio
# - {videoId}_narrative_input.json     # LLM input
# - {videoId}_narrative_llm_response.json  # Raw LLM output
# - {videoId}_narrative_moments.json   # Final validated moments
```

### View Debug Files

**1. View LLM Input:**
```bash
cat /app/uploads/{videoId}_narrative_input.json | jq '.'
```

**2. View LLM Response:**
```bash
cat /app/uploads/{videoId}_narrative_llm_response.json | jq '.'
```

**3. View Final Moments:**
```bash
cat /app/uploads/{videoId}_narrative_moments.json | jq '.'
```

## Example Narrative Moments Output

```json
{
  "total_moments": 5,
  "moments": [
    {
      "id": 1,
      "start_time": 15.5,
      "end_time": 28.3,
      "duration": 12.8,
      "core_idea": "Discusses the three key principles of effective time management",
      "energy": "medium",
      "story_type": "educational",
      "confidence_score": 0.89,
      "hook_strength": 0.78
    },
    {
      "id": 2,
      "start_time": 35.2,
      "end_time": 48.1,
      "duration": 12.9,
      "core_idea": "Shares a personal breakthrough moment that changed everything",
      "energy": "high",
      "story_type": "inspirational",
      "confidence_score": 0.94,
      "hook_strength": 0.91
    },
    {
      "id": 3,
      "start_time": 52.4,
      "end_time": 65.8,
      "duration": 13.4,
      "core_idea": "Demonstrates a quick exercise routine anyone can do",
      "energy": "high",
      "story_type": "fun",
      "confidence_score": 0.82,
      "hook_strength": 0.73
    }
  ],
  "metadata": {
    "transcript_length": 1245,
    "segments_count": 23,
    "analysis_timestamp": "2025-06-18T10:00:42.000Z"
  }
}
```

## Filtering Moments

### By Confidence Score
```bash
# Get high-confidence moments (>0.8)
curl http://localhost:3000/api/status/abc-123-def | \
  jq '.narrativeMoments[] | select(.confidence_score >= 0.8)'
```

### By Energy Level
```bash
# Get high-energy moments
curl http://localhost:3000/api/status/abc-123-def | \
  jq '.narrativeMoments[] | select(.energy == "high")'
```

### By Story Type
```bash
# Get educational moments
curl http://localhost:3000/api/status/abc-123-def | \
  jq '.narrativeMoments[] | select(.story_type == "educational")'
```

### Top 3 Moments
```bash
# Already provided in results.topMoments
curl http://localhost:3000/api/status/abc-123-def | \
  jq '.results.topMoments'
```

## Test Cases

### Test Case 1: Educational Content
**Video Type:** Tutorial, how-to guide, explanation
**Expected:** Multiple "educational" moments with medium energy

### Test Case 2: Motivational Speech
**Video Type:** Inspirational talk
**Expected:** "inspirational" moments with high energy, high hook strength

### Test Case 3: Product Demo
**Video Type:** Product showcase
**Expected:** "promotional" moments with varied energy

### Test Case 4: Vlog / Casual Talk
**Video Type:** Personal stories
**Expected:** Mix of "fun", "reflective", and "random" moments

### Test Case 5: Interview / Conversation
**Video Type:** Q&A format
**Expected:** Multiple moments, varied story types based on topics

## Common Issues & Solutions

### Issue: No moments detected
**Possible Causes:**
- Transcript too short
- No clear narrative structure
- Heavy technical jargon
- Poor audio quality

**Solution:**
- Check transcript in debug files
- Ensure video has clear speech
- Try with different content type

### Issue: Too many low-confidence moments
**Possible Causes:**
- Rambling or unstructured content
- Lots of filler words
- Incomplete thoughts

**Solution:**
- Use content with clearer structure
- Edit video before processing
- Adjust confidence threshold in your filtering

### Issue: Moments don't make sense
**Possible Causes:**
- Transcription errors
- VAD removed important context
- LLM misunderstood content

**Solution:**
- Check transcript accuracy
- Review VAD cleaned audio
- Examine debug files for issues

## Performance Benchmarks

**Small Video (1-2 minutes):**
- Audio Extraction: ~2 seconds
- VAD: ~5-8 seconds
- Whisper: ~5-10 seconds
- Narrative Detection: ~3-5 seconds
- **Total: ~15-25 seconds**

**Medium Video (3-5 minutes):**
- Audio Extraction: ~3 seconds
- VAD: ~10-15 seconds
- Whisper: ~10-20 seconds
- Narrative Detection: ~5-8 seconds
- **Total: ~28-46 seconds**

**Large Video (5-10 minutes):**
- Audio Extraction: ~5 seconds
- VAD: ~15-25 seconds
- Whisper: ~20-40 seconds
- Narrative Detection: ~8-12 seconds
- **Total: ~48-82 seconds**

## API Rate Limits

**Replicate (VAD):**
- Free tier: Limited requests per minute
- If rate limited, wait 60 seconds and retry

**OpenAI (Whisper + GPT-4):**
- Emergent LLM key has its own limits
- Check balance: Use emergent_integrations_manager tool
- If rate limited, wait and retry

## Validation Checklist

✅ **Video uploads successfully**
- Check file size and format
- Verify videoId returned

✅ **Processing starts**
- Status changes to "processing"
- Processing step updates

✅ **All steps complete**
- Audio extracted (check file exists)
- VAD completes (cleanedAudioURL present)
- Transcription succeeds (transcript.text populated)
- Narrative detection runs (narrativeMoments array present)

✅ **Moments are valid**
- start_time < end_time
- duration > 0
- confidence_score between 0 and 1
- All required fields present

✅ **Debug files created**
- Three JSON files in uploads directory
- Files contain expected data
- No error messages in logs

---

**Ready to test!** Start with a short video (30-60 seconds) for fastest results.
