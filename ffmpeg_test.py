#!/usr/bin/env python3
"""
Quick test to verify FFmpeg audio extraction works
"""

import subprocess
import tempfile
import os

def test_ffmpeg_audio_extraction():
    """Test that FFmpeg can extract audio from a video file"""
    print("Testing FFmpeg audio extraction...")
    
    try:
        # Create a simple test video with audio
        temp_video = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        temp_video.close()
        
        # Generate a simple 5-second video with audio
        cmd = [
            'ffmpeg', '-y',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=5',  # 5 seconds of 440Hz tone
            '-f', 'lavfi',
            '-i', 'color=black:size=320x240:duration=5',  # 5 seconds of black video
            '-c:v', 'libx264', '-c:a', 'aac',
            '-shortest',
            temp_video.name
        ]
        
        print("Creating test video...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        if result.returncode != 0:
            print(f"❌ Failed to create test video: {result.stderr}")
            return False
        
        print("✅ Test video created successfully")
        
        # Now test audio extraction
        temp_audio = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        temp_audio.close()
        
        extract_cmd = [
            'ffmpeg', '-y',
            '-i', temp_video.name,
            '-vn',  # No video
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            temp_audio.name
        ]
        
        print("Extracting audio...")
        extract_result = subprocess.run(extract_cmd, capture_output=True, text=True, timeout=30)
        
        if extract_result.returncode != 0:
            print(f"❌ Failed to extract audio: {extract_result.stderr}")
            return False
        
        # Check if audio file was created and has content
        if os.path.exists(temp_audio.name) and os.path.getsize(temp_audio.name) > 0:
            print(f"✅ Audio extraction successful! Audio file size: {os.path.getsize(temp_audio.name)} bytes")
            
            # Clean up
            os.unlink(temp_video.name)
            os.unlink(temp_audio.name)
            return True
        else:
            print("❌ Audio file not created or empty")
            return False
            
    except Exception as e:
        print(f"❌ Test failed with error: {str(e)}")
        return False

if __name__ == "__main__":
    success = test_ffmpeg_audio_extraction()
    if success:
        print("\n✅ FFmpeg audio extraction is working correctly!")
    else:
        print("\n❌ FFmpeg audio extraction failed!")
    exit(0 if success else 1)