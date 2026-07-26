"use client";
export const dynamic = "force-dynamic";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  Upload,
  Video,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Play,
} from "lucide-react";
import CameraRecorder from "@/components/CameraRecorder";

// Video Player Component with aspect ratio detection
const VideoPlayer = ({
  videoId,
  clipId,
  isOriginal = false,
  className = "",
}: {
  videoId: string;
  clipId?: string;
  isOriginal?: boolean;
  className?: string;
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isVertical, setIsVertical] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Construct the video URL based on whether it's original or processed clip
  const videoUrl = isOriginal
    ? `/api/video/${videoId}`
    : `/api/video/${videoId}/clip/${clipId}`;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      setIsLoaded(true);
      // Detect if video is vertical (portrait) or horizontal (landscape)
      const aspectRatio = video.videoWidth / video.videoHeight;
      setIsVertical(aspectRatio < 1);
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);

    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  }, []);

  return (
    <div
      className={`relative rounded-lg overflow-hidden bg-black ${className}`}
    >
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        preload="metadata"
        className={`w-full ${
          isVertical
            ? "max-h-[600px] mx-auto object-contain"
            : "h-auto object-contain"
        }`}
        style={{
          aspectRatio: isVertical ? "9/16" : "16/9",
        }}
      />
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <Loader2 className="h-8 w-8 text-white animate-spin" />
        </div>
      )}
    </div>
  );
};

export default function Home() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoStatus, setVideoStatus] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setError(null);
      setVideoId(null);
      setStatus(null);
      setVideoStatus(null);
    }
  };

  const handleCameraRecording = (file: File) => {
    setSelectedFile(file);
    setError(null);
    setVideoId(null);
    setStatus(null);
    setVideoStatus(null);
    // Auto-upload the recorded video
    uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("video", file);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setVideoId(data.videoId);
      setStatus("uploaded");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    await uploadFile(selectedFile);
  };

  const handleGenerateRoughcuts = async () => {
    if (!videoId) return;

    setProcessing(true);
    setError(null);
    setStatus("processing");

    try {
      // Start processing
      const processResponse = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });

      const processData = await processResponse.json();

      if (!processResponse.ok) {
        throw new Error(processData.error || "Processing failed");
      }

      // Poll for status
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/status/${videoId}`);
          const statusData = await statusResponse.json();

          if (!statusResponse.ok) {
            throw new Error(statusData.error || "Failed to fetch status");
          }

          setStatus(statusData.status);
          setVideoStatus(statusData);

          if (statusData.status === "completed") {
            setProcessing(false);
            clearInterval(pollInterval);
          } else if (statusData.status === "failed") {
            setError(statusData.error || "Processing failed");
            setProcessing(false);
            clearInterval(pollInterval);
          }
        } catch (err: any) {
          setError(err.message);
          setProcessing(false);
          clearInterval(pollInterval);
        }
      }, 2000);
    } catch (err: any) {
      setError(err.message);
      setProcessing(false);
    }
  };

  const handleRetry = () => {
    setError(null);
    setStatus("uploaded");
    handleGenerateRoughcuts();
  };

  const handleRunAgain = async () => {
    if (!videoId) return;

    setProcessing(true);
    setError(null);

    try {
      // Call rerun endpoint
      const rerunResponse = await fetch("/api/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });

      const rerunData = await rerunResponse.json();

      if (!rerunResponse.ok) {
        throw new Error(rerunData.error || "Rerun failed");
      }

      // Update to new video ID
      const newVideoId = rerunData.videoId;
      setVideoId(newVideoId);
      setStatus("processing");
      setVideoStatus(null);

      // Poll for status with new ID
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/status/${newVideoId}`);
          const statusData = await statusResponse.json();

          if (!statusResponse.ok) {
            throw new Error(statusData.error || "Failed to fetch status");
          }

          setStatus(statusData.status);
          setVideoStatus(statusData);

          if (statusData.status === "completed") {
            setProcessing(false);
            clearInterval(pollInterval);
          } else if (statusData.status === "failed") {
            setError(statusData.error || "Processing failed");
            setProcessing(false);
            clearInterval(pollInterval);
          }
        } catch (err: any) {
          setError(err.message);
          setProcessing(false);
          clearInterval(pollInterval);
        }
      }, 2000);
    } catch (err: any) {
      setError(err.message);
      setProcessing(false);
    }
  };

  const getStatusIcon = () => {
    if (status === "uploaded")
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    if (status === "processing")
      return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />;
    if (status === "completed")
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    if (status === "failed")
      return <XCircle className="h-5 w-5 text-red-600" />;
    return null;
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold">AI Video Editor</h1>
          <p className="text-muted-foreground">
            Upload a video and generate viral-ready clips automatically
          </p>
        </div>

        {/* Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle>📁 Upload Video File</CardTitle>
            <CardDescription>
              Select a video file from your device to upload and process
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileSelect}
                disabled={uploading || processing}
                className="flex-1"
              />
              <Button
                onClick={handleUpload}
                disabled={!selectedFile || uploading || processing || !!videoId}
                className="min-w-[120px]"
              >
                {uploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload
                  </>
                )}
              </Button>
            </div>

            {selectedFile && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Video className="h-4 w-4" />
                <span>{selectedFile.name}</span>
                <span>
                  ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                </span>
              </div>
            )}

            {status && (
              <div className="flex items-center gap-2 text-sm">
                {getStatusIcon()}
                <span className="font-medium capitalize">{status}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Camera Recorder Section */}
        {!videoId && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or
                </span>
              </div>
            </div>

            <CameraRecorder
              onVideoRecorded={handleCameraRecording}
              disabled={uploading || processing}
            />
          </>
        )}

        {/* Uploaded Video Preview */}
        {videoId && status === "uploaded" && (
          <Card>
            <CardHeader>
              <CardTitle>Uploaded Video</CardTitle>
              <CardDescription>
                Preview your uploaded video before processing
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <VideoPlayer
                videoId={videoId}
                isOriginal={true}
                className="shadow-2xl"
              />
            </CardContent>
          </Card>
        )}

        {/* Generate Clipora Clips Section */}
        {videoId && status === "uploaded" && (
          <Card>
            <CardHeader>
              <CardTitle>Generate Clipora Clips</CardTitle>
              <CardDescription>
                AI-powered video analysis to extract viral-ready clips
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleGenerateRoughcuts}
                disabled={processing}
                className="w-full"
                size="lg"
              >
                {processing ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  "✂️ Generate Clipora Clips"
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Processing Status */}
        {processing && videoStatus && (
          <Card>
            <CardHeader>
              <CardTitle>Processing Status</CardTitle>
              <CardDescription>
                {videoStatus.processingStep || "Processing..."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Working on your video...</span>
                </div>
                {videoStatus.processingStep && (
                  <p className="text-sm text-muted-foreground">
                    Current step: {videoStatus.processingStep}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>{error}</span>
              {videoId && (
                <Button
                  onClick={handleRetry}
                  variant="outline"
                  size="sm"
                  className="ml-4 h-7 text-xs"
                  disabled={processing}
                >
                  {processing ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      Retrying...
                    </>
                  ) : (
                    "Retry"
                  )}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Results Grid */}
        {status === "completed" && videoStatus?.results && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Clipora Results</CardTitle>
                  <CardDescription>
                    ✨ Generated {videoStatus.results.totalRoughcuts}{" "}
                    viral-ready clips from your video
                  </CardDescription>
                </div>
                <Button
                  onClick={handleRunAgain}
                  variant="outline"
                  size="sm"
                  disabled={processing}
                >
                  {processing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Running...
                    </>
                  ) : (
                    "Run Again"
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Clips Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {videoStatus.results.roughcuts?.map((clip: any) => {
                  // Color coding for content role
                  const roleColors = {
                    PRIMARY_REEL: "bg-green-50 border-green-400",
                    SECONDARY_REEL: "bg-blue-50 border-blue-400",
                    SUPPORTING: "bg-yellow-50 border-yellow-400",
                    DISCARD: "bg-red-50 border-red-400",
                  };

                  return (
                    <div
                      key={clip.id}
                      className={`border-2 rounded-xl p-4 space-y-4 hover:shadow-lg transition-all ${roleColors[clip.content_role as keyof typeof roleColors] || "bg-white border-gray-200"}`}
                    >
                      {/* Video Player for this processed clip */}
                      <VideoPlayer
                        videoId={videoStatus.videoId}
                        clipId={clip.canonical_id || clip.id}
                        isOriginal={false}
                        className="shadow-xl ring-2 ring-black/5"
                      />

                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-lg">
                              Clip #{clip.canonical_id}
                            </h3>
                            <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-bold">
                              {clip.content_role?.replace("_", " ")}
                            </span>
                            {clip.format_tag && (
                              <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs font-medium">
                                {clip.format_tag.replace(/_/g, " ")}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {clip.timestamp} • {clip.duration.toFixed(1)}s
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold text-primary">
                            {clip.publish_score}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            score
                          </div>
                        </div>
                      </div>

                      <p className="text-sm font-medium leading-relaxed">
                        {clip.core_idea}
                      </p>

                      {clip.publish_reason && (
                        <div className="text-xs bg-green-50 border border-green-200 rounded-lg p-3">
                          <span className="font-semibold text-green-800">
                            ✓ Why publish:
                          </span>
                          <span className="text-green-700 ml-1">
                            {clip.publish_reason}
                          </span>
                        </div>
                      )}

                      <div className="flex gap-2 flex-wrap">
                        <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-medium">
                          {clip.story_type}
                        </span>
                        <span className="px-2 py-1 bg-secondary/10 text-secondary-foreground rounded text-xs font-medium">
                          {clip.energy} energy
                        </span>
                        <span className="px-2 py-1 bg-accent/10 rounded text-xs font-medium">
                          {clip.intent}
                        </span>
                      </div>

                      <div className="flex gap-3 text-xs text-muted-foreground pt-2 border-t">
                        <span>
                          Delivery Quality:{" "}
                          {clip.delivery_quality_score?.toFixed(2)}
                        </span>
                        <span>•</span>
                        <span>
                          Publish Score: {clip.publish_score?.toFixed(2)}
                        </span>
                        {clip.is_merged && (
                          <>
                            <span>•</span>
                            <span className="text-blue-600 font-medium">
                              Merged Clip
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Statistics */}
              {videoStatus.results.stats && (
                <div className="border-t pt-6">
                  <h3 className="font-semibold mb-4">Clipora Analytics</h3>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-3xl font-bold">
                        {videoStatus.results.stats.total_idea_units}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Ideas Analyzed
                      </p>
                    </div>
                    <div>
                      <p className="text-3xl font-bold text-green-600">
                        {videoStatus.results.stats.publishable_units}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Clipora Clips Generated
                      </p>
                    </div>
                    <div>
                      <p className="text-3xl font-bold text-red-600">
                        {videoStatus.results.stats.discarded_units}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Low-Quality Filtered
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
