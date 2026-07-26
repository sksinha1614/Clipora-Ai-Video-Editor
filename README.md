# Clipora - AI Video Editor

Transform long videos into viral-ready clips with AI-powered Clipora technology.

## Architecture

**Backend**: Next.js API Routes (Node.js)

- `/api/upload` - Upload video files
- `/api/process` - Trigger video processing
- `/api/status/:videoId` - Check processing status and results

**Frontend**: Next.js + React

- Single page application with file upload
- Processing status monitoring
- Results display grid

**Storage**: In-memory (no database)

## Project Structure

```
/app
├── app/
│   ├── api/
│   │   └── [[...path]]/
│   │       └── route.js          # All API endpoints
│   ├── page.js                    # Main frontend page
│   ├── layout.js                  # App layout
│   └── globals.css                # Global styles
├── components/
│   └── ui/                        # shadcn/ui components
├── uploads/                       # Uploaded video files (created on first upload)
└── package.json                   # Dependencies
```

## API Endpoints

### POST /api/upload

Upload a video file and save it locally.

**Request**: `multipart/form-data` with `video` field
**Response**:

```json
{
  "success": true,
  "videoId": "uuid-string",
  "filename": "original-name.mp4",
  "size": 1234567
}
```

### POST /api/process

Trigger processing for an uploaded video (currently mocked with 3-second delay).

**Request**:

```json
{
  "videoId": "uuid-string"
}
```

**Response**:

```json
{
  "success": true,
  "message": "Processing started",
  "videoId": "uuid-string"
}
```

### GET /api/status/:videoId

Fetch processing status and results.

**Response**:

```json
{
  "videoId": "uuid-string",
  "filename": "video.mp4",
  "status": "completed",
  "uploadedAt": "2025-01-01T00:00:00.000Z",
  "startedAt": "2025-01-01T00:00:05.000Z",
  "completedAt": "2025-01-01T00:00:35.000Z",
  "processingStep": "Complete",
  "transcript": {
    "text": "Full transcript of speech content...",
    "segments": [
      {
        "id": 0,
        "start": 2.5,
        "end": 5.8,
        "text": "Hello, this is the first segment."
      },
      {
        "id": 1,
        "start": 6.2,
        "end": 10.1,
        "text": "And this is the second segment."
      }
    ]
  },
  "cleanedAudioURL": "https://replicate.delivery/.../cleaned_audio.mp3",
  "results": {
    "roughcuts": [
      {
        "id": 1,
        "timestamp": "00:00:05",
        "duration": "5s",
        "thumbnail": null
      }
    ],
    "totalRoughcuts": 3
  }
}
```

**Status Values**:

- `uploaded` - Video uploaded, ready for processing
- `processing` - Currently being processed
- `completed` - Processing finished successfully
- `failed` - Processing failed

## Features

### Current Features

✅ Video file upload with validation
✅ File storage to local filesystem
✅ In-memory metadata storage
✅ **Audio extraction from video (FFmpeg)**
✅ **Voice Activity Detection (Silero VAD via Replicate)**
✅ **Speech transcription (OpenAI Whisper)**
✅ **Cleaned transcript with timestamp mapping**
✅ **3-Stage Agent Reasoning Pipeline (OpenAI GPT-4o-mini)**

- Stage 1: Meaning extraction (clean idea units)
- Stage 2: Publish-worthiness ranking (0-100 scores)
- Stage 3: Internet framing (story type, energy, intent)
  ✅ **Structured JSON outputs saved to data/ directory**
  ✅ **Quality over quantity filtering**
  ✅ Real-time status polling
  ✅ Results display grid
  ✅ Loading states and error handling
  ✅ Clean API contracts

### Processing Pipeline

1. **Upload** - Video file uploaded and saved locally
2. **Audio Extraction** - FFmpeg extracts audio track (16kHz, mono WAV)
3. **VAD Processing** - Silero VAD removes silence, keeps speech-only segments
4. **Transcription** - OpenAI Whisper transcribes cleaned audio
5. **Agent Reasoning (3 Stages)**:
   - **Stage 1**: Extract clean idea units (what creator meant)
   - **Stage 2**: Rank publish-worthiness (what's worth publishing)
   - **Stage 3**: Internet framing (how internet should see it)
6. **Results** - Returns publishable clips with structured metadata

### Not Implemented Yet

❌ Video clip generation (cutting/exporting)
❌ Persistent database
❌ Authentication
❌ Thumbnail generation
❌ Advanced styling
❌ Multi-speaker detection
❌ Visual scene analysis

## Running the Application

The application is already running via supervisor:

```bash
# Check status
sudo supervisorctl status nextjs

# Restart if needed
sudo supervisorctl restart nextjs

# View logs
tail -f /var/log/supervisor/nextjs.out.log
```

Access the application at: `http://localhost:3000`

## Usage Flow

1. **Select Video**: Click "Choose File" and select a video file
2. **Upload**: Click "Upload" button to upload the video
3. **Generate Roughcuts**: After upload, click "Generate Roughcuts" button
4. **Wait**: Processing status updates in real-time (currently takes ~3 seconds)
5. **View Results**: Results grid displays mock roughcuts with timestamps

## Development Notes

- Videos are stored in `/app/uploads/` directory (created automatically)
- In-memory storage resets on server restart
- Processing is simulated with a 3-second delay
- Mock results return 3 roughcuts per video
- No authentication or authorization
- No database connection required
- Ready for future integration of real video processing logic

## Next Steps (Not Implemented)

1. Add real video processing with FFmpeg
2. Implement AI-based scene detection
3. Generate actual thumbnails
4. Add persistent storage (database)
5. Implement authentication
6. Add video player for preview
7. Polish UI/UX
8. Add video trimming/editing capabilities

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS, shadcn/ui
- **Backend**: Next.js API Routes (Node.js)
- **File Upload**: Native Next.js FormData handling
- **Storage**: In-memory Maps (videos metadata)
- **File System**: Node.js fs/promises
- **Audio Processing**: FFmpeg (audio extraction)
- **Voice Activity Detection**: Silero VAD via Hugging Face API
- **Transcription**: OpenAI Whisper API (with Emergent LLM key)

## Environment Variables

Required API keys in `.env`:

```bash
HUGGINGFACE_TOKEN=your_huggingface_token
OPENAI_API_KEY=your_openai_key_or_emergent_llm_key
```

## Pipeline Details

### Audio Extraction

- FFmpeg extracts audio from video at 16kHz, mono, WAV format
- Optimized for speech recognition

### Voice Activity Detection (VAD)

- Silero VAD removes silence-only regions
- Keeps speech-containing segments
- Returns cleaned audio file from Hugging Face

### Transcription

- OpenAI Whisper transcribes cleaned audio
- Returns full transcript text
- Includes segments with precise timestamps:
  - `start`: Segment start time (seconds)
  - `end`: Segment end time (seconds)
  - `text`: Transcribed text for segment

### Timestamp Mapping

- Segments preserve original video timestamps
- Each segment maps back to exact time in original video
- Ready for clip generation or scene detection

---

**Status**: ✅ VAD + Whisper Pipeline Complete - Ready for narrative logic integration
