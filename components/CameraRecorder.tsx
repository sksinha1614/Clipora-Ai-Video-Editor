'use client';

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Camera, Square, Video, Loader2, CheckCircle2 } from 'lucide-react';

interface CameraRecorderProps {
  onVideoRecorded: (file: File) => void;
  disabled?: boolean;
}

export default function CameraRecorder({ onVideoRecorded, disabled = false }: CameraRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startCamera = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'user'
        },
        audio: true
      });

      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true; // Mute to avoid feedback
      }
      
      setIsPreviewing(true);
    } catch (err: any) {
      setError(err.message || 'Failed to access camera');
      console.error('Camera error:', err);
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;

    try {
      chunksRef.current = [];
      
      const options = { mimeType: 'video/webm;codecs=vp8,opus' };
      const mediaRecorder = new MediaRecorder(streamRef.current, options);
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        setRecordedBlob(blob);
        
        // Show recorded video
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = URL.createObjectURL(blob);
          videoRef.current.muted = false;
        }
        
        setIsRecording(false);
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      setRecordingTime(0);
      
      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'Failed to start recording');
      console.error('Recording error:', err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    
    setIsPreviewing(false);
    setIsRecording(false);
    
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
  };

  const useRecording = () => {
    if (!recordedBlob) return;

    // Convert blob to file
    const file = new File([recordedBlob], `camera-recording-${Date.now()}.webm`, {
      type: 'video/webm'
    });

    stopCamera();
    setRecordedBlob(null);
    setRecordingTime(0);
    onVideoRecorded(file);
  };

  const discardRecording = () => {
    setRecordedBlob(null);
    setRecordingTime(0);
    
    if (videoRef.current) {
      videoRef.current.src = '';
    }
    
    startCamera(); // Restart camera preview
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>📹 Record from Camera</CardTitle>
        <CardDescription>
          Record a video directly from your camera or webcam
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Video Preview */}
        {(isPreviewing || recordedBlob) && (
          <div className="relative rounded-lg overflow-hidden bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-auto max-h-[500px] object-contain"
              style={{ aspectRatio: '16/9' }}
            />
            
            {/* Recording Indicator */}
            {isRecording && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-red-600 text-white px-3 py-2 rounded-full">
                <div className="w-3 h-3 bg-white rounded-full animate-pulse" />
                <span className="font-mono font-bold">{formatTime(recordingTime)}</span>
              </div>
            )}
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
            {error}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap gap-3">
          {/* Not Started Yet */}
          {!isPreviewing && !recordedBlob && (
            <Button
              onClick={startCamera}
              disabled={disabled}
              size="lg"
              className="flex-1"
            >
              <Camera className="mr-2 h-5 w-5" />
              Start Camera
            </Button>
          )}

          {/* Camera Active - Not Recording */}
          {isPreviewing && !isRecording && !recordedBlob && (
            <>
              <Button
                onClick={startRecording}
                disabled={disabled}
                size="lg"
                className="flex-1 bg-red-600 hover:bg-red-700"
              >
                <Video className="mr-2 h-5 w-5" />
                Start Recording
              </Button>
              <Button
                onClick={stopCamera}
                variant="outline"
                size="lg"
              >
                Cancel
              </Button>
            </>
          )}

          {/* Recording in Progress */}
          {isRecording && (
            <Button
              onClick={stopRecording}
              size="lg"
              className="flex-1 bg-red-600 hover:bg-red-700"
            >
              <Square className="mr-2 h-5 w-5" />
              Stop Recording
            </Button>
          )}

          {/* Recording Complete - Preview */}
          {recordedBlob && !isRecording && (
            <>
              <Button
                onClick={useRecording}
                size="lg"
                className="flex-1 bg-green-600 hover:bg-green-700"
              >
                <CheckCircle2 className="mr-2 h-5 w-5" />
                Use This Recording
              </Button>
              <Button
                onClick={discardRecording}
                variant="outline"
                size="lg"
              >
                Record Again
              </Button>
            </>
          )}
        </div>

        {/* Info Text */}
        {isPreviewing && !isRecording && !recordedBlob && (
          <p className="text-xs text-muted-foreground text-center">
            💡 Click "Start Recording" when you're ready to record
          </p>
        )}
        
        {recordedBlob && (
          <p className="text-xs text-muted-foreground text-center">
            ✅ Recording complete! Preview your video and click "Use This Recording" to process it
          </p>
        )}
      </CardContent>
    </Card>
  );
}
