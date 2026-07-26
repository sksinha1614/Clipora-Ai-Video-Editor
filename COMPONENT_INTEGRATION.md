# VideoUploadCard Component Integration

## Overview

Successfully integrated the `VideoUploadCard` component with the existing backend API for video processing. The component provides a beautiful drag-and-drop interface with animation effects and automatic backend integration.

## What Was Done

### 1. Project Setup ✅

**TypeScript Support:**
- Added `tsconfig.json` for TypeScript compilation
- Project now supports both `.js` and `.tsx` files

**Dependencies Installed:**
- ✅ `framer-motion` - For smooth animations
- ✅ `lucide-react` - Already installed
- ✅ All other dependencies already present

### 2. Component Structure

**Location:** `/app/components/ui/video-upload-card.tsx`

**Key Features:**
- Drag-and-drop video upload
- Beautiful "vending machine drop" animation
- Video preview with play/pause controls
- Automatic backend integration
- Loading states during processing
- Clean, minimal UI

### 3. Backend Integration

**Flow:**
1. User selects/drops video file
2. File appears with animation
3. After animation completes → Automatically uploads to `/api/upload`
4. Receives `videoId` from backend
5. Triggers processing via `/api/process`
6. Navigates to results view (or calls callback)

**API Endpoints Used:**
- `POST /api/upload` - Uploads video file
- `POST /api/process` - Starts processing pipeline
- `GET /api/status/:videoId` - Polls for status updates

### 4. Main Page Integration

**Location:** `/app/app/page.tsx`

**Features:**
- Landing page with VideoUploadCard
- Results page that shows:
  - Processing status with live updates
  - Publishable clips with metadata
  - Statistics (idea units, publishable, discarded)
  - Story types, energy levels, publish scores
- Status polling every 2 seconds
- Back button to return to upload

## Component Props

```typescript
interface VideoUploadCardProps {
  className?: string;
  triggerAnimation?: boolean;
  onAnimationComplete?: () => void;
  title?: string;
  description?: string;
  onUploadSuccess?: (videoId: string) => void;  // Backend integration callback
}
```

## Usage Examples

### Basic Usage (Automatic Navigation)
```tsx
import { VideoUploadCard } from '@/components/ui/video-upload-card';

export default function Page() {
  return (
    <VideoUploadCard
      title="Upload Your Video"
      description="Drop your video here and let AI find the best moments"
    />
  );
}
```
**Behavior:** Automatically navigates to `/results?videoId={id}` after upload

### Custom Callback
```tsx
import { VideoUploadCard } from '@/components/ui/video-upload-card';

export default function Page() {
  const handleSuccess = (videoId: string) => {
    console.log('Video uploaded:', videoId);
    // Custom logic here
  };

  return (
    <VideoUploadCard
      onUploadSuccess={handleSuccess}
    />
  );
}
```

## Backend Requirements

The component expects these API endpoints to exist:

### POST /api/upload
```typescript
// Request: FormData with 'video' file
// Response:
{
  "success": true,
  "videoId": "uuid-string",
  "filename": "video.mp4",
  "size": 1234567
}
```

### POST /api/process
```typescript
// Request:
{
  "videoId": "uuid-string"
}

// Response:
{
  "success": true,
  "message": "Processing started",
  "videoId": "uuid-string"
}
```

### GET /api/status/:videoId
```typescript
// Response:
{
  "videoId": "uuid-string",
  "status": "completed",
  "processingStep": "Complete",
  "results": {
    "roughcuts": [...],
    "totalRoughcuts": 5,
    "stats": {...}
  }
}
```

## Animation Details

**Drop Animation:**
- Duration: 1.2 seconds
- Easing: `[0.55, 0.055, 0.675, 0.19]` (vending machine gravity)
- Starts above screen, drops to center
- Bounce effect on landing (spring animation)

**States:**
1. **Idle:** Upload icon visible, dashed border
2. **Drag Over:** Border highlights, background changes
3. **Uploading:** Loading state, upload icon active
4. **Animating:** Video card drops with animation
5. **Processing:** "Processing..." text, loading indicator
6. **Complete:** Navigates to results or calls callback

## File Structure

```
/app
├── components/
│   └── ui/
│       └── video-upload-card.tsx    # Main component
├── app/
│   ├── page.tsx                      # Landing page with upload
│   └── api/
│       └── [[...path]]/
│           └── route.js              # Backend endpoints
├── tsconfig.json                     # TypeScript config
└── package.json                      # Dependencies
```

## Styling

**Uses shadcn/ui + Tailwind:**
- `bg-card` - Card backgrounds
- `text-foreground` - Text colors
- `border-border` - Border colors
- `bg-primary` - Primary accents
- `bg-muted` - Muted backgrounds
- Custom animations via `framer-motion`

**Responsive:**
- Min width: 400px (video card)
- Max width: 2xl (container)
- Centered layout
- Mobile-friendly (touch-enabled)

## Error Handling

**Upload Errors:**
```typescript
try {
  // Upload logic
} catch (error) {
  console.error('Upload error:', error);
  alert('Upload failed. Please try again.');
}
```

**Processing Errors:**
- Status polling stops on 'failed' status
- Error message displayed in results view
- User can go back and try again

## Customization

### Change Upload Endpoint
Edit line ~386 in `video-upload-card.tsx`:
```typescript
const uploadResponse = await fetch('/api/upload', {
  method: 'POST',
  body: formData,
});
```

### Change Processing Endpoint
Edit line ~398:
```typescript
const processResponse = await fetch('/api/process', {
  method: 'POST',
  body: JSON.stringify({ videoId: newVideoId }),
});
```

### Customize Animation
Edit motion properties in `VideoComponent`:
```typescript
animate={{
  duration: 1.2,  // Change animation duration
  ease: [0.55, 0.055, 0.675, 0.19],  // Change easing curve
}}
```

### Change Styling
All styling uses Tailwind classes, easy to customize:
```typescript
className="rounded-xl min-h-[310px] ..."
```

## Testing

### Manual Test Flow
1. Start the app: `npm run dev`
2. Open http://localhost:3000
3. Drag a video file onto the upload area (or click to browse)
4. Watch the drop animation
5. Wait for "Processing..." message
6. View results page with clips and statistics

### Check Backend Integration
```bash
# Check if video was uploaded
ls /app/uploads/

# Check if processing started
tail -f /var/log/supervisor/nextjs.out.log

# Check data files
ls /app/data/
```

## Troubleshooting

### Component Not Rendering
**Issue:** Blank screen or error
**Fix:** Check browser console for TypeScript errors

### Animation Not Working
**Issue:** Video appears instantly without animation
**Fix:** Ensure `framer-motion` is installed: `yarn add framer-motion`

### Backend Not Responding
**Issue:** Upload fails or hangs
**Fix:** 
1. Check server is running: `curl http://localhost:3000/api/videos`
2. Check logs: `tail -f /var/log/supervisor/nextjs.out.log`
3. Verify API endpoints exist in `/app/api/[[...path]]/route.js`

### Results Not Showing
**Issue:** Processing completes but no results
**Fix:** Check status response structure matches expected format

## Performance Notes

- Video preview uses `URL.createObjectURL()` for instant playback
- Memory cleanup: URLs are revoked when component unmounts
- Status polling: 2-second intervals (configurable)
- Animation performance: Hardware-accelerated via `framer-motion`

## Browser Support

- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ✅ Mobile browsers
- ⚠️ IE11 not supported (uses modern JavaScript)

## Future Enhancements

Possible improvements:
- [ ] Progress bar during upload
- [ ] Drag multiple files (batch processing)
- [ ] Upload to cloud storage (S3, etc.)
- [ ] Thumbnail preview before upload
- [ ] Video trimming before processing
- [ ] Resume failed uploads

---

**Status:** ✅ Fully integrated and ready to use!
