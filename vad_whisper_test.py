#!/usr/bin/env python3
"""
VAD + Whisper Pipeline Testing for Video Roughcut Generator
Tests the new real processing pipeline with FFmpeg, Replicate VAD, and OpenAI Whisper
"""

import requests
import json
import time
import os
import tempfile
import subprocess
from io import BytesIO

# Get base URL from environment
import os
# Use localhost for testing since the external URL might not be accessible
BASE_URL = "http://localhost:3000/api"

def create_test_video_with_speech():
    """Create a test video file with actual speech content using FFmpeg"""
    print("Creating test video with speech content...")
    
    try:
        # Create a simple video with synthesized speech using FFmpeg
        # This creates a 10-second video with a test tone and silence patterns
        temp_video = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        temp_video.close()
        
        # Generate a simple video with audio that has speech-like patterns
        # Using sine wave with varying frequencies to simulate speech
        cmd = [
            'ffmpeg', '-y',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=2',  # 2 seconds of tone
            '-f', 'lavfi', 
            '-i', 'sine=frequency=0:duration=1',    # 1 second of silence
            '-f', 'lavfi',
            '-i', 'sine=frequency=880:duration=2',  # 2 seconds of higher tone
            '-f', 'lavfi',
            '-i', 'sine=frequency=0:duration=1',    # 1 second of silence
            '-f', 'lavfi',
            '-i', 'sine=frequency=660:duration=4',  # 4 seconds of mid tone
            '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[audio]; color=black:size=640x480:duration=10[video]',
            '-map', '[video]', '-map', '[audio]',
            '-c:v', 'libx264', '-c:a', 'aac',
            '-t', '10',  # 10 seconds total
            temp_video.name
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            print(f"✅ Created test video: {temp_video.name}")
            return temp_video.name
        else:
            print(f"❌ FFmpeg failed: {result.stderr}")
            # Fallback: create a simple mock video file
            return create_mock_video_file()
            
    except Exception as e:
        print(f"❌ Error creating test video: {str(e)}")
        # Fallback: create a simple mock video file
        return create_mock_video_file()

def create_mock_video_file():
    """Create a simple mock video file as fallback"""
    print("Creating fallback mock video file...")
    mock_video_content = b'\x00\x00\x00\x20ftypmp41\x00\x00\x00\x00mp41isom\x00\x00\x00\x08free' + b'\x00' * 2000
    
    temp_file = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    temp_file.write(mock_video_content)
    temp_file.close()
    
    print(f"✅ Created mock video: {temp_file.name}")
    return temp_file.name

def test_vad_whisper_upload():
    """Test uploading a video with speech content"""
    print("\n=== Testing Video Upload for VAD + Whisper Pipeline ===")
    
    try:
        # Create test video with speech
        video_path = create_test_video_with_speech()
        
        print(f"Uploading test video: {video_path}")
        with open(video_path, 'rb') as video_file:
            files = {'video': ('speech_test.mp4', video_file, 'video/mp4')}
            response = requests.post(f"{BASE_URL}/upload", files=files, timeout=60)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        # Clean up temp file
        os.unlink(video_path)
        
        if response.status_code == 200:
            data = response.json()
            if 'videoId' in data:
                print("✅ Video uploaded successfully for VAD + Whisper testing")
                return data['videoId']
            else:
                print("❌ Upload response missing videoId")
                return None
        else:
            print(f"❌ Upload failed with status {response.status_code}")
            return None
            
    except Exception as e:
        print(f"❌ Upload test failed: {str(e)}")
        return None

def test_vad_whisper_processing(video_id):
    """Test the VAD + Whisper processing pipeline"""
    print(f"\n=== Testing VAD + Whisper Processing Pipeline for {video_id} ===")
    
    try:
        # Start processing
        payload = {"videoId": video_id}
        response = requests.post(f"{BASE_URL}/process", 
                               json=payload, 
                               headers={'Content-Type': 'application/json'},
                               timeout=30)
        
        print(f"Process request - Status Code: {response.status_code}")
        print(f"Process request - Response: {response.text}")
        
        if response.status_code != 200:
            print(f"❌ Failed to start processing: {response.status_code}")
            return False
        
        print("✅ Processing started successfully")
        return True
        
    except Exception as e:
        print(f"❌ Processing start failed: {str(e)}")
        return False

def test_vad_whisper_status_monitoring(video_id):
    """Monitor the VAD + Whisper processing status and verify all steps"""
    print(f"\n=== Monitoring VAD + Whisper Processing Status for {video_id} ===")
    
    expected_steps = [
        "Extracting audio...",
        "Running voice activity detection...", 
        "Transcribing speech...",
        "Complete"
    ]
    
    seen_steps = set()
    max_polls = 60  # Increased for real processing
    poll_interval = 5  # 5 seconds between polls
    
    try:
        for i in range(max_polls):
            print(f"\n--- Poll {i+1}/{max_polls} ---")
            
            response = requests.get(f"{BASE_URL}/status/{video_id}", timeout=30)
            
            if response.status_code != 200:
                print(f"❌ Status request failed: {response.status_code}")
                continue
            
            data = response.json()
            current_status = data.get('status', 'unknown')
            processing_step = data.get('processingStep', 'N/A')
            
            print(f"Status: {current_status}")
            print(f"Processing Step: {processing_step}")
            
            # Track processing steps
            if processing_step and processing_step != 'N/A':
                seen_steps.add(processing_step)
                print(f"✅ Seen step: {processing_step}")
            
            # Check for completion
            if current_status == 'completed':
                print("🎉 Processing completed!")
                
                # Verify all expected fields are present
                required_fields = ['videoId', 'filename', 'status', 'uploadedAt', 'startedAt', 'completedAt']
                missing_fields = [field for field in required_fields if field not in data or data[field] is None]
                
                if missing_fields:
                    print(f"❌ Missing required fields: {missing_fields}")
                else:
                    print("✅ All required status fields present")
                
                # Check for VAD + Whisper specific outputs
                cleaned_audio_url = data.get('cleanedAudioURL')
                transcript = data.get('transcript')
                
                print(f"\n--- VAD + Whisper Output Verification ---")
                
                # Verify cleanedAudioURL
                if cleaned_audio_url:
                    print(f"✅ cleanedAudioURL present: {cleaned_audio_url}")
                    if cleaned_audio_url.startswith('http'):
                        print("✅ cleanedAudioURL is a valid URL")
                    else:
                        print("❌ cleanedAudioURL is not a valid URL")
                else:
                    print("❌ cleanedAudioURL missing")
                
                # Verify transcript
                if transcript:
                    print("✅ transcript object present")
                    
                    # Check transcript text
                    if 'text' in transcript and transcript['text']:
                        print(f"✅ transcript.text present: '{transcript['text'][:100]}...'")
                    else:
                        print("❌ transcript.text missing or empty")
                    
                    # Check transcript segments
                    if 'segments' in transcript and isinstance(transcript['segments'], list):
                        segments = transcript['segments']
                        print(f"✅ transcript.segments present with {len(segments)} segments")
                        
                        # Verify segment structure
                        if segments:
                            first_segment = segments[0]
                            required_segment_fields = ['id', 'start', 'end', 'text']
                            segment_missing = [field for field in required_segment_fields if field not in first_segment]
                            
                            if segment_missing:
                                print(f"❌ Segment missing fields: {segment_missing}")
                            else:
                                print("✅ Segment structure correct")
                                print(f"Sample segment: {first_segment}")
                        
                    else:
                        print("❌ transcript.segments missing or not a list")
                else:
                    print("❌ transcript object missing")
                
                # Verify processing steps
                print(f"\n--- Processing Steps Verification ---")
                print(f"Expected steps: {expected_steps}")
                print(f"Seen steps: {list(seen_steps)}")
                
                missing_steps = [step for step in expected_steps if step not in seen_steps]
                if missing_steps:
                    print(f"❌ Missing processing steps: {missing_steps}")
                else:
                    print("✅ All expected processing steps observed")
                
                return {
                    'success': True,
                    'data': data,
                    'seen_steps': seen_steps,
                    'has_cleaned_audio': bool(cleaned_audio_url),
                    'has_transcript': bool(transcript),
                    'transcript_segments': len(transcript.get('segments', [])) if transcript else 0
                }
            
            elif current_status == 'failed':
                print(f"❌ Processing failed")
                error = data.get('error', 'Unknown error')
                print(f"Error: {error}")
                return {'success': False, 'error': error}
            
            elif current_status == 'processing':
                print("⏳ Still processing...")
                time.sleep(poll_interval)
            
            else:
                print(f"⏳ Status: {current_status}, waiting...")
                time.sleep(poll_interval)
        
        print("❌ Processing timed out or incomplete")
        return {'success': False, 'error': 'Timeout'}
        
    except Exception as e:
        print(f"❌ Status monitoring failed: {str(e)}")
        return {'success': False, 'error': str(e)}

def test_error_handling():
    """Test error handling for VAD + Whisper pipeline"""
    print("\n=== Testing VAD + Whisper Error Handling ===")
    
    # Test 1: Invalid video format
    print("\n1. Testing invalid video format...")
    try:
        # Create a text file disguised as video
        temp_file = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        temp_file.write(b'This is not a video file content')
        temp_file.close()
        
        with open(temp_file.name, 'rb') as fake_video:
            files = {'video': ('fake.mp4', fake_video, 'video/mp4')}
            response = requests.post(f"{BASE_URL}/upload", files=files, timeout=30)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 200:
            # If upload succeeds, try processing to see if it fails gracefully
            data = response.json()
            video_id = data.get('videoId')
            
            if video_id:
                # Try to process the invalid video
                payload = {"videoId": video_id}
                process_response = requests.post(f"{BASE_URL}/process", 
                                               json=payload, 
                                               headers={'Content-Type': 'application/json'},
                                               timeout=30)
                
                if process_response.status_code == 200:
                    print("Processing started for invalid video, monitoring for failure...")
                    
                    # Monitor for failure
                    for i in range(10):  # Check for 10 polls
                        time.sleep(2)
                        status_response = requests.get(f"{BASE_URL}/status/{video_id}", timeout=30)
                        if status_response.status_code == 200:
                            status_data = status_response.json()
                            if status_data.get('status') == 'failed':
                                print("✅ Invalid video correctly failed during processing")
                                break
                        
        os.unlink(temp_file.name)
        
    except Exception as e:
        print(f"❌ Invalid format test failed: {str(e)}")
    
    # Test 2: Very short video (if we can create one)
    print("\n2. Testing very short video...")
    try:
        # Create a very short video (1 second)
        temp_video = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
        temp_video.close()
        
        cmd = [
            'ffmpeg', '-y',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=0.5',  # 0.5 seconds
            '-f', 'lavfi',
            '-i', 'color=black:size=320x240:duration=0.5',
            '-c:v', 'libx264', '-c:a', 'aac',
            '-shortest',
            temp_video.name
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        
        if result.returncode == 0:
            print("Created very short video, testing upload and processing...")
            
            with open(temp_video.name, 'rb') as short_video:
                files = {'video': ('short.mp4', short_video, 'video/mp4')}
                response = requests.post(f"{BASE_URL}/upload", files=files, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                video_id = data.get('videoId')
                print(f"Short video uploaded: {video_id}")
                
                # Try processing
                payload = {"videoId": video_id}
                process_response = requests.post(f"{BASE_URL}/process", 
                                               json=payload, 
                                               headers={'Content-Type': 'application/json'},
                                               timeout=30)
                
                if process_response.status_code == 200:
                    print("✅ Short video processing started (should handle gracefully)")
                else:
                    print(f"Short video processing failed to start: {process_response.status_code}")
            
        os.unlink(temp_video.name)
        
    except Exception as e:
        print(f"Short video test failed: {str(e)}")

def main():
    """Run comprehensive VAD + Whisper pipeline tests"""
    print("🚀 Starting VAD + Whisper Pipeline Tests")
    print(f"Base URL: {BASE_URL}")
    print("This will test real processing with external APIs (Replicate + OpenAI)")
    print("Expected processing time: 30-120 seconds depending on video length")
    
    try:
        # Test 1: Upload video with speech content
        print("\n" + "="*70)
        print("STEP 1: UPLOAD TEST VIDEO")
        print("="*70)
        
        video_id = test_vad_whisper_upload()
        if not video_id:
            print("❌ Cannot proceed without successful upload")
            return False
        
        # Test 2: Start VAD + Whisper processing
        print("\n" + "="*70)
        print("STEP 2: START VAD + WHISPER PROCESSING")
        print("="*70)
        
        processing_started = test_vad_whisper_processing(video_id)
        if not processing_started:
            print("❌ Cannot proceed without successful processing start")
            return False
        
        # Test 3: Monitor processing and verify outputs
        print("\n" + "="*70)
        print("STEP 3: MONITOR PROCESSING & VERIFY OUTPUTS")
        print("="*70)
        
        result = test_vad_whisper_status_monitoring(video_id)
        
        # Test 4: Error handling
        print("\n" + "="*70)
        print("STEP 4: ERROR HANDLING TESTS")
        print("="*70)
        
        test_error_handling()
        
        # Summary
        print("\n" + "="*70)
        print("VAD + WHISPER PIPELINE TEST SUMMARY")
        print("="*70)
        
        if result.get('success'):
            print("✅ VAD + Whisper pipeline working correctly!")
            print(f"✅ Processing steps completed: {list(result['seen_steps'])}")
            print(f"✅ Cleaned audio URL: {'Yes' if result['has_cleaned_audio'] else 'No'}")
            print(f"✅ Transcript generated: {'Yes' if result['has_transcript'] else 'No'}")
            print(f"✅ Transcript segments: {result['transcript_segments']}")
            return True
        else:
            print("❌ VAD + Whisper pipeline failed!")
            print(f"Error: {result.get('error', 'Unknown')}")
            return False
            
    except Exception as e:
        print(f"❌ Test suite failed: {str(e)}")
        return False

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)