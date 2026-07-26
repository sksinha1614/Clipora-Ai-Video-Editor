# Narrative Moment Detection

## Overview

The video processing pipeline now includes AI-powered narrative moment detection that analyzes transcripts to identify compelling segments suitable for short-form content (reels, TikToks, YouTube Shorts).

## How It Works

### Input
- Cleaned transcript text from VAD + Whisper processing
- Timestamp-mapped segments from original video

### Processing
Uses OpenAI GPT-4 to analyze transcript and identify:
- **Standalone narrative moments** - Complete ideas understandable without context
- **Story structure** - Clear beginning, middle, and end
- **Energy levels** - High, medium, or low engagement
- **Story types** - Educational, inspirational, fun, promotional, etc.
- **Hook strength** - How attention-grabbing the opening is

### Output
Ordered list of narrative moments sorted by **publish-worthiness**

## Narrative Moment Structure

Each detected moment includes:

```json
{
  "id": 1,
  "start_time": 15.5,        // Seconds from video start
  "end_time": 28.3,          // Seconds from video start
  "duration": 12.8,          // Duration in seconds
  "core_idea": "Explains how to overcome fear of public speaking by practicing with small groups first.",
  "energy": "medium",        // high | medium | low
  "story_type": "educational",  // high-energy | reflective | promotional | fun | educational | inspirational | random
  "confidence_score": 0.85,  // 0.0 to 1.0 - suitability for reels
  "hook_strength": 0.72,     // 0.0 to 1.0 - attention-grabbing opening
  "timestamp": "00:15"       // Formatted timestamp
}
```

## Detection Criteria

### What Makes a Good Narrative Moment?

✅ **Single Clear Idea**
- One cohesive thought or story
- Complete without additional context
- Understandable on its own

✅ **Clean Content**
- No filler words ("um", "uh", "like")
- No false starts or corrections
- No repeated attempts at the same point

✅ **Engaging Structure**
- Strong opening hook
- Clear progression
- Satisfying conclusion

✅ **Optimal Length**
- Typically 5-60 seconds
- Long enough to be meaningful
- Short enough for short-form platforms

### What Gets Excluded?

❌ Setup/transition moments without payoff
❌ Technical difficulties or corrections
❌ Long pauses or dead air (already removed by VAD)
❌ Incomplete thoughts
❌ Context-dependent references

## Scoring System

### Confidence Score (0.0 - 1.0)
Measures overall suitability for short-form content:
- **0.9 - 1.0**: Exceptional - viral potential, strong hook, clear value
- **0.7 - 0.9**: Excellent - publish-worthy, engaging content
- **0.5 - 0.7**: Good - solid content, may need minor editing
- **0.3 - 0.5**: Okay - usable but not standout
- **0.0 - 0.3**: Weak - skip or combine with other moments

### Hook Strength (0.0 - 1.0)
Measures how attention-grabbing the opening is:
- **0.8 - 1.0**: Instant hook - stops scrollers immediately
- **0.6 - 0.8**: Strong - engaging opening
- **0.4 - 0.6**: Moderate - adequate but not gripping
- **0.2 - 0.4**: Weak - slow start
- **0.0 - 0.2**: No hook - skip or re-edit

## Energy Levels

**High Energy**
- Fast-paced delivery
- Exciting or dramatic content
- High emotional intensity
- Action-oriented

**Medium Energy**
- Steady, engaging pace
- Informative or conversational
- Balanced emotional tone
- Educational content

**Low Energy**
- Calm, reflective pace
- Contemplative or serious
- Subdued emotional tone
- Deep thoughts or insights

## Story Types

**High-Energy**
- Exciting reveals
- Dramatic moments
- Celebrations
- Surprises

**Reflective**
- Personal insights
- Lessons learned
- Deep thoughts
- Contemplations

**Promotional**
- Product features
- Service descriptions
- Announcements
- Calls to action

**Fun**
- Humor
- Entertainment
- Light-hearted moments
- Jokes

**Educational**
- How-tos
- Explanations
- Tutorials
- Tips and tricks

**Inspirational**
- Motivational messages
- Success stories
- Overcoming challenges
- Encouragement

**Random**
- Unclassified moments
- Mixed content
- Transitional segments

## API Response

### Status Endpoint with Narrative Moments
```json
{
  "videoId": "abc-123",
  "status": "completed",
  "processingStep": "Complete",
  "transcript": {
    "text": "...",
    "segments": [...]
  },
  "narrativeMoments": [
    {
      "id": 1,
      "start_time": 15.5,
      "end_time": 28.3,
      "duration": 12.8,
      "core_idea": "How to overcome fear of public speaking",
      "energy": "medium",
      "story_type": "educational",
      "confidence_score": 0.85,
      "hook_strength": 0.72,
      "timestamp": "00:15"
    }
  ],
  "results": {
    "roughcuts": [...],
    "totalRoughcuts": 5,
    "topMoments": [...]  // Top 3 most publishable
  }
}
```

## Debug Files

For each processed video, intermediate JSON files are saved in `/uploads/`:

1. **`{videoId}_narrative_input.json`**
   - Input to LLM
   - Full transcript text
   - Timestamped segments
   - Raw transcript data

2. **`{videoId}_narrative_llm_response.json`**
   - Raw LLM response
   - Model used
   - Token usage
   - Complete API response

3. **`{videoId}_narrative_moments.json`**
   - Final validated moments
   - Metadata (timestamps, counts)
   - Complete analysis results

## Implementation Details

### LLM Configuration
```javascript
{
  model: "gpt-4o-mini",
  temperature: 0.3,  // Lower for consistency
  response_format: { type: "json_object" }
}
```

### Prompt Strategy
The system uses a specialized prompt that:
- Acts as an expert video editor
- Focuses on short-form content optimization
- Prioritizes standalone, context-free moments
- Emphasizes quality over quantity
- Sorts results by publish-worthiness

### Validation
Each moment is validated for:
- Valid start/end timestamps
- Positive duration
- Required fields present
- Reasonable confidence scores
- Proper formatting

## Usage Example

```javascript
// After processing completes
const status = await fetch(`/api/status/${videoId}`);
const data = await status.json();

// Access narrative moments
const moments = data.narrativeMoments;

// Get top publishable moments
const topMoments = data.results.topMoments;

// Find high-energy moments
const highEnergy = moments.filter(m => m.energy === 'high');

// Find moments by confidence
const bestMoments = moments.filter(m => m.confidence_score >= 0.8);

// Sort by hook strength
const strongHooks = moments
  .filter(m => m.hook_strength >= 0.7)
  .sort((a, b) => b.hook_strength - a.hook_strength);
```

## Best Practices

### For Content Creators
1. Review moments sorted by confidence score
2. Focus on high confidence (>0.8) moments first
3. Check hook strength for social media
4. Consider energy levels for platform fit
5. Use story types to organize content

### For Developers
1. Always check debug JSON files for issues
2. Monitor LLM token usage and costs
3. Implement retry logic for API failures
4. Cache results to avoid re-processing
5. Consider adding human review flags

## Performance

- **LLM Analysis**: ~2-5 seconds per video
- **Token Usage**: ~500-2000 tokens depending on transcript length
- **Accuracy**: High for clear, structured content
- **Reliability**: Handles various content types well

## Limitations

- Requires quality transcripts (VAD + Whisper preprocessing)
- Best with conversational or narrative content
- May struggle with very technical or dense content
- Confidence scores are heuristic, not absolute
- No video analysis (audio/transcript only)

## Future Enhancements

Potential improvements:
- Visual analysis integration (scene detection)
- Speaker diarization for multi-person videos
- Sentiment analysis for emotional moments
- Trend alignment (what's popular on platforms)
- A/B testing data integration
- Custom scoring models per platform

---

**Status**: ✅ Production-ready narrative detection with OpenAI GPT-4
